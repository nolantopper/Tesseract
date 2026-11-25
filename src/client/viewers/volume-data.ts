import { Gunzip, gzipSync } from 'fflate';
import * as nifti from 'nifti-reader-js';
import dicomParser from 'dicom-parser';
import {
  checkedPixels,
  grayscale,
  nrrdDataFile,
  nrrdHeader,
  rasterInputLimit,
  type RasterSource,
} from './raster';

type Scalar = keyof typeof scalarReaders;
const scalarReaders = {
  u8: [1, 'getUint8'],
  i8: [1, 'getInt8'],
  u16: [2, 'getUint16'],
  i16: [2, 'getInt16'],
  u32: [4, 'getUint32'],
  i32: [4, 'getInt32'],
  f32: [4, 'getFloat32'],
  f64: [8, 'getFloat64'],
} as const;

function boundedGunzip(bytes: Uint8Array) {
  let length = 0;
  const chunks: Uint8Array[] = [];
  const gunzip = new Gunzip((chunk) => {
    length += chunk.length;
    if (length > rasterInputLimit) throw new Error('Expanded image exceeds 64 MiB.');
    chunks.push(chunk);
  });
  // Limit how much a synchronous inflate call can allocate before checking its output.
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    gunzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function scalarReader(bytes: Uint8Array, count: number, type: Scalar, littleEndian: boolean) {
  const [size, read] = scalarReaders[type];
  if (count * size > bytes.length) throw new Error('Image data ended before all voxels were read.');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (index: number) => data[read](index * size, littleEndian);
}

function volumeShape(dims: number[]) {
  if (dims.length < 2 || dims.length > 3 || dims.some((n) => !Number.isInteger(n) || n <= 0))
    throw new Error('Preview supports scalar image volumes with two or three dimensions.');
  const shape = [dims[0]!, dims[1]!, dims[2] ?? 1] as const;
  if (shape[0] * shape[1] * shape[2] > rasterInputLimit)
    throw new Error('Volume exceeds the voxel limit.');
  return shape;
}

function volume(
  [x, y, z]: ReturnType<typeof volumeShape>,
  spacing: number[],
  value: (index: number) => number,
  format: string,
  defaultWindow?: [number, number],
): RasterSource {
  const axes = [
    {
      label: 'XY',
      width: x,
      height: y,
      count: z,
      row: x,
      column: 1,
      slice: x * y,
      spacing: [0, 1],
    },
    {
      label: 'XZ',
      width: x,
      height: z,
      count: y,
      row: x * y,
      column: 1,
      slice: x,
      spacing: [0, 2],
    },
    {
      label: 'YZ',
      width: y,
      height: z,
      count: x,
      row: x * y,
      column: x,
      slice: 1,
      spacing: [1, 2],
    },
  ];
  if (z === 1) axes.splice(1);
  return {
    groups: axes.map(({ label, count }) => ({
      label,
      count,
      unit: 'Slice',
      defaultIndex: Math.floor(count / 2),
    })),
    render({ group, index, window }) {
      const plane = axes[group]!;
      const { width, height } = plane;
      const sx = spacing[plane.spacing[0]!] ?? 1;
      const sy = spacing[plane.spacing[1]!] ?? 1;
      const aspect = sx > 0 && sy > 0 ? (width * sx) / (height * sy) : width / height;
      return grayscale(
        width,
        height,
        (i) =>
          value(
            index * plane.slice + (i % width) * plane.column + Math.floor(i / width) * plane.row,
          ),
        {
          aspect,
          window: window ?? defaultWindow,
          details: `${format} voxel plane ${plane.label}, slice ${index + 1} of ${plane.count}. ${width} × ${height} voxels.`,
        },
      );
    },
  };
}

export function openNifti(data: ArrayBuffer): RasterSource {
  if (nifti.isCompressed(data)) data = boundedGunzip(new Uint8Array(data)).buffer;
  const header = nifti.readHeader(data);
  const rank = header.dims[0]!;
  if (rank < 2 || rank > 7 || header.dims.slice(4, rank + 1).some((n) => n !== 1))
    throw new Error('NIfTI time series and vector volumes are outside this preview.');
  const shape = volumeShape(header.dims.slice(1, Math.min(rank, 3) + 1));
  const types: Record<number, Scalar> = {
    2: 'u8',
    4: 'i16',
    8: 'i32',
    16: 'f32',
    64: 'f64',
    256: 'i8',
    512: 'u16',
    768: 'u32',
  };
  const type = types[header.datatypeCode];
  if (!type) throw new Error('Unsupported NIfTI voxel type.');
  const offset = header.vox_offset;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 352 ||
    offset >= data.byteLength ||
    header.numBitsPerVoxel !== scalarReaders[type][0] * 8
  )
    throw new Error('Invalid NIfTI voxel layout.');
  const value = scalarReader(
    new Uint8Array(data, offset),
    shape[0] * shape[1] * shape[2],
    type,
    header.littleEndian,
  );
  const scaled = Number.isFinite(header.scl_slope) && header.scl_slope !== 0;
  return volume(
    shape,
    header.pixDims.slice(1, 4).map(Math.abs),
    scaled
      ? (index) =>
          value(index) * header.scl_slope +
          (Number.isFinite(header.scl_inter) ? header.scl_inter : 0)
      : value,
    'NIfTI',
    Number.isFinite(header.cal_min) &&
      Number.isFinite(header.cal_max) &&
      header.cal_max > header.cal_min
      ? [header.cal_min, header.cal_max]
      : undefined,
  );
}

