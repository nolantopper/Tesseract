import { McapIndexedReader } from '@mcap/core';
import { createFileRegistry, fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { Decompress } from 'fzstd';

export const videoLimits = {
  input: 64 * 1024 * 1024,
  chunk: 32 * 1024 * 1024,
  expanded: 128 * 1024 * 1024,
  encoded: 32 * 1024 * 1024,
  frames: 10000,
  pixels: 1920 * 1080,
  gop: 600,
};
export interface Camera {
  id: number;
  topic: string;
}
export interface VideoSample {
  timestampNs: string;
  captureTimestampNs?: string;
  key: boolean;
  data: Uint8Array;
}
export interface CameraStream {
  camera: Camera;
  codec: string;
  width: number;
  height: number;
  samples: VideoSample[];
}

// Validate the frame envelope before fzstd allocates its sliding window.
// A chunk may hold one dictionary-free Zstandard frame, bounded to 32 MiB.
export function decompressVideoChunk(data: Uint8Array, expected: bigint): Uint8Array {
  if (expected < 0n || expected > BigInt(videoLimits.chunk))
    throw new Error('MCAP expanded chunk exceeds 32 MiB.');
  if (
    data.length < 6 ||
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) !== 0xfd2fb528
  )
    throw new Error('Invalid Zstandard frame.');
  const flag = data[4],
    single = (flag >> 5) & 1,
    fcsFlag = flag >> 6;
  if (flag & 0x18) throw new Error('Unsupported Zstandard frame flags.');
  let offset = single ? 5 : 6;
  const window = single ? Number(expected) : 2 ** (10 + (data[5] >> 3)) * (1 + (data[5] & 7) / 8);
  if (window > videoLimits.chunk) throw new Error('Zstandard window exceeds 32 MiB.');
  const uint = (length: number) => {
    if (offset + length > data.length) throw new Error('Truncated Zstandard header.');
    let value = 0n;
    for (let i = 0; i < length; i++) value |= BigInt(data[offset++]) << BigInt(i * 8);
    return value;
  };
  if (uint([0, 1, 2, 4][flag & 3]) !== 0n)
    throw new Error('Zstandard dictionaries are unsupported.');
  const fcsBytes = fcsFlag ? 1 << fcsFlag : single;
  if (fcsBytes && uint(fcsBytes) + (fcsFlag === 1 ? 256n : 0n) !== expected)
    throw new Error('Zstandard content size differs from MCAP chunk size.');
  let last = false;
  while (!last) {
    const block = Number(uint(3));
    last = !!(block & 1);
    const type = (block >> 1) & 3,
      length = block >>> 3;
    if (type === 3 || length > 131072) throw new Error('Invalid Zstandard block.');
    offset += type === 1 ? 1 : length;
    if (offset > data.length) throw new Error('Truncated Zstandard block.');
  }
  if (flag & 4) offset += 4;
  if (offset !== data.length)
    throw new Error('Concatenated or truncated Zstandard frames are unsupported.');
  const output = new Uint8Array(Number(expected));
  let written = 0;
  const decoder = new Decompress((chunk) => {
    if (written + chunk.length > output.length)
      throw new Error('Zstandard output exceeds its declared size.');
    output.set(chunk, written);
    written += chunk.length;
  });
  decoder.push(data, true);
  if (written !== output.length) throw new Error('Incomplete Zstandard output.');
  return output;
}

export function annexBNals(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; prefix: number }[] = [];
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      const prefix = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
      if (prefix) {
        starts.push({ at: i, prefix });
        i += prefix - 1;
      }
    }
  }
  if (!starts.length || starts[0].at !== 0) throw new Error('H.264 must use Annex-B access units.');
  return starts.map((s, i) => data.subarray(s.at + s.prefix, starts[i + 1]?.at ?? data.length));
}

