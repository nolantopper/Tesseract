import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { ViewerProps } from '../../shared/types';
import { Icon } from '../Icon';
import { canSaveHostFile, readBytes, saveHostFile } from '../backend';
import { mapFileLimit, renameMapFeature } from './map-preview';
import EditValue from './EditValue';
import { useStructuredPreview } from './use-structured-preview';
import type { MapFeature, MapPoint, MapPreview } from './structured';
import './structured.css';

const fitted = { scale: 1, x: 0, y: 0 };
type Shape = { feature: MapFeature; stroke: Path2D; area: Path2D; markers: Path2D };

export default function MapViewer({ artifact, readAsset, onShareItem, sharedItemId }: ViewerProps) {
  const { data, error } = useStructuredPreview<MapPreview>(artifact, readAsset);
  const canvas = useRef<HTMLCanvasElement>(null);
  const shapes = useRef<Shape[]>([]);
  const drag = useRef<{ x: number; y: number; moved: boolean }>(undefined);
  const [view, setView] = useState(fitted);
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState('');
  const feature = data?.features.find(({ id }) => id === selected);
  const zoom = (factor: number) => {
    setView((prev) => ({ ...prev, scale: Math.min(50, Math.max(0.2, prev.scale * factor)) }));
  };

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx || !data) return;
    const paint = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      const pixelRatio = Math.min(2, window.devicePixelRatio);
      const scaledWidth = Math.max(1, Math.round(width * pixelRatio));
      const scaledHeight = Math.max(1, Math.round(height * pixelRatio));
      if (element.width !== scaledWidth || element.height !== scaledHeight) {
        element.width = scaledWidth;
        element.height = scaledHeight;
      }
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      const styles = getComputedStyle(element);
      const accent = styles.getPropertyValue('--accent').trim();
      ctx.fillStyle = styles.getPropertyValue('--panel').trim();
      ctx.fillRect(0, 0, width, height);
      const [left, bottom, right, top] = data.bounds;
      const scale =
        view.scale *
        Math.min(
          Math.max(1, width - 36) / Math.max(1e-7, right - left),
          Math.max(1, height - 36) / Math.max(1e-7, top - bottom),
        );
      const project = ([x, y]: MapPoint): MapPoint => [
        (x - (left + right) / 2) * scale + width / 2 + view.x,
        ((bottom + top) / 2 - y) * scale + height / 2 + view.y,
      ];
      const trace = (path: Path2D, points: MapPoint[]) => {
        if (!points.length) return;
        path.moveTo(...project(points[0]));
        for (let i = 1; i < points.length; i++) path.lineTo(...project(points[i]));
      };
      const projected = data.features.map((feature) => {
        const stroke = new Path2D();
        const area = new Path2D();
        const markers = new Path2D();
        for (const line of feature.lines) trace(stroke, line);
        for (const polygon of feature.polygons)
          for (const ring of polygon) {
            trace(area, ring);
            area.closePath();
          }
        for (const position of feature.points) {
          const [x, y] = project(position);
          markers.moveTo(x + 4, y);
          markers.arc(x, y, 4, 0, 2 * Math.PI);
        }
        return { feature, stroke, area, markers };
      });
      shapes.current = projected;
      ctx.strokeStyle = accent;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const shape of projected) paintShape(shape);
      for (const shape of projected) {
        if (shape.feature.id === selected || shape.feature.id === sharedItemId)
          paintShape(shape, true);
      }
      function paintShape(shape: Shape, highlight = false) {
        const { area, markers, stroke } = shape;
        ctx!.fillStyle = accent;
        ctx!.globalAlpha = highlight ? 0.25 : 0.07;
        ctx!.fill(area, 'evenodd');
        ctx!.globalAlpha = highlight ? 1 : 0.5;
        ctx!.fill(markers);
        ctx!.lineWidth = highlight ? 3 : 1;
        ctx!.stroke(stroke);
        ctx!.stroke(area);
        if (highlight) ctx!.stroke(markers);
        ctx!.globalAlpha = 1;
      }
    };
    const resize = new ResizeObserver(paint);
    const theme = new MutationObserver(paint);
    resize.observe(element);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme'],
    });
    paint();
    return () => {
      resize.disconnect();
      theme.disconnect();
    };
  }, [data, selected, sharedItemId, view]);

  if (!data)
    return (
      <div className="empty" role={error ? 'alert' : 'status'}>
        {error || 'Loading map…'}
      </div>
    );

  const pick = (event: MouseEvent<HTMLCanvasElement>) => {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const x = ((event.clientX - rect.left) * element.width) / rect.width;
    const y = ((event.clientY - rect.top) * element.height) / rect.height;
    ctx.save();
    ctx.lineWidth = 10;
    let match: MapFeature | undefined;
    for (let i = shapes.current.length - 1; i >= 0; i--) {
      const { area, stroke, markers, feature } = shapes.current[i];
      if (
        ctx.isPointInPath(area, x, y, 'evenodd') ||
        ctx.isPointInStroke(area, x, y) ||
        ctx.isPointInStroke(stroke, x, y) ||
        ctx.isPointInStroke(markers, x, y) ||
        ctx.isPointInPath(markers, x, y)
      ) {
        match = feature;
        break;
      }
    }
    ctx.restore();
    return match;
  };
  const pan = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    if (Math.hypot(dx, dy) < 4 && !drag.current.moved) return;
    drag.current = { x: event.clientX, y: event.clientY, moved: true };
    setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  };
  const share = (item: MapFeature) => {
    setSelected(item.id);
    requestAnimationFrame(() => {
      const source = canvas.current;
      if (!source) return;
      const thumbnail = document.createElement('canvas');
      const scale = Math.min(1, 640 / Math.max(source.width, source.height));
      thumbnail.width = Math.max(1, Math.round(source.width * scale));
      thumbnail.height = Math.max(1, Math.round(source.height * scale));
      thumbnail.getContext('2d')?.drawImage(source, 0, 0, thumbnail.width, thumbnail.height);
      const image = thumbnail.toDataURL('image/jpeg', 0.82).split(',')[1];
      onShareItem?.({ id: item.id, label: item.label, details: item.details }, image);
    });
  };

  return (
    <div className="structured-view map-view" onDoubleClick={(event) => event.stopPropagation()}>
      <div className="map-stage">
        <canvas
          ref={canvas}
          aria-label="Map preview"
          aria-keyshortcuts="Enter"
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, moved: false };
          }}
          onPointerMove={pan}
          onPointerCancel={() => {
            drag.current = undefined;
          }}
          onClick={(event) => {
            if (!drag.current?.moved) setSelected(pick(event)?.id ?? '');
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            const item = pick(event);
            if (item && !drag.current?.moved) share(item);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && feature) {
              event.preventDefault();
              share(feature);
              return;
            }
            const direction: Record<string, MapPoint> = {
              ArrowLeft: [30, 0],
              ArrowRight: [-30, 0],
              ArrowUp: [0, 30],
              ArrowDown: [0, -30],
            };
            const delta = direction[event.key];
            if (delta) {
              event.preventDefault();
              setView((prev) => ({ ...prev, x: prev.x + delta[0], y: prev.y + delta[1] }));
            }
          }}
        />
        <div className="map-controls" role="group" aria-label="Map controls">
          <button
            className="icon-button"
            title="Zoom out"
            aria-label="Zoom out"
            onClick={() => zoom(0.8)}
          >
            <Icon name="minus" />
          </button>
          <button
            className="icon-button"
            title="Fit map"
            aria-label="Fit map"
            onClick={() => setView(fitted)}
          >
            <Icon name="fit" />
          </button>
          <button
            className="icon-button"
            title="Zoom in"
            aria-label="Zoom in"
            onClick={() => zoom(1.25)}
          >
            <Icon name="plus" />
          </button>
        </div>
      </div>
      <div className="structured-controls">
        <select
          aria-label="Map feature"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Features · {data.features.length}</option>
          {data.features.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        {feature?.canRename && canSaveHostFile(artifact) && editing !== feature.id && (
          <button
            type="button"
            className="icon-button"
            title="Rename feature"
            aria-label="Rename feature"
            onClick={() => setEditing(feature.id)}
          >
            <Icon name="edit" />
          </button>
        )}
      </div>
      {feature && editing === feature.id && (
        <EditValue
          key={feature.id}
          label="Feature name"
          value={feature.label}
          onClose={() => setEditing('')}
          onSave={async (name) => {
            const bytes = await readBytes(artifact, mapFileLimit);
            await saveHostFile(
              artifact,
              renameMapFeature(bytes, artifact.format.id, feature.id, name),
            );
          }}
        />
      )}
      {feature && (
        <details>
          <summary>Properties</summary>
          <pre className="raw-preview">{feature.details}</pre>
        </details>
      )}
      {data.note && <div className="preview-note">{data.note}</div>}
    </div>
  );
}
