import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { gzipFilename, unpack } from '../src/shared/archives.js';
import { renameGzipEntry, renameTarEntry, renameZipEntry } from '../src/shared/archive-edits.js';
import { indexZip, readZipEntry } from '../src/shared/zip.js';

test('ZIP rename preserves member bytes, comments and central offsets', async () => {
  const source = new Uint8Array(
    zipSync({
      'nested/a.txt': [strToU8('original payload'), { comment: 'entry note', level: 6 }],
      'other.txt': strToU8('other payload'),
    }),
  );
  const output = await renameZipEntry(source.buffer, 'nested/a.txt', 'longer-name.txt');
  const read = (bytes: Uint8Array) => async (offset: number, length: number) =>
    new Uint8Array(bytes.subarray(offset, offset + length)).buffer;
  const before = await indexZip(source.length, read(source));
  const after = await indexZip(output.length, read(output));
  assert.deepEqual([...after.entries.keys()], ['nested/longer-name.txt', 'other.txt']);
  for (const [previous, current] of [
    ['nested/a.txt', 'nested/longer-name.txt'],
    ['other.txt', 'other.txt'],
  ]) {
    assert.deepEqual(
      await readZipEntry(before.entries.get(previous)!, read(source)),
      await readZipEntry(after.entries.get(current)!, read(output)),
    );
  }
  assert(Buffer.from(output).includes('entry note'));
  assert.deepEqual(unzipSync(output)['nested/longer-name.txt'], strToU8('original payload'));
  await assert.rejects(renameZipEntry(source.buffer, 'other.txt', '../outside'), /file name/);
});

test('TAR rename preserves the data block and recomputes the header checksum', () => {
  const source = new Uint8Array(2048);
  source.set(strToU8('./readme.txt'));
  source.set(strToU8('00000000004\0'), 124);
  source.set(strToU8('0'), 156);
  source.set(strToU8('ustar\0'), 257);
  source.set(strToU8('data'), 512);
  const checksum = source
    .subarray(0, 512)
    .reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  source.set(strToU8(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
  const edited = renameTarEntry(source.buffer, 'readme.txt', 'new.txt');
  assert.deepEqual(edited.subarray(512), source.subarray(512));
  assert.deepEqual(unpack(edited, 'tar', 'sample.tar')['./new.txt'], strToU8('data'));
  const expected = edited
    .subarray(0, 512)
    .reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  assert.equal(Number.parseInt(new TextDecoder().decode(edited.subarray(148, 154)), 8), expected);
});

test('GZIP rename keeps the original compressed payload and footer', () => {
  const source = new Uint8Array(gzipSync(strToU8('data'), { filename: 'old.txt' }));
  const output = renameGzipEntry(source.buffer, 'new-name.txt');
  assert.deepEqual(
    output.subarray(gzipFilename(output).end),
    source.subarray(gzipFilename(source).end),
  );
  assert.deepEqual(unpack(output, 'gz', 'archive.gz')['new-name.txt'], strToU8('data'));
});
