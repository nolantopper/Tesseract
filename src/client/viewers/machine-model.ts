import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import {
  buildGgufHeader,
  gguf,
  GGMLQuantizationType,
  GGUFValueType,
  type GGUFMetadata,
} from '@huggingface/gguf';
import type { AsyncBuffer } from 'hyparquet';
import type { MachineModel, ModelItem } from './structured';
import { replaceJsonProperty } from './json-edits';

const text = new TextDecoder();
const limit = 6000;
const MiB = 1024 * 1024;
const onnxTypes = [
  'Undefined',
  'Float32',
  'Uint8',
  'Int8',
  'Uint16',
  'Int16',
  'Int32',
  'Int64',
  'String',
  'Bool',
  'Float16',
  'Float64',
  'Uint32',
  'Uint64',
  'Complex64',
  'Complex128',
  'BFloat16',
  'Float8E4M3FN',
  'Float8E4M3FNUZ',
  'Float8E5M2',
  'Float8E5M2FNUZ',
  'Uint4',
  'Int4',
];
const liteTypes = [
  'Float32',
  'Float16',
  'Int32',
  'Uint8',
  'Int64',
  'String',
  'Bool',
  'Int16',
  'Complex64',
  'Int8',
  'Float64',
  'Complex128',
  'Uint64',
  'Resource',
  'Variant',
  'Uint32',
  'Uint16',
  'Int4',
  'BFloat16',
  'Int2',
  'Uint4',
  'Float8E4M3FN',
  'Float8E5M2',
];
const liteOps: Record<number, string> = {
  0: 'Add',
  1: 'AveragePool2D',
  2: 'Concatenation',
  3: 'Conv2D',
  4: 'DepthwiseConv2D',
  6: 'Dequantize',
  7: 'EmbeddingLookup',
  9: 'FullyConnected',
  11: 'L2Normalization',
  14: 'Logistic',
  16: 'LSTM',
  17: 'MaxPool2D',
  18: 'Mul',
  19: 'ReLU',
  21: 'ReLU6',
  22: 'Reshape',
  23: 'ResizeBilinear',
  25: 'Softmax',
  28: 'Tanh',
  32: 'Custom',
  34: 'Pad',
  36: 'Gather',
  39: 'Transpose',
  40: 'Mean',
  41: 'Sub',
  42: 'Div',
  43: 'Squeeze',
  45: 'StridedSlice',
  47: 'Exp',
  49: 'Split',
  50: 'LogSoftmax',
  53: 'Cast',
  54: 'PReLU',
  56: 'ArgMax',
  65: 'Slice',
  67: 'TransposeConv',
  70: 'ExpandDims',
  74: 'Sum',
  75: 'Sqrt',
  76: 'Rsqrt',
  77: 'Shape',
  79: 'ArgMin',
  82: 'ReduceMax',
  83: 'Pack',
  88: 'Unpack',
  89: 'ReduceMin',
  97: 'ResizeNearestNeighbor',
  98: 'LeakyReLU',
  114: 'Quantize',
  117: 'HardSwish',
  118: 'If',
  119: 'While',
  126: 'BatchMatmul',
  128: 'CumSum',
  130: 'BroadcastTo',
  150: 'Gelu',
};
const metadata = (label: string, value: string | number | undefined): ModelItem[] =>
  value === undefined || value === ''
    ? []
    : [{ id: `metadata:${label}`, label, details: String(value).slice(0, 4000) }];
const description = (value = ''): ModelItem => ({
  id: 'model-description',
  label: 'Description',
  details: value.slice(0, 4000),
  canEdit: value.length <= 4000,
});
const string = (chunk?: Uint8Array) =>
  chunk ? text.decode(chunk.subarray(0, 1000)).slice(0, 256) : '';
type Fields = Map<number, (Uint8Array | bigint)[]>;

function protobuf(payload: Uint8Array, wanted: number[]): Fields {
  const reader = new BinaryReader(payload);
  const fields: Fields = new Map();
  while (reader.pos < reader.len) {
    const [number, wire] = reader.tag();
    if (
      wanted.includes(number) &&
      (wire === WireType.LengthDelimited || wire === WireType.Varint)
    ) {
      const value = wire === WireType.Varint ? BigInt(reader.int64()) : reader.bytes();
      const list = fields.get(number) ?? [];
      if (list.length < limit) {
        list.push(value);
        fields.set(number, list);
      }
    } else {
      reader.skip(wire, number, 12);
    }
  }
  return fields;
}

