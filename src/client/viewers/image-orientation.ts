const orientationTag = 274;
const quarterTurns = [0, 6, 7, 8, 5, 2, 3, 4, 1];
const emptyExif = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function joinBytes(pieces: Uint8Array[]) {
  const joined = new Uint8Array(pieces.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of pieces) {
    joined.set(bytes, offset);
    offset += bytes.length;
  }
  return joined;
}

const matches = (bytes: Uint8Array, offset: number, tag: string) =>
  Array.from(tag).every((char, index) => bytes[offset + index] === char.charCodeAt(0));

export function turnOrientation(value: number) {
  return quarterTurns[value] || 6;
}

export function orientImage(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  value = 1,
) {
  switch (value) {
    case 2:
      context.transform(-1, 0, 0, 1, width, 0);
      break;
    case 3:
      context.transform(-1, 0, 0, -1, width, height);
      break;
    case 4:
      context.transform(1, 0, 0, -1, 0, height);
      break;
    case 5:
      context.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      context.transform(0, 1, -1, 0, height, 0);
      break;
    case 7:
      context.transform(0, -1, -1, 0, height, width);
      break;
    case 8:
      context.transform(0, -1, 1, 0, 0, width);
      break;
  }
}

export function rotateTiff(bytes: Uint8Array, page = 0, turns = 1, allowGeospatial = false) {
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = input.getUint16(0);
  const little = order === 0x4949;
  if ((!little && order !== 0x4d4d) || input.getUint16(2, little) !== 42)
    throw new Error('Rotation requires standard TIFF byte offsets.');
  let pointer = 4;
  const visited = new Set<number>();
  let directory: number;
  let count: number;
  let next: number;
  for (let index = 0; ; index++) {
    directory = input.getUint32(pointer, little);
    if (directory < 8 || directory + 2 > bytes.length || visited.has(directory))
      throw new Error('Invalid TIFF page directory.');
    visited.add(directory);
    count = input.getUint16(directory, little);
    next = directory + 2 + count * 12;
    if (next + 4 > bytes.length) throw new Error('Truncated TIFF page directory.');
    if (index === page) break;
    pointer = next;
  }
  let orientation = 0;
  let insert = next;
  for (let entry = directory + 2; entry < next; entry += 12) {
    const tag = input.getUint16(entry, little);
    if (!allowGeospatial && [33550, 33922, 34264, 34735, 34736, 34737].includes(tag))
      throw new Error('Georeferenced TIFF pages require a spatial transform to rotate.');
    if (tag === orientationTag) {
      if (
        orientation ||
        input.getUint16(entry + 2, little) !== 3 ||
        input.getUint32(entry + 4, little) !== 1
      )
        throw new Error('Invalid TIFF orientation tag.');
      orientation = entry + 8;
    }
    if (tag > orientationTag && insert === next) insert = entry;
  }
  let value = orientation ? input.getUint16(orientation, little) : 1;
  if (value < 1 || value > 8) throw new Error('Invalid TIFF orientation.');
  for (let i = 0; i < turns; i++) value = turnOrientation(value);
  if (orientation) {
    const result = bytes.slice();
    new DataView(result.buffer).setUint16(orientation, value, little);
    return result;
  }
  if (count === 65535) throw new Error('The TIFF directory cannot hold another entry.');
  // Append a replacement directory so existing strip, tile, and metadata offsets stay valid.
  const replacement = bytes.length + (bytes.length % 2);
  const result = new Uint8Array(replacement + (next - directory) + 16);
  result.set(bytes);
  const entryOffset = replacement + insert - directory;
  result.set(bytes.subarray(directory, insert), replacement);
  result.set(bytes.subarray(insert, next + 4), entryOffset + 12);
  const output = new DataView(result.buffer);
  output.setUint32(pointer, replacement, little);
  output.setUint16(replacement, count + 1, little);
  output.setUint16(entryOffset, orientationTag, little);
  output.setUint16(entryOffset + 2, 3, little);
  output.setUint32(entryOffset + 4, 1, little);
  output.setUint16(entryOffset + 8, value, little);
  return result;
}

export function rotateJpeg(bytes: Uint8Array, turns: number) {
  const inView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (inView.getUint16(0) !== 0xffd8) throw new Error('Invalid JPEG.');
  const exif = new Uint8Array([69, 120, 105, 102, 0, 0]);
  let start = 2;
  let end = 2;
  let tiff = emptyExif;
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset] !== 0xff) throw new Error('Invalid JPEG segment.');
    if (bytes[offset + 1] === 0xff) {
      offset++;
      continue;
    }
    if (bytes[offset + 1] === 0xda || bytes[offset + 1] === 0xd9) break;
    const length = inView.getUint16(offset + 2);
    const next = offset + 2 + length;
    if (length < 2 || next > bytes.length) throw new Error('Truncated JPEG segment.');
    if (
      bytes[offset + 1] === 0xe1 &&
      length >= 8 &&
      exif.every((byte, index) => byte === bytes[offset + 4 + index])
    ) {
      if (start !== end) throw new Error('This JPEG has more than one Exif segment.');
      start = offset;
      end = next;
      tiff = bytes.slice(offset + 10, next);
    }
    offset = next;
  }
  const rotated = rotateTiff(tiff, 0, turns, true);
  const length = 2 + exif.length + rotated.length;
  if (length > 65535) throw new Error('The JPEG Exif segment exceeds the format limit.');
  const result = new Uint8Array(bytes.length - (end - start) + length + 2);
  result.set(bytes.subarray(0, start));
  const output = new DataView(result.buffer);
  output.setUint16(start, 0xffe1);
  output.setUint16(start + 2, length);
  result.set(exif, start + 4);
  result.set(rotated, start + 4 + exif.length);
  result.set(bytes.subarray(end), start + 2 + length);
  return result;
}

function pngCrc(bytes: Uint8Array) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ~crc;
}

export function rotatePng(bytes: Uint8Array, turns: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a)
    throw new Error('Invalid PNG.');
  let tiff = emptyExif;
  let start = 0;
  let end = 0;
  let imageData = 0;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const next = offset + length + 12;
    if (next > bytes.length) throw new Error('Truncated PNG chunk.');
    if (matches(bytes, offset + 4, 'eXIf')) {
      if (start) throw new Error('This PNG has more than one Exif chunk.');
      start = offset;
      end = next;
      tiff = bytes.slice(offset + 8, next - 4);
    } else if (!imageData && matches(bytes, offset + 4, 'IDAT')) {
      imageData = offset;
    }
    offset = next;
  }
  if (!imageData) throw new Error('Missing PNG image data.');
  const rotated = rotateTiff(tiff, 0, turns, true);
  const chunk = new Uint8Array(rotated.length + 12);
  const output = new DataView(chunk.buffer);
  output.setUint32(0, rotated.length);
  chunk.set(new TextEncoder().encode('eXIf'), 4);
  chunk.set(rotated, 8);
  output.setUint32(chunk.length - 4, pngCrc(chunk.subarray(4, chunk.length - 4)));
  if (start && start < imageData)
    return joinBytes([bytes.subarray(0, start), chunk, bytes.subarray(end)]);
  return joinBytes([
    bytes.subarray(0, imageData),
    chunk,
    bytes.subarray(imageData, start || bytes.length),
    bytes.subarray(end || bytes.length),
  ]);
}
