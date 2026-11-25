import { useEffect, useState } from 'react';
import type { ViewerProps } from '../../shared/types';
import { canSaveHostFile, readBytes, saveHostFile } from '../backend';
import { Icon } from '../Icon';
import EditValue from './EditValue';

export default function TextViewer({ artifact }: ViewerProps) {
  const binary = artifact.format.kind === 'unknown';
  const limit = binary ? 512 : 256 * 1024;
  const [text, setText] = useState<string>();
  const [original, setOriginal] = useState<{ text: string; bom: boolean; crlf: boolean }>();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setText(undefined);
    setOriginal(undefined);
    setEditing(false);
    setError('');
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
          if (artifact.size <= limit && canSaveHostFile(artifact)) {
            try {
              const exact = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                bytes,
              );
              const bom = exact.startsWith('\uFEFF');
              const source = bom ? exact.slice(1) : exact;
              const crlf = source.includes('\r\n');
              // A textarea normalizes line endings, so mixed line endings stay preview-only.
              if (
                !source.includes('\0') &&
                !/\r(?!\n)/.test(source) &&
                !(crlf && /(?<!\r)\n/.test(source))
              )
                setOriginal({ text: source.replaceAll('\r\n', '\n'), bom, crlf });
            } catch {
              // The permissive preview can display legacy text encodings.
            }
          }
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
  if (!artifact.size && !original) return <div className="empty">Empty file</div>;
  return (
    <div className="text-view">
      {original && !editing && (
        <div className="structured-controls">
          <button
            type="button"
            className="icon-button"
            title="Edit text"
            aria-label="Edit text"
            onClick={() => setEditing(true)}
          >
            <Icon name="edit" />
          </button>
        </div>
      )}
      {(binary || artifact.size > limit) && (
        <div className="preview-note">
          {binary
            ? artifact.size > limit
              ? 'Binary preview · First 512 bytes'
              : 'Binary preview'
            : 'First 256 KiB'}
        </div>
      )}
      {editing && original ? (
        <EditValue
          label="File text"
          value={original.text}
          multiline
          onClose={() => setEditing(false)}
          onSave={(draft) =>
            saveHostFile(
              artifact,
              new TextEncoder().encode(
                (original.bom ? '\uFEFF' : '') +
                  (original.crlf ? draft.replaceAll('\n', '\r\n') : draft),
              ),
            )
          }
        />
      ) : (
        <pre
          className="raw-preview"
          tabIndex={0}
          aria-label={binary ? 'Binary preview' : 'Text preview'}
        >
          {text}
        </pre>
      )}
    </div>
  );
}
