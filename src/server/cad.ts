import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
export const cadDecoder = (kind = 'cad') =>
  kind === 'laz'
    ? readFile(join(dirname(require.resolve('laz-perf')), 'laz-perf.wasm'))
    : readFile(join(dirname(require.resolve('occt-import-js')), 'occt-import-js.wasm'));
