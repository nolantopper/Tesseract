import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { McapIndexedReader } from '@mcap/core';
import { renameMcapTopic } from '../src/shared/mcap-edits.js';

const source = (bytes: Uint8Array) => ({
  size: async () => BigInt(bytes.length),
  read: async (offset: bigint, length: bigint) =>
    bytes.subarray(Number(offset), Number(offset + length)),
});

test('MCAP topic rename preserves recording payloads and metadata', async () => {
  const original = source(await readFile(new URL('../samples/robot.mcap', import.meta.url)));
  const before = await McapIndexedReader.Initialize({ readable: original });
  const first = [...before.channelsById.values()][0];
  const result = await renameMcapTopic(original, first.id, '/joint_renamed');
  const after = await McapIndexedReader.Initialize({ readable: source(result) });
  const collect = async (reader: McapIndexedReader) => {
    const messages = [];
    for await (const { channelId, ...message } of reader.readMessages({ validateCrcs: true }))
      messages.push({ ...message, topic: reader.channelsById.get(channelId)?.topic });
    return messages;
  };
  assert.deepEqual(
    await collect(after),
    (await collect(before)).map((message) =>
      message.topic === first.topic ? { ...message, topic: '/joint_renamed' } : message,
    ),
  );
  assert.deepEqual(
    await Array.fromAsync(after.readMetadata()),
    await Array.fromAsync(before.readMetadata()),
  );
  assert.equal(after.header.profile, before.header.profile);
});
