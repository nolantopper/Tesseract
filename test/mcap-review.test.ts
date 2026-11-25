import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { McapIndexedReader, McapWriter } from '@mcap/core';
import { updateMcapView } from '../src/client/viewers/mcap-review.js';
import { plotMcap, sampleMcap } from '../src/shared/mcap-recording.js';
import { decompressVideoChunk, videoLimits, videoRecording } from '../src/shared/mcap-video.js';
import type { McapInfo } from '../src/shared/types.js';

const cameras = 'test/fixtures/cameras.mcap';

function source(bytes: Uint8Array) {
  return {
    size: async () => BigInt(bytes.length),
    read: async (offset: bigint, length: bigint) =>
      bytes.subarray(Number(offset), Number(offset + length)),
  };
}
test('review commands validate a complete update and keep nanosecond offsets exact', () => {
  const startTime = '1000000000000000001';
  const info: McapInfo = {
    startTime,
    endTime: '1000000010000000001',
    topics: [
      { id: 1, topic: '/camera', schema: 'foxglove.CompressedVideo', encoding: 'protobuf' },
      { id: 2, topic: '/topic', schema: 'robot.State', encoding: 'json' },
    ],
    indexed: true,
    profile: '',
    library: '',
    messageCount: '10',
    metadata: [],
  };
  const current = { timestampNs: startTime, cameraChannelId: 1 };
  const startNs = '1000000002000000003';
  const endNs = '1000000003000000002';
  const action = { kind: 'mcap_view' as const, range: { startNs, endNs }, channelIds: [2] };
  assert.deepEqual(updateMcapView(current, action, info), {
    ...current,
    timestampNs: startNs,
    channelIds: [2],
    range: { startNs, endNs },
  });
  assert.throws(
    () => updateMcapView(current, { ...action, timestampNs: startTime }, info),
    /outside/,
  );
  assert.throws(
    () => updateMcapView(current, { ...action, cameraChannelId: 2 }, info),
    /unavailable/,
  );
  assert.deepEqual(current, { timestampNs: startTime, cameraChannelId: 1 });
});

test('MCAP topic sampling returns bounded decoded messages with exact timestamps', async () => {
  const input = source(await readFile(cameras));
  const reader = await McapIndexedReader.Initialize({ readable: input });
  const channel = [...reader.channelsById.values()].find((item) => item.topic === '/camera/side')!;
  const range = { startNs: '42500000000', endNs: '42700000000' };
  const samples = await sampleMcap(input, { ...range, channelId: channel.id, limit: 2 });
  assert.deepEqual(
    samples.map((item) => item.timestampNs),
    ['42500000000', '42600000000'],
  );
  assert.equal(JSON.parse(samples[0].value).codec, 'h264');
  assert.equal(samples[0].channelId, channel.id);
  await assert.rejects(sampleMcap(input, { ...range, channelId: channel.id, limit: 21 }), /20/);
  const telemetry = await sampleMcap(source(await readFile('samples/robot.mcap')), {
    channelId: 0,
    startNs: '1730000000000000000',
    endNs: '1730000000100000000',
    limit: 1,
  });
  assert.deepEqual(
    telemetry.map((message) => message.timestampNs),
    ['1730000000000000000'],
  );
  assert.ok(JSON.parse(telemetry[0].value));
});

test('MCAP plots retain numeric readings with their original log times', async () => {
  const input = source(await readFile('samples/robot.mcap'));
  const { statistics } = await McapIndexedReader.Initialize({ readable: input });
  const query = {
    channelId: 1,
    startNs: String(statistics!.messageStartTime),
    endNs: String(statistics!.messageEndTime),
  };
  const series = await plotMcap(input, query);
  const [first] = await sampleMcap(input, { ...query, limit: 1 });
  const expected = JSON.parse(first.value);
  assert.ok(series.length);
  for (const { field, points } of series) {
    assert.equal(typeof expected[field], 'number');
    assert.deepEqual(points[0], { timestampNs: first.timestampNs, value: expected[field] });
    assert.ok(points.length > 1);
  }
  assert.deepEqual(
    await plotMcap(source(await readFile(cameras)), {
      channelId: 0,
      startNs: '42000000000',
      endNs: '43900000000',
    }),
    [],
  );
});

test('indexed video reads a bounded window without reading a large attachment', async () => {
  const readable = source(await readFile(cameras));
  const original = await McapIndexedReader.Initialize({
    readable,
    decompressHandlers: { zstd: decompressVideoChunk },
  });
  let offset = 0n;
  const spans: { start: bigint; data: Uint8Array }[] = [];
  const writer = new McapWriter({
    writable: {
      position: () => offset,
      async write(data) {
        if (data.length < videoLimits.input) spans.push({ start: offset, data: data.slice() });
        offset += BigInt(data.length);
      },
    },
  });
  await writer.start({ profile: original.header.profile, library: 'Tesseract range test' });
  await writer.addAttachment({
    name: 'large',
    mediaType: 'application/octet-stream',
    data: new Uint8Array(videoLimits.input + 1),
    logTime: 0n,
    createTime: 0n,
  });
  const schemas = new Map<number, number>();
  const channels = new Map<number, number>();
  for (const schema of original.schemasById.values()) {
    schemas.set(schema.id, await writer.registerSchema(schema));
  }
  for (const channel of original.channelsById.values()) {
    const schemaId = schemas.get(channel.schemaId)!;
    channels.set(channel.id, await writer.registerChannel({ ...channel, schemaId }));
  }
  for await (const message of original.readMessages()) {
    await writer.addMessage({ ...message, channelId: channels.get(message.channelId)! });
  }
  await writer.end();
  assert.ok(offset > BigInt(videoLimits.input));
  let transferred = 0n;
  const indexed = await videoRecording({
    size: async () => offset,
    read: async (start, count) => {
      transferred += count;
      const bytes = new Uint8Array(Number(count));
      for (const span of spans) {
        const low = start > span.start ? start : span.start;
        const high =
          start + count < span.start + BigInt(span.data.length)
            ? start + count
            : span.start + BigInt(span.data.length);
        if (high > low)
          bytes.set(
            span.data.subarray(Number(low - span.start), Number(high - span.start)),
            Number(low - start),
          );
      }
      return bytes;
    },
  });
  const stream = await indexed.stream(indexed.cameras[1].id, {
    start: 42500000000n,
    end: 42700000000n,
  });
  assert.equal(stream.samples.at(-1)?.timestampNs, '42700000000');
  assert.ok(transferred < 1024n * 1024n);
});
