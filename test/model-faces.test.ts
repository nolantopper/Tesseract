import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Mesh } from 'three';
import { faceOverlay, findFace } from '../src/client/viewers/model-faces.js';
import { cadSurfaces } from '../src/client/viewers/model-parts.js';

test('face selection welds a planar mesh surface without selecting coplanar disconnected triangles', () => {
  const geometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute(
      [
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0, 3,
        1, 0, 2, 1, 0,
      ],
      3,
    ),
  );
  const mesh = new Mesh(geometry);
  const face = findFace(mesh, 1)!;
  assert.deepEqual(face, { kind: 'planar', index: 0, triangles: [0, 1] });
  assert.deepEqual(findFace(mesh, 0), face);
  assert.equal(faceOverlay(mesh, face).lines.length, 4 * 6);
  assert.deepEqual(findFace(mesh, 3), { kind: 'triangle', index: 3, triangles: [3] });
});

test('the CAD importer’s surface boundaries take precedence over planar mesh grouping', () => {
  const mesh = new Mesh(new BoxGeometry());
  mesh.userData.surfaces = { author: 'model metadata' };
  assert.equal(findFace(mesh, 3)?.kind, 'planar');
  Reflect.set(mesh.userData, cadSurfaces, [
    { first: 0, last: 3 },
    { first: 4, last: 5 },
  ]);
  const face = { kind: 'surface', index: 0, triangles: [0, 1, 2, 3] };
  assert.deepEqual(findFace(mesh, 3), face);
  assert.deepEqual(findFace(mesh, 0, 'surface'), face);
});
