import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BufferSource, FLAC, Input, MP4 } from 'mediabunny';
import { gzipSync, gunzipSync } from 'fflate';
import { rotateImage, slowGif } from '../src/client/viewers/image-edits.js';
import { darkenImage } from '../src/client/viewers/exposure-edit.js';
import { rotateTiff } from '../src/client/viewers/image-orientation.js';
import { trimMedia } from '../src/client/viewers/media-edits.js';
import { canDarkenPsd, darkenPsd } from '../src/client/viewers/psd-edits.js';
import { openHdr, openTiff } from '../src/client/viewers/raster-images.js';
import { nrrdHeader } from '../src/client/viewers/raster.js';
import {
  invertDicom,
  openDicom,
  openNifti,
  openNrrd,
  saveVolumeWindow,
} from '../src/client/viewers/volume-data.js';

const fixture = async (path: string) =>
  Uint8Array.from(await readFile(new URL(path, import.meta.url))).buffer;

function pngChunks(bytes: Uint8Array) {
  const chunks = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const kind = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    chunks.set(kind, bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return chunks;
}

test('PNG rotates by editing EXIF without replacing its image chunks', async () => {
  const original = await fixture('../samples/image.png');
  const rotated = rotateImage(original, 'png');
  const before = pngChunks(new Uint8Array(original));
  const after = pngChunks(rotated);
  const tiff = after.get('eXIf')!;
  const ifd = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  assert.equal(ifd.getUint16(ifd.getUint32(4, true) + 10, true), 6);
  after.delete('eXIf');
  assert.deepEqual(after, before);
  assert.equal(rotateImage(rotated.buffer, 'png').length, rotated.length);
});

test('animated GIF slowing changes frame delays without re-encoding frames', () => {
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex');
  const first = Buffer.from('21f90400050000002c0000000001000100000202440100', 'hex');
  const second = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
  const original = Uint8Array.from(Buffer.concat([header, first, second, Uint8Array.of(59)]));
  const edited = slowGif(original.buffer);
  assert.equal(edited[header.length + 4], 10);
  assert.equal(edited[header.length + first.length + 4], 20);
  assert.deepEqual(
    Array.from(edited.keys()).filter((offset) => original[offset] !== edited[offset]),
    [header.length + 4, header.length + first.length + 4],
  );
});

test('TIFF rotation keeps raster samples and rejects spatial TIFF', async () => {
  const spatial = new Uint8Array(await fixture('./fixtures/raster/bands.tif'));
  assert.throws(() => rotateTiff(spatial), /Georeferenced/);

  // Strip georeference entries from the directory of a real fixture for the plain TIFF case.
  const original = spatial.slice();
  const view = new DataView(original.buffer);
  const little = view.getUint16(0) === 0x4949;
  const offset = view.getUint32(4, little);
  const count = view.getUint16(offset, little);
  let next = offset + 2;
  for (let entry = offset + 2; entry < offset + 2 + 12 * count; entry += 12) {
    if ([33550, 33922, 34264, 34735, 34736, 34737].includes(view.getUint16(entry, little)))
      continue;
    original.copyWithin(next, entry, entry + 12);
    next += 12;
  }
  view.setUint16(offset, (next - offset - 2) / 12, little);
  view.setUint32(next, 0, little);
  const edit = rotateTiff(original);
  const before = await (await openTiff(original.buffer)).render({ group: 0, index: 0 });
  const after = await (await openTiff(edit.buffer)).render({ group: 0, index: 0 });
  assert.equal(after.orientation, 6);
  assert.deepEqual(after.data, before.data);
});

test('NIfTI display range changes only the header calibration', async () => {
  const original = await fixture('./fixtures/raster/slices.nii');
  const changed = saveVolumeWindow(original, 'nifti', [2, 20]);
  const first = openNifti(original).render({ group: 0, index: 1 });
  const second = openNifti(changed.buffer).render({ group: 0, index: 1 });
  assert.deepEqual((await second).window, [2, 20]);
  assert.notDeepEqual((await first).data, (await second).data);
  assert.deepEqual(changed.subarray(132), new Uint8Array(original).subarray(132));
  const gzip = gzipSync(new Uint8Array(original));
  assert.deepEqual(gunzipSync(saveVolumeWindow(gzip.buffer, 'nifti', [2, 20])), changed);
});

test('NRRD intensity window reopens with unchanged attached or detached voxels', async () => {
  const raw = await fixture('./fixtures/raster/voxels.raw');
  for (const [name, detached] of [
    ['slices.nrrd', undefined],
    ['detached.nhdr', raw],
  ] as const) {
    const original = await fixture(`./fixtures/raster/${name}`);
    const edited = saveVolumeWindow(original, 'nrrd', [2, 20]);
    const start = nrrdHeader(new Uint8Array(original)).headerSize;
    const end = nrrdHeader(edited).headerSize;
    assert.deepEqual(edited.subarray(end), new Uint8Array(original).subarray(start));
    const image = await openNrrd(edited.buffer, detached).render({ group: 0, index: 1 });
    assert.deepEqual(image.window, [2, 20]);
  }
});

test('DICOM grayscale polarity changes one presentation byte and keeps all frames', async () => {
  const original = await fixture('./fixtures/raster/frames.dcm');
  const inverted = invertDicom(original);
  assert.equal(
    Array.from(new Uint8Array(original)).filter((byte, index) => byte !== inverted[index]).length,
    1,
  );
  const before = openDicom(original);
  const after = openDicom(inverted.buffer);
  for (let index = 0; index < 2; index++) {
    const first = await before.render({ group: 0, index });
    const second = await after.render({ group: 0, index });
    assert.deepEqual(
      first.data.map((byte, offset) => (offset % 4 === 3 ? byte : 255 - byte)),
      second.data,
    );
  }
});

for (const format of ['hdr', 'exr']) {
  test(`${format} exposure edit matches its preview and reopens in the same format`, async () => {
    const bytes = await fixture(`./fixtures/raster/sample.${format}`);
    const exr = format === 'exr';
    const image = openHdr(bytes, exr);
    const choice = { group: 0, index: 0 };
    const original = await image.render(choice);
    const preview = await image.render({ ...choice, darken: true });
    assert.equal(original.canDarken, true);
    const edited = darkenImage(bytes, exr);
    const updated = await openHdr(edited.buffer, exr).render(choice);
    assert.equal(edited.length, bytes.byteLength);
    assert.notDeepEqual(updated.data, original.data);
    assert.deepEqual(updated.data, preview.data);
  });
}

test('Photoshop darkening preserves layers, RLE headers, and ancillary bytes', async () => {
  const bytes = await fixture('./fixtures/raster/layers.psd');
  assert.equal(canDarkenPsd(bytes), true);
  const edited = darkenPsd(bytes);
  const original = new Uint8Array(bytes);
  assert.equal(edited.length, original.length);
  assert.deepEqual(edited.subarray(0, 180), original.subarray(0, 180));
  assert.equal(edited[187], original[187] >> 1);
  assert.equal(edited[237], original[237] >> 1);
  const psb = bytes.slice(0);
  new DataView(psb).setUint16(4, 2);
  assert.equal(canDarkenPsd(psb), false);
  assert.throws(() => darkenPsd(psb), /plain 8-bit RGB Photoshop/);
});

for (const [format, inputFormat, path] of [
  ['flac', FLAC, './fixtures/media/sample.flac'],
  ['mp4', MP4, '../samples/video.mp4'],
] as const) {
  test(`${format} trim reopens in original container with the same track codecs`, async () => {
    const bytes = await fixture(path);
    const input = new Input({ formats: [inputFormat], source: new BufferSource(bytes) });
    const duration = await input.computeDuration();
    const edited = await trimMedia(bytes, format, 0, duration * 0.8, new AbortController().signal);
    const output = new Input({ formats: [inputFormat], source: new BufferSource(edited) });
    try {
      assert.deepEqual(
        await Promise.all((await output.getTracks()).map((track) => track.getCodec())),
        await Promise.all((await input.getTracks()).map((track) => track.getCodec())),
      );
      const trimmed = await output.computeDuration();
      assert.ok(trimmed > 0 && trimmed < duration, `Duration went from ${duration} to ${trimmed}`);
    } finally {
      input.dispose();
      output.dispose();
    }
  });
}
