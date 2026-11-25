import type { Dataset, Group } from 'h5wasm';
import { parseNumericEdit } from '../../shared/numeric-edit';

type Hdf5 = typeof import('h5wasm');

export function isHdf5Link(group: Group, name: string) {
  const path = `${group.path === '/' ? '' : group.path}/${name}`;
  return Boolean(group.get_link(path) || group.get_external_link(path)?.filename);
}

export function editableHdf5(dataset: Dataset) {
  const { type, size, littleEndian, shape, virtual_sources: sources } = dataset.metadata;
  return (
    shape != null &&
    littleEndian &&
    !sources?.length &&
    ((type === 0 && [1, 2, 4, 8].includes(size)) || (type === 1 && [4, 8].includes(size)))
  );
}

export async function editHdf5Value(
  h5: Hdf5,
  data: ArrayBuffer,
  path: string,
  index: number,
  draft: string,
  source: string,
) {
  const { FS } = await h5.ready;
  FS.writeFile(source, new Uint8Array(data));
  let file: InstanceType<typeof h5.File> | undefined;
  try {
    file = new h5.File(source, 'a');
    const names = path.slice(1).split('/');
    if (
      !path.startsWith('/') ||
      !names.length ||
      names.length > 9 ||
      names.some((name) => !name || name === '.' || name === '..')
    )
      throw new Error('Invalid HDF5 dataset path.');
    let group: Group = file;
    for (const name of names.slice(0, -1)) {
      if (isHdf5Link(group, name)) throw new Error('Linked datasets cannot be edited.');
      const entity = group.get(name);
      if (!(entity instanceof h5.Group)) throw new Error('The selected dataset no longer exists.');
      group = entity;
    }
    const name = names[names.length - 1];
    if (isHdf5Link(group, name)) throw new Error('Linked datasets cannot be edited.');
    const dataset = group.get(name);
    if (!(dataset instanceof h5.Dataset) || !editableHdf5(dataset))
      throw new Error('Choose an editable numeric dataset.');
    const { shape, type, size, signed } = dataset.metadata;
    const dimensions = shape!;
    const count = dimensions.reduce((total, dimension) => total * dimension, 1);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(index) || index < 0 || index >= count)
      throw new Error('Choose an element in this dataset.');
    let position = index;
    const ranges: [number, number][] = [];
    for (const dimension of [...dimensions].reverse()) {
      const coordinate = position % dimension;
      ranges.unshift([coordinate, coordinate + 1]);
      position = Math.floor(position / dimension);
    }
    const value = parseNumericEdit(draft, type === 1 ? 'f' : signed ? 'i' : 'u', size);
    dataset.write_slice(ranges, [value]);
    const result = dataset.slice(ranges);
    const edited = ArrayBuffer.isView(result)
      ? (result as unknown as ArrayLike<number | bigint>)[0]
      : result;
    if (edited !== (type === 1 && size === 4 ? Math.fround(Number(value)) : value))
      throw new Error('The selected HDF5 value could not be verified.');
    if (file.close() !== 0) throw new Error('Couldn’t close the edited HDF5 file.');
    file = undefined;
    return FS.readFile(source);
  } finally {
    file?.close();
    FS.unlink(source);
  }
}
