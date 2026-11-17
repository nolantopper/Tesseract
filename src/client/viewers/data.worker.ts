import { Bag } from '@foxglove/rosbag';
import { parse } from '@foxglove/rosmsg';
import { MessageReader } from '@foxglove/rosmsg-serialization';
import { McapStreamReader } from '@mcap/core';
import { NetCDFReader } from 'netcdfjs';
import { inspectNpy } from '../../shared/numpy';

const MiB = 1024 * 1024;
const messageLimit = 100;
const valueLimit = 10_000;

function inspectNetCdf(data: ArrayBuffer) {
  const reader = new NetCDFReader(data);
  return {
    version: reader.version,
    dimensions: reader.dimensions,
    attributes: reader.globalAttributes,
    variables: reader.variables.map((variable) => {
      const count = variable.dimensions.reduce(
        (total, id) => total * (reader.dimensions[id]?.size || reader.recordDimension.length),
        1,
      );
      return {
        ...variable,
        preview:
          count <= valueLimit
            ? reader.getDataVariable(variable)
            : 'Variable exceeds 10,000 value preview limit',
      };
    }),
  };
}

function inspectMcapMessages(data: ArrayBuffer) {
  const reader = new McapStreamReader();
  const channels = new Map<number, { topic: string; messageEncoding: string; schemaId: number }>();
  const schemas = new Map<number, { encoding: string; data: Uint8Array }>();
  const messages = [];
  const text = new TextDecoder();

  chunks: for (let offset = 0; offset < data.byteLength; offset += 65536) {
    reader.append(new Uint8Array(data, offset, Math.min(65536, data.byteLength - offset)));
    for (let record; (record = reader.nextRecord());) {
      if (record.type === 'Channel') channels.set(record.id, record);
      if (record.type === 'Schema') schemas.set(record.id, record);
      if (record.type !== 'Message') continue;

      const channel = channels.get(record.channelId);
      const schema = channel && schemas.get(channel.schemaId);
      let value: unknown = 'Unsupported encoding';
      if (record.data.length > MiB) {
        value = 'Message exceeds 1 MiB preview limit';
      } else if (channel?.messageEncoding === 'json') {
        try {
          value = JSON.parse(text.decode(record.data));
        } catch {
          value = 'Invalid JSON';
        }
      } else if (channel?.messageEncoding === 'ros1' && schema?.encoding === 'ros1msg') {
        value = new MessageReader(parse(text.decode(schema.data))).readMessage(record.data);
      }
      messages.push({
        topic: channel?.topic,
        timestampNs: String(record.logTime),
        channelId: record.channelId,
        value,
      });
      if (messages.length >= messageLimit) break chunks;
    }
  }
  return {
    messages,
    note: 'First 100 messages; JSON and ROS1 encodings. Compressed chunks need a decompressor adapter.',
  };
}

async function inspectRosBag(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  const bag = new Bag({
    size: () => bytes.length,
    read: async (offset, length) => {
      if (offset < 0 || length < 0 || length > 64 * MiB || offset + length > bytes.length) {
        throw new Error('Invalid ROS bag read.');
      }
      return bytes.subarray(offset, offset + length);
    },
  });
  await bag.open();
  const messages = [];
  for await (const message of bag.messageIterator()) {
    messages.push({ topic: message.topic, timestamp: message.timestamp, message: message.message });
    if (messages.length >= messageLimit) break;
  }
  return {
    start: bag.startTime,
    end: bag.endTime,
    connections: [...bag.connections.values()],
    messages,
    limit: 'First 100 messages; uncompressed ROS1 bags only.',
  };
}

