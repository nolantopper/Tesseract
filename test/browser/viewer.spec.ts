import { zipSync, strToU8, unzipSync } from 'fflate';
import { test, expect, type Page, type FrameLocator, type Locator } from '@playwright/test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  copyFile,
  readFile,
  writeFile,
  mkdir,
  rm,
  open as openFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import { RESOURCE_URI } from '../../src/server/mcp.js';
import { viewIdentity, type ViewAction, type ViewIdentity } from '../../src/shared/view.js';

let client: Client, transport: StdioClientTransport, temp: string;
test.beforeAll(async () => {
  temp = await mkdtemp(resolve(tmpdir(), 'tesseract-browser-'));
  await copyFile(resolve('samples/bracket.stl'), resolve(temp, 'refresh.stl'));
  await copyFile(resolve('test/fixtures/cameras.mcap'), resolve(temp, 'cameras.mcap'));
  await writeFile(
    resolve(temp, 'bundle.zip'),
    zipSync({ 'nested/readme.txt': strToU8('archive contents') }),
  );
  const models = {
    'bracket.stl': await readFile(resolve('samples/bracket.stl')),
    'bench-vise.glb': await readFile(resolve('samples/bench-vise.glb')),
  };
  await writeFile(
    resolve(temp, 'models.zip'),
    zipSync({ ...models, 'nested.zip': zipSync(models) }),
  );
  await copyFile(resolve('test/fixtures/simulation/usd-crate.usdc'), resolve(temp, 'scene.usdc'));
  await writeFile(
    resolve(temp, 'workcell.usdz'),
    zipSync(
      {
        'scene.usda': await readFile(resolve('samples/simulation/workcell.usda')),
      },
      { level: 0 },
    ),
  );
  const simulationAssets = {
    'models/robot.urdf': Buffer.from(
      (await readFile(resolve('samples/simulation/robot.urdf'), 'utf8')).replace(
        'meshes/tool.obj',
        '../meshes/tool.obj',
      ),
    ),
    'meshes/tool.obj': await readFile(resolve('samples/simulation/meshes/tool.obj')),
    'scenes/workcell.usda': await readFile(resolve('samples/simulation/workcell.usda')),
    'scenes/reference.usda': Buffer.from(
      '#usda 1.0\ndef Xform "Referenced_workcell" (\n prepend references = @../scenes/workcell.usda@\n)\n{\n}\n',
    ),
  };
  await writeFile(
    resolve(temp, 'simulation.zip'),
    zipSync({
      ...simulationAssets,
      'nested.zip': zipSync(simulationAssets),
    }),
  );
  await writeFile(
    resolve(temp, 'missing-assets.zip'),
    zipSync({ 'models/robot.urdf': simulationAssets['models/robot.urdf'] }),
  );
  const glbSource = await readFile(resolve('samples/bracket.glb'));
  const jsonLength = glbSource.readUInt32LE(12);
  const gltf = JSON.parse(glbSource.subarray(20, 20 + jsonLength).toString());
  gltf.buffers[0].uri = 'geometry.bin';
  await mkdir(resolve(temp, 'linked-gltf'));
  await writeFile(resolve(temp, 'linked-gltf/scene.gltf'), JSON.stringify(gltf));
  await writeFile(resolve(temp, 'linked-gltf/geometry.bin'), glbSource.subarray(28 + jsonLength));
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
    env: process.env.TESSERACT_FFMPEG
      ? { TESSERACT_FFMPEG: process.env.TESSERACT_FFMPEG }
      : undefined,
  });
  client = new Client({ name: 'tesseract-browser-test', version: '1.0.0' });
  await client.connect(transport);
});
test.afterAll(async () => {
  await client?.close();
  await rm(temp, { recursive: true, force: true });
});
async function open(page: Page, path: string, chatContext = false) {
  const result = await client.callTool({ name: 'artifact_open', arguments: { path } });
  expect(result.isError).toBeFalsy();
  const data = result.structuredContent as any;
  const frame = await openEmbedded(page, { input: { path }, result, chatContext });
  await expect(frame.locator('main')).toHaveAccessibleName(data.artifact.name);
  return data.artifact;
}
const readyModel = '.model-view[aria-busy="false"] canvas';
async function frontView(frame: FrameLocator) {
  const canvas = frame.locator(readyModel);
  await expect(canvas).toBeVisible();
  await canvas.press('1');
  return canvas;
}
async function selectModel(view: FrameLocator, heightFraction = 0.73) {
  const canvas = await frontView(view);
  const bounds = (await canvas.boundingBox())!;
  const position = { x: bounds.width / 2, y: bounds.height * heightFraction };
  await canvas.click({ position });
  await expect(canvas).toHaveAttribute('data-selected-part', /^object-/);
  return { canvas, position };
}

async function getSelection(artifactId: string) {
  const result = await client.callTool({
    name: 'artifact_get_selection',
    arguments: { artifactId },
  });
  expect(result.isError).toBeFalsy();
  return result.structuredContent?.selection;
}

async function pickVisiblePart(frame: FrameLocator, face = false) {
  const canvas = await frontView(frame);
  const bounds = (await canvas.boundingBox())!;
  for (const [x, y] of [
    [0.5, 0.5],
    [0.4, 0.5],
    [0.5, 0.65],
    [0.5, 0.6],
    [0.5, 0.35],
    [0.5, 0.7],
    [0.3, 0.5],
    [0.7, 0.5],
    [0.35, 0.7],
    [0.5, 0.8],
  ]) {
    const position = { x: bounds.width * x, y: bounds.height * y };
    await canvas.click({ position, modifiers: face ? ['Alt'] : [] });
    if (await canvas.getAttribute('data-selected-part')) return { canvas, position };
  }
  throw new Error('No model part was selectable.');
}

for (const [file, name] of [
  ['samples/simulation/workcell.usda', 'workcell.usda'],
  ['test/fixtures/simulation/usd-crate.usdc', 'scene.usdc'],
  ['USDZ', 'workcell.usdz'],
  ['test/fixtures/simulation/sim-arm.urdf', 'arm.urdf'],
  ['samples/simulation/world.sdf', 'world.sdf'],
  ['samples/simulation/scene.xml', 'scene.mjcf'],
  ['samples/simulation/meshes/triangle.dae', 'triangle.dae'],
]) {
  test(`simulation asset ${name} renders, navigates, and shares selected visual context`, async ({
    page,
  }) => {
    const source = file === 'USDZ' ? resolve(temp, name) : resolve(file);
    const input = { file: { name, resourceUri: `host-resource://${name}` } };
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
      chatContext: true,
      imageContext: true,
      contextLifecycle: true,
    });
    await expect(frame.locator(readyModel)).toBeVisible();
    await expect(frame.getByRole('alert')).toHaveCount(0);
    await expect(frame.getByText('Preview details', { exact: true })).toHaveCount(0);
    const { canvas, position } = await pickVisiblePart(frame);
    const id = await canvas.getAttribute('data-selected-part');
    await expect(page.locator('html')).not.toHaveAttribute('data-chat-context', /"viewId"/);
    await canvas.dblclick({ position });
    const identity = await readPanelReference(page, frame);
    const context = await getVisualContext(identity);
    expect(context).toMatchObject({
      imageMatchesSnapshot: true,
      snapshot: { context: { kind: 'model' }, selected: { objectId: id } },
    });
    expect(context.image).toBeTruthy();
    await expect(canvas).toHaveAttribute('data-chat-parts', id!);
    await canvas.press('0');
    await canvas.screenshot({ path: `test-results/simulation-${name}.png` });
    await page.getByRole('button', { name: 'Remove context', exact: true }).click();
    await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
    await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
  });
}

test('IFC faces share distinct context on the same part and clear independently', async ({
  page,
}) => {
  const name = 'block.ifc';
  const input = { file: { name, resourceUri: `host-resource://${name}` } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'application/octet-stream',
      blob: await readFile(resolve('test/fixtures/geometry/block.ifc'), 'base64'),
    },
    chatContext: true,
    imageContext: true,
    contextLifecycle: true,
    theme: 'dark',
    styles: {
      variables: {
        '--color-background-primary': '#181819',
        '--color-background-secondary': '#343434',
      },
    },
  });
  await expect(frame.getByRole('button', { name: 'Faces', exact: true })).toHaveCount(0);
  const { canvas, position } = await pickVisiblePart(frame, true);
  const front = (await canvas.getAttribute('data-selected-part'))!;
  expect(front).toMatch(/^object-\d+\/planar\/\d+$/);
  await expect(frame.getByRole('group', { name: 'View cube' })).toHaveCount(0);
  expect(await canvas.boundingBox()).toEqual(
    await frame.getByRole('region', { name: 'Artifact preview' }).boundingBox(),
  );
  const background = await page.evaluate(
    async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const sample = document.createElement('canvas').getContext('2d')!;
      sample.drawImage(image, 0, 0);
      return [...sample.getImageData(8, 8, 1, 1).data];
    },
    (await canvas.screenshot()).toString('base64'),
  );
  expect(background).toEqual([24, 24, 25, 255]);
  await expect(canvas).toHaveCSS('outline-style', 'none');
  await canvas.press('ArrowRight');
  await expect(canvas).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('html')).not.toHaveAttribute('data-chat-context', /"viewId"/);
  await canvas.dblclick({ position, modifiers: ['Alt'] });
  await expect(canvas).toHaveCSS('outline-style', 'none');
  const identity = await readPanelReference(page, frame);
  await expect(canvas).toHaveAttribute('data-chat-parts', front);
  expect(await getVisualContext(identity)).toMatchObject({
    imageMatchesSnapshot: true,
    snapshot: {
      selected: { face: { kind: 'planar', triangleCount: 2, normal: expect.any(Array) } },
    },
  });
  await canvas.press('5');
  const size = (await canvas.boundingBox())!;
  const topPosition = { x: size.width / 2, y: size.height / 2 };
  await canvas.click({ position: topPosition, modifiers: ['Alt'] });
  const top = (await canvas.getAttribute('data-selected-part'))!;
  expect(top.split('/')[0]).toEqual(front.split('/')[0]);
  expect(top).not.toEqual(front);
  await canvas.dblclick({ position: topPosition, modifiers: ['Alt'] });
  await expect(canvas).toHaveAttribute('data-chat-parts', `${front} ${top}`);
  await expect
    .poll(async () => (await getView(identity))?.snapshot)
    .toMatchObject({
      selected: {
        parts: [
          { objectId: front.split('/')[0], face: { index: Number(front.split('/')[2]) } },
          { objectId: top.split('/')[0], face: { index: Number(top.split('/')[2]) } },
        ],
      },
    });
  await canvas.screenshot({ path: 'test-results/ifc-faces.png' });
  await canvas.dblclick({ position: topPosition, modifiers: ['Alt'] });
  await expect(canvas).toHaveAttribute('data-chat-parts', front);
  await page.getByRole('button', { name: 'Remove context', exact: true }).click();
  await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
});

test('dragging a URDF link poses its joint and keeps chat synchronized', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 640 });
  const name = 'arm.urdf';
  const input = { file: { name, resourceUri: `host-resource://${name}` } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'application/octet-stream',
      blob: await readFile(resolve('test/fixtures/simulation/sim-arm.urdf'), 'base64'),
    },
    chatContext: true,
    imageContext: true,
    contextLifecycle: true,
  });
  const { canvas } = await pickVisiblePart(frame);
  await expect(frame.getByRole('slider')).toHaveCount(0);
  await expect(canvas).toHaveAttribute('aria-keyshortcuts', /PageDown/);
  const bounds = (await canvas.boundingBox())!;
  let position = { x: bounds.width * 0.56, y: 0 };
  for (const y of [0.41, 0.43, 0.39, 0.45, 0.37]) {
    position = { x: bounds.width * 0.56, y: bounds.height * y };
    await canvas.click({ position });
    if ((await canvas.getAttribute('data-selected-part')) === 'object-2') break;
  }
  await expect(canvas).toHaveAttribute('data-selected-part', 'object-2');
  await canvas.dblclick({ position });
  const identity = await readPanelReference(page, frame);
  const readPose = async () => {
    const snapshot = (await getView(identity))?.snapshot as {
      context?: { joints?: { value: number }[] };
    };
    return snapshot.context?.joints?.[1]?.value ?? 0;
  };
  expect((await getView(identity))?.snapshot).toMatchObject({
    context: {
      joints: [
        { id: 'joint-0', name: 'Base joint', value: 0, unit: 'rad' },
        { id: 'joint-1', name: 'Elbow joint', value: 0, unit: 'rad' },
      ],
    },
  });
  const screenshot = () => canvas.screenshot({ style: 'canvas { outline: none !important; }' });
  const home = await screenshot();
  const x = bounds.x + position.x;
  const y = bounds.y + position.y;
  await page.mouse.move(x, y);
  await expect(canvas).toHaveCSS('cursor', 'grab');
  await page.mouse.down();
  await page.mouse.move(x, y + 44, { steps: 10 });
  await expect(canvas).toHaveCSS('cursor', 'grabbing');
  await page.mouse.up();
  await expect.poll(readPose).toBeGreaterThan(0.1);
  expect(await screenshot()).not.toEqual(home);
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-2');

  await canvas.press('r');
  await expect.poll(readPose).toBe(0);
  expect(await screenshot()).toEqual(home);
  await canvas.press('ArrowRight');
  await expect.poll(readPose).toBeCloseTo(Math.PI / 36);
  const beforeOrbit = await screenshot();
  await page.mouse.move(bounds.x + 20, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 75, bounds.y + 53, { steps: 6 });
  await page.mouse.up();
  expect(await screenshot()).not.toEqual(beforeOrbit);
  expect(await readPose()).toBeCloseTo(Math.PI / 36);

  await changeView(identity, { kind: 'set_joint', jointId: 'joint-1', value: Math.PI / 4 });
  await expect
    .poll(async () => (await getView(identity))?.snapshot)
    .toMatchObject({
      context: { joints: [expect.any(Object), { id: 'joint-1', value: Math.PI / 4 }] },
    });
  await frame.locator('.model-view').screenshot({ path: 'test-results/posed-urdf.png' });
});

test('simulation folder and ZIP imports resolve meshes, layer references and external glTF buffers', async ({
  page,
}) => {
  const paths = [
    { path: resolve('samples/simulation'), entry: 'robot.urdf' },
    { path: resolve(temp, 'simulation.zip'), entry: 'models/robot.urdf' },
    { path: resolve(temp, 'simulation.zip'), entry: 'scenes/reference.usda' },
    { path: resolve(temp, 'linked-gltf'), entry: 'scene.gltf' },
  ];
  for (const { path, entry } of paths) {
    const result = await client.callTool({ name: 'artifact_open', arguments: { path } });
    const frame = await openEmbedded(page, {
      input: { path },
      result,
      chatContext: true,
      imageContext: true,
    });
    await frame.getByRole('searchbox', { name: 'Filter entries' }).fill(entry);
    await frame.getByRole('button', { name: entry, exact: true }).click();
    await expect(frame.locator(readyModel)).toBeVisible();
    await expect(frame.getByRole('alert')).toHaveCount(0);
    const { canvas, position } = await pickVisiblePart(frame);
    await canvas.dblclick({ position });
    const identity = await readPanelReference(page, frame);
    expect((await getVisualContext(identity)).image).toBeTruthy();
  }
});

