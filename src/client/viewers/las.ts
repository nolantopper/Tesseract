import { BufferGeometry, Float32BufferAttribute } from 'three';
export function parseLas(data: ArrayBuffer) {
  const view = new DataView(data);
  if (data.byteLength < 227 || new TextDecoder().decode(data.slice(0, 4)) !== 'LASF')
    throw new Error('Invalid LAS header.');
  const format = view.getUint8(104),
    stride = view.getUint16(105, true),
    offset = view.getUint32(96, true);
  if (format & 0xc0)
    throw new Error('Compressed LAZ requires a LASzip decoder; export uncompressed LAS.');
  if (format > 10) throw new Error('Unsupported LAS point format.');
  let count = view.getUint32(107, true);
  if (view.getUint8(25) >= 4 && data.byteLength >= 375) {
    const n = view.getBigUint64(247, true);
    if (n > 6_000_000n) throw new Error('LAS exceeds 6 million points.');
    if (n) count = Number(n);
  }
  if (
    !count ||
    count > 6_000_000 ||
    stride < 12 ||
    offset < 227 ||
    offset + stride * count > data.byteLength
  )
    throw new Error('Invalid LAS point count or truncated payload.');
  const scale = [131, 139, 147].map((at) => view.getFloat64(at, true)),
    origin = [155, 163, 171].map((at) => view.getFloat64(at, true));
  if ([...scale, ...origin].some((n) => !Number.isFinite(n)))
    throw new Error('Invalid LAS coordinates.');
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let j = 0; j < 3; j++) {
      const n = view.getInt32(offset + i * stride + j * 4, true) * scale[j] + origin[j];
      if (!Number.isFinite(n)) throw new Error('Invalid LAS point.');
      positions[i * 3 + j] = n;
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const colorOffset =
    format === 2 ? 20 : [3, 5].includes(format) ? 28 : [7, 8, 10].includes(format) ? 30 : undefined;
  if (colorOffset !== undefined && stride >= colorOffset + 6) {
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++)
      for (let j = 0; j < 3; j++)
        colors[i * 3 + j] = view.getUint16(offset + i * stride + colorOffset + j * 2, true) / 65535;
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  }
  return geometry;
}

export async function parseLaz(data: ArrayBuffer, wasmBinary: ArrayBuffer) {
  const { createLazPerf } = await import('laz-perf');
  const decoder = await createLazPerf({ wasmBinary });
  const input = decoder._malloc(data.byteLength);
  let output = 0;
  const reader = new decoder.LASZip();
  try {
    decoder.HEAPU8.set(new Uint8Array(data), input);
    reader.open(input, data.byteLength);
    const count = reader.getCount(),
      stride = reader.getPointLength(),
      format = reader.getPointFormat();
    const header = new DataView(data),
      offset = header.getUint32(96, true);
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 6_000_000 ||
      stride < 12 ||
      offset + count * stride > 64 * 1024 * 1024 ||
      offset > data.byteLength
    )
      throw new Error('LAZ decoded size exceeds limits.');
    const bytes = new Uint8Array(offset + count * stride);
    bytes.set(new Uint8Array(data, 0, offset));
    bytes[104] = format;
    output = decoder._malloc(stride);
    for (let i = 0; i < count; i++) {
      reader.getPoint(output);
      bytes.set(decoder.HEAPU8.subarray(output, output + stride), offset + i * stride);
    }
    return parseLas(bytes.buffer);
  } finally {
    reader.delete();
    decoder._free(input);
    if (output) decoder._free(output);
  }
}
