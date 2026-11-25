import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { maxModelJoints } from '../../shared/view';
import type { Joint } from './model-joints';
import { jointAttachment } from './model-parts';

type Node = {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: Node[];
  base: string;
};
type Attributes = Record<string, string>;
type Defaults = Record<string, Attributes>;
type Format = 'urdf' | 'sdf' | 'mjcf';

const child = (node: Node, tag: string) => node.children.find((item) => item.tag === tag);
const children = (node: Node, tag: string) => node.children.filter((item) => item.tag === tag);
const value = (node: Node, tag: string) => child(node, tag)?.text;

function numeric(text: string | undefined, count: number, fallback?: number[]): number[] {
  const values = text === undefined ? fallback : text.trim().split(/\s+/).map(Number);
  if (
    !values ||
    values.length !== count ||
    values.some((number) => !Number.isFinite(number) || Math.abs(number) > 1e9)
  )
    throw new Error(`Expected ${count} finite simulation values.`);
  return values;
}

function positive(text: string | undefined): number {
  const [number] = numeric(text, 1);
  if (number <= 0 || number > 1e6) throw new Error('Invalid simulation geometry size.');
  return number;
}

function dimensions(text: string | undefined, count: number): number[] {
  return numeric(text, count).map((number) => positive(String(number)));
}

function assetPath(base: string, path: string): string {
  if (!path || path.length > 4096 || /[\u0000-\u001f]/.test(path))
    throw new Error('Invalid simulation asset path.');
  if (/^(?:package|model):\/\//.test(path)) return path;
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || /^[\\/]/.test(path))
    throw new Error('Simulation assets must use relative, package://, or model:// paths.');
  const scheme = /^(package|model):\/\//.exec(base)?.[0] ?? '';
  if (scheme) base = base.slice(scheme.length);
  const parts: string[] = [];
  for (const part of `${base}/${path}`.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (scheme && part === '..' && parts.length <= 1)
      throw new Error('Simulation asset path escapes its package.');
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else parts.push(part);
  }
  return scheme + parts.join('/');
}

function parseXml(data: ArrayBuffer, base = ''): Node {
  if (data.byteLength > 16 * 1024 * 1024) throw new Error('Simulation XML exceeds 16 MiB.');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(data);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML entities are not supported.');
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed simulation XML.');
  const raw = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    processEntities: false,
  }).parse(xml) as Record<string, unknown>[];
  let count = 0;
  const normalize = (items: Record<string, unknown>[], depth: number): Node[] => {
    if (depth > 64) throw new Error('Simulation hierarchy exceeds 64 levels.');
    const nodes: Node[] = [];
    for (const item of items) {
      const tag = Object.keys(item).find((key) => key !== ':@' && !key.startsWith('#'));
      if (!tag || tag.startsWith('?')) continue;
      if (++count > 20000) throw new Error('Simulation XML exceeds 20,000 elements.');
      const contents = item[tag] as Record<string, unknown>[];
      const attrs = (item[':@'] ?? {}) as Attributes;
      for (const [name, entry] of Object.entries(attrs)) {
        if (typeof entry !== 'string' || entry.length > 1024 * 1024)
          throw new Error(`Invalid simulation attribute ${name}.`);
      }
      nodes.push({
        tag,
        attrs,
        text: contents
          .map((entry) => entry['#text'] ?? '')
          .join('')
          .trim(),
        children: normalize(contents, depth + 1),
        base,
      });
    }
    return nodes;
  };
  const roots = normalize(raw, 0);
  if (roots.length !== 1) throw new Error('Simulation XML requires one root element.');
  return roots[0];
}

function rpyQuaternion(angles: number[]): Quaternion {
  const result = new Quaternion();
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  angles.forEach((angle, index) =>
    result.premultiply(new Quaternion().setFromAxisAngle(axes[index], angle)),
  );
  return result;
}

function poseMatrix(pose?: Node): Matrix4 {
  if (!pose) return new Matrix4();
  const format = pose.attrs.rotation_format ?? 'euler_rpy';
  if (!['euler_rpy', 'quat_xyzw'].includes(format))
    throw new Error(`Unsupported SDF rotation format: ${format}.`);
  const values = numeric(pose.text, format === 'quat_xyzw' ? 7 : 6);
  let rotation: Quaternion;
  if (format === 'quat_xyzw') {
    rotation = new Quaternion(values[3], values[4], values[5], values[6]);
    if (rotation.lengthSq() < 1e-15) throw new Error('Invalid simulation quaternion.');
    rotation.normalize();
  } else {
    const factor = pose.attrs.degrees === 'true' ? Math.PI / 180 : 1;
    rotation = rpyQuaternion(values.slice(3).map((angle) => angle * factor));
  }
  return new Matrix4().compose(new Vector3(...values.slice(0, 3)), rotation, new Vector3(1, 1, 1));
}

