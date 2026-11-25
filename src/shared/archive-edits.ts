import { archiveLimit, gzipFilename, safeEntry } from './archives.js';
import { indexZip, readZipEntry } from './zip.js';

function renamedPath(path: string, name: string) {
  if (!name.trim() || name === '.' || name === '..' || /[\/\\\u0000-\u001f]/.test(name))
    throw new Error('Enter a file name without a folder or control characters.');
  return safeEntry(path.slice(0, path.lastIndexOf('/') + 1) + name);
}

function checkZipExtras(view: DataView, start: number, length: number) {
  const end = start + length;
  for (let cursor = start; cursor < end;) {
    if (cursor + 4 > end) throw new Error('Invalid ZIP extra field.');
    const id = view.getUint16(cursor, true);
    if (id === 0x7075 || id === 0x0001)
      throw new Error('This ZIP uses extended filename or ZIP64 records.');
    cursor += 4 + view.getUint16(cursor + 2, true);
    if (cursor > end) throw new Error('Invalid ZIP extra field.');
  }
}

export async function renameZipEntry(source: ArrayBuffer, path: string, name: string, npz = false) {
  const read = async (offset: number, length: number) => source.slice(offset, offset + length);
  const { entries, directoryOffset, directorySize, endOffset, simpleDirectory } = await indexZip(
    source.byteLength,
    read,
  );
  const input = new Uint8Array(source);
  const signature = new TextEncoder().encode('APK Sig Block 42');
  if (
    !simpleDirectory ||
    (directoryOffset >= signature.length &&
      signature.every((byte, i) => input[directoryOffset - signature.length + i] === byte)) ||
    [...entries.keys()].some((name) => /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/i.test(name))
  )
    throw new Error('This ZIP directory layout cannot be edited safely.');
  const entry = entries.get(path);
  if (!entry || entry.directory) throw new Error('Select a file in the archive.');
  if (npz && !name.endsWith('.npy')) throw new Error('Keep the .npy extension for an NPZ array.');
  const newPath = renamedPath(path, name);
  if (newPath === path) return new Uint8Array(source);
  if (entries.has(newPath)) throw new Error('An entry already has that name.');
  if ((entry.flags & 0x800) === 0 && /[^\x20-\x7e]/.test(name))
    throw new Error('Enter an ASCII name for this ZIP.');

  const view = new DataView(source);
  const localName = entry.localOffset + 30;
  const centralName = entry.directoryRecordOffset + 46;
  const oldLength = entry.nameBytes.length;
  // The existing reader checks that the two headers agree and payload offsets are valid.
  await readZipEntry(entry, read);
  checkZipExtras(view, localName + oldLength, view.getUint16(entry.localOffset + 28, true));
  checkZipExtras(
    view,
    centralName + oldLength,
    view.getUint16(entry.directoryRecordOffset + 30, true),
  );
  if (
    [...entries.values()].some(
      ({ directoryRecordOffset }) =>
        view.getUint32(directoryRecordOffset + 42, true) === 0xffffffff,
    )
  )
    throw new Error('This ZIP uses ZIP64 offsets.');
  const prefix = entry.nameBytes.subarray(0, entry.nameBytes.lastIndexOf(47) + 1);
  const encoded = new TextEncoder().encode(name);
  const newLength = prefix.length + encoded.length;
  const shift = newLength - oldLength;
  if (newLength > 4096 || input.length + 2 * shift > archiveLimit)
    throw new Error('Renamed archive exceeds the save limit.');

  const bytes = new Uint8Array(input.length + 2 * shift);
  bytes.set(input.subarray(0, localName));
  bytes.set(prefix, localName);
  bytes.set(encoded, localName + prefix.length);
  bytes.set(input.subarray(localName + oldLength, centralName), localName + newLength);
  bytes.set(prefix, centralName + shift);
  bytes.set(encoded, centralName + shift + prefix.length);
  bytes.set(input.subarray(centralName + oldLength), centralName + shift + newLength);
  const result = new DataView(bytes.buffer);
  result.setUint16(entry.localOffset + 26, newLength, true);
  result.setUint16(entry.directoryRecordOffset + shift + 28, newLength, true);
  for (const current of entries.values()) {
    const centralShift =
      shift + (current.directoryRecordOffset > entry.directoryRecordOffset ? shift : 0);
    const localShift = current.localOffset > entry.localOffset ? shift : 0;
    result.setUint32(
      current.directoryRecordOffset + centralShift + 42,
      current.localOffset + localShift,
      true,
    );
  }
  result.setUint32(endOffset + 2 * shift + 12, directorySize + shift, true);
  result.setUint32(endOffset + 2 * shift + 16, directoryOffset + shift, true);
  return bytes;
}

