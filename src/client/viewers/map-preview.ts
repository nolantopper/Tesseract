import { kml } from '@tmcw/togeojson';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Feature, Geometry } from 'geojson';
import type { MapFeature, MapPoint, MapPreview } from './structured';
import { replaceJsonProperty } from './json-edits';

const text = new TextDecoder('utf-8', { fatal: true });
const featureLimit = 2000;
const pointLimit = 100_000;
const fileLimit = 16 * 1024 * 1024;
const featureNameKeys = ['name', 'Name', 'NAME', 'title'];

function parseKml(source: string, strict = false) {
  if (/<!DOCTYPE/i.test(source)) throw new Error('KML document types are unsupported.');
  const root = new DOMParser({
    onError: (level) => {
      if (strict || level !== 'warning') throw new Error('Invalid KML file.');
    },
  }).parseFromString(source, 'text/xml');
  if (root.documentElement?.localName !== 'kml') throw new Error('Invalid KML file.');
  return root;
}

export async function mapPreview(
  bytes: ArrayBuffer,
  format: string,
  readCompanion: (extension: string) => Promise<ArrayBuffer | undefined>,
): Promise<MapPreview> {
  let document: unknown;
  if (format === 'kml') {
    const root = parseKml(text.decode(bytes));
    document = kml(root);
    const map = normalizeMap(document);
    const placemarks = root.getElementsByTagName('Placemark').length;
    for (const feature of map.features)
      if (Number(feature.id.slice(8)) < placemarks) feature.canRename = true;
    return map;
  } else if (format === 'shp') {
    const { parseShp, parseDbf, combine } = await import('shpjs');
    const [prj, dbf, cpg] = await Promise.all(['prj', 'dbf', 'cpg'].map(readCompanion));
    const geometries = parseShp(bytes, prj && text.decode(prj));
    const properties = dbf ? parseDbf(dbf, cpg ?? new ArrayBuffer(0)) : [];
    document = combine([geometries, properties]);
  } else {
    document = JSON.parse(text.decode(bytes));
  }
  const map = normalizeMap(document);
  if (format === 'geojson' && (document as { type: string }).type.match(/^Feature(Collection)?$/))
    for (const feature of map.features) feature.canRename = true;
  return map;
}

export function renameMapFeature(bytes: ArrayBuffer, format: string, id: string, name: string) {
  if (!name.trim() || name.length > 200) throw new Error('Enter a name up to 200 characters.');
  const match = /^feature-(\d+)$/.exec(id);
  if (!match) throw new Error('Invalid map feature.');
  const index = Number(match[1]);
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const value = source.slice(bom.length);
  if (format === 'geojson') {
    const document = JSON.parse(value) as { type: string; features?: Feature[] };
    const path = document.type === 'FeatureCollection' ? ['features', index] : [];
    const feature = document.type === 'FeatureCollection' ? document.features?.[index] : document;
    if (feature?.type !== 'Feature' || (!path.length && index !== 0))
      throw new Error('The feature no longer exists.');
    const properties = (feature as Feature).properties;
    const next =
      properties == null
        ? replaceJsonProperty(value, path, 'properties', { name })
        : replaceJsonProperty(
            value,
            [...path, 'properties'],
            featureNameKeys.find(
              (key) => Object.hasOwn(properties, key) && properties[key] != null,
            ) ?? 'name',
            name,
          );
    return new TextEncoder().encode(bom + next);
  }
  if (format === 'kml') {
    const encoding = /^<\?xml\s+[^?>]*\bencoding\s*=\s*['"]([^'"]+)['"]/i.exec(value)?.[1];
    if (encoding && encoding.toLowerCase() !== 'utf-8')
      throw new Error('Only UTF-8 KML files can be edited.');
    const document = parseKml(value, true);
    // togeojson's default order begins with all Placemarks, including those without geometry.
    const placemark = document.getElementsByTagName('Placemark').item(index);
    if (!placemark) throw new Error('Choose a KML placemark.');
    const existing = placemark.getElementsByTagName('name').item(0);
    if (existing && existing.parentNode !== placemark)
      throw new Error('This placemark does not have a direct name.');
    const title = existing ?? document.createElementNS(placemark.namespaceURI, 'name');
    if (!existing) placemark.insertBefore(title, placemark.firstChild);
    title.textContent = name;
    if (kml(document).features[index]?.properties?.name !== name)
      throw new Error('An extended property overrides this placemark name.');
    return new TextEncoder().encode(bom + new XMLSerializer().serializeToString(document));
  }
  throw new Error('This map format cannot rename features in place.');
}

