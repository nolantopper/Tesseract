import { z } from 'zod';

const viewerKind = z.enum([
  'model',
  'image',
  'video',
  'audio',
  'text',
  'mcap',
  'unknown',
  'container',
]);
const format = z.object({
  id: z.string(),
  label: z.string(),
  extensions: z.array(z.string()),
  mime: z.string(),
  kind: viewerKind,
});
const topic = z.object({
  id: z.number(),
  topic: z.string(),
  encoding: z.string(),
  schema: z.string(),
  count: z.string().optional(),
});
const mcapInfo = z.object({
  profile: z.string(),
  library: z.string(),
  indexed: z.boolean(),
  startTime: z.string(),
  endTime: z.string(),
  messageCount: z.string(),
  topics: z.array(topic),
  metadata: z.array(z.object({ name: z.string(), values: z.record(z.string(), z.string()) })),
});
const artifact = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  size: z.number(),
  modified: z.number(),
  revision: z.string(),
  entries: z
    .array(z.object({ name: z.string(), path: z.string(), directory: z.boolean() }))
    .optional(),
  depth: z.number().optional(),
  format,
  mcap: mcapInfo.optional(),
  warning: z.string().optional(),
});

export const artifactResponse = z.object({ artifact });
export type ViewerKind = z.infer<typeof viewerKind>;
export type Format = z.infer<typeof format>;
export type Topic = z.infer<typeof topic>;
export type McapInfo = z.infer<typeof mcapInfo>;
export type Artifact = z.infer<typeof artifact>;
export type Selection = {
  artifactId: string;
  revision: string;
  path: string;
  kind: 'object' | 'time';
  objectId?: string;
  objectName?: string;
  coordinates?: [number, number, number];
  timestampNs?: string;
  channelId?: number;
};
export interface ViewerProps {
  artifact: Artifact;
  onSelect: (selection: Selection) => void;
}
