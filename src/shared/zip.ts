import { Inflate, strFromU8 } from 'fflate';
import { archiveLimit, safeEntry } from './archives.js';

const maxUint32 = 0xffffffff;
const directoryCountLimit = 2000;
const endRecordSize = 22;
const localHeaderSize = 30;

type ReadRange = (offset: number, length: number) => Promise<ArrayBuffer>;

export interface ZipEntry {
  path: string;
  directory: boolean;
  localOffset: number;
  directoryRecordOffset: number;
  endOffset: number;
  compressedSize: number;
  size: number;
  method: number;
  flags: number;
  checksum: number;
  nameBytes: Uint8Array;
}

const safeNumber = (value: bigint) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP offset exceeds size limit.');
  return Number(value);
};

export async function indexZip(size: number, read: ReadRange) {
  if (size < endRecordSize) throw new Error('ZIP directory is missing.');
  let tailOffset = size - endRecordSize;
  let tail = new DataView(await read(tailOffset, endRecordSize));
  if (tail.getUint32(0, true) !== 0x06054b50 || tail.getUint16(20, true)) {
    tailOffset = Math.max(0, tailOffset - 0xffff);
    tail = new DataView(await read(tailOffset, size - tailOffset));
  }
  let end = tail.byteLength - endRecordSize;
  while (
    end >= 0 &&
    (tail.getUint32(end, true) !== 0x06054b50 ||
      end + endRecordSize + tail.getUint16(end + 20, true) !== tail.byteLength)
  )
    end--;
  if (end < 0) throw new Error('ZIP directory is missing.');
  if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true))
    throw new Error('Split ZIP archives are unsupported.');

  let directoryEnd = tailOffset + end;
  let count = tail.getUint16(end + 10, true);
  let directorySize = tail.getUint32(end + 12, true);
  let directoryOffset = tail.getUint32(end + 16, true);
  const zip64Archive =
    count === 0xffff || directorySize === maxUint32 || directoryOffset === maxUint32;
  if (zip64Archive) {
    const locatorOffset = directoryEnd - 20;
    if (locatorOffset < 0) throw new Error('ZIP64 directory locator is missing.');
    const locator = new DataView(await read(locatorOffset, 20));
    if (
      locator.getUint32(0, true) !== 0x07064b50 ||
      locator.getUint32(4, true) !== 0 ||
      locator.getUint32(16, true) !== 1
    )
      throw new Error('Unsupported ZIP64 directory locator.');
    directoryEnd = safeNumber(locator.getBigUint64(8, true));
    if (directoryEnd + 56 > locatorOffset) throw new Error('Invalid ZIP64 directory offset.');
    const zip64 = new DataView(await read(directoryEnd, 56));
    const zip64Size = safeNumber(zip64.getBigUint64(4, true));
    if (
      zip64.getUint32(0, true) !== 0x06064b50 ||
      zip64Size < 44 ||
      zip64Size > locatorOffset - directoryEnd - 12 ||
      zip64.getUint32(16, true) ||
      zip64.getUint32(20, true) ||
      zip64.getBigUint64(24, true) !== zip64.getBigUint64(32, true)
    )
      throw new Error('Unsupported ZIP64 directory record.');
    count = safeNumber(zip64.getBigUint64(32, true));
    directorySize = safeNumber(zip64.getBigUint64(40, true));
    directoryOffset = safeNumber(zip64.getBigUint64(48, true));
  } else if (tail.getUint16(end + 8, true) !== count) {
    throw new Error('Split ZIP archives are unsupported.');
  }
  if (count > directoryCountLimit || directorySize > archiveLimit)
    throw new Error('ZIP directory exceeds 2,000 entries or 64 MiB.');
  if (directoryOffset > directoryEnd - directorySize || count * 46 > directorySize)
    throw new Error('Invalid ZIP directory size.');

  const directory = new DataView(await read(directoryOffset, directorySize));
  const entries = new Map<string, ZipEntry>();
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directorySize || directory.getUint32(cursor, true) !== 0x02014b50)
      throw new Error('Invalid ZIP directory entry.');
    const flags = directory.getUint16(cursor + 8, true);
    const directoryRecordOffset = directoryOffset + cursor;
    const method = directory.getUint16(cursor + 10, true);
    const checksum = directory.getUint32(cursor + 16, true);
    let compressedSize = directory.getUint32(cursor + 20, true);
    let size = directory.getUint32(cursor + 24, true);
    const nameLength = directory.getUint16(cursor + 28, true);
    const extraLength = directory.getUint16(cursor + 30, true);
    const commentLength = directory.getUint16(cursor + 32, true);
    let disk = directory.getUint16(cursor + 34, true);
    let localOffset = directory.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > directorySize || !nameLength || nameLength > 4096)
      throw new Error('Invalid ZIP entry name or size.');
    const nameBytes = new Uint8Array(directory.buffer, nameStart, nameLength).slice();
    const name = safeEntry(strFromU8(nameBytes, (flags & 0x800) === 0));
    const path = name
      .split('/')
      .filter((part) => part && part !== '.')
      .join('/');
    cursor = next;

    if (
      size === maxUint32 ||
      compressedSize === maxUint32 ||
      localOffset === maxUint32 ||
      disk === 0xffff
    ) {
      const end = extraStart + extraLength;
      let found = false;
      for (let extra = extraStart; extra + 4 <= end;) {
        const field = directory.getUint16(extra, true);
        const length = directory.getUint16(extra + 2, true);
        extra += 4;
        if (extra + length > end) throw new Error('Invalid ZIP64 extra field.');
        if (field === 1) {
          found = true;
          const fieldEnd = extra + length;
          const nextSize = () => {
            if (extra + 8 > fieldEnd) throw new Error('Missing ZIP64 entry size.');
            const value = safeNumber(directory.getBigUint64(extra, true));
            extra += 8;
            return value;
          };
          if (size === maxUint32) size = nextSize();
          if (compressedSize === maxUint32) compressedSize = nextSize();
          if (localOffset === maxUint32) localOffset = nextSize();
          if (disk === 0xffff) {
            if (extra + 4 > fieldEnd) throw new Error('Missing ZIP64 disk number.');
            disk = directory.getUint32(extra, true);
          }
          break;
        }
        extra += length;
      }
      if (!found) throw new Error('ZIP64 entry metadata is missing.');
    }

    if (disk || localOffset + localHeaderSize > directoryOffset)
      throw new Error('Invalid ZIP local header location.');
    if (!path && name.endsWith('/')) continue;
    if (!path || entries.has(path)) throw new Error('Duplicate or invalid ZIP entry path.');
    entries.set(path, {
      path,
      directory: name.endsWith('/'),
      localOffset,
      directoryRecordOffset,
      endOffset: directoryOffset,
      compressedSize,
      size,
      method,
      flags,
      checksum,
      nameBytes,
    });
  }
  const positions = [...entries.values()].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < positions.length; i++) {
    const entry = positions[i];
    entry.endOffset = positions[i + 1]?.localOffset ?? directoryOffset;
    if (entry.localOffset > entry.endOffset - localHeaderSize - entry.nameBytes.length)
      throw new Error('Overlapping ZIP local headers.');
  }
  return {
    entries,
    directoryOffset,
    directorySize,
    endOffset: tailOffset + end,
    simpleDirectory:
      !zip64Archive &&
      entries.size === count &&
      cursor === directorySize &&
      directoryOffset + directorySize === tailOffset + end,
  };
}

