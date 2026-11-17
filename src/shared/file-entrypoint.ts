import { z } from 'zod';
import { formats } from './formats.js';

export const stlFileInput = z.object({
  file: z.object({
    name: z.string().regex(/\.[sS][tT][lL]$/),
    resourceUri: z.string().trim().min(1),
  }),
});

// Built-in workspace media coverage for extensions in the format registry.
const codexMediaExtensions = new Set(['mp4', 'webm', 'ogv', 'mp3', 'wav', 'ogg']);
export const nativeExtensions = formats
  .filter((format) => format.id !== 'text' && format.kind !== 'image')
  .flatMap((format) => format.extensions)
  .filter((ext) => !codexMediaExtensions.has(ext))
  .map((ext) => `.${ext}`);
export const artifactFileInput = z.object({
  file: z.object({
    name: z
      .string()
      .refine(
        (name) => nativeExtensions.some((ext) => name.toLowerCase().endsWith(ext)),
        'Unsupported native viewer extension.',
      ),
    resourceUri: z.string().trim().min(1),
  }),
});
