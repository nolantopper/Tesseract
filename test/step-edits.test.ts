import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import initCad from 'occt-import-js';
import { repaintStepFace } from '../src/client/viewers/step-edits.js';

test('STEP saves the selected face color without modifying CAD geometry or neighboring styles', async () => {
  const cad = await initCad();
  const bytes = await readFile(
    resolve('node_modules/occt-import-js/test/testfiles/cax-if/io1-tu-203.stp'),
  );
  const original = cad.ReadStepFile(bytes, null);
  let imports = 0;
  const read: typeof cad.ReadStepFile = (data, options) => {
    imports++;
    return cad.ReadStepFile(data, options);
  };
  const edit = { mesh: 0, face: 24, color: '#ff0000' };
  const output = repaintStepFace(bytes, edit, read);
  assert.equal(imports, 2);
  const saved = cad.ReadStepFile(new Uint8Array(output), null);
  assert.equal(saved.success, true);
  const [mesh] = saved.meshes;
  assert.deepEqual(mesh.attributes, original.meshes[0].attributes);
  assert.deepEqual(mesh.index, original.meshes[0].index);
  assert.deepEqual(mesh.brep_faces[24].color, [1, 0, 0]);
  assert.deepEqual(
    mesh.brep_faces.filter((_, i) => i !== 24),
    original.meshes[0].brep_faces.filter((_, i) => i !== 24),
  );
  const faces = /#\d+=ADVANCED_FACE\([^;]+;/g;
  const contents = bytes.toString();
  const [first, target] = [...contents.matchAll(faces)].filter(
    (_, index) => index === 0 || index === 24,
  );
  const reordered = Buffer.from(
    contents.replace(faces, (record) =>
      record === first[0] ? target[0] : record === target[0] ? first[0] : record,
    ),
  );
  imports = 0;
  const probed = repaintStepFace(reordered, edit, read);
  assert(imports > 2);
  assert.deepEqual(cad.ReadStepFile(new Uint8Array(probed), null), saved);
  assert.throws(
    () => repaintStepFace(bytes, { mesh: 0, face: 100, color: '#ff0000' }, cad.ReadStepFile),
    /unavailable/,
  );
});