export async function readZipEntry(entry: ZipEntry, read: ReadRange) {
  const { localOffset, compressedSize, size, method, flags, nameBytes } = entry;
  if (size > archiveLimit || compressedSize > archiveLimit)
    throw new Error('ZIP entry exceeds the 64 MiB preview limit.');
  if (flags & 1) throw new Error('This ZIP entry is encrypted.');
  if (method !== 0 && method !== 8) throw new Error('This ZIP compression method is unsupported.');
  const local = await read(localOffset, localHeaderSize + nameBytes.length);
  const header = new DataView(local);
  const headerCompressedSize = header.getUint32(18, true);
  const headerSize = header.getUint32(22, true);
  const sizeMismatch =
    (flags & 8) === 0 &&
    (header.getUint32(14, true) !== entry.checksum ||
      (headerCompressedSize !== maxUint32 && headerCompressedSize !== compressedSize) ||
      (headerSize !== maxUint32 && headerSize !== size));
  if (
    header.getUint32(0, true) !== 0x04034b50 ||
    header.getUint16(6, true) !== flags ||
    header.getUint16(8, true) !== method ||
    header.getUint16(26, true) !== nameBytes.length ||
    sizeMismatch
  )
    throw new Error('Invalid ZIP local header.');
  const dataOffset = localOffset + local.byteLength + header.getUint16(28, true);
  if (dataOffset > entry.endOffset - compressedSize) throw new Error('Invalid ZIP entry size.');
  const name = new Uint8Array(local, localHeaderSize);
  if (name.some((byte, i) => byte !== nameBytes[i])) throw new Error('ZIP entry name changed.');
  return read(dataOffset, compressedSize);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

export function decodeZipEntry(
  packed: ArrayBuffer,
  { size, method, checksum }: Pick<ZipEntry, 'size' | 'method' | 'checksum'>,
): ArrayBuffer {
  const data = new Uint8Array(packed);
  let bytes = data;
  if (method === 8) {
    if (!data.length) throw new Error('ZIP deflate stream is missing.');
    bytes = new Uint8Array(size);
    let offset = 0;
    const inflate = new Inflate((chunk) => {
      if (chunk.length > size - offset) throw new Error('ZIP entry exceeds its declared size.');
      bytes.set(chunk, offset);
      offset += chunk.length;
    });
    const stride = 16384;
    for (let start = 0; start < data.length; start += stride)
      inflate.push(data.subarray(start, start + stride), start + stride >= data.length);
    if (offset !== size) throw new Error('ZIP entry size does not match its directory.');
  }
  if (bytes.length !== size) throw new Error('ZIP entry size does not match its directory.');
  let crc = maxUint32;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  if (~crc >>> 0 !== checksum) throw new Error('ZIP entry checksum does not match.');
  return bytes.buffer;
}