const chunks = (fields: Fields, field: number) =>
  (fields.get(field) ?? []).filter((value): value is Uint8Array => value instanceof Uint8Array);
const first = (fields: Fields, field: number) => chunks(fields, field)[0];
const ints = (fields: Fields, field: number) =>
  (fields.get(field) ?? []).filter((value): value is bigint => typeof value === 'bigint');
const name = (fields: Fields, field: number) => string(first(fields, field));
const typename = (types: string[], value: number) => types[value] ?? `Type ${value}`;

export function inspectOnnx(data: ArrayBuffer): MachineModel {
  // ONNX protobuf field numbers are defined by the ONNX IR specification.
  const model = protobuf(new Uint8Array(data), [1, 2, 3, 6, 7, 8]);
  const payload = first(model, 7);
  if (!payload || !ints(model, 1).length) throw new Error('Invalid ONNX model.');
  const graph = protobuf(payload, [1, 2, 5, 11, 12, 13]);
  const operators = chunks(graph, 1).map((item, index): ModelItem => {
    const node = protobuf(item, [1, 2, 3, 4, 5, 7]);
    const type = name(node, 4) || 'Operator';
    const domain = name(node, 7);
    return {
      id: `op-${index}`,
      label: name(node, 3) || `${index + 1} · ${type}`,
      type,
      inputs: chunks(node, 1).slice(0, 48).map(string),
      outputs: chunks(node, 2).slice(0, 48).map(string),
      details: [
        domain && `Domain: ${domain}`,
        ...chunks(node, 5)
          .slice(0, 16)
          .map((attribute) => name(protobuf(attribute, [1]), 1)),
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 3000),
    };
  });
  const tensors = new Map<string, ModelItem>();
  for (const kind of [11, 12, 13]) {
    for (const item of chunks(graph, kind)) {
      const fields = protobuf(item, [1, 2]);
      const label = name(fields, 1);
      if (!label || tensors.has(label)) continue;
      const value = first(fields, 2);
      const tensorBytes = value && first(protobuf(value, [1]), 1);
      const tensor = tensorBytes && protobuf(tensorBytes, [1, 2]);
      const shape = tensor && first(tensor, 2);
      const dimensions =
        shape &&
        chunks(protobuf(shape, [1]), 1)
          .slice(0, 32)
          .map((dim) => {
            const field = protobuf(dim, [1, 2]);
            return name(field, 2) || String(ints(field, 1)[0] ?? '?');
          });
      if (tensors.size >= limit) break;
      tensors.set(label, {
        id: `tensor-${tensors.size}`,
        label,
        type: tensor ? typename(onnxTypes, Number(ints(tensor, 1)[0] ?? 0)) : undefined,
        shape: dimensions?.join(' × '),
        details: kind === 11 ? 'Graph input' : kind === 12 ? 'Graph output' : undefined,
      });
    }
  }
  for (const item of chunks(graph, 5)) {
    const fields = protobuf(item, [1, 2, 8, 14]);
    const label = name(fields, 8);
    if (!label || (!tensors.has(label) && tensors.size >= limit)) continue;
    const shape = ints(fields, 1).slice(0, 32).map(String);
    const packed = first(fields, 1);
    if (!shape.length && packed) {
      const reader = new BinaryReader(packed);
      while (reader.pos < reader.len && shape.length < 32) shape.push(String(reader.int64()));
    }
    tensors.set(label, {
      id: tensors.get(label)?.id ?? `tensor-${tensors.size}`,
      label,
      type: typename(onnxTypes, Number(ints(fields, 2)[0] ?? 0)),
      shape: shape.join(' × '),
      details: ints(fields, 14)[0] === 1n ? 'External initializer' : 'Initializer',
    });
  }
  const opsets = chunks(model, 8)
    .slice(0, 12)
    .map((item) => {
      const fields = protobuf(item, [1, 2]);
      return `${name(fields, 1) || 'ai.onnx'} ${ints(fields, 2)[0] ?? ''}`;
    });
  return {
    graphs: [{ name: name(graph, 2) || 'Graph', operators, tensors: [...tensors.values()] }],
    metadata: [
      ...metadata('IR version', String(ints(model, 1)[0])),
      ...metadata('Producer', [name(model, 2), name(model, 3)].filter(Boolean).join(' ')),
      ...metadata('Operator sets', opsets.join(', ')),
      description(text.decode(chunks(model, 6).at(-1))),
    ],
    note:
      operators.length === limit || tensors.size === limit
        ? `First ${limit} items per group`
        : undefined,
  };
}