function tarChecksum(bytes: Uint8Array, header: number) {
  return bytes
    .subarray(header, header + 512)
    .reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
}

export function renameTarEntry(source: ArrayBuffer, path: string, name: string) {
  const newPath = renamedPath(path, name);
  const bytes = new Uint8Array(source.slice(0));
  const decoder = new TextDecoder();
  const text = (start: number, length: number) =>
    decoder.decode(bytes.subarray(start, start + length)).split('\0')[0];
  const encoded = new TextEncoder().encode(name);
  if (encoded.length > 100) throw new Error('This TAR supports file names up to 100 bytes.');
  let header: number | undefined;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const storedName = text(offset, 100);
    const prefix = text(offset + 345, 155);
    const storedPath = safeEntry([prefix, storedName].filter(Boolean).join('/'))
      .split('/')
      .filter((segment) => segment && segment !== '.')
      .join('/');
    const kind = text(offset + 156, 1);
    const sizeField = text(offset + 124, 12).trim();
    const checksum = text(offset + 148, 8).trim();
    const size = /^[0-7]+$/.test(sizeField) ? Number.parseInt(sizeField, 8) : NaN;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (
      !Number.isSafeInteger(next) ||
      next > bytes.length ||
      !['', '0', '5'].includes(kind) ||
      !/^[0-7]+$/.test(checksum) ||
      Number.parseInt(checksum, 8) !== tarChecksum(bytes, offset)
    )
      throw new Error('This TAR header layout cannot be edited safely.');
    if (storedPath === path) {
      if (kind === '5' || header !== undefined) throw new Error('Select a unique TAR file.');
      const replacement = new TextEncoder().encode(
        storedName.slice(0, storedName.lastIndexOf('/') + 1) + name,
      );
      if (replacement.length > 100) throw new Error('The TAR header has no space for that name.');
      header = offset;
    } else if (storedPath.replace(/\/$/, '') === newPath)
      throw new Error('An entry already has that name.');
    offset = next;
  }
  if (header === undefined) throw new Error('Select a file in the archive.');
  const storedName = text(header, 100);
  const replacement = new TextEncoder().encode(
    storedName.slice(0, storedName.lastIndexOf('/') + 1) + name,
  );
  bytes.fill(0, header, header + 100);
  bytes.set(replacement, header);
  const checksum = tarChecksum(bytes, header);
  bytes.set(new TextEncoder().encode(checksum.toString(8).padStart(6, '0') + '\0 '), header + 148);
  return bytes;
}

export function renameGzipEntry(source: ArrayBuffer, name: string) {
  const input = new Uint8Array(source);
  if (!/^[\x20-\x7e]{1,1024}$/.test(name)) throw new Error('Enter a GZIP file name in ASCII.');
  renamedPath('', name);
  const { start, end } = gzipFilename(input);
  if (input[3] & 2) throw new Error('This GZIP uses a header checksum.');
  const size = input.length - (end - start) + name.length + 1;
  if (size > archiveLimit) throw new Error('Renamed archive exceeds the save limit.');
  const output = new Uint8Array(size);
  output.set(input.subarray(0, start));
  output[3] |= 8;
  output.set(new TextEncoder().encode(name), start);
  output.set(input.subarray(end), start + name.length + 1);
  return output;
}
