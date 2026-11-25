const axes = { x: [1, 2], y: [2, 0], z: [0, 1] } as const;
export type RotationAxis = keyof typeof axes;
export function isRotatableMesh(format: string): format is 'stl' | 'obj' | 'ply' | 'pcd' {
  return ['stl', 'obj', 'ply', 'pcd'].includes(format);
}
type RotatableMesh = 'stl' | 'obj' | 'ply' | 'pcd';

const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const negate = (value: string) =>
  value.startsWith('-') ? value.slice(1) : '-' + value.replace(/^\+/, '');

// Edit source coordinates so faces, groups, material references, and STL attributes survive.
export function rotateMeshSource(bytes: ArrayBuffer, format: RotatableMesh, axis: RotationAxis) {
  const [a, b] = axes[axis];
  if (format === 'ply' || format === 'pcd') return rotateCloud(bytes, format, a, b);
  if (format === 'stl' && bytes.byteLength >= 84) {
    const source = new DataView(bytes);
    const faces = source.getUint32(80, true);
    if (faces > 0 && 84 + 50 * faces === bytes.byteLength) {
      const output = bytes.slice(0);
      const edited = new DataView(output);
      for (let start = 84; start < bytes.byteLength; start += 50) {
        for (let tuple = start; tuple < start + 48; tuple += 12) {
          const first = tuple + 4 * a;
          const second = tuple + 4 * b;
          edited.setUint32(first, source.getUint32(second, true) ^ 0x80000000, true);
          edited.setUint32(second, source.getUint32(first, true), true);
        }
      }
      return output;
    }
  }

  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (format === 'stl' && !/^\uFEFF?solid\b/.test(source))
    throw new Error('This STL does not have a supported source layout.');
  if (format === 'obj' && /^[\t ]*(?:call|csh)(?=[\t ])/m.test(source))
    throw new Error('An OBJ with external instructions cannot be rotated.');
  const records =
    format === 'obj'
      ? /^([\t \uFEFF]*v(?:n)?[\t ]+)([^\r\n]*)/gm
      : /^([\t ]*(?:facet[\t ]+normal|vertex)[\t ]+)([^\r\n]*)/gm;
  let touched = false;
  const output = source.replace(records, (_, prefix: string, tail: string) => {
    const fields = /^(\S+)([\t ]+)(\S+)([\t ]+)(\S+)(.*)$/.exec(tail);
    const values = fields && [fields[1], fields[3], fields[5]];
    if (!fields || !values || values.some((value) => !number.test(value)))
      throw new Error('A mesh coordinate could not be rotated.');
    [values[a], values[b]] = [negate(values[b]), values[a]];
    touched = true;
    return prefix + values[0] + fields[2] + values[1] + fields[4] + values[2] + fields[6];
  });
  if (!touched) throw new Error('This mesh has no editable coordinates.');
  return new TextEncoder().encode(output);
}

type Field = { name: string; size: number; float?: boolean };
type Cloud = {
  fields: Field[];
  normals: string[];
  points: number;
  encoding: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  trailingFaces?: boolean;
};

const pclMetadata =
  /\b(?:coordinate.?system|sensor.?origin|frame(?:.?id)?|viewpoint|orientation|quaternion|up.?axis|transform|rotation|georeferenc\w*)\b/i;
const otherPointFields = new Set([
  'r',
  'g',
  'b',
  'a',
  'rgb',
  'rgba',
  'red',
  'green',
  'blue',
  'alpha',
  'diffuse_red',
  'diffuse_green',
  'diffuse_blue',
  'diffuse_alpha',
  'u',
  'v',
  's',
  't',
  'tx',
  'ty',
  'texture_u',
  'texture_v',
  'intensity',
  'curvature',
  'confidence',
  'quality',
  'label',
]);
const propertySizes: Readonly<Record<string, number>> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};
const plyScalar = (type: string) => (Object.hasOwn(propertySizes, type) ? propertySizes[type] : 0);
const plyFloat = (type: string) => /^(float(?:32|64)?|double)$/.test(type);
const count = (value?: string) => (value && /^\d+$/.test(value) ? Number(value) : NaN);
function cloudError(format: 'ply' | 'pcd'): never {
  throw new Error(`This ${format.toUpperCase()} layout cannot be rotated safely.`);
}

