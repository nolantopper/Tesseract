import { Color } from 'three';

export type GlbPaint = { node: number; primitive: number; color: string };
type Material = {
  pbrMetallicRoughness?: {
    baseColorTexture?: unknown;
    baseColorFactor?: [number, number, number, number];
  };
};
type Primitive = { material?: number; attributes: Record<string, number> };
type Mesh = { primitives: Primitive[] };
type GlbDocument = { nodes: { mesh?: number }[]; meshes: Mesh[]; materials?: Material[] };

export function repaintGltf(source: ArrayBuffer, edits: Iterable<GlbPaint>): ArrayBuffer {
  return repaintDocument(new Uint8Array(source), edits).buffer;
}

export function repaintGlb(source: ArrayBuffer, edits: Iterable<GlbPaint>): ArrayBuffer {
  if (source.byteLength < 20) throw new Error('Invalid GLB header.');
  const header = new DataView(source);
  const jsonLength = header.getUint32(12, true);
  const binaryOffset = 20 + jsonLength;
  if (
    header.getUint32(0, true) !== 0x46546c67 ||
    header.getUint32(4, true) !== 2 ||
    header.getUint32(8, true) !== source.byteLength ||
    header.getUint32(16, true) !== 0x4e4f534a ||
    jsonLength % 4 !== 0 ||
    binaryOffset > source.byteLength
  )
    throw new Error('Invalid GLB header.');
  const json = repaintDocument(new Uint8Array(source, 20, jsonLength), edits);
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const output = new ArrayBuffer(20 + paddedLength + source.byteLength - binaryOffset);
  new Uint8Array(output, 0, 20).set(new Uint8Array(source, 0, 20));
  const outputHeader = new DataView(output);
  outputHeader.setUint32(8, output.byteLength, true);
  outputHeader.setUint32(12, paddedLength, true);
  const bytes = new Uint8Array(output);
  bytes.fill(0x20, 20, 20 + paddedLength);
  bytes.set(json, 20);
  bytes.set(new Uint8Array(source, binaryOffset), 20 + paddedLength);
  return output;
}

function repaintDocument(source: Uint8Array, edits: Iterable<GlbPaint>) {
  const document = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(source),
  ) as GlbDocument;
  const editedMeshes = new Map<number, Mesh>();
  const materials = (document.materials ??= []);
  for (const { node: nodeIndex, primitive: primitiveIndex, color } of edits) {
    const node = document.nodes[nodeIndex];
    const original = document.meshes[node?.mesh ?? -1];
    if (!original?.primitives[primitiveIndex])
      throw new Error('Model part is no longer available.');
    let mesh = editedMeshes.get(nodeIndex);
    if (!mesh) {
      // A GLB mesh and material can be shared by different nodes.
      mesh = { ...original, primitives: [...original.primitives] };
      node.mesh = document.meshes.push(mesh) - 1;
      editedMeshes.set(nodeIndex, mesh);
    }
    const primitive = mesh.primitives[primitiveIndex];
    const material = materials[primitive.material ?? -1] ?? {};
    const pbrMetallicRoughness = { ...material.pbrMetallicRoughness };
    delete pbrMetallicRoughness.baseColorTexture;
    const rgb = new Color(color);
    pbrMetallicRoughness.baseColorFactor = [
      rgb.r,
      rgb.g,
      rgb.b,
      pbrMetallicRoughness.baseColorFactor?.[3] ?? 1,
    ];
    const attributes = { ...primitive.attributes };
    delete attributes.COLOR_0;
    mesh.primitives[primitiveIndex] = {
      ...primitive,
      attributes,
      material: materials.push({ ...material, pbrMetallicRoughness }) - 1,
    };
  }
  return new TextEncoder().encode(JSON.stringify(document));
}
