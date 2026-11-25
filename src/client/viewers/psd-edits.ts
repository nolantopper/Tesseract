import { checkedPixels } from './raster';

const unsupported = () => new Error('Color editing requires a plain 8-bit RGB Photoshop document.');

function colorChannels(bytes: Uint8Array, apply: boolean) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 38 ||
    view.getUint32(0) !== 0x38425053 ||
    view.getUint16(4) !== 1 ||
    view.getUint16(22) !== 8 ||
    view.getUint16(24) !== 3
  )
    throw unsupported();
  const count = view.getUint16(12);
  const height = view.getUint32(14);
  const width = view.getUint32(18);
  checkedPixels(width, height);
  if (count < 3 || count > 4) throw unsupported();

  let offset = 26;
  const sectionEnd = (limit: number) => {
    const end = offset + 4 + view.getUint32(offset);
    offset += 4;
    if (end > limit) throw unsupported();
    return end;
  };
  offset = sectionEnd(bytes.length);
  offset = sectionEnd(bytes.length);
  const layerMaskEnd = sectionEnd(bytes.length);

  const readColors = (start: number, end: number, w: number, h: number, colors: boolean[]) => {
    if (start + 2 > end) throw unsupported();
    const mode = view.getUint16(start);
    let cursor = start + 2;
    if (mode === 0) {
      if (end !== cursor + w * h * colors.length) throw unsupported();
      for (const color of colors) {
        const limit = cursor + w * h;
        if (apply && color) for (let i = cursor; i < limit; i++) bytes[i] >>= 1;
        cursor = limit;
      }
      return;
    }
    if (mode !== 1) throw unsupported();
    let rowSize = cursor;
    cursor += h * colors.length * 2;
    if (cursor > end) throw unsupported();
    for (const color of colors) {
      for (let row = 0; row < h; row++) {
        const rowEnd = cursor + view.getUint16(rowSize);
        rowSize += 2;
        if (rowEnd > end) throw unsupported();
        let pixels = 0;
        while (cursor < rowEnd) {
          const tag = view.getInt8(cursor++);
          if (tag === -128) continue;
          const samples = tag < 0 ? 1 : tag + 1;
          const next = cursor + samples;
          if (next > rowEnd) throw unsupported();
          pixels += Math.abs(tag) + 1;
          if (apply && color) for (let i = cursor; i < next; i++) bytes[i] >>= 1;
          cursor = next;
        }
        if (pixels !== w) throw unsupported();
      }
    }
    if (cursor !== end) throw unsupported();
  };

  if (offset < layerMaskEnd) {
    const layerInfoEnd = sectionEnd(layerMaskEnd);
    if (offset < layerInfoEnd) {
      const layers = Math.abs(view.getInt16(offset));
      offset += 2;
      if (layers > 200) throw unsupported();
      const channels: Array<{ w: number; h: number; color: boolean; size: number }> = [];
      for (let layer = 0; layer < layers; layer++) {
        const h = view.getInt32(offset + 8) - view.getInt32(offset);
        const w = view.getInt32(offset + 12) - view.getInt32(offset + 4);
        const entries = view.getUint16(offset + 16);
        offset += 18;
        if (entries < 3 || entries > 4) throw unsupported();
        checkedPixels(w, h);
        const ids = new Set<number>();
        for (let i = 0; i < entries; i++) {
          const id = view.getInt16(offset);
          if (id < -1 || id > 2 || ids.has(id)) throw unsupported();
          ids.add(id);
          channels.push({ w, h, color: id >= 0, size: view.getUint32(offset + 2) });
          offset += 6;
        }
        if (view.getUint32(offset) !== 0x3842494d || view.getUint32(offset + 4) !== 0x6e6f726d)
          throw unsupported();
        offset += 12;
        const extraEnd = sectionEnd(layerInfoEnd);
        // No masks, blend ranges or color effects. Layer naming and stable IDs are kept.
        if (view.getUint32(offset) !== 0 || view.getUint32(offset + 4) !== 0) throw unsupported();
        offset += 8;
        offset += Math.ceil((bytes[offset] + 1) / 4) * 4;
        while (offset < extraEnd) {
          const signature = view.getUint32(offset);
          const key = view.getUint32(offset + 4);
          const length = view.getUint32(offset + 8);
          if (signature !== 0x3842494d || (key !== 0x6c756e69 && key !== 0x6c796964))
            throw unsupported();
          offset += 12 + length + (length % 2);
        }
        if (offset !== extraEnd) throw unsupported();
      }
      for (const { w, h, color, size } of channels) {
        if (offset + size > layerInfoEnd) throw unsupported();
        readColors(offset, offset + size, w, h, [color]);
        offset += size;
      }
      if (layerInfoEnd - offset > 3) throw unsupported();
    }
    offset = layerInfoEnd;
    if (offset + 4 === layerMaskEnd && view.getUint32(offset) === 0) offset += 4;
    if (offset !== layerMaskEnd) throw unsupported();
  }
  readColors(layerMaskEnd, bytes.length, width, height, [
    true,
    true,
    true,
    ...(count === 4 ? [false] : []),
  ]);
}

export function canDarkenPsd(data: ArrayBuffer) {
  try {
    colorChannels(new Uint8Array(data), false);
    return true;
  } catch {
    return false;
  }
}

export function darkenPsd(data: ArrayBuffer) {
  const bytes = new Uint8Array(data.slice(0));
  colorChannels(bytes, true);
  return bytes;
}
