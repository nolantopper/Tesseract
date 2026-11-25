import type { Format } from './types.js';
export const rasterIds = ['tiff', 'psd', 'exr', 'hdr', 'dicom', 'nifti', 'nrrd'];
export const formats: Format[] = [
  ...[
    ['3mf', '3MF', ['3mf']],
    ['amf', 'AMF', ['amf']],
    ['fbx', 'FBX', ['fbx']],
    ['3ds', '3DS', ['3ds']],
    ['3dm', 'Rhino 3DM', ['3dm']],
    ['brep', 'BREP', ['brep', 'brp']],
    ['dxf', 'DXF', ['dxf']],
    ['ifc', 'IFC', ['ifc']],
  ].map(([id, label, extensions]) => ({
    id: id as string,
    label: label as string,
    extensions: extensions as string[],
    mime: 'application/octet-stream',
    kind: 'model' as const,
  })),
  ...[
    ['parquet', 'Parquet', ['parquet']],
    ['sqlite', 'SQLite', ['sqlite', 'sqlite3', 'db', 'db3']],
    ['geojson', 'GeoJSON', ['geojson']],
    ['kml', 'KML', ['kml']],
    ['shp', 'Shapefile', ['shp']],
    ['onnx', 'ONNX', ['onnx']],
    ['tflite', 'TensorFlow Lite', ['tflite']],
    ['safetensors', 'Safetensors', ['safetensors']],
    ['gguf', 'GGUF', ['gguf']],
  ].map(([id, label, extensions]) => ({
    id: id as string,
    label: label as string,
    extensions: extensions as string[],
    mime: 'application/octet-stream',
    kind: 'text' as const,
  })),
  ...[
    ['tiff', 'TIFF', ['tif', 'tiff', 'geotiff']],
    ['psd', 'Photoshop', ['psd']],
    ['exr', 'OpenEXR', ['exr']],
    ['hdr', 'Radiance HDR', ['hdr', 'rgbe']],
    ['dicom', 'DICOM', ['dcm', 'dicom']],
    ['nifti', 'NIfTI', ['nii', 'nii.gz']],
    ['nrrd', 'NRRD', ['nrrd', 'nhdr']],
  ].map(([id, label, extensions]) => ({
    id: id as string,
    label: label as string,
    extensions: extensions as string[],
    mime: 'application/octet-stream',
    kind: 'image' as const,
  })),
  ...[
    ['7z', '7-Zip', ['7z', 'cb7']],
    ['rar', 'RAR', ['rar', 'cbr']],
    ['xz', 'XZ', ['xz', 'txz']],
    ['bz2', 'Bzip2', ['bz2', 'bzip2', 'tbz', 'tbz2']],
    ['zst', 'Zstandard', ['zst', 'zstd', 'tzst']],
    ['iso', 'ISO', ['iso']],
    ['cab', 'CAB', ['cab']],
  ].map(([id, label, extensions]) => ({
    id: id as string,
    label: label as string,
    extensions: extensions as string[],
    mime: 'application/octet-stream',
    kind: 'container' as const,
  })),
  ...['usd', 'usda', 'usdc', 'usdz', 'urdf', 'mjcf', 'dae'].map((id) => ({
    id,
    label: id.toUpperCase(),
    extensions: [id],
    mime: 'application/octet-stream',
    kind: 'model' as const,
  })),
  { id: 'sdf', label: 'SDF', extensions: ['sdf', 'world'], mime: 'application/xml', kind: 'model' },
  ...[
    ['hdf5', ['h5', 'hdf5']],
    ['bag', ['bag']],
    ['e57', ['e57']],
  ].map(([id, extensions]) => ({
    id: id as string,
    label: String(id).toUpperCase(),
    extensions: extensions as string[],
    mime: 'application/octet-stream',
    kind: 'text' as const,
  })),
  {
    id: 'step',
    label: 'STEP',
    extensions: ['step', 'stp'],
    mime: 'application/octet-stream',
    kind: 'model',
  },
  {
    id: 'iges',
    label: 'IGES',
    extensions: ['iges', 'igs'],
    mime: 'application/octet-stream',
    kind: 'model',
  },
  {
    id: 'netcdf',
    label: 'NetCDF',
    extensions: ['nc', 'netcdf'],
    mime: 'application/octet-stream',
    kind: 'text',
  },
  {
    id: 'npy',
    label: 'NumPy array',
    extensions: ['npy'],
    mime: 'application/octet-stream',
    kind: 'text',
  },
  {
    id: 'zip',
    label: 'ZIP',
    extensions: ['zip', 'apk', 'cbz', 'ear', 'epub', 'ipa', 'jar', 'kmz', 'war', 'whl'],
    mime: 'application/zip',
    kind: 'container',
  },
  {
    id: 'gz',
    label: 'GZIP',
    extensions: ['gz', 'gzip', 'tgz'],
    mime: 'application/gzip',
    kind: 'container',
  },
  ...['tar', 'npz'].map((id) => ({
    id,
    label: id.toUpperCase(),
    extensions: [id],
    mime: 'application/octet-stream',
    kind: 'container' as const,
  })),
  ...['stl', 'glb', 'obj', 'ply', 'pcd', 'vtk', 'las', 'laz', 'vtu', 'vtp'].map((id) => ({
    id,
    label: id.toUpperCase(),
    extensions: [id],
    mime: id === 'glb' ? 'model/gltf-binary' : 'application/octet-stream',
    kind: 'model' as const,
  })),
  { id: 'gltf', label: 'glTF', extensions: ['gltf'], mime: 'model/gltf+json', kind: 'model' },
  ...[
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['svg', 'image/svg+xml'],
    ['avif', 'image/avif'],
  ].map(([id, mime]) => ({
    id,
    label: id.toUpperCase(),
    extensions: [id],
    mime,
    kind: 'image' as const,
  })),
  { id: 'mp4', label: 'MP4', extensions: ['mp4'], mime: 'video/mp4', kind: 'video' },
  { id: 'webm', label: 'WebM', extensions: ['webm'], mime: 'video/webm', kind: 'video' },
  {
    id: 'mov',
    label: 'QuickTime',
    extensions: ['mov', 'qt'],
    mime: 'video/quicktime',
    kind: 'video',
  },
  { id: 'm4v', label: 'M4V', extensions: ['m4v'], mime: 'video/mp4', kind: 'video' },
  { id: 'mkv', label: 'Matroska', extensions: ['mkv'], mime: 'video/x-matroska', kind: 'video' },
  { id: '3gp', label: '3GP', extensions: ['3gp'], mime: 'video/3gpp', kind: 'video' },
  { id: '3g2', label: '3G2', extensions: ['3g2'], mime: 'video/3gpp2', kind: 'video' },
  { id: 'avi', label: 'AVI', extensions: ['avi'], mime: 'video/x-msvideo', kind: 'video' },
  {
    id: 'mpeg',
    label: 'MPEG',
    extensions: ['mpg', 'mpeg', 'mpe', 'm2v'],
    mime: 'video/mpeg',
    kind: 'video',
  },
  { id: 'wmv', label: 'WMV', extensions: ['wmv', 'asf'], mime: 'video/x-ms-wmv', kind: 'video' },
  ...[
    ['mp3', 'audio/mpeg'],
    ['wav', 'audio/wav'],
    ['ogg', 'audio/ogg'],
  ].map(([id, mime]) => ({
    id,
    label: id.toUpperCase(),
    extensions: [id],
    mime,
    kind: 'audio' as const,
  })),
  { id: 'weba', label: 'WebM audio', extensions: ['weba'], mime: 'audio/webm', kind: 'audio' },
  { id: 'flac', label: 'FLAC', extensions: ['flac'], mime: 'audio/flac', kind: 'audio' },
  {
    id: 'aiff',
    label: 'AIFF',
    extensions: ['aiff', 'aif', 'aifc'],
    mime: 'audio/aiff',
    kind: 'audio',
  },
  {
    id: 'mka',
    label: 'Matroska audio',
    extensions: ['mka'],
    mime: 'audio/x-matroska',
    kind: 'audio',
  },
  {
    id: 'mcap',
    label: 'MCAP',
    extensions: ['mcap'],
    mime: 'application/octet-stream',
    kind: 'mcap',
  },
  {
    id: 'text',
    label: 'Text',
    extensions: [
      'txt',
      'md',
      'json',
      'jsonl',
      'csv',
      'yaml',
      'yml',
      'xml',
      'ts',
      'tsx',
      'js',
      'py',
      'rs',
      'c',
      'cpp',
      'h',
      'log',
      'toml',
    ],
    mime: 'text/plain',
    kind: 'text',
  },
];
export const unknown: Format = {
  id: 'unknown',
  label: 'Binary',
  extensions: [],
  mime: 'application/octet-stream',
  kind: 'unknown',
};

