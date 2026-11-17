import { cadDecoder } from './cad.js';
import { McpServer } from '@modelcontextprotocol/server';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { z } from 'zod';
import { stlFileInput, artifactFileInput, nativeExtensions } from '../shared/file-entrypoint.js';
import { formats } from '../shared/formats.js';
import { idSchema, selectionSchema } from './schemas.js';
import type { ArtifactStore } from './store.js';
import { version } from '../shared/version.js';

export const RESOURCE_URI = 'ui://tesseract/viewer.html';
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const compress = promisify(gzip);
export function createMcpServer(store: ArtifactStore, embeddedFile: string) {
  const server = new McpServer({ name: 'tesseract', title: 'Tesseract', version });
  const result = (data: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  });
  const run = async (operation: () => Promise<Record<string, unknown>>) => {
    try {
      return result(await operation());
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'Artifact operation failed.',
          },
        ],
      };
    }
  };
  registerAppTool(
    server,
    'artifact_viewer',
    {
      title: 'Open Tesseract',
      description:
        'Open a file picker in Tesseract so the user can choose a local file to preview.',
      inputSchema: z.object({}),
      annotations: readOnly,
      _meta: {
        ui: { resourceUri: RESOURCE_URI },
        'openai/ui': { entrypoints: [{ type: 'thread' }] },
      },
    },
    async () => result({ picker: true }),
  );
  for (const name of ['artifact_open', 'artifact_inspect', 'artifact_refresh']) {
    registerAppTool(
      server,
      name,
      {
        title: name.replaceAll('_', ' '),
        description:
          name === 'artifact_open'
            ? 'Inspect and preview an artifact within the configured workspace roots. To show a file already chosen in Codex Desktop, open it directly with the native file panel. Use artifact_viewer to let the user choose a file.'
            : name === 'artifact_refresh'
              ? 'Reinspect a workspace artifact after editing. Preserves its reference and clears stale selections.'
              : 'Inspect workspace artifact type, size, revision, and MCAP summary without transferring file contents.',
        inputSchema: z.object({ path: z.string().min(1).max(4096) }),
        annotations: readOnly,
        _meta: { ui: name === 'artifact_open' ? { resourceUri: RESOURCE_URI } : {} },
      },
      ({ path }) =>
        run(async () => {
          const artifact = await store.inspect(path);
          if (name === 'artifact_open') store.latestId = artifact.id;
          return { artifact };
        }),
    );
  }
  registerAppTool(
    server,
    'artifact_open_stl',
    {
      title: 'Open STL with Tesseract',
      description: 'Preview an STL file supplied by the desktop file viewer.',
      inputSchema: stlFileInput,
      annotations: readOnly,
      _meta: {
        ui: { resourceUri: RESOURCE_URI, visibility: ['app'] },
        'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.stl'] }] },
      },
    },
    async () => ({ content: [] }),
  );
  registerAppTool(
    server,
    'artifact_open_file',
    {
      title: 'Open file with Tesseract',
      description:
        'Preview a specialized artifact in the Codex file panel through the host resource bridge.',
      inputSchema: artifactFileInput,
      annotations: readOnly,
      _meta: {
        ui: { resourceUri: RESOURCE_URI, visibility: ['app'] },
        'openai/ui': {
          entrypoints: [
            { type: 'file', extensions: nativeExtensions.filter((ext) => ext !== '.stl') },
          ],
        },
      },
    },
    async () => ({ content: [] }),
  );
  registerAppTool(
    server,
    'artifact_open_host_file',
    {
      title: 'Inspect the file opened in this panel',
      description:
        'Read the native panel file identified by host-supplied resource metadata. Accepts no filesystem path.',
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
      _meta: { ui: { visibility: ['app'] } },
    },
    async (_args, context) => {
      try {
        const resource = z
          .object({ path: z.string().min(1) })
          .safeParse(context.mcpReq._meta?.['openai/resource']);
        if (!resource.success)
          throw new Error('Codex did not supply the opened file binding (openai/resource.path).');
        // Preserve configured roots, canonicalization and regular-file checks.
        const artifact = await store.inspect(resource.data.path);
        return result({ artifact });
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Cannot inspect the host-bound file.',
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    'artifact_list_supported_formats',
    {
      description: 'List implemented preview formats and MVP limits.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () =>
      result({
        formats,
        limits: {
          modelBytes: 64 * 1024 * 1024,
          embeddedMediaBytes: 64 * 1024 * 1024,
          textBytes: 256 * 1024,
          mcapUnindexedBytes: 32 * 1024 * 1024,
        },
        deferred: [
          'USD',
          'binary/appended VTK XML and field switching',
          'E57 point packets',
          'ROS2/CDR and compressed recording playback',
          'comparison',
          'capture',
        ],
      }),
  );
  server.registerTool(
    'artifact_get_selection',
    {
      description:
        'Return the user’s latest model hit (object identity and coordinates) or MCAP timestamp and channel. Selection is scoped to the artifact revision.',
      inputSchema: z.object({ artifactId: z.string().uuid().optional() }),
      annotations: readOnly,
    },
    ({ artifactId }) =>
      run(async () => {
        const id = artifactId ?? store.latestId;
        if (id) await store.get(id);
        return { selection: id ? (store.selections.get(id) ?? null) : null };
      }),
  );
  registerAppTool(
    server,
    'artifact_state',
    {
      description: 'Read current state of an already opened artifact.',
      inputSchema: idSchema,
      annotations: readOnly,
      _meta: { ui: { visibility: ['app'] } },
    },
    ({ artifactId }) => run(async () => ({ artifact: await store.get(artifactId) })),
  );
  registerAppTool(
    server,
    'artifact_read',
    {
      description:
        'Read at most 1 MiB of an opened artifact at an explicit byte offset for the viewer.',
      inputSchema: idSchema.extend({
        offset: z.number().int().nonnegative(),
        length: z
          .number()
          .int()
          .min(0)
          .max(1024 * 1024),
        revision: z.string(),
      }),
      annotations: readOnly,
      _meta: { ui: { visibility: ['app'] } },
    },
    ({ artifactId, offset, length, revision }) =>
      run(async () => ({
        data: (await store.read(artifactId, offset, length, revision)).toString('base64'),
      })),
  );
  registerAppTool(
    server,
    'artifact_select',
    {
      description: 'Persist a user selection for agent inspection.',
      inputSchema: selectionSchema,
      annotations: { ...readOnly, readOnlyHint: false },
      _meta: { ui: { visibility: ['app'] } },
    },
    (args) => run(async () => ({ selection: await store.select(args) })),
  );
  registerAppTool(
    server,
    'artifact_cad_decoder',
    {
      description: 'Read a bounded chunk of the bundled CAD WebAssembly decoder.',
      inputSchema: z.object({
        offset: z
          .number()
          .int()
          .min(0)
          .max(16 * 1024 * 1024),
        kind: z.enum(['cad', 'laz']).default('cad'),
      }),
      annotations: readOnly,
      _meta: { ui: { visibility: ['app'] } },
    },
    ({ offset, kind }) =>
      run(async () => {
        const bytes = await cadDecoder(kind);
        return {
          total: bytes.length,
          data: bytes.subarray(offset, offset + 1024 * 1024).toString('base64'),
        };
      }),
  );
  const parserScripts = new Map<string, Promise<Buffer>>();
  registerAppTool(
    server,
    'artifact_parser_script',
    {
      description: 'Read a bounded chunk of a bundled parser worker.',
      inputSchema: z.object({
        kind: z.enum(['cad', 'data']),
        offset: z
          .number()
          .int()
          .min(0)
          .max(16 * 1024 * 1024),
      }),
      annotations: readOnly,
      _meta: { ui: { visibility: ['app'] } },
    },
    ({ kind, offset }) =>
      run(async () => {
        let script = parserScripts.get(kind);
        if (!script) {
          script = readFile(join(dirname(embeddedFile), `${kind}.worker.js`)).then((bytes) =>
            compress(bytes),
          );
          parserScripts.set(kind, script);
          void script.catch(() => parserScripts.delete(kind));
        }
        const bytes = await script;
        return {
          total: bytes.length,
          data: bytes.subarray(offset, offset + 512 * 1024).toString('base64'),
        };
      }),
  );
  registerAppResource(
    server,
    'tesseract-viewer',
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(embeddedFile, 'utf8'),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: ['blob:', 'data:'], resourceDomains: ['blob:', 'data:'] },
            },
          },
        },
      ],
    }),
  );
  return server;
}
