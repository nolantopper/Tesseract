import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { zipSync } from 'fflate';

const source = fileURLToPath(new URL('../', import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const manifest = await readJson(join(source, 'plugin.json'));
const { name, version } = manifest;
const npmPackage = await readJson(join(source, 'package.json'));
assert.equal(name, npmPackage.name);
assert.equal(version, npmPackage.version);
const mcp = (await readJson(join(source, 'mcp.json'))).mcpServers[name];
assert.deepEqual(
  mcp.args,
  ['${PLUGIN_ROOT}/dist/server/index.js', '--root', '${PLUGIN_ROOT}/samples'],
  'Restore the portable sample root in mcp.json before packaging.',
);

const packageFiles = [
  '.agents/plugins/marketplace.json',
  'assets',
  'dist',
  'plugin.json',
  'mcp.json',
  'package.json',
  'package-lock.json',
  'README.md',
  'CONTRIBUTING.md',
  'STYLE_GUIDE.md',
  'THIRD_PARTY.md',
  'LICENSE',
  'licenses',
  'skills',
  'scripts/configure-plugin.mjs',
  'samples/bracket.glb',
  'samples/bracket.stl',
  'samples/robot.mcap',
  'samples/video.mp4',
];

async function smokeTest(root) {
  const expand = (value) => value.replaceAll('${PLUGIN_ROOT}', root);
  const client = new Client({ name: 'tesseract-release-check', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args.map(expand),
    cwd: expand(mcp.cwd),
  });
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), {
      name,
      title: manifest.extensions['com.openai'].interface.displayName,
      version,
    });
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'artifact_viewer'));
    const picker = await client.callTool({ name: 'artifact_viewer', arguments: {} });
    assert.equal(picker.structuredContent?.picker, true);
    const sample = await client.callTool({
      name: 'artifact_open',
      arguments: { path: 'bracket.glb' },
    });
    assert.equal(sample.structuredContent?.artifact?.format?.id, 'glb');
    const blocked = await client.callTool({
      name: 'artifact_open',
      arguments: { path: join(root, 'mcp.json') },
    });
    assert.equal(blocked.isError, true);
    const resource = await client.readResource({ uri: 'ui://tesseract/viewer.html' });
    assert.match(resource.contents[0].text, /<title>Tesseract<\/title>/);
    const parser = await client.callTool({
      name: 'artifact_parser_script',
      arguments: { kind: 'data', offset: 0 },
    });
    assert.ok(parser.structuredContent?.data);
  } finally {
    await client.close();
  }
}

async function collect(directory, prefix, entries) {
  for (const file of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const local = join(directory, file.name);
    const entry = `${prefix}/${file.name}`;
    if (file.isDirectory()) await collect(local, entry, entries);
    else if (file.isFile()) entries[entry] = await readFile(local);
    else throw new Error(`Unexpected entry in release package: ${entry}`);
  }
}

const temporary = await mkdtemp(join(tmpdir(), `${name}-release-`));
try {
  const stage = join(temporary, name);
  for (const file of packageFiles) {
    const output = join(stage, file);
    await mkdir(dirname(output), { recursive: true });
    await cp(join(source, file), output, { recursive: true });
  }
  const install = spawnSync(
    process.execPath,
    [
      process.env.npm_execpath,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-bin-links',
    ],
    { cwd: stage, stdio: 'inherit' },
  );
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error('Could not install release dependencies.');

  await smokeTest(stage);
  const entries = Object.create(null);
  await collect(stage, name, entries);
  const zip = zipSync(entries, { level: 6 });
  const release = join(source, 'release');
  const archive = `${name}-${version}.zip`;
  await mkdir(release, { recursive: true });
  await writeFile(join(release, archive), zip);
  await writeFile(
    join(release, `${archive}.sha256`),
    `${createHash('sha256').update(zip).digest('hex')}  ${archive}\n`,
  );
  console.log(`Packaged and smoke-tested release/${archive}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
