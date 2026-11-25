// Test-only MCP Apps host. Uses the official bridge; never shipped in the viewer.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { McpUiUpdateModelContextRequest } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

declare global {
  interface Window {
    callMcp: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<any>;
  }
}
async function start() {
  const fixture = await (await fetch('/fixture')).json();
  const frame = document.createElement('iframe');
  frame.id = 'app';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.allowFullscreen = Boolean(fixture.browserFullscreen);
  frame.style.cssText = 'width:100%;height:100vh;border:0;display:block';
  if (fixture.fullscreen && fixture.displayMode !== 'fullscreen') frame.style.width = '60%';
  document.body.style.margin = '0';
  document.body.appendChild(frame);
  const bridge = new AppBridge(
    null,
    { name: 'Tesseract test host', version: '1.0.0' },
    {
      serverTools: {},
      updateModelContext: fixture.chatContext
        ? { text: {}, image: fixture.imageContext ? {} : undefined }
        : undefined,
      downloadFile: fixture.download ? {} : undefined,
      experimental: {
        ...(fixture.fileResource ? { 'openai/resource': {} } : {}),
        ...(fixture.contextLifecycle ? { 'openai/modelContext': {} } : {}),
      },
    },
    {
      hostContext: {
        theme: fixture.theme ?? 'dark',
        styles: fixture.styles,
        displayMode: fixture.displayMode ?? 'inline',
        availableDisplayModes:
          fixture.hostDisplayModes ?? (fixture.fullscreen ? fixture.displayModes : ['inline']),
        ...(fixture.contextLifecycle ? { 'openai/modelContext': null } : {}),
      },
    },
  );
  bridge.onrequestdisplaymode = async ({ mode }) => {
    document.documentElement.dataset.requestedMode = mode;
    const actual = fixture.rejectFullscreen ? 'inline' : mode;
    frame.style.width = actual === 'fullscreen' ? '100%' : '60%';
    await bridge.sendHostContextChange({ displayMode: actual });
    document.documentElement.dataset.displayMode = actual;
    return { mode: actual };
  };
  bridge.oncalltool = async (params) => {
    if (params.name === 'artifact_cad_decoder' || params.name === 'artifact_parser_script') {
      const count = Number(document.documentElement.dataset.parserReads ?? 0);
      document.documentElement.dataset.parserReads = String(count + 1);
    }
    const result = await window.callMcp(params);
    if (params.name === 'artifact_sync_view') {
      const count = Number(document.documentElement.dataset.syncCount ?? 0);
      document.documentElement.dataset.syncCount = String(count + 1);
    }
    return result;
  };
  type ContextContent = NonNullable<McpUiUpdateModelContextRequest['params']['content']>;
  let latestContent: ContextContent = [];
  let updates = 0;
  const remove = document.createElement('button');
  remove.setAttribute('aria-label', 'Remove context');
  remove.textContent = '×';
  remove.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:10';
  remove.hidden = true;
  const removeImage = document.createElement('button');
  removeImage.setAttribute('aria-label', 'Remove context image');
  removeImage.textContent = '× image';
  removeImage.style.cssText = 'position:fixed;right:40px;bottom:8px;z-index:10';
  removeImage.hidden = true;
  if (fixture.contextLifecycle) document.body.append(remove, removeImage);
  const publishContext = async (content: ContextContent) => {
    latestContent = content;
    document.documentElement.dataset.attachments = JSON.stringify(
      content
        .filter(
          ({ annotations }) => !annotations?.audience || annotations.audience.includes('user'),
        )
        .map((block) => ({ type: block.type, ...block._meta })),
    );
    const text = content?.find((block) => block.type === 'text')?.text;
    document.documentElement.dataset.chatContext = text ?? '';
    document.documentElement.dataset.chatImage =
      content?.find((block) => block.type === 'image')?.data ?? '';
    remove.hidden = !content.length;
    removeImage.hidden = !content.some((block) => block.type === 'image');
    const updateId = content.length ? crypto.randomUUID() : undefined;
    if (fixture.contextLifecycle) {
      await bridge.sendHostContextChange({
        'openai/modelContext': updateId ? { updateId, content } : null,
      });
      return updateId ? { _meta: { 'openai/modelContext': { updateId } } } : {};
    }
    return {};
  };
  remove.onclick = () => {
    void publishContext([]);
  };
  removeImage.onclick = () => {
    void publishContext(latestContent.filter((block) => block.type !== 'image'));
  };
  if (fixture.chatContext)
    bridge.onupdatemodelcontext = async ({ content }) => {
      const response = await publishContext(content ?? []);
      if (content?.length && ++updates === 1 && fixture.contextUpdateDelayMs) {
        document.documentElement.dataset.contextDelayed = 'true';
        await new Promise((resolve) => setTimeout(resolve, fixture.contextUpdateDelayMs));
        document.documentElement.dataset.contextDelayed = 'done';
      }
      return response;
    };
  if (fixture.download)
    bridge.ondownloadfile = async ({ contents }) => {
      document.documentElement.dataset.download = JSON.stringify(contents);
      return {};
    };
  let resourceVersion = 1;
  if (fixture.resourceUpdates) {
    for (const method of ['resources/subscribe', 'resources/unsubscribe']) {
      bridge.setRequestHandler(
        z.object({ method: z.literal(method), params: z.object({ uri: z.string() }) }),
        async ({ params }) => {
          if (params.uri !== fixture.fileResource?.uri) throw new Error('Expected the open URI.');
          document.documentElement.dataset.subscribedFile =
            method === 'resources/subscribe' ? params.uri : '';
          return {};
        },
      );
    }
    new MutationObserver(() => {
      const { dataset } = document.documentElement;
      const uri = dataset.notifyResource;
      if (!uri) return;
      delete dataset.notifyResource;
      void bridge.notification({ method: 'notifications/resources/updated', params: { uri } });
    }).observe(document.documentElement, { attributeFilter: ['data-notify-resource'] });
  }
  bridge.onreadresource = async ({ uri, _meta }) => {
    if (
      uri !== fixture.fileResource?.uri ||
      (_meta?.['openai/resource'] as { representation?: string })?.representation !== 'blob'
    ) {
      throw new Error('Expected a binary read of the file opened by the host.');
    }
    const file = fixture.fileResource;
    const { dataset } = document.documentElement;
    dataset.fileReads = String(Number(dataset.fileReads ?? 0) + 1);
    if (dataset.externalFile) {
      file.blob = dataset.externalFile;
      delete dataset.externalFile;
      resourceVersion++;
    }
    return {
      contents: [
        fixture.writeFile
          ? {
              ...file,
              _meta: { 'openai/resource': { writable: true, etag: String(resourceVersion) } },
            }
          : file,
      ],
    };
  };
  if (fixture.writeFile)
    bridge.setRequestHandler(
      z.object({
        method: z.literal('openai/resources/write'),
        params: z.object({ uri: z.string(), ifMatch: z.string(), blob: z.string() }),
      }),
      async ({ params }) => {
        if (params.uri !== fixture.fileResource.uri)
          throw new Error('Expected the opened file URI.');
        if (
          params.ifMatch !== String(resourceVersion) ||
          document.documentElement.dataset.forceConflict
        )
          return { outcome: 'conflict', etag: String(resourceVersion) };
        fixture.fileResource.blob = params.blob;
        resourceVersion++;
        document.documentElement.dataset.savedFile = params.blob;
        return { outcome: 'saved', etag: String(resourceVersion) };
      },
    );
  bridge.oninitialized = async () => {
    document.documentElement.dataset.appDisplayModes = JSON.stringify(
      bridge.getAppCapabilities()?.availableDisplayModes,
    );
    await bridge.sendToolInput({ arguments: fixture.input });
    await bridge.sendToolResult(fixture.result);
  };
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  const policy =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; style-src 'unsafe-inline'; img-src blob: data:; media-src blob: data:; worker-src blob:; connect-src blob: data:";
  frame.srcdoc = fixture.html.replace(
    '<head>',
    `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`,
  );
}
void start();
