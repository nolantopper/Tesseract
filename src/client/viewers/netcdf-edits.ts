import { NetCDFReader } from 'netcdfjs';
import { writeNumericEdit } from '../../shared/numeric-edit';

const types: Record<string, [string, number]> = {
  byte: ['i', 1],
  short: ['i', 2],
  int: ['i', 4],
  float: ['f', 4],
  double: ['f', 8],
};

export function editableNetCdf(type: string, record: boolean) {
  return !record && Object.hasOwn(types, type);
}

export function editNetCdfValue(data: ArrayBuffer, name: string, index: number, value: string) {
  const reader = new NetCDFReader(data);
  const variable = reader.variables.find((entry) => entry.name === name);
  if (!variable || !editableNetCdf(variable.type, variable.record))
    throw new Error('Choose a fixed-size numeric variable.');
  const [type, size] = types[variable.type];
  const count = variable.dimensions.reduce(
    (total, dimension) => total * (reader.dimensions[dimension]?.size || 0),
    1,
  );
  if (!Number.isSafeInteger(index) || index < 0 || index >= count)
    throw new Error('Choose an element in this array.');
  if (
    count * size > variable.size ||
    variable.offset < 0 ||
    variable.offset + variable.size > data.byteLength
  )
    throw new Error('Invalid NetCDF variable range.');
  writeNumericEdit(new DataView(data), variable.offset + index * size, type, size, false, value);
  return data;
}
