import type {
  App,
  McpUiHostContext,
  McpUiUpdateModelContextRequest,
  McpUiDisplayMode,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import SummaryWorker from './viewers/mcap-summary.worker?worker&inline';
import type { McapInfo } from '../shared/types';
import { artifactResponse, type Artifact, type Selection } from '../shared/types';
import { artifactFileInput } from '../shared/file-entrypoint';
import { detectFormat, formats } from '../shared/formats';
import { hostResourceContent, hostResourceFile, hostPreviewLimit } from './host-file';
import { version } from '../shared/version';
import { ModelContext, modelContextHostState } from './model-context';
import { resolveAssetPath } from '../shared/asset-path';
import {
  viewCommand,
  viewIdentity,
  type ViewIdentity,
  type ViewResult,
  type ViewSnapshot,
} from '../shared/view';

const localFiles = new Map<string, File>();
const previewLimit = hostPreviewLimit;
const byteResponse = z.object({ data: z.string() });
const pickerResponse = z.object({ picker: z.literal(true) });
const MAX_PARSER_BYTES = 16 * 1024 * 1024;
const parserResponse = byteResponse.extend({ total: z.number().int().positive() });
const bundledBytes = new Map<string, ArrayBuffer>();
const workspaceExtensions = new Set(
  formats
    .filter(
      ({ id, kind }) =>
        kind === 'model' ||
        ['mcap', 'zip', 'npz', 'parquet', 'sqlite', 'gguf', 'safetensors', 'shp', 'nrrd'].includes(
          id,
        ),
    )
    .flatMap(({ extensions }) => extensions),
);
let bridge: App | undefined;
let displayMode: McpUiDisplayMode = 'inline';
let modelContext: ModelContext | undefined;
let pendingHostFile: AbortController | undefined;
let reloadHostFile: ((saved?: { file: File; etag: string }) => Promise<void>) | undefined;
let hostFile:
  { id: string; uri: string; name: string; writable?: boolean; etag?: string } | undefined;
let hostWatch:
  { uri: string; supported: Promise<boolean>; subscribed: boolean; changed: boolean } | undefined;
export const artifactChangedEvent = 'tesseract-artifact-changed';

function stopWatchingHostFile() {
  const watch = hostWatch;
  const app = bridge;
  hostWatch = undefined;
  if (!watch || !app) return;
  void watch.supported
    .then(async (supported) => {
      if (supported && hostWatch?.uri !== watch.uri)
        await app.request(
          { method: 'resources/unsubscribe', params: { uri: watch.uri } },
          z.object({}),
          { timeout: 1500 },
        );
    })
    .catch(() => {});
}

function watchHostFile(app: App, uri: string) {
  if (hostWatch?.uri === uri) return;
  stopWatchingHostFile();
  if (!app.getHostCapabilities()?.experimental?.['openai/resource']) return;
  const supported = app
    .request({ method: 'resources/subscribe', params: { uri } }, z.object({}), { timeout: 1500 })
    .then(
      () => true,
      () => false,
    );
  const watch = { uri, supported, subscribed: false, changed: false };
  hostWatch = watch;
  void supported.then((value) => {
    watch.subscribed = value;
  });
}

export const canRetryHostFile = () => reloadHostFile !== undefined;
export async function retryHostFile() {
  await reloadHostFile?.();
}
export function cancelHostFile() {
  pendingHostFile?.abort();
  reloadHostFile = undefined;
  hostFile = undefined;
  stopWatchingHostFile();
}

export async function connect(
  onArtifact: (a: Artifact) => void,
  onTheme: (theme: string) => void,
  onError: (message: string) => void,
  onPicker: () => void,
  onDisplayMode: (fullscreen: boolean, available: boolean) => void,
) {
  const { App, applyHostStyleVariables } = await import('@modelcontextprotocol/ext-apps');
  const app = new App(
    { name: 'Tesseract', version },
    { availableDisplayModes: ['inline', 'fullscreen'] },
  );
  bridge = app;
  modelContext = new ModelContext(
    (params) => app.updateModelContext(params),
    () => window.dispatchEvent(new Event('tesseract-context-removed')),
  );
  app.setNotificationHandler(
    z.object({
      method: z.literal('notifications/resources/updated'),
      params: z.object({ uri: z.string() }),
    }),
    ({ params }) => {
      if (hostWatch?.uri !== params.uri) return;
      hostWatch.changed = true;
      window.dispatchEvent(new Event(artifactChangedEvent));
    },
  );
  app.ontoolinput = async ({ arguments: args }) => {
    const input = artifactFileInput.safeParse(args);
    if (!input.success) {
      if (args && 'file' in args) onError('Tesseract couldn’t read this file from Codex.');
      return;
    }
    const { name, resourceUri } = input.data.file;
    hostFile = undefined;
    watchHostFile(app, resourceUri);
    const showHostFile = (artifact: Artifact, writable?: boolean, etag?: string) => {
      hostFile = { id: artifact.id, uri: resourceUri, name, writable, etag };
      onArtifact(artifact);
    };
    reloadHostFile = async (saved) => {
      pendingHostFile?.abort();
      pendingHostFile = new AbortController();
      const { signal } = pendingHostFile;
      let inspectionError: unknown;
      try {
        if (saved) {
          const artifact = await openLocalFile(saved.file, signal);
          if (signal.aborted) releaseLocalFile(artifact);
          else showHostFile(artifact, true, saved.etag);
          return;
        }
        // Workspace files keep bounded reads and linked assets inside the configured roots.
        if (workspaceExtensions.has(name.toLowerCase().split('.').pop() ?? '')) {
          try {
            const { artifact } = artifactResponse.parse(
              await tool('artifact_open_host_file', {}, signal),
            );
            if (/\.mcap$/i.test(name) && !artifact.mcap)
              throw new Error(artifact.warning ?? 'No indexed MCAP summary was returned.');
            if (!signal.aborted) showHostFile(artifact);
            return;
          } catch (error) {
            signal.throwIfAborted();
            inspectionError = error;
          }
        }
        if (!app.getHostCapabilities()?.experimental?.['openai/resource']) {
          throw new Error('This host did not share the opened file.');
        }
        const resource = await app.readServerResource(
          {
            uri: resourceUri,
            _meta: { 'openai/resource': { representation: 'blob' } },
          },
          { signal },
        );
        const file = hostResourceFile(resource, resourceUri, name);
        const artifact = await openLocalFile(file, signal);
        if (signal.aborted) releaseLocalFile(artifact);
        else {
          const content = hostResourceContent(resource, resourceUri);
          const metadata = resourceMetadata.safeParse(content._meta?.['openai/resource']).data;
          showHostFile(
            artifact,
            'blob' in content && Boolean(metadata?.writable && metadata.etag),
            metadata?.etag,
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        if (inspectionError instanceof Error)
          console.warn('Indexed file inspection failed.', inspectionError.message);
        onError(error instanceof Error ? error.message : 'Couldn’t open file.');
      }
    };
    await reloadHostFile();
  };
  app.ontoolresult = (result) => {
    const data = result.structuredContent;
    const parsed = artifactResponse.safeParse(data);
    if (parsed.success) {
      cancelHostFile();
      onArtifact(parsed.data.artifact);
    }
    if (pickerResponse.safeParse(data).success) onPicker();
  };
  const applyContext = (context?: McpUiHostContext) => {
    if (context?.displayMode) {
      displayMode = context.displayMode;
    }
    const modes = app.getHostContext()?.availableDisplayModes;
    // Codex file panels already use "fullscreen" and cannot switch back to inline.
    onDisplayMode(
      displayMode === 'fullscreen',
      Boolean(modes?.includes('inline') && modes.includes('fullscreen')),
    );
    if (context?.theme) onTheme(context.theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    if (context && Object.hasOwn(context, 'openai/modelContext')) {
      const state = modelContextHostState.safeParse(context['openai/modelContext']);
      if (state.success) modelContext?.receive(state.data);
    }
  };
  app.onhostcontextchanged = applyContext;
  app.onteardown = async () => {
    cancelHostFile();
    window.dispatchEvent(new Event('tesseract-teardown'));
    return {};
  };
  await app.connect();
  applyContext(app.getHostContext());
}
export async function toggleFullscreen() {
  const context = bridge?.getHostContext();
  const mode = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  const modes = context?.availableDisplayModes;
  if (!bridge || !modes?.includes('inline') || !modes.includes('fullscreen'))
    return displayMode === 'fullscreen';
  const actual = await bridge.requestDisplayMode({ mode });
  displayMode = actual.mode;
  if (actual.mode !== mode) throw new Error('Codex couldn’t change the display mode.');
  return displayMode === 'fullscreen';
}
async function tool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  if (!bridge) throw new Error('Host connection unavailable.');
  const result = await bridge.callServerTool({ name, arguments: args }, { signal });
  if (result.isError)
    throw new Error(
      result.content?.find((c) => c.type === 'text')?.text ?? 'Artifact operation failed.',
    );
  return result.structuredContent;
}

export async function shareView(artifact: Artifact, snapshot: ViewSnapshot, image?: string) {
  return viewIdentity.parse(
    await tool('artifact_share_view', {
      revision: artifact.revision,
      snapshot,
      image,
      workspaceArtifactId: artifact.id.startsWith('local-') ? undefined : artifact.id,
    }),
  );
}

export async function addViewToChat(
  view: ViewIdentity,
  { group, title, summary }: { group: string; title: string; summary?: string },
  image?: string,
): Promise<boolean> {
  const capabilities = bridge?.getHostCapabilities()?.updateModelContext;
  if (!bridge || !capabilities || !modelContext) return false;
  const reference = `Use Tesseract’s artifact_get_view with ${JSON.stringify({ ...view, includeImage: true })} for the current preview and selection.`;
  const text = summary ? `${summary}\n${reference}` : reference;
  const metadata = { 'openai/group': { title: group }, 'openai/title': title };
  const preview = capabilities.image && image;
  const content: NonNullable<McpUiUpdateModelContextRequest['params']['content']> = [
    {
      type: 'text',
      text,
      _meta: metadata,
      annotations: preview ? { audience: ['assistant'] } : undefined,
    },
  ];
  if (preview)
    content.push({ type: 'image', mimeType: 'image/jpeg', data: preview, _meta: metadata });
  try {
    return await modelContext.update({ content });
  } catch {
    return false;
  }
}

export async function clearChatContext() {
  if (bridge?.getHostCapabilities()?.updateModelContext) await modelContext?.clear();
}

export async function syncView(
  view: ViewIdentity,
  snapshot?: ViewSnapshot,
  result?: ViewResult,
  image?: string,
) {
  const response = await tool('artifact_sync_view', { ...view, snapshot, result, image });
  return z.object({ command: viewCommand.nullable() }).parse(response).command;
}

export async function closeView(view: ViewIdentity) {
  await tool('artifact_close_view', view);
}

export const canDownloadArtifact = () => Boolean(bridge?.getHostCapabilities()?.downloadFile);

export function encodeBytes(data: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 16384)
    binary += String.fromCharCode(...data.subarray(offset, offset + 16384));
  return btoa(binary);
}

export async function downloadArtifact(name: string, mimeType: string, bytes: ArrayBuffer) {
  if (!bridge || !canDownloadArtifact()) throw new Error('This host can’t save a copy.');
  if (bytes.byteLength > previewLimit) throw new Error('Export limit is 64 MiB.');
  const response = await bridge.downloadFile({
    contents: [
      {
        type: 'resource',
        resource: {
          uri: `file:///${encodeURIComponent(name)}`,
          mimeType,
          blob: encodeBytes(new Uint8Array(bytes)),
        },
      },
    ],
  });
  if (response.isError) throw new Error('Couldn’t save copy.');
}

const writableResource = z.object({ writable: z.literal(true), etag: z.string().min(1) });
const resourceMetadata = z.object({
  writable: z.boolean().optional(),
  etag: z.string().min(1).optional(),
});
const writeOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('saved'), etag: z.string() }),
  z.object({ outcome: z.literal('conflict'), etag: z.string() }),
  z.object({ outcome: z.literal('too-large'), maxBytes: z.number() }),
]);

