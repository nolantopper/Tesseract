import { Triangle, Vector3, type Mesh } from 'three';
import type { SelectedPart } from '../../shared/view';
import { cadSurfaces } from './model-parts';

type Surface = { first: number; last: number };
type FaceKind = NonNullable<SelectedPart['face']>['kind'];
export type FacePatch = { kind: FaceKind; index: number; triangles: number[] };

const maxPatchTriangles = 20_000;
function triangleAt(mesh: Mesh, index: number, triangle: Triangle) {
  const buffer = mesh.geometry.index;
  const coordinate = (offset: number) =>
    buffer ? buffer.getX(index * 3 + offset) : index * 3 + offset;
  mesh.getVertexPosition(coordinate(0), triangle.a);
  mesh.getVertexPosition(coordinate(1), triangle.b);
  mesh.getVertexPosition(coordinate(2), triangle.c);
  return triangle;
}

const pointKey = (point: Vector3) => `${point.x},${point.y},${point.z}`;
function edges({ a, b, c }: Triangle) {
  const points = [a, b, c].map(pointKey);
  return points.map((point, i) => {
    const next = points[(i + 1) % 3];
    return point < next ? `${point};${next}` : `${next};${point}`;
  });
}

export function findFace(mesh: Mesh, index: number, kind?: FaceKind): FacePatch | undefined {
  const count = Math.floor(
    (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3,
  );
  if (!Number.isInteger(index) || index < 0 || index >= count) return;
  const surfaces = Reflect.get(mesh.userData, cadSurfaces) as Surface[] | undefined;
  const native =
    kind === 'surface'
      ? index
      : surfaces?.findIndex(({ first, last }) => index >= first && index <= last);
  if ((kind === undefined || kind === 'surface') && native !== undefined && native >= 0) {
    const range = surfaces?.[native];
    if (
      range &&
      range.first >= 0 &&
      range.last < count &&
      range.last >= range.first &&
      range.last - range.first < maxPatchTriangles
    ) {
      return {
        kind: 'surface',
        index: native,
        triangles: Array.from({ length: range.last - range.first + 1 }, (_, i) => range.first + i),
      };
    }
  }
  if (kind === 'surface') return;
  const fallback: FacePatch = { kind: 'triangle', index, triangles: [index] };
  // shortcut: large meshes use triangle picking, upgrade to a shared adjacency index if needed.
  if (kind === 'triangle' || count > 150_000 || (native !== undefined && native >= 0))
    return fallback;
  const seed = triangleAt(mesh, index, new Triangle());
  const normal = seed.getNormal(new Vector3());
  if (!normal.lengthSq()) return fallback;
  const point = new Vector3();
  const candidate = new Triangle();
  const direction = new Vector3();
  const tolerance = Math.max(seed.a.distanceTo(seed.b), seed.a.distanceTo(seed.c), 1e-9) * 1e-5;
  const coplanar = (vertex: Vector3) =>
    Math.abs(normal.dot(point.subVectors(vertex, seed.a))) < tolerance;
  const neighbors = new Map<string, number[]>();
  const byTriangle = new Map<number, string[]>();
  for (let i = 0; i < count; i++) {
    triangleAt(mesh, i, candidate);
    if (
      Math.abs(normal.dot(candidate.getNormal(direction))) < 0.99999 ||
      !coplanar(candidate.a) ||
      !coplanar(candidate.b) ||
      !coplanar(candidate.c)
    )
      continue;
    if (byTriangle.size >= maxPatchTriangles) return fallback;
    const keys = edges(candidate);
    byTriangle.set(i, keys);
    for (const key of keys) {
      let bucket = neighbors.get(key);
      if (!bucket) neighbors.set(key, (bucket = []));
      bucket.push(i);
    }
  }
  const seen = new Set([index]);
  const triangles = [index];
  for (let i = 0; i < triangles.length; i++) {
    for (const key of byTriangle.get(triangles[i]) ?? []) {
      for (const next of neighbors.get(key) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        triangles.push(next);
      }
      neighbors.delete(key);
    }
  }
  if (triangles.length < 2) return fallback;
  triangles.sort((a, b) => a - b);
  return { kind: 'planar', index: triangles[0], triangles };
}

export function faceNormal(mesh: Mesh, face: FacePatch) {
  return triangleAt(mesh, face.triangles[0], new Triangle()).getNormal(new Vector3());
}

export function faceOverlay(mesh: Mesh, face: FacePatch) {
  const positions: number[] = [];
  const border = new Map<string, number[] | null>();
  const triangle = new Triangle();
  for (const index of face.triangles) {
    triangleAt(mesh, index, triangle);
    const vertices = [triangle.a.toArray(), triangle.b.toArray(), triangle.c.toArray()];
    positions.push(...vertices.flat());
    edges(triangle).forEach((key, i) => {
      border.set(key, border.has(key) ? null : [...vertices[i], ...vertices[(i + 1) % 3]]);
    });
  }
  const lines: number[] = [];
  for (const edge of border.values()) if (edge) lines.push(...edge);
  return { positions, lines };
}
