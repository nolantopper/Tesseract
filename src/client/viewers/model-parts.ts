import * as T from 'three';

export const jointAttachment = Symbol('joint attachment');
export const cadSurfaces = Symbol('CAD surfaces');

type Material = {
  color: [number, number, number];
  opacity: number;
  metalness: number;
  roughness: number;
};
export interface Part {
  name: string;
  points: boolean;
  lines?: true;
  attributes: Record<string, { array: Float32Array; itemSize: number }>;
  index?: Uint16Array | Uint32Array;
  jointId?: string;
  surfaces?: { first: number; last: number }[];
  materials?: Material[];
  groups?: { start: number; count: number; materialIndex?: number }[];
}

export function partsFromObject(root: T.Object3D): Part[] {
  const parts: Part[] = [];
  let vertices = 0;
  root.updateMatrixWorld(true);
  root.traverseVisible((object) => {
    if (!(
      object instanceof T.Mesh ||
      object instanceof T.Points ||
      object instanceof T.LineSegments
    ))
      return;
    const geometry = new T.BufferGeometry();
    try {
      const source: T.BufferGeometry = object.geometry;
      const sourcePosition = source.getAttribute('position');
      vertices += sourcePosition?.count ?? 0;
      if (
        !sourcePosition?.count ||
        sourcePosition.itemSize !== 3 ||
        vertices > 6_000_000 ||
        parts.length >= 2000
      )
        throw new Error(
          'Scene exceeds the 6 million vertex or 2,000 part limit, or has invalid positions.',
        );
      for (const name of ['position', 'normal', 'color', 'uv']) {
        const attribute = source.getAttribute(name);
        if (!attribute) continue;
        if (
          attribute.count !== sourcePosition.count ||
          attribute.itemSize < 1 ||
          attribute.itemSize > 4
        )
          throw new Error('Scene contains mismatched vertex attributes.');
        const array = new Float32Array(attribute.count * attribute.itemSize);
        for (let vertex = 0; vertex < attribute.count; vertex++)
          for (let channel = 0; channel < attribute.itemSize; channel++)
            array[vertex * attribute.itemSize + channel] = attribute.getComponent(vertex, channel);
        geometry.setAttribute(name, new T.BufferAttribute(array, attribute.itemSize));
      }
      if (source.index) {
        if (
          source.index.count > 18_000_000 ||
          source.index.array.some(
            (index) => !Number.isSafeInteger(index) || index < 0 || index >= sourcePosition.count,
          )
        )
          throw new Error('Scene contains invalid mesh indices.');
        geometry.setIndex(source.index.clone());
      }
      geometry.groups = source.groups.map((group) => ({ ...group }));
      geometry.applyMatrix4(object.matrixWorld);
      const position = geometry.getAttribute('position');
      if (!geometry.getAttribute('normal') && object instanceof T.Mesh)
        geometry.computeVertexNormals();
      const attributes: Part['attributes'] = {};
      for (const name of ['position', 'normal', 'color', 'uv']) {
        const attribute = geometry.getAttribute(name);
        if (!attribute) continue;
        const array = Float32Array.from(attribute.array);
        if (array.some((value) => !Number.isFinite(value)))
          throw new Error('Scene contains invalid coordinates.');
        attributes[name] = { array, itemSize: attribute.itemSize };
      }
      const materials = (Array.isArray(object.material) ? object.material : [object.material]).map(
        (material: T.Material) => {
          const surface = material as T.MeshStandardMaterial;
          return {
            color: (surface.color ?? new T.Color(0x94a8bb)).toArray() as [number, number, number],
            opacity: surface.opacity ?? 1,
            metalness: surface.metalness ?? 0.12,
            roughness: surface.roughness ?? 0.48,
          };
        },
      );
      let joint: T.Object3D | null = object;
      while (joint && !Reflect.has(joint.userData, jointAttachment)) joint = joint.parent;
      parts.push({
        name: (object.name || object.parent?.name || 'Part').slice(0, 200),
        points: object instanceof T.Points,
        lines: object instanceof T.LineSegments ? true : undefined,
        attributes,
        index: geometry.index ? Uint32Array.from(geometry.index.array) : undefined,
        jointId: joint ? Reflect.get(joint.userData, jointAttachment) : undefined,
        materials,
        groups: geometry.groups.map((group) => ({ ...group })),
      });
    } finally {
      geometry.dispose();
    }
  });
  if (!parts.length) throw new Error('No renderable geometry found.');
  return parts;
}

export function objectFromParts(parts: Part[]): T.Group {
  const group = new T.Group();
  for (const part of parts) {
    const geometry = new T.BufferGeometry();
    for (const [name, attribute] of Object.entries(part.attributes))
      geometry.setAttribute(name, new T.BufferAttribute(attribute.array, attribute.itemSize));
    if (part.index) geometry.setIndex(new T.BufferAttribute(part.index, 1));
    for (const entry of part.groups ?? [])
      geometry.addGroup(entry.start, entry.count, entry.materialIndex);
    const materials = part.materials?.map(
      (surface) =>
        new T.MeshStandardMaterial({
          color: new T.Color(...surface.color),
          opacity: surface.opacity,
          transparent: surface.opacity < 1,
          metalness: surface.metalness,
          roughness: surface.roughness,
          vertexColors: !!part.attributes.color,
        }),
    ) ?? [
      new T.MeshStandardMaterial({
        color: part.attributes.color ? 0xffffff : 0x94a8bb,
        metalness: 0.12,
        roughness: 0.48,
        vertexColors: !!part.attributes.color,
      }),
    ];
    const object = part.points
      ? new T.Points(geometry, new T.PointsMaterial())
      : part.lines
        ? new T.LineSegments(
            geometry,
            new T.LineBasicMaterial({ color: materials[0].color, toneMapped: false }),
          )
        : new T.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
    if (part.points || part.lines) for (const material of materials) material.dispose();
    object.name = part.name;
    if (part.jointId) Reflect.set(object.userData, jointAttachment, part.jointId);
    if (part.surfaces) Reflect.set(object.userData, cadSurfaces, part.surfaces);
    group.add(object);
  }
  return group;
}

export function disposeModel(root: T.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof T.Mesh || object instanceof T.Points || object instanceof T.Line))
      return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material))
        if (value instanceof T.Texture) {
          if (typeof ImageBitmap !== 'undefined' && value.image instanceof ImageBitmap)
            value.image.close();
          value.dispose();
        }
      material.dispose();
    }
  });
}

export function lineSegments(points: ArrayLike<number>) {
  const result = new Float32Array(Math.max(0, points.length - 3) * 2);
  for (let i = 0; i + 5 < points.length; i += 3)
    for (let j = 0; j < 6; j++) result[i * 2 + j] = points[i + j];
  return new T.BufferGeometry().setAttribute('position', new T.BufferAttribute(result, 3));
}
