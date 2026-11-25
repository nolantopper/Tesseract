import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Vector2, Vector3 } from 'three';
import { dragJoint } from '../src/client/viewers/model-joint-drag.js';
import type { JointHandle } from '../src/client/viewers/model-joints.js';

const rect = { left: 15, top: 30, width: 400, height: 400 };
const camera = new PerspectiveCamera(40, 1, 0.1, 100);
camera.position.z = 5;
camera.updateMatrixWorld(true);
const pixels = (point: Vector3) => {
  const projected = point.clone().project(camera);
  return new Vector2(rect.left + 200 * (1 + projected.x), rect.top + 200 * (1 - projected.y));
};
const joint: JointHandle = {
  id: 'joint-0',
  name: 'Joint',
  unit: 'rad',
  pivot: new Vector3(),
  axis: new Vector3(0, 0, 1),
  min: -Math.PI / 2,
  max: Math.PI / 2,
  value: 0,
};
const close = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 1e-8);

test('a hinge follows the grab around its pivot and moves back immediately at a limit', () => {
  const point = new Vector3(1, 0, 0);
  const move = dragJoint(joint, point, pixels(point), rect, camera, 1);
  const top = pixels(new Vector3(0, 1, 0));
  close(move(top), Math.PI / 2);
  close(move(pixels(new Vector3(-1, 0, 0))), Math.PI / 2);
  close(move(top), 0);
});

test('a slider projects the drag onto the authored axis and clamps to its limits', () => {
  const point = new Vector3();
  const slider: JointHandle = {
    ...joint,
    unit: 'm',
    axis: new Vector3(1, 0, 0),
    min: -0.5,
    max: 0.5,
  };
  const move = dragJoint(slider, point, pixels(point), rect, camera, 1);
  close(move(pixels(new Vector3(0.35, 1, 0))), 0.35);
  close(move(pixels(new Vector3(0.8, 0, 0))), 0.5);
  close(move(pixels(new Vector3(0.7, 0, 0))), 0.4);
});
