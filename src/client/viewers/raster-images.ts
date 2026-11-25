import { fromArrayBuffer } from 'geotiff';
import { initializeCanvas, readPsd, type Layer } from 'ag-psd';
import { FloatType } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { checkedPixels, grayscale, type RasterFrame, type RasterSource } from './raster';
import { readExrHeader, readHdrHeader } from './exposure-edit';
import { canDarkenPsd } from './psd-edits';

export async function openTiff(bytes: ArrayBuffer): Promise<RasterSource> {
  const header = new DataView(bytes);
  const classic = header.getUint16(2, header.getUint16(0) === 0x4949) === 42;
  const tiff = await fromArrayBuffer(bytes);
  const pages: Awaited<ReturnType<typeof tiff.getImage>>[] = [];
  const offsets = new Set<number>();
  for (let index = 0; index < 64; index++) {
    const page = await tiff.getImage(index);
    pages.push(page);
    const next = page.getFileDirectory().nextIFDByteOffset;
    if (next === 0) break;
    if (offsets.has(next)) throw new Error('TIFF page directories form a loop.');
    offsets.add(next);
    if (index === 63) throw new Error('TIFF exceeds the 64-page preview limit.');
  }
  return {
    groups: pages.map((page, index) => {
      const channels = Math.min(16, Math.max(1, page.getSamplesPerPixel()));
      return {
        label: `Page ${index + 1}`,
        count: channels === 1 ? 1 : channels + 1,
        unit: 'Channel',
        labels: ['Composite', ...Array.from({ length: channels }, (_, band) => `Band ${band + 1}`)],
      };
    }),
    async render({ group, index }) {
      const page = pages[group]!;
      const width = page.getWidth();
      const height = page.getHeight();
      const count = checkedPixels(width, height);
      const samples = page.getSamplesPerPixel();
      if (
        !Number.isInteger(samples) ||
        samples < 1 ||
        samples > 16 ||
        count * samples * Math.ceil(page.getBitsPerSample(0) / 8) > 64 * 1024 * 1024 ||
        page.getTileWidth() * Math.min(page.getTileHeight(), height) * samples * 8 >
          64 * 1024 * 1024
      )
        throw new Error('TIFF raster exceeds the preview limit.');
      const directory = page.getFileDirectory();
      const photometric = directory.getValue('PhotometricInterpretation') ?? 1;
      const geo = page.getGeoKeys();
      const orientation = (await directory.loadValue('Orientation')) ?? 1;
      const presentation = { orientation, canRotate: classic && !geo };
      const epsg = geo?.ProjectedCSTypeGeoKey ?? geo?.GeographicTypeGeoKey;
      const projection =
        typeof epsg === 'number' && epsg > 0 && epsg < 32767 ? ` EPSG:${epsg}.` : '';
      let bounds = '';
      if (geo) {
        try {
          const bbox = page.getBoundingBox();
          if (bbox.length === 4 && bbox.every(Number.isFinite))
            bounds = ` Bounds: ${bbox.map((value) => Number(value.toPrecision(8))).join(', ')}.`;
        } catch {
          // A GeoKey directory may exist without a spatial transform.
        }
      }
      const details = `${geo ? 'GeoTIFF' : 'TIFF'} page ${group + 1} of ${pages.length}, ${index ? `band ${index}` : 'composite'}. ${width} × ${height} pixels.${projection}${bounds}`;
      if (index || photometric < 2 || (photometric !== 3 && samples < 3)) {
        const raster = await page.readRasters({
          samples: [Math.max(0, index - 1)],
          interleave: true,
        });
        const nodata = page.getGDALNoData();
        const bits = page.getBitsPerSample(Math.max(0, index - 1));
        const window: [number, number] | undefined =
          photometric < 2 && bits === 8 && page.getSampleFormat() === 1 ? [0, 255] : undefined;
        const band = grayscale(width, height, (i) => (raster[i] === nodata ? NaN : raster[i]!), {
          window,
          details,
          invert: !index && photometric === 0,
        });
        return { ...band, ...presentation };
      }
      const pixels = await page.readRGB({ interleave: true, enableAlpha: samples === 4 });
      const stride = pixels.length / count;
      if (stride !== 3 && stride !== 4) throw new Error('Unsupported TIFF color layout.');
      const scales = Array.from({ length: stride }, (_, channel) =>
        photometric === 2
          ? page.getSampleFormat(channel) === 3
            ? 255
            : 255 / (2 ** page.getBitsPerSample(channel) - 1)
          : 1,
      );
      const data = new Uint8ClampedArray(count * 4);
      for (let i = 0; i < count; i++) {
        for (let channel = 0; channel < 3; channel++)
          data[i * 4 + channel] = pixels[i * stride + channel]! * scales[channel]!;
        data[i * 4 + 3] = stride === 4 ? pixels[i * stride + 3]! * scales[3]! : 255;
      }
      return { width, height, data, details, ...presentation };
    },
  };
}

