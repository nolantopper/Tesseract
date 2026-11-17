import { zipSync, strToU8 } from 'fflate';
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { mkdtemp, copyFile, readFile, writeFile, rm, open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import { RESOURCE_URI } from '../../src/server/mcp.js';

let client: Client, transport: StdioClientTransport, temp: string;
test.beforeAll(async () => {
  temp = await mkdtemp(resolve(tmpdir(), 'tesseract-browser-'));
  await copyFile(resolve('samples/bracket.stl'), resolve(temp, 'refresh.stl'));
  await copyFile(resolve('test/fixtures/cameras.mcap'), resolve(temp, 'cameras.mcap'));
  await writeFile(
    resolve(temp, 'bundle.zip'),
    zipSync({ 'nested/readme.txt': strToU8('archive contents') }),
  );
  await copyFile(
    resolve('node_modules/occt-import-js/test/testfiles/cax-if/io1-tu-203.stp'),
    resolve(temp, 'part.step'),
  );
  await copyFile(
    resolve('node_modules/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.igs'),
    resolve(temp, 'part.iges'),
  );
  const huge = await openFile(resolve(temp, 'large.glb'), 'w');
  await huge.write(Buffer.from('glTF'));
  await huge.truncate(65 * 1024 * 1024);
  await huge.close();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/server/index.js'), '--root', resolve('samples'), '--root', temp],
    stderr: 'pipe',
  });
  client = new Client({ name: 'tesseract-browser-test', version: '1.0.0' });
  await client.connect(transport);
});
test.afterAll(async () => {
  await client?.close();
  await rm(temp, { recursive: true, force: true });
});
async function open(page: Page, path: string) {
  const result = await client.callTool({ name: 'artifact_open', arguments: { path } });
  expect(result.isError).toBeFalsy();
  const data = result.structuredContent as any;
  await page.goto(data.viewerUrl);
  await expect(page.locator('.filename')).toHaveText(data.artifact.name);
  return data.artifact;
}
async function selectModel(view: Page | FrameLocator, heightFraction = 0.73) {
  const cube = view.getByRole('group', { name: 'View cube' });
  await cube.getByRole('button', { name: 'Front', exact: true }).click();
  await expect(cube.locator('.view-cube-face:visible')).toHaveCount(1);
  const canvas = view.getByLabel('3D model viewport');
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height * heightFraction } });
}
test('STL, GLB, OBJ, and PLY render, orbit, and return object selection to MCP', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const path of ['bracket.stl', 'bracket.glb', 'bracket.obj', 'pyramid.ply']) {
    const artifact = await open(page, path);
    await selectModel(page, path.endsWith('.ply') ? 0.5 : 0.73);
    await expect(page.getByRole('status')).toContainText('available to agent');
    const selected = await client.callTool({
      name: 'artifact_get_selection',
      arguments: { artifactId: artifact.id },
    });
    const selection = (selected.structuredContent as any).selection;
    expect(selection.kind).toBe('object');
    expect(selection.coordinates).toHaveLength(3);
    expect(selection.revision).toBe(artifact.revision);
    await page.mouse.move(600, 350);
    await page.mouse.down();
    await page.mouse.move(650, 390);
    await page.mouse.up();
    await page.mouse.wheel(0, 120);
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/model.png' });
});
test('the view cube snaps to faces, edges, and corners and follows orbit', async ({ page }) => {
  const artifact = await open(page, 'bracket.stl');
  const args = { artifactId: artifact.id };
  const before = await client.callTool({ name: 'artifact_get_selection', arguments: args });
  const cube = page.getByRole('group', { name: 'View cube' });
  const visibleFaces = cube.locator('.view-cube-face:visible');
  for (const name of [
    'Open artifact',
    'Refresh artifact',
    'Fit to view',
    'Perspective',
    'Wireframe',
    'Objects',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await cube.getByRole('button', { name: 'Front', exact: true }).click();
  await expect(visibleFaces).toHaveCount(1);
  await cube.getByRole('button', { name: 'Front / Top edge', exact: true }).click();
  await expect(visibleFaces).toHaveCount(2);
  await expect(cube.getByRole('button', { name: 'Top', exact: true })).toBeVisible();
  await cube.getByRole('button', { name: 'Front / Right / Top corner', exact: true }).click();
  await expect(visibleFaces).toHaveCount(3);
  await cube.getByRole('button', { name: 'Right', exact: true }).click();
  await expect(visibleFaces).toHaveCount(1);
  await cube.getByRole('button', { name: 'Right / Back edge', exact: true }).click();
  await expect(visibleFaces).toHaveCount(2);
  await cube.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(visibleFaces).toHaveCount(1);
  const body = cube.locator('.view-cube-body');
  const beforeOrbit = await body.getAttribute('style');
  await page.mouse.move(600, 350);
  await page.mouse.down();
  await page.mouse.move(720, 405, { steps: 5 });
  await page.mouse.up();
  expect(await body.getAttribute('style')).not.toBe(beforeOrbit);
  const after = await client.callTool({ name: 'artifact_get_selection', arguments: args });
  expect(after.structuredContent).toEqual(before.structuredContent);
});
test('MCAP topics and timeline selection round-trip at nanosecond precision', async ({ page }) => {
  const artifact = await open(page, 'robot.mcap');
  await expect(page.getByText('60 messages', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '/joint_states', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Recording timeline' });
  await slider.fill('5000');
  await slider.dispatchEvent('change');
  await expect(page.getByRole('status')).toContainText('1730000002950000000 ns');
  const result = await client.callTool({
    name: 'artifact_get_selection',
    arguments: { artifactId: artifact.id },
  });
  expect((result.structuredContent as any).selection.timestampNs).toBe('1730000002950000000');
  expect((result.structuredContent as any).selection.channelId).toBe(artifact.mcap.topics[0].id);
  await page.getByText('Recording metadata', { exact: true }).click();
  await expect(page.getByText(/demo-arm/)).toBeVisible();
  await page.screenshot({ path: 'test-results/mcap.png' });
});
test('images, videos, text, and fallback open in the shared interface', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await open(page, 'diagram.svg');
  const image = page.getByRole('img', { name: 'diagram.svg' });
  await expect(image).toBeVisible();
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800);
  const preview = (await page.locator('.media-stage').boundingBox())!;
  const controls = (await page.getByRole('group', { name: 'Image controls' }).boundingBox())!;
  expect(controls.y).toBeGreaterThanOrEqual(preview.y + preview.height);
  await page.screenshot({ path: 'test-results/image-narrow.png' });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await open(page, 'video.mp4');
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0);
  await open(page, 'telemetry.json');
  await expect(page.locator('pre')).toContainText('base_link');
  await page.screenshot({ path: 'test-results/text-narrow.png' });
  await open(page, 'unsupported.step');
  await expect(page.getByRole('alert')).toBeVisible();
});
test('malformed and oversized files fail gracefully and another file still opens', async ({
  page,
}) => {
  await open(page, 'invalid.stl');
  await expect(page.getByRole('alert')).toBeVisible();
  await open(page, 'invalid.mcap');
  await expect(page.getByRole('alert')).toBeVisible();
  await open(page, resolve(temp, 'large.glb'));
  await expect(page.getByRole('alert')).toContainText('64 MiB');
  await open(page, 'telemetry.json');
  await expect(page.locator('pre')).toContainText('base_link');
});
test('file edits refresh without remounting unchanged models or preserving stale selections', async ({
  page,
}) => {
  const artifact = await open(page, resolve(temp, 'refresh.stl'));
  await selectModel(page);
  await expect(page.getByRole('status')).toContainText('available to agent');
  await expect
    .poll(
      async () =>
        (
          await client.callTool({
            name: 'artifact_get_selection',
            arguments: { artifactId: artifact.id },
          })
        ).structuredContent,
    )
    .not.toEqual({ selection: null });
  await writeFile(resolve(temp, 'refresh.stl'), 'broken after edit');
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 10000 });
  const selection = await client.callTool({
    name: 'artifact_get_selection',
    arguments: { artifactId: artifact.id },
  });
  expect((selection.structuredContent as any).selection).toBeNull();
});
async function openEmbedded(
  page: Page,
  fixture: {
    input: Record<string, unknown>;
    result: Awaited<ReturnType<Client['callTool']>>;
    fileResource?: { uri: string; mimeType: string; blob: string };
    boundFilePath?: string;
    theme?: 'light' | 'dark';
    styles?: { variables: Record<string, string> };
  },
) {
  const resource = await client.readResource({ uri: RESOURCE_URI });
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: resolve('test/browser/host.ts'), name: 'TestHost', formats: ['iife'] },
    },
  });
  const bundle = (Array.isArray(output) ? output[0] : output) as any;
  const code = bundle.output[0].code;
  await page.exposeFunction('callMcp', (params: any) =>
    client.callTool(
      fixture.boundFilePath
        ? { ...params, _meta: { 'openai/resource': { path: fixture.boundFilePath } } }
        : params,
    ),
  );
  await page.route('https://tesseract.test/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/fixture')
      await route.fulfill({ json: { ...fixture, html: (resource.contents[0] as any).text } });
    else
      await route.fulfill({
        contentType: 'text/html',
        body: `<html><body><script>${code}</script></body></html>`,
      });
  });
  await page.goto('https://tesseract.test/');
  return page.frameLocator('#app');
}

