import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { McapIndexedReader, McapWriter } from '@mcap/core';
import { create, createFileRegistry, fromBinary, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import {
  annexBNals,
  decompressVideoChunk,
  frameAt,
  h264Configuration,
  keyframeAt,
  videoLimits,
  videoRecording,
} from '../src/shared/mcap-video.js';
const path = 'samples/external/dreamtac-cut-banana-episode-017.mcap';
const synthetic = 'test/fixtures/cameras.mcap';
const real = { skip: !existsSync(path) };
test('synthetic zstd recording has two cameras with exact frame timestamps and keyframes', async () => {
  const recording = await videoRecording(await readFile(synthetic));
  assert.deepEqual(
    recording.cameras.map((camera) => camera.topic),
    ['/camera/front', '/camera/side'],
  );
  for (const camera of recording.cameras) {
    const { width, height, samples } = await recording.stream(camera.id);
    assert.deepEqual([width, height, samples.length], [64, 48, 20]);
    assert.deepEqual(
      samples.flatMap((sample, index) => (sample.key ? [index] : [])),
      [0, 5, 10, 15],
    );
    for (const [index, sample] of samples.entries()) {
      assert.equal(sample.timestampNs, String(42000000000n + BigInt(index) * 100000000n));
      assert.equal(sample.captureTimestampNs, sample.timestampNs);
    }
    const index = frameAt(samples, 42750000000n);
    assert.equal(index, 7);
    assert.equal(keyframeAt(samples, index), 5);
  }
});
test(
  'real DreamTac zstd/protobuf video extracts four cameras with exact timestamps and IDRs',
  real,
  async () => {
    const data = await readFile(path);
    assert.equal(
      createHash('sha256').update(data).digest('hex'),
      'b729b213520bed88e6a65d4239db43821dd1445de2bc324ea6ebe569e52fbc7c',
    );
    const r = await videoRecording(data);
    assert.deepEqual(
      r.cameras.map((c) => c.topic),
      ['/camera', '/wrist-camera', '/tactile-left', '/tactile-right'],
    );
    for (const camera of r.cameras) {
      const stream = await r.stream(camera.id);
      assert.equal(stream.samples.length, 162);
      assert.equal(stream.codec, 'avc1.4d400c');
      assert.equal(stream.width, 224);
      assert.equal(stream.height, 224);
      assert.deepEqual(
        stream.samples.flatMap((s, i) => (s.key ? [i] : [])),
        [0, 30, 60, 90, 120, 150],
      );
      for (const [i, s] of stream.samples.entries()) {
        assert.equal(s.timestampNs, String(1000000000000000000n + BigInt(i) * 50000000n));
        assert.equal(s.captureTimestampNs, s.timestampNs);
      }
      assert.equal(frameAt(stream.samples, 1000000004325000000n), 86);
      assert.equal(keyframeAt(stream.samples, 86), 60);
      assert.equal(keyframeAt(stream.samples, 2), 0);
      assert.ok(annexBNals(stream.samples[60].data).some((n) => (n[0] & 31) === 5));
    }
  },
);
test('Zstandard rejects expanded allocation bombs, mismatched sizes and truncated frames', () => {
  assert.throws(
    () => decompressVideoChunk(new Uint8Array(0), BigInt(videoLimits.chunk + 1)),
    /exceeds/,
  );
  // Single-segment raw frame: content size 3, last raw block with "abc".
  const frame = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 25, 0, 0, 97, 98, 99]);
  assert.equal(new TextDecoder().decode(decompressVideoChunk(frame, 3n)), 'abc');
  assert.throws(() => decompressVideoChunk(frame, 4n), /content size/);
  assert.throws(() => decompressVideoChunk(frame.subarray(0, 10), 3n), /Truncated/);
  const hugeWindow = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0xff]);
  assert.throws(() => decompressVideoChunk(hugeWindow, 3n), /window/);
  assert.throws(() => h264Configuration(Uint8Array.from([0x67, 77, 64, 12, 0])), /SPS/);
  assert.throws(() => annexBNals(Uint8Array.from([1, 2, 3, 4])), /Annex-B/);
});
test('schema-aware video decoding reports unsupported codecs instead of displaying arbitrary payloads', async () => {
  const bytes = await readFile(synthetic);
  const source = await McapIndexedReader.Initialize({
    readable: {
      size: async () => BigInt(bytes.length),
      read: async (o, n) => bytes.subarray(Number(o), Number(o + n)),
    },
  });
  const schema = [...source.schemasById.values()].find(
    (candidate) => candidate.name === 'foxglove.CompressedVideo',
  );
  assert.ok(schema);
  const type = createFileRegistry(fromBinary(FileDescriptorSetSchema, schema.data)).getMessage(
    schema.name,
  )!;
  const chunks: Uint8Array[] = [];
  let offset = 0n;
  const writer = new McapWriter({
    writable: {
      position: () => offset,
      write: async (data) => {
        chunks.push(data.slice());
        offset += BigInt(data.length);
      },
    },
  });
  await writer.start({ profile: '', library: 'codec-rejection-test' });
  const schemaId = await writer.registerSchema(schema);
  const channelId = await writer.registerChannel({
    topic: '/camera',
    messageEncoding: 'protobuf',
    schemaId,
    metadata: new Map(),
  });
  await writer.addMessage({
    channelId,
    sequence: 0,
    logTime: 1n,
    publishTime: 1n,
    data: toBinary(type, create(type, { format: 'h265', data: Uint8Array.from([0, 0, 1, 1]) })),
  });
  await writer.end();
  const recording = await videoRecording(Buffer.concat(chunks));
  await assert.rejects(recording.stream(channelId), /codec h265 is unsupported/);
});
