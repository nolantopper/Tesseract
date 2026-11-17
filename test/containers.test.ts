import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, gzipSync, strToU8 } from 'fflate';
import { unpack } from '../src/shared/archives.js';
import { inspectNpy } from '../src/shared/numpy.js';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAccess } from '../src/server/files.js';
import { ArtifactStore } from '../src/server/store.js';
test('archives preview content and reject traversal, duplicate paths and excessive entries', () => {
  assert.equal(
    new TextDecoder().decode(
      unpack(zipSync({ 'nested/data.txt': strToU8('hello') }), 'zip', 'a.zip')['nested/data.txt'],
    ),
    'hello',
  );
  assert.equal(
    new TextDecoder().decode(unpack(gzipSync(strToU8('hello')), 'gz', 'data.txt.gz')['data.txt']),
    'hello',
  );
  assert.throws(
    () => unpack(zipSync({ '../escape.txt': strToU8('no') }), 'zip', 'bad.zip'),
    /Unsafe/,
  );
  assert.throws(
    () =>
      unpack(
        zipSync(
          Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [String(i), new Uint8Array()])),
        ),
        'zip',
        'many.zip',
      ),
    /limits|entries/,
  );
  const tar = new Uint8Array(1024);
  const text = new TextEncoder();
  tar.set(text.encode('hello.txt'));
  tar.set(text.encode('00000000003\0'), 124);
  tar[156] = 48;
  tar.set(text.encode('yes'), 512);
  assert.equal(new TextDecoder().decode(unpack(tar, 'tar', 'a.tar')['hello.txt']), 'yes');
  const compressedTar = unpack(gzipSync(tar), 'gz', 'example.TGZ')['example.tar'];
  assert.deepEqual(unpack(compressedTar, 'tar', 'example.tar')['hello.txt'], tar.slice(512, 515));
  tar[156] = 50;
  assert.throws(() => unpack(tar, 'tar', 'link.tar'), /links/);
});
test('folder browsing is bounded by roots, skips symlinks and opens child files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tesseract-folder-'));
  try {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'data.txt'), 'hello');
    await symlink('/etc', join(root, 'escape'));
    const store = new ArtifactStore(await FileAccess.create([root]));
    const folder = await store.inspect('.');
    assert.equal(folder.format.id, 'folder');
    assert.equal(folder.entries?.length, 2);
    assert.equal((await store.inspect('data.txt')).format.kind, 'text');
    await assert.rejects(store.inspect('escape'), /outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('NumPy previews preserve shape and numeric values and reject pickle/object payloads', () => {
  let header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2,), }\n";
  const bytes = new Uint8Array(10 + header.length + 8);
  bytes.set([0x93, 78, 85, 77, 80, 89, 1, 0]);
  new DataView(bytes.buffer).setUint16(8, header.length, true);
  bytes.set(strToU8(header), 10);
  new DataView(bytes.buffer).setFloat32(10 + header.length, 1.5, true);
  new DataView(bytes.buffer).setFloat32(14 + header.length, -2, true);
  assert.deepEqual(inspectNpy(bytes.buffer).preview, [1.5, -2]);
  assert.deepEqual(inspectNpy(bytes.buffer).shape, [2]);
  header = header.replace('<f4', '|O8');
  bytes.set(strToU8(header), 10);
  assert.throws(() => inspectNpy(bytes.buffer), /dtypes/);
});