export function canSaveHostFile(artifact: Artifact) {
  return (
    hostFile?.id === artifact.id &&
    hostFile.writable !== false &&
    !artifact.entries &&
    artifact.size <= previewLimit &&
    Boolean(bridge?.getHostCapabilities()?.experimental?.['openai/resource'])
  );
}

function hostSaveTarget(artifact: Artifact) {
  const active = hostFile;
  const app = bridge;
  if (!app || active?.id !== artifact.id)
    throw new Error('Open the file in a native Codex file tab.');
  if (active.writable === false)
    throw new Error('Codex has not granted versioned write access to this file.');
  if (artifact.size > previewLimit) throw new Error('Save limit is 64 MiB.');
  return { app, active };
}

async function readHostSave(artifact: Artifact, signal?: AbortSignal) {
  const { app, active } = hostSaveTarget(artifact);
  if (active.etag) {
    const current = new Uint8Array(await readBytes(artifact, previewLimit, false, signal));
    return { app, active, current, etag: active.etag };
  }
  const resource = await app.readServerResource(
    { uri: active.uri, _meta: { 'openai/resource': { representation: 'blob' } } },
    { signal },
  );
  const content = hostResourceContent(resource, active.uri);
  const metadata = writableResource.safeParse(content._meta?.['openai/resource']);
  if (!metadata.success)
    throw new Error('Codex has not granted versioned write access to this file.');
  if (!('blob' in content)) throw new Error('Codex did not return the file’s exact bytes.');
  const file = hostResourceFile(resource, active.uri, active.name);
  const current = new Uint8Array(await file.arrayBuffer());
  const original = new Uint8Array(await readBytes(artifact, previewLimit, false, signal));
  if (
    current.length !== original.length ||
    !current.every((byte, index) => byte === original[index])
  )
    throw new Error('The file changed. Reload it before saving.');
  return { app, active, current, etag: metadata.data.etag };
}

