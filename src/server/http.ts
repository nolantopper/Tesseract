import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactStore } from './store.js';
import { cadDecoder } from './cad.js';
import { selectionSchema } from './schemas.js';

export async function startHttp(store: ArtifactStore, webDir: string, port = 0) {
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const body = async (req: IncomingMessage) => {
    if (!req.headers['content-type']?.startsWith('application/json'))
      throw new Error('Expected JSON.');
    const buffers: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) throw new Error('Request too large.');
      buffers.push(chunk);
    }
    return JSON.parse(Buffer.concat(buffers).toString());
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return json(res, { error: 'Invalid origin.' }, 403);
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith('/api/')) {
        const supplied =
          req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token') ?? '';
        if (
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          return json(res, { error: 'Unauthorized.' }, 401);
        if (req.method === 'GET' && url.pathname === '/api/cad-decoder') {
          const data = await cadDecoder(url.searchParams.get('kind') === 'laz' ? 'laz' : 'cad');
          res.writeHead(200, { 'Content-Type': 'application/wasm', 'Content-Length': data.length });
          res.end(data);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/open') {
          const data = await body(req);
          if (typeof data.path !== 'string') throw new Error('A workspace path is required.');
          const artifact = await store.inspect(data.path);
          store.latestId = artifact.id;
          return json(res, { artifact });
        }
        if (req.method === 'POST' && url.pathname === '/api/selection')
          return json(res, {
            selection: await store.select(selectionSchema.parse(await body(req))),
          });
        if (req.method === 'GET' && url.pathname === '/api/selection') {
          const id = url.searchParams.get('id') ?? store.latestId;
          if (id) await store.get(id);
          return json(res, { selection: id ? (store.selections.get(id) ?? null) : null });
        }
        const match = /^\/api\/(artifact|file)\/([\w-]+)$/.exec(url.pathname);
        if (req.method === 'GET' && match) {
          const a = await store.get(match[2]);
          if (match[1] === 'artifact') return json(res, { artifact: a });
          if (url.searchParams.get('revision') !== a.revision)
            return json(res, { error: 'Artifact changed. Refresh the viewer.' }, 409);
          const file = await store.files.open(a.path);
          let start = 0,
            end = a.size - 1,
            partial = false;
          if (req.headers.range) {
            const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!range || (!range[1] && !range[2])) {
              await file.handle.close();
              res.writeHead(416, { 'Content-Range': `bytes */${a.size}` });
              return res.end();
            }
            if (!range[1]) start = Math.max(0, a.size - Number(range[2]));
            else {
              start = Number(range[1]);
              if (range[2]) end = Math.min(end, Number(range[2]));
            }
            partial = true;
          }
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start < 0
          ) {
            await file.handle.close();
            res.writeHead(416, { 'Content-Range': `bytes */${a.size}` });
            return res.end();
          }
          res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
          res.writeHead(partial ? 206 : 200, {
            'Content-Type': a.format.mime,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${a.size}` } : {}),
          });
          const stream = file.handle.createReadStream({ start, end, autoClose: true });
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
          return;
        }
        return json(res, { error: 'Not found.' }, 404);
      }
      if (req.method !== 'GET') return json(res, { error: 'Method not allowed.' }, 405);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      if (relative !== 'index.html' && !/^assets\/[\w.-]+$/.test(relative))
        return json(res, { error: 'Not found.' }, 404);
      if (/^assets\/(?:cad|data)\.worker-[\w-]+\.js$/.test(relative))
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'",
        );
      const data = await readFile(path.join(webDir, relative));
      const ext = path.extname(relative);
      res.writeHead(200, {
        'Content-Type':
          (
            { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<
              string,
              string
            >
          )[ext] ?? 'application/octet-stream',
      });
      res.end(data);
    } catch (error) {
      if (!res.headersSent)
        json(res, { error: error instanceof Error ? error.message : 'Cannot open artifact.' }, 400);
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot start local viewer.');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    token,
    origin,
    viewerUrl: (id?: string) => `${origin}/#token=${token}${id ? `&artifact=${id}` : ''}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
