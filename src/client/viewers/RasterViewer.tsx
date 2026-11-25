import { useEffect, useRef, useState } from 'react';
import type { ViewerProps } from '../../shared/types';
import {
  canSaveHostFile,
  embeddedParserWorker,
  readAsset as readWorkspaceAsset,
  readBytes,
  saveHostFile,
} from '../backend';
import { Icon } from '../Icon';
import { orientImage, rotateTiff, turnOrientation } from './image-orientation';
import {
  labelFor,
  nrrdDataFile,
  rasterInputLimit,
  type RasterChoice,
  type RasterFrame,
  type RasterGroup,
  type RasterRequest,
  type RasterResponse,
} from './raster';
import rasterWorkerUrl from './raster.worker?worker&url';
import './raster.css';

type RasterEdit =
  | { kind: 'rotate'; page: number }
  | { kind: 'invert' }
  | { kind: 'darken' }
  | { kind: 'window'; range: [number, number] };

const editLabels = {
  rotate: 'Rotate right',
  invert: 'Invert grayscale',
  darken: 'Darken',
  window: 'Increase contrast',
};

export default function RasterViewer({
  artifact,
  readAsset,
  onShareItem,
  sharedItemId,
}: ViewerProps) {
  const [groups, setGroups] = useState<RasterGroup[]>([]);
  const [choice, setChoice] = useState<RasterChoice>({ group: 0, index: 0 });
  const [rendered, setRendered] = useState<{ frame: RasterFrame; choice: RasterChoice }>();
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<RasterEdit>();
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const write = useRef<AbortController>(null);
  const renderFrame = useRef<((choice: RasterChoice) => void) | null>(null);
  const group = groups[choice.group];
  const frame =
    rendered?.choice.group === choice.group && rendered.choice.index === choice.index
      ? rendered.frame
      : undefined;
  const label = group ? labelFor(group, choice.index) : 'Image preview';
  const id = `${artifact.format.id}:${choice.group}:${choice.index}`;
  const isVolume = artifact.format.id === 'nrrd' || artifact.format.id === 'nifti';
  const isMedical = artifact.format.id === 'dicom';
  const pendingWindow =
    draft?.kind === 'window' &&
    (rendered?.choice.window?.[0] !== draft.range[0] ||
      rendered.choice.window?.[1] !== draft.range[1]);
  const pendingDraft = pendingWindow || (draft?.kind === 'darken' && !rendered?.choice.darken);
  let availableEdit: RasterEdit | undefined;
  if (frame && canSaveHostFile(artifact)) {
    if (frame.canRotate) availableEdit = { kind: 'rotate', page: choice.group };
    else if (frame.canInvert) availableEdit = { kind: 'invert' };
    else if (frame.canDarken) availableEdit = { kind: 'darken' };
    else if (isVolume && frame.window && frame.window[0] < frame.window[1]) {
      const [min, max] = frame.window;
      const margin = (max - min) * 0.1;
      if (Number.isFinite(margin) && margin > 0)
        availableEdit = { kind: 'window', range: [min + margin, max - margin] };
    }
  }

  useEffect(() => () => write.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let worker: Worker | undefined;
    let sequence = 0;
    let timer: number;
    const stop = () => {
      controller.abort();
      clearTimeout(timer);
      worker?.terminate();
      renderFrame.current = null;
    };
    const fail = (message: string) => {
      stop();
      setError(message);
      setFailed(true);
    };
    const waitForFrame = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => fail('Image preview exceeded 20 seconds.'), 20_000);
    };
    setGroups([]);
    setRendered(undefined);
    setError('');
    setFailed(false);
    waitForFrame();

    void (async () => {
      const data = await readBytes(artifact, rasterInputLimit, false, signal);
      const path = artifact.format.id === 'nrrd' ? nrrdDataFile(new Uint8Array(data)) : undefined;
      const detached =
        path &&
        (await (readAsset ? readAsset(path, signal) : readWorkspaceAsset(artifact, path, signal)));
      if (detached && detached.byteLength + data.byteLength > rasterInputLimit)
        throw new Error('Image and its data exceed 64 MiB.');
      const parser = await embeddedParserWorker(rasterWorkerUrl, signal);
      if (signal.aborted) {
        parser.terminate();
        return;
      }
      worker = parser;
      const post = (message: RasterRequest, buffers?: ArrayBuffer[]) =>
        parser.postMessage(message, buffers ?? []);
      const request = (next: RasterChoice) => {
        setChoice(next);
        setError('');
        waitForFrame();
        post({ choice: next, sequence: ++sequence });
      };
      renderFrame.current = request;
      parser.onmessage = ({ data }: MessageEvent<RasterResponse>) => {
        if ('sequence' in data && data.sequence !== undefined && data.sequence !== sequence) return;
        clearTimeout(timer);
        if ('groups' in data) {
          setGroups(data.groups);
          request({ group: 0, index: data.groups[0]?.defaultIndex ?? 0 });
        } else if ('frame' in data) setRendered(data);
        else if (data.sequence === undefined) fail(data.error);
        else setError(data.error);
      };
      parser.onerror = () => fail('Image decoder unavailable.');
      post(
        { format: artifact.format.id, data, detached: detached || undefined },
        detached ? [data, detached] : [data],
      );
    })().catch((error) => {
      if (!signal.aborted) fail(error instanceof Error ? error.message : 'Couldn’t open image.');
    });
    return stop;
  }, [artifact, readAsset]);

  useEffect(() => {
    const node = canvas.current;
    if (!node || !frame) return;
    const { width, height, aspect } = frame;
    const orientation =
      draft?.kind === 'rotate' ? turnOrientation(frame.orientation ?? 1) : (frame.orientation ?? 1);
    const inverted = draft?.kind === 'invert';
    const scaledWidth =
      aspect && Number.isFinite(aspect)
        ? Math.min(8192, Math.max(1, Math.round(height * aspect)))
        : width;
    const scale = Math.min(1, 2048 / Math.max(scaledWidth, height));
    const displayWidth = Math.max(1, Math.round(scaledWidth * scale));
    const displayHeight = Math.max(1, Math.round(height * scale));
    const swapped = orientation >= 5;
    node.width = swapped ? displayHeight : displayWidth;
    node.height = swapped ? displayWidth : displayHeight;
    const context = node.getContext('2d');
    if (!context) return;
    const image = new ImageData(frame.data, width, height);
    if (orientation === 1 && !inverted && node.width === width && node.height === height)
      context.putImageData(image, 0, 0);
    else {
      const source = new OffscreenCanvas(width, height);
      source.getContext('2d')?.putImageData(image, 0, 0);
      if (inverted) context.filter = 'invert(1)';
      const scaleX = displayWidth / width;
      const scaleY = displayHeight / height;
      context.scale(swapped ? scaleY : scaleX, swapped ? scaleX : scaleY);
      orientImage(context, width, height, orientation);
      context.drawImage(source, 0, 0);
    }
  }, [frame, draft]);

  const beginEdit = (edit: RasterEdit) => {
    setDraft(edit);
    setEditError('');
    if (edit.kind === 'window') renderFrame.current?.({ ...choice, window: edit.range });
    if (edit.kind === 'darken') renderFrame.current?.({ ...choice, darken: true });
  };

  const discard = () => {
    if (draft?.kind === 'window' || draft?.kind === 'darken')
      renderFrame.current?.({ group: choice.group, index: choice.index });
    setDraft(undefined);
    setEditError('');
  };

  const save = async () => {
    if (!draft || write.current || pendingDraft) return;
    const controller = new AbortController();
    const { signal } = controller;
    write.current = controller;
    setSaving(true);
    setEditError('');
    try {
      const original = await readBytes(artifact, rasterInputLimit, false, signal);
      let bytes: Uint8Array;
      if (draft.kind === 'rotate') bytes = rotateTiff(new Uint8Array(original), draft.page, 1);
      else if (draft.kind === 'darken') {
        if (artifact.format.id === 'psd') {
          const { darkenPsd } = await import('./psd-edits');
          bytes = darkenPsd(original);
        } else {
          const { darkenImage } = await import('./exposure-edit');
          bytes = darkenImage(original, artifact.format.id === 'exr');
        }
      } else {
        const { invertDicom, saveVolumeWindow } = await import('./volume-data');
        bytes =
          draft.kind === 'invert'
            ? invertDicom(original)
            : saveVolumeWindow(original, artifact.format.id, draft.range);
      }
      await saveHostFile(artifact, bytes, signal);
    } catch (error) {
      if (!signal.aborted)
        setEditError(error instanceof Error ? error.message : 'Couldn’t save image.');
    } finally {
      write.current = null;
      if (!signal.aborted) setSaving(false);
    }
  };

  const share = () => {
    if (!frame || !onShareItem) return;
    let capture: string | undefined;
    const source = canvas.current;
    // DICOM pixels can contain burned-in identifiers even when no patient tags are shared.
    if (source && !isMedical) {
      const thumb = document.createElement('canvas');
      const scale = Math.min(1, 512 / Math.max(source.width, source.height));
      thumb.width = Math.max(1, Math.round(source.width * scale));
      thumb.height = Math.max(1, Math.round(source.height * scale));
      const context = thumb.getContext('2d');
      if (context) {
        context.fillStyle = '#292929';
        context.fillRect(0, 0, thumb.width, thumb.height);
        context.drawImage(source, 0, 0, thumb.width, thumb.height);
        capture = thumb.toDataURL('image/jpeg', 0.78).split(',')[1];
      }
    }
    const selection = groups.length > 1 ? `${group!.label} · ${label}` : label;
    onShareItem({ id, label: selection, details: frame.details }, capture);
  };

  const useSelector = !!group?.labels && group.count > 1;
  return (
    <div className="raster-view" onDoubleClick={(event) => event.stopPropagation()}>
      {!failed && (groups.length > 1 || useSelector) && (
        <div className="raster-selectors">
          {groups.length > 1 && (
            <select
              aria-label={isVolume ? 'Plane' : 'Page'}
              value={choice.group}
              disabled={!!draft}
              onChange={(event) => {
                const group = Number(event.target.value);
                renderFrame.current?.({ group, index: groups[group]?.defaultIndex ?? 0 });
              }}
            >
              {groups.map((item, index) => (
                <option key={index} value={index}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
          {useSelector && (
            <select
              aria-label={group.unit}
              value={choice.index}
              disabled={!!draft}
              onChange={(event) =>
                renderFrame.current?.({ group: choice.group, index: Number(event.target.value) })
              }
            >
              {group.labels!.slice(0, group.count).map((label, index) => (
                <option key={index} value={index}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div
        className="preview-stage media-stage raster-stage"
        data-shared={frame && sharedItemId === id ? 'true' : undefined}
      >
        {frame ? (
          <canvas
            ref={canvas}
            aria-label={`${label} preview`}
            aria-pressed={sharedItemId === id}
            role="button"
            tabIndex={0}
            title="Share with chat"
            onDoubleClick={share}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              if (!event.repeat) share();
            }}
          />
        ) : (
          <div className="empty" role={error ? 'alert' : 'status'}>
            {error || 'Loading image…'}
          </div>
        )}
      </div>
      {!failed && group && !useSelector && group.count > 1 && (
        <div className="raster-controls">
          <input
            aria-label={group.unit}
            type="range"
            min={1}
            max={group.count}
            value={choice.index + 1}
            disabled={!!draft}
            onChange={(event) =>
              renderFrame.current?.({ group: choice.group, index: Number(event.target.value) - 1 })
            }
          />
          <span className="preview-note">
            {choice.index + 1} / {group.count}
          </span>
        </div>
      )}
      {(availableEdit || draft) && (
        <div className="raster-edit-controls">
          {draft ? (
            <>
              <button
                type="button"
                className="icon-button"
                title="Save changes"
                aria-label="Save changes"
                disabled={saving || pendingDraft}
                onClick={() => void save()}
              >
                <Icon name="check" />
              </button>
              <button
                type="button"
                className="icon-button"
                title="Discard changes"
                aria-label="Discard changes"
                disabled={saving}
                onClick={discard}
              >
                <Icon name="close" />
              </button>
            </>
          ) : (
            availableEdit && (
              <button
                type="button"
                title={editLabels[availableEdit.kind]}
                onClick={() => beginEdit(availableEdit)}
              >
                {editLabels[availableEdit.kind]}
              </button>
            )
          )}
        </div>
      )}
      {editError && (
        <p className="preview-note" role="alert">
          {editError}
        </p>
      )}
      {frame?.details && (
        <details className="preview-note">
          <summary>Preview details</summary>
          <p>{frame.details}</p>
        </details>
      )}
    </div>
  );
}
