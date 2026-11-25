import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { Box3, Mesh, MeshPhysicalMaterial, Points, Vector3 } from 'three';
import { parseUsd } from '../src/client/viewers/usd.js';
import { partsFromObject } from '../src/client/viewers/model-parts.js';

const buffer = (text: string) => new TextEncoder().encode(text).buffer;
const missing = async (path: string): Promise<ArrayBuffer> => {
  throw new Error(`Missing ${path}`);
};
const scene = (body: string, metadata = '') => buffer(`#usda 1.0\n${metadata}\n${body}\n`);
const meshes = (object: Awaited<ReturnType<typeof parseUsd>>['object']) => {
  const result: Mesh[] = [];
  object.traverse((child) => {
    if (child instanceof Mesh && child.geometry.getAttribute('position')) result.push(child);
  });
  return result;
};
const cube = `def Cube "body"\n{\n double size = 2\n color3f[] primvars:displayColor = [(1, 0, 0)]\n double3 xformOp:translate = (3, 0, 0)\n uniform token[] xformOpOrder = ["xformOp:translate"]\n}`;

test('USD primitives preserve names, material colors, transforms, axis and stage orientation', async () => {
  const parsed = await parseUsd(scene(cube), missing);
  const mesh = meshes(parsed.object)[0];
  assert.equal(mesh.name, 'body');
  assert.equal((mesh.material as MeshPhysicalMaterial).color.getHexString(), 'ff0000');
  assert.deepEqual(
    new Box3().setFromObject(parsed.object).getCenter(new Vector3()).toArray(),
    [3, 0, 0],
  );
  assert.deepEqual(
    new Box3().setFromObject(parsed.object).getSize(new Vector3()).toArray(),
    [2, 2, 2],
  );
  const kinds = ['Sphere', 'Cylinder', 'Cone', 'Capsule', 'Plane'];
  const primitives = await parseUsd(
    scene(
      kinds
        .map(
          (kind) =>
            `def ${kind} "${kind}"\n{\n double radius = 1\n double height = 2\n token axis = "X"\n}`,
        )
        .join('\n'),
      '(\n upAxis = "Z"\n)',
    ),
    missing,
  );
  assert.equal(meshes(primitives.object).length, 5);
  assert.equal(primitives.object.rotation.x, -Math.PI / 2);
  assert.deepEqual(primitives.warnings, []);
});

test('USD polygon meshes preserve geometry and report static animation and texture limitations', async () => {
  const data = scene(
    `def Mesh "triangle"\n{\n point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n int[] faceVertexCounts = [3]\n int[] faceVertexIndices = [0, 1, 2]\n double3 xformOp:translate.timeSamples = {\n 0: (0, 0, 0),\n 1: (2, 0, 0)\n }\n}\ndef Shader "texture"\n{\n asset inputs:file = @image.png@\n}`,
  );
  const parsed = await parseUsd(data, missing);
  assert.equal(meshes(parsed.object)[0].geometry.getAttribute('position').count, 3);
  assert(parsed.warnings.some((warning) => warning.includes('texture')));
  assert(parsed.warnings.some((warning) => warning.includes('initial pose')));
});

test('USD relative references and payloads are loaded without network paths or basename collisions', async () => {
  const requested: string[] = [];
  const files = new Map([
    [
      'assets/root.usda',
      scene(`def Xform "root" (\n prepend references = @../parts/body.usda@\n)\n{\n}`),
    ],
    ['parts/body.usda', scene(cube)],
  ]);
  const data = scene(
    `def Xform "reference" (\n prepend references = @assets/root.usda@\n)\n{\n}\ndef Xform "payload" (\n payload = @parts/body.usda@\n)\n{\n}`,
  );
  const parsed = await parseUsd(data, async (path) => {
    requested.push(path);
    const data = files.get(path);
    if (!data) return missing(path);
    return data;
  });
  assert.deepEqual(requested, ['assets/root.usda', 'parts/body.usda']);
  assert.equal(meshes(parsed.object).length, 2);
  await assert.rejects(
    parseUsd(
      scene(`def Xform "bad" (\n prepend references = @https://example.com/scene.usd@\n)\n{\n}`),
      missing,
    ),
    /Unsupported USD asset path/,
  );
  await assert.rejects(
    parseUsd(scene(`def Xform "bad" (\n prepend references = @missing.usda@\n)\n{\n}`), missing),
    /Couldn’t load USD layer/,
  );
});