export function openPsd(bytes: ArrayBuffer): RasterSource {
  const header = new DataView(bytes);
  if (bytes.byteLength < 26 || header.getUint32(0) !== 0x38425053)
    throw new Error('Invalid Photoshop document.');
  checkedPixels(header.getUint32(18), header.getUint32(14));
  const canDarken = canDarkenPsd(bytes);
  initializeCanvas(
    (width, height) => new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
    (width, height) => new ImageData(width, height),
  );
  const psd = readPsd(bytes, {
    useImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    imageResourcesWhitelist: [],
    totalMemoryLimit: 96 * 1024 * 1024,
  });
  const layers: { label: string; layer: Layer }[] = [];
  function walk(children: Layer[] | undefined, prefix: string, depth: number) {
    if (!children || depth > 32) return;
    for (const layer of children) {
      if (layers.length >= 200) return;
      const label = `${prefix}${layer.name || `Layer ${layers.length + 1}`}`.slice(-200);
      if (layer.imageData) layers.push({ label, layer });
      walk(layer.children, `${label} / `, depth + 1);
    }
  }
  walk(psd.children, '', 0);
  return {
    groups: [
      {
        label: 'Layers',
        count: layers.length + 1,
        unit: 'Layer',
        labels: ['Composite', ...layers.map(({ label }) => label)],
      },
    ],
    render({ index, darken }) {
      const layer = layers[index - 1]?.layer;
      const source = index ? layer?.imageData : psd.imageData;
      if (!source) throw new Error('This Photoshop view has no stored bitmap.');
      const { width, height } = source;
      const count = checkedPixels(width, height);
      if (source.data.length !== count * 4) throw new Error('Invalid Photoshop pixel layout.');
      const data = new Uint8ClampedArray(count * 4);
      const scale =
        source.data instanceof Uint16Array
          ? 255 / 65535
          : source.data instanceof Float32Array
            ? 255
            : 1;
      for (let i = 0; i < data.length; i++) {
        const value = source.data[i]! * scale;
        data[i] = darken && canDarken && i % 4 !== 3 ? Math.floor(value / 2) : value;
      }
      const position = layer ? ` Layer bounds start at ${layer.left ?? 0}, ${layer.top ?? 0}.` : '';
      return {
        width,
        height,
        data,
        canDarken,
        details: `Photoshop ${index ? 'layer bitmap' : 'stored composite'}. ${width} × ${height} pixels.${position}`,
      };
    },
  };
}

export function openHdr(data: ArrayBuffer, exr: boolean): RasterSource {
  const { canDarken } = exr ? readExrHeader(data) : readHdrHeader(data);
  const decoded = exr
    ? new EXRLoader().setDataType(FloatType).parse(data)
    : new HDRLoader().setDataType(FloatType).parse(data);
  const { width, height, data: values } = decoded;
  const count = checkedPixels(width, height);
  if (!(values instanceof Float32Array) || values.length !== count * 4)
    throw new Error('Unsupported HDR pixel layout.');
  const labels = ['Composite', 'Red', 'Green', 'Blue', ...(exr ? ['Alpha'] : [])];
  return {
    groups: [{ label: 'Channels', count: labels.length, unit: 'Channel', labels }],
    render({ index, darken }) {
      const data = new Uint8ClampedArray(count * 4);
      const toDisplay = (value: number) => {
        const linear = Math.max(0, value);
        return 255 * (linear / (1 + linear)) ** (1 / 2.2);
      };
      for (let i = 0; i < count; i++) {
        const start = (exr ? (height - 1 - Math.floor(i / width)) * width + (i % width) : i) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const value = values[start + (index ? index - 1 : channel)]!;
          data[i * 4 + channel] =
            index === 4 ? value * 255 : toDisplay(darken ? value * 0.5 : value);
        }
        data[i * 4 + 3] = exr && !index ? values[start + 3]! * 255 : 255;
      }
      return {
        canDarken: canDarken && index !== 4,
        width,
        height,
        data,
        details: `${exr ? 'OpenEXR' : 'Radiance HDR'} ${labels[index]}. ${width} × ${height} pixels. ${index === 4 ? 'Linear alpha.' : 'Tone-mapped preview.'}`,
      } satisfies RasterFrame;
    },
  };
}