function setMatrix(object: Object3D, matrix: Matrix4) {
  matrix.decompose(object.position, object.quaternion, object.scale);
}

function setOrigin(object: Object3D, origin?: Node) {
  if (!origin) return;
  object.position.fromArray(numeric(origin.attrs.xyz, 3, [0, 0, 0]));
  object.quaternion.copy(rpyQuaternion(numeric(origin.attrs.rpy, 3, [0, 0, 0])));
}

function setScale(object: Object3D, scale?: string) {
  const values = numeric(scale, 3, [1, 1, 1]);
  if (values.some((number) => number === 0))
    throw new Error('Simulation mesh scale cannot be zero.');
  object.scale.multiply(new Vector3(...values));
}

function material(rgba?: string): MeshStandardMaterial {
  const color = numeric(rgba, 4, [0.65, 0.7, 0.76, 1]);
  if (color.some((number) => number < 0 || number > 1))
    throw new Error('Simulation colors must be between 0 and 1.');
  return new MeshStandardMaterial({
    color: new Color().setRGB(color[0], color[1], color[2]),
    opacity: color[3],
    transparent: color[3] < 1,
    roughness: 0.6,
    side: DoubleSide,
  });
}

function primitive(kind: string, size: number[]): BufferGeometry {
  if (size.some((number) => !Number.isFinite(number) || number <= 0 || number > 1e6))
    throw new Error('Invalid simulation geometry size.');
  if (kind === 'box') return new BoxGeometry(size[0], size[1], size[2]);
  if (kind === 'sphere') return new SphereGeometry(size[0], 24, 16);
  if (kind === 'ellipsoid') return new SphereGeometry(1, 24, 16).scale(size[0], size[1], size[2]);
  if (kind === 'cylinder')
    return new CylinderGeometry(size[0], size[0], size[1], 24).rotateX(Math.PI / 2);
  if (kind === 'cone') return new ConeGeometry(size[0], size[1], 24).rotateX(Math.PI / 2);
  if (kind === 'capsule') return new CapsuleGeometry(size[0], size[1], 6, 24).rotateX(Math.PI / 2);
  if (kind === 'plane') return new PlaneGeometry(size[0], size[1]);
  throw new Error(`Unsupported simulation geometry: ${kind}.`);
}