function tfliteReader(data: ArrayBuffer) {
  if (data.byteLength < 8 || text.decode(new Uint8Array(data, 4, 4)) !== 'TFL3')
    throw new Error('Invalid TensorFlow Lite model.');
  // A FlatBuffers table stores field offsets in its preceding vtable.
  const view = new DataView(data);
  const u32 = (i: number) => view.getUint32(i, true);
  const i32 = (i: number) => view.getInt32(i, true);
  const u16 = (i: number) => view.getUint16(i, true);
  const indirect = (i: number) => i && i + u32(i);
  const slot = (table: number, field: number) => {
    const vtable = table - i32(table);
    const index = 4 + 2 * field;
    if (index >= u16(vtable)) return 0;
    const relative = u16(vtable + index);
    return relative ? table + relative : 0;
  };
  const readString = (i: number) => {
    const offset = indirect(i);
    return offset ? string(new Uint8Array(data, offset + 4, Math.min(u32(offset), 1000))) : '';
  };
  return { root: u32(0), indirect, slot, readString, u32, i32, view };
}

export function inspectTflite(data: ArrayBuffer): MachineModel {
  const { root, indirect, slot, readString, u32, i32, view } = tfliteReader(data);
  const vector = <T>(i: number, read: (offset: number) => T, max = limit): T[] => {
    const offset = indirect(i);
    if (!offset) return [];
    const length = u32(offset);
    if (offset + 4 + length * 4 > data.byteLength)
      throw new Error('Invalid TensorFlow Lite vector.');
    return Array.from({ length: Math.min(length, max) }, (_unused, j) => read(offset + 4 + j * 4));
  };
  const opcodes = vector(slot(root, 1), (offset) => {
    const table = indirect(offset);
    const old = slot(table, 0);
    const code = Math.max(old ? view.getUint8(old) : 0, u32OrZero(slot(table, 3)));
    return readString(slot(table, 1)) || liteOps[code] || `Operator ${code}`;
  });
  let remaining = limit;
  let operatorsLeft = limit;
  const graphs = vector(
    slot(root, 2),
    (offset) => {
      const table = indirect(offset);
      const inputs = new Set(vector(slot(table, 1), i32, 256));
      const outputs = new Set(vector(slot(table, 2), i32, 256));
      const tensors = vector(
        slot(table, 0),
        (position) => {
          const tensor = indirect(position);
          const type = slot(tensor, 1);
          return {
            label: readString(slot(tensor, 3)),
            type: typename(liteTypes, type ? view.getUint8(type) : 0),
            shape: vector(slot(tensor, 0), i32, 32).join(' × '),
          };
        },
        remaining,
      ).map((tensor, i) => ({
        ...tensor,
        id: `tensor-${offset}-${i}`,
        label: tensor.label || `Tensor ${i}`,
        details: [inputs.has(i) && 'Graph input', outputs.has(i) && 'Graph output']
          .filter(Boolean)
          .join(', '),
      }));
      remaining -= tensors.length;
      const connections = (source: number) =>
        vector(source, i32, 48)
          .filter((i) => i >= 0)
          .map((i) => tensors[i]?.label ?? `Tensor ${i}`);
      const operators = vector(
        slot(table, 3),
        (position) => {
          const op = indirect(position);
          const index = u32OrZero(slot(op, 0));
          const type = opcodes[index] || `Operator code ${index}`;
          return { type, inputs: connections(slot(op, 1)), outputs: connections(slot(op, 2)) };
        },
        operatorsLeft,
      ).map((op, i) => ({ ...op, id: `op-${offset}-${i}`, label: `${i + 1} · ${op.type}` }));
      operatorsLeft -= operators.length;
      return { name: readString(slot(table, 4)) || `Graph ${offset}`, tensors, operators };
    },
    32,
  );
  if (!graphs.length) throw new Error('TensorFlow Lite model has no graphs.');
  return {
    graphs,
    metadata: [
      ...metadata('Schema version', u32OrZero(slot(root, 0))),
      ...(slot(root, 3) ? [description(tfliteDescription(data))] : []),
    ],
    note:
      remaining === 0 || operatorsLeft === 0 || graphs.length === 32
        ? 'Large model · first items shown'
        : undefined,
  };

  function u32OrZero(i: number) {
    return i ? u32(i) : 0;
  }
}