export function normalizeMap(document: unknown): MapPreview {
  if (!document || typeof document !== 'object' || !('type' in document))
    throw new Error('Invalid map data.');
  const raw = document as { type: string; features?: unknown[] };
  const inputs =
    raw.type === 'FeatureCollection'
      ? raw.features
      : [raw.type === 'Feature' ? raw : { type: 'Feature', geometry: raw }];
  if (!Array.isArray(inputs)) throw new Error('Invalid feature collection.');
  const bounds: MapPreview['bounds'] = [Infinity, Infinity, -Infinity, -Infinity];
  const features: MapFeature[] = [];
  let pointCount = 0;
  const position = (value: unknown): MapPoint => {
    if (!Array.isArray(value) || !Number.isFinite(value[0]) || !Number.isFinite(value[1]))
      throw new Error('Invalid map coordinates.');
    const [lon, lat] = value as number[];
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90)
      throw new Error('Coordinates require WGS84. For Shapefiles, include the .prj file.');
    if (++pointCount > pointLimit) throw new Error('Map exceeds 100,000 positions.');
    const radians = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
    const y = (Math.asinh(Math.tan(radians)) * 180) / Math.PI;
    bounds[0] = Math.min(bounds[0], lon);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], lon);
    bounds[3] = Math.max(bounds[3], y);
    return [lon, y];
  };
  const line = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error('Invalid map line.');
    return value.map(position);
  };
  const geometry = (value: Geometry, feature: MapFeature, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12) throw new Error('Invalid map geometry.');
    switch (value.type) {
      case 'Point':
        feature.points.push(position(value.coordinates));
        break;
      case 'MultiPoint':
        for (const point of line(value.coordinates)) feature.points.push(point);
        break;
      case 'LineString':
        feature.lines.push(line(value.coordinates));
        break;
      case 'MultiLineString':
        for (const coordinates of value.coordinates) feature.lines.push(line(coordinates));
        break;
      case 'Polygon':
        feature.polygons.push(value.coordinates.map(line));
        break;
      case 'MultiPolygon':
        for (const polygon of value.coordinates) feature.polygons.push(polygon.map(line));
        break;
      case 'GeometryCollection':
        if (!Array.isArray(value.geometries) || value.geometries.length > featureLimit)
          throw new Error('Invalid geometry collection.');
        for (const child of value.geometries) geometry(child, feature, depth + 1);
        break;
      default:
        throw new Error('Unsupported map geometry.');
    }
  };

  for (let index = 0; index < Math.min(inputs.length, featureLimit); index++) {
    const source = inputs[index] as Feature;
    if (source?.type !== 'Feature') throw new Error('Invalid map feature.');
    if (source.geometry == null) continue;
    const properties = source.properties ?? {};
    const name =
      properties.name ?? properties.Name ?? properties.NAME ?? properties.title ?? source.id;
    const label = (
      typeof name === 'string' || typeof name === 'number' ? String(name) : `Feature ${index + 1}`
    ).slice(0, 200);
    // Share properties as inert text, without retaining style URLs or an entire geometry.
    const propertySummary = Object.entries(properties)
      .slice(0, 24)
      .map(([key, value]) => [
        key.slice(0, 120),
        typeof value === 'string'
          ? value.slice(0, 300)
          : value == null || typeof value !== 'object'
            ? value
            : '…',
      ]);
    const details = JSON.stringify({
      featureId: source.id,
      geometry: source.geometry.type,
      properties: propertySummary,
    }).slice(0, 3900);
    const feature: MapFeature = {
      id: `feature-${index}`,
      label,
      details,
      points: [],
      lines: [],
      polygons: [],
    };
    geometry(source.geometry, feature);
    features.push(feature);
  }
  if (!pointCount) throw new Error('No map geometry.');
  return {
    features,
    bounds,
    note: inputs.length > featureLimit ? `First ${featureLimit} features` : undefined,
  };
}

export const mapFileLimit = fileLimit;
