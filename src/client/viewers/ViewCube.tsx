import type { Ref } from 'react';
import { Matrix4, Vector3, type Camera } from 'three';

const faces = [
  { name: 'Front', normal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], rotation: 'rotateY(0deg)' },
  {
    name: 'Right',
    normal: [1, 0, 0],
    right: [0, 0, -1],
    up: [0, 1, 0],
    rotation: 'rotateY(90deg)',
  },
  {
    name: 'Back',
    normal: [0, 0, -1],
    right: [-1, 0, 0],
    up: [0, 1, 0],
    rotation: 'rotateY(180deg)',
  },
  {
    name: 'Left',
    normal: [-1, 0, 0],
    right: [0, 0, 1],
    up: [0, 1, 0],
    rotation: 'rotateY(-90deg)',
  },
  { name: 'Top', normal: [0, 1, 0], right: [1, 0, 0], up: [0, 0, -1], rotation: 'rotateX(90deg)' },
  {
    name: 'Bottom',
    normal: [0, -1, 0],
    right: [1, 0, 0],
    up: [0, 0, 1],
    rotation: 'rotateX(-90deg)',
  },
].map((face) => ({
  ...face,
  normal: new Vector3().fromArray(face.normal),
  right: new Vector3().fromArray(face.right),
  up: new Vector3().fromArray(face.up),
}));

const regions = faces.map((face) =>
  [1, 0, -1].flatMap((row) =>
    [-1, 0, 1].map((column) => {
      const direction = face.normal
        .clone()
        .addScaledVector(face.right, column)
        .addScaledVector(face.up, row);
      const adjacent = faces.filter((other) => other !== face && direction.dot(other.normal) > 0);
      const names = [face.name, ...adjacent.map((other) => other.name)].join(' / ');
      const label = column && row ? `${names} corner` : column || row ? `${names} edge` : face.name;
      return { direction, label, center: !row && !column };
    }),
  ),
);

export function updateViewCube(cube: HTMLDivElement, camera: Camera) {
  const rotation = new Matrix4().makeRotationFromQuaternion(
    camera.quaternion.clone().invert(),
  ).elements;
  // CSS points down along Y, so flip the input and output Y axes.
  for (const index of [1, 4, 6, 9]) rotation[index] *= -1;
  cube.style.transform = `matrix3d(${rotation.join(',')})`;
  const towardCamera = new Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  for (const [index, face] of faces.entries()) {
    (cube.children[index] as HTMLElement).hidden = towardCamera.dot(face.normal) <= 0.001;
  }
}

export default function ViewCube({
  cubeRef,
  onSnap,
}: {
  cubeRef: Ref<HTMLDivElement>;
  onSnap: (direction: Vector3) => void;
}) {
  return (
    <div className="view-cube" role="group" aria-label="View cube">
      <div className="view-cube-body" ref={cubeRef}>
        {faces.map((face, index) => (
          <div
            className="view-cube-face"
            key={face.name}
            data-face={face.name}
            style={{ transform: `${face.rotation} translateZ(var(--cube-half))` }}
          >
            {regions[index].map(({ direction, label, center }) => (
              <button
                type="button"
                key={label}
                aria-label={label}
                title={label}
                onClick={() => onSnap(direction)}
              >
                {center ? face.name : null}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
