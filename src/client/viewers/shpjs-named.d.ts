declare module 'shpjs' {
  import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
  export function parseShp(shp: ArrayBuffer, prj?: string): Geometry[];
  export function parseDbf(dbf: ArrayBuffer, cpg?: ArrayBuffer): GeoJsonProperties[];
  export function combine(input: [Geometry[], GeoJsonProperties[]]): FeatureCollection;
}
