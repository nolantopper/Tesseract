import { Group, Vector3, type Object3D } from 'three';
import type { ModelJoint } from '../../shared/view';
import { jointAttachment } from './model-parts';

export type Joint = Omit<ModelJoint, 'value'> & {
  parent?: string;
  reference: number;
  pivot: [number, number, number];
  axis: [number, number, number];
};
export type JointHandle = ModelJoint & { axis: Vector3; pivot: Vector3 };

export function buildPose(root: Object3D, joints: Joint[]) {
  const frames = new Map(joints.map(({ id }) => [id, new Group()]));
  const movable = new Map<Object3D, Joint>(
    joints.filter(({ min, max }) => min < max).map((joint) => [frames.get(joint.id)!, joint]),
  );
  const parts = root.children.slice();
  for (const { id, parent } of joints) {
    (parent ? frames.get(parent)! : root).add(frames.get(id)!);
  }
  for (const part of parts) frames.get(Reflect.get(part.userData, jointAttachment))?.add(part);
  const home = (joint: Joint) => Math.min(joint.max, Math.max(joint.min, joint.reference));
  const values = new Map(joints.map((joint) => [joint.id, home(joint)]));
  const update = () => {
    for (const { id, axis, pivot, reference, unit } of joints) {
      const frame = frames.get(id)!;
      const delta = values.get(id)! - reference;
      const direction = new Vector3(...axis);
      if (unit === 'm') frame.position.copy(direction.multiplyScalar(delta));
      else {
        frame.quaternion.setFromAxisAngle(direction, delta);
        const center = new Vector3(...pivot);
        frame.position.copy(center).sub(center.applyQuaternion(frame.quaternion));
      }
    }
    root.updateMatrixWorld(true);
  };
  update();
  const read = ({ id, name, unit, min, max }: Joint): ModelJoint => ({
    id,
    name,
    unit,
    min,
    max,
    value: values.get(id)!,
  });
  return {
    read: () => joints.map(read),
    jointAt(object: Object3D): JointHandle | undefined {
      for (let frame = object.parent; frame && frame !== root; frame = frame.parent) {
        const joint = movable.get(frame);
        if (!joint) continue;
        const matrix = frame.parent!.matrixWorld;
        return {
          ...read(joint),
          axis: new Vector3(...joint.axis).transformDirection(matrix),
          pivot: new Vector3(...joint.pivot).applyMatrix4(matrix),
        };
      }
    },
    change(id?: string, value?: number) {
      if (id !== undefined) {
        const joint = joints.find((joint) => joint.id === id);
        if (
          !joint ||
          value === undefined ||
          !Number.isFinite(value) ||
          value < joint.min ||
          value > joint.max
        )
          throw new Error('Joint or position unavailable.');
        values.set(id, value);
      } else for (const joint of joints) values.set(joint.id, home(joint));
      update();
    },
  };
}
