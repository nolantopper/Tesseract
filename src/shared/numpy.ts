export function inspectNpy(data: ArrayBuffer) {
  const bytes = new Uint8Array(data),
    view = new DataView(data);
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x93 ||
    new TextDecoder().decode(bytes.subarray(1, 6)) !== 'NUMPY'
  )
    throw new Error('Invalid NumPy signature.');
  const major = bytes[6];
  if (![1, 2, 3].includes(major)) throw new Error('Unsupported NumPy version.');
  if (major !== 1 && bytes.length < 12) throw new Error('Truncated NumPy header.');
  const offset = major === 1 ? 10 : 12,
    length = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  if (length > 65536 || offset + length > data.byteLength)
    throw new Error('Invalid NumPy header size.');
  const header = new TextDecoder().decode(bytes.subarray(offset, offset + length));
  const dtype = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header)?.[1];
  const shapeText = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!dtype || shapeText === undefined)
    throw new Error('Structured NumPy dtypes are not supported.');
  const shape = shapeText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (shape.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid NumPy shape.');
  const match = /^([<>=|])([fiub])(1|2|4|8)$/.exec(dtype);
  if (!match)
    throw new Error(
      'Only scalar numeric and boolean NumPy dtypes are supported. Object arrays are never executed.',
    );
  const [, order, type, sizeText] = match,
    size = Number(sizeText),
    count = shape.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(count) || count * size !== data.byteLength - offset - length)
    throw new Error('NumPy payload does not match its shape.');
  if (type === 'f' && ![4, 8].includes(size))
    throw new Error('Only float32 and float64 are supported.');
  const little =
    order === '<' ||
    order === '|' ||
    (order === '=' && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1);
  const values: (string | number)[] = [];
  for (let i = 0; i < Math.min(count, 10000); i++) {
    const at = offset + length + i * size;
    values.push(
      type === 'f'
        ? size === 4
          ? view.getFloat32(at, little)
          : view.getFloat64(at, little)
        : size === 8
          ? String(type === 'i' ? view.getBigInt64(at, little) : view.getBigUint64(at, little))
          : type === 'i'
            ? size === 1
              ? view.getInt8(at)
              : size === 2
                ? view.getInt16(at, little)
                : view.getInt32(at, little)
            : size === 1
              ? view.getUint8(at)
              : size === 2
                ? view.getUint16(at, little)
                : view.getUint32(at, little),
    );
  }
  return {
    dtype,
    shape,
    storage: /['"]fortran_order['"]\s*:\s*True/.test(header) ? 'column-major' : 'row-major',
    count,
    preview: values,
    truncated: count > values.length,
  };
}