test('USD sublayers merge stronger primitive attributes and detect cyclic layers', async () => {
  const sphere = scene('def Sphere "sphere"\n{\n double radius = 1\n}');
  const root = scene('over "sphere"\n{\n double radius = 2\n}', '(\n subLayers = [@base.usda@]\n)');
  const parsed = await parseUsd(root, async () => sphere);
  const size = new Box3().setFromObject(parsed.object).getSize(new Vector3());
  assert(Math.abs(size.x - 4) < 1e-5);
  const cyclic = scene('def Xform "ref" (\n prepend references = @scene.usd@\n)\n{\n}');
  await assert.rejects(
    parseUsd(cyclic, async () => cyclic),
    /Cyclic USD layer reference/,
  );
});

test('USDZ composes internal relative references and rejects traversal, damaged entries and oversized packages', async () => {
  const data = zipSync({
    'layers/root.usda': new Uint8Array(
      scene('def Xform "root" (\n prepend references = @../geometry.usda@\n)\n{\n}'),
    ),
    'geometry.usda': new Uint8Array(scene(cube)),
  });
  const parsed = await parseUsd(data.buffer, missing);
  assert.equal(meshes(parsed.object).length, 1);
  const escaped = zipSync({
    'root.usda': new Uint8Array(
      scene('def Xform "root" (\n prepend references = @../outside.usda@\n)\n{\n}'),
    ),
  });
  await assert.rejects(parseUsd(escaped.buffer, missing), /escapes its package/);
  const bad = data.slice();
  bad[50] ^= 1;
  await assert.rejects(parseUsd(bad.buffer, missing), /ZIP|USD/);
  const huge = zipSync({
    'root.usda': new Uint8Array(scene(cube)),
    padding: new Uint8Array(64 * 1024 * 1024),
  });
  await assert.rejects(parseUsd(huge.buffer, missing), /expands beyond/);
});

test('a real OpenUSD binary USDC crate renders supported intrinsic geometry', async () => {
  const bytes = await readFile(new URL('./fixtures/simulation/usd-crate.usdc', import.meta.url));
  const parsed = await parseUsd(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    missing,
  );
  const names = meshes(parsed.object)
    .map((mesh) => mesh.name)
    .sort();
  assert.deepEqual(names, ['capsule', 'cone', 'cube', 'cylinder', 'sphere']);
  assert.equal(partsFromObject(parsed.object).length, 5);
  assert(parsed.warnings.some((warning) => warning.includes('BasisCurves')));
  await assert.rejects(parseUsd(new Uint8Array([80, 88, 82, 45, 85, 83, 68, 67]).buffer, missing));
});

test('referenced prim transforms compose instead of overwriting the source transform', async () => {
  const child = scene(`def Xform "asset"\n{\n${cube}\n}`);
  const parent = scene(
    'def Xform "instance" (\n prepend references = @part.usda@</asset/body>\n)\n{\n double3 xformOp:translate = (2, 0, 0)\n uniform token[] xformOpOrder = ["xformOp:translate"]\n}',
  );
  const parsed = await parseUsd(parent, async () => child);
  const center = new Box3().setFromObject(parsed.object).getCenter(new Vector3());
  assert.deepEqual(center.toArray(), [5, 0, 0]);
});

test('USD hidden geometry is omitted and malformed topology fails before composing', async () => {
  const parsed = await parseUsd(
    scene(
      `${cube}\ndef Sphere "hidden"\n{\n token visibility = "invisible"\n double radius = 100\n}`,
    ),
    missing,
  );
  assert.equal(meshes(parsed.object).length, 1);
  await assert.rejects(
    parseUsd(
      scene(
        'def Mesh "invalid"\n{\n point3f[] points = [(0,0,0), (1,0,0), (0,1,0)]\n int[] faceVertexIndices = [0,1,999]\n int[] faceVertexCounts = [3]\n}',
      ),
      missing,
    ),
    /face index/,
  );
});

test('USD Points remain pickable point geometry with their authored positions and transforms', async () => {
  const parsed = await parseUsd(
    scene(
      'def Points "lidar"\n{\n point3f[] points = [(0,0,0), (1,2,3), (-1,0,0)]\n double3 xformOp:translate = (2,0,0)\n uniform token[] xformOpOrder = ["xformOp:translate"]\n}',
    ),
    missing,
  );
  let points: Points | undefined;
  parsed.object.traverse((child) => {
    if (child instanceof Points) points = child;
  });
  assert.equal(points?.name, 'lidar');
  assert.equal(points?.geometry.getAttribute('position').count, 3);
  assert.deepEqual(
    new Box3().setFromObject(parsed.object).getCenter(new Vector3()).toArray(),
    [2, 1, 1.5],
  );
  assert.deepEqual(parsed.warnings, []);
});