function plyLayout(header: string): Cloud {
  const lines = header.trimEnd().split(/\r?\n/);
  const encoding = /^format (ascii|binary_little_endian|binary_big_endian) 1\.0$/.exec(
    lines[1],
  )?.[1] as Cloud['encoding'] | undefined;
  if (lines[0] !== 'ply' || !encoding) return cloudError('ply');
  const fields: Field[] = [];
  let points = NaN,
    faces: number | undefined;
  for (const line of lines.slice(2, -1)) {
    const [kind, ...args] = line.trim().split(/\s+/);
    if (kind === 'comment' && !pclMetadata.test(args.join(' '))) continue;
    if (kind === 'element' && args.length === 2) {
      if (args[0] === 'vertex' && Number.isNaN(points)) {
        points = count(args[1]);
        if (!Number.isSafeInteger(points) || points < 1) return cloudError('ply');
        continue;
      }
      if (args[0] === 'face' && points > 0 && faces === undefined) {
        faces = count(args[1]);
        if (!Number.isSafeInteger(faces)) return cloudError('ply');
        continue;
      }
    }
    if (kind === 'property' && points > 0) {
      const [type, name] = args;
      if (faces === undefined && args.length === 2 && plyScalar(type)) {
        fields.push({ name, size: plyScalar(type), float: plyFloat(type) });
        continue;
      }
      if (
        faces !== undefined &&
        type === 'list' &&
        args.length === 4 &&
        plyScalar(args[1]) &&
        !plyFloat(args[1]) &&
        plyScalar(args[2]) &&
        ['vertex_indices', 'vertex_index', 'texcoord'].includes(args[3])
      )
        continue;
      if (faces !== undefined && args.length === 2 && plyScalar(type) && otherPointFields.has(name))
        continue;
    }
    return cloudError('ply');
  }
  return { fields, points, encoding, normals: ['nx', 'ny', 'nz'], trailingFaces: Boolean(faces) };
}

function pcdLayout(header: string): Cloud {
  const fieldsByKey = new Map<string, string[]>();
  for (const line of header.trimEnd().split(/\r?\n/)) {
    if (line.startsWith('#') && !pclMetadata.test(line)) continue;
    const [key, ...values] = line.trim().split(/\s+/);
    if (
      fieldsByKey.has(key) ||
      !['VERSION', 'FIELDS', 'SIZE', 'TYPE', 'COUNT', 'WIDTH', 'HEIGHT', 'POINTS', 'DATA'].includes(
        key,
      )
    )
      return cloudError('pcd');
    fieldsByKey.set(key, values);
  }
  const values = (key: string) => fieldsByKey.get(key) ?? [];
  const names = values('FIELDS'),
    widths = values('SIZE'),
    types = values('TYPE');
  const counts = values('COUNT');
  const width = count(values('WIDTH')[0]),
    height = count(values('HEIGHT')[0]);
  const points = fieldsByKey.has('POINTS') ? count(values('POINTS')[0]) : width * height;
  const encoding = values('DATA')[0];
  if (
    names.length !== widths.length ||
    names.length !== types.length ||
    widths.some((width) => !['1', '2', '4', '8'].includes(width)) ||
    types.some((type) => !['F', 'U', 'I'].includes(type)) ||
    (fieldsByKey.has('COUNT') &&
      (counts.length !== names.length || counts.some((n) => n !== '1'))) ||
    (encoding !== 'ascii' && encoding !== 'binary') ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    points !== width * height
  )
    return cloudError('pcd');
  const fields = names.map((name, index) => ({
    name,
    size: Number(widths[index]),
    float: types[index] === 'F',
  }));
  return {
    fields,
    points,
    normals: ['normal_x', 'normal_y', 'normal_z'],
    encoding: encoding === 'ascii' ? encoding : 'binary_little_endian',
  };
}

