import { McapIndexedReader, type IReadable, type Schema } from '@mcap/core';
import { createFileRegistry, fromBinary, toJson } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { decompressVideoChunk, videoLimits } from './mcap-video.js';
import type { ViewSample } from './view.js';

type TimeRange = {
  startNs: string;
  endNs: string;
};
export type McapPlot = TimeRange & { channelId: number };
export type McapSample = McapPlot & { limit: number; reverse?: boolean };
export type McapPlotPoint = { timestampNs: string; value: number };
export type McapPlotSeries = { field: string; points: McapPlotPoint[] };

export type McapRecordingRequest =
  | { kind: 'sample'; query: McapSample }
  | { kind: 'plot'; query: McapPlot }
  | { kind: 'rename'; channelId: number; topic: string };

const poseSchema = 'foxglove.PoseInFrame';

export function supportsPlot(encoding: string, schema?: string) {
  return encoding === 'json' || (encoding === 'protobuf' && schema === poseSchema);
}

function protobufDescriptor(schema: Schema | undefined) {
  if (schema?.encoding !== 'protobuf' || schema.data.length > 1024 * 1024) return undefined;
  return createFileRegistry(fromBinary(FileDescriptorSetSchema, schema.data)).getMessage(
    schema.name,
  );
}

function poseFields(message: unknown): [string, unknown][] {
  const { pose } = message as {
    pose?: {
      position?: { x: number; y: number; z: number };
      orientation?: { x: number; y: number; z: number; w: number };
    };
  };
  return [
    ['position.x', pose?.position?.x],
    ['position.y', pose?.position?.y],
    ['position.z', pose?.position?.z],
    ['orientation.x', pose?.orientation?.x],
    ['orientation.y', pose?.orientation?.y],
    ['orientation.z', pose?.orientation?.z],
    ['orientation.w', pose?.orientation?.w],
  ];
}

async function indexedRecording(source: IReadable, range: TimeRange) {
  const fileSize = await source.size();
  let remaining = videoLimits.input;
  let expanded = 0;
  const reader = await McapIndexedReader.Initialize({
    readable: {
      size: async () => fileSize,
      read: async (offset, length) => {
        if (
          offset < 0n ||
          length < 0n ||
          offset + length > fileSize ||
          length > BigInt(videoLimits.chunk) ||
          length > BigInt(remaining)
        )
          throw new Error('Read limit reached. Try a shorter range.');
        remaining -= Number(length);
        return source.read(offset, length);
      },
    },
    decompressHandlers: {
      zstd: (data, size) => {
        expanded += Number(size);
        if (expanded > videoLimits.expanded)
          throw new Error('Decompression limit reached. Try a shorter range.');
        return decompressVideoChunk(data, size);
      },
    },
  });
  const startingAt = BigInt(range.startNs);
  const endingAt = BigInt(range.endNs);
  const stats = reader.statistics;
  if (
    !stats ||
    startingAt < stats.messageStartTime ||
    endingAt > stats.messageEndTime ||
    startingAt > endingAt
  )
    throw new Error('Range must be inside an indexed recording.');
  return { reader, startingAt, endingAt };
}

async function recordingChannel(source: IReadable, query: McapPlot, reverse = false) {
  const { reader, startingAt, endingAt } = await indexedRecording(source, query);
  const channel = reader.channelsById.get(query.channelId);
  if (!channel) throw new Error('Topic channel is unavailable.');
  const schema = reader.schemasById.get(channel.schemaId);
  const messages = reader.readMessages({
    startingAt,
    endingAt,
    topics: [channel.topic],
    validateCrcs: true,
    reverse,
  });
  return { channel, schema, messages };
}

export async function sampleMcap(source: IReadable, sample: McapSample): Promise<ViewSample[]> {
  if (!Number.isInteger(sample.limit) || sample.limit < 1 || sample.limit > 20)
    throw new Error('Sample count must be between 1 and 20.');
  const { channel, schema, messages } = await recordingChannel(source, sample, sample.reverse);
  const protobuf = channel.messageEncoding === 'protobuf' ? protobufDescriptor(schema) : undefined;
  const decoder = new TextDecoder();
  const results: ViewSample[] = [];
  for await (const message of messages) {
    if (message.channelId !== channel.id) continue;
    const { data } = message;
    let value = `${channel.messageEncoding || 'Binary'} message · ${data.length} bytes`;
    if (data.length <= 64 * 1024) {
      try {
        if (channel.messageEncoding === 'json')
          value = JSON.stringify(JSON.parse(decoder.decode(data)));
        else if (protobuf) {
          const parsed = fromBinary(protobuf, data);
          if (protobuf.typeName === 'foxglove.CompressedVideo') {
            const video = parsed as unknown as { format: string; data: Uint8Array };
            value = JSON.stringify({ codec: video.format, encodedBytes: video.data.length });
          } else {
            value = JSON.stringify(toJson(protobuf, parsed, { useProtoFieldName: true }));
          }
        } else if (['utf8', 'utf-8', 'text'].includes(channel.messageEncoding)) {
          value = decoder.decode(data);
        }
      } catch {
        value += ' · decode failed';
      }
    }
    results.push({
      timestampNs: String(message.logTime),
      channelId: message.channelId,
      value: value.length > 2000 ? value.slice(0, 1999) + '…' : value,
    });
    if (results.length >= sample.limit) break;
  }
  return results;
}

export async function plotMcap(source: IReadable, plot: McapPlot): Promise<McapPlotSeries[]> {
  const { channel, schema, messages } = await recordingChannel(source, plot);
  if (!supportsPlot(channel.messageEncoding, schema?.name)) return [];
  const pose = channel.messageEncoding === 'protobuf' ? protobufDescriptor(schema) : undefined;
  if (channel.messageEncoding === 'protobuf' && !pose) return [];
  const decoder = new TextDecoder();
  const series = new Map<string, McapPlotPoint[]>();
  let count = 0;

  for await (const message of messages) {
    if (message.channelId !== channel.id) continue;
    if (++count > 5000)
      throw new Error('This topic has over 5,000 samples. Choose a shorter range.');
    if (message.data.length > 64 * 1024) continue;
    let fields: [string, unknown][];
    try {
      if (pose) fields = poseFields(fromBinary(pose, message.data));
      else {
        const data: unknown = JSON.parse(decoder.decode(message.data));
        fields =
          data && typeof data === 'object' && !Array.isArray(data)
            ? Object.entries(data)
            : [['value', data]];
      }
    } catch {
      continue;
    }
    for (const [field, value] of fields) {
      if (typeof value !== 'number' || !Number.isFinite(value) || !field || field.length > 120)
        continue;
      let points = series.get(field);
      if (!points) {
        if (series.size >= 12) continue;
        series.set(field, (points = []));
      }
      points.push({ timestampNs: String(message.logTime), value });
    }
  }
  return Array.from(series, ([field, points]) => ({ field, points }));
}
