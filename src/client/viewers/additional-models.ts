import {
  BufferAttribute,
  BufferGeometry,
  BufferGeometryLoader,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Texture,
  TextureLoader,
} from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import initRhino from 'three/addons/libs/rhino3dm/rhino3dm.module.js';
import { IfcAPI, GEOM_TRIANGLES, GEOM_LINE_STRIP, GEOM_POINTS } from 'web-ifc';
import { disposeModel, lineSegments, partsFromObject } from './model-parts';
import { parseDxf } from './dxf-model';

async function readIfc(data: ArrayBuffer, wasm: ArrayBuffer, root: Group) {
  const api = new IfcAPI();
  const url = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
  try {
    await api.Init(() => url, true);
  } finally {
    URL.revokeObjectURL(url);
  }
  const model = api.OpenModel(new Uint8Array(data), {
    COORDINATE_TO_ORIGIN: false,
    MEMORY_LIMIT: 128 * 1024 * 1024,
    EXPORT_POLYLINES: true,
  });
  if (model < 0) throw new Error('Unable to open IFC model.');
  let vertices = 0;
  let indices = 0;
  let oversized = false;
  try {
    api.StreamAllMeshes(model, (mesh) => {
      if (oversized) return;
      const { expressID, geometries } = mesh;
      const type = api.GetNameFromTypeCode(api.GetLineType(model, expressID));
      const item = api.GetLine(model, expressID, false);
      const name = item?.Name?.value;
      for (let i = 0; i < geometries.size(); i++) {
        const placed = geometries.get(i);
        const geometry = api.GetGeometry(model, placed.geometryExpressID);
        try {
          const count = geometry.GetVertexDataSize() / 6;
          const indexCount = geometry.GetIndexDataSize();
          vertices += count * (placed.geomType === GEOM_LINE_STRIP ? 2 : 1);
          indices += indexCount;
          if (root.children.length >= 2000 || vertices > 6_000_000 || indices > 18_000_000) {
            oversized = true;
            return;
          }
          if (!count || !Number.isInteger(count)) continue;
          const source = api.GetVertexArray(geometry.GetVertexData(), count * 6);
          const positions = new Float32Array(count * 3);
          const normals = new Float32Array(count * 3);
          for (let j = 0; j < count * 3; j += 3) {
            positions.set(source.subarray(j * 2, j * 2 + 3), j);
            normals.set(source.subarray(j * 2 + 3, j * 2 + 6), j);
          }
          const { x, y, z, w } = placed.color;
          const color = placed.hasColor ? new Color(x, y, z) : new Color(0x94a8bb);
          const opacity = placed.hasColor ? w : 1;
          const buffer = new BufferGeometry();
          buffer.setAttribute('position', new BufferAttribute(positions, 3));
          let object;
          if (placed.geomType === GEOM_LINE_STRIP) {
            buffer.dispose();
            object = new LineSegments(lineSegments(positions), new LineBasicMaterial({ color }));
          } else if (placed.geomType === GEOM_POINTS)
            object = new Points(buffer, new PointsMaterial({ color }));
          else if (placed.geomType === GEOM_TRIANGLES) {
            const index = api.GetIndexArray(geometry.GetIndexData(), indexCount);
            buffer.setIndex(new BufferAttribute(index.slice(), 1));
            buffer.setAttribute('normal', new BufferAttribute(normals, 3));
            object = new Mesh(
              buffer,
              new MeshStandardMaterial({ color, opacity, transparent: opacity < 1 }),
            );
          } else {
            buffer.dispose();
            continue;
          }
          const label = typeof name === 'string' && name ? name.slice(0, 140) + ' · ' : '';
          object.name = `${label}${type} #${expressID}${geometries.size() > 1 ? ` (${i + 1})` : ''}`;
          object.applyMatrix4(new Matrix4().fromArray(placed.flatTransformation));
          root.add(object);
        } finally {
          geometry.delete();
        }
      }
    });
    if (oversized) throw new Error('IFC geometry exceeds the preview limit.');
  } finally {
    api.CloseModel(model);
  }
}

