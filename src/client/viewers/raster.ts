export type RasterGroup = {
  label: string;
  count: number;
  unit: 'Page' | 'Layer' | 'Slice' | 'Frame' | 'Channel' | 'Image';
  labels?: string[];
  defaultIndex?: number;
};
export type RasterChoice = {
  group: number;
  index: number;
  window?: [number, number];
  darken?: boolean;
};
export type RasterFrame = {
  width: number;
  height: number;
  aspect?: number;
  orientation?: number;
  canRotate?: boolean;
  canInvert?: boolean;
  canDarken?: boolean;
  window?: [number, number];
  data: Uint8ClampedArray<ArrayBuffer>;
  details?: string;
};
export type RasterSource = {
  groups: RasterGroup[];
  render: (choice: RasterChoice) => RasterFrame | Promise<RasterFrame>;
};
export type RasterRequest =
  | { format: string; data: ArrayBuffer; detached?: ArrayBuffer }
  | { choice: RasterChoice; sequence: number };
export type RasterResponse =
  | { groups: RasterGroup[] }
  | { frame: RasterFrame; choice: RasterChoice; sequence: number }
  | { error: string; sequence?: number };

export function labelFor(group: RasterGroup, index: number) {
  return group.labels?.[index] ?? `${group.unit} ${index + 1}`;
}

export const rasterInputLimit = 64 * 1024 * 1024;
export function checkedPixels(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16_384 ||
    height > 16_384 ||
    width * height > 8_388_608
  )
    throw new Error('Image dimensions exceed the preview limit.');
  return width * height;
}

export function grayscale(
  width: number,
  height: number,
  value: (index: number) => number,
  options?: { window?: [number, number]; invert?: boolean; details?: string; aspect?: number },
): RasterFrame {
  const count = checkedPixels(width, height);
  let min = Infinity;
  let max = -Infinity;
  if (options?.window) [min, max] = options.window;
  else {
    for (let index = 0; index < count; index++) {
      const sample = value(index);
      if (!Number.isFinite(sample)) continue;
      min = Math.min(sample, min);
      max = Math.max(sample, max);
    }
  }
  const data = new Uint8ClampedArray(count * 4);
  for (let index = 0; index < count; index++) {
    const sample = value(index);
    const gray = Number.isFinite(sample)
      ? min < max
        ? Math.min(255, Math.max(0, ((sample - min) * 255) / (max - min)))
        : sample > 0
          ? 255
          : 0
      : 0;
    data.fill(options?.invert ? 255 - gray : gray, index * 4, index * 4 + 3);
    data[index * 4 + 3] = 255;
  }
  return {
    width,
    height,
    data,
    aspect: options?.aspect,
    details: options?.details,
    window: Number.isFinite(min) && Number.isFinite(max) ? [min, max] : undefined,
  };
}

export function nrrdHeader(bytes: Uint8Array) {
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, 65_536));
  const separator = /\r?\n\r?\n/.exec(prefix);
  if (!/^NRRD000[1-5]\r?\n/.test(prefix) || (!separator && bytes.length > prefix.length))
    throw new Error('Invalid or incomplete NRRD header.');
  const fields = new Map<string, string>();
  for (const line of prefix.slice(0, separator?.index).split(/\r?\n/).slice(1)) {
    const field = /^([^#:=][^:]*):\s*(?![=])(.*)$/.exec(line);
    if (field) fields.set(field[1]!.trim().toLowerCase(), field[2]!.trim());
  }
  if (!separator && !fields.get('data file') && !fields.get('datafile'))
    throw new Error('NRRD header has no data separator.');
  return { fields, headerSize: separator ? separator.index + separator[0].length : bytes.length };
}

export function nrrdDataFile(bytes: Uint8Array) {
  const { fields } = nrrdHeader(bytes);
  const path = fields.get('data file') ?? fields.get('datafile');
  if (path && (/^LIST\b/i.test(path) || path.includes('%')))
    throw new Error('Only a single detached NRRD data file is supported.');
  return path;
}
