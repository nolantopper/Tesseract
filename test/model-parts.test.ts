import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Uint8BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Group,
  Box3,
  Vector3,
} from 'three';
import { partsFromObject, objectFromParts } from '../src/client/viewers/model-parts.js';

test('linked meshes preserve transformed interleaved positions and normalized colors', () => {
  const geometry = new BufferGeometry();
  const data = new InterleavedBuffer(
    new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    6,
  );
  geometry.setAttribute('position', new InterleavedBufferAttribute(data, 3, 0));
  geometry.setAttribute('normal', new InterleavedBufferAttribute(data, 3, 3));
  geometry.setAttribute(
    'color',
    new Uint8BufferAttribute([255, 0, 0, 0, 255, 0, 0, 0, 255], 3, true),
  );
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: '#ff0000' }));
  mesh.name = 'gripper';
  mesh.position.set(2, 3, 4);
  const root = new Group();
  root.add(mesh);
  const parts = partsFromObject(root);
  assert.equal(parts[0].attributes.position.array.length, 9);
  assert.deepEqual([...parts[0].attributes.color.array], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(
    new Box3().setFromObject(objectFromParts(parts)).getCenter(new Vector3()).toArray(),
    [2.5, 3.5, 4],
  );
  assert.deepEqual([...geometry.getAttribute('position').array], [...data.array]);
});

test('normalized positions transform without overflowing and hidden objects stay hidden', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Uint8BufferAttribute([0, 0, 0, 255, 0, 0, 0, 255, 0], 3, true),
  );
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  mesh.position.set(2, 0, 0);
  const root = new Group();
  root.add(mesh);
  const hidden = mesh.clone();
  hidden.visible = false;
  root.add(hidden);
  const parts = partsFromObject(root);
  assert.equal(parts.length, 1);
  assert.deepEqual([...parts[0].attributes.position.array], [2, 0, 0, 3, 0, 0, 2, 1, 0]);
});

test('linked mesh topology rejects missing vertices and mismatched attributes', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Uint8BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 9]);
  assert.throws(
    () => partsFromObject(new Mesh(geometry, new MeshStandardMaterial())),
    /invalid mesh indices/,
  );
  geometry.setIndex([0, 1, 2]);
  geometry.setAttribute('color', new Uint8BufferAttribute([255, 0, 0], 3));
  assert.throws(
    () => partsFromObject(new Mesh(geometry, new MeshStandardMaterial())),
    /mismatched vertex/,
  );
});