test('breadcrumbs return from models, filtered paths, and nested archives', async ({ page }) => {
  const frame = page.frameLocator('#app');
  await open(page, resolve(temp, 'simulation.zip'));
  const filter = frame.getByRole('searchbox', { name: 'Filter entries' });
  await filter.fill('models/robot.urdf');
  await frame.getByRole('button', { name: 'models/robot.urdf', exact: true }).click();
  await expect(frame.locator(readyModel)).toBeVisible();
  const nav = frame.getByRole('navigation', { name: 'Folder location' });
  await expect(nav).toContainText('robot.urdf');
  await nav.getByRole('button', { name: 'models', exact: true }).click();
  await expect(frame.getByLabel('3D model viewport')).toHaveCount(0);
  await expect(frame.getByRole('button', { name: 'robot.urdf', exact: true })).toBeFocused();
  await nav.getByRole('button', { name: 'simulation.zip', exact: true }).click();
  await frame.getByRole('button', { name: 'nested.zip', exact: true }).click();
  await expect(frame.getByRole('navigation', { name: 'Folder location' })).toContainText(
    'nested.zip',
  );
  const innerFiles = frame.getByRole('complementary', { name: 'Files' }).last();
  await innerFiles.getByRole('searchbox', { name: 'Filter entries' }).fill('scenes/workcell.usda');
  await innerFiles.getByRole('button', { name: 'scenes/workcell.usda', exact: true }).click();
  await expect(frame.locator(readyModel)).toBeVisible();
  const nestedNav = frame.getByRole('navigation', { name: 'Folder location' });
  await expect(nestedNav).toContainText('nested.zip');
  await nestedNav.getByRole('button', { name: 'simulation.zip', exact: true }).click();
  await expect(frame.getByLabel('3D model viewport')).toHaveCount(0);
  await expect(frame.getByRole('button', { name: 'nested.zip', exact: true })).toBeFocused();
  await expect(frame.getByRole('navigation', { name: 'Folder location' })).toContainText(
    'simulation.zip',
  );
});

test('missing simulation dependencies fail clearly and another asset still opens', async ({
  page,
}) => {
  const frame = page.frameLocator('#app');
  await open(page, resolve(temp, 'missing-assets.zip'));
  await frame.getByRole('searchbox', { name: 'Filter entries' }).fill('robot.urdf');
  await frame.getByRole('button', { name: 'models/robot.urdf', exact: true }).click();
  await expect(frame.getByRole('alert')).toContainText(/Missing|missing/);
  await open(page, 'simulation/workcell.usda');
  await expect(frame.locator(readyModel)).toBeVisible();
  await expect(frame.getByRole('alert')).toHaveCount(0);
});

test('native workspace robot handoff resolves linked meshes without expanding file access', async ({
  page,
}) => {
  const source = resolve('samples/simulation/robot.urdf');
  const input = { file: { name: 'robot.urdf', resourceUri: 'host-resource://robot.urdf' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    boundFilePath: source,
    chatContext: true,
    imageContext: true,
  });
  await expect(frame.locator(readyModel)).toBeVisible();
  await expect(frame.getByRole('alert')).toHaveCount(0);
  const { canvas, position } = await pickVisiblePart(frame);
  await canvas.dblclick({ position });
  const identity = await readPanelReference(page, frame);
  const view = await getVisualContext(identity);
  expect(view.snapshot.context.objects.length).toBe(3);
  expect(view.image).toBeTruthy();
});
test('STL, GLB, OBJ, and PLY render, orbit, and return object selection to MCP', async ({
  page,
}) => {
  const frame = page.frameLocator('#app');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const path of ['bracket.stl', 'bracket.glb', 'bracket.obj', 'pyramid.ply']) {
    const artifact = await open(page, path);
    await selectModel(frame, path.endsWith('.ply') ? 0.5 : 0.73);
    await expect
      .poll(() => getSelection(artifact.id))
      .toMatchObject({
        kind: 'object',
        revision: artifact.revision,
        coordinates: [expect.any(Number), expect.any(Number), expect.any(Number)],
      });
    await page.mouse.move(600, 350);
    await page.mouse.down();
    await page.mouse.move(650, 390);
    await page.mouse.up();
    await page.mouse.wheel(0, 120);
    const canvas = frame.getByLabel('3D model viewport');
    await expect(canvas).toHaveAttribute('data-selected-part', /^object-/);
    await canvas.click({ position: { x: 8, y: 8 } });
    await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
    await expect.poll(() => getSelection(artifact.id)).toBeNull();
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/model.png' });
});
test('keyboard camera views and orbit work without opening a toolbar', async ({ page }) => {
  const frame = page.frameLocator('#app');
  const artifact = await open(page, 'bracket.stl');
  const args = { artifactId: artifact.id };
  const before = await client.callTool({ name: 'artifact_get_selection', arguments: args });
  for (const name of [
    'Open artifact',
    'Refresh artifact',
    'Fit to view',
    'Perspective',
    'Wireframe',
    'Objects',
  ]) {
    await expect(frame.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  const canvas = await frontView(frame);
  const screenshot = () => canvas.screenshot({ style: 'canvas { outline: none !important; }' });
  const front = await screenshot();
  await canvas.press('5');
  expect(await screenshot()).not.toEqual(front);
  await canvas.press('1');
  expect(await screenshot()).toEqual(front);
  const beforeOrbit = await screenshot();
  await page.mouse.move(600, 350);
  await page.mouse.down();
  await page.mouse.move(720, 405, { steps: 5 });
  await page.mouse.up();
  expect(await screenshot()).not.toEqual(beforeOrbit);
  const after = await client.callTool({ name: 'artifact_get_selection', arguments: args });
  expect(after.structuredContent).toEqual(before.structuredContent);
});
test('MCAP topics and timeline selection round-trip at nanosecond precision', async ({ page }) => {
  const frame = page.frameLocator('#app');
  const artifact = await open(page, 'robot.mcap', true);
  await expect(frame.locator('.recording-summary')).toHaveCount(0);
  const slider = frame.getByRole('slider', { name: 'Recording timeline' });
  await slider.fill('5000');
  await slider.dispatchEvent('change');
  await expect
    .poll(() => getSelection(artifact.id))
    .toMatchObject({
      timestampNs: '1730000002950000000',
    });
  await frame.getByText('+2.950 s', { exact: true }).dblclick();
  const identity = await readPanelReference(page, frame);
  expect((await getView(identity))?.snapshot).toMatchObject({
    selected: { timestampNs: '1730000002950000000' },
  });
  const temperature = frame.getByRole('button', { name: '/telemetry/temperature', exact: true });
  await temperature.press('Space');
  await expect(temperature).toHaveAttribute('aria-pressed', 'true');
  const joints = frame.getByRole('row').filter({ hasText: '/joint_states' });
  await joints
    .getByRole('cell')
    .last()
    .click({ position: { x: 3, y: 3 } });
  await expect(joints.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await expect(temperature).toHaveAttribute('aria-pressed', 'false');
  await joints.getByRole('button').click();
  await expect(
    frame
      .getByRole('region', { name: '/joint_states graph' })
      .locator(':scope > .preview-pane-title'),
  ).toHaveText('/joint_states');
  await expect(joints.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await frame.getByText('Recording metadata', { exact: true }).click();
  await expect(frame.getByText(/demo-arm/)).toBeVisible();
  await page.screenshot({ path: 'test-results/mcap.png' });
});
test('images, videos, text, and fallback open in the shared interface', async ({ page }) => {
  const frame = page.frameLocator('#app');
  await page.setViewportSize({ width: 390, height: 820 });
  await open(page, 'diagram.svg');
  const image = frame.getByRole('img', { name: 'diagram.svg' });
  await expect(image).toBeVisible();
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(800);
  const preview = (await frame.locator('.media-stage').boundingBox())!;
  const controls = (await frame.getByRole('group', { name: 'Image controls' }).boundingBox())!;
  expect(controls.y).toBeGreaterThanOrEqual(preview.y + preview.height);
  await page.screenshot({ path: 'test-results/image-narrow.png' });
  await frame.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await open(page, 'video.mp4');
  const video = frame.locator('video');
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
  await expect(frame.locator('pre')).toContainText('base_link');
  await page.screenshot({ path: 'test-results/text-narrow.png' });
  await open(page, 'unsupported.step');
  await expect(frame.getByRole('alert')).toBeVisible();
});
test('malformed and oversized files fail gracefully and another file still opens', async ({
  page,
}) => {
  const frame = page.frameLocator('#app');
  await open(page, 'invalid.stl');
  await expect(frame.getByRole('alert')).toBeVisible();
  await open(page, 'invalid.mcap');
  await expect(frame.getByRole('alert')).toBeVisible();
  await open(page, resolve(temp, 'large.glb'));
  await expect(frame.getByRole('alert')).toContainText('64 MiB');
  await open(page, 'telemetry.json');
  await expect(frame.locator('pre')).toContainText('base_link');
});
test('file edits refresh without remounting unchanged models or preserving stale selections', async ({
  page,
}) => {
  const frame = page.frameLocator('#app');
  const artifact = await open(page, resolve(temp, 'refresh.stl'));
  await selectModel(frame);
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
  await expect(frame.getByRole('alert')).toBeVisible({ timeout: 10000 });
  const selection = await client.callTool({
    name: 'artifact_get_selection',
    arguments: { artifactId: artifact.id },
  });
  expect((selection.structuredContent as any).selection).toBeNull();
});
const boundPaths = new WeakMap<Page, string | undefined>();

async function openEmbedded(
  page: Page,
  fixture: {
    input: Record<string, unknown>;
    result: Awaited<ReturnType<Client['callTool']>>;
    fileResource?: { uri: string; mimeType: string; blob: string };
    boundFilePath?: string;
    theme?: 'light' | 'dark';
    styles?: { variables: Record<string, string> };
    chatContext?: boolean;
    imageContext?: boolean;
    contextLifecycle?: boolean;
    contextUpdateDelayMs?: number;
    download?: boolean;
    fullscreen?: boolean;
    browserFullscreen?: boolean;
    writeFile?: boolean;
    resourceUpdates?: boolean;
    rejectFullscreen?: boolean;
    displayMode?: 'inline' | 'fullscreen';
    hostDisplayModes?: Array<'inline' | 'fullscreen'>;
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
  if (!boundPaths.has(page)) {
    await page.exposeFunction('callMcp', (params: Parameters<Client['callTool']>[0]) => {
      const path = boundPaths.get(page);
      return client.callTool(path ? { ...params, _meta: { 'openai/resource': { path } } } : params);
    });
  }
  boundPaths.set(page, fixture.boundFilePath);
  await page.unroute('https://tesseract.test/**');
  await page.route('https://tesseract.test/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/fixture')
      await route.fulfill({
        json: {
          ...fixture,
          displayModes: (
            resource.contents[0]._meta?.['openai/ui'] as { availableDisplayModes?: string[] }
          )?.availableDisplayModes,
          html: (resource.contents[0] as any).text,
        },
      });
    else
      await route.fulfill({
        contentType: 'text/html',
        body: `<html><body><script>${code}</script></body></html>`,
      });
  });
  await page.goto('https://tesseract.test/');
  return page.frameLocator('#app');
}

test('fullscreen enters, exits, and resizes on a capable host without losing selection', async ({
  page,
}) => {
  const input = { file: { name: 'bench-vise.glb', resourceUri: 'host-resource://bench-vise.glb' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fullscreen: true,
    boundFilePath: resolve('samples/bench-vise.glb'),
  });
  await expect(page.locator('html')).toHaveAttribute(
    'data-app-display-modes',
    '["inline","fullscreen"]',
  );
  const { canvas } = await pickVisiblePart(frame);
  const selected = await canvas.getAttribute('data-selected-part');
  const original = await canvas.elementHandle();
  const before = (await canvas.boundingBox())!;
  await frame.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-display-mode', 'fullscreen');
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(before.width + 100);
  await expect(canvas).toHaveAttribute('data-selected-part', selected!);
  expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
  await canvas.screenshot({ path: 'test-results/fullscreen-scene.png' });
  await frame.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Enter fullscreen', exact: true })).toBeVisible();
  await canvas.press('f');
  await expect(page.locator('html')).toHaveAttribute('data-display-mode', 'fullscreen');
  await canvas.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-display-mode', 'inline');
  await expect(canvas).toHaveAttribute('data-selected-part', selected!);
  await expect(frame.getByRole('alert')).toHaveCount(0);
});

for (const displayMode of ['inline', 'fullscreen'] as const) {
  test(`a fixed ${displayMode} panel hides fullscreen and preserves selection shortcuts`, async ({
    page,
  }) => {
    const input = {
      file: { name: 'bench-vise.glb', resourceUri: 'host-resource://bench-vise.glb' },
    };
    const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
    const frame = await openEmbedded(page, {
      input,
      result,
      displayMode,
      hostDisplayModes: [displayMode],
      boundFilePath: resolve('samples/bench-vise.glb'),
    });
    const { canvas } = await pickVisiblePart(frame);
    const selected = await canvas.getAttribute('data-selected-part');
    await expect(frame.getByRole('button', { name: /fullscreen/ })).toHaveCount(0);
    await canvas.press('f');
    await expect(canvas).toHaveAttribute('data-selected-part', selected!);
    await canvas.press('Escape');
    await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
    await expect(page.locator('html')).not.toHaveAttribute('data-requested-mode');
    await expect(frame.getByRole('alert')).toHaveCount(0);
  });
}

test('fullscreen reports when a capable host declines the request', async ({ page }) => {
  const input = { path: 'bench-vise.glb' };
  const result = await client.callTool({ name: 'artifact_open', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fullscreen: true,
    rejectFullscreen: true,
  });
  await frame.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await expect(frame.getByRole('alert')).toContainText('couldn’t change the display mode');
  await expect(frame.getByRole('button', { name: 'Exit fullscreen', exact: true })).toHaveCount(0);
  await expect(frame.locator(readyModel)).toBeVisible();
});

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
  await expect(openFile).toHaveCount(0);
  await frame.getByLabel('Binary preview').dblclick();
  await expect(frame.getByLabel('View reference')).toHaveValue(/Tesseract preview .*viewId/);
  await expect(frame.getByRole('button', { name: 'Copy reference' })).toBeVisible();
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
    const artifact = (result.structuredContent as any).artifact;
    await expect.poll(() => getSelection(artifact.id)).toMatchObject({ kind: 'object' });
    expect(errors).toEqual([]);
    await page.screenshot({ path: `test-results/embedded-${model.split('.').pop()}.png` });
  });
test('desktop file entrypoint renders the STL resource handed off by the host', async ({
  page,
}) => {
  await page.setViewportSize({ width: 542, height: 800 });
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
  await expect(frame.locator('main')).toHaveAccessibleName(file.name);
  await pickVisiblePart(frame);
  await expect(frame.locator('header')).toHaveCount(0);
  await expect(frame.getByRole('button', { name: 'Open file' })).toHaveCount(0);
  expect((await frame.locator('.viewport').boundingBox())!.y).toBe(0);
  await expect(frame.getByRole('button', { name: 'Add to chat' })).toHaveCount(0);
  await expect(frame.locator('.dimensions')).toHaveCount(0);
  await expect(frame.locator('footer')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/clean-model-panel.png' });
});

test('PCD point clouds render and expose selected source coordinates to MCP', async ({ page }) => {
  const frame = page.frameLocator('#app');
  const artifact = await open(page, 'scan.pcd');
  await expect(frame.locator(readyModel)).toBeVisible();
  await expect(frame.getByRole('alert')).toHaveCount(0);
  await selectModel(frame, 0.5);
  await expect
    .poll(() => getSelection(artifact.id))
    .toMatchObject({
      kind: 'object',
      objectName: 'Point cloud',
      coordinates: [expect.any(Number), expect.any(Number), expect.any(Number)],
    });
});

for (const theme of ['dark', 'light'] as const) {
  test(`point clouds use bright, screen-sized Codex accent points in ${theme} mode`, async ({
    page,
  }) => {
    const input = { path: 'scan.pcd' };
    const result = await client.callTool({ name: 'artifact_open', arguments: input });
    const frame = await openEmbedded(page, {
      input,
      result,
      theme,
      styles: { variables: { '--color-text-primary': theme === 'dark' ? '#ffffff' : '#000000' } },
    });
    await expect(frame.locator(readyModel)).toBeVisible();
    const canvas = frame.getByLabel('3D model viewport');
    const countPoints = async (color: number[], name: string) => {
      const screenshot = await canvas.screenshot({
        path: `test-results/points-${name}.png`,
        scale: 'css',
      });
      return page.evaluate(
        async ({ png, color }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const buffer = document.createElement('canvas');
          buffer.width = image.width;
          buffer.height = image.height;
          const context = buffer.getContext('2d')!;
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(
            Math.round(image.width * 0.1),
            Math.round(image.height * 0.15),
            Math.round(image.width * 0.8),
            Math.round(image.height * 0.7),
          ).data;
          let bright = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (color.every((value, channel) => Math.abs(value - pixels[i + channel]) <= 3))
              bright++;
          return bright;
        },
        { png: screenshot.toString('base64'), color },
      );
    };
    const color = theme === 'dark' ? [255, 255, 255] : [0, 0, 0];
    expect(await countPoints(color, theme)).toBeGreaterThan(1500);
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 200);
    expect(await countPoints(color, `${theme}-zoomed-out`)).toBeGreaterThan(1500);
    await frame
      .locator('html')
      .evaluate((root) => root.style.setProperty('--color-text-primary', '#33ccff'));
    expect(await countPoints([51, 204, 255], `${theme}-host-color`)).toBeGreaterThan(1500);
  });
}

for (const source of ['ZIP', 'nested ZIP', 'folder']) {
  test(`models inside a ${source} share, toggle, and receive agent edits`, async ({ page }) => {
    const input = { path: source === 'folder' ? '.' : resolve(temp, 'models.zip') };
    const result = await client.callTool({ name: 'artifact_open', arguments: input });
    const native = source === 'ZIP';
    const uri = 'file://tesseract-model-archive';
    const frame = await openEmbedded(page, {
      input: native ? { file: { name: 'models.zip', resourceUri: uri } } : input,
      result: native ? { content: [] } : result,
      fileResource: native
        ? {
            uri,
            mimeType: 'application/zip',
            blob: await readFile(resolve(temp, 'models.zip'), 'base64'),
          }
        : undefined,
      chatContext: true,
      imageContext: true,
      contextLifecycle: true,
      download: true,
    });
    if (source === 'nested ZIP') {
      await frame.getByRole('button', { name: 'nested.zip', exact: true }).click();
      await expect(frame.getByRole('navigation', { name: 'Folder location' })).toContainText(
        'nested.zip',
      );
    }
    await frame.getByRole('button', { name: 'bracket.stl', exact: true }).last().click();
    await selectModel(frame);
    const canvas = frame.getByLabel('3D model viewport');
    const bounds = (await canvas.boundingBox())!;
    const bracket = { x: bounds.width / 2, y: bounds.height * 0.73 };
    await expect(page.locator('html')).not.toHaveAttribute('data-chat-context', /"viewId"/);
    await canvas.dblclick({ position: bracket });
    const identity = await readPanelReference(page, frame);
    const view = await getVisualContext(identity);
    expect(view).toMatchObject({
      imageMatchesSnapshot: true,
      snapshot: {
        name: 'bracket.stl',
        format: 'stl',
        context: { kind: 'model' },
        selected: { parts: [{ objectId: 'object-0' }] },
      },
    });
    expect(view.image).toBeTruthy();
    await expect(canvas).toHaveAttribute('data-chat-parts', 'object-0');
    await canvas.dblclick({ position: bracket });
    await expect(page.locator('html')).toHaveAttribute('data-chat-context', '');
    await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
    await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);

    await frame.getByRole('button', { name: 'bench-vise.glb', exact: true }).last().click();
    await frontView(frame);
    const nextBounds = (await canvas.boundingBox())!;
    await canvas.dblclick({
      position: { x: nextBounds.width * 0.37, y: nextBounds.height * 0.46 },
    });
    const next = await readPanelReference(page, frame);
    expect(next.viewId).not.toBe(identity.viewId);
    expect((await getView(next))?.snapshot).toMatchObject({
      name: 'bench-vise.glb',
      format: 'glb',
      selected: { parts: [{ objectId: 'object-1' }] },
    });
    await changeView(next, { kind: 'set_color', objectId: 'object-1', color: '#ff0000' });
    await expect(frame.getByRole('button', { name: 'Save copy', exact: true })).toBeVisible();
    await canvas.screenshot({ path: `test-results/shared-model-${source.replace(' ', '-')}.png` });
    await page.getByRole('button', { name: 'Remove context', exact: true }).click();
    await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
    await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
  });
}

