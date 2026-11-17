import { McapIndexedReader, McapStreamReader } from '@mcap/core';
import type { FileHandle } from 'node:fs/promises';
import type { McapInfo } from '../shared/types.js';

function metadataPreview(values: ReadonlyMap<string, string>) {
  // Record bytes can be much larger than the useful tool/UI summary.
  return Object.fromEntries(
    [...values].slice(0, 32).map(([key, value]) => [key.slice(0, 256), value.slice(0, 2048)]),
  );
}

// All offsets stay bigint until a bounded, safe filesystem read is made.
export async function inspectMcap(handle: FileHandle, size: number): Promise<McapInfo> {
  let budget = 64 * 1024 * 1024;
  const readable = {
    size: async () => BigInt(size),
    read: async (offset: bigint, length: bigint) => {
      if (
        offset < 0n ||
        length < 0n ||
        offset + length > BigInt(size) ||
        length > 16n * 1024n * 1024n ||
        length > BigInt(budget)
      )
        throw new Error('MCAP metadata exceeds the inspection budget.');
      budget -= Number(length);
      const data = Buffer.alloc(Number(length));
      const { bytesRead } = await handle.read(data, 0, data.length, Number(offset));
      if (bytesRead !== data.length) throw new Error('MCAP ended unexpectedly.');
      return data;
    },
  };
  try {
    const reader = await McapIndexedReader.Initialize({ readable });
    if (!reader.statistics) throw new Error('No summary statistics.');
    const metadata: McapInfo['metadata'] = [];
    for await (const record of reader.readMetadata()) {
      if (metadata.length >= 100) break;
      metadata.push({ name: record.name.slice(0, 256), values: metadataPreview(record.metadata) });
    }
    return {
      profile: reader.header.profile,
      library: reader.header.library,
      indexed: true,
      startTime: String(reader.statistics.messageStartTime),
      endTime: String(reader.statistics.messageEndTime),
      messageCount: String(reader.statistics.messageCount),
      metadata,
      topics: [...reader.channelsById.values()].slice(0, 10000).map((c) => ({
        id: c.id,
        topic: c.topic.slice(0, 1024),
        encoding: c.messageEncoding.slice(0, 100),
        schema: (reader.schemasById.get(c.schemaId)?.name ?? '').slice(0, 512),
        count: String(reader.statistics!.channelMessageCounts.get(c.id) ?? 0n),
      })),
    };
  } catch (error) {
    if (size > 32 * 1024 * 1024)
      throw new Error(
        `Indexed metadata unavailable; unindexed recordings over 32 MiB are not scanned. ${error instanceof Error ? error.message : ''}`,
      );
    const reader = new McapStreamReader();
    const info: McapInfo = {
      profile: '',
      library: '',
      indexed: false,
      startTime: '0',
      endTime: '0',
      messageCount: '0',
      topics: [],
      metadata: [],
    };
    const schemas = new Map<number, string>();
    const channels = new Set<number>();
    let count = 0n,
      start: bigint | undefined,
      end = 0n;
    for (let offset = 0; offset < size; offset += 65536) {
      const buffer = Buffer.alloc(Math.min(65536, size - offset));
      await handle.read(buffer, 0, buffer.length, offset);
      reader.append(buffer);
      for (let r; (r = reader.nextRecord());) {
        if (r.type === 'Header') {
          info.profile = r.profile;
          info.library = r.library;
        }
        if (r.type === 'Schema') schemas.set(r.id, r.name.slice(0, 512));
        if (r.type === 'Channel' && !channels.has(r.id) && channels.size < 10000) {
          channels.add(r.id);
          info.topics.push({
            id: r.id,
            topic: r.topic.slice(0, 1024),
            encoding: r.messageEncoding.slice(0, 100),
            schema: schemas.get(r.schemaId) ?? '',
          });
        }
        if (r.type === 'Metadata' && info.metadata.length < 100)
          info.metadata.push({ name: r.name.slice(0, 256), values: metadataPreview(r.metadata) });
        if (r.type === 'Message') {
          count++;
          if (start === undefined || r.logTime < start) start = r.logTime;
          if (r.logTime > end) end = r.logTime;
        }
      }
    }
    if (!reader.done()) throw new Error('Incomplete or malformed MCAP recording.');
    info.startTime = String(start ?? 0n);
    info.endTime = String(end);
    info.messageCount = String(count);
    return info;
  }
}
