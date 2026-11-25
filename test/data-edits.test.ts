import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NetCDFReader } from 'netcdfjs';
import * as h5 from 'h5wasm/node';
import { editHdf5Value } from '../src/client/viewers/hdf5-edits.js';
import {
  editModelDescription,
  inspectGguf,
  inspectOnnx,
  inspectSafetensors,
  inspectTflite,
} from '../src/client/viewers/machine-model.js';
import { mapPreview, renameMapFeature } from '../src/client/viewers/map-preview.js';
import { editNetCdfValue } from '../src/client/viewers/netcdf-edits.js';
import { editSqliteCell, TableReader } from '../src/client/viewers/table-preview.js';
import { editNpyValue, inspectNpy } from '../src/shared/numpy.js';

const fixture = async (path: string) =>
  Uint8Array.from(await readFile(new URL(path, import.meta.url))).buffer;
const structured = (name: string) => fixture(`./fixtures/structured/${name}`);
const scientific = (name: string) => fixture(`../samples/scientific/${name}`);

test('SQLite changes only the selected row and preserves 64-bit integer values', async () => {
  const bytes = await structured('rows.sqlite');
  const table = 'samples';
  const original = await new TableReader().sqlite(bytes, { table });
  const column = original.columns[1].name;
  const rowId = original.edits![1].rowId;
  const edit = { table, column, rowId, value: '9223372036854775807' };
  assert.equal(original.edits![1].types[1], 'integer');
  const result = await editSqliteCell(bytes, edit);
  const reopened = await new TableReader().sqlite(Uint8Array.from(result).buffer, { table });
  assert.deepEqual(reopened.rows.slice(0, 3), [
    original.rows[0],
    ['sample-1', edit.value],
    original.rows[2],
  ]);
  await assert.rejects(editSqliteCell(bytes, { ...edit, value: '9223372036854775808' }), /range/);
  await assert.rejects(editSqliteCell(bytes, { ...edit, rowId: '-12' }), /valid numeric value/);
  const wal = bytes.slice(0);
  new Uint8Array(wal)[18] = 2;
  new Uint8Array(wal)[19] = 2;
  await assert.rejects(editSqliteCell(wal, edit), /using WAL/);
});

test('GeoJSON replaces one feature name without re-encoding nearby coordinates or large integers', async () => {
  const original =
    '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":null},' +
    '{"type":"Feature","properties":{"Name":"old","count":9223372036854775807},"geometry":' +
    '{"type":"Point","coordinates":[-122.0000,1.200]}}]}';
  const bytes = new TextEncoder().encode(original).buffer;
  const result = renameMapFeature(bytes, 'geojson', 'feature-1', '新 "name"');
  assert.equal(new TextDecoder().decode(result), original.replace('"old"', '"新 \\"name\\""'));
  const map = await mapPreview(result.buffer, 'geojson', async () => undefined);
  assert.equal(map.features[0].label, '新 "name"');
});

test('KML escapes a renamed placemark and retains map geometry', async () => {
  const bytes = await structured('tracks.kml');
  const original = await mapPreview(bytes, 'kml', async () => undefined);
  const edited = renameMapFeature(bytes, 'kml', original.features[0].id, 'Copy <&>');
  const result = await mapPreview(edited.buffer, 'kml', async () => undefined);
  assert.deepEqual(result.bounds, original.bounds);
  assert.deepEqual(result.features[0].lines, original.features[0].lines);
  assert.equal(result.features[0].label, 'Copy <&>');
});

test('NumPy and NetCDF overwrite one numeric value within the original binary layout', async () => {
  const npy = await scientific('array.npy');
  const npyHeader = npy.slice(0, npy.byteLength - 16);
  editNpyValue(npy, 2, '-8.25');
  assert.deepEqual(inspectNpy(npy).preview, [1, 2, -8.25, 4]);
  assert.deepEqual(npy.slice(0, npy.byteLength - 16), npyHeader);
  assert.throws(() => editNpyValue(npy, 10, '0'), /element/);

  const netCdf = await scientific('climate.nc');
  const original = new NetCDFReader(netCdf).getDataVariable('temperature');
  editNetCdfValue(netCdf, 'temperature', 1, '19.25');
  assert.deepEqual(new NetCDFReader(netCdf).getDataVariable('temperature'), [
    original[0],
    19.25,
    original[2],
  ]);
  assert.throws(() => editNetCdfValue(netCdf, 'temperature', 1, '1e99'), /range/);
});

test('HDF5 edits a bounded numeric slice and reopens it without affecting nearby values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tesseract-hdf5-'));
  const path = join(dir, 'dataset.h5');
  try {
    const source = await scientific('datasets.h5');
    const bytes = await editHdf5Value(h5, source, '/temperature', 1, '23.5', path);
    await writeFile(path, bytes);
    const file = new h5.File(path, 'r');
    try {
      const dataset = file.get('temperature');
      assert.ok(dataset instanceof h5.Dataset);
      assert.deepEqual(dataset.value, new Float64Array([1, 23.5, 3]));
    } finally {
      file.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ONNX, Safetensors, and GGUF write descriptions and retain model graphs and weight bytes', async () => {
  const cases = [
    ['relu.onnx', 'onnx', inspectOnnx],
    ['weights.safetensors', 'safetensors', inspectSafetensors],
    ['weights.gguf', 'gguf', inspectGguf],
  ] as const;
  for (const [name, format, inspect] of cases) {
    const original = await structured(name);
    const before = await inspect(original);
    const edit = await editModelDescription(original, format, 'A longer description ✓');
    const after = await inspect(Uint8Array.from(edit).buffer);
    assert.equal(
      after.metadata.find(({ id }) => id === 'model-description')?.details,
      'A longer description ✓',
    );
    assert.deepEqual(after.graphs, before.graphs);
    if (format !== 'onnx') assert.deepEqual(edit.slice(-8), new Uint8Array(original.slice(-8)));
  }
});

test('TensorFlow Lite repoints an existing description while preserving graphs', async () => {
  const original = new Uint8Array(await structured('add.tflite'));
  const view = new DataView(original.buffer);
  const root = view.getUint32(0, true);
  const vtable = root - view.getInt32(root, true);
  const size = view.getUint16(vtable + 2, true);
  const field = root + size;
  const fixture = new Uint8Array(original.length + 16);
  fixture.set(original.subarray(0, field));
  fixture.set(original.subarray(field), field + 8);
  const layout = new DataView(fixture.buffer);
  layout.setUint16(vtable + 2, size + 4, true);
  layout.setUint16(vtable + 10, size, true);
  for (const slot of [1, 2, 4]) {
    const pointer = root + layout.getUint16(vtable + 4 + slot * 2, true);
    layout.setUint32(pointer, layout.getUint32(pointer, true) + 8, true);
  }
  layout.setUint32(field, original.length + 8 - field, true);
  const before = inspectTflite(fixture.buffer);
  const result = await editModelDescription(fixture.buffer, 'tflite', 'New description');
  const parsed = inspectTflite(Uint8Array.from(result).buffer);
  assert.equal(
    parsed.metadata.find(({ id }) => id === 'model-description')?.details,
    'New description',
  );
  assert.deepEqual(parsed.graphs, before.graphs);
});