const nrrdTypes = new Map<string, Scalar>(
  (
    Object.entries({
      u8: 'unsigned char|uchar|uint8|uint8_t',
      i8: 'signed char|int8|int8_t',
      i16: 'short|short int|signed short|signed short int|int16|int16_t',
      u16: 'unsigned short|unsigned short int|ushort|uint16|uint16_t',
      i32: 'int|signed int|int32|int32_t',
      u32: 'unsigned int|uint|uint32|uint32_t',
      f32: 'float',
      f64: 'double',
    }) as [Scalar, string][]
  ).flatMap(([type, names]) => names.split('|').map((name) => [name, type])),
);

export function openNrrd(data: ArrayBuffer, detached?: ArrayBuffer) {
  const input = new Uint8Array(data);
  const { fields, headerSize } = nrrdHeader(input);
  const sizes = fields.get('sizes')?.split(/\s+/).map(Number) ?? [];
  if (
    (fields.has('byte skip') && fields.get('byte skip') !== '0') ||
    (fields.has('line skip') && fields.get('line skip') !== '0') ||
    Number(fields.get('dimension')) !== sizes.length
  )
    throw new Error('Unsupported NRRD data layout.');
  const shape = volumeShape(sizes);
  const count = shape[0] * shape[1] * shape[2];
  const type = nrrdTypes.get(fields.get('type') ?? '');
  if (!type) throw new Error('Unsupported NRRD voxel type.');
  const path = nrrdDataFile(input);
  if (path && !detached)
    throw new Error('Open the containing folder or archive for detached NRRD data.');
  const encoding = (fields.get('encoding') ?? 'raw').toLowerCase();
  let bytes = detached ? new Uint8Array(detached) : input.subarray(headerSize);
  const endian = fields.get('endian');
  if (endian && endian !== 'little' && endian !== 'big')
    throw new Error('Invalid NRRD endianness.');
  let value: (index: number) => number;
  if (['txt', 'text', 'ascii'].includes(encoding)) {
    const values = new Float64Array(count);
    if (values.byteLength > rasterInputLimit)
      throw new Error('Text volume exceeds the preview limit.');
    let index = 0;
    for (const item of new TextDecoder().decode(bytes).matchAll(/\S+/g)) {
      if (index >= count) throw new Error('Too many NRRD voxel values.');
      values[index++] = Number(item[0]);
    }
    if (index !== count) throw new Error('NRRD data ended before all voxels were read.');
    value = (index) => values[index]!;
  } else {
    if (encoding === 'gzip' || encoding === 'gz') bytes = boundedGunzip(bytes);
    else if (encoding !== 'raw') throw new Error('Unsupported NRRD encoding.');
    value = scalarReader(bytes, count, type, endian !== 'big');
  }
  const directions = [...(fields.get('space directions') ?? '').matchAll(/\(([^)]+)\)|none/gi)].map(
    (match) => (match[1] ? Math.hypot(...match[1].split(',').map(Number)) : 1),
  );
  const spacing = directions.length
    ? directions
    : (fields.get('spacings')?.split(/\s+/).map(Number) ?? []);
  const window = /^tesseract_window:=([^\r\n]+)$/m
    .exec(new TextDecoder().decode(input.subarray(0, headerSize)))?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number);
  return volume(
    shape,
    spacing,
    value,
    'NRRD',
    window?.length === 2 && window.every(Number.isFinite) && window[1] > window[0]
      ? [window[0], window[1]]
      : undefined,
  );
}

