import createArchive from 'libarchive.js/src/webworker/wasm-gen/libarchive.js';
import archiveWasm from 'libarchive.js/dist/libarchive.wasm?url&inline';
import { Buffer } from 'buffer/';
import bzip from 'seek-bzip';
import { XzReadableStream } from 'xz-decompress';
import { Decompress } from 'fzstd';
import { archiveLimit, safeEntry } from '../../shared/archives';

const entryLimit = 2000;

// Check every frame before fzstd allocates its sliding window.
function checkZstdWindows(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset < data.length;) {
    const magic = view.getUint32(offset, true);
    offset += 4;
    if (magic >>> 4 === 0x184d2a5) {
      offset += 4 + view.getUint32(offset, true);
      if (offset > data.length) throw new Error('Truncated Zstandard frame.');
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error('Invalid Zstandard frame.');
    const flags = view.getUint8(offset++);
    const singleSegment = Boolean(flags & 32);
    if (!singleSegment) {
      const descriptor = view.getUint8(offset++);
      const base = 2 ** (10 + (descriptor >>> 3));
      if (base * (1 + (descriptor & 7) / 8) > archiveLimit)
        throw new Error('Zstandard window exceeds 64 MiB.');
    }
    offset += [0, 1, 2, 4][flags & 3];
    const sizeFlag = flags >>> 6;
    const sizeBytes = sizeFlag ? 2 ** sizeFlag : Number(singleSegment);
    if (sizeBytes) {
      const size =
        sizeBytes === 8
          ? view.getBigUint64(offset, true)
          : sizeBytes === 4
            ? BigInt(view.getUint32(offset, true))
            : sizeBytes === 2
              ? BigInt(view.getUint16(offset, true) + 256)
              : BigInt(view.getUint8(offset));
      if (size > BigInt(archiveLimit)) throw new Error('Zstandard frame exceeds 64 MiB.');
    }
    offset += sizeBytes;
    let last: boolean;
    do {
      const header =
        view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16);
      const type = (header >>> 1) & 3;
      if (type === 3) throw new Error('Invalid Zstandard block.');
      last = Boolean(header & 1);
      offset += 3 + (type === 1 ? 1 : header >>> 3);
    } while (!last);
    if (flags & 4) offset += 4;
    if (offset > data.length) throw new Error('Truncated Zstandard frame.');
  }
}

async function decompress(data: ArrayBuffer, kind: string) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const add = (chunk: Uint8Array) => {
    size += chunk.length;
    if (size > archiveLimit) throw new Error('Expanded size exceeds 64 MiB.');
    if (chunk.length) chunks.push(chunk);
  };
  if (kind === 'xz') {
    const stream = new XzReadableStream(new Blob([data]).stream());
    const reader = stream.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        add(next.value);
      }
    } finally {
      await reader.cancel();
    }
  } else if (kind === 'bz2') {
    Object.assign(globalThis, { Buffer });
    let chunk = new Uint8Array(16384);
    let offset = 0;
    bzip.decode(
      new Uint8Array(data),
      {
        writeByte(byte) {
          chunk[offset++] = byte;
          if (offset === chunk.length) {
            add(chunk);
            chunk = new Uint8Array(16384);
            offset = 0;
          }
        },
      },
      true,
    );
    add(chunk.subarray(0, offset));
  } else {
    const bytes = new Uint8Array(data);
    checkZstdWindows(bytes);
    new Decompress(add).push(bytes, true);
  }
  const decoded = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.length;
  }
  return decoded;
}

export async function unpackExtended(data: ArrayBuffer, kind: string, name: string) {
  if (data.byteLength > archiveLimit) throw new Error('Archive exceeds 64 MiB.');
  if (kind === 'xz' || kind === 'bz2' || kind === 'zst') {
    const path = safeEntry(
      name.replace(/\.(?:txz|tbz2?|tzst)$/i, '.tar').replace(/\.(?:xz|bz2|bzip2|zst|zstd)$/i, '') ||
        'content',
    );
    return { [path]: await decompress(data, kind) };
  }
  const wasmBinary = await (await fetch(archiveWasm)).arrayBuffer();
  const module = await createArchive({ wasmBinary });
  const source = module._malloc(data.byteLength);
  if (!source) throw new Error('Cannot allocate archive preview.');
  let archive = 0;
  try {
    module.HEAPU8.set(new Uint8Array(data), source);
    archive = module.cwrap('archive_open', 'number', ['number', 'number', 'string', 'string'])(
      source,
      data.byteLength,
      null,
      'en_US.UTF-8',
    );
    if (!archive) throw new Error('Couldn’t read archive.');
    const getPath = module.cwrap('archive_entry_pathname', 'string', ['number']);
    const getError = module.cwrap('archive_error_string', 'string', ['number']);
    const entries: Record<string, Uint8Array> = Object.create(null);
    let total = 0;
    let count = 0;
    for (let entry; (entry = module._get_next_entry(archive));) {
      if (++count > entryLimit) throw new Error('Archive exceeds 2,000 entries.');
      const type = module._archive_entry_filetype(entry);
      if (type !== 32768) {
        module._archive_read_data_skip(archive);
        continue;
      }
      if (module._archive_entry_is_encrypted(entry)) throw new Error('Encrypted archive entry.');
      const path = safeEntry(getPath(entry))
        .split('/')
        .filter((part) => part && part !== '.')
        .join('/');
      safeEntry(path);
      if (Object.hasOwn(entries, path)) throw new Error('Duplicate archive entry.');
      const size = module._archive_entry_size(entry);
      if (!Number.isSafeInteger(size) || size < 0 || (total += size) > archiveLimit)
        throw new Error('Archive expanded size exceeds 64 MiB.');
      if (!size) {
        entries[path] = new Uint8Array();
        continue;
      }
      const pointer = module._get_filedata(archive, size);
      if (pointer <= 0) throw new Error(getError(archive) || 'Couldn’t read archive entry.');
      try {
        if (pointer + size > module.HEAPU8.length) throw new Error('Invalid archive entry size.');
        entries[path] = module.HEAPU8.slice(pointer, pointer + size);
      } finally {
        module._free(pointer);
      }
    }
    if (getError(archive)) throw new Error('Couldn’t read archive.');
    return entries;
  } finally {
    if (archive) module._archive_close(archive);
    module._free(source);
  }
}
