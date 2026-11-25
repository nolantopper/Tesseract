import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import { parseSimulation } from '../src/client/viewers/simulation.js';
import { buildPose } from '../src/client/viewers/model-joints.js';
import { objectFromParts, partsFromObject } from '../src/client/viewers/model-parts.js';

const data = (text: string) => new TextEncoder().encode(text).buffer;
const noAsset = async (path: string): Promise<ArrayBuffer> => {
  throw new Error(`Missing asset: ${path}`);
};
const noMesh = async (): Promise<Object3D> => {
  throw new Error('Unexpected mesh');
};
const meshes = (object: Object3D) => {
  const parts: Mesh[] = [];
  object.traverse((part) => {
    if (part instanceof Mesh) parts.push(part);
  });
  return parts;
};
const close = (actual: number[], expected: number[]) =>
  actual.forEach((number, index) =>
    assert.ok(Math.abs(number - expected[index]) < 1e-6, `${actual} != ${expected}`),
  );

test('URDF preserves visual materials, named parts, joint origins, and Z-up coordinates', async () => {
  const { object, warnings, joints } = await parseSimulation(
    data(`<robot name="Arm">
    <material name="red"><color rgba="0.9 0.1 0.2 1"/></material>
    <link name="base"><visual><geometry><box size="1 2 3"/></geometry><material name="red"/></visual></link>
    <link name="tip"><visual><origin xyz="1 0 0"/><geometry><sphere radius="0.2"/></geometry></visual></link>
    <joint name="hinge" type="revolute"><parent link="base"/><child link="tip"/><origin xyz="0 0 2" rpy="0 0 1.5707963267948966"/></joint>
  </robot>`),
    'urdf',
    noAsset,
    noMesh,
  );
  const parts = meshes(object);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'base/1');
  const color = (parts[0].material as MeshStandardMaterial).color;
  close([color.r, color.g, color.b], [0.9, 0.1, 0.2]);
  close(parts[1].getWorldPosition(new Vector3()).toArray(), [0, 2, -1]);
  assert.match(warnings.join(' '), /physics/i);
  assert.equal(joints[0].name, 'hinge');
});

test('URDF carries fixed descendants through a parent rotation and a local-axis slide', async () => {
  const { object, joints } = await parseSimulation(
    data(`<robot>
    <link name="base"/><link name="arm"/><link name="slide"/>
    <link name="tool"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
    <joint name="tip" type="fixed"><parent link="slide"/><child link="tool"/><origin xyz="1 0 0"/></joint>
    <joint name="extend" type="prismatic"><parent link="arm"/><child link="slide"/><axis xyz="1 0 0"/><limit lower="0" upper="0.5"/></joint>
    <joint name="turn" type="continuous"><parent link="base"/><child link="arm"/><origin xyz="1 0 0"/><axis xyz="0 0 1"/></joint>
  </robot>`),
    'urdf',
    noAsset,
    noMesh,
  );
  const preview = objectFromParts(partsFromObject(object));
  const pose = buildPose(preview, joints);
  const [turn, extend] = pose.read();
  assert.equal(turn.name, 'turn');
  assert.equal(extend.name, 'extend');
  close(new Box3().setFromObject(preview).getCenter(new Vector3()).toArray(), [2, 0, 0]);
  pose.change(turn.id, Math.PI / 2);
  pose.change(extend.id, 0.5);
  close(new Box3().setFromObject(preview).getCenter(new Vector3()).toArray(), [1, 0, -1.5]);
  assert.throws(() => pose.change(extend.id, 0.51), /unavailable/);
  pose.change();
  close(new Box3().setFromObject(preview).getCenter(new Vector3()).toArray(), [2, 0, 0]);
});

test('SDF joints use authored pivots, expressed axes, and preserve fixed children', async () => {
  const { object, joints } = await parseSimulation(
    data(`<sdf version="1.9"><model name="m">
    <link name="base"/>
    <link name="arm"><pose>2 0 0 0 0 0</pose></link>
    <link name="tool"><pose>3 0 0 0 0 0</pose><visual><geometry><box><size>0.1 0.1 0.1</size></box></geometry></visual></link>
    <joint name="turn" type="revolute"><parent>base</parent><child>arm</child>
      <pose relative_to="base">1 0 0 0 0 0</pose><axis><xyz expressed_in="__model__">0 0 1</xyz><limit><lower>-1e16</lower><upper>1e16</upper></limit></axis>
    </joint>
    <joint name="mount" type="fixed"><parent>arm</parent><child>tool</child></joint>
  </model></sdf>`),
    'sdf',
    noAsset,
    noMesh,
  );
  const preview = objectFromParts(partsFromObject(object));
  const pose = buildPose(preview, joints);
  pose.change(joints[0].id, Math.PI / 2);
  close(new Box3().setFromObject(preview).getCenter(new Vector3()).toArray(), [1, 0, -2]);
});