/** Static visual geometry, in the model's authored zero pose; no simulator code is executed. */
export async function parseSimulation(
  data: ArrayBuffer,
  format: Format,
  loadAsset: (path: string) => Promise<ArrayBuffer>,
  loadMesh: (data: ArrayBuffer, extension: string, path?: string) => Promise<Object3D>,
): Promise<{ object: Object3D; warnings: string[]; joints: Joint[] }> {
  const warnings = new Set<string>();
  const articulated = new Map<Object3D, Joint>();
  let parts = 0;
  let vertices = 0;
  let dependencies = 0;
  let dependencyBytes = 0;
  const assetCache = new Map<string, Promise<ArrayBuffer>>();
  const meshCache = new Map<string, Promise<Object3D>>();
  const warn = (message: string) => {
    if (warnings.size < 16) warnings.add(message);
  };
  const bind = (
    object: Object3D,
    name: string | undefined,
    unit: Joint['unit'],
    axis: Vector3,
    pivot: Vector3,
    range: [number | undefined, number | undefined],
    reference = 0,
  ) => {
    if (axis.lengthSq() < 1e-15) throw new Error('Invalid joint axis.');
    const extent = unit === 'rad' ? Math.PI : 1;
    const [lower, upper] = range;
    const min = lower ?? Math.min(reference - extent, (upper ?? reference) - extent);
    const max = upper ?? Math.max(reference + extent, (lower ?? reference) + extent);
    if (min > max) throw new Error('Invalid joint range.');
    if (articulated.size >= maxModelJoints) {
      warn('Joint controls are limited to the first 128 joints.');
      return;
    }
    const id = `joint-${articulated.size}`;
    Reflect.set(object.userData, jointAttachment, id);
    articulated.set(object, {
      id,
      name: (name || `Joint ${articulated.size + 1}`).slice(0, 200),
      unit,
      min,
      max,
      reference,
      axis: axis.normalize().toArray(),
      pivot: pivot.toArray(),
    });
  };
  const limitValue = (text?: string) => (text === undefined ? undefined : numeric(text, 1)[0]);
  const sdfBound = (text: string | undefined, sign: number) =>
    text && (sign * Number(text) >= 1e16 || text.toLowerCase() === (sign < 0 ? '-inf' : 'inf'))
      ? undefined
      : limitValue(text);
  const read = (path: string): Promise<ArrayBuffer> => {
    const known = assetCache.get(path);
    if (known) return known;
    if (++dependencies > 128) throw new Error('Simulation exceeds 128 linked assets.');
    const pending = loadAsset(path).then((bytes) => {
      dependencyBytes += bytes.byteLength;
      if (dependencyBytes > 64 * 1024 * 1024)
        throw new Error('Linked simulation assets exceed 64 MiB.');
      return bytes;
    });
    assetCache.set(path, pending);
    return pending;
  };
  const check = (object: Object3D, name: string, color?: string) => {
    object.traverse((part) => {
      if (!(part instanceof Mesh)) return;
      if (++parts > 2000) throw new Error('Simulation exceeds 2,000 visual parts.');
      const position = part.geometry.getAttribute('position');
      if (!position) throw new Error('Simulation mesh has no positions.');
      vertices += position.count;
      if (vertices > 6_000_000) throw new Error('Simulation exceeds 6 million vertices.');
      if (color) part.material = material(color);
      part.name = part.name ? `${name}/${part.name}` : name;
    });
    object.name = name;
    return object;
  };
  const mesh = async (path: string, base: string, name: string, color?: string) => {
    const fullPath = assetPath(base, path);
    const extension = fullPath.split('.').at(-1)?.toLowerCase();
    if (!extension || extension.includes('/')) throw new Error(`Mesh type is missing: ${path}.`);
    let pending = meshCache.get(fullPath);
    if (!pending) {
      pending = read(fullPath).then((bytes) => loadMesh(bytes, extension, fullPath));
      meshCache.set(fullPath, pending);
    }
    return check((await pending).clone(true), name, color);
  };

  const visualGeometry = async (geometry: Node | undefined, name: string, color?: string) => {
    if (!geometry) throw new Error(`Visual geometry is missing: ${name}.`);
    const shape = geometry.children[0];
    if (!shape) throw new Error(`Visual geometry is empty: ${name}.`);
    if (shape.tag === 'mesh') {
      const filename = shape.attrs.filename ?? value(shape, 'uri');
      if (!filename) throw new Error(`Mesh path is missing: ${name}.`);
      const object = await mesh(filename, shape.base, name, color);
      setScale(object, shape.attrs.scale ?? value(shape, 'scale'));
      if (child(shape, 'submesh'))
        throw new Error(
          'SDF submesh selection is not supported. Export the submesh as a separate mesh.',
        );
      return object;
    }
    let size: number[];
    if (shape.tag === 'box') size = dimensions(shape.attrs.size ?? value(shape, 'size'), 3);
    else if (shape.tag === 'sphere')
      size = [positive(shape.attrs.radius ?? value(shape, 'radius'))];
    else if (['cylinder', 'capsule', 'cone'].includes(shape.tag))
      size = [
        positive(shape.attrs.radius ?? value(shape, 'radius')),
        positive(shape.attrs.length ?? value(shape, 'length')),
      ];
    else if (shape.tag === 'ellipsoid') size = dimensions(value(shape, 'radii'), 3);
    else if (shape.tag === 'plane') size = dimensions(value(shape, 'size'), 2);
    else throw new Error(`Unsupported simulation geometry: ${shape.tag}.`);
    const object = check(new Mesh(primitive(shape.tag, size), material(color)), name);
    if (shape.tag === 'plane') {
      const normal = new Vector3(...numeric(value(shape, 'normal'), 3, [0, 0, 1]));
      if (normal.lengthSq() < 1e-15) throw new Error('Invalid plane normal.');
      object.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal.normalize());
    }
    return object;
  };

  const urdf = async (robot: Node) => {
    if (robot.tag !== 'robot') throw new Error('URDF requires a robot root.');
    const inspect = (node: Node) => {
      if (
        node.tag.includes(':') ||
        Object.values(node.attrs).some((entry) => /\$\{|\$\(/.test(entry))
      )
        throw new Error('Expand Xacro into URDF before opening this model.');
      node.children.forEach(inspect);
    };
    inspect(robot);
    const group = new Group();
    group.name = robot.attrs.name || 'Robot';
    const materials = new Map(children(robot, 'material').map((item) => [item.attrs.name, item]));
    const links = new Map<string, Group>();
    for (const link of children(robot, 'link')) {
      const name = link.attrs.name;
      if (!name || name.length > 200 || links.has(name))
        throw new Error('URDF link names must be distinct.');
      const object = new Group();
      object.name = name;
      links.set(name, object);
      let visuals = children(link, 'visual');
      if (!visuals.length && children(link, 'collision').length) {
        visuals = children(link, 'collision');
        warn('Links without visuals use their collision geometry.');
      }
      for (const [index, visual] of visuals.entries()) {
        const own = child(visual, 'material');
        const appearance = child(own ?? visual, 'color')
          ? own
          : own?.attrs.name
            ? materials.get(own.attrs.name)
            : undefined;
        const rgba = appearance && child(appearance, 'color')?.attrs.rgba;
        if (appearance && child(appearance, 'texture'))
          warn('URDF texture images are not displayed.');
        const part = await visualGeometry(
          child(visual, 'geometry'),
          `${name}/${visual.attrs.name || index + 1}`,
          rgba,
        );
        const frame = new Group();
        setOrigin(frame, child(visual, 'origin'));
        frame.add(part);
        object.add(frame);
      }
    }
    const parents = new Map<string, string>();
    const joints = children(robot, 'joint');
    for (const joint of joints) {
      const parent = child(joint, 'parent')?.attrs.link;
      const descendant = child(joint, 'child')?.attrs.link;
      if (!parent || !descendant || !links.has(parent) || !links.has(descendant))
        throw new Error('URDF joint references an unknown link.');
      if (parent === descendant || parents.has(descendant))
        throw new Error('URDF joints do not form a tree.');
      parents.set(descendant, parent);
      const seen = new Set([descendant]);
      let ancestor: string | undefined = parent;
      while (ancestor) {
        if (seen.has(ancestor)) throw new Error('URDF joint cycle detected.');
        seen.add(ancestor);
        ancestor = parents.get(ancestor);
      }
      const object = links.get(descendant)!;
      setOrigin(object, child(joint, 'origin'));
      links.get(parent)!.add(object);
      const type = joint.attrs.type;
      if (type === 'fixed') continue;
      if (!['revolute', 'continuous', 'prismatic'].includes(type) || child(joint, 'mimic')) {
        warn('URDF multi-axis and mimic joints remain in their authored pose.');
        continue;
      }
      const limit = child(joint, 'limit')?.attrs;
      bind(
        object,
        joint.attrs.name,
        type === 'prismatic' ? 'm' : 'rad',
        new Vector3(...numeric(child(joint, 'axis')?.attrs.xyz, 3, [1, 0, 0])),
        new Vector3(),
        type === 'continuous'
          ? [undefined, undefined]
          : [limitValue(limit?.lower), limitValue(limit?.upper)],
      );
    }
    for (const [name, object] of links) if (!parents.has(name)) group.add(object);
    return group;
  };

  const sdfStack = new Set<string>();
  const sdfScope = async (scope: Node, object: Group, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('SDF model nesting exceeds 32 levels.');
    const entries = scope.children.filter((item) =>
      ['model', 'link', 'frame', 'joint', 'include'].includes(item.tag),
    );
    if (
      [scope, ...entries].some(
        (item) => item.attrs.placement_frame || value(item, 'placement_frame'),
      )
    )
      throw new Error(
        'SDF placement_frame is not supported. Export poses relative to the model frame.',
      );
    const includes = new Map<Node, { path: string; model: Node }>();
    for (const item of entries.filter((item) => item.tag === 'include')) {
      if (item.attrs.merge === 'true' || value(item, 'merge') === 'true')
        throw new Error('SDF include merge is not supported. Export the merged model first.');
      let uri = value(item, 'uri');
      if (!uri) throw new Error('SDF include URI is missing.');
      if (!/\.(?:sdf|world)$/i.test(uri)) uri = uri.replace(/\/$/, '') + '/model.sdf';
      const path = assetPath(item.base, uri);
      if (sdfStack.has(path)) throw new Error('SDF include cycle detected.');
      const included = parseXml(await read(path), path.slice(0, path.lastIndexOf('/') + 1));
      if (included.tag !== 'sdf') throw new Error('SDF include does not contain an SDF document.');
      const model = child(included, 'model');
      if (!model) throw new Error('SDF include does not contain a model.');
      item.attrs.name = value(item, 'name') ?? model.attrs.name;
      const sourcePose = child(model, 'pose');
      if (!child(item, 'pose') && sourcePose) item.children.push(sourcePose);
      includes.set(item, { path, model });
    }
    const named = new Map<string, Node>();
    const frames = new Map<string, Matrix4>();
    for (const item of entries) {
      const name =
        item.attrs.name ??
        value(item, 'name') ??
        (item.tag === 'include' ? value(item, 'uri') : undefined);
      if (!name || name.length > 200 || named.has(name))
        throw new Error('SDF frame names must be distinct.');
      named.set(name, item);
    }
    const resolve = (name: string, seen = new Set<string>()): Matrix4 => {
      if (!name || name === '__model__') return new Matrix4();
      if (name === 'world') {
        object.updateWorldMatrix(true, false);
        return object.matrixWorld.clone().invert();
      }
      const known = frames.get(name);
      if (known) return known;
      if (seen.has(name)) throw new Error('SDF frame cycle detected.');
      const item = named.get(name);
      if (!item) throw new Error(`Unknown SDF frame: ${name}.`);
      seen.add(name);
      const pose = child(item, 'pose');
      const parent =
        pose?.attrs.relative_to ??
        pose?.attrs.frame ??
        (item.tag === 'frame'
          ? item.attrs.attached_to
          : item.tag === 'joint'
            ? value(item, 'child')
            : '') ??
        '';
      const matrix = resolve(parent, seen).clone().multiply(poseMatrix(pose));
      frames.set(name, matrix);
      return matrix;
    };
    const groups = new Map<string, Group>();
    for (const [name, item] of named) {
      const frame = new Group();
      frame.name = name;
      setMatrix(frame, resolve(name));
      object.add(frame);
      groups.set(name, frame);
      if (item.tag === 'model') await sdfScope(item, frame, depth + 1);
      else if (item.tag === 'link') {
        const visuals = children(item, 'visual');
        const shapes = visuals.length ? visuals : children(item, 'collision');
        if (!visuals.length && shapes.length)
          warn('Links without visuals use their collision geometry.');
        for (const [index, visual] of shapes.entries()) {
          const appearance = child(visual, 'material');
          if (appearance && (child(appearance, 'script') || child(appearance, 'pbr')))
            warn('SDF material scripts and PBR textures are not displayed.');
          const rgba = appearance && (value(appearance, 'diffuse') ?? value(appearance, 'ambient'));
          const part = await visualGeometry(
            child(visual, 'geometry'),
            `${name}/${visual.attrs.name || index + 1}`,
            rgba,
          );
          const pose = child(visual, 'pose');
          const relative = pose?.attrs.relative_to ?? pose?.attrs.frame;
          const placement = new Group();
          setMatrix(
            placement,
            relative
              ? resolve(name)
                  .clone()
                  .invert()
                  .multiply(resolve(relative))
                  .multiply(poseMatrix(pose))
              : poseMatrix(pose),
          );
          placement.add(part);
          frame.add(placement);
        }
      } else if (item.tag === 'include') {
        const { path, model } = includes.get(item)!;
        sdfStack.add(path);
        try {
          await sdfScope(model, frame, depth + 1);
        } finally {
          sdfStack.delete(path);
        }
      }
    }
    const links = new Map<string, { name: string; parent: string; joint: Node }>();
    let tree = true;
    for (const [name, joint] of named) {
      if (joint.tag !== 'joint') continue;
      const parent = value(joint, 'parent');
      const descendant = value(joint, 'child');
      if (
        !parent ||
        !descendant ||
        (parent !== 'world' && named.get(parent)?.tag !== 'link') ||
        named.get(descendant)?.tag !== 'link' ||
        links.has(descendant)
      ) {
        tree = false;
        break;
      }
      links.set(descendant, { name, parent, joint });
    }
    for (const descendant of links.keys()) {
      const seen = new Set([descendant]);
      let parent = links.get(descendant)?.parent;
      while (parent) {
        if (seen.has(parent)) {
          tree = false;
          break;
        }
        seen.add(parent);
        parent = links.get(parent)?.parent;
      }
    }
    if (!tree) warn('SDF joint posing requires a link tree within each model.');
    else
      for (const [descendant, { name, parent, joint }] of links) {
        const link = groups.get(descendant)!;
        (groups.get(parent) ?? object).attach(link);
        const type = joint.attrs.type;
        if (type === 'fixed') continue;
        if (!['revolute', 'continuous', 'prismatic'].includes(type)) {
          warn('SDF multi-axis joints remain in their authored pose.');
          continue;
        }
        const axis = child(joint, 'axis');
        const xyz = axis && child(axis, 'xyz');
        const limit = axis && child(axis, 'limit');
        const fromModel = axis && value(axis, 'use_parent_model_frame') === 'true';
        const toLink = resolve(descendant).clone().invert();
        const jointFrame = toLink.clone().multiply(resolve(name));
        const axisFrame = toLink
          .clone()
          .multiply(resolve(xyz?.attrs.expressed_in || (fromModel ? '__model__' : name)));
        bind(
          link,
          name,
          type === 'prismatic' ? 'm' : 'rad',
          new Vector3(...numeric(xyz?.text, 3, [0, 0, 1])).transformDirection(axisFrame),
          new Vector3().setFromMatrixPosition(jointFrame),
          type === 'continuous' || !limit
            ? [undefined, undefined]
            : [sdfBound(value(limit, 'lower'), -1), sdfBound(value(limit, 'upper'), 1)],
        );
      }
    if (children(scope, 'actor').length) warn('Animated SDF actors are not displayed.');
    if (children(scope, 'plugin').length) warn('Simulation plugins are not executed.');
  };

  const includeStack = new Set<string>();
  const expandMjcf = async (node: Node, depth = 0): Promise<void> => {
    if (depth > 32) throw new Error('MJCF includes exceed 32 levels.');
    const expanded: Node[] = [];
    for (const item of node.children) {
      if (item.tag === 'include') {
        const path = assetPath('', item.attrs.file);
        if (includeStack.has(path)) throw new Error('MJCF include cycle detected.');
        includeStack.add(path);
        try {
          const included = parseXml(await read(path));
          await expandMjcf(included, depth + 1);
          expanded.push(...included.children);
        } finally {
          includeStack.delete(path);
        }
      } else {
        await expandMjcf(item, depth);
        expanded.push(item);
      }
    }
    node.children = expanded;
  };

  const mjcf = async (root: Node) => {
    if (root.tag !== 'mujoco') throw new Error('MJCF requires a mujoco root.');
    await expandMjcf(root);
    const compiler = child(root, 'compiler');
    if (compiler?.attrs.coordinate === 'global')
      throw new Error('MJCF global coordinates must be converted to local coordinates.');
    if (compiler?.attrs.angle && !['radian', 'degree'].includes(compiler.attrs.angle))
      throw new Error('MJCF compiler angle must be degree or radian.');
    const angle = compiler?.attrs.angle === 'radian' ? 1 : Math.PI / 180;
    const sequence = compiler?.attrs.eulerseq ?? 'xyz';
    if (!/^[xyzXYZ]{3}$/.test(sequence)) throw new Error('Invalid MJCF Euler sequence.');
    const classes = new Map<string, Defaults>();
    const defaults = (node: Node, inherited: Defaults) => {
      const own: Defaults = { ...inherited };
      for (const entry of node.children) {
        if (entry.tag === 'default') continue;
        own[entry.tag] = { ...inherited[entry.tag], ...entry.attrs };
      }
      const name = node.attrs.class ?? '';
      if (classes.has(name)) throw new Error(`Duplicate MJCF default class: ${name}.`);
      classes.set(name, own);
      for (const nested of children(node, 'default')) defaults(nested, own);
    };
    const rootDefaults = children(root, 'default');
    for (const entry of rootDefaults.filter((entry) => !entry.attrs.class)) defaults(entry, {});
    for (const entry of rootDefaults.filter((entry) => entry.attrs.class))
      defaults(entry, classes.get('') ?? {});
    const attrs = (node: Node, inheritedClass = ''): Attributes => {
      const name = node.attrs.class ?? inheritedClass;
      if (name && !classes.has(name)) throw new Error(`Unknown MJCF default class: ${name}.`);
      return { ...classes.get(name)?.[node.tag], ...node.attrs };
    };
    const orient = (object: Object3D, attributes: Attributes) => {
      object.position.fromArray(numeric(attributes.pos, 3, [0, 0, 0]));
      const rotations = ['quat', 'axisangle', 'euler', 'xyaxes', 'zaxis'].filter(
        (key) => attributes[key] !== undefined,
      );
      if (rotations.length > 1) throw new Error('MJCF has conflicting orientation attributes.');
      if (attributes.quat) {
        const [w, x, y, z] = numeric(attributes.quat, 4);
        object.quaternion.set(x, y, z, w);
        if (object.quaternion.lengthSq() < 1e-15) throw new Error('Invalid simulation quaternion.');
        object.quaternion.normalize();
      } else if (attributes.euler) {
        const angles = numeric(attributes.euler, 3);
        const axes: Record<string, Vector3> = {
          x: new Vector3(1, 0, 0),
          y: new Vector3(0, 1, 0),
          z: new Vector3(0, 0, 1),
        };
        angles.forEach((value, index) => {
          const axis = sequence[index];
          const rotation = new Quaternion().setFromAxisAngle(
            axes[axis.toLowerCase()],
            value * angle,
          );
          if (axis === axis.toLowerCase()) object.quaternion.multiply(rotation);
          else object.quaternion.premultiply(rotation);
        });
      } else if (attributes.axisangle) {
        const [x, y, z, rotation] = numeric(attributes.axisangle, 4);
        const axis = new Vector3(x, y, z);
        if (axis.lengthSq() < 1e-15) throw new Error('Invalid rotation axis.');
        object.quaternion.setFromAxisAngle(axis.normalize(), rotation * angle);
      } else if (attributes.zaxis) {
        const axis = new Vector3(...numeric(attributes.zaxis, 3));
        if (axis.lengthSq() < 1e-15) throw new Error('Invalid rotation axis.');
        object.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), axis.normalize());
      } else if (attributes.xyaxes) {
        const axes = numeric(attributes.xyaxes, 6);
        const x = new Vector3(...axes.slice(0, 3));
        const y = new Vector3(...axes.slice(3));
        if (x.lengthSq() < 1e-15) throw new Error('Invalid MJCF xyaxes.');
        x.normalize();
        y.addScaledVector(x, -x.dot(y));
        if (y.lengthSq() < 1e-15) throw new Error('Invalid MJCF xyaxes.');
        y.normalize();
        object.quaternion.setFromRotationMatrix(
          new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y)),
        );
      }
    };
    const assets = child(root, 'asset');
    const meshAssets = new Map(
      children(assets ?? root, 'mesh').map((item) => [
        item.attrs.name ??
          item.attrs.file
            ?.split('/')
            .at(-1)
            ?.replace(/\.[^.]+$/, ''),
        item,
      ]),
    );
    const materials = new Map(
      children(assets ?? root, 'material').map((item) => [item.attrs.name, item]),
    );
    const group = new Group();
    group.name = root.attrs.model || 'MuJoCo';
    const addBody = async (
      node: Node,
      object: Group,
      inheritedClass: string,
      depth: number,
    ): Promise<void> => {
      if (depth > 64) throw new Error('MJCF body nesting exceeds 64 levels.');
      const defaultClass = node.attrs.childclass ?? inheritedClass;
      if (node.tag === 'body') {
        for (const joint of children(node, 'joint')) {
          const entry = attrs(joint, defaultClass);
          const type = entry.type ?? 'hinge';
          if (type !== 'hinge' && type !== 'slide') {
            warn('MJCF free and ball joints remain in their authored pose.');
            continue;
          }
          const scale = type === 'hinge' ? angle : 1;
          const limited =
            entry.limited === 'true' ||
            (entry.limited !== 'false' && compiler?.attrs.autolimits !== 'false');
          const range =
            limited && entry.range ? numeric(entry.range, 2).map((bound) => bound * scale) : [];
          const frame = new Group();
          frame.name = object.name;
          object.add(frame);
          object = frame;
          bind(
            frame,
            entry.name,
            type === 'hinge' ? 'rad' : 'm',
            new Vector3(...numeric(entry.axis, 3, [0, 0, 1])),
            new Vector3(...numeric(entry.pos, 3, [0, 0, 0])),
            [range[0], range[1]],
            (limitValue(entry.ref) ?? 0) * scale,
          );
        }
        if (child(node, 'freejoint'))
          warn('MJCF free and ball joints remain in their authored pose.');
      }
      for (const item of node.children) {
        if (['composite', 'flexcomp', 'replicate', 'attach'].includes(item.tag))
          throw new Error(`MJCF ${item.tag} requires model compilation before preview.`);
        if (item.tag === 'body' || item.tag === 'frame') {
          const body = new Group();
          body.name = item.attrs.name || (item.tag === 'body' ? 'Body' : 'Frame');
          orient(body, item.attrs);
          object.add(body);
          await addBody(item, body, defaultClass, depth + 1);
        } else if (item.tag === 'geom') {
          const attributes = attrs(item, defaultClass);
          const name = attributes.name || `${object.name || 'World'}/geom-${parts + 1}`;
          let rgba = attributes.rgba;
          if (attributes.material) {
            const appearance = materials.get(attributes.material);
            if (!appearance) throw new Error(`Unknown MJCF material: ${attributes.material}.`);
            const materialAttrs = attrs(appearance);
            rgba ??= materialAttrs.rgba;
            if (materialAttrs.texture) warn('MJCF texture images are not displayed.');
          }
          const kind = attributes.type || (attributes.mesh ? 'mesh' : 'sphere');
          if (attributes.mesh && kind !== 'mesh')
            throw new Error('MJCF primitive fitting from mesh assets requires model compilation.');
          const frame = new Group();
          orient(frame, attributes);
          let part: Object3D;
          if (kind === 'mesh') {
            const asset = meshAssets.get(attributes.mesh);
            if (!asset) throw new Error(`Unknown MJCF mesh: ${attributes.mesh}.`);
            const entry = attrs(asset);
            if (entry.file) {
              const prefix = compiler?.attrs.meshdir ?? compiler?.attrs.assetdir ?? '';
              part = await mesh(assetPath(prefix, entry.file), '', name, rgba);
            } else {
              const values = (entry.vertex ?? '').trim().split(/\s+/).map(Number);
              const indices = (entry.face ?? '').trim().split(/\s+/).map(Number);
              if (
                !values.length ||
                values.length % 3 ||
                values.length > 18_000_000 ||
                values.some((number) => !Number.isFinite(number))
              )
                throw new Error('Invalid inline MJCF mesh vertices.');
              if (
                !entry.face ||
                !indices.length ||
                indices.length % 3 ||
                indices.some(
                  (index) => !Number.isInteger(index) || index < 0 || index >= values.length / 3,
                )
              )
                throw new Error('Inline MJCF meshes need explicit triangle faces.');
              const geometry = new BufferGeometry();
              geometry.setAttribute('position', new Float32BufferAttribute(values, 3));
              geometry.setIndex(indices);
              geometry.computeVertexNormals();
              part = check(new Mesh(geometry, material(rgba)), name);
            }
            if (entry.refpos || entry.refquat) {
              const reference = new Group();
              orient(reference, { pos: entry.refpos ?? '0 0 0', quat: entry.refquat ?? '1 0 0 0' });
              reference.updateMatrix();
              const inverse = new Group();
              setMatrix(inverse, reference.matrix.clone().invert());
              inverse.add(part);
              part = inverse;
            }
            const scaled = new Group();
            setScale(scaled, entry.scale);
            scaled.add(part);
            part = scaled;
          } else {
            const supplied = (attributes.size ?? '')
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .map(Number);
            if (
              !supplied.length ||
              supplied.length > 3 ||
              supplied.some((number) => !Number.isFinite(number) || number < 0 || number > 1e6)
            )
              throw new Error('Invalid MJCF geom size.');
            let size: number[];
            if (kind === 'sphere') size = [supplied[0]];
            else if (kind === 'box' || kind === 'ellipsoid') {
              if (supplied.length !== 3) throw new Error(`MJCF ${kind} needs three sizes.`);
              size = kind === 'box' ? supplied.map((number) => number * 2) : supplied;
            } else if (kind === 'plane') {
              if (supplied.length !== 3) throw new Error('MJCF plane needs three sizes.');
              size = supplied.slice(0, 2).map((number) => (number ? number * 2 : 10));
              if (supplied[0] === 0 || supplied[1] === 0)
                warn('Infinite planes use a finite 10-unit preview extent.');
            } else size = [supplied[0], (supplied[1] ?? 0) * 2];
            if (attributes.fromto) {
              if (!['capsule', 'cylinder', 'ellipsoid', 'box'].includes(kind))
                throw new Error(`MJCF fromto is unsupported for ${kind}.`);
              const endpoints = numeric(attributes.fromto, 6);
              const start = new Vector3(...endpoints.slice(0, 3));
              const end = new Vector3(...endpoints.slice(3));
              const direction = end.clone().sub(start);
              const length = direction.length();
              if (length < 1e-12) throw new Error('MJCF fromto endpoints must differ.');
              frame.position.copy(start.add(end).multiplyScalar(0.5));
              frame.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), direction.normalize());
              if (kind === 'box') size[2] = length;
              else if (kind === 'ellipsoid') size[2] = length / 2;
              else size[1] = length;
            }
            part = check(new Mesh(primitive(kind, size), material(rgba)), name);
          }
          frame.add(part);
          object.add(frame);
        }
      }
    };
    const world = child(root, 'worldbody');
    if (!world) throw new Error('MJCF worldbody is missing.');
    await addBody(world, group, '', 0);
    if (child(root, 'equality')) warn('MJCF equality constraints are not applied to joint posing.');
    return group;
  };

  const root = parseXml(data);
  let object: Group;
  if (format === 'urdf') object = await urdf(root);
  else if (format === 'mjcf') object = await mjcf(root);
  else {
    if (root.tag !== 'sdf') throw new Error('SDF requires an sdf root.');
    object = new Group();
    object.name = child(root, 'world')?.attrs.name || child(root, 'model')?.attrs.name || 'SDF';
    const worlds = children(root, 'world');
    if (worlds.length) {
      for (const world of worlds) {
        const group = new Group();
        group.name = world.attrs.name || 'World';
        object.add(group);
        await sdfScope(world, group, 0);
      }
    } else await sdfScope(root, object, 0);
  }
  if (!parts) throw new Error('No visual geometry found in the simulation asset.');
  object.rotation.x = -Math.PI / 2;
  object.updateMatrixWorld(true);
  const joints: Joint[] = [];
  object.traverse((frame) => {
    const joint = articulated.get(frame);
    if (!joint) return;
    let parent = frame.parent;
    while (parent && !articulated.has(parent)) parent = parent.parent;
    joints.push({
      ...joint,
      parent: parent ? articulated.get(parent)?.id : undefined,
      pivot: new Vector3(...joint.pivot).applyMatrix4(frame.matrixWorld).toArray(),
      axis: new Vector3(...joint.axis).transformDirection(frame.matrixWorld).toArray(),
    });
  });
  warn('Kinematic preview, without physics or controllers.');
  return { object, warnings: [...warnings], joints };
}
