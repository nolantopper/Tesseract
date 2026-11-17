import { realpath, readFile, writeFile } from 'node:fs/promises';
const roots = await Promise.all(process.argv.slice(2).map((root) => realpath(root)));
if (!roots.length)
  throw new Error('Usage: node scripts/configure-plugin.mjs /absolute/workspace [additional-root]');
const file = new URL('../mcp.json', import.meta.url);
const config = JSON.parse(await readFile(file, 'utf8'));
config.mcpServers.tesseract.args = [
  '${PLUGIN_ROOT}/dist/server/index.js',
  ...roots.flatMap((root) => ['--root', root]),
];
await writeFile(file, JSON.stringify(config, null, 2) + '\n');
console.log('Plugin workspace roots configured:', roots.join(', '));