test('folders and ZIP entries can be browsed and previewed', async ({ page }) => {
  const frame = page.frameLocator('#app');
  await open(page, '.');
  await frame.getByRole('button', { name: 'telemetry.json', exact: true }).click();
  await expect(frame.locator('pre')).toContainText('base_link');
  await page.setViewportSize({ width: 390, height: 820 });
  await open(page, resolve(temp, 'bundle.zip'));
  const folder = frame.getByRole('button', { name: 'nested', exact: true });
  await folder.press('ArrowRight');
  await expect(frame.getByRole('navigation', { name: 'Folder location' })).toContainText('nested');
  await frame.getByRole('button', { name: 'readme.txt', exact: true }).press('ArrowLeft');
  await expect(folder).toBeFocused();
  const filter = frame.getByRole('searchbox', { name: 'Filter entries' });
  await filter.fill('missing');
  await expect(frame.getByText('No matching files')).toBeVisible();
  await filter.fill('readme');
  const entry = frame.getByRole('button', { name: 'nested/readme.txt', exact: true });
  await entry.click();
  await expect(entry).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('pre')).toContainText('archive contents');
  await frame.locator('pre').dblclick();
  const reference = frame.getByLabel('View reference');
  await expect(reference).toBeVisible();
  const identity = viewIdentity.parse(
    JSON.parse((await reference.inputValue()).replace(/^Tesseract preview /, '')),
  );
  await expect
    .poll(async () => (await getView(identity))?.snapshot)
    .toMatchObject({
      context: { kind: 'container', entry: 'nested/readme.txt', textPreview: 'archive contents' },
    });
  const list = (await frame.getByRole('complementary', { name: 'Files' }).boundingBox())!;
  const preview = (await frame.locator('pre').boundingBox())!;
  expect(preview.y).toBeGreaterThanOrEqual(list.y + list.height);
  expect(preview.width).toBeGreaterThan(340);
  await page.screenshot({ path: 'test-results/archive-narrow.png' });
});

async function readPanelReference(page: Page, frame: FrameLocator) {
  await expect(page.locator('html')).toHaveAttribute('data-chat-context', /"viewId"/);
  await expect(frame.getByRole('button', { name: 'Add to chat' })).toHaveCount(0);
  const context = await page.locator('html').getAttribute('data-chat-context');
  const reference = context?.match(/\{"viewId":.*?\}/)?.[0];
  return viewIdentity.parse(JSON.parse(reference ?? '{}'));
}

async function getView(identity: ViewIdentity) {
  const result = await client.callTool({ name: 'artifact_get_view', arguments: identity });
  expect(result.isError).toBeFalsy();
  return result.structuredContent;
}

async function getVisualContext(identity: ViewIdentity) {
  const result = await client.callTool({
    name: 'artifact_get_view',
    arguments: { ...identity, includeImage: true },
  });
  expect(result.isError).toBeFalsy();
  return {
    ...result.structuredContent,
    image: result.content?.find((item) => item.type === 'image')?.data,
  };
}

async function changeView(identity: ViewIdentity, action: ViewAction) {
  const result = await client.callTool({
    name: 'artifact_change_view',
    arguments: { ...identity, action },
  });
  expect(result.structuredContent).toMatchObject({ status: 'queued' });
  const id = result.structuredContent?.commandId;
  await expect.poll(async () => (await getView(identity))?.lastResult).toMatchObject({ id });
  expect((await getView(identity))?.lastResult).not.toMatchObject({ error: true });
}