test('MJCF composes same-body joints, uses degree ranges, and resets to the reference pose', async () => {
  const { object, joints } = await parseSimulation(
    data(`<mujoco><worldbody><body>
    <joint name="slide" type="slide" axis="0 1 0" limited="true" range="0 2"/>
    <joint name="turn" type="hinge" pos="1 0 0" range="0 120" ref="30"/>
    <geom type="sphere" size="0.1" pos="2 0 0"/>
  </body></worldbody></mujoco>`),
    'mjcf',
    noAsset,
    noMesh,
  );
  const preview = objectFromParts(partsFromObject(object));
  const pose = buildPose(preview, joints);
  const [slide, turn] = pose.read();
  close([turn.value, turn.max], [Math.PI / 6, (2 * Math.PI) / 3]);
  pose.change(slide.id, 1);
  pose.change(turn.id, turn.max);
  close(new Box3().setFromObject(preview).getCenter(new Vector3()).toArray(), [1, 0, -2]);
  pose.change();
  close(new Box3().setFromObject(preview).getCenter(new Vector3()).toArray(), [2, 0, 0]);
});

test('URDF meshes resolve through callbacks with relative path, extension, scale, and origin', async () => {
  const requested: string[] = [];
  let meshPath: string | undefined;
  const { object } = await parseSimulation(
    data(`<robot name="Mesh robot"><link name="base"><visual>
    <origin xyz="2 0 0"/><geometry><mesh filename="../meshes/body.obj" scale="2 3 4"/></geometry>
  </visual></link></robot>`),
    'urdf',
    async (path) => {
      requested.push(path);
      return data('mesh data');
    },
    async (bytes, extension, path) => {
      assert.equal(extension, 'obj');
      assert.equal(new TextDecoder().decode(bytes), 'mesh data');
      meshPath = path;
      return new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    },
  );
  assert.deepEqual(requested, ['../meshes/body.obj']);
  assert.equal(meshPath, requested[0]);
  const bounds = new Box3().setFromObject(object);
  close(bounds.getSize(new Vector3()).toArray(), [2, 4, 3]);
  close(bounds.getCenter(new Vector3()).toArray(), [2, 0, 0]);
});

test('simulation parser rejects XML entities, missing dependencies, invalid numbers, Xacro, and URDF cycles', async () => {
  await assert.rejects(
    parseSimulation(data('<!DOCTYPE robot [<!ENTITY x "x">]><robot/>'), 'urdf', noAsset, noMesh),
    /entities/,
  );
  await assert.rejects(
    parseSimulation(
      data(
        '<robot><link name="a"><visual><geometry><sphere radius="NaN"/></geometry></visual></link></robot>',
      ),
      'urdf',
      noAsset,
      noMesh,
    ),
    /finite/,
  );
  await assert.rejects(
    parseSimulation(
      data('<robot><xacro:include filename="other"/></robot>'),
      'urdf',
      noAsset,
      noMesh,
    ),
    /Xacro/,
  );
  await assert.rejects(
    parseSimulation(
      data(
        '<robot><link name="a"><visual><geometry><mesh filename="missing.stl"/></geometry></visual></link></robot>',
      ),
      'urdf',
      noAsset,
      noMesh,
    ),
    /Missing asset/,
  );
  await assert.rejects(
    parseSimulation(
      data(`<robot><link name="a"/><link name="b"/>
    <joint type="fixed"><parent link="a"/><child link="b"/></joint>
    <joint type="fixed"><parent link="b"/><child link="a"/></joint>
  </robot>`),
      'urdf',
      noAsset,
      noMesh,
    ),
    /cycle/,
  );
  await assert.rejects(
    parseSimulation(data('<robot><link>'), 'urdf', noAsset, noMesh),
    /Malformed/,
  );
});

