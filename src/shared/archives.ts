import { Unzip, UnzipInflate, Gunzip } from 'fflate';
export const archiveLimit = 64 * 1024 * 1024;

export function gzipFilename(data: Uint8Array) {
  if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8 || data[3] & 0xe0)
    throw new Error('Invalid GZIP header.');
  let start = 10;
  if (data[3] & 4) start += 2 + (data[10] | (data[11] << 8));
  if (start > data.length - 8) throw new Error('Truncated GZIP header.');
  if (!(data[3] & 8)) return { start, end: start, name: undefined };
  const terminator = data.subarray(start, Math.min(start + 4097, data.length - 8)).indexOf(0);
  if (terminator < 0) throw new Error('Invalid GZIP filename.');
  return {
    start,
    end: start + terminator + 1,
    name: new TextDecoder('iso-8859-1').decode(data.subarray(start, start + terminator)),
  };
}

export function safeEntry(name: string) {
  if (
    !name ||
    name.length > 4096 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[a-z]:/i.test(name) ||
    name.split('/').some((p) => p === '..')
  )
    throw new Error('Unsafe archive entry path.');
  return name;
}
export function unpack(data: Uint8Array, kind: string, name: string): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = Object.create(null);
  let total = 0,
    count = 0;
  const add = (path: string, bytes: Uint8Array) => {
    safeEntry(path);
    if (++count > 2000 || (total += bytes.length) > archiveLimit)
      throw new Error('Archive exceeds 2,000 entries or 64 MiB expanded size.');
    if (Object.hasOwn(entries, path)) throw new Error('Duplicate archive entry.');
    entries[path] = bytes;
  };
  if (data.length > archiveLimit) throw new Error('Archive exceeds 64 MiB.');
  if (kind === 'zip' || kind === 'npz') {
    let expanded = 0,
      files = 0;
    const unzip = new Unzip((file) => {
      safeEntry(file.name);
      if (++files > 2000 || (file.originalSize ?? 0) > archiveLimit)
        throw new Error('Archive limits exceeded.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        size += chunk.length;
        expanded += chunk.length;
        if (expanded > archiveLimit) {
          file.terminate();
          throw new Error('Archive expanded size exceeds 64 MiB.');
        }
        chunks.push(chunk);
        if (final && !file.name.endsWith('/')) {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const c of chunks) {
            bytes.set(c, offset);
            offset += c.length;
          }
          add(file.name, bytes);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let at = 0; at < data.length; at += 16384)
      unzip.push(data.subarray(at, at + 16384), at + 16384 >= data.length);
  } else if (kind === 'gz') {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const decoder = new Gunzip((chunk) => {
      size += chunk.length;
      if (size > archiveLimit) throw new Error('GZIP expanded size exceeds 64 MiB.');
      chunks.push(chunk);
    });
    for (let at = 0; at < data.length; at += 16384)
      decoder.push(data.subarray(at, at + 16384), at + 16384 >= data.length);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    let filename: string | undefined;
    try {
      const stored = gzipFilename(data).name;
      if (stored && /^[^/\\]+$/.test(stored) && stored !== '.' && stored !== '..')
        filename = safeEntry(stored);
    } catch {}
    add(
      filename || name.replace(/\.tgz$/i, '.tar').replace(/\.(?:gz|gzip)$/i, '') || 'content',
      bytes,
    );
  } else if (kind === 'tar') {
    const text = (start: number, length: number) =>
      new TextDecoder().decode(data.subarray(start, start + length)).split('\0')[0];
    for (let offset = 0; offset + 512 <= data.length;) {
      if (data.subarray(offset, offset + 512).every((b) => b === 0)) break;
      const path = [text(offset + 345, 155), text(offset, 100)].filter(Boolean).join('/');
      safeEntry(path);
      const size = parseInt(text(offset + 124, 12).trim(), 8);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > archiveLimit ||
        offset + 512 + size > data.length
      )
        throw new Error('Invalid TAR entry size.');
      const type = text(offset + 156, 1);
      if (type !== '' && type !== '0' && type !== '5')
        throw new Error('TAR links and extended entry types are not supported.');
      if (type !== '5') add(path, data.slice(offset + 512, offset + 512 + size));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  } else throw new Error('Unsupported archive format.');
  return entries;
}
