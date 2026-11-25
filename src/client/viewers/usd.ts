import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
  Group,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  SphereGeometry,
  PlaneGeometry,
  Mesh,
  type Object3D,
} from 'three';
import { USDAParser } from 'three/examples/jsm/loaders/usd/USDAParser.js';
import { USDCParser } from 'three/examples/jsm/loaders/usd/USDCParser.js';
import { USDComposer } from 'three/examples/jsm/loaders/usd/USDComposer.js';
import { decodeZipEntry, indexZip, readZipEntry } from '../../shared/zip';

type Layer = ReturnType<USDAParser['parseData']>;
type LoadAsset = (path: string) => Promise<ArrayBuffer>;
const maxBytes = 64 * 1024 * 1024;
const maxValues = 18_000_000;
const isCrate = (data: ArrayBuffer) => new TextDecoder().decode(data.slice(0, 8)) === 'PXR-USDC';
const layerName = (path: string) => /\.(usd|usda|usdc)$/i.test(path);

function resolvePath(base: string, relative: string, packaged: boolean) {
  if (!relative || relative.length > 4096 || /[\\\0?#]|^[a-z][a-z0-9+.-]*:|^\//i.test(relative))
    throw new Error(`Unsupported USD asset path: ${relative.slice(0, 120)}`);
  const parts = base.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part === '..' && packaged) throw new Error('USD asset escapes its package.');
    else parts.push(part);
  }
  return parts.join('/');
}

class StaticUsdComposer extends USDComposer {
  _buildHierarchy(parent: Object3D, path: string) {
    super._buildHierarchy(parent, path);
    for (const child of parent.children) {
      const prim = path === '/' ? `/${child.name}` : `${path}/${child.name}`;
      if (this.specsByPath[prim]?.fields.typeName !== 'Points') continue;
      const positions = this.specsByPath[`${prim}.points`]?.fields.default as number[] | undefined;
      if (!positions?.length) continue;
      if (
        positions.length % 3 ||
        positions.length > maxValues ||
        positions.some((n) => !Number.isFinite(n))
      )
        throw new Error('USD point cloud contains invalid coordinates.');
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      const points = new Points(geometry, new PointsMaterial({ size: 3, sizeAttenuation: false }));
      points.name = child.name;
      child.add(points);
    }
  }

  _findSingleMesh() {
    return null;
  }

  _resolveReference(reference: string, variants: Record<string, string> = {}) {
    const match = reference.match(/@([^@]+)@(?:<([^>]+)>)?/);
    if (!match) throw new Error('Internal USD references are not supported in this preview.');
    const layer: Layer | undefined = this.assets[match[1]];
    if (!layer) throw new Error(`USD layer is missing: ${match[1]}`);
    // Referenced stages share the root stage axes; keep each prim's own transform intact.
    const root = layer.specsByPath['/'];
    const nested: Layer = {
      specsByPath: {
        ...layer.specsByPath,
        '/': { ...root, fields: { ...root?.fields, upAxis: 'Y' } },
      },
    };
    const object = new StaticUsdComposer().compose(nested, this.assets, {
      ...variants,
      ...this.externalVariantSelections,
    });
    if (!match[2]) return object;
    let target: Object3D | undefined = object;
    for (const name of match[2].split('/').filter(Boolean))
      target = target?.children.find((child) => child.name === name);
    if (!target) throw new Error(`USD reference prim is missing: ${match[2]}`);
    target.removeFromParent();
    return new Group().add(target);
  }
}

function mergeLayers(weak: Layer, strong: Layer): Layer {
  const result: Layer = { specsByPath: { ...weak.specsByPath } };
  for (const [path, spec] of Object.entries(strong.specsByPath)) {
    const prior = result.specsByPath[path];
    const fields = { ...prior?.fields, ...spec.fields };
    if (spec.fields.typeName === '' && prior?.fields.typeName)
      fields.typeName = prior.fields.typeName;
    if (prior?.fields.primChildren || spec.fields.primChildren)
      fields.primChildren = [
        ...new Set([...(spec.fields.primChildren ?? []), ...(prior?.fields.primChildren ?? [])]),
      ];
    result.specsByPath[path] = { ...spec, fields };
  }
  return result;
}

