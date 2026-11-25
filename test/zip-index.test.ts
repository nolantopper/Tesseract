import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { archiveLimit } from '../src/shared/archives.js';
import { decodeZipEntry, indexZip, readZipEntry } from '../src/shared/zip.js';

test('ZIPs over the preview limit list entries and read the selected item by range', async () => {
  const data = zipSync({
    'large.bin': [new Uint8Array(archiveLimit + 1), { level: 0 }],
    'nested/readme.txt': strToU8('line of text\n'.repeat(40)),
  });
  let bytesRead = 0;
  const read = async (offset: number, size: number) => {
    bytesRead += size;
    return data.slice(offset, offset + size).buffer;
  };
  const { entries } = await indexZip(data.length, read);
  assert.deepEqual([...entries.keys()], ['large.bin', 'nested/readme.txt']);
  const before = bytesRead;
  await assert.rejects(readZipEntry(entries.get('large.bin')!, read), /64 MiB preview limit/);
  assert.equal(bytesRead, before);

  const entry = entries.get('nested/readme.txt')!;
  const packed = await readZipEntry(entry, read);
  assert.equal(
    new TextDecoder().decode(decodeZipEntry(packed, entry)),
    'line of text\n'.repeat(40),
  );
  assert.ok(bytesRead < 100_000, 'only metadata and the selected file should be read');
});

test('ZIP range previews verify entry integrity and reject ambiguous paths', async () => {
  const data = zipSync({ 'file.txt': strToU8('hello') }, { level: 0 });
  const read = async (offset: number, size: number) => data.slice(offset, offset + size).buffer;
  const { entries } = await indexZip(data.length, read);
  const entry = entries.get('file.txt')!;
  const packed = await readZipEntry(entry, read);
  new Uint8Array(packed)[0] = 0;
  assert.throws(() => decodeZipEntry(packed, entry), /checksum/);

  const mismatched = data.slice();
  new DataView(mismatched.buffer).setUint32(entry.localOffset + 22, 6, true);
  await assert.rejects(
    readZipEntry(entry, async (offset, size) => mismatched.slice(offset, offset + size).buffer),
    /local header/,
  );

  const duplicate = zipSync({ 'file.txt': strToU8('first'), './file.txt': strToU8('second') });
  await assert.rejects(
    indexZip(
      duplicate.length,
      async (offset, size) => duplicate.slice(offset, offset + size).buffer,
    ),
    /Duplicate/,
  );
});

test('ZIP64 directory offsets resolve to the same bounded entry', async () => {
  const data = zipSync({ 'notes.txt': strToU8('large archive, small file') });
  const endOffset = data.length - 22;
  const original = new DataView(data.buffer, endOffset);
  const zip64 = new Uint8Array(data.length + 76);
  zip64.set(data.subarray(0, endOffset));
  zip64.set(data.subarray(endOffset), endOffset + 76);
  const records = new DataView(zip64.buffer, endOffset);
  records.setUint32(0, 0x06064b50, true);
  records.setBigUint64(4, 44n, true);
  records.setBigUint64(24, 1n, true);
  records.setBigUint64(32, 1n, true);
  records.setBigUint64(40, BigInt(original.getUint32(12, true)), true);
  records.setBigUint64(48, BigInt(original.getUint32(16, true)), true);
  records.setUint32(56, 0x07064b50, true);
  records.setBigUint64(64, BigInt(endOffset), true);
  records.setUint32(72, 1, true);
  records.setUint32(76 + 12, 0xffffffff, true);
  records.setUint32(76 + 16, 0xffffffff, true);

  const read = async (offset: number, size: number) => zip64.slice(offset, offset + size).buffer;
  const { entries } = await indexZip(zip64.length, read);
  const entry = entries.get('notes.txt')!;
  const bytes = decodeZipEntry(await readZipEntry(entry, read), entry);
  assert.equal(new TextDecoder().decode(bytes), 'large archive, small file');
});