test('SDF worlds preserve nested model poses and resolve named frame placements', async () => {
  const { object } = await parseSimulation(
    data(`<sdf version="1.9"><world name="world"><model name="model">
    <pose>1 0 0 0 0 0</pose><frame name="tool"><pose>0 0 2 0 0 0</pose></frame>
    <link name="arm"><pose relative_to="tool">1 0 0 0 0 0</pose>
      <visual name="shape"><pose>0 1 0 0 0 0</pose><geometry><box><size>1 2 3</size></box></geometry>
        <material><diffuse>0.2 0.8 0.3 1</diffuse></material>
      </visual>
    </link>
  </model></world></sdf>`),
    'sdf',
    noAsset,
    noMesh,
  );
  const [part] = meshes(object);
  close(part.getWorldPosition(new Vector3()).toArray(), [2, 2, -1]);
  assert.equal(part.name, 'arm/shape');
  const color = (part.material as MeshStandardMaterial).color;
  close([color.r, color.g, color.b], [0.2, 0.8, 0.3]);
});

test('SDF model includes use source-relative mesh references and reject frame/include cycles', async () => {
  const paths: string[] = [];
  const files: Record<string, string> = {
    'models/part.sdf':
      '<sdf version="1.9"><model name="part"><link name="body"><visual><geometry><mesh><uri>meshes/body.obj</uri></mesh></geometry></visual></link></model></sdf>',
  };
  const { object } = await parseSimulation(
    data(
      '<sdf><world name="w"><include><uri>models/part.sdf</uri><pose>0 0 3 0 0 0</pose></include></world></sdf>',
    ),
    'sdf',
    async (path) => {
      paths.push(path);
      return data(files[path] ?? 'mesh data');
    },
    async () => new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()),
  );
  assert.deepEqual(paths, ['models/part.sdf', 'models/meshes/body.obj']);
  close(meshes(object)[0].getWorldPosition(new Vector3()).toArray(), [0, 3, 0]);
  const packagePaths: string[] = [];
  await parseSimulation(
    data('<sdf><include><uri>model://robot</uri></include></sdf>'),
    'sdf',
    async (path) => {
      packagePaths.push(path);
      return data(path.endsWith('.sdf') ? files['models/part.sdf'] : 'mesh data');
    },
    async () => new Mesh(new BoxGeometry(), new MeshStandardMaterial()),
  );
  assert.deepEqual(packagePaths, ['model://robot/model.sdf', 'model://robot/meshes/body.obj']);
  await assert.rejects(
    parseSimulation(
      data(
        '<sdf><model name="m"><frame name="a"><pose relative_to="b">0 0 0 0 0 0</pose></frame><frame name="b"><pose relative_to="a">0 0 0 0 0 0</pose></frame></model></sdf>',
      ),
      'sdf',
      noAsset,
      noMesh,
    ),
    /cycle/,
  );
  await assert.rejects(
    parseSimulation(
      data('<sdf><include><uri>loop.sdf</uri></include></sdf>'),
      'sdf',
      async () => data('<sdf><model name="m"><include><uri>loop.sdf</uri></include></model></sdf>'),
      noMesh,
    ),
    /cycle/,
  );
});

test('MJCF honors includes, inherited defaults, degree rotations, capsule fromto, and compiler mesh directories', async () => {
  const requested: string[] = [];
  const { object, warnings } = await parseSimulation(
    data(`<mujoco model="Cart">
    <compiler angle="degree" meshdir="meshes"/>
    <default><geom rgba="0.8 0.2 0.1 1"/><default class="small"><geom type="box" size="0.1 0.2 0.3"/></default></default>
    <asset><mesh name="body" file="body.obj" scale="2 2 2"/></asset>
    <worldbody><body name="cart" pos="1 2 3" euler="0 0 90" childclass="small">
      <geom name="box"/><geom class="" name="rod" type="capsule" size="0.1" fromto="0 0 0 0 0 2"/>
      <include file="parts/extra.xml"/>
    </body></worldbody>
  </mujoco>`),
    'mjcf',
    async (path) => {
      requested.push(path);
      if (path === 'parts/extra.xml')
        return data(
          '<mujocoinclude><geom class="" name="imported" type="mesh" mesh="body"/></mujocoinclude>',
        );
      return data('mesh data');
    },
    async () => new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()),
  );
  assert.deepEqual(requested, ['parts/extra.xml', 'meshes/body.obj']);
  const parts = meshes(object);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].name, 'box');
  close(parts[0].getWorldPosition(new Vector3()).toArray(), [1, 3, -2]);
  close(new Box3().setFromObject(parts[0]).getSize(new Vector3()).toArray(), [0.4, 0.6, 0.2]);
  const color = (parts[0].material as MeshStandardMaterial).color;
  close([color.r, color.g, color.b], [0.8, 0.2, 0.1]);
  assert.match(warnings.join(' '), /physics/);
});