async function writeHostSave(
  { app, active, etag }: ReturnType<typeof hostSaveTarget> & { etag: string },
  bytes: Uint8Array,
  signal?: AbortSignal,
) {
  if (bytes.byteLength > previewLimit) throw new Error('Save limit is 64 MiB.');
  signal?.throwIfAborted();
  if (hostFile !== active) throw new Error('The open file changed before saving.');
  const result = await app.request(
    {
      method: 'openai/resources/write',
      params: { uri: active.uri, ifMatch: etag, blob: encodeBytes(bytes) },
    },
    writeOutcome,
    { signal },
  );
  if (result.outcome === 'conflict') throw new Error('The file changed. Reload it before saving.');
  if (result.outcome === 'too-large')
    throw new Error(`Codex allows up to ${result.maxBytes} bytes per save.`);
  // Let the editor report success before the new revision invalidates its preview session.
  window.setTimeout(() => {
    if (hostFile !== active) return;
    const source = localFiles.get(active.id);
    const saved = source && {
      file: new File([bytes.slice()], active.name, { type: source.type }),
      etag: result.etag,
    };
    void reloadHostFile?.(saved);
  }, 0);
  return { name: active.name, size: bytes.byteLength, outcome: result.outcome };
}

export async function saveHostFile(
  artifact: Artifact,
  bytes: ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
) {
  const next = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (next.byteLength > previewLimit) throw new Error('Save limit is 64 MiB.');
  const target = hostSaveTarget(artifact);
  const pending = target.active.etag
    ? { ...target, etag: target.active.etag }
    : await readHostSave(artifact, signal);
  return writeHostSave(pending, next, signal);
}

