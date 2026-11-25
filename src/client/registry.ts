import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ViewerProps } from '../shared/types';
import { rasterIds } from '../shared/formats';

export interface ViewerModule {
  id: string;
  matches: (format: ViewerProps['artifact']['format']) => boolean;
  load: () => Promise<{ default: ComponentType<ViewerProps> }>;
}
const handlers: {
  module: ViewerModule;
  component: LazyExoticComponent<ComponentType<ViewerProps>>;
}[] = [];
export function registerViewer(module: ViewerModule) {
  handlers.unshift({ module, component: lazy(module.load) });
}
export function resolveViewer(format: ViewerProps['artifact']['format']) {
  return handlers.find((h) => h.module.matches(format))?.component;
}
registerViewer({ id: 'fallback', matches: () => true, load: () => import('./viewers/TextViewer') });
registerViewer({
  id: 'media',
  matches: (f) => ['image', 'audio', 'video'].includes(f.kind),
  load: () => import('./viewers/MediaViewer'),
});
registerViewer({
  id: 'model',
  matches: (f) => f.kind === 'model',
  load: () => import('./viewers/ModelViewer'),
});
registerViewer({
  id: 'mcap',
  matches: (f) => f.kind === 'mcap',
  load: () => import('./viewers/McapViewer'),
});

registerViewer({
  id: 'container',
  matches: (f) => f.kind === 'container',
  load: () => import('./viewers/ContainerViewer'),
});

registerViewer({
  id: 'array',
  matches: (f) => ['npy', 'netcdf', 'hdf5', 'bag', 'e57'].includes(f.id),
  load: () => import('./viewers/DataViewer'),
});
registerViewer({
  id: 'raster',
  matches: (f) => rasterIds.includes(f.id),
  load: () => import('./viewers/RasterViewer'),
});
registerViewer({
  id: 'table',
  matches: (f) => ['parquet', 'sqlite'].includes(f.id),
  load: () => import('./viewers/TableViewer'),
});
registerViewer({
  id: 'map',
  matches: (f) => ['geojson', 'kml', 'shp'].includes(f.id),
  load: () => import('./viewers/MapViewer'),
});
registerViewer({
  id: 'machine-model',
  matches: (f) => ['onnx', 'tflite', 'safetensors', 'gguf'].includes(f.id),
  load: () => import('./viewers/MachineModelViewer'),
});
