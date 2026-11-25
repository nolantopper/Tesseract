import assert from 'node:assert/strict';
import test from 'node:test';
import {
  joinAssetReference,
  packageAssetPaths,
  resolveAssetPath,
} from '../src/shared/asset-path.js';

test('linked assets resolve relative to their document while preserving the workspace path', () => {
  assert.equal(resolveAssetPath('models/robot.urdf', '../meshes/body.stl'), 'meshes/body.stl');
  assert.equal(resolveAssetPath('meshes/body.gltf', 'body.bin'), 'meshes/body.bin');
  assert.equal(
    resolveAssetPath('package://robot/meshes/body.gltf', '../textures/body.png'),
    'package://robot/textures/body.png',
  );
  assert.equal(
    resolveAssetPath('/workspace/urdf/robot.urdf', '../meshes/body.stl'),
    '/workspace/meshes/body.stl',
  );
  assert.equal(
    resolveAssetPath('scene.usda', 'textures/space%20name.png'),
    'textures/space name.png',
  );
  assert.equal(
    resolveAssetPath('folder/scene.usda', '.\\textures\\surface.png'),
    'folder/textures/surface.png',
  );
  assert.equal(resolveAssetPath('scene.usda', 'literal%2520name.png'), 'literal%20name.png');
});

test('asset paths reject network access, absolute paths, controls, and archive root escapes', () => {
  for (const path of [
    '../secret',
    '%2e%2e/secret',
    '/secret',
    '%2fsecret',
    '//host/file',
    'https://host/file',
    'file:///secret',
    'C:\\secret',
    'data:image/png;base64,eA==',
    'bad%00name',
    'bad%0aname',
    'bad%zzname',
  ])
    assert.throws(() => resolveAssetPath('scene.usda', path));
  assert.throws(() => resolveAssetPath('dir/scene.usda', '../../secret'));
  assert.throws(() => resolveAssetPath('package://robot/meshes/body.gltf', '../../secret'));
  assert.throws(() => resolveAssetPath('https://host/mesh.gltf', 'secret'));
});

test('package and model URIs produce only contained exact lookup candidates', () => {
  assert.deepEqual(packageAssetPaths('package://robot/meshes/body.stl'), [
    'robot/meshes/body.stl',
    'meshes/body.stl',
  ]);
  assert.deepEqual(packageAssetPaths('model://robot/materials/space%20name.png'), [
    'robot/materials/space name.png',
    'materials/space name.png',
  ]);
  assert.deepEqual(packageAssetPaths('package://robot/literal%2520name.png'), [
    'robot/literal%20name.png',
    'literal%20name.png',
  ]);
  assert.equal(packageAssetPaths('mesh/body.stl'), undefined);
  assert.equal(packageAssetPaths('https://host/file'), undefined);
  for (const path of [
    'package://../secret',
    'model://robot/../secret',
    'package://robot/%2fsecret',
  ])
    assert.throws(() => packageAssetPaths(path));
});

test('linked mesh references keep the root document frame until the final scope resolution', () => {
  const texture = joinAssetReference('body.gltf', '../textures/color.png');
  assert.equal(texture, '../textures/color.png');
  assert.equal(resolveAssetPath('robot/model.urdf', texture), 'textures/color.png');
  const outside = joinAssetReference('../meshes/body.gltf', '../../texture.png');
  assert.equal(outside, '../meshes/../../texture.png');
  assert.equal(resolveAssetPath('robot/urdf/model.urdf', outside), 'texture.png');
  assert.throws(() => resolveAssetPath('robot/model.urdf', outside));
  assert.equal(
    joinAssetReference('package://robot/meshes/body.gltf', '../textures/a.png'),
    'package://robot/meshes/../textures/a.png',
  );
  assert.throws(() => joinAssetReference('package://robot/meshes/body.gltf', '../../texture.png'));
  assert.equal(
    resolveAssetPath(
      'robot/model.urdf',
      joinAssetReference('meshes/body.gltf', 'literal%2520name.png'),
    ),
    'robot/meshes/literal%20name.png',
  );
  for (const reference of [
    'https://host/file',
    'file:///secret',
    '/secret',
    '//host/file',
    '%2fsecret',
    'C:\\secret',
    'bad%00name',
  ])
    assert.throws(() => joinAssetReference('mesh.gltf', reference));
  assert.throws(() => joinAssetReference('https://host/mesh.gltf', 'secret'));
});
