import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { parsePcd } from '../src/client/viewers/pcd.ts';
import { rotateMeshSource } from '../src/client/viewers/mesh-edits.ts';

const decode = (value: ArrayBuffer | Uint8Array) => new TextDecoder().decode(value);

test('OBJ rotates only position and normal records, keeping external materials and topology', () => {
  const source = new TextEncoder().encode(
    'mtllib sample.mtl\r\n' +
      'v 1.0e-5  2.0\t-3.5 1 # vertex color follows\r\n' +
      'vn 0 0 +1\r\n' +
      'vt 0.1 0.2\r\n' +
      'g part\r\nusemtl finish\r\nf 1/1/1 2/2/1 3/3/1\r\n',
  );
  assert.equal(
    decode(rotateMeshSource(source.buffer, 'obj', 'y')),
    'mtllib sample.mtl\r\n' +
      'v -3.5  2.0\t-1.0e-5 1 # vertex color follows\r\n' +
      'vn +1 0 -0\r\n' +
      'vt 0.1 0.2\r\n' +
      'g part\r\nusemtl finish\r\nf 1/1/1 2/2/1 3/3/1\r\n',
  );
});

function arrayBuffer(value: string | Uint8Array) {
  return typeof value === 'string'
    ? new TextEncoder().encode(value).buffer
    : new Uint8Array(value).buffer;
}

test('ASCII PLY rotation preserves vertex colors, whitespace, and binary-independent face topology', () => {
  const original = readFileSync('samples/pyramid.ply', 'utf8');
  const start = original.indexOf('end_header\n') + 'end_header\n'.length;
  const header = original
    .slice(0, start)
    .replace(
      'element face 6',
      'property uchar red\nproperty uchar green\nproperty uchar blue\nelement face 6',
    );
  const [a, b, c, d, e, ...faces] = original.slice(start).split('\n');
  const tail = faces.join('\n');
  const source = arrayBuffer(
    header + [a, b, c, d, e].map((row) => row + '\t255 100 0\n').join('') + tail,
  );
  const output = rotateMeshSource(source, 'ply', 'y');
  assert.ok(decode(output).startsWith(header + '-1 0 1\t255 100 0\n'));
  assert.ok(decode(output).endsWith(tail));
  const loader = new PLYLoader();
  const before = loader.parse(source),
    after = loader.parse(arrayBuffer(new Uint8Array(output)));
  assert.deepEqual(after.index!.array, before.index!.array);
  assert.deepEqual(after.getAttribute('color').array, before.getAttribute('color').array);
  assert.deepEqual(Array.from(after.getAttribute('position').array).slice(0, 3), [-1, 0, 1]);
});

test('binary PLY preserves big-endian vertex attributes and face records', () => {
  const header = new TextEncoder().encode(
    'ply\nformat binary_big_endian 1.0\nelement vertex 3\nproperty double x\nproperty uchar red\n' +
      'property double y\nproperty double z\nproperty float nx\nproperty float ny\nproperty float nz\n' +
      'element face 1\nproperty list uchar int vertex_indices\nend_header\n',
  );
  const stride = 37;
  const source = new Uint8Array(header.length + stride * 3 + 13);
  source.set(header);
  const data = new DataView(source.buffer, header.length);
  for (let index = 0; index < 3; index++) {
    const offset = stride * index;
    data.setFloat64(offset, index + 1);
    data.setUint8(offset + 8, 128 + index);
    data.setFloat64(offset + 9, index + 2);
    data.setFloat64(offset + 17, index + 3);
    data.setFloat32(offset + 25, 1);
  }
  data.setUint8(stride * 3, 3);
  data.setInt32(stride * 3 + 5, 1);
  data.setInt32(stride * 3 + 9, 2);
  const output = rotateMeshSource(source.buffer, 'ply', 'z') as ArrayBuffer;
  const bytes = new Uint8Array(output);
  const view = new DataView(output, header.length);
  assert.deepEqual(bytes.subarray(0, header.length), header);
  assert.deepEqual(
    bytes.subarray(header.length + stride * 3),
    source.subarray(header.length + stride * 3),
  );
  assert.equal(view.getUint8(8), 128);
  assert.equal(view.getFloat64(0), -2);
  assert.equal(view.getFloat64(9), 1);
  assert.equal(view.getFloat32(29), 1);
  assert.deepEqual(Array.from(new PLYLoader().parse(output).index!.array), [0, 1, 2]);
});

