import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLas } from '../src/client/viewers/las.js';
import { parseVtkXml } from '../src/client/viewers/vtk-xml.js';
const array = (data: Uint8Array) => Uint8Array.from(data).buffer;
test('LAS preserves source coordinates and point colors, rejects truncated data', async () => {
  const data = await readFile('samples/scientific/points.las');
  const geometry = parseLas(array(data));
  assert.deepEqual(
    Array.from(geometry.getAttribute('position').array),
    [0, 0, 0, 1, 0, 1, 0, 1, 0],
  );
  assert.equal(geometry.getAttribute('color').count, 3);
  geometry.dispose();
  assert.throws(() => parseLas(array(data.subarray(0, 228))), /truncated/);
});
test('VTK XML triangulates cells and maps scalar values; rejects entities and invalid indices', async () => {
  const xml = await readFile('samples/scientific/surface.vtp', 'utf8');
  const geometry = parseVtkXml(array(new TextEncoder().encode(xml)));
  assert.deepEqual(Array.from(geometry.index!.array), [0, 1, 2]);
  assert.equal(geometry.getAttribute('color').count, 3);
  geometry.dispose();
  assert.throws(
    () => parseVtkXml(array(new TextEncoder().encode('<!DOCTYPE VTKFile>' + xml))),
    /entities/,
  );
  assert.throws(
    () =>
      parseVtkXml(
        array(new TextEncoder().encode(xml.replace('>0 1 2</DataArray>', '>0 1 30</DataArray>'))),
      ),
    /index/,
  );
});
