import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FileAccess } from './files.js';
import { ArtifactStore } from './store.js';
import { startHttp } from './http.js';
import { createMcpServer } from './mcp.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string', multiple: true },
    port: { type: 'string' },
    web: { type: 'boolean' },
    file: { type: 'string' },
  },
});
const port = Number(values.port ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
const store = new ArtifactStore(await FileAccess.create(values.root ?? [process.cwd()]));
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, import.meta.url.endsWith('.ts') ? '../../dist' : '..');
const http = await startHttp(store, resolve(dist, 'web'), port);
if (values.web) {
  const artifact = values.file ? await store.inspect(values.file) : undefined;
  console.log(http.viewerUrl(artifact?.id));
} else {
  const mcp = createMcpServer(store, http.viewerUrl, resolve(dist, 'embedded/index.html'));
  const transport = new StdioServerTransport();
  mcp.server.onclose = () => {
    void http.close();
  };
  await mcp.connect(transport);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void http.close().finally(() => process.exit(0));
  });
