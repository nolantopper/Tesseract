import { checkedPixels } from './raster';

const colorChannel = (name: string) => name === 'R' || name === 'G' || name === 'B';

export function readExrHeader(data: ArrayBuffer) {
  const view = new DataView(data);
  const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 65_536));
  if (bytes.length < 8 || view.getUint32(0, true) !== 20000630 || (bytes[5] & ~6) !== 0)
    throw new Error('Expected a single-part, non-deep OpenEXR image.');
  const text = new TextDecoder();
  const attrs = new Set<string>();
  let offset = 8;
  let width = 0;
  let height = 0;
  let top = 0;
  let compression = -1;
  let channelData: Uint8Array | undefined;
  const string = () => {
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end - offset > 255) throw new Error('Invalid OpenEXR header attribute.');
    const result = text.decode(bytes.subarray(offset, end));
    offset = end + 1;
    return result;
  };
  for (let name = string(); name; name = string()) {
    const type = string();
    const size = view.getUint32(offset, true);
    offset += 4;
    const end = offset + size;
    if (attrs.has(name) || name === '__proto__' || end > bytes.length)
      throw new Error('Invalid or oversized OpenEXR header.');
    attrs.add(name);
    if (name === 'dataWindow' && type === 'box2i' && size === 16) {
      const left = view.getInt32(offset, true);
      top = view.getInt32(offset + 4, true);
      width = view.getInt32(offset + 8, true) - left + 1;
      height = view.getInt32(offset + 12, true) - top + 1;
      checkedPixels(width, height);
    }
    if (name === 'tiles' && type === 'tiledesc' && size === 9)
      checkedPixels(view.getUint32(offset, true), view.getUint32(offset + 4, true));
    if (name === 'compression' && size === 1) compression = bytes[offset];
    if (name === 'channels') {
      if (size > 2048) throw new Error('OpenEXR channel list exceeds the preview limit.');
      channelData = bytes.subarray(offset, end);
    }
    offset = end;
  }
  if (!width || !height || !channelData)
    throw new Error('OpenEXR header is missing image metadata.');
  const channels: Array<{ rgb: boolean; half: boolean; size: number }> = [];
  let channel = 0;
  while (channel < channelData.length - 1) {
    const end = channelData.indexOf(0, channel);
    if (end <= channel || end + 17 >= channelData.length) break;
    const name = text.decode(channelData.subarray(channel, end));
    const field = channelData.byteOffset + end + 1;
    const format = view.getUint32(field, true);
    if (
      format > 2 ||
      view.getUint32(field + 8, true) !== 1 ||
      view.getUint32(field + 12, true) !== 1 ||
      (format === 0 && colorChannel(name))
    )
      break;
    const half = format === 1;
    channels.push({ rgb: colorChannel(name), half, size: half ? 2 : 4 });
    channel = end + 17;
  }
  const canDarken =
    compression === 0 &&
    !(bytes[5] & 2) &&
    channel === channelData.length - 1 &&
    channelData[channel] === 0 &&
    channels.filter(({ rgb }) => rgb).length === 3;
  return { canDarken, offset, width, height, top, channels };
}

