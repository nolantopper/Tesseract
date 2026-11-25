import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
export const cadDecoder = (kind = 'cad') => {
  switch (kind) {
    case 'laz':
      return readFile(join(dirname(require.resolve('laz-perf')), 'laz-perf.wasm'));
    case 'ifc':
      return readFile(require.resolve('web-ifc/web-ifc.wasm'));
    case 'rhino':
      return readFile(require.resolve('three/addons/libs/rhino3dm/rhino3dm.wasm'));
    default:
      return readFile(join(dirname(require.resolve('occt-import-js')), 'occt-import-js.wasm'));
  }
};
