import { z } from 'zod';
import type { Artifact } from '../shared/types';
import {
  modelEditAction,
  previewViewAction,
  type ViewAction,
  type ViewSnapshot,
} from '../shared/view';
import { canSaveHostFile, encodeBytes, patchHostFile, readRange } from './backend';

export type LivePanel = {
  artifact: Artifact;
  read: () => ViewSnapshot;
  capture: () => string | undefined;
  change: (action: ViewAction, signal?: AbortSignal, save?: true) => Promise<unknown>;
};

type SiteTool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; consequentialHint?: boolean };
  execute: (input: unknown, options?: { signal?: AbortSignal }) => unknown;
};

const readInput = z.object({ includeImage: z.boolean().optional() }).strict();
const changeInput = z.object({ action: previewViewAction }).strict();
const modelEditInput = z
  .object({
    artifactId: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
    action: modelEditAction,
  })
  .strict();
const offset = z.number().int().nonnegative();
const encodedBytes = z.base64().max(24_000);
const readBytesInput = z
  .object({
    offset,
    length: z.number().int().min(1).max(16_384),
  })
  .strict();
const patchInput = z
  .object({
    artifactId: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
    offset,
    expectedBase64: encodedBytes,
    replacementBase64: encodedBytes,
  })
  .strict();
const decodeBytes = (value: string) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));

function readPanel(panel: LivePanel, includeImage?: boolean) {
  const view = {
    artifactId: panel.artifact.id,
    revision: panel.artifact.revision,
    snapshot: panel.read(),
  };
  if (!includeImage) return view;
  const image = panel.capture();
  return {
    structuredContent: { ...view, hasImage: Boolean(image) },
    content: image ? [{ type: 'image', mimeType: 'image/jpeg', data: image }] : [],
  };
}

export function registerWebMcp(getPanel: () => LivePanel | undefined) {
  const { modelContext } = document as Document & {
    modelContext?: {
      registerTool: (tool: SiteTool, options: { signal: AbortSignal }) => void | Promise<void>;
    };
  };
  if (typeof modelContext?.registerTool !== 'function') return;

  const registration = new AbortController();
  const tools: SiteTool[] = [
    {
      name: 'tesseract_read_view',
      description:
        'Read the file, selection, and viewer state in this open Tesseract tab. Optionally capture the current model or camera frame.',
      inputSchema: z.toJSONSchema(readInput),
      annotations: { readOnlyHint: true },
      execute(input) {
        const args = readInput.safeParse(input);
        if (!args.success) return { error: 'Invalid view options.' };
        const panel = getPanel();
        return panel
          ? readPanel(panel, args.data.includeImage)
          : { error: 'Open a file in this Tesseract tab.' };
      },
    },
    {
      name: 'tesseract_change_view',
      description:
        'Change this open Tesseract preview. For all recording topics use mcap_view with layout.allTopics set to true. Changes apply to the preview.',
      inputSchema: z.toJSONSchema(changeInput),
      annotations: { readOnlyHint: false },
      execute(input, options) {
        const args = changeInput.safeParse(input);
        if (!args.success) return { error: 'Invalid view action.' };
        const panel = getPanel();
        if (!panel) return { error: 'Open a file in this Tesseract tab.' };
        const { action } = args.data;
        return action.kind === 'capture'
          ? readPanel(panel, true)
          : panel.change(action, options?.signal);
      },
    },
    {
      name: 'tesseract_edit_model',
      description:
        'Save a part color, STEP surface color, or 90-degree model rotation to the open file. Get its artifact ID, revision, and target from tesseract_read_view. This writes to disk.',
      inputSchema: z.toJSONSchema(modelEditInput),
      annotations: { readOnlyHint: false, consequentialHint: true },
      execute(input, options) {
        const args = modelEditInput.safeParse(input);
        if (!args.success) return { error: 'Invalid model edit.' };
        const panel = getPanel();
        const { artifactId, revision, action } = args.data;
        if (!panel || panel.artifact.id !== artifactId || panel.artifact.revision !== revision)
          return { error: 'The open file changed. Read it again before saving.' };
        if (!canSaveHostFile(panel.artifact))
          return { error: 'Open the model in a writable native Codex file tab.' };
        return panel.change(action, options?.signal, true);
      },
    },
    {
      name: 'tesseract_read_file_bytes',
      description:
        'Read a byte range of the open file as base64. Returns the artifact ID and revision needed to save edits.',
      inputSchema: z.toJSONSchema(readBytesInput),
      annotations: { readOnlyHint: true },
      async execute(input, options) {
        const args = readBytesInput.safeParse(input);
        if (!args.success) return { error: 'Invalid file byte range.' };
        const artifact = getPanel()?.artifact;
        if (!artifact) return { error: 'Open a file in this Tesseract tab.' };
        try {
          const { offset, length } = args.data;
          const bytes = await readRange(artifact, offset, length, options?.signal);
          return {
            artifactId: artifact.id,
            revision: artifact.revision,
            offset,
            base64: encodeBytes(new Uint8Array(bytes)),
          };
        } catch (error) {
          return { error: (error as Error).message };
        }
      },
    },
    {
      name: 'tesseract_patch_file',
      description:
        'Save a byte replacement to the current writable Codex file in place. Read its exact bytes and revision first. This writes to disk.',
      inputSchema: z.toJSONSchema(patchInput),
      annotations: { readOnlyHint: false, consequentialHint: true },
      async execute(input, options) {
        const args = patchInput.safeParse(input);
        if (!args.success) return { error: 'Invalid file edit.' };
        const { artifactId, revision, offset, expectedBase64, replacementBase64 } = args.data;
        const artifact = getPanel()?.artifact;
        if (artifact?.id !== artifactId || artifact.revision !== revision)
          return { error: 'The open file changed. Read it again before saving.' };
        try {
          return await patchHostFile(
            artifact,
            offset,
            decodeBytes(expectedBase64),
            decodeBytes(replacementBase64),
            options?.signal,
          );
        } catch (error) {
          return { error: (error as Error).message };
        }
      },
    },
  ];
  for (const tool of tools) {
    void Promise.resolve()
      .then(() => {
        if (!registration.signal.aborted)
          return modelContext.registerTool(tool, { signal: registration.signal });
      })
      .catch((error) => {
        if (!registration.signal.aborted) console.warn('Could not register Tesseract tool.', error);
      });
  }
  return () => registration.abort();
}