test('Open Tesseract previews files outside the workspace through the picker and drop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 820 });
  const { tools } = await client.listTools();
  expect(tools.find((tool) => tool.name === 'artifact_viewer')?._meta?.['openai/ui']).toEqual({
    entrypoints: [{ type: 'thread' }],
  });
  const input = {};
  const result = await client.callTool({ name: 'artifact_viewer', arguments: input });
  const frame = await openEmbedded(page, { input, result });
  const openFile = frame.getByRole('button', { name: 'Open file', exact: true });
  const [picker] = await Promise.all([page.waitForEvent('filechooser'), openFile.click()]);
  await picker.setFiles({
    name: 'README.no-extension',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('Personal notes'),
  });
  await expect(frame.getByLabel('Text preview')).toHaveText('Personal notes');

  const dataTransfer = await frame.locator('main').evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.of(0, 255, 16)], 'unrecognized.bin'));
    return transfer;
  });
  await frame.locator('main').dispatchEvent('drop', { dataTransfer });
  await expect(frame.getByLabel('Binary preview')).toContainText('00 ff 10');
  await expect(openFile).toBeVisible();
});
for (const model of ['bracket.glb', 'bracket.stl'])
  test(`embedded MCP App reads ${model} through the host bridge and returns a selection`, async ({
    page,
  }) => {
    const input = { path: model };
    const result = await client.callTool({ name: 'artifact_open', arguments: input });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const frame = await openEmbedded(page, { input, result });
    await selectModel(frame);
    await expect(frame.getByRole('status')).toContainText('available to agent');
    const selected = await client.callTool({
      name: 'artifact_get_selection',
      arguments: { artifactId: (result.structuredContent as any).artifact.id },
    });
    expect((selected.structuredContent as any).selection.kind).toBe('object');
    expect(errors).toEqual([]);
    await page.screenshot({ path: `test-results/embedded-${model.split('.').pop()}.png` });
  });