function parseNativeDicom(bytes: Uint8Array) {
  const dicom = dicomParser.parseDicom(bytes, {
    inflater() {
      throw new Error('Deflated DICOM datasets are outside this preview.');
    },
  });
  const transfer = dicom.string('x00020010')?.trim();
  if (
    !transfer ||
    !['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'].includes(transfer)
  )
    throw new Error(
      'This DICOM transfer syntax requires a decoder beyond the native pixel preview.',
    );
  return { dicom, littleEndian: transfer !== '1.2.840.10008.1.2.2' };
}

const hasDicomPresentation = (dicom: ReturnType<typeof parseNativeDicom>['dicom']) =>
  Boolean(
    dicom.elements.x20500010 ||
    dicom.elements.x20500020 ||
    dicom.elements.x4ffe0001 ||
    dicom.elements.xfffafffa,
  );

export function openDicom(data: ArrayBuffer): RasterSource {
  const bytes = new Uint8Array(data);
  const { dicom, littleEndian } = parseNativeDicom(bytes);
  const width = dicom.uint16('x00280011') ?? 0;
  const height = dicom.uint16('x00280010') ?? 0;
  const count = checkedPixels(width, height);
  const frames = dicom.intString('x00280008') ?? 1;
  const bits = dicom.uint16('x00280100');
  const stored = dicom.uint16('x00280101') ?? bits;
  const highBit = dicom.uint16('x00280102') ?? (stored ?? 0) - 1;
  const signed = dicom.uint16('x00280103') === 1;
  const samples = dicom.uint16('x00280002');
  const photometric = dicom.string('x00280004')?.trim();
  const mono = samples === 1 && (photometric === 'MONOCHROME1' || photometric === 'MONOCHROME2');
  const canInvert = mono && !hasDicomPresentation(dicom);
  const rgb = samples === 3 && photometric === 'RGB' && bits === 8 && stored === 8 && !signed;
  const element = dicom.elements.x7fe00010;
  if (
    !element ||
    element.hadUndefinedLength ||
    (!mono && !rgb) ||
    !Number.isInteger(frames) ||
    frames < 1 ||
    (bits !== 8 && bits !== 16) ||
    !stored ||
    stored > bits ||
    highBit < stored - 1 ||
    highBit >= bits
  )
    throw new Error('Unsupported DICOM pixel layout.');
  const frameBytes = count * samples! * (bits / 8);
  if (
    frames * frameBytes > element.length ||
    element.dataOffset + frames * frameBytes > bytes.length
  )
    throw new Error('DICOM pixel data ended before all frames were read.');
  const pixels = new DataView(data, element.dataOffset, frames * frameBytes);
  const planar = rgb && dicom.uint16('x00280006') === 1;
  const slope = dicom.floatString('x00281053') ?? 1;
  const intercept = dicom.floatString('x00281052') ?? 0;
  const center = dicom.floatString('x00281050');
  const windowWidth = dicom.floatString('x00281051');
  const window: [number, number] | undefined =
    Number.isFinite(center) && windowWidth && windowWidth > 0
      ? [center! - windowWidth / 2, center! + windowWidth / 2]
      : undefined;
  const details = (index: number) =>
    `DICOM frame ${index + 1} of ${frames}. ${width} × ${height} pixels. ${mono ? 'Grayscale' : 'RGB'}.`;
  return {
    groups: [{ label: 'Frames', count: frames, unit: 'Frame' }],
    render({ index }) {
      const base = index * frameBytes;
      if (mono) {
        const sign = 2 ** (stored - 1);
        const mask = sign * 2 - 1;
        const shift = highBit - stored + 1;
        const gray = grayscale(
          width,
          height,
          (pixel) => {
            const raw =
              bits === 8
                ? pixels.getUint8(base + pixel)
                : pixels.getUint16(base + 2 * pixel, littleEndian);
            const sample = (raw >> shift) & mask;
            return (signed && sample >= sign ? sample - sign * 2 : sample) * slope + intercept;
          },
          { window, invert: photometric === 'MONOCHROME1', details: details(index) },
        );
        return { ...gray, canInvert };
      }
      const rgba = new Uint8ClampedArray(count * 4);
      for (let i = 0; i < count; i++) {
        for (let channel = 0; channel < 3; channel++) {
          rgba[i * 4 + channel] = pixels.getUint8(
            base + (planar ? channel * count + i : i * 3 + channel),
          );
        }
        rgba[i * 4 + 3] = 255;
      }
      return { width, height, data: rgba, details: details(index) };
    },
  };
}