export async function patchHostFile(
  artifact: Artifact,
  offset: number,
  expected: Uint8Array,
  replacement: Uint8Array,
  signal?: AbortSignal,
) {
  const size = artifact.size - expected.length + replacement.length;
  if (size > previewLimit) throw new Error('Save limit is 64 MiB.');
  const pending = await readHostSave(artifact, signal);
  const { current } = pending;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset + expected.length > current.length ||
    !expected.every((byte, index) => byte === current[offset + index])
  )
    throw new Error('The bytes at the edit location do not match.');
  const end = offset + expected.length;
  const next = new Uint8Array(size);
  next.set(current.subarray(0, offset));
  next.set(replacement, offset);
  next.set(current.subarray(end), offset + replacement.length);
  return writeHostSave(pending, next, signal);
}

export function canRefreshArtifact(artifact: Artifact) {
  return !artifact.id.startsWith('local-') || hostFile?.id === artifact.id;
}

export function artifactRefreshDelay(artifact: Artifact) {
  if (hostFile?.id === artifact.id && hostWatch?.subscribed && !hostWatch.changed) return;
  if (!artifact.id.startsWith('local-')) return artifact.entries ? 2000 : 1000;
  if (hostFile?.id !== artifact.id || !hostFile.etag || artifact.size > previewLimit) return;
  // Older hosts send the entire blob. Keep background reads below 4 MiB/s.
  return Math.max(750, Math.ceil((artifact.size * 1000) / (4 * 1024 * 1024)));
}

export function hasPendingArtifactUpdate(artifact: Artifact) {
  return hostFile?.id === artifact.id && hostWatch?.changed === true;
}

