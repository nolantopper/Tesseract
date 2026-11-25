export function parseNumericEdit(draft: string, type: string, size: number): number | bigint {
  const value = draft.trim();
  if (type === 'f') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
      throw new Error('Enter a finite number.');
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (size === 4 && !Number.isFinite(Math.fround(parsed))))
      throw new Error('Number is outside this data type’s range.');
    return parsed;
  }
  if (!/^[+-]?\d{1,20}$/.test(value)) throw new Error('Enter an integer.');
  const parsed = BigInt(value);
  const bits = BigInt(size * 8);
  const minimum = type === 'i' ? -(1n << (bits - 1n)) : 0n;
  const maximum = type === 'b' ? 1n : (1n << (type === 'i' ? bits - 1n : bits)) - 1n;
  if (parsed < minimum || parsed > maximum)
    throw new Error('Integer is outside this data type’s range.');
  return size === 8 ? parsed : Number(parsed);
}

export function writeNumericEdit(
  view: DataView,
  offset: number,
  type: string,
  size: number,
  little: boolean,
  draft: string,
) {
  const value = parseNumericEdit(draft, type, size);
  if (typeof value === 'bigint') {
    if (type === 'i') view.setBigInt64(offset, value, little);
    else view.setBigUint64(offset, value, little);
  } else if (type === 'f') {
    if (size === 4) view.setFloat32(offset, value, little);
    else view.setFloat64(offset, value, little);
  } else if (size === 1) {
    if (type === 'i') view.setInt8(offset, value);
    else view.setUint8(offset, value);
  } else if (size === 2) {
    if (type === 'i') view.setInt16(offset, value, little);
    else view.setUint16(offset, value, little);
  } else if (type === 'i') view.setInt32(offset, value, little);
  else view.setUint32(offset, value, little);
}
