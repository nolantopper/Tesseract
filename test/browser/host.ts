// Test-only MCP Apps host. Uses the official bridge; never shipped in the viewer.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

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
  frame.style.cssText = 'width:100%;height:100vh;border:0;display:block';
  document.body.style.margin = '0';
  document.body.appendChild(frame);
  const bridge = new AppBridge(
    null,
    { name: 'Tesseract test host', version: '1.0.0' },
    {
      serverTools: {},
      experimental: fixture.fileResource ? { 'openai/resource': {} } : undefined,
    },
    {
      hostContext: {
        theme: fixture.theme ?? 'dark',
        styles: fixture.styles,
        displayMode: 'inline',
      },
    },
  );
  bridge.oncalltool = (params) => window.callMcp(params);
  bridge.onreadresource = async ({ uri, _meta }) => {
    if (
      uri !== fixture.fileResource?.uri ||
      (_meta?.['openai/resource'] as { representation?: string })?.representation !== 'blob'
    ) {
      throw new Error('Expected a binary read of the file opened by the host.');
    }
    return { contents: [fixture.fileResource] };
  };
  bridge.oninitialized = async () => {
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
