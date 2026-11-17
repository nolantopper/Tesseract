import { z } from 'zod';
export const idSchema = z.object({ artifactId: z.string().uuid() });
export const selectionSchema = z.object({
  artifactId: z.string().uuid(),
  revision: z.string().max(200),
  path: z.string().max(4096),
  kind: z.enum(['object', 'time']),
  objectId: z.string().max(200).optional(),
  objectName: z.string().max(200).optional(),
  coordinates: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  timestampNs: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional(),
  channelId: z.number().int().nonnegative().optional(),
});
