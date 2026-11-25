import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repaintGlb, repaintGltf } from '../src/client/viewers/glb-edits.js';

test('recoloring glTF preserves its linked buffers, textures, and untouched instances', () => {
  const source = {
    asset: { version: '2.0' },
    buffers: [{ uri: 'geometry.bin', byteLength: 24 }],
    images: [{ uri: 'surface.png' }],
    nodes: [{ mesh: 0 }, { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const edited = JSON.parse(
    new TextDecoder().decode(
      repaintGltf(bytes.buffer, [{ node: 1, primitive: 0, color: '#ff0000' }]),
    ),
  );
  assert.deepEqual(edited.buffers, source.buffers);
  assert.deepEqual(edited.images, source.images);
  assert.deepEqual(edited.nodes, [{ mesh: 0 }, { mesh: 1 }]);
  assert.deepEqual(edited.meshes[0], source.meshes[0]);
  assert.deepEqual(edited.materials[0], source.materials[0]);
  assert.deepEqual(edited.materials[edited.meshes[1].primitives[0].material].pbrMetallicRoughness, {
    baseColorFactor: [1, 0, 0, 1],
  });
});

test('export colors a textured GLB primitive without changing other nodes or binary data', () => {
  const original = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, { mesh: 0 }],
    meshes: [
      {
        name: 'Shared',
        primitives: [
          { attributes: { POSITION: 0, COLOR_0: 1 }, material: 0 },
          { attributes: { POSITION: 2 }, material: 0 },
        ],
      },
    ],
    materials: [
      {
        name: 'Yellow',
        normalTexture: { index: 1 },
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          baseColorFactor: [1, 1, 0, 0.7],
          roughnessFactor: 0.6,
        },
      },
    ],
  };
  const json = Buffer.from(JSON.stringify(original));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const bytes = new ArrayBuffer(20 + jsonLength + 12);
  const source = Buffer.from(bytes);
  source.writeUInt32LE(0x46546c67, 0);
  source.writeUInt32LE(2, 4);
  source.writeUInt32LE(source.length, 8);
  source.writeUInt32LE(jsonLength, 12);
  source.writeUInt32LE(0x4e4f534a, 16);
  source.fill(0x20, 20, 20 + jsonLength);
  json.copy(source, 20);
  const tail = Buffer.from([4, 0, 0, 0, 66, 73, 78, 0, 1, 2, 3, 4]);
  tail.copy(source, 20 + jsonLength);
  const unchanged = Buffer.from(source);

  const edited = Buffer.from(repaintGlb(bytes, [{ node: 1, primitive: 0, color: '#ff0000' }]));
  const newLength = edited.readUInt32LE(12);
  assert.equal(edited.readUInt32LE(8), edited.length);
  assert.deepEqual(edited.subarray(20 + newLength), tail);
  assert.deepEqual(source, unchanged);
  const result = JSON.parse(edited.toString('utf8', 20, 20 + newLength));
  assert.deepEqual(result.scenes, original.scenes);
  assert.deepEqual(result.nodes, [{ mesh: 0 }, { mesh: 1 }]);
  assert.deepEqual(result.meshes[0], original.meshes[0]);
  assert.deepEqual(result.meshes[1].primitives, [
    { attributes: { POSITION: 0 }, material: 1 },
    original.meshes[0].primitives[1],
  ]);
  assert.deepEqual(result.materials[0], original.materials[0]);
  assert.deepEqual(result.materials[1], {
    name: 'Yellow',
    normalTexture: { index: 1 },
    pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.7], roughnessFactor: 0.6 },
  });
});
