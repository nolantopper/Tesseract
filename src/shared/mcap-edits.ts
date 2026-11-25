import { McapStreamReader, McapWriter, type IReadable } from '@mcap/core';
import { decompressVideoChunk, videoLimits } from './mcap-video.js';

export async function renameMcapTopic(source: IReadable, channelId: number, topic: string) {
  if (!topic.trim() || topic.length > 1024 || /[\u0000-\u001f]/.test(topic))
    throw new Error('Enter a topic name of up to 1,024 characters.');
  const sourceSize = await source.size();
  if (sourceSize > BigInt(videoLimits.input)) throw new Error('Save limit is 64 MiB.');
  let expanded = 0;
  const reader = new McapStreamReader({
    decompressHandlers: {
      zstd(data, size) {
        expanded += Number(size);
        if (expanded > videoLimits.expanded)
          throw new Error('Expanded recording exceeds the limit.');
        return decompressVideoChunk(data, size);
      },
    },
  });
  reader.append(await source.read(0n, sourceSize));

  const chunks: Uint8Array[] = [];
  let size = 0;
  const writer = new McapWriter({
    writable: {
      position: () => BigInt(size),
      async write(bytes) {
        size += bytes.length;
        if (size > videoLimits.input) throw new Error('Saved recording would exceed 64 MiB.');
        chunks.push(bytes.slice());
      },
    },
  });
  const schemas = new Map([[0, 0]]);
  const channels = new Map<number, number>();
  let found = false;
  let inSummary = false;
  for (let record; (record = reader.nextRecord());) {
    if (record.type === 'Unknown') throw new Error('This recording contains unsupported records.');
    if (inSummary) continue;
    switch (record.type) {
      case 'Header':
        await writer.start(record);
        break;
      case 'Schema':
        if (!schemas.has(record.id)) schemas.set(record.id, await writer.registerSchema(record));
        break;
      case 'Channel': {
        if (channels.has(record.id)) break;
        const schemaId = schemas.get(record.schemaId);
        if (schemaId === undefined) throw new Error('Recording channel is missing a schema.');
        if (record.id === channelId) found = true;
        channels.set(
          record.id,
          await writer.registerChannel({
            ...record,
            schemaId,
            topic: record.id === channelId ? topic : record.topic,
          }),
        );
        break;
      }
      case 'Message': {
        const id = channels.get(record.channelId);
        if (id === undefined) throw new Error('Recording message is missing a channel.');
        await writer.addMessage({ ...record, channelId: id });
        break;
      }
      case 'Attachment':
        await writer.addAttachment(record);
        break;
      case 'Metadata':
        await writer.addMetadata(record);
        break;
      case 'DataEnd':
        inSummary = true;
        break;
    }
  }
  if (!reader.done() || !found) throw new Error('Recording or topic is unavailable.');
  await writer.end();
  const output = new Uint8Array(size);
  let offset = 0;
  for (const bytes of chunks) {
    output.set(bytes, offset);
    offset += bytes.length;
  }
  return output;
}