async function inspectHdf5(data: ArrayBuffer) {
  const h5 = await import('h5wasm');
  const { FS } = await h5.ready;
  const path = '/input.h5';
  FS.writeFile(path, new Uint8Array(data));
  let file: InstanceType<typeof h5.File> | undefined;
  try {
    file = new h5.File(path, 'r');
    const datasets: unknown[] = [];
    let visited = 0;
    const walk = (group: InstanceType<typeof h5.Group>, depth: number) => {
      if (depth > 8) throw new Error('HDF5 nesting exceeds 8 levels.');
      for (const name of group.keys()) {
        if (++visited > 2000) throw new Error('HDF5 exceeds 2,000 objects.');
        // Links may point to other files or introduce cycles.
        if (group.get_link(name)) {
          datasets.push({ name, link: 'Link skipped' });
          continue;
        }
        const entity = group.get(name);
        if (entity instanceof h5.Dataset) {
          const count = entity.shape?.reduce((total, size) => total * size, 1) ?? 0;
          const numeric =
            typeof entity.dtype === 'string' && /^[<>=|]?[bBhHiIlLqQfd]$/.test(entity.dtype);
          datasets.push({
            path: entity.path,
            shape: entity.shape,
            dtype: entity.dtype,
            preview:
              numeric && count <= valueLimit
                ? entity.value
                : 'Metadata only: large or nonnumeric dataset',
          });
        } else if (entity instanceof h5.Group) {
          walk(entity, depth + 1);
        }
      }
    };
    walk(file, 0);
    return { datasets, note: 'Dataset metadata; links are not followed.' };
  } finally {
    file?.close();
    FS.unlink(path);
  }
}

function inspectE57(data: ArrayBuffer) {
  const view = new DataView(data);
  const text = new TextDecoder();
  if (data.byteLength < 48 || text.decode(data.slice(0, 8)) !== 'ASTM-E57') {
    throw new Error('Invalid E57 header.');
  }
  const integer = (offset: number) => {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('E57 offset is too large.');
    return Number(value);
  };
  const offset = integer(24);
  const length = integer(32);
  const page = integer(40);
  if (page < 8 || page > MiB || length > 8 * MiB || offset >= data.byteLength) {
    throw new Error('Invalid E57 XML metadata range.');
  }
  const xml = new Uint8Array(length);
  let written = 0;
  let cursor = offset;
  while (written < length) {
    // Each page ends with a four-byte checksum.
    const take = Math.min(length - written, page - 4 - (cursor % page));
    if (take <= 0 || cursor + take > data.byteLength) throw new Error('Truncated E57 metadata.');
    xml.set(new Uint8Array(data, cursor, take), written);
    written += take;
    cursor += take;
    if (cursor % page === page - 4) cursor += 4;
  }
  return {
    major: view.getUint32(8, true),
    minor: view.getUint32(12, true),
    xml: text.decode(xml),
    note: 'E57 XML metadata only; point packets and page checksums are not decoded.',
  };
}

function inspect(data: ArrayBuffer, kind: string) {
  switch (kind) {
    case 'npy':
      return inspectNpy(data);
    case 'netcdf':
      return inspectNetCdf(data);
    case 'mcap':
      return inspectMcapMessages(data);
    case 'bag':
      return inspectRosBag(data);
    case 'hdf5':
      return inspectHdf5(data);
    case 'e57':
      return inspectE57(data);
    default:
      throw new Error('Unsupported data format.');
  }
}

function formatPreview(result: unknown) {
  let budget = 0;
  const text = JSON.stringify(
    result,
    (_key, value: unknown) => {
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'string') {
        budget += value.length;
        if (budget > 2 * MiB) throw new Error('Metadata exceeds 2 MiB.');
        return value.slice(0, 65536);
      }
      if (ArrayBuffer.isView(value)) {
        return Array.from(value as unknown as ArrayLike<number>).slice(0, 1000);
      }
      return value;
    },
    2,
  );
  if (text.length > 2 * MiB) throw new Error('Data preview exceeds 2 MiB.');
  return text;
}

self.onmessage = async (event: MessageEvent<{ data: ArrayBuffer; kind: string }>) => {
  try {
    const { data, kind } = event.data;
    const result = await inspect(data, kind);
    const messages = 'messages' in result ? result.messages : undefined;
    self.postMessage({ text: formatPreview(result), messages });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Cannot inspect data.' });
  }
};