function addPrimitives(layer: Layer, warnings: Set<string>) {
  for (const [path, spec] of Object.entries(layer.specsByPath)) {
    if (spec.specType !== 6 || path === '/') continue;
    const type = spec.fields.typeName;
    const value = (name: string, fallback: number) => {
      const result = layer.specsByPath[`${path}.${name}`]?.fields.default ?? fallback;
      if (typeof result !== 'number' || !Number.isFinite(result) || result <= 0 || result > 1e9)
        throw new Error(`Invalid USD ${type} ${name}.`);
      return result;
    };
    let geometry: BufferGeometry | undefined;
    if (type === 'Cube')
      geometry = new BoxGeometry(value('size', 2), value('size', 2), value('size', 2));
    else if (type === 'Sphere') geometry = new SphereGeometry(value('radius', 1), 24, 16);
    else if (type === 'Cylinder')
      geometry = new CylinderGeometry(
        value('radius', 1),
        value('radius', 1),
        value('height', 2),
        24,
      );
    else if (type === 'Cone')
      geometry = new ConeGeometry(value('radius', 1), value('height', 2), 24);
    else if (type === 'Capsule')
      geometry = new CapsuleGeometry(value('radius', 0.5), value('height', 1), 8, 24);
    else if (type === 'Plane') geometry = new PlaneGeometry(value('width', 2), value('length', 2));
    else if (
      ['BasisCurves', 'NurbsCurves', 'NurbsPatch', 'PointInstancer', 'Volume', 'TetMesh'].includes(
        type,
      )
    )
      warnings.add(`${type} geometry is not supported in this static USD preview.`);
    if (!geometry) continue;
    if (!['Cube', 'Sphere'].includes(type)) {
      const axis = layer.specsByPath[`${path}.axis`]?.fields.default ?? 'Z';
      if (!['X', 'Y', 'Z'].includes(axis)) throw new Error(`Invalid USD ${type} axis.`);
      if (type === 'Plane') {
        if (axis === 'X') geometry.rotateY(Math.PI / 2);
        else if (axis === 'Y') geometry.rotateX(-Math.PI / 2);
      } else {
        if (axis === 'Z') geometry.rotateX(Math.PI / 2);
        else if (axis === 'X') geometry.rotateZ(-Math.PI / 2);
      }
    }
    const position = geometry.getAttribute('position');
    const index = geometry.index?.array ?? Array.from({ length: position.count }, (_, i) => i);
    spec.fields.typeName = 'Mesh';
    const attribute = (name: string, typeName: string, data: number[]) => {
      layer.specsByPath[`${path}.${name}`] = { specType: 1, fields: { default: data, typeName } };
    };
    attribute('points', 'point3f[]', Array.from(position.array));
    attribute('faceVertexIndices', 'int[]', Array.from(index));
    attribute(
      'faceVertexCounts',
      'int[]',
      Array.from({ length: index.length / 3 }, () => 3),
    );
    geometry.dispose();
  }
}

function validateLayer(layer: Layer) {
  if (Object.keys(layer.specsByPath).length > 100_000)
    throw new Error('USD scene has too many properties.');
  for (const [path, spec] of Object.entries(layer.specsByPath)) {
    const value = spec.fields.default;
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const numbers = value as ArrayLike<unknown>;
      if (numbers.length > maxValues) throw new Error('USD geometry exceeds the vertex limit.');
      if (
        path.endsWith('.points') ||
        path.endsWith('.faceVertexIndices') ||
        path.endsWith('.faceVertexCounts')
      ) {
        for (let i = 0; i < numbers.length; i++)
          if (typeof numbers[i] !== 'number' || !Number.isFinite(numbers[i]))
            throw new Error('USD geometry contains invalid values.');
      }
    }
    if (spec.fields.typeName === 'Mesh') {
      const positions = layer.specsByPath[`${path}.points`]?.fields.default as number[] | undefined;
      const indices = layer.specsByPath[`${path}.faceVertexIndices`]?.fields.default as
        number[] | undefined;
      const counts = layer.specsByPath[`${path}.faceVertexCounts`]?.fields.default as
        number[] | undefined;
      if (positions && (positions.length % 3 || positions.length > maxValues))
        throw new Error('USD mesh has an invalid point count.');
      if (
        indices &&
        (!positions ||
          indices.some(
            (index) => !Number.isSafeInteger(index) || index < 0 || index >= positions.length / 3,
          ))
      )
        throw new Error('USD mesh has an invalid face index.');
      if (
        counts &&
        (!indices ||
          counts.some((count) => !Number.isSafeInteger(count) || count < 3) ||
          counts.reduce((sum, count) => sum + count, 0) !== indices.length)
      )
        throw new Error('USD mesh face sizes do not match its indices.');
    }
  }
}

