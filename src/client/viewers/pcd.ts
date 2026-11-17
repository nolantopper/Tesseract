import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';

// Check allocation sizes before handing untrusted headers to the loader.
export function parsePcd(data: ArrayBuffer) {
  if (data.byteLength > 64 * 1024 * 1024) throw new Error('PCD file exceeds 64 MiB.');
  const header = new TextDecoder().decode(data.slice(0, 64 * 1024));
  const end = /^DATA (ascii|binary|binary_compressed)\r?\n/m.exec(header);
  if (!end) throw new Error('Invalid PCD header: expected DATA within the first 64 KiB.');
  const headerLength = end.index + end[0].length;
  const values = (key: string) =>
    new RegExp(`^${key} ([^\\r\\n]+)`, 'm')
      .exec(header.slice(0, headerLength))?.[1]
      .trim()
      .split(/\s+/) ?? [];
  const fields = values('FIELDS'),
    sizes = values('SIZE').map(Number),
    types = values('TYPE');
  const counts = values('COUNT').length ? values('COUNT').map(Number) : fields.map(() => 1);
  if (
    !['x', 'y', 'z'].every((key) => fields.includes(key)) ||
    new Set(fields).size !== fields.length ||
    sizes.length !== fields.length ||
    types.length !== fields.length ||
    counts.length !== fields.length ||
    sizes.some((n) => ![1, 2, 4, 8].includes(n)) ||
    types.some((t) => !['F', 'I', 'U'].includes(t)) ||
    counts.some((n) => n !== 1)
  )
    throw new Error('Unsupported PCD fields: require x/y/z and scalar fields.');
  const width = Number(values('WIDTH')[0]),
    height = Number(values('HEIGHT')[0]);
  const points = Number(values('POINTS')[0] ?? width * height);
  if (!Number.isSafeInteger(points) || points < 1 || points > 6_000_000)
    throw new Error('PCD exceeds the 6 million point limit or has an invalid point count.');
  const size = points * sizes.reduce((sum, n) => sum + n, 0);
  if (size > 64 * 1024 * 1024) throw new Error('PCD decoded data exceeds 64 MiB.');
  if (end[1] === 'binary' && data.byteLength - headerLength !== size)
    throw new Error('PCD binary payload does not match its declared size.');
  if (end[1] === 'binary_compressed') {
    if (data.byteLength < headerLength + 8) throw new Error('Truncated PCD compressed payload.');
    const view = new DataView(data, headerLength);
    if (
      view.getUint32(4, true) !== size ||
      view.getUint32(0, true) !== data.byteLength - headerLength - 8
    )
      throw new Error('PCD compressed payload does not match its declared size.');
  }
  const object = new PCDLoader().parse(data);
  const position = object.geometry.getAttribute('position');
  if (!position || position.count !== points || position.array.some((n) => !Number.isFinite(n))) {
    object.geometry.dispose();
    object.material.dispose();
    throw new Error('PCD contains invalid coordinates or a mismatched point count.');
  }
  return object;
}