test.describe('model selection outline', () => {
  test.use({ deviceScaleFactor: 2 });

  for (const theme of ['dark', 'light'] as const) {
    test(`a single click draws a visible theme outline in ${theme} mode`, async ({ page }) => {
      const input = { path: 'bench-vise.glb' };
      const result = await client.callTool({ name: 'artifact_open', arguments: input });
      const frame = await openEmbedded(page, {
        input,
        result,
        chatContext: true,
        theme,
        styles: { variables: { '--color-text-primary': theme === 'dark' ? '#fff' : '#000' } },
      });
      const canvas = await frontView(frame);
      const bounds = (await canvas.boundingBox())!;
      const fixed = { x: bounds.width * 0.37, y: bounds.height * 0.46 };
      await canvas.click({ position: fixed });
      await expect(canvas).toHaveAttribute('data-selected-part', 'object-1');
      await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);

      const screenshot = await canvas.screenshot({
        path: `test-results/bench-vise-selected-${theme}.png`,
        scale: 'device',
      });
      const readPixels = (screenshot: Buffer) =>
        page.evaluate(
          async ({ png, theme }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${png}`;
            await image.decode();
            const buffer = document.createElement('canvas');
            buffer.width = image.width;
            buffer.height = image.height;
            const context = buffer.getContext('2d')!;
            context.drawImage(image, 0, 0);
            // Cross the jaw's top edge, excluding the canvas focus ring and the base.
            const column = context.getImageData(
              Math.round(image.width * 0.37),
              Math.round(image.height * 0.2),
              1,
              Math.round(image.height * 0.3),
            ).data;
            let run = 0;
            let longest = 0;
            for (let i = 0; i < column.length; i += 4) {
              const channels = [column[i], column[i + 1], column[i + 2]];
              const accent = channels.every((c) => (theme === 'dark' ? c > 240 : c < 15));
              run = accent ? run + 1 : 0;
              longest = Math.max(longest, run);
            }
            const body = context.getImageData(
              Math.round(image.width * 0.37),
              Math.round(image.height * 0.46),
              1,
              1,
            ).data;
            return { thickness: longest, body: [...body].slice(0, 3) };
          },
          { png: screenshot.toString('base64'), theme },
        );
      const pixels = await readPixels(screenshot);
      // At 2x, a 2 CSS px stroke covers three or four full device pixels depending on alignment.
      expect(pixels.thickness).toBeGreaterThanOrEqual(3);
      expect(pixels.thickness).toBeLessThanOrEqual(4);
      await canvas.dblclick({ position: fixed });
      await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1');
      const shared = await canvas.screenshot({
        path: `test-results/bench-vise-context-${theme}.png`,
        scale: 'css',
      });
      const filled = await readPixels(shared);
      expect(
        filled.body.every((value, i) =>
          theme === 'dark' ? value > pixels.body[i] + 5 : value < pixels.body[i] - 5,
        ),
      ).toBe(true);
      await canvas.press('0');
      await canvas.screenshot({ path: `test-results/bench-vise-perspective-${theme}.png` });
      await canvas.click({ position: { x: 8, y: 8 } });
      await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
      await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1');
    });
  }
});

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`oblique outlines at ${deviceScaleFactor}x`, () => {
    test.use({ deviceScaleFactor, viewport: { width: 560, height: 720 } });

    test('zoomed outline stays continuous over the selected faces', async ({ page }) => {
      const input = { path: 'bench-vise.glb' };
      const result = await client.callTool({ name: 'artifact_open', arguments: input });
      const frame = await openEmbedded(page, {
        input,
        result,
        chatContext: true,
        theme: 'dark',
        styles: { variables: { '--color-text-primary': '#fff' } },
      });
      const canvas = await frontView(frame);
      const bounds = (await canvas.boundingBox())!;
      await canvas.dblclick({ position: { x: bounds.width * 0.63, y: bounds.height * 0.46 } });
      await expect(canvas).toHaveAttribute('data-chat-parts', 'object-2');
      await canvas.press('0');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, -1400);
      const screenshot = await canvas.screenshot({
        path: `test-results/outline-closeup-${deviceScaleFactor}x.png`,
        scale: 'css',
      });
      const edges = await page.evaluate(async (png) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const buffer = document.createElement('canvas');
        buffer.width = image.width;
        buffer.height = image.height;
        const context = buffer.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const { width, height, data } = context.getImageData(0, 0, image.width, image.height);
        const white = (x: number, y: number) => {
          const i = (y * width + x) * 4;
          return data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235;
        };
        const edge: { x: number; y: number }[] = [];
        for (let x = 20; x < width - 20; x++) {
          for (let y = Math.round(height * 0.2); y < height - 20; y++) {
            if (white(x, y)) {
              edge.push({ x, y });
              break;
            }
          }
        }
        const left = edge[0]?.x ?? 0;
        const span = (edge.at(-1)?.x ?? 0) - left;
        const top = edge.reduce((a, b) => (a.y < b.y ? a : b), { x: 0, y: height });
        let checked = 0;
        let frayed = 0;
        let gaps = 0;
        let previousX: number | undefined;
        for (const { x, y } of edge) {
          if (x < left + span * 0.2 || x > left + span * 0.8 || Math.abs(x - top.x) < span * 0.1) {
            previousX = undefined;
            continue;
          }
          checked++;
          if (previousX !== undefined) gaps += x - previousX - 1;
          previousX = x;
          for (let offset = 5; offset < 9; offset++) {
            if (white(x, y + offset)) {
              frayed++;
              break;
            }
          }
        }
        return { checked, frayed, gaps };
      }, screenshot.toString('base64'));
      expect(edges.checked).toBeGreaterThan(20);
      expect(edges.gaps / edges.checked).toBeLessThan(0.05);
      expect(edges.frayed / edges.checked).toBeLessThan(0.05);
    });
  });
}

test('double-click commits model context while single clicks stay in the viewer', async ({
  page,
}) => {
  const input = { path: 'bench-vise.glb' };
  const result = await client.callTool({ name: 'artifact_open', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    chatContext: true,
    theme: 'dark',
    styles: { variables: { '--color-text-primary': '#fff' } },
  });
  const canvas = await frontView(frame);
  const bounds = (await canvas.boundingBox())!;
  const fixed = { x: bounds.width * 0.37, y: bounds.height * 0.46 };
  const sliding = { x: bounds.width * 0.63, y: bounds.height * 0.46 };
  await canvas.click({ position: fixed });
  await canvas.click({ position: sliding, modifiers: ['Shift'] });
  await expect(page.locator('html')).not.toHaveAttribute('data-chat-context', /"viewId"/);
  await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
  await canvas.dblclick({ position: sliding });
  const identity = await readPanelReference(page, frame);
  const attachment = page.locator('html');
  const footer = frame.locator('footer');
  const parts = [
    { objectName: 'Fixed jaw', objectId: expect.any(String), coordinates: expect.any(Array) },
    { objectName: 'Sliding jaw', objectId: expect.any(String), coordinates: expect.any(Array) },
  ];
  expect((await getView(identity))?.snapshot).toMatchObject({ selected: { parts } });
  await expect(attachment).toHaveAttribute(
    'data-chat-context',
    /selected parts are "Fixed jaw" and "Sliding jaw"/,
  );
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1 object-2');
  await expect(footer).toHaveCount(0);
  const artifact = result.structuredContent?.artifact as { id: string };
  await expect.poll(() => getSelection(artifact.id)).toMatchObject({ parts });
  const groupImage = (await getVisualContext(identity)).image;
  expect(groupImage).toBeTruthy();
  await expect(attachment).toHaveAttribute('data-chat-context', /"includeImage":true/);
  // Hosts accepting text context can retrieve the automatically refreshed image through MCP.
  expect(await attachment.getAttribute('data-chat-image')).toBe('');
  await page.screenshot({ path: 'test-results/bench-vise.png' });

  const syncCount = Number(await attachment.getAttribute('data-sync-count'));
  await canvas.click({ position: fixed, modifiers: ['Shift'] });
  await expect
    .poll(async () => Number(await attachment.getAttribute('data-sync-count')))
    .toBeGreaterThan(syncCount);
  const pendingGroup = await getVisualContext(identity);
  expect(pendingGroup.snapshot).toMatchObject({ selected: { parts } });
  expect(pendingGroup.image).toBe(groupImage);
  await expect(attachment).toHaveAttribute(
    'data-chat-context',
    /selected parts are "Fixed jaw" and "Sliding jaw"/,
  );
  await canvas.dblclick({ position: sliding });
  await expect
    .poll(async () => (await getView(identity))?.snapshot)
    .toMatchObject({
      selected: { parts: [parts[0]] },
    });
  await expect(attachment).toHaveAttribute('data-chat-context', /selected part is "Fixed jaw"/);
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1');
  await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
  const removed = await getVisualContext(identity);
  expect(removed).toMatchObject({ imageMatchesSnapshot: true });
  expect(removed.image).not.toBe(groupImage);
  await canvas.click({ position: sliding });
  await expect.poll(() => getSelection(artifact.id)).toMatchObject({ parts: [parts[1]] });
  expect((await getView(identity))?.snapshot).toMatchObject({ selected: { parts: [parts[0]] } });
  await canvas.dblclick({ position: sliding });
  await expect(attachment).toHaveAttribute(
    'data-chat-context',
    /selected parts are "Fixed jaw" and "Sliding jaw"/,
  );
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1 object-2');
  await canvas.dblclick({ position: fixed });
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-2');
  expect((await getView(identity))?.snapshot).toMatchObject({ selected: { parts: [parts[1]] } });
  await canvas.dblclick({ position: sliding });
  await expect(attachment).toHaveAttribute('data-chat-context', '');
  await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
  await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
  await expect
    .poll(
      async () =>
        (await client.callTool({ name: 'artifact_get_view', arguments: identity })).isError,
    )
    .toBe(true);
  await expect(footer).toHaveCount(0);
});

test('successive double-clicks and Shift-selected groups accumulate in chat context', async ({
  page,
}) => {
  const input = { path: 'bench-vise.glb' };
  const result = await client.callTool({ name: 'artifact_open', arguments: input });
  const frame = await openEmbedded(page, { input, result, chatContext: true, imageContext: true });
  const canvas = await frontView(frame);
  const bounds = (await canvas.boundingBox())!;
  const fixed = { x: bounds.width * 0.37, y: bounds.height * 0.46 };
  const sliding = { x: bounds.width * 0.63, y: bounds.height * 0.46 };
  const base = { x: bounds.width * 0.5, y: bounds.height * 0.59 };
  await page.evaluate(() => {
    const call = window.callMcp;
    window.callMcp = async (params) => {
      if (params.name === 'artifact_share_view') {
        document.documentElement.dataset.sharePending = 'true';
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return call(params);
    };
  });
  await canvas.dblclick({ position: fixed });
  await expect(page.locator('html')).toHaveAttribute('data-share-pending', 'true');
  await canvas.dblclick({ position: sliding });
  const identity = await readPanelReference(page, frame);
  await expect
    .poll(() => getVisualContext(identity))
    .toMatchObject({
      imageMatchesSnapshot: true,
      snapshot: { selected: { parts: [{ objectId: 'object-1' }, { objectId: 'object-2' }] } },
    });
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1 object-2');

  await canvas.click({ position: base });
  await expect(canvas).toHaveAttribute('data-selected-part', 'object-0');
  await canvas.click({ position: fixed, modifiers: ['Shift'] });
  await canvas.dblclick({ position: fixed });
  const group = {
    selected: {
      parts: [{ objectId: 'object-1' }, { objectId: 'object-2' }, { objectId: 'object-0' }],
    },
  };
  await expect.poll(async () => (await getView(identity))?.snapshot).toMatchObject(group);
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1 object-2 object-0');
  await canvas.dblclick({ position: fixed });
  await expect
    .poll(async () => (await getView(identity))?.snapshot)
    .toMatchObject({
      selected: { parts: [{ objectId: 'object-2' }, { objectId: 'object-0' }] },
    });
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-2 object-0');
  await canvas.dblclick({ position: fixed });
  await expect
    .poll(async () => (await getView(identity))?.snapshot)
    .toMatchObject({
      selected: {
        parts: [{ objectId: 'object-2' }, { objectId: 'object-0' }, { objectId: 'object-1' }],
      },
    });
  await expect(page.locator('html')).toHaveAttribute(
    'data-chat-context',
    /selected parts are "Sliding jaw", "Base", and "Fixed jaw"/,
  );
  await canvas.screenshot({ path: 'test-results/multiple-context-parts.png' });
});

test('unnamed parts keep their highlighted image current in chat and MCP', async ({ page }) => {
  const source = await readFile(resolve('samples/bench-vise.glb'));
  const jsonLength = source.readUInt32LE(12);
  const model = JSON.parse(source.subarray(20, 20 + jsonLength).toString());
  for (const node of model.nodes) delete node.name;
  const text = Buffer.from(JSON.stringify(model));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(json);
  const unnamed = Buffer.concat([source.subarray(0, 20), json, source.subarray(20 + jsonLength)]);
  unnamed.writeUInt32LE(unnamed.length, 8);
  unnamed.writeUInt32LE(json.length, 12);

  const input = { file: { name: 'unnamed.glb', resourceUri: 'host-resource://unnamed-model' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'model/gltf-binary',
      blob: unnamed.toString('base64'),
    },
    chatContext: true,
    imageContext: true,
  });
  const canvas = await frontView(frame);
  const bounds = (await canvas.boundingBox())!;
  const fixed = { x: bounds.width * 0.37, y: bounds.height * 0.46 };
  const sliding = { x: bounds.width * 0.63, y: bounds.height * 0.46 };
  await canvas.click({ position: fixed });
  await canvas.dblclick({ position: fixed });
  const identity = await readPanelReference(page, frame);
  const first = await getVisualContext(identity);
  expect(first).toMatchObject({
    imageMatchesSnapshot: true,
    snapshot: { selected: { objectId: 'object-1', objectName: 'mesh_1' } },
  });
  expect(first.image).toBeTruthy();
  await writeFile('test-results/unnamed-fixed-context.jpg', Buffer.from(first.image!, 'base64'));
  const chatImage = () => page.locator('html').getAttribute('data-chat-image');
  await expect.poll(chatImage).toBe(first.image);

  const syncCount = Number(await page.locator('html').getAttribute('data-sync-count'));
  await canvas.click({ position: sliding });
  await expect(canvas).toHaveAttribute('data-selected-part', 'object-2');
  await expect
    .poll(async () => Number(await page.locator('html').getAttribute('data-sync-count')))
    .toBeGreaterThan(syncCount);
  const pending = await getVisualContext(identity);
  expect(pending.snapshot).toMatchObject({ selected: { objectId: 'object-1' } });
  expect(pending.image).toBe(first.image);
  expect(await chatImage()).toBe(first.image);
  await canvas.dblclick({ position: sliding });
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1 object-2');
  const second = await getVisualContext(identity);
  expect(second).toMatchObject({
    imageMatchesSnapshot: true,
    snapshot: { selected: { objectId: 'object-2', objectName: 'mesh_2' } },
  });
  expect(second.image).toBeTruthy();
  expect(second.image).not.toBe(first.image);
  await writeFile('test-results/unnamed-sliding-context.jpg', Buffer.from(second.image!, 'base64'));
  await expect.poll(chatImage).toBe(second.image);

  // Delay one sync to exercise several selection changes while a capture is in flight.
  await page.evaluate(() => {
    const call = window.callMcp;
    let delayed = false;
    window.callMcp = async (params) => {
      if (!delayed && params.name === 'artifact_sync_view' && params.arguments?.snapshot) {
        delayed = true;
        document.documentElement.dataset.delayedSync = 'pending';
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await call(params);
        document.documentElement.dataset.delayedSync = 'done';
        return result;
      }
      return call(params);
    };
  });
  await canvas.dblclick({ position: sliding });
  await expect(page.locator('html')).toHaveAttribute('data-delayed-sync', 'pending');
  await canvas.dblclick({ position: sliding });
  await expect(page.locator('html')).toHaveAttribute('data-delayed-sync', 'done');
  await expect.poll(chatImage).toBe(second.image);
  await expect
    .poll(() => getVisualContext(identity))
    .toMatchObject({
      imageMatchesSnapshot: true,
      snapshot: { selected: { parts: [{ objectId: 'object-1' }, { objectId: 'object-2' }] } },
      image: second.image,
    });

  await canvas.click({ position: fixed });
  await changeView(identity, { kind: 'set_color', objectId: 'object-2', color: '#ff0000' });
  const recolored = await getVisualContext(identity);
  expect(recolored.snapshot).toMatchObject({ selected: { objectId: 'object-2' } });
  expect(recolored.image).not.toBe(second.image);
  await expect(canvas).toHaveAttribute('data-selected-part', 'object-1');
  await expect.poll(chatImage).toBe(recolored.image);
  await writeFile(
    'test-results/committed-selection-context.jpg',
    Buffer.from(recolored.image!, 'base64'),
  );
  await canvas.press('Escape');
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1 object-2');
  expect((await getView(identity))?.snapshot).toMatchObject({ selected: { objectId: 'object-2' } });
});

for (const imageOnly of [false, true]) {
  test(`host × removal clears highlights for ${imageOnly ? 'an image block' : 'the whole context'}`, async ({
    page,
  }) => {
    const input = { path: 'bench-vise.glb' };
    const result = await client.callTool({ name: 'artifact_open', arguments: input });
    const frame = await openEmbedded(page, {
      input,
      result,
      chatContext: true,
      imageContext: true,
      contextLifecycle: true,
    });
    const canvas = await frontView(frame);
    const bounds = (await canvas.boundingBox())!;
    const fixed = { x: bounds.width * 0.37, y: bounds.height * 0.46 };
    const sliding = { x: bounds.width * 0.63, y: bounds.height * 0.46 };
    await canvas.dblclick({ position: fixed });
    const identity = await readPanelReference(page, frame);
    await expect(canvas).toHaveAttribute('data-chat-parts', 'object-1');
    expect(JSON.parse((await page.locator('html').getAttribute('data-attachments'))!)).toEqual([
      { type: 'image', 'openai/group': { title: 'bench-vise.glb' }, 'openai/title': 'Fixed jaw' },
    ]);
    await page
      .getByRole('button', {
        name: imageOnly ? 'Remove context image' : 'Remove context',
        exact: true,
      })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-chat-context', '');
    await expect(page.locator('html')).toHaveAttribute('data-chat-image', '');
    await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
    await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
    await expect
      .poll(
        async () =>
          (await client.callTool({ name: 'artifact_get_view', arguments: identity })).isError,
      )
      .toBe(true);
    await canvas.screenshot({
      path: `test-results/context-removed-${imageOnly ? 'image' : 'all'}.png`,
    });

    await canvas.click({ position: sliding });
    await expect(page.locator('html')).toHaveAttribute('data-chat-context', '');
    await canvas.dblclick({ position: sliding });
    const next = await readPanelReference(page, frame);
    expect(next.viewId).not.toBe(identity.viewId);
    await expect(canvas).toHaveAttribute('data-chat-parts', 'object-2');
    expect((await getView(next))?.snapshot).toMatchObject({
      selected: { parts: [{ objectId: 'object-2' }] },
    });
  });
}

test('host × during an update stays removed when its acknowledgement arrives', async ({ page }) => {
  const input = { path: 'bench-vise.glb' };
  const result = await client.callTool({ name: 'artifact_open', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    chatContext: true,
    imageContext: true,
    contextLifecycle: true,
    contextUpdateDelayMs: 1000,
  });
  const canvas = await frontView(frame);
  const bounds = (await canvas.boundingBox())!;
  await canvas.dblclick({ position: { x: bounds.width * 0.37, y: bounds.height * 0.46 } });
  await expect(page.locator('html')).toHaveAttribute('data-context-delayed', 'true');
  await page.getByRole('button', { name: 'Remove context', exact: true }).click();
  await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
  await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
  await expect(page.locator('html')).toHaveAttribute('data-chat-context', '');
  await canvas.dblclick({ position: { x: bounds.width * 0.63, y: bounds.height * 0.46 } });
  const identity = await readPanelReference(page, frame);
  await expect(page.locator('html')).toHaveAttribute('data-context-delayed', 'done');
  await expect(canvas).toHaveAttribute('data-chat-parts', 'object-2');
  expect((await getView(identity))?.snapshot).toMatchObject({
    selected: { parts: [{ objectId: 'object-2' }] },
  });
  await expect(frame.locator('footer')).toHaveCount(0);
});

test.describe('touch selection', () => {
  test.use({ hasTouch: true });

  test('double-tap shares a part with chat', async ({ page }) => {
    const input = { path: 'bench-vise.glb' };
    const result = await client.callTool({ name: 'artifact_open', arguments: input });
    const frame = await openEmbedded(page, { input, result, chatContext: true });
    const canvas = await frontView(frame);
    const bounds = (await canvas.boundingBox())!;
    const position = { x: bounds.width * 0.37, y: bounds.height * 0.46 };
    await canvas.tap({ position });
    await expect(page.locator('html')).not.toHaveAttribute('data-chat-context', /"viewId"/);
    await canvas.tap({ position });
    const identity = await readPanelReference(page, frame);
    expect(JSON.parse((await page.locator('html').getAttribute('data-attachments'))!)).toEqual([
      { type: 'text', 'openai/group': { title: 'bench-vise.glb' }, 'openai/title': 'Fixed jaw' },
    ]);
    expect((await getView(identity))?.snapshot).toMatchObject({
      selected: { parts: [{ objectName: 'Fixed jaw' }] },
    });
    await canvas.tap({ position });
    await canvas.tap({ position });
    await expect(page.locator('html')).toHaveAttribute('data-chat-context', '');
    await expect(canvas).not.toHaveAttribute('data-chat-parts', /.+/);
    await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
  });
});

test('chat recolors a GLB opened by the host and saves a copy from the same panel', async ({
  page,
}) => {
  const name = 'bracket.glb';
  const input = { file: { name, resourceUri: 'host-resource://shared-bracket' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'model/gltf-binary',
      blob: await readFile(resolve('samples', name), 'base64'),
    },
    chatContext: true,
    download: true,
  });
  const { canvas, position } = await selectModel(frame);
  const save = frame.getByRole('button', { name: 'Save copy', exact: true });
  await expect(save).toHaveCount(0);
  await expect(frame.locator('footer')).toHaveCount(0);
  await canvas.dblclick({ position });
  const identity = await readPanelReference(page, frame);
  const view = await getView(identity);
  expect(view?.snapshot).toMatchObject({
    name,
    selected: { objectId: expect.any(String) },
  });
  const image = await client.callTool({
    name: 'artifact_get_view',
    arguments: { ...identity, includeImage: true },
  });
  expect(image.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
  );
  const objectId = (view?.snapshot as { selected: { objectId: string } }).selected.objectId;
  const stale = await client.callTool({
    name: 'artifact_change_view',
    arguments: {
      ...identity,
      revision: 'older',
      action: { kind: 'set_color', objectId, color: '#ff0000' },
    },
  });
  expect(stale.isError).toBe(true);
  await changeView(identity, { kind: 'set_color', objectId, color: '#ff0000' });
  expect((await getView(identity))?.snapshot).toMatchObject({
    context: {
      objects: expect.arrayContaining([
        { id: objectId, name: expect.any(String), color: '#ff0000', textured: false },
      ]),
    },
  });
  await expect(frame.getByLabel('Part color')).toHaveCount(0);
  await expect(frame.getByRole('button', { name: /undo/i })).toHaveCount(0);
  expect((await getView(identity))?.hasSharedImage).toBe(true);
  expect((await getView(identity))?.imageMatchesSnapshot).toBe(true);
  const automaticImage = await client.callTool({
    name: 'artifact_get_view',
    arguments: { ...identity, includeImage: true },
  });
  const imageBytes = (response: typeof image) =>
    response.content?.find((item) => item.type === 'image')?.data;
  expect(imageBytes(automaticImage)).toBeTruthy();
  expect(imageBytes(automaticImage)).not.toBe(imageBytes(image));
  await changeView(identity, { kind: 'capture' });
  const updatedImage = await client.callTool({
    name: 'artifact_get_view',
    arguments: { ...identity, includeImage: true },
  });
  expect(imageBytes(updatedImage)).toBeTruthy();
  expect(imageBytes(updatedImage)).not.toBe(imageBytes(image));
  await canvas.click({ position: { x: 8, y: 8 } });
  await expect(canvas).not.toHaveAttribute('data-selected-part', /.+/);
  expect((await getView(identity))?.snapshot).toMatchObject({ selected: { objectId } });
  await save.click();
  await expect(page.locator('html')).toHaveAttribute('data-download', /bracket-edited\.glb/);
  const dataTransfer = await frame.locator('main').evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Next file'], 'notes.txt', { type: 'text/plain' }));
    return transfer;
  });
  await frame.locator('main').dispatchEvent('drop', { dataTransfer });
  await expect(frame.getByLabel('Text preview')).toHaveText('Next file');
  await expect
    .poll(
      async () =>
        (await client.callTool({ name: 'artifact_get_view', arguments: identity })).isError,
    )
    .toBe(true);
});

test('MCAP double-click shares the visible frame and keeps it pinned when chat seeks', async ({
  page,
}) => {
  const name = 'cameras.mcap';
  const input = { file: { name, resourceUri: 'host-resource://shared-camera' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    boundFilePath: resolve(temp, name),
    chatContext: true,
    imageContext: true,
    browserFullscreen: true,
  });
  const video = frame.getByLabel('Recorded camera video');
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42000000000');
  await expect(frame.getByRole('button', { name: 'Select video timestamp' })).toHaveCount(0);
  await expect(frame.getByText('Review options', { exact: true })).toHaveCount(0);
  await expect(video).toHaveJSProperty('controls', true);
  expect(await video.evaluate((element) => element.ownerDocument.fullscreenEnabled)).toBe(true);
  await seekCamera(video, 0.125);
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42100000000');
  const frontTopic = frame.getByRole('button', { name: '/camera/front', exact: true });
  await frontTopic.click();
  await expect(page.locator('html')).not.toHaveAttribute('data-chat-context', /"viewId"/);
  await frontTopic.dblclick();
  await expect(page.locator('html')).toHaveAttribute(
    'data-attachments',
    /"openai\/title":"\/camera\/front"/,
  );
  const topicIdentity = await readPanelReference(page, frame);
  expect((await getView(topicIdentity))?.snapshot).toMatchObject({
    selected: { timestampNs: '42125000000', item: { label: '/camera/front' } },
  });
  await video.dblclick();
  const identity = await readPanelReference(page, frame);
  expect(identity).toEqual(topicIdentity);
  await expect(page.locator('html')).toHaveAttribute(
    'data-chat-context',
    /42100000000 ns.*\/camera\/front/,
  );
  expect(await video.evaluate((element) => !!element.ownerDocument.fullscreenElement)).toBe(false);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.125);
  const first = await getVisualContext(identity);
  await expect(video).toHaveJSProperty('paused', true);
  const snapshot = first.snapshot as {
    recording: { topics: { name: string; id: number }[] };
  };
  const front = snapshot.recording.topics.find((topic) => topic.name === '/camera/front')!.id;
  const side = snapshot.recording.topics.find((topic) => topic.name === '/camera/side')!.id;
  expect(first.image).toBeTruthy();
  expect(first).toMatchObject({
    imageMatchesSnapshot: true,
    snapshot: { selected: { timestampNs: '42100000000', channelId: front } },
  });
  const range = { startNs: '42100000000', endNs: '42700000000' };
  await changeView(identity, {
    kind: 'mcap_view',
    cameraChannelId: side,
    timestampNs: '42300000000',
    range,
    channelIds: [side],
  });
  await expect(video).toHaveAttribute('data-camera', '/camera/side');
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42300000000');
  expect(await getVisualContext(identity)).toMatchObject({
    image: first.image,
    imageMatchesSnapshot: true,
    snapshot: {
      context: { timestampNs: '42300000000', cameraChannelId: side, range, channelIds: [side] },
      selected: { timestampNs: '42100000000', channelId: front },
    },
  });
  await changeView(identity, { kind: 'mcap_sample', channelId: side, ...range, limit: 2 });
  expect((await getView(identity))?.lastResult).toMatchObject({
    samples: [
      { channelId: side, timestampNs: expect.any(String), value: expect.any(String) },
      { channelId: side, timestampNs: expect.any(String), value: expect.any(String) },
    ],
  });
  await video.dblclick();
  await expect(page.locator('html')).toHaveAttribute(
    'data-chat-context',
    /42300000000 ns.*\/camera\/side/,
  );
  expect(await readPanelReference(page, frame)).toEqual(identity);
  const second = await getVisualContext(identity);
  expect(second.snapshot).toMatchObject({
    selected: { timestampNs: '42300000000', channelId: side },
  });
  expect(second.image).toBeTruthy();
  expect(second.image).not.toEqual(first.image);
  await changeView(identity, { kind: 'undo' });
  await expect(video).toHaveAttribute('data-camera', '/camera/front');
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42100000000');
});
test('STEP tessellation renders using the bundled CAD decoder', async ({ page }) => {
  const frame = page.frameLocator('#app');
  for (const name of ['part.step', 'part.iges']) {
    await open(page, resolve(temp, name));
    await expect(frame.locator(readyModel)).toBeVisible({ timeout: 25000 });
    await expect(frame.getByRole('alert')).toHaveCount(0);
    const { canvas } = await pickVisiblePart(frame, true);
    await expect(canvas).toHaveAttribute('data-selected-part', /^object-\d+\/surface\/\d+$/);
  }
});
test('scientific data and ROS message readers inspect real fixtures', async ({ page }) => {
  const frame = page.frameLocator('#app');
  for (const [path, expected] of [
    ['array.npy', 'row-major'],
    ['datasets.h5', 'temperature'],
    ['climate.nc', 'temperature'],
    ['scan.e57', 'e57Root'],
    ['telemetry.bag', '/temperature'],
  ]) {
    if (path === 'telemetry.bag') await page.setViewportSize({ width: 390, height: 800 });
    await open(page, `scientific/${path}`, path === 'telemetry.bag');
    await expect(frame.locator('pre').first()).toContainText(expected, { timeout: 25000 });
    if (path === 'telemetry.bag') {
      const message = frame.getByLabel('Decoded message');
      const player = frame.getByRole('group', { name: 'Message controls' });
      const scrubber = player.getByRole('slider', { name: 'Message preview index' });
      await expect(player).toContainText('0:00.0 / 0:00.2');
      await player.getByRole('button', { name: 'Play preview' }).click();
      await expect(scrubber).not.toHaveValue('0');
      await scrubber.press('End');
      await expect(player.getByRole('button', { name: 'Play preview' })).toBeVisible();
      await expect(player).toContainText('0:00.2 / 0:00.2');
      await expect(message).toContainText('1200000000');
      await message.dblclick();
      const identity = await readPanelReference(page, frame);
      expect((await getView(identity))?.snapshot).toMatchObject({
        selected: { timestampNs: '1200000000' },
      });
      await frame.locator('.message-player').screenshot({ path: 'test-results/rosbag-player.png' });
    }
    await expect(frame.getByRole('alert')).toHaveCount(0);
  }
});
test('LAS, compressed LAZ and VTK meshes render', async ({ page }) => {
  const frame = page.frameLocator('#app');
  for (const name of ['points.las', 'points.laz', 'surface.vtk', 'surface.vtp']) {
    await open(page, `scientific/${name}`);
    await expect(frame.locator(readyModel)).toBeVisible({ timeout: 25000 });
    await expect(frame.getByRole('alert')).toHaveCount(0);
  }
});
test('MCAP JSON messages are decoded on demand', async ({ page }) => {
  const frame = page.frameLocator('#app');
  const artifact = await open(page, 'robot.mcap', true);
  await frame.getByRole('button', { name: 'Decoded message preview' }).click();
  await expect(frame.locator('.text-view pre').first()).toContainText('frame');
  await frame.getByRole('button', { name: 'Play preview' }).click();
  await expect(frame.getByRole('slider', { name: 'Message preview index' })).not.toHaveValue('0');
  await frame.getByRole('button', { name: 'Pause preview' }).click();
  const message = frame.getByLabel('Decoded message');
  await message.dblclick();
  const { timestampNs } = JSON.parse((await message.textContent())!);
  await expect.poll(() => getSelection(artifact.id)).toMatchObject({ timestampNs });
  const identity = await readPanelReference(page, frame);
  expect((await getView(identity))?.snapshot).toMatchObject({ selected: { timestampNs } });
  await frame.locator('.message-view').scrollIntoViewIfNeeded();
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
    await expect(frame.locator('main')).toHaveAccessibleName(name);
    if (name.endsWith('.mcap')) {
      await expect(frame.getByRole('slider', { name: 'Recording timeline' })).toBeVisible();
      await frame.getByRole('slider', { name: 'Recording timeline' }).fill('5000');
      await expect(frame.locator('footer')).toHaveCount(0);
    } else await expect(frame.locator(readyModel)).toBeVisible();
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
          '.usd',
          '.usda',
          '.usdc',
          '.usdz',
          '.urdf',
          '.sdf',
          '.world',
          '.mjcf',
          '.dae',
        ]),
      },
    ],
  });
  const extensions = (ui as { entrypoints: { extensions: string[] }[] }).entrypoints[0].extensions;
  for (const extension of [
    '.xml',
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

test('native QuickTime preview shares by double-click and expands with its fullscreen icon', async ({
  page,
}) => {
  const input = { file: { name: 'quicktime.MOV', resourceUri: 'host-resource://quicktime' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  expect(result.isError).toBeFalsy();
  // Remuxed from samples/video.mp4 using avconvert's PresetPassthrough.
  const blob = await readFile(resolve('test/fixtures/quicktime.mov'), 'base64');
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: { uri: input.file.resourceUri, mimeType: 'application/octet-stream', blob },
    chatContext: true,
    imageContext: true,
    browserFullscreen: true,
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
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await seekCamera(video, 0.5);
  await expect(video).toHaveJSProperty('seeking', false);
  await video.dblclick();
  const identity = await readPanelReference(page, frame);
  expect((await getVisualContext(identity)).snapshot).toMatchObject({
    selected: { item: { id: 'time:0.500' } },
  });
  expect(await video.evaluate((element) => element.ownerDocument.fullscreenElement)).toBeNull();
  await expect(video).toHaveJSProperty('paused', true);

  // Playwright locators cannot see the browser's own media controls.
  await video.hover();
  const session = await page.context().newCDPSession(page);
  await session.send('DOM.enable');
  const { nodes } = await session.send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
  const icon = nodes.find(
    ({ attributes }) =>
      attributes?.includes('-webkit-media-controls-fullscreen-button') &&
      !attributes.includes('aria-hidden'),
  );
  expect(icon).toBeDefined();
  const { model } = await session.send('DOM.getBoxModel', { nodeId: icon!.nodeId });
  const [left, top, , , right, bottom] = model.content;
  await page.mouse.click((left + right) / 2, (top + bottom) / 2);
  await expect.poll(() => video.evaluate((element) => element.matches(':fullscreen'))).toBe(true);
  await session.detach();
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
  await expect(frame.locator(readyModel)).toBeVisible();
});

for (const [path, preview] of [
  ['part.step', 'model'],
  ['part.iges', 'model'],
  ['points.laz', 'model'],
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
    if (preview === 'model') await expect(frame.locator(readyModel)).toBeVisible();
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
  await expect(frame.locator('main')).toHaveAccessibleName(input.file.name);
  await expect(frame.locator('.recording-summary, .camera-detail')).toHaveCount(0);
  await expect(frame.getByRole('combobox', { name: 'Recording topic' })).toHaveCount(0);
  await expect(frame.locator('.camera-screen .preview-pane-title')).toHaveText('/camera/front');
  await expect(frame.getByRole('button', { name: /(?:previous|next) frame/i })).toHaveCount(0);
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
  const video = frame.getByLabel('Recorded camera video');
  await expect(video).toHaveJSProperty('controls', true);
  const side = frame.getByRole('button', { name: '/camera/side', exact: true });
  await side.press('Space');
  await expect(side).toBeFocused();
  await expect(frame.locator('.camera-screen .preview-pane-title')).toHaveText('/camera/side');
  await frame.getByRole('button', { name: '/camera/front', exact: true }).click();
  const bounds = (await video.boundingBox())!;
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await expect(frame.getByRole('button', { name: 'Select video timestamp' })).toHaveCount(0);
  await expect(frame.getByText('Review options', { exact: true })).toHaveCount(0);
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

async function seekCamera(video: Locator, time: number) {
  await video.evaluate((element: HTMLVideoElement, target) => {
    element.currentTime = target;
  }, time);
}

async function checkCameraPlayback(view: FrameLocator) {
  const video = view.getByLabel('Recorded camera video');
  await expect(video).toHaveJSProperty('controls', true);
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42000000000');
  const fingerprint = () =>
    video.evaluate((element: HTMLVideoElement) => {
      const stamp = document.createElement('canvas');
      stamp.width = element.videoWidth;
      stamp.height = element.videoHeight;
      const context = stamp.getContext('2d')!;
      context.drawImage(element, 0, 0);
      const p = context.getImageData(0, 0, stamp.width, stamp.height).data;
      let sum = 0;
      for (let i = 0; i < p.length; i += 4)
        sum = (sum + p[i] * (i + 1) + p[i + 1] * 3 + p[i + 2] * 7) % 2147483647;
      return sum;
    });
  expect(await fingerprint()).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect
    .poll(async () => BigInt((await video.getAttribute('data-frame-timestamp-ns')) ?? '0'))
    .toBeGreaterThan(42200000000n);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await expect(video).toHaveJSProperty('paused', true);
  await seekCamera(video, 0.525);
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42500000000');
  const cameraPixels = await fingerprint();
  await view.getByRole('button', { name: '/camera/side', exact: true }).click();
  await expect(video).toHaveAttribute('data-camera', '/camera/side');
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42500000000');
  expect(await fingerprint()).not.toBe(cameraPixels);
  await seekCamera(video, 0.125);
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42100000000');
  await video.dblclick();
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.125);
  await expect(view.getByRole('alert')).toHaveCount(0);
}

test('camera video plays, pauses, seeks and switches cameras for an indexed workspace file', async ({
  page,
}) => {
  const frame = page.frameLocator('#app');
  const artifact = await open(page, resolve(temp, 'cameras.mcap'));
  await checkCameraPlayback(frame);
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

test('camera video uses native playback when the host has no WebCodecs decoder', async ({
  page,
}) => {
  const frame = page.frameLocator('#app');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'VideoDecoder', { value: undefined });
  });
  await open(page, resolve(temp, 'cameras.mcap'));
  const video = frame.getByLabel('Recorded camera video');
  await expect(video).toHaveJSProperty('controls', true);
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '42000000000');
  await expect(frame.getByRole('alert')).toHaveCount(0);
});

test('DreamTac swaps same-height previews, keeps the playhead, and shares exact pose and gripper readings', async ({
  page,
}) => {
  const path = resolve('samples/external/dreamtac-cut-banana-episode-017.mcap');
  test.skip(!existsSync(path), 'Local DreamTac recording is optional.');
  await page.setViewportSize({ width: 500, height: 800 });
  const frame = await openNativeFixture(page, path);
  const video = frame.getByLabel('Recorded camera video');
  const topic = (name: string) => frame.getByRole('button', { name, exact: true });
  await expect(video).toHaveJSProperty('controls', true);
  const { height: videoHeight } = (await frame.locator('.camera-screen').boundingBox())!;
  await expect(frame.locator('.camera-screen .preview-pane-title')).toHaveText('/camera');
  await expect(frame.getByRole('button', { name: '/camera', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await seekCamera(video, 0.125);
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '1000000000100000000');
  await video.dblclick();
  const identity = await readPanelReference(page, frame);
  const shared = await getVisualContext(identity);
  expect(shared.snapshot).toMatchObject({
    selected: { timestampNs: '1000000000100000000' },
  });
  expect(shared.image).toBeTruthy();
  await video.hover();
  await video.screenshot({ path: 'test-results/dreamtac-native-video.png' });

  await seekCamera(video, 2.0125);
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '1000000002000000000');
  const gripper = frame.getByRole('button', { name: '/gripper.plot', exact: true });
  await gripper.click();
  const graph = frame.getByRole('slider', { name: '/gripper.plot timeline' });
  await expect(frame.locator('.mcap-plot .preview-pane-title')).toHaveText('/gripper.plot');
  await expect(video).toHaveCount(0);
  expect(
    (await frame.getByRole('region', { name: '/gripper.plot graph' }).boundingBox())!.height,
  ).toBe(videoHeight);
  await expect(graph).toHaveAttribute('aria-valuenow', '25');

  await graph.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await graph.boundingBox())!;
  const center = y + height / 2;
  await page.mouse.move(x + width * 0.1, center);
  await page.mouse.down();
  await page.mouse.move(x + width * 0.75, center, { steps: 6 });
  await page.mouse.up();
  await expect(graph).toHaveAttribute('aria-valuenow', '75');
  await topic('/camera').click();
  await expect(frame.getByRole('button', { name: '/camera', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(6.04, 1);
  await topic('/gripper.plot').click();
  await expect(gripper).toHaveAttribute('aria-pressed', 'true');
  await expect(graph).toHaveAttribute('aria-valuenow', '75');
  expect((await getVisualContext(identity)).snapshot).toMatchObject({
    selected: { timestampNs: '1000000000100000000' },
  });

  await graph.dblclick({ position: { x: width * 0.49, y: height / 2 } });
  const selected = {
    timestampNs: '1000000003950000000',
    channelId: 8,
    item: {
      label: '/gripper.plot · opening',
      details: expect.stringMatching(/^opening = -?\d/),
    },
  };
  await expect
    .poll(async () => (await getVisualContext(identity)).snapshot)
    .toMatchObject({ selected });
  await expect(page.locator('html')).toHaveAttribute('data-chat-context', /opening = .*?/);
  await expect(graph.locator('.mcap-plot-shared')).toBeVisible();
  await page.screenshot({ path: 'test-results/dreamtac-telemetry.png' });
  await topic('/camera').click();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(3.95);
  await seekCamera(video, 6);
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', '1000000006000000000');
  await topic('/gripper.plot').click();
  await expect(graph).toHaveAttribute('aria-valuenow', '75');
  expect((await getVisualContext(identity)).snapshot).toMatchObject({ selected });
  await page.getByRole('button', { name: 'Remove context', exact: true }).click();
  await expect(graph.locator('.mcap-plot-shared')).toHaveCount(0);

  await topic('/end-effector-pose').click();
  await expect(
    frame.getByRole('button', { name: '/end-effector-pose', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const fields = frame.getByRole('combobox', { name: 'Graph field' });
  await expect(fields.locator('option')).toHaveText([
    'position.x',
    'position.y',
    'position.z',
    'orientation.x',
    'orientation.y',
    'orientation.z',
    'orientation.w',
  ]);
  const pose = frame.getByRole('slider', { name: '/end-effector-pose timeline' });
  await fields.press('Space');
  await expect.poll(() => fields.evaluate((element) => element.matches(':open'))).toBe(true);
  expect(
    await fields.evaluate((element) => getComputedStyle(element, '::picker(select)').appearance),
  ).toBe('base-select');
  await page.screenshot({ path: 'test-results/dreamtac-field-menu.png' });
  await fields.press('Escape');
  await expect(fields).toBeFocused();
  await fields.selectOption('orientation.w');
  await pose.press('Home');
  await expect(pose).toHaveAttribute('aria-valuetext', /· orientation.w 0\.03408/);
  await pose.press('Enter');
  const poseView = await readPanelReference(page, frame);
  expect((await getVisualContext(poseView)).snapshot).toMatchObject({
    selected: {
      timestampNs: '1000000000000000000',
      channelId: 6,
      item: { details: 'orientation.w = 0.034079536003309825' },
    },
  });
  const position = frame.getByRole('slider', { name: 'Graph playback position' });
  const play = frame.getByRole('button', { name: 'Play graph' });
  const pause = frame.getByRole('button', { name: 'Pause graph' });
  await play.click();
  await expect(pause).toBeVisible();
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(0);
  await pause.click();
  await expect(play).toBeVisible();
  await play.click();
  await position.fill('500000');
  await expect(play).toBeVisible();
  await expect(pose).toHaveAttribute('aria-valuenow', '50');
  await position.fill('980000');
  await play.click();
  await expect(pose).toHaveAttribute('aria-valuenow', '100');
  await expect(play).toBeVisible();
  await play.click();
  await expect(pause).toBeVisible();
  await expect.poll(async () => Number(await position.inputValue())).toBeLessThan(500000);
  await pause.click();
  await page.screenshot({ path: 'test-results/dreamtac-pose.png' });
});

test('DreamTac preserves playback and pane size when switching topics', async ({ page }) => {
  const path = resolve('samples/external/dreamtac-cut-banana-episode-017.mcap');
  test.skip(!existsSync(path), 'Local DreamTac recording is optional.');
  const frame = await openNativeFixture(page, path);
  const video = frame.getByLabel('Recorded camera video');
  const topic = (name: string) => frame.getByRole('button', { name, exact: true });
  const progress = frame.getByRole('slider', { name: 'Graph playback position' });
  const videoTime = () => video.evaluate((element: HTMLVideoElement) => element.currentTime);
  const graphTime = async () => (Number(await progress.inputValue()) * 8.05) / 1_000_000;
  await expect(video).toHaveJSProperty('controls', true);
  await seekCamera(video, 1.5);
  await expect(video).toHaveJSProperty('seeking', false);
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(videoTime).toBeGreaterThan(1.7);
  await topic('/camera').click();
  await expect(video).toHaveJSProperty('paused', false);
  const fromVideo = await videoTime();

  await topic('/gripper.plot').click();
  await expect(frame.getByRole('button', { name: 'Pause graph' })).toBeVisible();
  expect(await graphTime()).toBeGreaterThanOrEqual(fromVideo - 0.05);
  await expect.poll(graphTime).toBeGreaterThan(fromVideo + 0.15);
  const fromGraph = await graphTime();

  await topic('/camera').click();
  await expect(video).toHaveJSProperty('controls', true);
  await expect(video).toHaveJSProperty('paused', false);
  expect(await videoTime()).toBeGreaterThanOrEqual(fromGraph - 0.05);
  await expect.poll(videoTime).toBeGreaterThan(fromGraph + 0.15);

  await video.evaluate((element: HTMLVideoElement) => element.pause());
  const pausedAt = await videoTime();
  await topic('/gripper.plot').click();
  await expect(frame.getByRole('button', { name: 'Play graph' })).toBeVisible();
  expect(await graphTime()).toBeCloseTo(pausedAt, 3);
  await topic('/camera').click();
  await expect(video).toHaveJSProperty('controls', true);
  await expect(video).toHaveJSProperty('paused', true);
  await expect.poll(videoTime).toBeCloseTo(pausedAt, 3);
  const preview = frame.locator('.mcap-preview');
  const cameraHeight = (await preview.boundingBox())!.height;
  await topic('/instruction').click();
  const messagePane = frame.getByRole('region', { name: '/instruction messages' });
  const message = messagePane.getByLabel('/instruction message', { exact: true });
  await expect(messagePane.locator(':scope > .preview-pane-title:first-child')).toHaveText(
    '/instruction',
  );
  await expect(message).toHaveText('Cut the banana with a knife.');
  expect((await preview.boundingBox())!.height).toBeCloseTo(cameraHeight, 1);
  await expect(messagePane.getByRole('button', { name: 'Play recording' })).toBeVisible();
  const messagePosition = messagePane.getByRole('slider', { name: 'Recording playback position' });
  expect((Number(await messagePosition.inputValue()) * 8.05) / 1_000_000).toBeCloseTo(pausedAt, 3);
  const positionBeforeClick = await messagePosition.inputValue();
  await topic('/instruction').click();
  await expect(message).toBeVisible();
  await expect(messagePosition).toHaveValue(positionBeforeClick);
});

test('Codex can open an MCAP with an arranged workspace preview', async ({ page }) => {
  const layout = {
    columns: 2,
    panes: [
      { channelId: 1, field: 'value' },
      { channelId: 1, field: 'frame' },
    ],
  };
  const input = { path: 'robot.mcap', layout };
  const result = await client.callTool({ name: 'artifact_open', arguments: input });
  expect(result.isError).toBeFalsy();
  const frame = await openEmbedded(page, { input, result });
  await expect(frame.locator('.mcap-panes .preview-pane-title')).toHaveText([
    '/telemetry/temperature',
    '/telemetry/temperature',
  ]);
  const fields = frame.getByRole('combobox', { name: 'Graph field' });
  await expect(fields.nth(0)).toHaveValue('value');
  await expect(fields.nth(1)).toHaveValue('frame');
  await expect(frame.getByRole('group', { name: 'Recording playback' })).toHaveCount(1);
});

test('Codex lays out DreamTac plots and cameras with one playhead', async ({ page }) => {
  const path = resolve('samples/external/dreamtac-cut-banana-episode-017.mcap');
  test.skip(!existsSync(path), 'Local DreamTac recording is optional.');
  await page.setViewportSize({ width: 500, height: 800 });
  const frame = await openNativeFixture(page, path);
  const videos = frame.getByLabel('Recorded camera video');
  const titles = frame.locator('.mcap-panes .preview-pane-title');
  await expect(videos).toHaveJSProperty('controls', true);
  await videos.dblclick();
  const identity = await readPanelReference(page, frame);
  const layout = {
    columns: 2 as const,
    panes: [
      { channelId: 8, field: 'opening' },
      { channelId: 6, field: 'position.z' },
    ],
  };
  await changeView(identity, { kind: 'mcap_view', layout });
  await expect(titles).toHaveText(['/gripper.plot', '/end-effector-pose']);
  await expect(videos).toHaveCount(0);
  await expect(frame.getByRole('combobox', { name: 'Graph field' })).toHaveValue('position.z');
  const first = (await titles.nth(0).boundingBox())!;
  const second = (await titles.nth(1).boundingBox())!;
  expect(second.x).toBeGreaterThan(first.x);
  expect(Math.abs(second.y - first.y)).toBeLessThan(4);
  await page.screenshot({ path: 'test-results/dreamtac-two-plots.png' });
  expect((await getView(identity))?.snapshot).toMatchObject({ context: { layout } });

  await changeView(identity, {
    kind: 'mcap_view',
    layout: { columns: 2, panes: [{ channelId: 2 }, { channelId: 3 }, { channelId: 8 }] },
  });
  await expect(titles).toHaveText(['/camera', '/wrist-camera', '/gripper.plot']);
  await expect(frame.getByRole('combobox', { name: 'Recording topic' })).toHaveCount(0);
  await expect(videos).toHaveCount(2);
  const position = frame.getByRole('slider', { name: 'Recording playback position' });
  await position.fill('250000');
  const videoTimes = () =>
    videos.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLVideoElement).currentTime),
    );
  await expect
    .poll(async () => (await videoTimes()).every((time) => Math.abs(time - 2.0125) < 0.035))
    .toBe(true);
  await expect(frame.getByRole('slider', { name: '/gripper.plot timeline' })).toHaveAttribute(
    'aria-valuenow',
    '25',
  );
  await frame.getByRole('button', { name: 'Play recording' }).click();
  await expect.poll(async () => (await videoTimes()).every((time) => time > 2.15)).toBe(true);
  await frame.getByRole('button', { name: 'Pause recording' }).click();
  const [front, wrist] = await videoTimes();
  expect(Math.abs(front - wrist)).toBeLessThan(0.2);
  await position.fill('250000');
  await position.fill('251000');
  await expect(videos.nth(1)).toHaveAttribute('data-frame-timestamp-ns', '1000000002000000000');
  await page.screenshot({ path: 'test-results/dreamtac-mixed-layout.png' });
  await videos.nth(1).dblclick();
  await expect
    .poll(async () => (await getVisualContext(identity)).snapshot)
    .toMatchObject({
      selected: { channelId: 3, timestampNs: expect.any(String) },
    });
  expect((await getVisualContext(identity)).image).toBeTruthy();
  await changeView(identity, { kind: 'undo' });
  await expect(titles).toHaveText(['/gripper.plot', '/end-effector-pose']);
});

test('Codex shows every DreamTac topic with one reachable playback control', async ({ page }) => {
  const path = resolve('samples/external/dreamtac-cut-banana-episode-017.mcap');
  test.skip(!existsSync(path), 'Local DreamTac recording is optional.');
  await page.setViewportSize({ width: 500, height: 810 });
  const frame = await openNativeFixture(page, path);
  const video = frame.getByLabel('Recorded camera video');
  await expect(video).toHaveJSProperty('controls', true);
  await video.dblclick();
  const identity = await readPanelReference(page, frame);
  const layout = { allTopics: true as const };
  await changeView(identity, { kind: 'mcap_view', layout });
  await expect(frame.locator('.mcap-panes .preview-pane-title')).toHaveText([
    '/instruction',
    '/camera',
    '/wrist-camera',
    '/tactile-left',
    '/tactile-right',
    '/end-effector-pose',
    '/end-effector.plot',
    '/gripper.plot',
  ]);
  expect((await getView(identity))?.snapshot).toMatchObject({ context: { layout } });
  const message = frame.getByLabel('/instruction message', { exact: true });
  await expect(message).toHaveText('Cut the banana with a knife.');
  await expect(
    frame.locator('.mcap-panes .preview-pane > .preview-pane-title:first-child'),
  ).toHaveCount(8);
  const transport = frame.getByRole('group', { name: 'Recording playback', exact: true });
  await expect(transport).toHaveCount(1);
  await expect(transport).toBeInViewport();
  await expect(video).toHaveCount(4);
  await transport.getByRole('slider').fill('250000');
  await expect
    .poll(() =>
      video.evaluateAll((elements) =>
        elements.every(
          (element) => Math.abs((element as HTMLVideoElement).currentTime - 2.0125) < 0.035,
        ),
      ),
    )
    .toBe(true);
  await expect(frame.getByRole('slider', { name: '/gripper.plot timeline' })).toHaveAttribute(
    'aria-valuenow',
    '25',
  );
  await message.dblclick();
  await expect
    .poll(async () => (await getVisualContext(identity)).snapshot)
    .toMatchObject({
      selected: {
        timestampNs: '1000000000000000000',
        channelId: 1,
        item: { label: '/instruction', details: expect.stringContaining('Cut the banana') },
      },
    });
  const panes = frame.locator('.mcap-panes .preview-pane');
  const messagePane = frame.getByRole('region', { name: '/instruction messages' });
  await message.click();
  expect(
    await panes.evaluateAll(
      (elements) => new Set(elements.map((element) => element.getBoundingClientRect().height)).size,
    ),
  ).toBe(1);
  await messagePane.evaluate((element) => {
    element.dataset.originalPane = 'true';
  });
  await frame.getByRole('button', { name: '/instruction', exact: true }).click();
  await frame.getByRole('button', { name: '/wrist-camera', exact: true }).click();
  await frame.getByRole('button', { name: '/gripper.plot', exact: true }).click();
  await expect(frame.locator('.camera-screen').filter({ hasText: /^\/camera$/ })).toHaveCount(0);
  await expect(messagePane).toHaveAttribute('data-original-pane', 'true');
  await expect(message).toHaveText('Cut the banana with a knife.');
  await expect(frame.locator('.mcap-panes .preview-pane-title')).toHaveCount(8);
  const gripperTopic = frame.getByRole('button', { name: '/gripper.plot', exact: true });
  await gripperTopic.dblclick();
  await expect
    .poll(async () => (await getView(identity))?.snapshot)
    .toMatchObject({
      context: { layout },
      selected: {
        timestampNs: '1000000002012500000',
        channelId: 8,
        item: { label: '/gripper.plot' },
      },
    });
  await expect(frame.locator('.mcap-panes .preview-pane-title')).toHaveCount(8);
  await expect(transport.getByRole('slider')).toHaveValue('250000');
  await page.setViewportSize({ width: 1024, height: 810 });
  await frame.locator('.mcap-view').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: 'test-results/dreamtac-all-topics.png' });
});

async function mockSiteTools(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, { execute: (args: unknown) => unknown }>();
    Object.defineProperty(document, 'modelContext', {
      value: {
        registerTool(tool: { name: string; execute: (args: unknown) => unknown }) {
          tools.set(tool.name, tool);
        },
      },
    });
    Object.assign(window, {
      callSiteTool: (name: string, args: unknown) => tools.get(name)?.execute(args),
    });
  });
}

function runSiteTool(frame: FrameLocator, name: string, args: object = {}) {
  return frame.getByRole('main').evaluate(
    (element, [tool, input]) => {
      const host = element.ownerDocument.defaultView as Window & {
        callSiteTool: (name: string, args: unknown) => unknown;
      };
      return host.callSiteTool(tool, input);
    },
    [name, args] as const,
  );
}

test('WebMCP reads and arranges the open MCAP without a chat attachment', async ({ page }) => {
  await mockSiteTools(page);
  const dreamtac = resolve('samples/external/dreamtac-cut-banana-episode-017.mcap');
  const path = existsSync(dreamtac) ? dreamtac : resolve(temp, 'cameras.mcap');
  const frame = await openNativeFixture(page, path);
  const video = frame.getByLabel('Recorded camera video');
  await expect(video).toHaveAttribute('data-frame-timestamp-ns', /^\d+$/);
  const main = frame.getByRole('main');
  await main.evaluate((element) => {
    element.dataset.originalPanel = 'true';
  });
  const call = (name: string, args?: object) => runSiteTool(frame, name, args);
  const { snapshot } = (await call('tesseract_read_view')) as {
    snapshot: { name: string; recording: { topics: { id: number; name: string }[] } };
  };
  expect(snapshot.name).toBe(basename(path));
  const topics = snapshot.recording.topics.map(({ name }) => name);
  expect(topics.length).toBeGreaterThan(1);
  if (path === dreamtac) expect(topics).toHaveLength(8);
  expect(await call('tesseract_read_view', { includeImage: true })).toMatchObject({
    structuredContent: { hasImage: true },
    content: [{ type: 'image', mimeType: 'image/jpeg' }],
  });
  expect(
    await call('tesseract_change_view', { action: { kind: 'mcap_view', layout: { columns: 9 } } }),
  ).toEqual({ error: 'Invalid view action.' });
  const layout = { allTopics: true };
  expect(
    await call('tesseract_change_view', { action: { kind: 'mcap_view', layout } }),
  ).toMatchObject({
    message: 'Updated recording view.',
  });
  await expect(frame.locator('.mcap-panes .preview-pane-title')).toHaveText(topics);
  expect(await call('tesseract_read_view')).toMatchObject({ snapshot: { context: { layout } } });
  const remaining = snapshot.recording.topics.filter(({ name }) => name !== '/instruction');
  const channelIds = remaining.map(({ id }) => id);
  const fullWidthLayout = {
    columns: 2,
    panes: channelIds.map((channelId, index) =>
      index === 0 ? { channelId, fullWidth: true } : { channelId },
    ),
  };
  const playhead = frame.getByRole('slider', { name: 'Recording playback position' });
  await playhead.fill('250000');
  expect(
    await call('tesseract_change_view', {
      action: { kind: 'mcap_view', channelIds, layout: fullWidthLayout },
    }),
  ).toMatchObject({ message: 'Updated recording view.' });
  const grid = frame.locator('.mcap-panes');
  const titles = grid.locator('.preview-pane-title');
  await expect(titles).toHaveText(remaining.map(({ name }) => name));
  const fullWidthPane = grid.locator('.mcap-full-width-pane');
  await expect(fullWidthPane.locator('.preview-pane-title')).toHaveText(remaining[0].name);
  for (const width of [500, 1024]) {
    await page.setViewportSize({ width, height: 810 });
    const gridWidth = (await grid.boundingBox())!.width;
    expect((await fullWidthPane.boundingBox())!.width).toBeCloseTo(gridWidth, 1);
    expect((await titles.nth(1).boundingBox())!.width).toBeLessThan(gridWidth);
  }
  await expect(playhead).toHaveValue('250000');
  await expect(frame.getByRole('button', { name: '/instruction', exact: true })).toHaveCount(0);
  await expect(main).toHaveAttribute('data-original-panel', 'true');
  await expect(page.locator('html')).not.toHaveAttribute('data-chat-context', /\S/);
  await expect(frame.getByLabel('View reference')).toHaveCount(0);
});

test('renames a ZIP entry in place and reopens its original contents', async ({ page }) => {
  const input = { file: { name: 'bundle.zip', resourceUri: 'host-resource://writable-zip' } };
  const source = zipSync({ 'readme.txt': strToU8('archive contents') });
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'application/zip',
      blob: Buffer.from(source).toString('base64'),
    },
    writeFile: true,
    resourceUpdates: true,
  });
  await frame.getByRole('button', { name: 'readme.txt', exact: true }).click();
  await frame.getByRole('button', { name: 'Rename archive entry' }).click();
  await frame.getByRole('textbox', { name: 'Rename archive entry' }).fill('renamed.txt');
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-saved-file', /\S/);
  const saved = Buffer.from(
    (await page.locator('html').getAttribute('data-saved-file'))!,
    'base64',
  );
  expect(unzipSync(saved)).toEqual({ 'renamed.txt': strToU8('archive contents') });
  await expect(frame.getByRole('button', { name: 'renamed.txt', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-file-reads', '1');
});

for (const resourceUpdates of [true, false]) {
  test(`an external edit refreshes a ZIP above 1 MiB ${resourceUpdates ? 'from its host notification' : 'with the older host fallback'}`, async ({
    page,
  }) => {
    const uri = 'host-resource://large-zip';
    const input = { file: { name: 'large.zip', resourceUri: uri } };
    const archive = (entry: string) =>
      Buffer.from(
        zipSync(
          {
            [entry]: strToU8('archive contents'),
            'padding.bin': new Uint8Array(2 * 1024 * 1024),
          },
          { level: 0 },
        ),
      ).toString('base64');
    const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
    const frame = await openEmbedded(page, {
      input,
      result,
      resourceUpdates,
      writeFile: !resourceUpdates,
      fileResource: { uri, mimeType: 'application/zip', blob: archive('before.txt') },
    });
    const host = page.locator('html');
    const main = frame.getByRole('main', { name: 'large.zip' });
    await expect(frame.getByRole('button', { name: 'before.txt' })).toBeVisible();
    await main.evaluate((element) => {
      element.dataset.samePanel = 'true';
    });
    if (resourceUpdates) {
      await expect(host).toHaveAttribute('data-subscribed-file', uri);
      await host.evaluate((element) => {
        element.dataset.notifyResource = 'host-resource://other';
      });
    }
    await host.evaluate(
      (element, { next, changedUri }) => {
        element.dataset.externalFile = next;
        if (changedUri) element.dataset.notifyResource = changedUri;
      },
      { next: archive('after.txt'), changedUri: resourceUpdates ? uri : undefined },
    );
    await expect(frame.getByRole('button', { name: 'after.txt' })).toBeVisible();
    await expect(main).toHaveAttribute('data-same-panel', 'true');
    if (resourceUpdates) await expect(host).toHaveAttribute('data-file-reads', '2');
  });
}

test('renames an MCAP topic in the native file session', async ({ page }) => {
  const input = { file: { name: 'robot.mcap', resourceUri: 'host-resource://writable-mcap' } };
  const source = await readFile(resolve('samples/robot.mcap'));
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'application/octet-stream',
      blob: source.toString('base64'),
    },
    writeFile: true,
  });
  const rename = 'Rename /joint_states';
  await frame.getByRole('button', { name: rename, exact: true }).click();
  await frame.getByRole('textbox', { name: rename, exact: true }).fill('/arm/joint_states');
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-saved-file', /\S/);
  await expect(
    frame.getByRole('button', { name: 'Rename /arm/joint_states', exact: true }),
  ).toBeVisible();
});

test('the open STEP panel renders both its own save and an external revision', async ({ page }) => {
  await mockSiteTools(page);
  const source = await readFile(
    resolve('node_modules/occt-import-js/test/testfiles/cax-if/io1-tu-203.stp'),
  );
  const original = Buffer.from("#1345=OVER_RIDING_STYLED_ITEM('',(#1313),#1096,#1306);");
  const updated = Buffer.from("#1345=OVER_RIDING_STYLED_ITEM('',(#1333),#1096,#1306);");
  const offset = source.indexOf(original);
  expect(offset).toBeGreaterThan(0);
  const input = { file: { name: 'Torus.step', resourceUri: 'host-resource://torus' } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  const frame = await openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'model/step',
      blob: source.toString('base64'),
    },
    writeFile: true,
  });
  const canvas = frame.locator(readyModel);
  await expect(canvas).toBeVisible();
  const main = frame.getByRole('main', { name: 'Torus.step' });
  await main.evaluate((element) => {
    element.dataset.initialPanel = 'true';
  });
  const countRed = async () => {
    await canvas.press('2');
    const capture = (await runSiteTool(frame, 'tesseract_read_view', { includeImage: true })) as {
      content: { data: string }[];
    };
    return canvas.evaluate(async (element, base64) => {
      const document = element.ownerDocument;
      const image = document.createElement('img');
      image.src = 'data:image/jpeg;base64,' + base64;
      await image.decode();
      const buffer = document.createElement('canvas');
      buffer.width = image.width;
      buffer.height = image.height;
      const imageContext = buffer.getContext('2d')!;
      imageContext.drawImage(image, 0, 0);
      const { data } = imageContext.getImageData(0, 0, buffer.width, buffer.height);
      let red = 0;
      for (let index = 0; index < data.length; index += 4)
        if (
          data[index] > 120 &&
          data[index] > data[index + 1] * 2 &&
          data[index] > data[index + 2] * 2
        )
          red++;
      return red;
    }, capture.content[0].data);
  };
  const redBefore = await countRed();
  const bytes = (await runSiteTool(frame, 'tesseract_read_file_bytes', {
    offset,
    length: original.length,
  })) as {
    artifactId: string;
    revision: string;
    base64: string;
  };
  expect(bytes.base64).toBe(original.toString('base64'));
  const patch = {
    artifactId: bytes.artifactId,
    revision: bytes.revision,
    offset,
    expectedBase64: bytes.base64,
    replacementBase64: updated.toString('base64'),
  };
  await page.locator('html').evaluate((element) => {
    element.dataset.forceConflict = 'true';
  });
  expect(await runSiteTool(frame, 'tesseract_patch_file', patch)).toEqual({
    error: 'The file changed. Reload it before saving.',
  });
  expect(await page.locator('html').getAttribute('data-saved-file')).toBeNull();
  await page.locator('html').evaluate((element) => {
    delete element.dataset.forceConflict;
  });
  expect(await runSiteTool(frame, 'tesseract_patch_file', patch)).toMatchObject({
    outcome: 'saved',
  });
  const expected = Buffer.concat([
    source.subarray(0, offset),
    updated,
    source.subarray(offset + original.length),
  ]);
  expect(await page.locator('html').getAttribute('data-saved-file')).toBe(
    expected.toString('base64'),
  );
  await expect(frame.getByRole('main')).toHaveAccessibleName('Torus.step');
  await expect(canvas).toBeVisible();
  await expect.poll(countRed).toBeGreaterThan(redBefore + 100);
  await page.locator('html').evaluate((element, blob) => {
    element.dataset.externalFile = blob;
  }, source.toString('base64'));
  await expect.poll(countRed).toBeLessThan(redBefore + 50);
  await expect(main).toHaveAttribute('data-initial-panel', 'true');
});

async function openNativeFixture(page: Page, path: string, bound = false) {
  const name = basename(path);
  const input = { file: { name, resourceUri: `host-resource://${name}` } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  expect(result.isError).toBeFalsy();
  return openEmbedded(page, {
    input,
    result,
    boundFilePath: bound ? path : undefined,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'application/octet-stream',
      blob: await readFile(path, 'base64'),
    },
    chatContext: true,
    imageContext: true,
    contextLifecycle: true,
  });
}

for (const file of ['7z', 'rar', 'cab', 'iso', 'txt.xz', 'txt.bz2', 'txt.zst']) {
  test(`expanded formats browse ${file} and share an entry in the native panel`, async ({
    page,
  }) => {
    const frame = await openNativeFixture(page, resolve('test/fixtures/archives', `notes.${file}`));
    await frame.getByRole('button', { name: /^notes\.txt$/i }).click();
    const text = frame.getByLabel('Text preview');
    await expect(text).toContainText('Archive preview fixture');
    await text.dblclick();
    const identity = await readPanelReference(page, frame);
    expect((await getView(identity))?.snapshot).toMatchObject({
      context: { kind: 'container', textPreview: 'Archive preview fixture\n' },
    });
  });
}

for (const name of ['3mf', 'amf', 'fbx', '3ds', '3dm', 'dxf', 'ifc', 'brep']) {
  test(`expanded formats pick and share ${name} geometry in the native panel`, async ({ page }) => {
    const path =
      name === 'brep'
        ? resolve('node_modules/occt-import-js/test/testfiles/cax-if-brep/as1_pe_203.brep')
        : resolve('test/fixtures/geometry', `block.${name}`);
    const frame = await openNativeFixture(page, path);
    await expect(frame.locator(readyModel)).toBeVisible({ timeout: 20000 });
    const { canvas, position } = await pickVisiblePart(frame);
    await canvas.dblclick({ position });
    const identity = await readPanelReference(page, frame);
    expect(await getVisualContext(identity)).toMatchObject({
      imageMatchesSnapshot: true,
      snapshot: { format: name, selected: { objectId: expect.any(String) } },
    });
  });
}

for (const [name, label] of [
  ['bands.tif', /Band 1 preview/],
  ['layers.psd', /Composite preview/],
  ['sample.exr', /Composite preview/],
  ['sample.hdr', /Composite preview/],
  ['frames.dcm', /Frame 1 preview/],
  ['slices.nii', /Slice \d+ preview/],
  ['slices.nii.gz', /Slice \d+ preview/],
  ['slices.nrrd', /Slice \d+ preview/],
] as const) {
  test(`expanded formats render and share ${name} without sending file bytes to chat`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 440, height: 760 });
    const frame = await openNativeFixture(page, resolve('test/fixtures/raster', name));
    if (name.endsWith('.tif')) await frame.getByLabel('Channel').selectOption({ label: 'Band 1' });
    await frame.getByRole('button', { name: label }).dblclick();
    const context = await getVisualContext(await readPanelReference(page, frame));
    expect(context.snapshot).toMatchObject({
      name,
      selected: { item: { id: expect.any(String) } },
    });
    if (name.endsWith('.dcm')) expect(context.image).toBeFalsy();
    else expect(context.image).toBeTruthy();
  });
}

test('expanded formats read a Shapefile’s attributes inside an archive', async ({ page }) => {
  const path = resolve(temp, 'map-companions.zip');
  await writeFile(
    path,
    zipSync({
      'maps/stations.shp': await readFile(resolve('test/fixtures/structured/stations.shp')),
      'maps/stations.dbf': await readFile(resolve('test/fixtures/structured/stations.dbf')),
    }),
  );
  const frame = await openNativeFixture(page, path);
  await frame.getByRole('button', { name: 'maps', exact: true }).click();
  await frame.getByRole('button', { name: 'stations.shp', exact: true }).click();
  await frame.getByLabel('Map feature').selectOption({ label: 'Downtown station' });
  await frame.getByLabel('Map preview').press('Enter');
  const identity = await readPanelReference(page, frame);
  expect((await getView(identity))?.snapshot).toMatchObject({
    selected: { item: { label: 'Downtown station' } },
  });
});

for (const [ext, kind] of [
  ['avi', 'video'],
  ['mpg', 'video'],
  ['wmv', 'video'],
  ['flac', 'audio'],
  ['aiff', 'audio'],
]) {
  test(`expanded formats play and share ${ext} in the native panel`, async ({ page }) => {
    test.skip(
      ext !== 'flac' && !process.env.TESSERACT_FFMPEG,
      'Set TESSERACT_FFMPEG for conversion tests.',
    );
    const frame = await openNativeFixture(page, resolve('test/fixtures/media', `sample.${ext}`));
    const media = frame.locator(kind);
    await expect
      .poll(
        () =>
          media
            .evaluate((node: HTMLMediaElement) => node.readyState, undefined, { timeout: 1000 })
            .catch(() => 0),
        { timeout: 20000 },
      )
      .toBeGreaterThanOrEqual(2);
    await media.dispatchEvent('dblclick', { bubbles: true });
    const context = await getVisualContext(await readPanelReference(page, frame));
    expect(context.snapshot).toMatchObject({ selected: { item: { id: 'time:0.000' } } });
    if (kind === 'video') expect(context.image).toBeTruthy();
  });
}

for (const name of ['rows.sqlite', 'rows.parquet']) {
  test(`expanded formats select and share a row from ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 440, height: 760 });
    const frame = await openNativeFixture(page, resolve('test/fixtures/structured', name));
    if (name === 'rows.sqlite')
      await frame.getByLabel('Table', { exact: true }).selectOption('samples');
    const row = frame.getByRole('row').filter({ hasText: 'sample-0' });
    await row.dblclick();
    const identity = await readPanelReference(page, frame);
    expect((await getView(identity))?.snapshot).toMatchObject({
      selected: { item: { details: expect.stringContaining('sample-0') } },
    });
    await expect(row).toHaveAttribute('data-shared', 'true');
    if (name === 'rows.parquet') await page.screenshot({ path: 'test-results/parquet-panel.png' });
    await page.getByRole('button', { name: 'Remove context', exact: true }).click();
    await expect(row).not.toHaveAttribute('data-shared', 'true');
  });
}

for (const [name, label] of [
  ['tracks.geojson', 'Downtown route'],
  ['tracks.kml', 'Downtown route'],
  ['stations.shp', 'Downtown station'],
]) {
  test(`expanded formats select and share a feature from ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 440, height: 760 });
    const fixture = name.endsWith('.shp')
      ? resolve(temp, name)
      : resolve('test/fixtures/structured', name);
    if (name.endsWith('.shp')) {
      await copyFile(resolve('test/fixtures/structured', name), fixture);
      await copyFile(
        resolve('test/fixtures/structured/stations.dbf'),
        resolve(temp, 'stations.dbf'),
      );
    }
    const frame = await openNativeFixture(page, fixture, name.endsWith('.shp'));
    await expect(frame.getByLabel('Map preview')).toBeVisible();
    await frame.getByLabel('Map feature').selectOption({ label });
    await frame.getByLabel('Map preview').press('Enter');
    const identity = await readPanelReference(page, frame);
    expect(await getVisualContext(identity)).toMatchObject({
      imageMatchesSnapshot: true,
      snapshot: { selected: { item: { label } } },
    });
    if (name === 'tracks.geojson') await page.screenshot({ path: 'test-results/map-panel.png' });
  });
}