test('desktop file entrypoint renders the STL resource handed off by the host', async ({
  page,
}) => {
  const { tools } = await client.listTools();
  expect(tools.find((tool) => tool.name === 'artifact_open_stl')?._meta).toMatchObject({
    ui: { resourceUri: RESOURCE_URI, visibility: ['app'] },
    'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.stl'] }] },
  });
  const file = { name: 'bracket.STL', resourceUri: 'host-resource://opened-bracket' };
  const input = { file };
  const result = await client.callTool({ name: 'artifact_open_stl', arguments: input });
  expect(result.isError).toBeFalsy();
  const blob = await readFile(resolve('samples/bracket.stl'), 'base64');
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: file.resourceUri,
      mimeType: 'model/stl',
      blob,
    },
  });
  await expect(frame.locator('.filename')).toHaveText(file.name);
  await selectModel(frame);
  await expect(frame.getByRole('status')).toContainText('Local selection');
});

test('PCD point clouds render and expose selected source coordinates to MCP', async ({ page }) => {
  const artifact = await open(page, 'scan.pcd');
  await expect(page.locator('.dimensions')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await selectModel(page, 0.5);
  await expect(page.getByRole('status')).toContainText('available to agent');
  const result = await client.callTool({
    name: 'artifact_get_selection',
    arguments: { artifactId: artifact.id },
  });
  const selection = (result.structuredContent as any).selection;
  expect(selection.kind).toBe('object');
  expect(selection.objectName).toBe('Point cloud');
  expect(selection.coordinates).toHaveLength(3);
});

test('folders and ZIP entries can be browsed and previewed', async ({ page }) => {
  await open(page, '.');
  await page.getByRole('button', { name: 'telemetry.json', exact: true }).click();
  await expect(page.locator('pre')).toContainText('base_link');
  await page.setViewportSize({ width: 390, height: 820 });
  await open(page, resolve(temp, 'bundle.zip'));
  const filter = page.getByRole('searchbox', { name: 'Filter entries' });
  await filter.fill('missing');
  await expect(page.getByText('No matching files')).toBeVisible();
  await filter.fill('readme');
  const entry = page.getByRole('button', { name: 'nested/readme.txt', exact: true });
  await entry.click();
  await expect(entry).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('pre')).toContainText('archive contents');
  const list = (await page.getByRole('complementary', { name: 'Files' }).boundingBox())!;
  const preview = (await page.locator('pre').boundingBox())!;
  expect(preview.y).toBeGreaterThanOrEqual(list.y + list.height);
  expect(preview.width).toBeGreaterThan(340);
  await page.screenshot({ path: 'test-results/archive-narrow.png' });
});
test('STEP tessellation renders using the bundled CAD decoder', async ({ page }) => {
  for (const name of ['part.step', 'part.iges']) {
    await open(page, resolve(temp, name));
    await expect(page.locator('.dimensions')).toBeVisible({ timeout: 25000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});
test('scientific data and ROS message readers inspect real fixtures', async ({ page }) => {
  for (const [path, expected] of [
    ['array.npy', 'row-major'],
    ['datasets.h5', 'temperature'],
    ['climate.nc', 'temperature'],
    ['scan.e57', 'e57Root'],
    ['telemetry.bag', '/temperature'],
  ]) {
    await open(page, `scientific/${path}`);
    await expect(page.locator('pre').first()).toContainText(expected, { timeout: 25000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});
test('LAS, compressed LAZ and VTK meshes render', async ({ page }) => {
  for (const name of ['points.las', 'points.laz', 'surface.vtk', 'surface.vtp']) {
    await open(page, `scientific/${name}`);
    await expect(page.locator('.dimensions')).toBeVisible({ timeout: 25000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});
test('MCAP JSON messages are decoded on demand', async ({ page }) => {
  await open(page, 'robot.mcap');
  await page.getByRole('button', { name: 'Decoded message preview' }).click();
  await expect(page.locator('.text-view pre').first()).toContainText('frame');
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect(page.getByRole('slider', { name: 'Message preview index' })).not.toHaveValue('0');
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await page.getByRole('button', { name: 'Select message timestamp' }).click();
  await expect(page.getByRole('status')).toContainText('available to agent');
  await page.locator('.message-view').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/messages.png' });
});
for (const name of ['robot.mcap', 'pyramid.ply'])
  test(`native file handoff opens ${name} without loopback access`, async ({ page }) => {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'artifact_open_file')?._meta).toMatchObject({
      'openai/ui': {
        entrypoints: [{ type: 'file', extensions: expect.arrayContaining(['.mcap', '.ply']) }],
      },
    });
    const input = { file: { name, resourceUri: `host-resource://${name}` } };
    const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
    expect(result.isError).toBeFalsy();
    const frame = await openEmbedded(page, {
      input,
      result,
      fileResource: {
        uri: input.file.resourceUri,
        mimeType: 'application/octet-stream',
        blob: await readFile(resolve('samples', name), 'base64'),
      },
    });
    await expect(frame.locator('.filename')).toHaveText(name);
    if (name.endsWith('.mcap')) {
      await expect(frame.getByRole('slider', { name: 'Recording timeline' })).toBeVisible();
      await frame.getByRole('slider', { name: 'Recording timeline' }).fill('5000');
      await expect(frame.getByRole('status')).toContainText('Local selection');
    } else await expect(frame.locator('.dimensions')).toBeVisible();
    await expect(frame.getByRole('alert')).toHaveCount(0);
  });

test('file registrations cover specialized formats and preserve Codex viewers', async () => {
  const { tools } = await client.listTools();
  const ui = tools.find((tool) => tool.name === 'artifact_open_file')?._meta?.['openai/ui'];
  expect(ui).toMatchObject({
    entrypoints: [
      {
        type: 'file',
        extensions: expect.arrayContaining([
          '.step',
          '.stp',
          '.iges',
          '.igs',
          '.laz',
          '.npy',
          '.h5',
          '.hdf5',
          '.nc',
          '.netcdf',
          '.bag',
          '.e57',
          '.mov',
          '.qt',
          '.m4v',
          '.mkv',
          '.3gp',
          '.3g2',
          '.weba',
          '.mka',
          '.gltf',
          '.tgz',
          '.whl',
        ]),
      },
    ],
  });
  const extensions = (ui as { entrypoints: { extensions: string[] }[] }).entrypoints[0].extensions;
  for (const extension of [
    '.stl',
    '.mp4',
    '.webm',
    '.ogv',
    '.mp3',
    '.png',
    '.pdf',
    '.md',
    '.csv',
  ]) {
    expect(extensions).not.toContain(extension);
  }
});

test('native panel plays a QuickTime file handed off as generic binary', async ({ page }) => {
  const input = { file: { name: 'quicktime.MOV', resourceUri: 'host-resource://quicktime' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  expect(result.isError).toBeFalsy();
  // Remuxed from samples/video.mp4 using avconvert's PresetPassthrough.
  const blob = await readFile(resolve('test/fixtures/quicktime.mov'), 'base64');
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: { uri: input.file.resourceUri, mimeType: 'application/octet-stream', blob },
  });
  const video = frame.locator('video');
  await expect(video).toBeVisible();
  await video.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    return element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);
});

test('native panel renders glTF with an embedded mesh', async ({ page }) => {
  const glb = await readFile(resolve('samples/bracket.glb'));
  const jsonEnd = 20 + glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString('utf8', 20, jsonEnd));
  gltf.buffers[0].uri = `data:application/octet-stream;base64,${glb.subarray(jsonEnd + 8).toString('base64')}`;
  const input = { file: { name: 'bracket.gltf', resourceUri: 'host-resource://bracket.gltf' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  expect(result.isError).toBeFalsy();
  const blob = Buffer.from(JSON.stringify(gltf)).toString('base64');
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: { uri: input.file.resourceUri, mimeType: 'model/gltf+json', blob },
  });
  await expect(frame.locator('.dimensions')).toBeVisible();
});

for (const [path, preview] of [
  ['part.step', 'dimensions'],
  ['part.iges', 'dimensions'],
  ['points.laz', 'dimensions'],
  ['array.npy', 'row-major'],
  ['climate.nc', 'temperature'],
  ['datasets.h5', 'temperature'],
  ['scan.e57', 'e57Root'],
  ['telemetry.bag', '/temperature'],
])
  test(`native panel previews ${path}`, async ({ page }) => {
    const source = path.startsWith('part.')
      ? resolve(temp, path)
      : resolve('samples/scientific', path);
    const input = { file: { name: path, resourceUri: `host-resource://${path}` } };
    const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
    expect(result.isError).toBeFalsy();
    const frame = await openEmbedded(page, {
      input,
      result,
      fileResource: {
        uri: input.file.resourceUri,
        mimeType: 'application/octet-stream',
        blob: await readFile(source, 'base64'),
      },
    });
    if (preview === 'dimensions') await expect(frame.locator('.dimensions')).toBeVisible();
    else await expect(frame.locator('pre').first()).toContainText(preview);
    await expect(frame.getByRole('alert')).toHaveCount(0);
  });

test('native host blob plays the synthetic recording with zstd chunks', async ({ page }) => {
  const bytes = await readFile(resolve(temp, 'cameras.mcap'));
  const input = { file: { name: 'cameras.mcap', resourceUri: 'host-resource://cameras' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'application/octet-stream',
      blob: bytes.toString('base64'),
    },
  });
  await expect(frame.locator('.filename')).toHaveText(input.file.name);
  await expect(frame.locator('.recording-summary')).toHaveText(
    '2 topics40 messages1.900 sMCAP · indexed',
  );
  await expect(frame.getByRole('button', { name: '/camera/side', exact: true })).toBeVisible();
  await expect(frame.getByRole('slider', { name: 'Recording timeline' })).toHaveCount(0);
  await expect(frame.getByText('Timestamp', { exact: true })).toHaveCount(0);
  await expect(frame.getByRole('alert')).toHaveCount(0);
  await checkCameraPlayback(frame);
  await page.screenshot({ path: 'test-results/native-camera-summary.png' });
});

test('native panel shares timestamps from a narrow side panel', async ({ page }) => {
  const path = resolve(temp, 'cameras.mcap');
  await page.setViewportSize({ width: 390, height: 820 });
  const input = { file: { name: 'cameras.mcap', resourceUri: 'host-resource://narrow-cameras' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    boundFilePath: path,
    theme: 'light',
    styles: {
      variables: { '--color-background-primary': '#fdfbf9', '--color-text-primary': '#252525' },
    },
  });
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgb(253, 251, 249)');
  await expect(frame.getByRole('button', { name: 'Play recording' })).toBeEnabled();
  const picker = frame.getByRole('combobox', { name: 'Camera channel' });
  await picker.press('Space');
  await expect.poll(() => picker.evaluate((el) => el.matches(':open'))).toBe(true);
  await page.screenshot({ path: 'test-results/native-camera-menu.png' });
  await picker.press('Escape');
  await expect(picker).toBeFocused();
  const controls = await frame.locator('.camera-controls').boundingBox();
  expect(controls!.width).toBeLessThan(390);
  for (const name of ['Play recording', 'Select video timestamp']) {
    const button = frame.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const bounds = (await button.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  }
  await checkCameraPlayback(frame);
  const inspection = await client.callTool({ name: 'artifact_inspect', arguments: { path } });
  const artifactId = (inspection.structuredContent as any).artifact.id;
  const selection = await client.callTool({
    name: 'artifact_get_selection',
    arguments: { artifactId },
  });
  expect(selection.structuredContent?.selection).toMatchObject({
    timestampNs: '42100000000',
    channelId: 1,
  });
  await page.screenshot({ path: 'test-results/native-camera-narrow-light.png' });
});

async function checkCameraPlayback(view: Page | FrameLocator) {
  const canvas = view.getByLabel('Recorded camera video');
  await expect(canvas).toHaveAttribute('data-frame-timestamp-ns', '42000000000');
  const fingerprint = () =>
    canvas.evaluate((c: HTMLCanvasElement) => {
      const p = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < p.length; i += 4)
        sum = (sum + p[i] * (i + 1) + p[i + 1] * 3 + p[i + 2] * 7) % 2147483647;
      return sum;
    });
  expect(await fingerprint()).toBeGreaterThan(0);
  await view.getByRole('button', { name: 'Play recording', exact: true }).click();
  const seek = view.getByRole('slider', { name: 'Video seek' });
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(0.25);
  await expect
    .poll(async () => BigInt((await canvas.getAttribute('data-frame-timestamp-ns'))!))
    .toBeGreaterThan(42200000000n);
  await view.getByRole('button', { name: 'Pause recording', exact: true }).click();
  const paused = await seek.inputValue();
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(await seek.inputValue()).toBe(paused);
  await seek.fill('0.525');
  await expect(canvas).toHaveAttribute('data-frame-timestamp-ns', '42500000000');
  const cameraPixels = await fingerprint();
  await view
    .getByRole('combobox', { name: 'Camera channel' })
    .selectOption({ label: '/camera/side' });
  await expect(canvas).toHaveAttribute('data-camera', '/camera/side');
  await expect(canvas).toHaveAttribute('data-frame-timestamp-ns', '42500000000');
  await expect.poll(fingerprint).not.toBe(cameraPixels);
  await seek.fill('0.125');
  await expect(canvas).toHaveAttribute('data-frame-timestamp-ns', '42100000000');
  await view.getByRole('button', { name: 'Select video timestamp' }).click();
  await expect(seek).toHaveValue('0.1');
  await expect(view.getByRole('alert')).toHaveCount(0);
}

test('camera video plays, pauses, seeks and switches cameras in the local viewer', async ({
  page,
}) => {
  const artifact = await open(page, resolve(temp, 'cameras.mcap'));
  await checkCameraPlayback(page);
  const result = await client.callTool({
    name: 'artifact_get_selection',
    arguments: { artifactId: artifact.id },
  });
  expect(result.structuredContent?.selection).toMatchObject({
    timestampNs: '42100000000',
    channelId: 1,
  });
  await page.screenshot({ path: 'test-results/camera-video-playback.png' });
});

test('camera video reports when the host has no WebCodecs decoder', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'VideoDecoder', { value: undefined });
  });
  await open(page, resolve(temp, 'cameras.mcap'));
  await expect(page.getByRole('alert')).toContainText('does not expose WebCodecs');
  await expect(page.getByRole('button', { name: 'Play recording', exact: true })).toBeDisabled();
});
