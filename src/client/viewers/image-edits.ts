import { rotateJpeg, rotatePng } from './image-orientation';
import { checkedPixels } from './raster';

export function canRotateImage(format: string) {
  return ['jpg', 'jpeg', 'png', 'webp'].includes(format);
}

export function rotateImage(data: ArrayBuffer, format: string) {
  const bytes = new Uint8Array(data);
  if (format === 'png') return rotatePng(bytes, 1);
  if (format === 'jpg' || format === 'jpeg') return rotateJpeg(bytes, 1);
  throw new Error('This image format cannot be rotated.');
}

function webpColorProfile(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  const text = new TextDecoder();
  const tag = (offset: number) => text.decode(bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length)
    throw new Error('Invalid WebP.');
  let profile: Uint8Array | undefined;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('Truncated WebP.');
    const length = view.getUint32(offset + 4, true);
    const kind = tag(offset);
    if (kind === 'ICCP' && !profile) profile = bytes.subarray(offset + 8, offset + 8 + length);
    else if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH'].includes(kind))
      throw new Error('Only static WebP without EXIF or XMP metadata can be rotated.');
    offset += 8 + length + (length % 2);
    if (offset > bytes.length) throw new Error('Truncated WebP.');
  }
  return profile;
}

export async function rotateWebp(data: ArrayBuffer) {
  const profile = webpColorProfile(data);
  const bitmap = await createImageBitmap(new Blob([data], { type: 'image/webp' }));
  try {
    checkedPixels(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.height, bitmap.width);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('WebP editing requires a canvas.');
    context.translate(bitmap.height, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(bitmap, 0, 0);
    const encoded = await canvas.convertToBlob({ type: 'image/webp', quality: 1 });
    if (encoded.type !== 'image/webp') throw new Error('This host cannot encode WebP.');
    const output = await encoded.arrayBuffer();
    if (profile) {
      const updated = webpColorProfile(output);
      if (
        updated?.length !== profile.length ||
        !profile.every((byte, index) => byte === updated[index])
      )
        throw new Error('This WebP color profile cannot be preserved.');
    }
    return new Uint8Array(output);
  } finally {
    bitmap.close();
  }
}

export function slowGif(data: ArrayBuffer) {
  const bytes = new Uint8Array(data.slice(0));
  const view = new DataView(bytes.buffer);
  const header = new TextDecoder().decode(bytes.subarray(0, 6));
  if (bytes.length < 13 || !['GIF87a', 'GIF89a'].includes(header)) throw new Error('Invalid GIF.');
  const colorTable = (flags: number) => (flags & 128 ? 3 << ((flags & 7) + 1) : 0);
  let offset = 13 + colorTable(bytes[10]);
  let frames = 0;
  let trailer = false;
  let updated = false;
  const skipBlocks = () => {
    for (;;) {
      if (offset >= bytes.length) throw new Error('Truncated GIF.');
      const length = bytes[offset++];
      if (!length) return;
      offset += length;
    }
  };
  while (offset < bytes.length) {
    const kind = bytes[offset++];
    if (kind === 0x3b) {
      trailer = true;
      break;
    }
    if (kind === 0x2c) {
      if (offset + 9 > bytes.length) throw new Error('Truncated GIF image.');
      offset += 9 + colorTable(bytes[offset + 8]);
      offset++; // LZW minimum code size.
      frames++;
    } else if (kind === 0x21) {
      if (bytes[offset++] === 0xf9) {
        if (bytes[offset] !== 4 || offset + 6 > bytes.length || bytes[offset + 5] !== 0)
          throw new Error('Invalid GIF frame delay.');
        const delay = view.getUint16(offset + 2, true);
        // Browsers typically treat a one-centisecond or unspecified delay as 100 ms.
        const next = Math.min(65_535, (delay < 2 ? 10 : delay) * 2);
        view.setUint16(offset + 2, next, true);
        updated ||= next !== delay;
      }
    } else throw new Error('Invalid GIF block.');
    skipBlocks();
  }
  if (!trailer || frames < 2) throw new Error('This GIF has no animation.');
  if (!updated) throw new Error('This GIF has no editable frame delays.');
  return bytes;
}

export function svgBackground(data: ArrayBuffer, color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Invalid background color.');
  const document = new DOMParser().parseFromString(
    new TextDecoder('utf-8', { fatal: true }).decode(data),
    'image/svg+xml',
  );
  const root = document.documentElement;
  if (
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    root.localName !== 'svg' ||
    document.doctype
  )
    throw new Error('This SVG cannot be edited safely.');
  // Keep the source document in image mode. Never insert SVG markup into the panel DOM.
  root.setAttribute('style', `${root.getAttribute('style') ?? ''};background-color:${color}`);
  return new TextEncoder().encode(new XMLSerializer().serializeToString(document));
}