export function invertDicom(data: ArrayBuffer) {
  const bytes = new Uint8Array(data.slice(0));
  const { dicom } = parseNativeDicom(bytes);
  const photometric = dicom.string('x00280004')?.trim();
  const tag = dicom.elements.x00280004;
  if (
    dicom.uint16('x00280002') !== 1 ||
    (photometric !== 'MONOCHROME1' && photometric !== 'MONOCHROME2') ||
    !tag ||
    tag.length < 11 ||
    tag.dataOffset + tag.length > bytes.length ||
    hasDicomPresentation(dicom)
  )
    throw new Error('This DICOM display cannot be inverted.');
  bytes[tag.dataOffset + 10] = photometric === 'MONOCHROME1' ? 50 : 49;
  return bytes;
}

export function saveVolumeWindow(data: ArrayBuffer, format: string, window: [number, number]) {
  const [min, max] = window;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)
    throw new Error('Choose a valid intensity range.');
  if (format === 'nifti') {
    const compressed = nifti.isCompressed(data);
    const bytes = compressed ? boundedGunzip(new Uint8Array(data)) : new Uint8Array(data.slice(0));
    const header = nifti.readHeader(bytes.buffer);
    const view = new DataView(bytes.buffer);
    const size = view.getInt32(0, header.littleEndian);
    if (size === 348) {
      if (
        !Number.isFinite(Math.fround(min)) ||
        !Number.isFinite(Math.fround(max)) ||
        Math.fround(min) === Math.fround(max)
      )
        throw new Error('This intensity range exceeds NIfTI-1 precision.');
      view.setFloat32(124, max, header.littleEndian);
      view.setFloat32(128, min, header.littleEndian);
    } else if (size === 540) {
      view.setFloat64(192, max, header.littleEndian);
      view.setFloat64(200, min, header.littleEndian);
    } else throw new Error('Unsupported NIfTI calibration header.');
    return compressed ? gzipSync(bytes) : bytes;
  }
  if (format !== 'nrrd') throw new Error('This file has no volume intensity range.');
  const input = new Uint8Array(data);
  const { headerSize } = nrrdHeader(input);
  const header = new TextDecoder('utf-8', { fatal: true }).decode(input.subarray(0, headerSize));
  const marker = /\r?\n\r?\n$/.exec(header);
  const newline = header.includes('\r\n') ? '\r\n' : '\n';
  const cleaned = (marker ? header.slice(0, -marker[0].length) : header.trimEnd())
    .replace(/^tesseract_window:=[^\r\n]*\r?\n?/gm, '')
    .trimEnd();
  const metadata = new TextEncoder().encode(
    `${cleaned}${newline}tesseract_window:=${min} ${max}${newline}${marker ? newline : ''}`,
  );
  const result = new Uint8Array(metadata.length + input.length - headerSize);
  result.set(metadata);
  result.set(input.subarray(headerSize), metadata.length);
  return result;
}