export async function state(artifact: Artifact, signal: AbortSignal): Promise<Artifact> {
  const watch = hostFile?.id === artifact.id ? hostWatch : undefined;
  if (watch) watch.changed = false;
  try {
    if (!artifact.id.startsWith('local-')) {
      const result = await tool('artifact_state', { artifactId: artifact.id }, signal);
      return artifactResponse.parse(result).artifact;
    }
    const active = hostFile;
    const app = bridge;
    if (!app || active?.id !== artifact.id) return artifact;
    const resource = await app.readServerResource(
      { uri: active.uri, _meta: { 'openai/resource': { representation: 'blob' } } },
      { signal },
    );
    const content = hostResourceContent(resource, active.uri);
    const metadata = resourceMetadata.safeParse(content._meta?.['openai/resource']).data;
    const etag = metadata?.etag;
    if ((etag && etag === active.etag) || hostFile !== active) return artifact;
    const file = hostResourceFile(resource, active.uri, active.name);
    if (!etag || !active.etag) {
      const previous = localFiles.get(artifact.id);
      if (previous?.size === file.size) {
        const [oldBytes, newBytes] = await Promise.all([
          previous.arrayBuffer(),
          file.arrayBuffer(),
        ]);
        const latest = new Uint8Array(newBytes);
        if (new Uint8Array(oldBytes).every((byte, index) => byte === latest[index]))
          return artifact;
      }
    }
    const next = await openLocalFile(file, signal);
    if (signal.aborted || hostFile !== active) {
      releaseLocalFile(next);
      return artifact;
    }
    hostFile = {
      ...active,
      id: next.id,
      etag,
      writable: 'blob' in content && Boolean(metadata?.writable && etag),
    };
    return next;
  } catch (error) {
    if (watch) watch.changed = true;
    throw error;
  }
}
let pendingSelection: Promise<unknown> = Promise.resolve();

async function updateSelection(
  name: 'artifact_select' | 'artifact_clear_selection',
  selection: Pick<Selection, 'artifactId' | 'revision'>,
) {
  if (selection.artifactId.startsWith('local-')) return false;
  const update = pendingSelection.catch(() => {}).then(() => tool(name, selection));
  pendingSelection = update;
  await update;
  return true;
}

export function select(selection: Selection) {
  return updateSelection('artifact_select', selection);
}

export function clearSelection(artifact: Artifact) {
  return updateSelection('artifact_clear_selection', {
    artifactId: artifact.id,
    revision: artifact.revision,
  });
}
export async function openLocalFile(file: File, signal: AbortSignal): Promise<Artifact> {
  const format = detectFormat(
    file.name,
    new Uint8Array(await file.slice(0, 512).arrayBuffer()),
    file.type,
  );
  signal.throwIfAborted();
  let mcap: McapInfo | undefined;
  if (format.kind === 'mcap') {
    mcap = await new Promise<McapInfo>((resolve, reject) => {
      const worker = new SummaryWorker();
      const finish = (error?: string, info?: McapInfo) => {
        clearTimeout(timer);
        worker.terminate();
        signal.removeEventListener('abort', cancel);
        if (error) reject(new Error(error));
        else resolve(info!);
      };
      const cancel = () => finish('MCAP loading cancelled.');
      const timer = setTimeout(() => finish('MCAP summary exceeded 20 seconds.'), 20000);
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = (event) => finish(event.data.error, event.data.info);
      worker.onerror = () => finish('MCAP summary worker unavailable.');
      worker.postMessage(file);
    });
  }
  signal.throwIfAborted();
  const artifact = {
    id: `local-${crypto.randomUUID()}`,
    path: file.name,
    name: file.name,
    size: file.size,
    modified: file.lastModified,
    revision: String(file.lastModified),
    format,
    mcap,
  };
  if (localFiles.size >= 128) localFiles.delete(localFiles.keys().next().value!);
  localFiles.set(artifact.id, file);
  return artifact;
}

export function releaseLocalFile(artifact: Artifact) {
  localFiles.delete(artifact.id);
}
export async function readBytes(
  a: Artifact,
  limit = previewLimit,
  prefix = false,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!prefix && a.size > limit)
    throw new Error(
      `Preview limit is ${limit / 1024 / 1024} MiB. The file remains available for inspection.`,
    );
  return readRange(a, 0, Math.min(a.size, limit), signal);
}

