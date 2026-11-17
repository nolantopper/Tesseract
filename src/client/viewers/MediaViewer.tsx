import { useEffect, useState } from 'react';
import type { ViewerProps } from '../../shared/types';
import { mediaUrl } from '../backend';
import { Icon } from '../Icon';

export default function MediaViewer({ artifact }: ViewerProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
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
      release();
    };
  }, [artifact]);
  if (error)
    return (
      <div className="empty" role="alert">
        {error}
      </div>
    );
  if (!url)
    return (
      <div className="empty" role="status">
        Loading media…
      </div>
    );
  const failed = () => setError('Unable to play or display this file. Check the format or codec.');
  return (
    <div className="media-view">
      {artifact.format.kind === 'video' ? (
        <div className="preview-stage media-stage video-stage">
          <video aria-label={artifact.name} src={url} controls playsInline onError={failed} />
        </div>
      ) : artifact.format.kind === 'audio' ? (
        <div className="audio-stage">
          <audio aria-label={artifact.name} src={url} controls onError={failed} />
        </div>
      ) : (
        <>
          <div className="preview-stage media-stage image-scroll">
            <img
              alt={artifact.name}
              src={url}
              style={{ transform: `scale(${zoom})` }}
              onError={failed}
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
          </div>
        </>
      )}
    </div>
  );
}