function isPlainText(bytes: Uint8Array): boolean {
  try {
    // The prefix can end in the middle of a UTF-8 code point.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return Boolean(text) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text);
  } catch {
    return false;
  }
}

export function detectFormat(name: string, bytes: Uint8Array, mime?: string): Format {
  const has = (...signature: number[]) => signature.every((v, i) => bytes[i] === v);
  const byId = (id: string) => formats.find((f) => f.id === id)!;
  if (has(0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a)) return byId('mcap');
  if (has(0x67, 0x6c, 0x54, 0x46)) return byId('glb');
  if (has(0x89, 0x50, 0x4e, 0x47)) return byId('png');
  if (has(0xff, 0xd8, 0xff)) return byId('jpg');
  if (has(0x47, 0x49, 0x46, 0x38)) return byId('gif');
  if (has(0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43)) return byId('usdc');
  if (has(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return byId('7z');
  if (has(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return byId('rar');
  if (has(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return byId('xz');
  if (has(0x42, 0x5a, 0x68) && bytes[3] >= 0x31 && bytes[3] <= 0x39) return byId('bz2');
  if (has(0x28, 0xb5, 0x2f, 0xfd)) return byId('zst');
  if (has(0x4d, 0x53, 0x43, 0x46)) return byId('cab');
  if (has(0x50, 0x41, 0x52, 0x31)) return byId('parquet');
  if (has(0x47, 0x47, 0x55, 0x46)) return byId('gguf');
  if (has(0x38, 0x42, 0x50, 0x53)) return byId('psd');
  if (has(0x76, 0x2f, 0x31, 0x01)) return byId('exr');
  if (bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d)
    return byId('dicom');
  const prefix = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  if (prefix.startsWith('SQLite format 3\0')) return byId('sqlite');
  if (/\.nii\.gz$/i.test(name)) return byId('nifti');
  if (prefix.startsWith('#usda')) return byId('usda');
  const xmlPrefix = prefix
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .trimStart();
  if (/^<mujoco(?:\s|>)/i.test(xmlPrefix)) return byId('mjcf');
  if (/^<robot(?:\s|>)/i.test(xmlPrefix)) return byId('urdf');
  if (/^<sdf(?:\s|>)/i.test(xmlPrefix)) return byId('sdf');
  if (/^<COLLADA(?:\s|>)/i.test(xmlPrefix)) return byId('dae');
  const filename = name.split(/[\\/]/).at(-1) ?? '';
  const ext = filename.includes('.') ? filename.split('.').at(-1)?.toLowerCase() : undefined;
  const known =
    formats.find((f) => ext && ext !== 'db' && f.extensions.includes(ext)) ??
    (mime && mime !== 'application/octet-stream'
      ? formats.find((f) => f.mime === mime)
      : undefined);
  if (known) return known;
  if (has(0x50, 0x4b, 0x03, 0x04) || has(0x50, 0x4b, 0x05, 0x06)) return byId('zip');
  if (has(0x1f, 0x8b, 0x08)) return byId('gz');
  return isPlainText(bytes) ? byId('text') : unknown;
}
