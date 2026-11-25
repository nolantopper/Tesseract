import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import DxfParser from 'dxf-parser';
import type {
  I3DfaceEntity,
  IArcEntity,
  ICircleEntity,
  IEllipseEntity,
  IEntity,
  IInsertEntity,
  ILineEntity,
  ILwpolylineEntity,
  IPoint,
  IPointEntity,
  IPolylineEntity,
} from 'dxf-parser';

const vector = (p: IPoint) => new Vector3(p.x, p.y, p.z ?? 0);

function arcPoints(center: Vector3, u: Vector3, v: Vector3, start: number, sweep: number) {
  const segments = Math.max(1, Math.min(96, Math.ceil(Math.abs(sweep) / (Math.PI / 32))));
  return Array.from({ length: segments + 1 }, (_, i) => {
    const angle = start + (i * sweep) / segments;
    return center.clone().addScaledVector(u, Math.cos(angle)).addScaledVector(v, Math.sin(angle));
  });
}

function polylineSegments(
  entity: ILwpolylineEntity | IPolylineEntity,
  add: (start: Vector3, end: Vector3) => void,
) {
  const { vertices, shape } = entity;
  const elevation = 'elevation' in entity ? (entity.elevation ?? 0) : 0;
  for (let i = 0; i < vertices.length - (shape ? 0 : 1); i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const p = new Vector3(a.x, a.y, a.z ?? elevation);
    const q = new Vector3(b.x, b.y, b.z ?? elevation);
    const bulge = a.bulge;
    const chord = q.clone().sub(p);
    const length = Math.hypot(chord.x, chord.y);
    if (!bulge || Math.abs(bulge) < 1e-6 || !length) {
      add(p, q);
      continue;
    }
    const sweep = 4 * Math.atan(bulge);
    const center = p
      .clone()
      .lerp(q, 0.5)
      .addScaledVector(new Vector3(-chord.y, chord.x, 0), (1 - bulge * bulge) / (4 * bulge));
    const u = p.clone().sub(center);
    const v = new Vector3(-u.y, u.x, 0);
    const arc = arcPoints(center, u, v, 0, sweep);
    for (let j = 1; j < arc.length; j++) add(arc[j - 1], arc[j]);
  }
}

