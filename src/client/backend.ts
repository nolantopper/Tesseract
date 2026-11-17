import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import SummaryWorker from './viewers/mcap-summary.worker?worker&inline';
import type { McapInfo } from '../shared/types';
import { artifactResponse, type Artifact, type Selection } from '../shared/types';
import { artifactFileInput } from '../shared/file-entrypoint';
import { detectFormat } from '../shared/formats';
import { hostResourceFile, hostPreviewLimit } from './host-file';
import { version } from '../shared/version';

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('token') ?? '';
const localFiles = new Map<string, File>();
const previewLimit = hostPreviewLimit;
const byteResponse = z.object({ data: z.string() });
const pickerResponse = z.object({ picker: z.literal(true) });
const MAX_PARSER_BYTES = 16 * 1024 * 1024;
const parserResponse = byteResponse.extend({ total: z.number().int().positive() });
const errorResponse = z.object({ error: z.string() });
let bridge: App | undefined;
let pendingHostFile: AbortController | undefined;
let reloadHostFile: (() => Promise<void>) | undefined;
export const embedded = window.parent !== window && !token;
export const canRetryHostFile = () => reloadHostFile !== undefined;
export async function retryHostFile() {
  await reloadHostFile?.();
}

export async function connect(
  onArtifact: (a: Artifact) => void,
  onTheme: (theme: string) => void,
  onError: (message: string) => void,
  onPicker: () => void,
) {
  if (!embedded) return;
  const { App, applyHostStyleVariables } = await import('@modelcontextprotocol/ext-apps');
  const app = new App({ name: 'Tesseract', version }, {});
  bridge = app;
  app.ontoolinput = async ({ arguments: args }) => {
    const input = artifactFileInput.safeParse(args);
    if (!input.success) {
      if (args && 'file' in args) onError('Tesseract couldn’t read this file from Codex.');
      return;
    }
    const { name, resourceUri } = input.data.file;
    reloadHostFile = async () => {
      pendingHostFile?.abort();
      pendingHostFile = new AbortController();
      const { signal } = pendingHostFile;
      let inspectionError: unknown;
      try {
        // The host binds MCAP inspection to the opened file. Indexed reads
        // avoid sending the whole recording through the file resource.
        if (/\.mcap$/i.test(name)) {
          try {
            const { artifact } = artifactResponse.parse(
              await tool('artifact_open_host_file', {}, signal),
            );
            if (!artifact.mcap)
              throw new Error(artifact.warning ?? 'No indexed MCAP summary was returned.');
            if (!signal.aborted) onArtifact(artifact);
            return;
          } catch (error) {
            signal.throwIfAborted();
            inspectionError = error;
          }
        }
        if (!app.getHostCapabilities()?.experimental?.['openai/resource']) {
          throw new Error('This host did not share the opened file.');
        }
        const resource = await app.readServerResource(
          {
            uri: resourceUri,
            _meta: { 'openai/resource': { representation: 'blob' } },
          },
          { signal },
        );
        const file = hostResourceFile(resource, resourceUri, name);
        const artifact = await openLocalFile(file, signal);
        if (!signal.aborted) onArtifact(artifact);
      } catch (error) {
        if (signal.aborted) return;
        if (inspectionError instanceof Error)
          console.warn('MCAP file inspection failed.', inspectionError.message);
        onError(error instanceof Error ? error.message : 'Couldn’t open file.');
      }
    };
    await reloadHostFile();
  };
  app.ontoolresult = (result) => {
    const data = result.structuredContent;
    const parsed = artifactResponse.safeParse(data);
    if (parsed.success) {
      pendingHostFile?.abort();
      onArtifact(parsed.data.artifact);
    }
    if (pickerResponse.safeParse(data).success) onPicker();
  };
  const applyContext = (context?: McpUiHostContext) => {
    if (context?.theme) onTheme(context.theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  };
  app.onhostcontextchanged = applyContext;
  app.onteardown = async () => {
    pendingHostFile?.abort();
    reloadHostFile = undefined;
    window.dispatchEvent(new Event('tesseract-teardown'));
    return {};
  };
  await app.connect();
  applyContext(app.getHostContext());
}
export async function toggleFullscreen() {
  if (embedded && bridge) {
    const context = bridge.getHostContext();
    const mode = context?.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    if (!context?.availableDisplayModes?.includes(mode))
      throw new Error('This host does not offer fullscreen viewing.');
    await bridge.requestDisplayMode({ mode });
  } else if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}
async function tool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  if (!bridge) throw new Error('Host connection unavailable.');
  const result = await bridge.callServerTool({ name, arguments: args }, { signal });
  if (result.isError)
    throw new Error(
      result.content?.find((c) => c.type === 'text')?.text ?? 'Artifact operation failed.',
    );
  return result.structuredContent;
}
async function api(route: string, data?: unknown): Promise<unknown> {
  const response = await fetch(`/api/${route}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const parsed = errorResponse.safeParse(result);
    throw new Error(parsed.success ? parsed.data.error : 'Artifact operation failed.');
  }
  return result;
}
export async function state(a: Artifact): Promise<Artifact> {
  if (localFiles.has(a.id)) return a;
  const result = embedded
    ? await tool('artifact_state', { artifactId: a.id })
    : await api(`artifact/${a.id}`);
  return artifactResponse.parse(result).artifact;
}
export async function stateById(id: string): Promise<Artifact> {
  return artifactResponse.parse(await api(`artifact/${id}`)).artifact;
}
export async function select(selection: Selection) {
  if (localFiles.has(selection.artifactId)) return false;
  if (embedded) await tool('artifact_select', selection);
  else await api('selection', selection);
  return true;
}
export async function openLocalFile(file: File, signal: AbortSignal): Promise<Artifact> {
  const format = detectFormat(
    file.name,
    new Uint8Array(await file.slice(0, 512).arrayBuffer()),
    file.type,
  );
  signal.throwIfAborted();
  let mcap: McapInfo | undefined;
  if (format.kind === 'mcap') {
    if (file.size > previewLimit) throw new Error('Native MCAP preview limit is 64 MiB.');
    const data = await file.arrayBuffer();
    signal.throwIfAborted();
    mcap = await new Promise<McapInfo>((resolve, reject) => {
      const worker = new SummaryWorker();
      const finish = (error?: string, info?: McapInfo) => {
        clearTimeout(timer);
        worker.terminate();
        signal.removeEventListener('abort', cancel);
        if (error) reject(new Error(error));
        else resolve(info!);
      };
      const cancel = () => finish('MCAP loading cancelled.');
      const timer = setTimeout(() => finish('MCAP summary exceeded 20 seconds.'), 20000);
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = (event) => finish(event.data.error, event.data.info);
      worker.onerror = () => finish('MCAP summary worker unavailable.');
      worker.postMessage(data, [data]);
    });
  }
  const artifact = {
    id: `local-${crypto.randomUUID()}`,
    path: file.name,
    name: file.name,
    size: file.size,
    modified: file.lastModified,
    revision: String(file.lastModified),
    format,
    mcap,
  };
  if (localFiles.size >= 128) localFiles.delete(localFiles.keys().next().value!);
  localFiles.set(artifact.id, file);
  return artifact;
}
export async function readBytes(
  a: Artifact,
  limit = previewLimit,
  prefix = false,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!prefix && a.size > limit)
    throw new Error(
      `Preview limit is ${limit / 1024 / 1024} MiB. The file remains available for inspection.`,
    );
  const length = Math.min(a.size, limit);
  if (length === 0) return new ArrayBuffer(0);
  const file = localFiles.get(a.id);
  if (file) return file.slice(0, length).arrayBuffer();
  if (!embedded) {
    const response = await fetch(fileUrl(a), {
      headers: prefix ? { Range: `bytes=0-${Math.max(0, length - 1)}` } : {},
      signal,
    });
    if (!response.ok) throw new Error('Cannot read file. It may have changed; refresh the viewer.');
    return response.arrayBuffer();
  }
  const result = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 1024 * 1024) {
    signal?.throwIfAborted();
    const { data } = byteResponse.parse(
      await tool(
        'artifact_read',
        {
          artifactId: a.id,
          revision: a.revision,
          offset,
          length: Math.min(1024 * 1024, length - offset),
        },
        signal,
      ),
    );
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (!bytes.length) throw new Error('File ended unexpectedly.');
    result.set(bytes, offset);
  }
  return result.buffer;
}
function fileUrl(a: Artifact) {
  return `/api/file/${a.id}?token=${token}&revision=${encodeURIComponent(a.revision)}`;
}
export async function mediaUrl(
  a: Artifact,
  signal?: AbortSignal,
): Promise<{ url: string; release: () => void }> {
  const local = localFiles.get(a.id);
  if (!embedded && !local) return { url: fileUrl(a), release: () => {} };
  const blob =
    local?.slice(0, local.size, a.format.mime) ??
    new Blob([await readBytes(a, undefined, false, signal)], { type: a.format.mime });
  const url = URL.createObjectURL(blob);
  return { url, release: () => URL.revokeObjectURL(url) };
}

export async function openPath(path: string): Promise<Artifact> {
  return artifactResponse.parse(
    embedded ? await tool('artifact_open', { path }) : await api('open', { path }),
  ).artifact;
}

export async function cadDecoder(signal?: AbortSignal, kind = 'cad'): Promise<ArrayBuffer> {
  if (!embedded) {
    const response = await fetch(`/api/cad-decoder?kind=${kind}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) throw new Error('CAD decoder unavailable.');
    return response.arrayBuffer();
  }
  return readBundledBytes('artifact_cad_decoder', kind, signal);
}

export async function embeddedParserWorker(
  kind: 'cad' | 'data',
  signal: AbortSignal,
): Promise<Worker> {
  const gzip = await readBundledBytes('artifact_parser_script', kind, signal);
  const stream = new Blob([gzip]).stream().pipeThrough(new DecompressionStream('gzip'));
  const script = await new Response(stream).arrayBuffer();
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readBundledBytes(
  name: 'artifact_cad_decoder' | 'artifact_parser_script',
  kind: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let offset = 0,
    total = 0;
  do {
    signal?.throwIfAborted();
    const result = parserResponse.parse(await tool(name, { offset, kind }, signal));
    total = result.total;
    if (total > MAX_PARSER_BYTES) throw new Error('Parser exceeds size limit.');
    const chunk = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
    if (!chunk.length) throw new Error('Incomplete parser download.');
    chunks.push(chunk);
    offset += chunk.length;
  } while (offset < total);
  const bytes = new Uint8Array(total);
  offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}