test('MJCF validates include cycles, orientation, geometry sizes, and procedural features', async () => {
  await assert.rejects(
    parseSimulation(
      data('<mujoco><include file="loop.xml"/></mujoco>'),
      'mjcf',
      async () => data('<mujoco><include file="loop.xml"/></mujoco>'),
      noMesh,
    ),
    /cycle/,
  );
  await assert.rejects(
    parseSimulation(
      data('<mujoco><worldbody><geom type="box" size="1 2"/></worldbody></mujoco>'),
      'mjcf',
      noAsset,
      noMesh,
    ),
    /three sizes/,
  );
  await assert.rejects(
    parseSimulation(
      data(
        '<mujoco><worldbody><body quat="0 0 0 0"><geom type="sphere" size="1"/></body></worldbody></mujoco>',
      ),
      'mjcf',
      noAsset,
      noMesh,
    ),
    /quaternion/,
  );
  await assert.rejects(
    parseSimulation(
      data('<mujoco><worldbody><replicate count="10000000"/></worldbody></mujoco>'),
      'mjcf',
      noAsset,
      noMesh,
    ),
    /compilation/,
  );
  await assert.rejects(
    parseSimulation(
      data('<mujoco><worldbody><geom type="mesh" mesh="unknown"/></worldbody></mujoco>'),
      'mjcf',
      noAsset,
      noMesh,
    ),
    /Unknown MJCF mesh/,
  );
  await assert.rejects(
    parseSimulation(
      data(
        '<mujoco><worldbody><geom type="sphere" size="1" quat="1 0 0 0" euler="1 2 3"/></worldbody></mujoco>',
      ),
      'mjcf',
      noAsset,
      noMesh,
    ),
    /conflicting/,
  );
});

test('authored simulation demos each contain several named visual parts', async () => {
  for (const [name, format, count] of [
    ['sim-arm.urdf', 'urdf', 4],
    ['sim-world.sdf', 'sdf', 3],
    ['sim-cartpole.xml', 'mjcf', 4],
  ] as const) {
    const bytes = await readFile(`test/fixtures/simulation/${name}`);
    const result = await parseSimulation(Uint8Array.from(bytes).buffer, format, noAsset, noMesh);
    const parts = meshes(result.object);
    assert.equal(parts.length, count, name);
    assert.ok(
      parts.every((part) => part.name.length > 0),
      name,
    );
    assert.ok(new Box3().setFromObject(result.object).getSize(new Vector3()).length() > 1, name);
  }
});

test('repeated simulation mesh instances reuse bytes and geometry without mixing instance transforms', async () => {
  let reads = 0;
  let parses = 0;
  const result = await parseSimulation(
    data(`<robot><link name="body">
    <visual name="one"><origin xyz="1 0 0"/><geometry><mesh filename="part.obj"/></geometry></visual>
    <visual name="two"><origin xyz="3 0 0"/><geometry><mesh filename="part.obj"/></geometry></visual>
  </link></robot>`),
    'urdf',
    async () => {
      reads++;
      return data('mesh');
    },
    async () => {
      parses++;
      const group = new Group();
      group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
      return group;
    },
  );
  assert.equal(reads, 1);
  assert.equal(parses, 1);
  const parts = meshes(result.object);
  close(parts[0].getWorldPosition(new Vector3()).toArray(), [1, 0, 0]);
  close(parts[1].getWorldPosition(new Vector3()).toArray(), [3, 0, 0]);
});

test('MJCF nested includes and compiler meshdir resolve relative to the main document', async () => {
  const requested: string[] = [];
  const files: Record<string, string> = {
    'parts/assets.xml':
      '<mujocoinclude><asset><mesh name="body" file="body.obj"/></asset><include file="extra.xml"/></mujocoinclude>',
    'extra.xml': '<mujocoinclude><option gravity="0 0 -9.81"/></mujocoinclude>',
  };
  await parseSimulation(
    data(
      '<mujoco><compiler meshdir="meshes"/><include file="parts/assets.xml"/><worldbody><geom type="mesh" mesh="body"/></worldbody></mujoco>',
    ),
    'mjcf',
    async (path) => {
      requested.push(path);
      return data(files[path] ?? 'mesh data');
    },
    async () => new Mesh(new BoxGeometry(), new MeshStandardMaterial()),
  );
  assert.deepEqual(requested, ['parts/assets.xml', 'extra.xml', 'meshes/body.obj']);
});