export async function parseUsd(
  data: ArrayBuffer,
  loadAsset: LoadAsset,
  name = 'scene.usd',
): Promise<{ object: Object3D; warnings: string[] }> {
  if (data.byteLength > maxBytes) throw new Error('USD exceeds the 64 MiB preview limit.');
  const warnings = new Set<string>();
  const assets: Record<string, Layer> = Object.create(null);
  const packageFiles = new Map<string, ArrayBuffer>();
  const loading = new Set<string>();
  const layers = new Map<string, Layer>();
  const aliases = new Map<string, string>();
  let totalBytes = 0;
  const packaged = new Uint8Array(data)[0] === 0x50 && new Uint8Array(data)[1] === 0x4b;
  let rootName = name.split(/[\\/]/).at(-1) || 'scene.usd';
  if (packaged) {
    const read = async (offset: number, length: number) => data.slice(offset, offset + length);
    const zip = await indexZip(data.byteLength, read);
    const entries = [...zip.entries.values()].filter((entry) => !entry.directory);
    if (!entries.length || !layerName(entries[0].path))
      throw new Error('USDZ must begin with a USD root layer.');
    rootName = entries[0].path;
    const expanded = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (expanded > maxBytes) throw new Error('USDZ expands beyond the 64 MiB preview limit.');
    for (const entry of entries) {
      if (!layerName(entry.path)) continue;
      packageFiles.set(entry.path, decodeZipEntry(await readZipEntry(entry, read), entry));
    }
  }

  const load = async (path: string, bytes?: ArrayBuffer): Promise<Layer> => {
    if (loading.has(path)) throw new Error(`Cyclic USD layer reference: ${path}`);
    if (layers.has(path)) return layers.get(path)!;
    if (!aliases.has(path)) aliases.set(path, `layer-${aliases.size}.usd`);
    if (Object.keys(assets).length + loading.size >= 128)
      throw new Error('USD references exceed 128 layers.');
    loading.add(path);
    try {
      bytes ??= packageFiles.get(path);
      if (!bytes) {
        if (packaged) throw new Error(`USD layer is missing from the package: ${path}`);
        try {
          bytes = await loadAsset(path);
        } catch (error) {
          throw new Error(
            `Couldn’t load USD layer ${JSON.stringify(path)}: ${error instanceof Error ? error.message : 'missing asset'}`,
          );
        }
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) throw new Error('USD layers exceed the 64 MiB preview limit.');
      let layer: Layer;
      let subLayers: string[] = [];
      if (isCrate(bytes)) {
        layer = new USDCParser().parseData(bytes);
        const sub = layer.specsByPath['/']?.fields.subLayers;
        if (Array.isArray(sub)) subLayers = sub.map(String);
      } else {
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new Error('USD layer is neither valid USDA text nor a USDC crate.');
        }
        if (!/^\uFEFF?#usda 1\.0(?:\r?\n|$)/.test(text))
          throw new Error('USD layer header is invalid.');
        const parser = new USDAParser();
        const header = parser.parseText(text)['#usda 1.0'];
        subLayers = [...String(header?.subLayers ?? '').matchAll(/@([^@]+)@/g)].map((m) => m[1]);
        // Treat authored overrides as sparse definitions so sublayer opinions can merge.
        layer = parser.parseData(text.replace(/^(\s*)over\s+/gm, '$1def '));
      }
      validateLayer(layer);
      for (const [specPath, spec] of Object.entries(layer.specsByPath)) {
        if (specPath.endsWith('.inputs:file')) {
          delete layer.specsByPath[specPath];
          warnings.add('USD texture images are not rendered; material colors are shown.');
        }
        if (spec.fields.timeSamples) warnings.add('USD animation is shown at its initial pose.');
        for (const key of ['references', 'payload']) {
          const raw = spec.fields[key];
          if (!raw) continue;
          const values = Array.isArray(raw) ? raw : [raw];
          const converted = values.map((value) =>
            typeof value === 'string'
              ? value
              : value.assetPath
                ? `@${value.assetPath}@${value.primPath ? `<${value.primPath}>` : ''}`
                : '',
          );
          const references = converted.flatMap((value) => [
            ...value.matchAll(/@([^@]+)@(?:<([^>]+)>)?/g),
          ]);
          if (references.length > 1)
            warnings.add('USD prims with multiple references use their first reference.');
          for (const ref of references) {
            const resolved = resolvePath(path, ref[1], packaged);
            await load(resolved);
          }
          const remapped = converted.map((value) =>
            value.replace(
              /@([^@]+)@/g,
              (_, relative: string) => `@${aliases.get(resolvePath(path, relative, packaged))!}@`,
            ),
          );
          if (key === 'references') spec.fields[key] = remapped;
          else spec.fields[key] = remapped[0];
        }
      }
      let combined: Layer = { specsByPath: {} };
      for (const relative of [...subLayers].reverse()) {
        const sub = await load(resolvePath(path, relative.replace(/^@|@$/g, ''), packaged));
        combined = mergeLayers(combined, sub);
      }
      layer = mergeLayers(combined, layer);
      layers.set(path, layer);
      assets[aliases.get(path)!] = layer;
      return layer;
    } finally {
      loading.delete(path);
    }
  };

  await load(rootName, packaged ? undefined : data);
  for (const [key, layer] of Object.entries(assets)) {
    const prepared: Layer = {
      specsByPath: Object.fromEntries(
        Object.entries(layer.specsByPath).map(([path, spec]) => [
          path,
          { ...spec, fields: { ...spec.fields } },
        ]),
      ),
    };
    for (const [path, spec] of Object.entries(prepared.specsByPath)) {
      if (!path.endsWith('.visibility') || spec.fields.default !== 'invisible') continue;
      const prim = path.slice(0, -'.visibility'.length);
      for (const candidate of Object.keys(prepared.specsByPath))
        if (
          candidate === prim ||
          candidate.startsWith(`${prim}/`) ||
          candidate.startsWith(`${prim}.`)
        )
          delete prepared.specsByPath[candidate];
    }
    addPrimitives(prepared, warnings);
    assets[key] = prepared;
  }
  const object = new StaticUsdComposer().compose(assets[aliases.get(rootName)!], assets);
  let vertices = 0;
  const emptyMeshes: Object3D[] = [];
  object.traverse((child) => {
    if (!(child instanceof Mesh || child instanceof Points)) return;
    const positions = child.geometry.getAttribute('position');
    if (!positions?.count) {
      emptyMeshes.push(child);
      return;
    }
    vertices += positions?.count ?? 0;
    if (vertices > 6_000_000) throw new Error('USD exceeds the 6 million vertex limit.');
    if (positions)
      for (let i = 0; i < positions.array.length; i++)
        if (!Number.isFinite(positions.array[i]))
          throw new Error('USD contains invalid coordinates.');
  });
  for (const empty of emptyMeshes) empty.removeFromParent();
  if (emptyMeshes.length) warnings.add('USD meshes without point data are not displayed.');
  if (!vertices)
    throw new Error(warnings.size ? [...warnings].join(' ') : 'No renderable USD geometry found.');
  return { object, warnings: [...warnings] };
}
