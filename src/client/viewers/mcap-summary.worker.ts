import { McapIndexedReader } from '@mcap/core';
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const data = new Uint8Array(event.data);
    let budget = 64 * 1024 * 1024;
    const reader = await McapIndexedReader.Initialize({
      readable: {
        size: async () => BigInt(data.length),
        read: async (offset, length) => {
          if (
            offset < 0n ||
            length < 0n ||
            offset + length > BigInt(data.length) ||
            length > 16n * 1024n * 1024n ||
            length > BigInt(budget)
          )
            throw new Error('MCAP summary read exceeds limits.');
          budget -= Number(length);
          return data.subarray(Number(offset), Number(offset + length));
        },
      },
    });
    const stats = reader.statistics;
    if (!stats) throw new Error('Native MCAP preview requires indexed summary statistics.');
    self.postMessage({
      info: {
        profile: reader.header.profile,
        library: reader.header.library,
        indexed: true,
        startTime: String(stats.messageStartTime),
        endTime: String(stats.messageEndTime),
        messageCount: String(stats.messageCount),
        metadata: [],
        topics: [...reader.channelsById.values()].slice(0, 10000).map((c) => ({
          id: c.id,
          topic: c.topic.slice(0, 1024),
          encoding: c.messageEncoding.slice(0, 100),
          schema: (reader.schemasById.get(c.schemaId)?.name ?? '').slice(0, 512),
          count: String(stats.channelMessageCounts.get(c.id) ?? 0n),
        })),
      },
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Cannot inspect MCAP.' });
  }
};
