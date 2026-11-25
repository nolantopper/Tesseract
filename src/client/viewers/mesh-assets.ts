import { LoadingManager, type Object3D } from 'three';
import { GLTFLoader, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { disposeModel } from './model-parts';

export async function parseMeshAsset(
  format: string,
  data: ArrayBuffer,
  loadAsset: (path: string) => Promise<ArrayBuffer>,
  signal: AbortSignal,
): Promise<{ object: Object3D; parser?: GLTFParser; release: () => void }> {
  const manager = new LoadingManager();
  const urls = new Map<string, string>();
  let object: Object3D | undefined;
  let bytes = data.byteLength;
  let loading = false;
  let finish!: () => void;
  let failed!: (error: Error) => void;
  const imagesReady = new Promise<void>((resolve, reject) => {
    finish = resolve;
    failed = reject;
  });
  void imagesReady.catch(() => {});
  manager.onStart = () => {
    loading = true;
  };
  manager.onLoad = () => finish();
  manager.onError = () => failed(new Error('Couldn’t load a referenced model image.'));
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const local = urls.get(url) ?? urls.get(url.replace(/^\.\//, ''));
    if (!local) throw new Error(`Missing asset: ${url}. Open the containing folder or ZIP.`);
    return local;
  });
  const release = () => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  };
  const aborted = () => failed(new Error('Model loading cancelled.'));
  signal.addEventListener('abort', aborted, { once: true });
  try {
    let uris: string[];
    let text = '';
    if (format === 'gltf' || format === 'glb') {
      let jsonData = data;
      if (format === 'glb') {
        const view = new DataView(data);
        if (
          data.byteLength < 20 ||
          view.getUint32(0, true) !== 0x46546c67 ||
          view.getUint32(16, true) !== 0x4e4f534a
        )
          throw new Error('Invalid GLB header.');
        const length = view.getUint32(12, true);
        if (length > data.byteLength - 20) throw new Error('Truncated GLB JSON.');
        jsonData = data.slice(20, 20 + length);
      }
      const json = JSON.parse(new TextDecoder().decode(jsonData));
      uris = [...(json.buffers ?? []), ...(json.images ?? [])].flatMap(
        (entry: { uri?: unknown }) => (typeof entry.uri === 'string' ? [entry.uri] : []),
      );
    } else if (format === 'dae') {
      if (data.byteLength > 8 * 1024 * 1024)
        throw new Error('Collada XML exceeds the 8 MiB preview limit.');
      text = new TextDecoder().decode(data);
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML entities are not supported.');
      const xml = new DOMParser().parseFromString(text, 'application/xml');
      if (xml.querySelector('parsererror')) throw new Error('Malformed Collada XML.');
      uris = Array.from(xml.querySelectorAll('library_images image init_from'))
        .map((entry) => entry.textContent?.trim() ?? '')
        .filter(Boolean);
    } else uris = [];
    for (const uri of new Set(uris)) {
      signal.throwIfAborted();
      if (uri.startsWith('data:')) continue;
      if (urls.size >= 128) throw new Error('Model exceeds the 128 linked asset limit.');
      const content = await loadAsset(uri);
      bytes += content.byteLength;
      if (bytes > 64 * 1024 * 1024) throw new Error('Model and linked assets exceed 64 MiB.');
      urls.set(uri, URL.createObjectURL(new Blob([content])));
    }
    signal.throwIfAborted();
    const parsed =
      format === 'dae'
        ? { object: new ColladaLoader(manager).parse(text, '')!.scene }
        : await new GLTFLoader(manager)
            .parseAsync(data, '')
            .then((gltf) => ({ object: gltf.scene, parser: gltf.parser }));
    object = parsed.object;
    if (loading) await imagesReady;
    signal.throwIfAborted();
    return { ...parsed, release };
  } catch (error) {
    if (object) disposeModel(object);
    release();
    throw error;
  } finally {
    signal.removeEventListener('abort', aborted);
  }
}
