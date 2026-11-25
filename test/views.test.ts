import assert from 'node:assert/strict';
import test from 'node:test';
import { SharedViews } from '../src/server/views.js';
import type { ViewSnapshot } from '../src/shared/view.js';

test('shared thumbnails follow their selection atomically and manual capture still works', () => {
  const views = new SharedViews();
  const snapshot: ViewSnapshot = {
    name: 'unnamed.glb',
    format: 'glb',
    size: 100,
    context: { kind: 'model', objects: [{ id: 'object-1', name: 'mesh_1' }] },
  };
  const identity = views.share('revision-1', snapshot, '/9j/AAAA');
  const selected = { ...snapshot, selected: { objectId: 'object-1' } };
  views.sync(identity, selected, undefined, '/9j/BBBB');
  assert.equal(views.read(identity).snapshot.selected?.objectId, 'object-1');
  assert.equal(views.read(identity).image, '/9j/BBBB');
  assert.equal(views.read(identity).imageMatchesSnapshot, true);

  // A failed automatic capture must clear the image of the previous selection.
  views.sync(identity, snapshot);
  assert.equal(views.read(identity).snapshot.selected, undefined);
  assert.equal(views.read(identity).image, undefined);
  assert.equal(views.read(identity).imageMatchesSnapshot, false);

  const command = views.queue(identity, { kind: 'capture' });
  views.sync(identity, undefined, { id: command.id, message: 'Captured preview.' }, '/9j/CCCC');
  assert.equal(views.read(identity).image, '/9j/CCCC');
  assert.equal(views.read(identity).imageMatchesSnapshot, true);
  assert.equal(views.read(identity).pendingCommandId, undefined);
  assert.throws(() => views.sync({ ...identity, revision: 'older' }, selected), /revision/);
});

test('joint commands require a shared controllable joint and an in-range value', () => {
  const views = new SharedViews();
  const identity = views.share('revision-1', {
    name: 'arm.urdf',
    format: 'urdf',
    size: 10,
    context: {
      kind: 'model',
      objects: [],
      joints: [{ id: 'joint-0', name: 'Hinge', unit: 'rad', min: -1, max: 1, value: 0 }],
    },
  });
  assert.throws(
    () => views.queue(identity, { kind: 'set_joint', jointId: 'joint-9', value: 0 }),
    /unavailable/,
  );
  assert.throws(
    () => views.queue(identity, { kind: 'set_joint', jointId: 'joint-0', value: 2 }),
    /between/,
  );
  assert.equal(
    views.queue(identity, { kind: 'set_joint', jointId: 'joint-0', value: 1 }).action.kind,
    'set_joint',
  );
});