function rotateCloud(bytes: ArrayBuffer, format: 'ply' | 'pcd', a: number, b: number) {
  const prefix = new TextDecoder('latin1').decode(bytes.slice(0, 64 * 1024));
  const end = (format === 'ply' ? /^end_header\r?\n/m : /^DATA (?:ascii|binary)\r?\n/m).exec(
    prefix,
  );
  if (!end) return cloudError(format);
  const start = end.index + end[0].length;
  const cloud = (format === 'ply' ? plyLayout : pcdLayout)(prefix.slice(0, start));
  const { fields, normals, points, encoding, trailingFaces } = cloud;
  const names = fields.map(({ name }) => name);
  const positions = ['x', 'y', 'z'];
  const triplets = [positions, ...(normals.some((key) => names.includes(key)) ? [normals] : [])];
  const tuples = triplets.map((triplet) => triplet.map((key) => names.indexOf(key)));
  if (
    !Number.isSafeInteger(points) ||
    points <= 0 ||
    new Set(names).size !== names.length ||
    names.some(
      (key) => !positions.includes(key) && !normals.includes(key) && !otherPointFields.has(key),
    ) ||
    tuples.some((tuple) =>
      tuple.some((index) => {
        const f = fields[index];
        return (
          !f?.float ||
          (f.size !== 4 && (format !== 'ply' || f.size !== 8)) ||
          f.size !== fields[tuple[0]]?.size
        );
      }),
    )
  )
    return cloudError(format);

  if (encoding === 'ascii') {
    const payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.slice(start),
    );
    let row = 0;
    const edited = payload.replace(/[^\r\n]+/g, (line) => {
      if (!line.trim()) return line;
      if (row >= points) return trailingFaces ? line : cloudError(format);
      row++;
      const tokens = [...line.matchAll(/[^\t ]+/g)].map((match) => match[0]);
      if (tokens.length !== fields.length) return cloudError(format);
      for (const tuple of tuples) {
        if (
          tuple.some(
            (index) => !number.test(tokens[index]) || !Number.isFinite(Number(tokens[index])),
          )
        )
          return cloudError(format);
        const first = tuple[a],
          second = tuple[b];
        [tokens[first], tokens[second]] = [negate(tokens[second]), tokens[first]];
      }
      let index = 0;
      return line.replace(/[^\t ]+/g, () => tokens[index++]);
    });
    if (row !== points) return cloudError(format);
    const body = new TextEncoder().encode(edited);
    const output = new Uint8Array(start + body.length);
    output.set(new Uint8Array(bytes, 0, start));
    output.set(body, start);
    return output;
  }
  let stride = 0;
  const offsets = fields.map(({ size }) => {
    const offset = stride;
    stride += size;
    return offset;
  });
  const endOfPoints = start + stride * points;
  if (endOfPoints > bytes.byteLength || (!trailingFaces && endOfPoints !== bytes.byteLength))
    return cloudError(format);
  const littleEndian = encoding === 'binary_little_endian';
  const output = bytes.slice(0);
  const source = new DataView(bytes),
    edited = new DataView(output);
  for (let row = start; row < endOfPoints; row += stride) {
    for (const tuple of tuples) {
      const first = row + offsets[tuple[a]],
        second = row + offsets[tuple[b]];
      if (fields[tuple[0]].size === 4) {
        if (
          tuple.some(
            (index) => !Number.isFinite(source.getFloat32(row + offsets[index], littleEndian)),
          )
        )
          return cloudError(format);
        edited.setUint32(first, source.getUint32(second, littleEndian) ^ 0x80000000, littleEndian);
        edited.setUint32(second, source.getUint32(first, littleEndian), littleEndian);
      } else {
        if (
          tuple.some(
            (index) => !Number.isFinite(source.getFloat64(row + offsets[index], littleEndian)),
          )
        )
          return cloudError(format);
        edited.setBigUint64(
          first,
          source.getBigUint64(second, littleEndian) ^ (1n << 63n),
          littleEndian,
        );
        edited.setBigUint64(second, source.getBigUint64(first, littleEndian), littleEndian);
      }
    }
  }
  return output;
}
