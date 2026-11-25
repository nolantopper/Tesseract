import type { AsyncBuffer } from 'hyparquet';
import { mapFileLimit, mapPreview } from './map-preview';
import { TableReader, editSqliteCell } from './table-preview';
import {
  editModelDescription,
  inspectGguf,
  inspectOnnx,
  inspectSafetensors,
  inspectTflite,
} from './machine-model';
import type { StructuredOutput, WorkerInput, WorkerOutput } from './structured';

const table = new TableReader();
const pending = new Map<
  number,
  { resolve: (data: ArrayBuffer) => void; reject: (error: Error) => void }
>();
let nextId = 0;
function post(message: WorkerOutput) {
  self.postMessage(message);
}
function read(
  request: { kind: 'read'; start: number; length: number } | { kind: 'asset'; extension: string },
) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    post({ ...request, id });
  });
}

self.onmessage = async ({ data }: MessageEvent<WorkerInput>) => {
  if (data.kind === 'bytes') {
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.data) request?.resolve(data.data);
    else request?.reject(new Error(data.error ?? 'Couldn’t read file.'));
    return;
  }
  try {
    const { size } = data;
    const file: AsyncBuffer = {
      byteLength: size,
      slice: (start, end = size) => read({ kind: 'read', start, length: end - start }),
    };
    if (data.kind === 'edit') {
      const bytes =
        'table' in data.edit
          ? await editSqliteCell(file, data.edit.table)
          : await editModelDescription(await file.slice(0), data.format, data.edit.description);
      self.postMessage({ kind: 'edit', bytes } satisfies WorkerOutput, {
        transfer: [bytes.buffer as ArrayBuffer],
      });
      return;
    }
    const { format, request } = data;
    let result: StructuredOutput;
    switch (format) {
      case 'sqlite':
        result = await table.sqlite(file, request);
        break;
      case 'parquet':
        result = await table.parquetPage(file, request);
        break;
      case 'geojson':
      case 'kml':
      case 'shp':
        if (size > mapFileLimit) throw new Error('Map preview limit is 16 MiB.');
        result = await mapPreview(await file.slice(0), format, async (extension) => {
          return read({ kind: 'asset', extension }).catch(() => undefined);
        });
        break;
      case 'gguf':
        result = await inspectGguf(file);
        break;
      case 'safetensors':
        result = await inspectSafetensors(file);
        break;
      case 'onnx':
      case 'tflite':
        if (size > 64 * 1024 * 1024) throw new Error('Model inspection limit is 64 MiB.');
        result = (format === 'onnx' ? inspectOnnx : inspectTflite)(await file.slice(0));
        break;
      default:
        throw new Error('Unsupported preview format.');
    }
    post({ kind: 'result', data: result });
  } catch (error) {
    if (data.kind === 'edit') {
      post({ kind: 'edit', error: error instanceof Error ? error.message : 'Couldn’t edit file.' });
      return;
    }
    post({
      kind: 'error',
      error: error instanceof Error ? error.message : 'Couldn’t inspect file.',
    });
  }
};