test('MJCF mesh reference translation and rotation precede nonuniform scaling', async () => {
  const result = await parseSimulation(
    data(`<mujoco><asset>
    <mesh name="part" file="part.obj" refpos="1 0 0" refquat="0.7071067811865476 0 0 0.7071067811865476" scale="2 3 4"/>
    </asset><worldbody><geom type="mesh" mesh="part"/></worldbody></mujoco>`),
    'mjcf',
    async () => data('mesh'),
    async () => new Mesh(new BoxGeometry(2, 1, 1).translate(3, 0, 0), new MeshStandardMaterial()),
  );
  const bounds = new Box3().setFromObject(result.object);
  close(bounds.getCenter(new Vector3()).toArray(), [0, 0, 6]);
  close(bounds.getSize(new Vector3()).toArray(), [2, 4, 6]);
});

test('MJCF frame meta-elements compose transforms around geometry and nested bodies', async () => {
  const result = await parseSimulation(
    data(`<mujoco><worldbody>
    <frame name="fixture" pos="1 0 0" euler="0 0 90">
      <geom name="marker" type="sphere" size="0.1" pos="1 0 0"/>
      <body name="nested" pos="0 0 2"><geom name="nested marker" type="box" size="0.1 0.2 0.3"/></body>
    </frame></worldbody></mujoco>`),
    'mjcf',
    noAsset,
    noMesh,
  );
  const parts = meshes(result.object);
  assert.equal(parts.length, 2);
  close(parts[0].getWorldPosition(new Vector3()).toArray(), [1, 0, -1]);
  close(parts[1].getWorldPosition(new Vector3()).toArray(), [1, 2, 0]);
});

test('SDF placement-frame semantics fail explicitly instead of misplacing geometry', async () => {
  for (const xml of [
    '<sdf><model name="m" placement_frame="tip"><pose>10 0 0 0 0 0</pose><link name="tip"><pose>1 0 0 0 0 0</pose><visual><geometry><box><size>1 1 1</size></box></geometry></visual></link></model></sdf>',
    '<sdf><include><uri>part.sdf</uri><placement_frame>tip</placement_frame></include></sdf>',
  ])
    await assert.rejects(
      parseSimulation(data(xml), 'sdf', noAsset, noMesh),
      /placement_frame is not supported/,
    );
  await assert.rejects(
    parseSimulation(
      data('<sdf><include><uri>part.sdf</uri></include></sdf>'),
      'sdf',
      async () => data('<sdf><model name="part" placement_frame="tip"/></sdf>'),
      noMesh,
    ),
    /placement_frame is not supported/,
  );
});

test('SDF includes preserve source names and poses unless explicitly overridden', async () => {
  const included =
    '<sdf><model name="part"><pose>2 0 0 0 0 0</pose><link name="shape"><pose>1 0 0 0 0 0</pose><visual><geometry><box><size>1 1 1</size></box></geometry></visual></link></model></sdf>';
  const result = await parseSimulation(
    data(`<sdf><world name="w">
    <include><uri>part.sdf</uri></include>
    <include><uri>part.sdf</uri><name>override</name><pose>10 0 0 0 0 0</pose></include>
    <model name="relative"><pose relative_to="part">0 3 0 0 0 0</pose><link name="marker"><visual><geometry><sphere><radius>0.1</radius></sphere></geometry></visual></link></model>
  </world></sdf>`),
    'sdf',
    async () => data(included),
    noMesh,
  );
  const parts = meshes(result.object);
  close(parts[0].getWorldPosition(new Vector3()).toArray(), [3, 0, 0]);
  close(parts[1].getWorldPosition(new Vector3()).toArray(), [11, 0, 0]);
  close(parts[2].getWorldPosition(new Vector3()).toArray(), [2, 0, -3]);
  assert.ok(result.object.getObjectByName('part'));
  assert.ok(result.object.getObjectByName('override'));
  await assert.rejects(
    parseSimulation(
      data('<sdf><include merge="true"><uri>part.sdf</uri></include></sdf>'),
      'sdf',
      noAsset,
      noMesh,
    ),
    /include merge is not supported/,
  );
});