for (const [name, label] of [
  ['relu.onnx', 'Relu'],
  ['add.tflite', 'Add'],
  ['weights.safetensors', 'weight'],
  ['weights.gguf', 'weight'],
]) {
  test(`expanded formats inspect and share a model item from ${name}`, async ({ page }) => {
    const frame = await openNativeFixture(page, resolve('test/fixtures/structured', name));
    const row = frame
      .getByRole('row')
      .filter({ hasText: new RegExp(label, 'i') })
      .first();
    await row.dblclick();
    const identity = await readPanelReference(page, frame);
    expect((await getView(identity))?.snapshot).toMatchObject({
      name,
      selected: { item: { id: expect.any(String) } },
    });
  });
}

async function openWritableFixture(page: Page, name: string, source: Buffer) {
  const input = { file: { name, resourceUri: `host-resource://${name}` } };
  const result = await client.callTool({ name: 'artifact_open_file', arguments: input });
  expect(result.isError).toBeFalsy();
  return openEmbedded(page, {
    input,
    result,
    fileResource: {
      uri: input.file.resourceUri,
      mimeType: 'application/octet-stream',
      blob: source.toString('base64'),
    },
    writeFile: true,
  });
}

test('edits a SQLite cell and reads the changed row from the saved database', async ({ page }) => {
  const source = await readFile(resolve('test/fixtures/structured/rows.sqlite'));
  const frame = await openWritableFixture(page, 'rows.sqlite', source);
  const table = frame.getByLabel('Table', { exact: true });
  await table.selectOption('samples');
  await frame.getByRole('row').filter({ hasText: 'sample-0' }).click();
  await frame.getByRole('button', { name: 'Edit cell' }).click();
  await frame.getByLabel('Column', { exact: true }).selectOption({ label: 'name' });
  await frame.getByRole('textbox', { name: 'Cell value', exact: true }).fill('changed sample');
  await frame.getByRole('button', { name: 'Save file' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-saved-file', /\S/);
  await table.selectOption('samples');
  await expect(frame.getByRole('row').filter({ hasText: 'changed sample' })).toBeVisible();
});

test('renames a GeoJSON feature in its open file', async ({ page }) => {
  const source = await readFile(resolve('test/fixtures/structured/tracks.geojson'));
  const frame = await openWritableFixture(page, 'tracks.geojson', source);
  await frame.getByLabel('Map feature').selectOption({ label: 'Downtown route' });
  await frame.getByRole('button', { name: 'Rename feature' }).click();
  const name = frame.getByRole('textbox', { name: 'Feature name', exact: true });
  await name.fill('Central route');
  await name.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-saved-file', /\S/);
  await expect(
    frame.getByLabel('Map feature').locator('option').filter({ hasText: 'Central route' }),
  ).toHaveCount(1);
});

test('a visual GLB color edit saves to the original and reloads with the new material', async ({
  page,
}) => {
  await mockSiteTools(page);
  const original = await readFile(resolve('samples/bracket.glb'));
  const frame = await openWritableFixture(page, 'bracket.glb', original);
  const { canvas } = await pickVisiblePart(frame);
  const objectId = await canvas.getAttribute('data-selected-part');
  await frame.getByRole('button', { name: 'Edit color' }).click();
  await frame.getByLabel('Part color').fill('#ff0000');
  await frame.getByRole('button', { name: 'Save', exact: true }).click();

  const host = page.locator('html');
  await expect(host).toHaveAttribute('data-saved-file', /\S/);
  const edited = Buffer.from((await host.getAttribute('data-saved-file'))!, 'base64');
  expect(edited.subarray(20 + edited.readUInt32LE(12))).toEqual(
    original.subarray(20 + original.readUInt32LE(12)),
  );
  await expect
    .poll(() => runSiteTool(frame, 'tesseract_read_view'))
    .toMatchObject({
      snapshot: {
        name: 'bracket.glb',
        context: {
          objects: expect.arrayContaining([
            { id: objectId, color: '#ff0000', name: expect.any(String), textured: false },
          ]),
        },
      },
    });
});

test('an agent glTF color edit saves to the original document without changing buffer URIs', async ({
  page,
}) => {
  await mockSiteTools(page);
  const binary = await readFile(resolve('samples/bracket.glb'));
  const jsonLength = binary.readUInt32LE(12);
  const source = JSON.parse(binary.subarray(20, 20 + jsonLength).toString());
  const uri =
    'data:application/octet-stream;base64,' + binary.subarray(28 + jsonLength).toString('base64');
  source.buffers[0].uri = uri;
  const frame = await openWritableFixture(
    page,
    'bracket.gltf',
    Buffer.from(JSON.stringify(source)),
  );
  await expect(frame.locator(readyModel)).toBeVisible();
  const { artifactId, revision } = (await runSiteTool(frame, 'tesseract_read_view')) as {
    artifactId: string;
    revision: string;
  };
  expect(
    await runSiteTool(frame, 'tesseract_edit_model', {
      artifactId,
      revision,
      action: { kind: 'set_color', objectId: 'object-0', color: '#ff0000' },
    }),
  ).toMatchObject({ message: /^Saved / });
  const host = page.locator('html');
  await expect(host).toHaveAttribute('data-saved-file', /\S/);
  const output = JSON.parse(
    Buffer.from((await host.getAttribute('data-saved-file'))!, 'base64').toString(),
  );
  expect(output.buffers).toEqual(source.buffers);
  expect(output.bufferViews).toEqual(source.bufferViews);
  expect(output.materials).toContainEqual(
    expect.objectContaining({
      pbrMetallicRoughness: expect.objectContaining({ baseColorFactor: [1, 0, 0, 1] }),
    }),
  );
});

test('an agent saves the selected STEP face color without replacing the CAD geometry', async ({
  page,
}) => {
  await mockSiteTools(page);
  const original = await readFile(resolve(temp, 'part.step'));
  const frame = await openWritableFixture(page, 'part.step', original);
  await expect(frame.locator(readyModel)).toBeVisible();
  const host = page.locator('html');
  const parserReads = await host.getAttribute('data-parser-reads');
  expect(Number(parserReads)).toBeGreaterThan(0);
  const { canvas } = await pickVisiblePart(frame, true);
  await expect(canvas).toHaveAttribute('data-selected-part', /\/surface\//);
  const [, objectId, face] = /^(object-\d+)\/surface\/(\d+)$/.exec(
    (await canvas.getAttribute('data-selected-part'))!,
  )!;
  const { artifactId, revision } = (await runSiteTool(frame, 'tesseract_read_view')) as {
    artifactId: string;
    revision: string;
  };
  expect(
    await runSiteTool(frame, 'tesseract_edit_model', {
      artifactId,
      revision,
      action: { kind: 'set_face_color', objectId, faceIndex: Number(face), color: '#ff0000' },
    }),
  ).toMatchObject({ message: `Saved face ${Number(face) + 1} color.` });
  await expect(host).toHaveAttribute('data-saved-file', /\S/);
  const output = Buffer.from((await host.getAttribute('data-saved-file'))!, 'base64').toString();
  expect(/COLOUR_RGB\('',1\.0+,0\.0+,0\.0+\)/.test(output)).toBe(true);
  expect(output.match(/^#\d+\s*=\s*ADVANCED_FACE[^;]+;/gm)).toEqual(
    original.toString().match(/^#\d+\s*=\s*ADVANCED_FACE[^;]+;/gm),
  );
  await expect
    .poll(
      async () =>
        (
          (await runSiteTool(frame, 'tesseract_read_view')) as {
            revision: string;
          }
        ).revision,
    )
    .not.toBe(revision);
  await expect(frame.locator(readyModel)).toBeVisible();
  await expect(host).toHaveAttribute('data-parser-reads', parserReads!);
});

test('rotating a writable STL visually saves vertices and leaves the facet data intact', async ({
  page,
}) => {
  const original = await readFile(resolve('samples/bracket.stl'));
  const frame = await openWritableFixture(page, 'bracket.stl', original);
  await expect(frame.locator(readyModel)).toBeVisible();
  await frame.getByRole('button', { name: 'Edit model' }).click();
  await frame.getByRole('button', { name: 'Rotate 90°' }).click();
  const host = page.locator('html');
  await expect(host).toHaveAttribute('data-saved-file', /\S/);
  const output = Buffer.from((await host.getAttribute('data-saved-file'))!, 'base64');
  expect(output.length).toBe(original.length);
  expect(output.subarray(0, 84)).toEqual(original.subarray(0, 84));
  expect(output.readFloatLE(96)).toBe(original.readFloatLE(104));
  expect(output.readFloatLE(100)).toBe(original.readFloatLE(100));
  expect(output.readFloatLE(104)).toBe(-original.readFloatLE(96));
  expect(output.subarray(132, 134)).toEqual(original.subarray(132, 134));
  await expect(frame.locator(readyModel)).toBeVisible();
});

test('a native Radiance exposure edit previews and writes the same HDR file', async ({ page }) => {
  const source = await readFile(resolve('test/fixtures/raster/sample.hdr'));
  const frame = await openWritableFixture(page, 'sample.hdr', source);
  const canvas = frame.getByRole('button', { name: 'Composite preview' });
  await expect(canvas).toBeVisible();
  const readPixel = () =>
    canvas.evaluate((node: HTMLCanvasElement) =>
      Array.from(node.getContext('2d')!.getImageData(0, 0, 1, 1).data),
    );
  const original = await readPixel();
  await frame.getByRole('button', { name: 'Darken', exact: true }).click();
  await expect.poll(readPixel).not.toEqual(original);
  const preview = await readPixel();
  await frame.getByRole('button', { name: 'Save changes' }).click();
  const host = page.locator('html');
  await expect(host).toHaveAttribute('data-saved-file', /\S/);
  const edited = Buffer.from((await host.getAttribute('data-saved-file'))!, 'base64');
  expect(edited.length).toBe(source.length);
  expect(edited[48]).toBe(source[48] - 1);
  await expect(frame.getByRole('button', { name: 'Darken', exact: true })).toBeVisible();
  await expect.poll(readPixel).toEqual(preview);
});

test('a native FLAC trim reopens audio with a shorter duration', async ({ page }) => {
  const source = await readFile(resolve('test/fixtures/media/sample.flac'));
  const frame = await openWritableFixture(page, 'sample.flac', source);
  const audio = frame.locator('audio');
  const getDuration = () => audio.evaluate((element: HTMLAudioElement) => element.duration);
  await frame.getByRole('button', { name: 'Trim', exact: true }).click();
  const duration = await getDuration();
  const end = frame.getByRole('slider', { name: 'End time' });
  await end.fill(String(duration * 0.65));
  await frame.getByRole('button', { name: 'Save trim', exact: true }).click();
  const host = page.locator('html');
  await expect(host).toHaveAttribute('data-saved-file', /\S/);
  const edited = Buffer.from((await host.getAttribute('data-saved-file'))!, 'base64');
  expect(edited.subarray(0, 4).toString()).toBe('fLaC');
  await expect(frame.getByRole('button', { name: 'Trim', exact: true })).toBeVisible();
  await expect.poll(getDuration).toBeLessThan(duration);
});
