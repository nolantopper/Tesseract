import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ViewerProps } from '../../shared/types';
import { canSaveHostFile, convertedMediaUrl, mediaUrl, readBytes, saveHostFile } from '../backend';
import { Icon } from '../Icon';
import { canRotateImage, rotateImage, rotateWebp, slowGif, svgBackground } from './image-edits';
import { canTrimMedia, trimMedia } from './media-edits';
import './media-edit.css';

export default function MediaViewer({ artifact, onShareItem, sharedItemId }: ViewerProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [converting, setConverting] = useState(false);
  const [converted, setConverted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [trim, setTrim] = useState<{ start: number; end: number }>();
  const [imageEdit, setImageEdit] = useState<{ bytes: Uint8Array<ArrayBuffer>; url: string }>();
  const [loadedImageEdit, setLoadedImageEdit] = useState('');
  const [background, setBackground] = useState('#ffffff');
  const [editError, setEditError] = useState('');
  const [editing, setEditing] = useState(false);
  const fallback = useRef<AbortController | null>(null);
  const editOperation = useRef<AbortController | null>(null);
  const playback = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let release = () => {};
    mediaUrl(artifact, controller.signal)
      .then((media) => {
        release = media.release;
        if (controller.signal.aborted) release();
        else setUrl(media.url);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      fallback.current?.abort();
      editOperation.current?.abort();
      release();
    };
  }, [artifact]);
  useEffect(
    () => () => {
      if (converted) URL.revokeObjectURL(url);
    },
    [converted, url],
  );
  useEffect(
    () => () => {
      if (imageEdit) URL.revokeObjectURL(imageEdit.url);
    },
    [imageEdit],
  );
  if (error)
    return (
      <div className="empty" role="alert">
        {error}
      </div>
    );
  if (!url || converting)
    return (
      <div className="empty" role="status">
        {converting ? 'Converting preview…' : 'Loading media…'}
      </div>
    );
  const failed = () => {
    const kind = artifact.format.kind;
    if (converted || (kind !== 'video' && kind !== 'audio')) {
      setError('Unable to play or display this file. Check the format or codec.');
      return;
    }
    if (fallback.current) return;
    const controller = new AbortController();
    fallback.current = controller;
    setConverting(true);
    void convertedMediaUrl(artifact, kind, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) URL.revokeObjectURL(next);
        else {
          setConverted(true);
          setUrl(next);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setConverting(false);
      });
  };
  const shareMoment = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const media = playback.current;
    if (!media || !media.readyState) return;
    const time = media.currentTime.toFixed(3);
    let capture: string | undefined;
    if (media instanceof HTMLVideoElement && media.videoWidth && media.readyState >= 2) {
      const thumbnail = document.createElement('canvas');
      const scale = Math.min(1, 480 / Math.max(media.videoWidth, media.videoHeight));
      thumbnail.width = Math.max(1, Math.round(media.videoWidth * scale));
      thumbnail.height = Math.max(1, Math.round(media.videoHeight * scale));
      thumbnail.getContext('2d')?.drawImage(media, 0, 0, thumbnail.width, thumbnail.height);
      capture = thumbnail.toDataURL('image/jpeg', 0.75);
    }
    onShareItem?.({ id: `time:${time}`, label: `${time} s` }, capture);
  };
  const edit = async (run: (signal: AbortSignal) => Promise<void>) => {
    if (editOperation.current) return;
    const controller = new AbortController();
    editOperation.current = controller;
    setEditing(true);
    setEditError('');
    try {
      await run(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        setEditError(error instanceof Error ? error.message : 'Couldn’t edit media.');
    } finally {
      if (editOperation.current === controller) editOperation.current = null;
      if (!controller.signal.aborted) setEditing(false);
    }
  };
  const format = artifact.format.id;
  const writable = canSaveHostFile(artifact);
  const canEditImage = writable && (canRotateImage(format) || format === 'svg' || format === 'gif');
  const canEditTime = writable && !converted && duration > 0 && canTrimMedia(format);
  const stageImage = () =>
    void edit(async (signal) => {
      const original =
        imageEdit?.bytes.buffer ?? (await readBytes(artifact, undefined, false, signal));
      const bytes =
        format === 'gif'
          ? slowGif(original)
          : format === 'svg'
            ? svgBackground(original, background)
            : format === 'webp'
              ? await rotateWebp(original)
              : rotateImage(original, format);
      signal.throwIfAborted();
      const preview = new Blob([bytes], { type: artifact.format.mime });
      setImageEdit({ bytes, url: URL.createObjectURL(preview) });
    });
  const observeDuration = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const seconds = event.currentTarget.duration;
    setDuration(Number.isFinite(seconds) ? seconds : 0);
  };
  const restrictPlayback = () => {
    const media = playback.current;
    if (!trim || !media || media.paused) return;
    if (media.currentTime < trim.start) media.currentTime = trim.start;
    if (media.currentTime >= trim.end) {
      media.pause();
      media.currentTime = trim.start;
    }
  };
  function moveTrim(edge: 'start' | 'end', time: number) {
    if (!trim || time < 0 || time > duration) return;
    const next = { ...trim, [edge]: time };
    if (next.end - next.start < 0.001) return;
    const media = playback.current;
    if (media) {
      media.pause();
      // Changing an audio boundary needs no frame preview, and some FLAC files cannot seek.
      if (media instanceof HTMLVideoElement) media.currentTime = time;
    }
    setTrim(next);
  }
  return (
    <div className="media-view">
      {artifact.format.kind === 'video' ? (
        <div
          className="preview-stage media-stage video-stage"
          data-shared={sharedItemId ? 'true' : undefined}
          onDoubleClick={shareMoment}
        >
          <video
            ref={(element) => {
              playback.current = element;
            }}
            aria-label={artifact.name}
            src={url}
            controls
            playsInline
            onError={failed}
            onLoadedMetadata={observeDuration}
            onTimeUpdate={restrictPlayback}
            onPlay={restrictPlayback}
          />
        </div>
      ) : artifact.format.kind === 'audio' ? (
        <div
          className="audio-stage"
          data-shared={sharedItemId ? 'true' : undefined}
          onDoubleClick={shareMoment}
        >
          <audio
            ref={(element) => {
              playback.current = element;
            }}
            aria-label={artifact.name}
            src={url}
            controls
            onError={failed}
            onLoadedMetadata={observeDuration}
          />
        </div>
      ) : (
        <>
          <div className="preview-stage media-stage image-scroll">
            <img
              alt={artifact.name}
              src={imageEdit?.url ?? url}
              style={{ transform: `scale(${zoom})` }}
              onLoad={() => {
                if (imageEdit) setLoadedImageEdit(imageEdit.url);
              }}
              onError={() => {
                if (!imageEdit) {
                  failed();
                  return;
                }
                setImageEdit(undefined);
                setEditError('The edited image could not be displayed.');
              }}
            />
          </div>
          <div className="image-controls" role="group" aria-label="Image controls">
            <button
              className="icon-button"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={zoom <= 0.1}
              onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}
            >
              <Icon name="minus" />
            </button>
            <button
              className="icon-button"
              aria-label="Fit image"
              title="Fit image"
              onClick={() => setZoom(1)}
            >
              <Icon name="fit" />
            </button>
            <button
              className="icon-button"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={zoom >= 8}
              onClick={() => setZoom((z) => Math.min(8, z * 1.25))}
            >
              <Icon name="plus" />
            </button>
            {canEditImage && format === 'svg' && (
              <input
                type="color"
                aria-label="Background color"
                title="Background color"
                value={background}
                disabled={editing}
                onChange={(event) => setBackground(event.target.value)}
              />
            )}
            {canEditImage && (
              <button
                type="button"
                title={format === 'webp' ? 'Re-encodes static WebP' : undefined}
                disabled={editing}
                onClick={stageImage}
              >
                {format === 'gif'
                  ? 'Slow animation'
                  : format === 'svg'
                    ? 'Set background'
                    : 'Rotate right'}
              </button>
            )}
            {imageEdit && (
              <>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Save image"
                  title="Save image"
                  disabled={editing || loadedImageEdit !== imageEdit.url}
                  onClick={() =>
                    void edit(async (signal) => {
                      await saveHostFile(artifact, imageEdit.bytes, signal);
                    })
                  }
                >
                  <Icon name="check" />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Discard image edits"
                  title="Discard image edits"
                  disabled={editing}
                  onClick={() => {
                    setImageEdit(undefined);
                    setEditError('');
                  }}
                >
                  <Icon name="close" />
                </button>
              </>
            )}
          </div>
        </>
      )}
      {canEditTime &&
        (trim ? (
          <div className="media-trim" role="group" aria-label="Trim media">
            {(['start', 'end'] as const).map((edge) => (
              <label key={edge}>
                <span>{edge === 'start' ? 'Start' : 'End'}</span>
                <input
                  type="range"
                  aria-label={edge === 'start' ? 'Start time' : 'End time'}
                  min={0}
                  max={duration}
                  step="any"
                  value={trim[edge]}
                  disabled={editing}
                  onChange={(event) => moveTrim(edge, event.target.valueAsNumber)}
                />
                <output>{trim[edge].toFixed(2)} s</output>
              </label>
            ))}
            <div className="media-trim-actions">
              <button
                type="button"
                disabled={editing || (trim.start === 0 && trim.end === duration)}
                onClick={() =>
                  void edit(async (signal) => {
                    playback.current?.pause();
                    const original = await readBytes(artifact, undefined, false, signal);
                    const bytes = await trimMedia(original, format, trim.start, trim.end, signal);
                    await saveHostFile(artifact, bytes, signal);
                  })
                }
              >
                Save trim
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Discard trim"
                title="Discard trim"
                disabled={editing}
                onClick={() => {
                  setTrim(undefined);
                  setEditError('');
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          </div>
        ) : (
          <div className="media-trim-actions">
            <button
              type="button"
              onClick={() => {
                playback.current?.pause();
                setTrim({ start: 0, end: duration });
              }}
            >
              Trim
            </button>
          </div>
        ))}
      {editing && (
        <div className="preview-note" role="status">
          Preparing edit…
        </div>
      )}
      {editError && (
        <div className="preview-note" role="alert">
          {editError}
        </div>
      )}
      {converted && <p className="preview-note">Converted preview</p>}
    </div>
  );
}