export function h264Configuration(sps: Uint8Array) {
  if (sps.length < 5 || (sps[0] & 31) !== 7)
    throw new Error('Missing H.264 sequence parameter set.');
  const rbsp = Array.from(sps.subarray(1)).filter(
    (_, i, a) => !(i >= 2 && a[i] === 3 && a[i - 1] === 0 && a[i - 2] === 0),
  );
  let bit = 0;
  const bits = (n: number) => {
    if (bit + n > rbsp.length * 8) throw new Error('Truncated H.264 SPS.');
    let v = 0;
    while (n--) {
      v = v * 2 + ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const ue = () => {
    let n = 0;
    while (!bits(1)) if (++n > 24) throw new Error('Invalid H.264 SPS integer.');
    return 2 ** n - 1 + bits(n);
  };
  const se = () => {
    const v = ue();
    return v & 1 ? (v + 1) / 2 : -v / 2;
  };
  const profile = bits(8);
  bits(16);
  ue();
  let chroma = 1,
    separate = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue();
    if (chroma > 3) throw new Error('Invalid H.264 chroma format.');
    if (chroma === 3) separate = bits(1);
    ue();
    ue();
    bits(1);
    if (bits(1))
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++)
        if (bits(1)) {
          let last = 8,
            next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next) next = (last + se() + 256) % 256;
            last = next || last;
          }
        }
  }
  ue();
  const order = ue();
  if (order === 0) ue();
  else if (order === 1) {
    bits(1);
    se();
    se();
    const n = ue();
    if (n > 256) throw new Error('Invalid H.264 picture order.');
    for (let i = 0; i < n; i++) se();
  } else if (order !== 2) throw new Error('Invalid H.264 picture order.');
  ue();
  bits(1);
  const w = ue() + 1,
    h = ue() + 1,
    frame = bits(1);
  if (!frame) bits(1);
  bits(1);
  let left = 0,
    right = 0,
    top = 0,
    bottom = 0;
  if (bits(1)) {
    left = ue();
    right = ue();
    top = ue();
    bottom = ue();
  }
  const arrayType = separate ? 0 : chroma,
    cropX = arrayType === 1 || arrayType === 2 ? 2 : 1;
  const cropY = (arrayType === 1 ? 2 : 1) * (2 - frame);
  const width = w * 16 - (left + right) * cropX,
    height = h * 16 * (2 - frame) - (top + bottom) * cropY;
  if (
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    width * height > videoLimits.pixels
  )
    throw new Error('H.264 frame exceeds the 1080p pixel budget.');
  return {
    codec: `avc1.${[sps[1], sps[2], sps[3]].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
    width,
    height,
  };
}

export async function videoRecording(data: Uint8Array) {
  if (data.length > videoLimits.input) throw new Error('MCAP video input limit is 64 MiB.');
  let expanded = 0;
  const reader = await McapIndexedReader.Initialize({
    readable: {
      size: async () => BigInt(data.length),
      read: async (o, n) => {
        if (o < 0n || n < 0n || o + n > BigInt(data.length) || n > BigInt(videoLimits.chunk))
          throw new Error('MCAP video read exceeds limits.');
        return data.subarray(Number(o), Number(o + n));
      },
    },
    decompressHandlers: {
      zstd: (bytes, size) => {
        expanded += Number(size);
        if (expanded > videoLimits.expanded) throw new Error('MCAP expansion budget exceeded.');
        return decompressVideoChunk(bytes, size);
      },
    },
  });
  if (
    !reader.statistics ||
    reader.statistics.messageEndTime - reader.statistics.messageStartTime > 21600000000000n
  )
    throw new Error(
      'Video preview requires indexed statistics and a recording no longer than six hours.',
    );
  const cameras: Camera[] = [];
  for (const c of reader.channelsById.values())
    if (
      c.messageEncoding === 'protobuf' &&
      reader.schemasById.get(c.schemaId)?.name === 'foxglove.CompressedVideo'
    )
      cameras.push({ id: c.id, topic: c.topic });
  if (cameras.length > 64) throw new Error('MCAP camera count exceeds 64.');
  return {
    cameras,
    async stream(id: number): Promise<CameraStream> {
      expanded = 0;
      const camera = cameras.find((c) => c.id === id);
      if (!camera) throw new Error('Unknown MCAP camera channel.');
      for (const c of reader.chunkIndexes) {
        if (c.uncompressedSize > BigInt(videoLimits.chunk))
          throw new Error('MCAP expanded chunk exceeds 32 MiB.');
        if (c.compression && c.compression !== 'zstd')
          throw new Error(
            `MCAP video chunk compression ${c.compression} is unsupported; use uncompressed or Zstandard chunks.`,
          );
      }
      const channel = reader.channelsById.get(id)!,
        schema = reader.schemasById.get(channel.schemaId)!;
      if (schema.encoding !== 'protobuf' || schema.data.length > 1024 * 1024)
        throw new Error('A bounded protobuf FileDescriptorSet is required for video.');
      const registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, schema.data));
      const type = registry.getMessage(schema.name);
      if (!type) throw new Error('Video schema is absent from its FileDescriptorSet.');
      const samples: VideoSample[] = [];
      let total = 0,
        sps: Uint8Array | undefined,
        pps: Uint8Array | undefined;
      let config: ReturnType<typeof h264Configuration> | undefined,
        sinceKey = 0;
      for await (const message of reader.readMessages({
        topics: [camera.topic],
        validateCrcs: true,
      })) {
        if (message.channelId !== id) continue;
        if (
          message.logTime < reader.statistics!.messageStartTime ||
          message.logTime > reader.statistics!.messageEndTime
        )
          throw new Error('Video frame timestamp is outside the recording.');
        if (message.data.length > 4 * 1024 * 1024)
          throw new Error('Video access unit exceeds 4 MiB.');
        const value = fromBinary(type, message.data) as unknown as {
          format: string;
          data: Uint8Array;
          timestamp?: { seconds: bigint; nanos: number };
        };
        if (value.format !== 'h264')
          throw new Error(
            `Video codec ${value.format || '(missing)'} is unsupported. This viewer supports H.264 Annex-B.`,
          );
        if (!(value.data instanceof Uint8Array) || !value.data.length)
          throw new Error('Video message has no frame bytes.');
        const nals = annexBNals(value.data);
        let key = false;
        for (const nal of nals) {
          const kind = nal[0] & 31;
          if (kind === 7) sps = nal.slice();
          if (kind === 8) pps = nal.slice();
          if (kind === 5) key = true;
        }
        if (!sps || !pps) throw new Error('H.264 playback requires SPS and PPS parameter sets.');
        const next = h264Configuration(sps);
        if (config && JSON.stringify(config) !== JSON.stringify(next))
          throw new Error('H.264 configuration changes within a camera stream are unsupported.');
        config = next;
        if (key) sinceKey = 0;
        else if (!samples.length || ++sinceKey > videoLimits.gop)
          throw new Error(
            'H.264 requires an initial keyframe and a keyframe at least every 600 frames.',
          );
        let bytes = value.data.slice();
        if (key && (!nals.some((n) => (n[0] & 31) === 7) || !nals.some((n) => (n[0] & 31) === 8))) {
          bytes = new Uint8Array(8 + sps.length + pps.length + value.data.length);
          bytes.set([0, 0, 0, 1]);
          bytes.set(sps, 4);
          bytes.set([0, 0, 0, 1], 4 + sps.length);
          bytes.set(pps, 8 + sps.length);
          bytes.set(value.data, 8 + sps.length + pps.length);
        }
        total += bytes.length;
        if (total > videoLimits.encoded || samples.length >= videoLimits.frames)
          throw new Error('Camera preview exceeds 32 MiB or 10,000 frames.');
        const timestampNs = String(message.logTime),
          captureTimestampNs = value.timestamp
            ? String(value.timestamp.seconds * 1000000000n + BigInt(value.timestamp.nanos))
            : undefined;
        samples.push({ timestampNs, captureTimestampNs, key, data: bytes });
      }
      if (!samples.length || !config) throw new Error('Camera has no video frames.');
      return { camera, ...config, samples };
    },
  };
}

export function frameAt(samples: VideoSample[], timeNs: bigint): number {
  let lo = 0,
    hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (BigInt(samples[mid].timestampNs) <= timeNs) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}
export function keyframeAt(samples: VideoSample[], index: number): number {
  while (index > 0 && !samples[index].key) index--;
  return index;
}