export async function readRange(a: Artifact, offset: number, length: number, signal?: AbortSignal) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > a.size ||
    length > previewLimit
  )
    throw new Error('Invalid preview byte range.');
  signal?.throwIfAborted();
  if (length === 0) return new ArrayBuffer(0);
  const file = localFiles.get(a.id);
  if (file) {
    const bytes = await file.slice(offset, offset + length).arrayBuffer();
    signal?.throwIfAborted();
    if (bytes.byteLength !== length) throw new Error('File ended unexpectedly.');
    return bytes;
  }
  const result = new Uint8Array(length);
  for (let position = 0; position < length; position += 1024 * 1024) {
    signal?.throwIfAborted();
    const count = Math.min(1024 * 1024, length - position);
    const { data } = byteResponse.parse(
      await tool(
        'artifact_read',
        {
          artifactId: a.id,
          revision: a.revision,
          offset: offset + position,
          length: count,
        },
        signal,
      ),
    );
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    if (bytes.length !== count) throw new Error('File ended unexpectedly.');
    result.set(bytes, position);
  }
  return result.buffer;
}
export async function mediaUrl(
  a: Artifact,
  signal?: AbortSignal,
): Promise<{ url: string; release: () => void }> {
  const local = localFiles.get(a.id);
  const blob =
    local?.slice(0, local.size, a.format.mime) ??
    new Blob([await readBytes(a, undefined, false, signal)], { type: a.format.mime });
  const url = URL.createObjectURL(blob);
  return { url, release: () => URL.revokeObjectURL(url) };
}

export async function convertedMediaUrl(a: Artifact, kind: 'audio' | 'video', signal: AbortSignal) {
  const bytes = new Uint8Array(await readBytes(a, 4 * 1024 * 1024, false, signal));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  const { data } = byteResponse.parse(
    await tool('artifact_convert_media', { kind, data: btoa(binary) }, signal),
  );
  if (data.length > 4 * 1024 * 1024) throw new Error('Converted preview exceeds 3 MiB.');
  const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
    type: kind === 'video' ? 'video/mp4' : 'audio/ogg',
  });
  signal.throwIfAborted();
  return URL.createObjectURL(blob);
}

export async function openPath(path: string, signal?: AbortSignal): Promise<Artifact> {
  return artifactResponse.parse(await tool('artifact_open', { path }, signal)).artifact;
}

export async function readAsset(artifact: Artifact, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (artifact.id.startsWith('local-') || /^(?:package|model):/i.test(path))
    throw new Error(`Open the containing folder or ZIP to load “${path}”.`);
  const dependency = await openPath(resolveAssetPath(artifact.path, path), signal);
  if (dependency.entries) throw new Error(`Asset is a folder: ${path}`);
  return readBytes(dependency, undefined, false, signal);
}

export async function cadDecoder(signal?: AbortSignal, kind = 'cad'): Promise<ArrayBuffer> {
  return (await readBundledBytes('artifact_cad_decoder', kind, signal)).slice(0);
}

export async function embeddedParserWorker(assetUrl: string, signal: AbortSignal): Promise<Worker> {
  // Vite emits the worker asset. The host bridge supplies its bytes inside the sandbox.
  const kind = /\/(advanced|extended-archive|cad|data|raster|structured)\.worker\.js$/.exec(
    assetUrl,
  )?.[1];
  if (!kind) throw new Error('Unknown parser worker.');
  const gzip = await readBundledBytes('artifact_parser_script', kind, signal);
  const stream = new Blob([gzip]).stream().pipeThrough(new DecompressionStream('gzip'));
  const script = await new Response(stream).arrayBuffer();
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readBundledBytes(
  name: 'artifact_cad_decoder' | 'artifact_parser_script',
  kind: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const key = `${name}/${kind}`;
  const cached = bundledBytes.get(key);
  if (cached) return cached;
  const readChunk = async (offset: number) => {
    signal?.throwIfAborted();
    const { data, total } = parserResponse.parse(await tool(name, { offset, kind }, signal));
    if (total > MAX_PARSER_BYTES) throw new Error('Parser exceeds size limit.');
    return { bytes: Uint8Array.from(atob(data), (character) => character.charCodeAt(0)), total };
  };
  const { bytes: first, total } = await readChunk(0);
  const stride = first.byteLength;
  if (!stride || stride > total) throw new Error('Incomplete parser download.');
  const bytes = new Uint8Array(total);
  bytes.set(first);
  for (let offset = stride; offset < total; offset += stride * 4) {
    const count = Math.min(4, Math.ceil((total - offset) / stride));
    await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const position = offset + index * stride;
        const chunk = await readChunk(position);
        if (chunk.total !== total || chunk.bytes.byteLength !== Math.min(stride, total - position))
          throw new Error('Incomplete parser download.');
        bytes.set(chunk.bytes, position);
      }),
    );
  }
  bundledBytes.set(key, bytes.buffer);
  return bytes.buffer;
}
