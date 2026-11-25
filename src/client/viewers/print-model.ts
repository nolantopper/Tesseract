import { zipSync } from 'fflate';
import { LoadingManager } from 'three';
import { AMFLoader } from 'three/addons/loaders/AMFLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { indexZip, readZipEntry, decodeZipEntry } from '../../shared/zip';

const xmlLimit = 8 * 1024 * 1024;
const packageLimit = 32 * 1024 * 1024;

function parseXml(bytes: ArrayBuffer) {
  if (bytes.byteLength > xmlLimit) throw new Error('Model XML exceeds 8 MiB.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML entities are not supported.');
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid model XML.');
  return xml;
}

function check3mf(root: Document) {
  const objects = new Map<string, Element>();
  const resources = root.querySelector('resources');
  const identifiers = new Set<string>();
  for (const resource of resources?.querySelectorAll('[id]') ?? []) {
    const id = resource.getAttribute('id') ?? '';
    if (!/^\d{1,10}$/.test(id) || identifiers.has(id))
      throw new Error('Invalid or duplicate 3MF resource ID.');
    identifiers.add(id);
  }
  for (const resource of root.querySelectorAll('[pid], [texid], [displaypropertiesid]')) {
    if (
      ['pid', 'texid', 'displaypropertiesid'].some((key) => {
        const id = resource.getAttribute(key);
        return id !== null && !/^\d{1,10}$/.test(id);
      })
    )
      throw new Error('Invalid 3MF material resource reference.');
  }
  for (const object of resources?.querySelectorAll('object') ?? []) {
    const id = object.getAttribute('id') ?? '';
    if (!/^\d{1,10}$/.test(id) || objects.has(id) || objects.size >= 2000)
      throw new Error('Invalid or excessive 3MF objects.');
    objects.set(id, object);
  }
  if (!objects.size) throw new Error('No 3MF objects found.');
  const visiting = new Set<string>();
  const costs = new Map<string, { nodes: number; vertices: number }>();
  function cost(id: string, depth: number) {
    if (depth > 32 || visiting.has(id)) throw new Error('Invalid 3MF component hierarchy.');
    const cached = costs.get(id);
    if (cached) return cached;
    const object = objects.get(id);
    if (!object) throw new Error('Missing 3MF object. Cross-document components are unsupported.');
    visiting.add(id);
    const result = { nodes: 1, vertices: object.querySelectorAll('triangle').length * 3 };
    for (const component of object.querySelector('components')?.querySelectorAll('component') ??
      []) {
      const child = cost(component.getAttribute('objectid') ?? '', depth + 1);
      result.nodes += child.nodes;
      result.vertices += child.vertices;
      if (result.nodes > 2000 || result.vertices > 6_000_000)
        throw new Error('3MF component expansion exceeds the preview limit.');
    }
    visiting.delete(id);
    costs.set(id, result);
    return result;
  }
  const items = root.querySelector('build')?.querySelectorAll('item') ?? [];
  if (!items.length || items.length > 2000) throw new Error('Invalid 3MF build list.');
  let templates = 0;
  for (const id of objects.keys()) {
    templates += cost(id, 0).nodes;
    if (templates > 10_000) throw new Error('3MF build hierarchy exceeds the preview limit.');
  }
  let nodes = 0;
  let vertices = 0;
  for (const item of items) {
    const child = cost(item.getAttribute('objectid') ?? '', 0);
    nodes += child.nodes;
    vertices += child.vertices;
    if (nodes > 2000 || vertices > 6_000_000)
      throw new Error('3MF build exceeds the preview limit.');
  }
}

export async function parsePrintModel(
  format: '3mf' | 'amf',
  input: ArrayBuffer,
  signal: AbortSignal,
) {
  let data = input;
  const warnings: string[] = [];
  if (format === '3mf' || (input.byteLength >= 2 && new DataView(input).getUint16(0) === 0x504b)) {
    const read = async (offset: number, size: number) => {
      signal.throwIfAborted();
      return input.slice(offset, offset + size);
    };
    const { entries } = await indexZip(input.byteLength, read);
    const files: Record<string, Uint8Array> = Object.create(null);
    let expanded = 0;
    let modelCount = 0;
    for (const entry of entries.values()) {
      if (entry.directory) continue;
      if (format === 'amf' && !entry.path.toLowerCase().endsWith('.amf')) continue;
      expanded += entry.size;
      if (expanded > packageLimit) throw new Error('Model package exceeds 32 MiB expanded size.');
      const isXml = /\.(?:model|rels|xml|amf)$/i.test(entry.path);
      if (isXml && entry.size > xmlLimit) throw new Error('Model XML exceeds 8 MiB.');
      const content = decodeZipEntry(await readZipEntry(entry, read), entry);
      if (format === 'amf') {
        if (++modelCount > 1) throw new Error('AMF package contains multiple models.');
        data = content;
      } else {
        if (isXml) {
          const xml = parseXml(content);
          if (entry.path.endsWith('.model')) {
            if (++modelCount > 1) throw new Error('3MF cross-document components are unsupported.');
            check3mf(xml);
          }
        }
        files[entry.path] = new Uint8Array(content);
        if (entry.path.endsWith('.printticket') && !warnings.length)
          warnings.push('3MF print settings are omitted.');
      }
    }
    if (!modelCount) throw new Error('Model package has no geometry.');
    if (format === '3mf') data = zipSync(files, { level: 0 }).buffer;
  }
  const manager = new LoadingManager();
  const urls = new Set<string>();
  const release = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  manager.setURLModifier((url) => {
    if (!url.startsWith('blob:')) throw new Error('Only embedded 3MF textures are supported.');
    urls.add(url);
    return url;
  });
  try {
    if (format === 'amf' && parseXml(data).querySelector('constellation'))
      warnings.push('AMF constellations are omitted.');
    signal.throwIfAborted();
    const object =
      format === '3mf'
        ? new ThreeMFLoader(manager).parse(data)
        : new AMFLoader(manager).parse(data);
    if (!object) throw new Error('No renderable print geometry found.');
    // Both print formats use a Z-up coordinate system.
    object.rotateX(-Math.PI / 2);
    manager.onLoad = release;
    return {
      object,
      release,
      warnings,
    };
  } catch (error) {
    release();
    throw error;
  }
}