const pcdHeader = (encoding: 'ascii' | 'binary') =>
  'VERSION 0.7\nFIELDS intensity x normal_z y normal_y z normal_x\n' +
  'SIZE 2 4 4 4 4 4 4\nTYPE U F F F F F F\nCOUNT 1 1 1 1 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\n' +
  `DATA ${encoding}\n`;

test('PCD rotates ASCII and binary positions and normals without changing intensity', () => {
  const original = arrayBuffer(pcdHeader('ascii') + '25 1 3 2 2 3 1\n');
  const ascii = rotateMeshSource(original, 'pcd', 'y');
  assert.equal(decode(ascii), pcdHeader('ascii') + '25 3 -1 2 2 -1 3\n');
  const header = new TextEncoder().encode(pcdHeader('binary'));
  const source = new Uint8Array(header.length + 26);
  source.set(header);
  const data = new DataView(source.buffer, header.length);
  data.setUint16(0, 0x80f2, true);
  [1, 3, 2, 2, 3, 1].forEach((value, i) => data.setFloat32(2 + i * 4, value, true));
  const binary = rotateMeshSource(source.buffer, 'pcd', 'y') as ArrayBuffer;
  const edited = new DataView(binary, header.length);
  assert.deepEqual(new Uint8Array(binary, 0, header.length), header);
  assert.equal(edited.getUint16(0, true), 0x80f2);
  for (const output of [arrayBuffer(new Uint8Array(ascii)), binary]) {
    const cloud = parsePcd(output);
    assert.deepEqual(Array.from(cloud.geometry.getAttribute('position').array), [3, 2, -1]);
    assert.deepEqual(Array.from(cloud.geometry.getAttribute('normal').array), [3, 2, -1]);
    cloud.geometry.dispose();
    cloud.material.dispose();
  }
});

test('point cloud edits reject authored frames, extra coordinate vectors, and compressed records', () => {
  const pcd = pcdHeader('ascii') + '25 1 3 2 2 3 1\n';
  for (const source of [
    'VIEWPOINT 10 0 0 1 0 0 0\n' + pcd,
    pcd.replace('normal_x', 'velocity_x'),
    pcd.replace('DATA ascii', 'DATA binary_compressed'),
  ]) {
    assert.throws(
      () => rotateMeshSource(arrayBuffer(source), 'pcd', 'x'),
      /cannot be rotated safely/,
    );
  }
  const ply = readFileSync('samples/pyramid.ply', 'utf8').replace(
    'element vertex',
    'obj_info frame camera\nelement vertex',
  );
  assert.throws(() => rotateMeshSource(arrayBuffer(ply), 'ply', 'x'), /cannot be rotated safely/);
});

test('ASCII STL keeps the original solid and rotates normals and vertex coordinates', () => {
  const source = new TextEncoder().encode(
    'solid hinge\n  facet normal 0 0 1\n    outer loop\n' +
      '      vertex 1 2 3\n      vertex 3 2 3\n      vertex 3 4 3\n' +
      '    endloop\n  endfacet\nendsolid hinge\n',
  );
  assert.equal(
    decode(rotateMeshSource(source.buffer, 'stl', 'x')),
    'solid hinge\n  facet normal 0 -1 0\n    outer loop\n' +
      '      vertex 1 -3 2\n      vertex 3 -3 2\n      vertex 3 -3 4\n' +
      '    endloop\n  endfacet\nendsolid hinge\n',
  );
});

test('binary STL preserves the original header and per-facet attribute bytes', () => {
  const source = new ArrayBuffer(134);
  const original = new DataView(source);
  original.setUint8(0, 42);
  original.setUint32(80, 1, true);
  for (let offset = 84; offset < 132; offset += 12) {
    original.setFloat32(offset, 1, true);
    original.setFloat32(offset + 4, 2, true);
    original.setFloat32(offset + 8, 3, true);
  }
  original.setUint16(132, 0x8fe7, true);
  const bytes = rotateMeshSource(source, 'stl', 'z') as ArrayBuffer;
  const edited = new DataView(bytes);
  assert.deepEqual(new Uint8Array(bytes).subarray(0, 84), new Uint8Array(source).subarray(0, 84));
  for (let offset = 84; offset < 132; offset += 12) {
    assert.deepEqual(
      Array.from({ length: 3 }, (_, axis) => edited.getFloat32(offset + 4 * axis, true)),
      [-2, 1, 3],
    );
  }
  assert.equal(edited.getUint16(132, true), 0x8fe7);
});
