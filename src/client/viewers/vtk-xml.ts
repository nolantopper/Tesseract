import { XMLParser } from 'fast-xml-parser';
import { BufferGeometry, Float32BufferAttribute } from 'three';
export function parseVtkXml(data: ArrayBuffer) {
  const xml = new TextDecoder().decode(data);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML entities are not supported.');
  const root = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    processEntities: false,
  }).parse(xml).VTKFile;
  const piece = root?.PolyData?.Piece ?? root?.UnstructuredGrid?.Piece;
  if (!piece || Array.isArray(piece)) throw new Error('VTK XML requires a single mesh piece.');
  const arrays = (node: any): any[] =>
    node?.DataArray ? (Array.isArray(node.DataArray) ? node.DataArray : [node.DataArray]) : [];
  const numbers = (a: any): number[] => {
    if (!a || (a['@format'] && a['@format'] !== 'ascii'))
      throw new Error('Only ASCII VTK XML arrays are supported.');
    const text = a['#text'] ?? '';
    const result = String(text).trim().split(/\s+/).filter(Boolean).map(Number);
    if (result.some((n) => !Number.isFinite(n))) throw new Error('Invalid VTK XML values.');
    return result;
  };
  const positions = numbers(arrays(piece.Points)[0]);
  if (!positions.length || positions.length % 3 || positions.length > 18_000_000)
    throw new Error('Invalid VTK point count.');
  const cells = arrays(piece.Polys ?? piece.Cells),
    connectivity = numbers(cells.find((a) => a['@Name'] === 'connectivity')),
    offsets = numbers(cells.find((a) => a['@Name'] === 'offsets'));
  const types = piece.Cells ? numbers(cells.find((a) => a['@Name'] === 'types')) : [];
  const indices: number[] = [];
  let start = 0;
  offsets.forEach((end, i) => {
    if (!Number.isSafeInteger(end) || end < start || end > connectivity.length)
      throw new Error('Invalid VTK cell offset.');
    const cell = connectivity.slice(start, end);
    start = end;
    if (cell.some((n) => !Number.isSafeInteger(n) || n < 0 || n >= positions.length / 3))
      throw new Error('Invalid VTK point index.');
    if (piece.Cells && ![5, 7, 9, 10].includes(types[i]))
      throw new Error('Only triangle, polygon, quad and tetrahedron VTK cells are supported.');
    if (types[i] === 10) {
      if (cell.length !== 4) throw new Error('Invalid tetrahedron.');
      for (const face of [
        [0, 1, 2],
        [0, 3, 1],
        [1, 3, 2],
        [0, 2, 3],
      ])
        indices.push(...face.map((j) => cell[j]));
    } else for (let j = 1; j + 1 < cell.length; j++) indices.push(cell[0], cell[j], cell[j + 1]);
    if (indices.length > 18_000_000) throw new Error('VTK triangle limit exceeded.');
  });
  if (!indices.length) throw new Error('No surface cells in VTK mesh.');
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const scalar = arrays(piece.PointData).find(
    (a) => !a['@NumberOfComponents'] || a['@NumberOfComponents'] === '1',
  );
  if (scalar) {
    const values = numbers(scalar);
    if (values.length !== positions.length / 3) throw new Error('VTK scalar count mismatch.');
    let min = Infinity,
      max = -Infinity;
    for (const n of values) {
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    const colors = values.flatMap((n) => {
      const t = (n - min) / (max - min || 1);
      return [t, 0.25, 1 - t];
    });
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  }
  return geometry;
}