async function safetensorsHeader(file: AsyncBuffer) {
  if (file.byteLength < 10) throw new Error('Invalid Safetensors file.');
  const length = Number(new DataView(await file.slice(0, 8)).getBigUint64(0, true));
  if (length < 2 || length > Math.min(16 * MiB, file.byteLength - 8))
    throw new Error('Invalid or oversized Safetensors header.');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    await file.slice(8, 8 + length),
  );
  const header = JSON.parse(source) as Record<string, unknown>;
  if (!header || typeof header !== 'object' || Array.isArray(header))
    throw new Error('Invalid Safetensors header.');
  return { source, header, length };
}

export async function inspectSafetensors(file: AsyncBuffer): Promise<MachineModel> {
  const { header, length } = await safetensorsHeader(file);
  const entries = Object.entries(header).filter(([key]) => key !== '__metadata__');
  const tensors = entries.slice(0, limit).map(([label, value], index): ModelItem => {
    const tensor = value as { dtype?: unknown; shape?: unknown; data_offsets?: unknown } | null;
    if (
      !tensor ||
      typeof tensor.dtype !== 'string' ||
      !Array.isArray(tensor.shape) ||
      tensor.shape.length > 32 ||
      tensor.shape.some((dim) => !Number.isSafeInteger(dim) || dim < 0) ||
      !Array.isArray(tensor.data_offsets) ||
      tensor.data_offsets.length !== 2 ||
      tensor.data_offsets.some(
        (offset) =>
          !Number.isSafeInteger(offset) || offset < 0 || offset + 8 + length > file.byteLength,
      ) ||
      tensor.data_offsets[0] > tensor.data_offsets[1]
    )
      throw new Error('Invalid Safetensors tensor.');
    return {
      id: `tensor-${index}`,
      label: label.slice(0, 256),
      type: tensor.dtype.slice(0, 64),
      shape: tensor.shape.join(' × '),
      details: `${tensor.data_offsets[1] - tensor.data_offsets[0]} bytes`,
    };
  });
  return {
    graphs: [{ name: 'Weights', operators: [], tensors }],
    metadata: [
      ...metadata('Tensors', tensors.length),
      description(safetensorsDescription(header)),
      ...Object.entries(header.__metadata__ ?? {})
        .filter(([key]) => key !== 'description')
        .slice(0, 48)
        .flatMap(([key, value]) =>
          typeof value === 'string' ? metadata(key.slice(0, 180), value) : [],
        ),
    ],
    note: entries.length > limit ? `First ${limit} tensors` : undefined,
  };
}