export function parseDxf(data: ArrayBuffer, root: Group, warnings: string[]) {
  if (data.byteLength > 8 * 1024 * 1024) throw new Error('DXF exceeds the 8 MiB preview limit.');
  const source = new TextDecoder().decode(data);
  if (source.startsWith('AutoCAD Binary DXF'))
    throw new Error('Binary DXF is unsupported. Export as ASCII DXF.');
  const drawing = new DxfParser().parseSync(source);
  if (!drawing) throw new Error('Invalid DXF drawing.');
  const layers = drawing.tables?.layer?.layers;
  const blocks = drawing.blocks;
  const omitted = new Set<string>();
  type Layer = { name: string; color: number; lines: number[]; points: number[]; faces: number[] };
  const parts = new Map<string, Layer>();
  let entities = 0;
  let vertices = 0;
  function draw(entity: IEntity, matrix: Matrix4, depth: number, parentLayer?: string) {
    if (++entities > 100_000 || depth > 24)
      throw new Error('DXF block expansion exceeds the preview limit.');
    if (entity.visible === false || entity.inPaperSpace) return;
    const layerName = entity.layer === '0' && parentLayer ? parentLayer : entity.layer || '0';
    const layer = layers && Object.hasOwn(layers, layerName) ? layers[layerName] : undefined;
    if (layer?.visible === false || layer?.frozen) return;
    if (entity.type === 'INSERT') {
      const insert = entity as IInsertEntity;
      const block = blocks && Object.hasOwn(blocks, insert.name) ? blocks[insert.name] : undefined;
      if (!block?.entities || !insert.position) {
        omitted.add('external or missing blocks');
        return;
      }
      const rows = insert.rowCount || 1;
      const columns = insert.columnCount || 1;
      if (rows * columns > 1000) throw new Error('DXF block array exceeds the preview limit.');
      const position = vector(insert.position);
      const offset = block.position ? vector(block.position).negate() : new Vector3();
      const transform = matrix
        .clone()
        .multiply(new Matrix4().makeTranslation(position))
        .multiply(new Matrix4().makeRotationZ(((insert.rotation ?? 0) * Math.PI) / 180));
      const scale = new Matrix4().makeScale(
        insert.xScale ?? 1,
        insert.yScale ?? 1,
        insert.zScale ?? 1,
      );
      for (let row = 0; row < rows; row++)
        for (let column = 0; column < columns; column++) {
          const instance = transform
            .clone()
            .multiply(
              new Matrix4().makeTranslation(
                column * (insert.columnSpacing || 0),
                row * (insert.rowSpacing || 0),
                0,
              ),
            )
            .multiply(scale)
            .multiply(new Matrix4().makeTranslation(offset));
          for (const child of block.entities) draw(child, instance, depth + 1, layerName);
        }
      return;
    }
    const color = entity.color ?? layer?.color ?? 0x94a8bb;
    const key = JSON.stringify([layerName, color]);
    const part = parts.get(key) ?? { name: layerName, color, lines: [], points: [], faces: [] };
    const add = (array: number[], ...points: Vector3[]) => {
      vertices += points.length;
      if (vertices > 1_000_000) throw new Error('DXF geometry exceeds the 1 million vertex limit.');
      if (!parts.has(key)) {
        if (parts.size >= 1000) throw new Error('DXF layers exceed the preview limit.');
        parts.set(key, part);
      }
      for (const point of points) array.push(...point.clone().applyMatrix4(matrix).toArray());
    };
    const segment = (a: Vector3, b: Vector3) => add(part.lines, a, b);
    switch (entity.type) {
      case 'LINE': {
        const points = (entity as ILineEntity).vertices;
        if (points.length === 2) segment(vector(points[0]), vector(points[1]));
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE':
        polylineSegments(entity as ILwpolylineEntity | IPolylineEntity, segment);
        break;
      case 'ARC':
      case 'CIRCLE': {
        const arc = entity as IArcEntity | ICircleEntity;
        const r = arc.radius;
        const start = arc.startAngle ?? 0;
        const sweep =
          entity.type === 'CIRCLE' ? 2 * Math.PI : (arc.angleLength + 2 * Math.PI) % (2 * Math.PI);
        const points = arcPoints(
          vector(arc.center),
          new Vector3(r, 0, 0),
          new Vector3(0, r, 0),
          start,
          sweep,
        );
        for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
        break;
      }
      case 'ELLIPSE': {
        const ellipse = entity as IEllipseEntity;
        const axis = vector(ellipse.majorAxisEndPoint);
        const minor = new Vector3(-axis.y, axis.x, 0).multiplyScalar(ellipse.axisRatio);
        const points = arcPoints(
          vector(ellipse.center),
          axis,
          minor,
          ellipse.startAngle,
          ellipse.endAngle - ellipse.startAngle,
        );
        for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
        break;
      }
      case 'POINT':
        add(part.points, vector((entity as IPointEntity).position));
        break;
      case '3DFACE': {
        const p = (entity as I3DfaceEntity).vertices.map(vector);
        if (p.length >= 3) add(part.faces, p[0], p[1], p[2]);
        if (p.length === 4) add(part.faces, p[0], p[2], p[3]);
        break;
      }
      default:
        omitted.add(entity.type);
    }
  }
  const identity = new Matrix4();
  for (const entity of drawing.entities ?? []) draw(entity, identity, 0);
  for (const part of parts.values()) {
    const geometry = (values: number[]) =>
      new BufferGeometry().setAttribute('position', new Float32BufferAttribute(values, 3));
    const color = part.color === 0 || part.color === 0xffffff ? 0x94a8bb : part.color;
    if (part.lines.length) {
      const lines = new LineSegments(geometry(part.lines), new LineBasicMaterial({ color }));
      lines.name = part.name;
      root.add(lines);
    }
    if (part.points.length) {
      const points = new Points(geometry(part.points), new PointsMaterial({ color }));
      points.name = part.name;
      root.add(points);
    }
    if (part.faces.length) {
      const faces = new Mesh(geometry(part.faces), new MeshBasicMaterial({ color }));
      faces.name = part.name;
      root.add(faces);
    }
  }
  if (omitted.size) warnings.push(`DXF preview omits ${[...omitted].slice(0, 8).join(', ')}.`);
}
