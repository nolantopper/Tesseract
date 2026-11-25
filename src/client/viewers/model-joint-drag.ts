import { MathUtils, Plane, Raycaster, Vector2, Vector3, type Camera } from 'three';
import type { JointHandle } from './model-joints';

export function dragJoint(
  joint: JointHandle,
  point: Vector3,
  start: Vector2,
  rect: { left: number; top: number; width: number; height: number },
  camera: Camera,
  radius: number,
) {
  const { axis, pivot, unit, min, max } = joint;
  let value = joint.value;
  const change = (delta: number) => (value = MathUtils.clamp(value + delta, min, max));
  const scale = new Vector2(rect.width / 2, -rect.height / 2);
  const offset = new Vector2(rect.left + scale.x, rect.top - scale.y);
  const ray = new Raycaster();
  const rayAt = (cursor: Vector2) => {
    ray.setFromCamera(cursor.clone().sub(offset).divide(scale), camera);
    return ray.ray;
  };
  const project = (position: Vector3) => {
    const { x, y } = position.clone().project(camera);
    return new Vector2(x, y).multiply(scale);
  };
  const arm = point.clone().sub(pivot);
  const tangent = unit === 'm' ? axis : new Vector3().crossVectors(axis, arm);
  const sample = unit === 'm' ? radius * 0.01 : 0.01;
  const direction = project(point.clone().addScaledVector(tangent, sample))
    .sub(project(point))
    .divideScalar(sample);
  const reach = unit === 'm' ? direction.length() * radius : direction.length();
  let previous = start.clone();
  // End-on sliders and hinges at the pivot use screen motion when their axis projects to a point.
  if (!Number.isFinite(reach) || reach < 12) {
    if (unit === 'm') direction.set(0, -rect.height / (2 * radius));
    else direction.set(rect.height / 3, 0);
  }
  const linear = (cursor: Vector2) => {
    const delta = cursor.clone().sub(previous).dot(direction) / direction.lengthSq();
    previous.copy(cursor);
    return change(delta);
  };
  const center = pivot.clone().addScaledVector(axis, arm.dot(axis));
  let last: Vector3 | undefined = point.clone().sub(center);
  if (
    unit === 'm' ||
    last.length() < radius * 0.01 ||
    Math.abs(rayAt(start).direction.dot(axis)) < 0.25
  )
    return linear;

  const plane = new Plane().setFromNormalAndCoplanarPoint(axis, point);
  const hit = new Vector3();
  const cross = new Vector3();
  const deadZone = last.length() * 0.06;
  return (cursor: Vector2) => {
    if (!rayAt(cursor).intersectPlane(plane, hit)) return value;
    const next = hit.clone().sub(center);
    if (next.length() < deadZone) {
      last = undefined;
      return value;
    }
    const delta = last ? Math.atan2(axis.dot(cross.crossVectors(last, next)), last.dot(next)) : 0;
    last = next;
    return change(delta);
  };
}
