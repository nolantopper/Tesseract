import { useEffect, useState } from 'react';
import type { ViewerProps } from '../../shared/types';
import { readBytes } from '../backend';

export default function TextViewer({ artifact }: ViewerProps) {
  const binary = artifact.format.kind === 'unknown';
  const limit = binary ? 512 : 256 * 1024;
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    readBytes(artifact, limit, true, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        if (binary) {
          const head = new Uint8Array(bytes);
          setText(
            Array.from(
              { length: Math.ceil(head.length / 16) },
              (_, i) =>
                `${(i * 16).toString(16).padStart(8, '0')}  ${[...head.slice(i * 16, i * 16 + 16)].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`,
            ).join('\n'),
          );
        } else {
          const decoded = new TextDecoder().decode(bytes);
          if (artifact.name.endsWith('.json') && artifact.size <= limit) {
            try {
              setText(JSON.stringify(JSON.parse(decoded), null, 2));
            } catch {
              setText(decoded);
            }
          } else setText(decoded);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [artifact, binary, limit]);
  if (error)
    return (
      <div className="empty" role="alert">
        {error}
      </div>
    );
  if (text === undefined)
    return (
      <div className="empty" role="status">
        Loading preview…
      </div>
    );
  if (!artifact.size) return <div className="empty">Empty file</div>;
  return (
    <div className="text-view">
      {(binary || artifact.size > limit) && (
        <div className="preview-note">
          {binary
            ? artifact.size > limit
              ? 'Binary preview · First 512 bytes'
              : 'Binary preview'
            : 'First 256 KiB'}
        </div>
      )}
      <pre
        className="raw-preview"
        tabIndex={0}
        aria-label={binary ? 'Binary preview' : 'Text preview'}
      >
        {text}
      </pre>
    </div>
  );
}
