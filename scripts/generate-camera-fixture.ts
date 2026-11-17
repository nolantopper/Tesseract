import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import { create, createFileRegistry, toBinary } from '@bufbuild/protobuf';
import {
  FieldDescriptorProto_Type as FieldType,
  FileDescriptorSetSchema,
  TimestampSchema,
} from '@bufbuild/protobuf/wkt';
import { McapWriter } from '@mcap/core';
import { annexBNals } from '../src/shared/mcap-video.js';

const ffmpeg = process.env.TESSERACT_FFMPEG ?? 'ffmpeg';
const startCode = Buffer.from([0, 0, 0, 1]);
const frameCount = 20;

function encodeFrames(color: string): Buffer[] {
  const video = execFileSync(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=64x48:r=10`,
    '-frames:v',
    String(frameCount),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'baseline',
    '-g',
    '5',
    '-bf',
    '0',
    '-threads',
    '1',
    '-x264-params',
    'aud=1:repeat-headers=1',
    '-f',
    'h264',
    'pipe:1',
  ]);
  const frames: Buffer[][] = [];
  for (const nal of annexBNals(video)) {
    if ((nal[0] & 31) === 9) frames.push([]);
    const accessUnit = frames.at(-1);
    assert.ok(accessUnit, 'Each access unit must begin with a delimiter.');
    accessUnit.push(startCode, Buffer.from(nal));
  }
  assert.equal(frames.length, frameCount);
  return frames.map((parts) => Buffer.concat(parts));
}

const descriptor = create(FileDescriptorSetSchema, {
  file: [
    TimestampSchema.file.proto,
    {
      name: 'camera-fixture.proto',
      package: 'foxglove',
      syntax: 'proto3',
      dependency: [TimestampSchema.file.proto.name],
      messageType: [
        {
          name: 'CompressedVideo',
          field: [
            {
              name: 'timestamp',
              number: 1,
              type: FieldType.MESSAGE,
              typeName: '.google.protobuf.Timestamp',
            },
            { name: 'data', number: 3, type: FieldType.BYTES },
            { name: 'format', number: 4, type: FieldType.STRING },
          ],
        },
      ],
    },
  ],
});
const schemaName = 'foxglove.CompressedVideo';
const videoType = createFileRegistry(descriptor).getMessage(schemaName);
assert.ok(videoType);

const buffers: Uint8Array[] = [];
let offset = 0n;
const writer = new McapWriter({
  writable: {
    position: () => offset,
    write: async (bytes) => {
      buffers.push(bytes.slice());
      offset += BigInt(bytes.length);
    },
  },
  compressChunk: (bytes) => ({ compression: 'zstd', compressedData: zstdCompressSync(bytes) }),
});
await writer.start({ profile: '', library: 'tesseract camera fixture' });
const schemaId = await writer.registerSchema({
  name: schemaName,
  encoding: 'protobuf',
  data: toBinary(FileDescriptorSetSchema, descriptor),
});
const cameras = [];
for (const [topic, color] of [
  ['/camera/front', 'red'],
  ['/camera/side', 'blue'],
]) {
  const channelId = await writer.registerChannel({
    topic,
    schemaId,
    messageEncoding: 'protobuf',
    metadata: new Map(),
  });
  cameras.push({ channelId, frames: encodeFrames(color) });
}
for (let sequence = 0; sequence < frameCount; sequence++) {
  const seconds = 42n + BigInt(Math.floor(sequence / 10));
  const nanos = (sequence % 10) * 100_000_000;
  const time = seconds * 1_000_000_000n + BigInt(nanos);
  for (const { channelId, frames } of cameras) {
    const message = create(videoType, {
      timestamp: { seconds, nanos },
      format: 'h264',
      data: frames[sequence],
    });
    await writer.addMessage({
      channelId,
      sequence,
      logTime: time,
      publishTime: time,
      data: toBinary(videoType, message),
    });
  }
}
await writer.end();
await writeFile(new URL('../test/fixtures/cameras.mcap', import.meta.url), Buffer.concat(buffers));
