import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FileAccess } from './files.js';
import { ArtifactStore } from './store.js';
import { createMcpServer } from './mcp.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string', multiple: true },
  },
});
const store = new ArtifactStore(await FileAccess.create(values.root ?? [process.cwd()]));
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, import.meta.url.endsWith('.ts') ? '../../dist' : '..');
const mcp = createMcpServer(store, resolve(dist, 'embedded/index.html'));
await mcp.connect(new StdioServerTransport());