async function readRhino(data: ArrayBuffer, wasm: ArrayBuffer, root: Group, warnings: string[]) {
  const rhino = await initRhino({ wasmBinary: wasm });
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(data));
  if (!doc) throw new Error('Unable to open Rhino model.');
  const objects = doc.objects();
  const geometryLoader = new BufferGeometryLoader();
  let vertices = 0;
  let skipped = false;
  try {
    if (objects.count > 2000) throw new Error('Rhino model exceeds the 2,000 object limit.');
    for (let i = 0; i < objects.count; i++) {
      const item = objects.get(i);
      const attributes = item.attributes();
      const source = item.geometry();
      try {
        if (!source || attributes.isInstanceDefinitionObject || !attributes.visible) continue;
        const type = source.objectType;
        const { r, g, b } = attributes.drawColor(doc);
        const color = new Color().setRGB(r / 255, g / 255, b / 255, 'srgb');
        let object;
        if (type === rhino.ObjectType.Curve) {
          const [start, end] = source.domain;
          const points = [];
          for (let i = 0; i <= 128; i++)
            points.push(...source.pointAt(start + ((end - start) * i) / 128));
          object = new LineSegments(lineSegments(points), new LineBasicMaterial({ color }));
        } else if (type === rhino.ObjectType.Point) {
          const geometry = new BufferGeometry().setAttribute(
            'position',
            new BufferAttribute(Float32Array.from(source.location), 3),
          );
          object = new Points(geometry, new PointsMaterial());
        } else if (type === rhino.ObjectType.PointSet) {
          if (source.count > 6_000_000 - vertices)
            throw new Error('Rhino geometry exceeds the preview limit.');
          object = new Points(geometryLoader.parse(source.toThreejsJSON()), new PointsMaterial());
        } else if (
          type === rhino.ObjectType.Mesh ||
          type === rhino.ObjectType.Brep ||
          type === rhino.ObjectType.Extrusion
        ) {
          let mesh = source;
          if (type === rhino.ObjectType.Extrusion) mesh = source.getMesh(rhino.MeshType.Any);
          if (type === rhino.ObjectType.Brep) {
            mesh = new rhino.Mesh();
            const faces = source.faces();
            let count = 0;
            try {
              if (faces.count > 20_000) throw new Error('Rhino surface has too many faces.');
              for (let j = 0; j < faces.count; j++) {
                const face = faces.get(j);
                const surface = face.getMesh(rhino.MeshType.Any);
                try {
                  if (surface) {
                    count += surface.vertices().count;
                    if (count > 6_000_000 - vertices)
                      throw new Error('Rhino geometry exceeds the preview limit.');
                    mesh.append(surface);
                  }
                } finally {
                  surface?.delete();
                  face.delete();
                }
              }
            } finally {
              faces.delete();
            }
          }
          try {
            const count = mesh?.vertices().count ?? 0;
            if (count > 6_000_000 - vertices)
              throw new Error('Rhino geometry exceeds the preview limit.');
            if (!count) {
              skipped = true;
              continue;
            }
            object = new Mesh(
              geometryLoader.parse(mesh.toThreejsJSON()),
              new MeshStandardMaterial({ color }),
            );
          } finally {
            if (mesh !== source) mesh?.delete();
          }
        } else {
          skipped = true;
          continue;
        }
        vertices += object.geometry.getAttribute('position').count;
        if (vertices > 6_000_000) {
          disposeModel(object);
          throw new Error('Rhino geometry exceeds the preview limit.');
        }
        object.name = attributes.name || `Rhino object ${i + 1}`;
        root.add(object);
      } finally {
        source?.delete();
        attributes.delete();
        item.delete();
      }
    }
  } finally {
    objects.delete();
    doc.delete();
  }
  root.rotateX(-Math.PI / 2);
  if (skipped) warnings.push('Rhino blocks and unsupported or unmeshed objects are omitted.');
}

export async function decodeAdditionalModel(format: string, data: ArrayBuffer, wasm?: ArrayBuffer) {
  const warnings: string[] = [];
  let root = new Group();
  try {
    if (format === 'ifc' && wasm) await readIfc(data, wasm, root);
    else if (format === '3dm' && wasm) await readRhino(data, wasm, root, warnings);
    else if (format === 'dxf') parseDxf(data, root, warnings);
    else if (format === 'fbx' || format === '3ds') {
      const originalLoad = TextureLoader.prototype.load;
      let hasTexture = false;
      // These mesh decoders run inside a dedicated worker and only return geometry.
      TextureLoader.prototype.load = () => {
        hasTexture = true;
        return new Texture();
      };
      try {
        // FBXLoader uses window for optional camera dimensions and embedded blob URLs.
        const scope = globalThis as unknown as { window?: typeof globalThis };
        scope.window = globalThis;
        try {
          root =
            format === 'fbx' ? new FBXLoader().parse(data, '') : new TDSLoader().parse(data, '');
        } finally {
          delete scope.window;
        }
      } finally {
        TextureLoader.prototype.load = originalLoad;
      }
      if (format === '3ds') root.rotateX(-Math.PI / 2);
      if (hasTexture) warnings.push('Texture images are omitted.');
      if (root.animations.length) warnings.push('Animation is shown at its initial pose.');
    } else throw new Error('Unsupported model parser.');
    return { parts: partsFromObject(root), warnings };
  } finally {
    disposeModel(root);
  }
}
