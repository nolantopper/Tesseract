import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { openHdr, openTiff } from '../src/client/viewers/raster-images.js';
import { nrrdDataFile } from '../src/client/viewers/raster.js';
import { openDicom, openNifti, openNrrd } from '../src/client/viewers/volume-data.js';

async function fixture(name: string) {
  return Uint8Array.from(await readFile(new URL(`./fixtures/raster/${name}`, import.meta.url)))
    .buffer;
}

test('GeoTIFF decodes color and a selected band with projection and bounds', async () => {
  const source = await openTiff(await fixture('bands.tif'));
  assert.deepEqual(source.groups[0]?.labels, ['Composite', 'Band 1', 'Band 2', 'Band 3']);
  const rgb = await source.render({ group: 0, index: 0 });
  assert.deepEqual([...rgb.data.slice(0, 4)], [255, 0, 0, 255]);
  assert.match(rgb.details ?? '', /EPSG:4326.*Bounds:/);
  const band = await source.render({ group: 0, index: 1 });
  assert.deepEqual([...band.data.slice(0, 4)], [255, 255, 255, 255]);
});

test('NIfTI and NRRD expose equivalent voxel planes and physical aspect', async () => {
  const header = await fixture('detached.nhdr');
  assert.equal(nrrdDataFile(new Uint8Array(header)), 'voxels.raw');
  assert.throws(() => openNrrd(header), /containing folder/);
  const sources = [
    openNifti(await fixture('slices.nii')),
    openNifti(await fixture('slices.nii.gz')),
    openNrrd(await fixture('slices.nrrd')),
    openNrrd(header, await fixture('voxels.raw')),
  ];
  for (const source of sources) {
    assert.deepEqual(
      source.groups.map((axis) => [axis.label, axis.count]),
      [
        ['XY', 2],
        ['XZ', 3],
        ['YZ', 4],
      ],
    );
    const xz = await source.render({ group: 1, index: 0 });
    assert.equal(xz.width, 4);
    assert.equal(xz.height, 2);
    assert.deepEqual([...xz.data.slice(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...xz.data.slice(16, 20)], [255, 255, 255, 255]);
  }
  const xy = await sources[0]!.render({ group: 0, index: 1 });
  assert.equal(xy.aspect, 4 / 6);
});

test('DICOM renders distinct frames and keeps patient metadata out of frame context', async () => {
  const source = openDicom(await fixture('frames.dcm'));
  const first = await source.render({ group: 0, index: 0 });
  const second = await source.render({ group: 0, index: 1 });
  assert.notDeepEqual(first.data, second.data);
  assert.equal(second.details, 'DICOM frame 2 of 2. 4 × 3 pixels. Grayscale.');
});

for (const format of ['exr', 'hdr']) {
  test(`${format.toUpperCase()} maps stored colors to display and renders a selected channel`, async () => {
    const source = openHdr(await fixture(`sample.${format}`), format === 'exr');
    const rgb = await source.render({ group: 0, index: 0 });
    const red = await source.render({ group: 0, index: 1 });
    assert.notDeepEqual(rgb.data, red.data);
    assert.equal(red.data[0], red.data[1]);
    assert.equal(red.data[1], red.data[2]);
    assert.match(red.details ?? '', /Red/);
  });
}