async function readGguf(file: AsyncBuffer, typedMetadata = false) {
  let fetched = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '');
    if (!match) throw new Error('Invalid GGUF range.');
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]) + 1, file.byteLength);
    if (start >= end || (fetched += end - start) > 32 * MiB)
      throw new Error('Invalid GGUF data or header exceeds 32 MiB.');
    return new Response(await file.slice(start, end), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end - 1}/${file.byteLength}` },
    });
  };
  const uri = 'https://local.invalid/model.gguf';
  if (typedMetadata) return gguf(uri, { fetch, typedMetadata: true });
  return { ...(await gguf(uri, { fetch })), typedMetadata: undefined };
}

export async function inspectGguf(file: AsyncBuffer): Promise<MachineModel> {
  const result = await readGguf(file);
  const info = result.metadata as GGUFMetadata<{ strict: false }>;
  const tensors = result.tensorInfos.slice(0, limit).map((tensor, index) => ({
    id: `tensor-${index}`,
    label: tensor.name.slice(0, 256),
    type: GGMLQuantizationType[tensor.dtype] ?? `Type ${tensor.dtype}`,
    shape: tensor.shape.slice(0, 32).map(String).join(' × '),
  }));
  return {
    graphs: [{ name: 'Weights', operators: [], tensors }],
    metadata: [
      description(
        typeof info['general.description'] === 'string' ? info['general.description'] : undefined,
      ),
      ...Object.entries(info)
        .filter(([key]) => key !== 'general.description')
        .slice(0, 250)
        .flatMap(([key, value]) =>
          metadata(
            key.slice(0, 180),
            Array.isArray(value)
              ? `${value.length} values`
              : value != null && typeof value !== 'object'
                ? String(value)
                : undefined,
          ),
        ),
    ],
    note: result.tensorInfos.length > limit ? `First ${limit} tensors` : undefined,
  };
}

function safetensorsDescription(header: Record<string, unknown>) {
  const value = header.__metadata__ as Record<string, unknown> | undefined;
  return typeof value?.description === 'string' ? value.description : undefined;
}

function tfliteDescription(data: ArrayBuffer) {
  const { root, indirect, slot, u32, view } = tfliteReader(data);
  const offset = indirect(slot(root, 3));
  if (!offset) return '';
  const end = offset + 4 + u32(offset);
  if (end >= data.byteLength || view.getUint8(end) !== 0)
    throw new Error('Invalid TensorFlow Lite description.');
  return text.decode(new Uint8Array(data, offset + 4, Math.min(4001, end - offset - 4)));
}

export async function editModelDescription(data: ArrayBuffer, format: string, draft: string) {
  const encoded = new TextEncoder().encode(draft);
  if (encoded.length > 16_000 || draft.length > 4000 || draft.includes('\0'))
    throw new Error('Enter a description up to 4,000 characters.');
  if (format === 'onnx') {
    inspectOnnx(data);
    const original = new Uint8Array(data);
    const reader = new BinaryReader(original);
    const writer = new BinaryWriter();
    let start = 0;
    while (reader.pos < reader.len) {
      const offset = reader.pos;
      const [field, wire] = reader.tag();
      reader.skip(wire, field, 12);
      if (field === 6 && wire === WireType.LengthDelimited) {
        writer.raw(original.subarray(start, offset));
        start = reader.pos;
      }
    }
    return writer
      .raw(original.subarray(start))
      .tag(6, WireType.LengthDelimited)
      .bytes(encoded)
      .finish();
  }
  if (format === 'tflite') {
    inspectTflite(data);
    const { root, slot } = tfliteReader(data);
    const field = slot(root, 3);
    if (!field) throw new Error('The model has no description field.');
    const start = Math.ceil(data.byteLength / 8) * 8;
    const output = new Uint8Array(start + 4 + encoded.length + 1);
    output.set(new Uint8Array(data));
    const view = new DataView(output.buffer);
    view.setUint32(field, start - field, true);
    view.setUint32(start, encoded.length, true);
    output.set(encoded, start + 4);
    return output;
  }
  if (format === 'safetensors') {
    await inspectSafetensors(data);
    const { source, header, length } = await safetensorsHeader(data);
    const metadata = header.__metadata__;
    if (
      metadata !== undefined &&
      (!metadata ||
        typeof metadata !== 'object' ||
        Array.isArray(metadata) ||
        Object.values(metadata).some((value) => typeof value !== 'string'))
    )
      throw new Error('Invalid Safetensors metadata.');
    const next =
      metadata === undefined
        ? replaceJsonProperty(source, [], '__metadata__', { description: draft })
        : replaceJsonProperty(source, ['__metadata__'], 'description', draft);
    const bytes = new TextEncoder().encode(next.trimEnd());
    const size = Math.ceil(bytes.length / 8) * 8;
    if (size > 16 * MiB) throw new Error('Safetensors metadata exceeds 16 MiB.');
    const weights = new Uint8Array(data, 8 + length);
    const output = new Uint8Array(8 + size + weights.length);
    new DataView(output.buffer).setBigUint64(0, BigInt(size), true);
    output.fill(32, 8, 8 + size);
    output.set(bytes, 8);
    output.set(weights, 8 + size);
    return output;
  }
  if (format === 'gguf') {
    const { metadata, typedMetadata, littleEndian, tensorInfoByteRange, tensorDataOffset } =
      await readGguf(data, true);
    const info = metadata as GGUFMetadata<{ strict: false }>;
    const alignment = Number(info['general.alignment'] ?? 32);
    if (
      !typedMetadata ||
      !Number.isSafeInteger(alignment) ||
      alignment > 65536 ||
      tensorDataOffset > BigInt(data.byteLength) ||
      Object.keys(typedMetadata).length - 3 !== Number(metadata.kv_count)
    )
      throw new Error('Unsupported GGUF header.');
    const original = new Blob([data]);
    const options = { littleEndian, tensorInfoByteRange, alignment };
    const originalHeader = new Uint8Array(
      await (await buildGgufHeader(original, typedMetadata, options)).arrayBuffer(),
    );
    const originalBytes = new Uint8Array(data);
    if (
      BigInt(originalHeader.length) !== tensorDataOffset ||
      !originalHeader.every((byte, index) => byte === originalBytes[index])
    )
      throw new Error('This GGUF header cannot be rewritten without changing other metadata.');
    typedMetadata['general.description'] = { type: GGUFValueType.STRING, value: draft };
    const header = await buildGgufHeader(original, typedMetadata, options);
    return new Uint8Array(
      await new Blob([header, original.slice(Number(tensorDataOffset))]).arrayBuffer(),
    );
  }
  throw new Error('This model does not support description edits.');
}
