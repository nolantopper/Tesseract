import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, symlink, rm, open, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FileAccess } from '../src/server/files.js';
import { ArtifactStore } from '../src/server/store.js';
import { inspectMcap } from '../src/server/mcap.js';
import { detectFormat } from '../src/shared/formats.js';
import { RESOURCE_URI } from '../src/server/mcp.js';

const samples = resolve('samples');
test('router prefers file signatures and returns an explicit fallback', () => {
  assert.equal(detectFormat('model.bin', new Uint8Array([0x67, 0x6c, 0x54, 0x46])).id, 'glb');
  assert.equal(detectFormat('image.stl', new Uint8Array([0x89, 0x50, 0x4e, 0x47])).id, 'png');
  assert.equal(detectFormat('file.OBJ', new Uint8Array()).id, 'obj');
  assert.equal(detectFormat('file.step', new Uint8Array()).id, 'step');
  assert.equal(
    detectFormat('file.bin', new Uint8Array(), 'application/octet-stream').id,
    'unknown',
  );
  assert.equal(detectFormat('.gitignore', Buffer.from('dist/\n# Français\n')).kind, 'text');
  assert.equal(detectFormat('file.custom', Buffer.from([0, 65, 66])).kind, 'unknown');
  assert.equal(detectFormat('archive', Buffer.from([0x50, 0x4b, 0x05, 0x06])).id, 'zip');
});
test('workspace guard blocks traversal, sibling prefixes, symlinks, and directories', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'tesseract-security-'));
  try {
    const root = resolve(temp, 'root');
    const sibling = resolve(temp, 'root-other');
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(resolve(sibling, 'secret'), 'private');
    await symlink(resolve(sibling, 'secret'), resolve(root, 'escape'));
    const access = await FileAccess.create([root]);
    await assert.rejects(access.open('../root-other/secret'), /outside/);
    await assert.rejects(access.open(resolve(sibling, 'secret')), /outside/);
    await assert.rejects(access.open('escape'), /outside/);
    await assert.rejects(access.open('.'), /regular files/);
    await assert.rejects(access.open('missing'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('stable references, bounded reads, and revision-scoped selections survive refresh correctly', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'tesseract-state-'));
  try {
    await writeFile(resolve(temp, 'part.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3');
    const store = new ArtifactStore(await FileAccess.create([temp]));
    const a = await store.inspect('part.obj');
    await store.select({
      artifactId: a.id,
      path: 'untrusted-path',
      revision: a.revision,
      kind: 'object',
      objectId: 'object-0',
      coordinates: [0, 0, 0],
    });
    assert.equal(store.selections.get(a.id)?.path, a.path);
    assert.equal((await store.read(a.id, 0, 3, a.revision)).toString(), 'v 0');
    await assert.rejects(store.read(a.id, 0, 1024 * 1024 + 1, a.revision), /Invalid byte range/);
    await writeFile(a.path, 'v 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3\n# revised');
    const next = await store.inspect('part.obj');
    assert.equal(next.id, a.id);
    assert.notEqual(next.revision, a.revision);
    assert.equal(store.selections.has(a.id), false);
    await assert.rejects(
      store.select({ artifactId: a.id, path: a.path, revision: a.revision, kind: 'object' }),
      /older/,
    );
    await assert.rejects(store.read(a.id, 0, 3, a.revision), /changed/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('MCAP indexed metadata, channels, counts, and nanosecond timestamps are preserved', async () => {
  const store = new ArtifactStore(await FileAccess.create([samples]));
  const a = await store.inspect('robot.mcap');
  assert.equal(a.warning, undefined);
  assert.equal(a.mcap?.indexed, true);
  assert.equal(a.mcap?.messageCount, '60');
  assert.equal(a.mcap?.topics.length, 3);
  assert.equal(a.mcap?.startTime, '1730000000000000000');
  assert.equal(a.mcap?.endTime, '1730000005900000000');
  assert.equal(a.mcap?.metadata[0].values.robot, 'demo-arm');
  await store.select({
    artifactId: a.id,
    path: a.path,
    revision: a.revision,
    kind: 'time',
    timestampNs: '1730000000000000001',
    channelId: a.mcap!.topics[0].id,
  });
  assert.equal(store.selections.get(a.id)?.timestampNs, '1730000000000000001');
  await assert.rejects(
    store.select({
      artifactId: a.id,
      path: a.path,
      revision: a.revision,
      kind: 'time',
      timestampNs: '999',
    }),
    /outside/,
  );
  const invalid = await store.inspect('invalid.mcap');
  assert.ok(invalid.warning);
  assert.equal(invalid.mcap, undefined);
  const file = await open(resolve(samples, 'robot.mcap'));
  try {
    let bytes = 0;
    const original = file.read.bind(file);
    const metered = new Proxy(file, {
      get(target, key) {
        if (key === 'read')
          return async (...args: any[]) => {
            bytes += args[2];
            return (original as any)(...args);
          };
        return Reflect.get(target, key);
      },
    });
    await inspectMcap(metered, (await file.stat()).size);
    assert.ok(bytes < (await file.stat()).size, 'indexed reader should skip message data');
  } finally {
    await file.close();
  }
});
test('the former standalone viewer flag fails without printing a URL', () => {
  const launched = spawnSync(process.execPath, [resolve('dist/server/index.js'), '--web'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(launched.status, 1);
  assert.equal(launched.stdout, '');
  assert.match(launched.stderr, /Unknown option '--web'/);
});
test('real stdio MCP exposes tools, UI resource, byte reads, and shared selections', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/server/index.js'), '--root', samples],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'tesseract-integration-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.name, 'tesseract');
    assert.equal(client.getServerVersion()?.title, 'Tesseract');
    const list = await client.listTools();
    assert.deepEqual(list.tools.find((t) => t.name === 'artifact_open')?._meta?.ui, {
      resourceUri: RESOURCE_URI,
    });
    const opened = await client.callTool({
      name: 'artifact_open',
      arguments: { path: 'bracket.glb' },
    });
    assert.ok(!opened.isError);
    const { artifact } = opened.structuredContent as any;
    assert.deepEqual(Object.keys(opened.structuredContent ?? {}), ['artifact']);
    assert.equal(artifact.format.id, 'glb');
    assert.equal(RESOURCE_URI, 'ui://tesseract/viewer.html');
    const { resources } = await client.listResources();
    assert.deepEqual(
      resources.map((resource) => resource.uri),
      [RESOURCE_URI],
    );
    const resource = await client.readResource({ uri: RESOURCE_URI });
    assert.match((resource.contents[0] as any).text, /<title>Tesseract<\/title>/);
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    await assert.rejects(
      client.readResource({ uri: 'ui://tesseract/viewer-unknown.html' }),
      /Resource not found/,
    );
    const read = await client.callTool({
      name: 'artifact_read',
      arguments: { artifactId: artifact.id, revision: artifact.revision, offset: 0, length: 4 },
    });
    assert.equal(Buffer.from((read.structuredContent as any).data, 'base64').toString(), 'glTF');
    const selection = {
      artifactId: artifact.id,
      revision: artifact.revision,
      path: artifact.path,
      kind: 'object',
      objectId: 'object-0',
      coordinates: [1, 2, 3],
    };
    const selected = await client.callTool({ name: 'artifact_select', arguments: selection });
    assert.ok(!selected.isError);
    const response = await client.callTool({
      name: 'artifact_get_selection',
      arguments: { artifactId: artifact.id },
    });
    assert.deepEqual((response.structuredContent as any).selection.coordinates, [1, 2, 3]);
    const blocked = await client.callTool({
      name: 'artifact_open',
      arguments: { path: '/etc/passwd' },
    });
    assert.equal(blocked.isError, true);
  } finally {
    await client.close();
  }
});
