import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  inspectGguf,
  inspectOnnx,
  inspectSafetensors,
  inspectTflite,
} from '../src/client/viewers/machine-model.js';
import { mapPreview } from '../src/client/viewers/map-preview.js';
import { TableReader } from '../src/client/viewers/table-preview.js';

const fixture = async (name: string) => {
  const bytes = await readFile(new URL(`./fixtures/structured/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

test('SQLite previews quote table names and preserve large integers across pages', async () => {
  const database = await fixture('rows.sqlite');
  const reader = new TableReader();
  const first = await reader.sqlite(database, {});
  assert.equal(first.table, 'quoted"table');
  assert.deepEqual(first.rows, [['quoted']]);
  const samples = await reader.sqlite(database, { table: 'samples' });
  assert.equal(samples.rows.length, 64);
  assert.equal(samples.more, true);
  assert.deepEqual(samples.rows[0], ['sample-0', String(2n ** 62n)]);
  const end = await reader.sqlite(database, { table: 'samples', offset: 64 });
  assert.equal(end.more, false);
  assert.deepEqual(end.rows[1], ['sample-65', String(2n ** 62n + 65n)]);
});

test('Parquet reads a selected row page and its schema', async () => {
  const database = await fixture('rows.parquet');
  const reader = new TableReader();
  const page = await reader.parquetPage(database, { offset: 64 });
  assert.deepEqual(
    page.columns.map(({ name }) => name),
    ['name', 'score'],
  );
  assert.deepEqual(page.rows, [
    ['sample-64', '64'],
    ['sample-65', '65'],
  ]);
  assert.equal(page.more, false);
});

test('map parsers retain feature names and attributes without remote resources', async () => {
  for (const [file, name] of [
    ['tracks.geojson', 'Downtown route'],
    ['tracks.kml', 'Downtown route'],
    ['stations.shp', 'Downtown station'],
  ]) {
    const format = file.split('.').at(-1)!;
    const output = await mapPreview(await fixture(file), format, (ext) =>
      ext === 'dbf' ? fixture('stations.dbf') : Promise.resolve(undefined),
    );
    assert.equal(output.features[0].label, name);
    assert.ok(output.bounds.every(Number.isFinite));
  }
  await assert.rejects(
    () =>
      mapPreview(
        new TextEncoder().encode('<!DOCTYPE kml><kml/>').buffer,
        'kml',
        async () => undefined,
      ),
    /document type/,
  );
});

test('ONNX and TensorFlow Lite expose operators with tensor connections', async () => {
  const onnx = inspectOnnx(await fixture('relu.onnx')).graphs[0].operators[0];
  assert.equal(onnx.type, 'Relu');
  assert.deepEqual(onnx.inputs, ['input']);
  assert.deepEqual(onnx.outputs, ['output']);
  const lite = inspectTflite(await fixture('add.tflite')).graphs[0].operators[0];
  assert.equal(lite.type, 'Add');
  assert.deepEqual(lite.inputs, ['lhs', 'rhs']);
  assert.deepEqual(lite.outputs, ['output']);
  assert.throws(() => inspectTflite(new ArrayBuffer(16)), /Invalid TensorFlow Lite/);
});

test('Safetensors reads the header and does not access model weights', async () => {
  const bytes = await fixture('weights.safetensors');
  const model = await inspectSafetensors({
    byteLength: bytes.byteLength,
    slice(start, end) {
      assert.ok(end! <= bytes.byteLength - 8);
      return bytes.slice(start, end);
    },
  });
  assert.deepEqual(model.graphs[0].tensors[0], {
    id: 'tensor-0',
    label: 'weight',
    type: 'F32',
    shape: '2',
    details: '8 bytes',
  });
});

test('GGUF exposes architecture and quantization metadata from local bytes', async () => {
  const model = await inspectGguf(await fixture('weights.gguf'));
  assert.ok(
    model.metadata.some(
      ({ label, details }) => label === 'general.architecture' && details === 'llama',
    ),
  );
  assert.deepEqual(model.graphs[0].tensors[0], {
    id: 'tensor-0',
    label: 'weight',
    type: 'F32',
    shape: '2',
  });
});