function darkenExr(data: ArrayBuffer) {
  const header = readExrHeader(data);
  if (!header.canDarken)
    throw new Error('Exposure editing requires uncompressed OpenEXR RGB scanlines.');
  const bytes = new Uint8Array(data.slice(0));
  const view = new DataView(bytes.buffer);
  const { width, height, offset, top, channels } = header;
  const stride = width * channels.reduce((total, field) => total + field.size, 0);
  const tableEnd = offset + height * 8;
  if (tableEnd > bytes.length) throw new Error('Truncated OpenEXR scanline table.');
  const offsets = Array.from({ length: height }, (_, y) =>
    Number(view.getBigUint64(offset + y * 8, true)),
  );
  offsets.sort((a, b) => a - b);
  const lines = new Set<number>();
  for (let y = 0; y < height; y++) {
    const start = offsets[y];
    const end = start + 8 + stride;
    if (
      !Number.isSafeInteger(start) ||
      start < tableEnd ||
      end > bytes.length ||
      end > (offsets[y + 1] ?? bytes.length)
    )
      throw new Error('Invalid OpenEXR scanline offset.');
    const line = view.getInt32(start, true);
    if (
      line < top ||
      line >= top + height ||
      lines.has(line) ||
      view.getUint32(start + 4, true) !== stride
    )
      throw new Error('Invalid OpenEXR scanline.');
    lines.add(line);
    let position = start + 8;
    for (const { rgb, half, size } of channels) {
      const end = position + width * size;
      if (rgb)
        for (; position < end; position += size) {
          if (!half) {
            const sample = view.getFloat32(position, true);
            if (Number.isFinite(sample)) view.setFloat32(position, sample * 0.5, true);
          } else {
            const sample = view.getUint16(position, true);
            const exponent = sample & 0x7c00;
            if (exponent === 0x7c00) continue;
            const mantissa = sample & 0x07ff;
            const next =
              exponent > 0x0400
                ? sample - 0x0400
                : (sample & 0x8000) | ((mantissa >>> 1) + ((mantissa & 3) === 3 ? 1 : 0));
            view.setUint16(position, next, true);
          }
        }
      position = end;
    }
  }
  return bytes;
}

export function readHdrHeader(data: ArrayBuffer) {
  const header = new TextDecoder('latin1').decode(
    new Uint8Array(data, 0, Math.min(8192, data.byteLength)),
  );
  const size = /^-Y (\d+) \+X (\d+)\r?\n/m.exec(header);
  if (!size) throw new Error('Unsupported Radiance HDR orientation or header.');
  const width = Number(size[2]);
  const height = Number(size[1]);
  checkedPixels(width, height);
  return {
    width,
    height,
    offset: size.index + size[0].length,
    canDarken: /^FORMAT=32-bit_rle_rgbe\r?$/m.test(header.slice(0, size.index)),
  };
}

function darkenHdr(data: ArrayBuffer) {
  const header = readHdrHeader(data);
  if (!header.canDarken) throw new Error('Exposure editing requires Radiance RGBE pixels.');
  const { width, height } = header;
  const bytes = new Uint8Array(data.slice(0));
  let offset = header.offset;
  const reduce = (index: number) => {
    if (bytes[index]) bytes[index]--;
  };
  const encoded =
    width >= 8 &&
    width <= 0x7fff &&
    bytes[offset] === 2 &&
    bytes[offset + 1] === 2 &&
    !(bytes[offset + 2] & 0x80);
  if (!encoded) {
    if (offset + width * height * 4 !== bytes.length)
      throw new Error('Legacy Radiance run-length encoding cannot be edited.');
    for (; offset < bytes.length; offset += 4) reduce(offset + 3);
    return bytes;
  }
  for (let row = 0; row < height; row++) {
    if (
      bytes[offset] !== 2 ||
      bytes[offset + 1] !== 2 ||
      ((bytes[offset + 2] << 8) | bytes[offset + 3]) !== width
    )
      throw new Error('Invalid Radiance scanline.');
    offset += 4;
    for (let channel = 0; channel < 4; channel++) {
      let column = 0;
      while (column < width) {
        const tag = bytes[offset++];
        const run = tag > 128;
        const count = run ? tag - 128 : tag;
        const end = offset + (run ? 1 : count);
        if (!count || column + count > width || end > bytes.length)
          throw new Error('Invalid Radiance scanline packet.');
        if (channel === 3) for (let byte = offset; byte < end; byte++) reduce(byte);
        offset = end;
        column += count;
      }
    }
  }
  if (offset !== bytes.length) throw new Error('Unexpected data after Radiance scanlines.');
  return bytes;
}

export function darkenImage(data: ArrayBuffer, exr: boolean) {
  return exr ? darkenExr(data) : darkenHdr(data);
}
