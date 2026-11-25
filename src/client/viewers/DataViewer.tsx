import { useEffect, useState, type CSSProperties } from 'react';
import type { Selection, ViewerProps } from '../../shared/types';
import { canSaveHostFile, embeddedParserWorker, readBytes, saveHostFile } from '../backend';
import { Icon } from '../Icon';
import { editableNpyDtype, editNpyValue } from '../../shared/numpy';
import { editableNetCdf, editNetCdfValue } from './netcdf-edits';
import ArrayValueEditor, { type EditableArray } from './ArrayValueEditor';
import dataWorkerUrl from './data.worker?worker&url';

async function rewriteHdf5(data: ArrayBuffer, name: string, index: number, value: string) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('HDF5 edit exceeded 20 seconds.')),
    20000,
  );
  let worker: Worker | undefined;
  try {
    const parser = await embeddedParserWorker(dataWorkerUrl, controller.signal);
    worker = parser;
    return await new Promise<Uint8Array>((resolve, reject) => {
      controller.signal.throwIfAborted();
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
      parser.onmessage = ({
        data: result,
      }: MessageEvent<{ bytes?: Uint8Array; error?: string }>) => {
        if (result.bytes) resolve(result.bytes);
        else reject(new Error(result.error ?? 'Couldn’t edit the dataset.'));
      };
      parser.onerror = () => reject(new Error('Data worker unavailable.'));
      parser.postMessage({ data, kind: 'hdf5', edit: { name, index, value } }, [data]);
    });
  } finally {
    clearTimeout(timer);
    worker?.terminate();
  }
}

function formatTime(nanoseconds: bigint, showTenths: boolean) {
  const seconds = Number(nanoseconds / 100_000_000n) / 10;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const label = showTenths ? remainder.toFixed(1) : String(Math.floor(remainder));
  return `${minutes}:${label.padStart(showTenths ? 4 : 2, '0')}`;
}

export default function DataViewer({ artifact, onSelect, onShareTime }: ViewerProps) {
  const [messages, setMessages] = useState<
    {
      topic?: string;
      timestampNs?: string;
      channelId?: number;
      value?: unknown;
      message?: unknown;
    }[]
  >([]);
  const [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (index + 1 >= messages.length) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setIndex((current) => current + 1), 500);
    return () => clearTimeout(timer);
  }, [playing, index, messages.length]);
  const [text, setText] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    let worker: Worker | undefined;
    setText('');
    setError('');
    setMessages([]);
    setIndex(0);
    setPlaying(false);
    const stop = () => {
      abort.abort();
      clearTimeout(timer);
      worker?.terminate();
    };
    const timer = setTimeout(() => {
      stop();
      setError('Data inspection exceeded 20 seconds.');
    }, 20000);
    async function inspect() {
      const data = await readBytes(artifact, undefined, false, signal);
      signal.throwIfAborted();
      const parser = await embeddedParserWorker(dataWorkerUrl, signal);
      if (signal.aborted) {
        parser.terminate();
        return;
      }
      worker = parser;
      parser.onmessage = (event) => {
        stop();
        setText(event.data.text ?? '');
        setMessages(event.data.messages ?? []);
        setError(event.data.error ?? '');
      };
      parser.onerror = () => {
        stop();
        setError('Data worker unavailable.');
      };
      parser.postMessage({ data, kind: artifact.format.id }, [data]);
    }
    void inspect().catch((error) => {
      if (!signal.aborted) {
        stop();
        setError(error.message);
      }
    });
    return stop;
  }, [artifact]);
  const message = messages[index];
  if (error)
    return (
      <div className="empty" role="alert">
        {error}
      </div>
    );
  if (!text)
    return (
      <div className="empty" role="status">
        Loading data…
      </div>
    );
  if (!message) {
    const format = artifact.format.id;
    const arrays: EditableArray[] = [];
    if (canSaveHostFile(artifact) && format === 'npy') {
      const { dtype, preview } = JSON.parse(text) as {
        dtype: string;
        preview: EditableArray['preview'];
      };
      if (preview.length && editableNpyDtype(dtype)) arrays.push({ name: '', preview });
    }
    if (canSaveHostFile(artifact) && format === 'netcdf') {
      const preview = JSON.parse(text) as {
        variables: (EditableArray & { type: string; record: boolean })[];
      };
      arrays.push(
        ...preview.variables.filter(
          (variable) =>
            editableNetCdf(variable.type, variable.record) &&
            Array.isArray(variable.preview) &&
            variable.preview.length,
        ),
      );
    }
    if (canSaveHostFile(artifact) && format === 'hdf5') {
      const { datasets } = JSON.parse(text) as {
        datasets: { path: string; preview: EditableArray['preview']; editable?: boolean }[];
      };
      for (const dataset of datasets) {
        if (dataset.editable && Array.isArray(dataset.preview) && dataset.preview.length)
          arrays.push({ name: dataset.path, preview: dataset.preview });
      }
    }
    return (
      <div className="text-view">
        {arrays.length > 0 && (
          <ArrayValueEditor
            arrays={arrays}
            save={async (name, index, value) => {
              const bytes = await readBytes(artifact);
              const edited =
                format === 'hdf5'
                  ? await rewriteHdf5(bytes, name, index, value)
                  : format === 'npy'
                    ? editNpyValue(bytes, index, value)
                    : editNetCdfValue(bytes, name, index, value);
              await saveHostFile(artifact, edited);
            }}
          />
        )}
        <pre className="raw-preview" tabIndex={0} aria-label="Data preview">
          {text}
        </pre>
      </div>
    );
  }

  const togglePlayback = () => {
    if (!playing && index + 1 === messages.length) setIndex(0);
    setPlaying(!playing);
  };
  const progress = (100 * index) / Math.max(1, messages.length - 1);
  const start = BigInt(messages[0].timestampNs ?? '0');
  const duration = BigInt(messages[messages.length - 1].timestampNs ?? start) - start;
  const elapsed = BigInt(message.timestampNs ?? start) - start;
  const showTenths = duration < 10_000_000_000n;
  const timeLabel =
    duration > 0 && elapsed >= 0 && elapsed <= duration
      ? `${formatTime(elapsed, showTenths)} / ${formatTime(duration, showTenths)}`
      : `${index + 1} / ${messages.length}`;
  const shareMessage = () => {
    if (!message.timestampNs) return;
    const selection: Selection = {
      artifactId: artifact.id,
      revision: artifact.revision,
      path: artifact.path,
      kind: 'time',
      timestampNs: message.timestampNs,
      channelId: message.channelId,
    };
    if (artifact.format.kind === 'mcap') onSelect(selection);
    onShareTime?.(selection);
  };
  return (
    <div className="text-view message-view">
      <div className="message-player">
        <div className="preview-note" title={message.topic}>
          <code>{message.topic}</code>
        </div>
        <pre
          className="raw-preview"
          tabIndex={0}
          aria-label="Decoded message"
          aria-keyshortcuts="Enter"
          onDoubleClick={(event) => {
            event.stopPropagation();
            shareMessage();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') shareMessage();
          }}
        >
          {JSON.stringify(message, null, 2)}
        </pre>
        <div className="message-controls" role="group" aria-label="Message controls">
          <input
            type="range"
            aria-label="Message preview index"
            aria-valuetext={`Message ${index + 1} of ${messages.length}`}
            min="0"
            max={messages.length - 1}
            value={index}
            disabled={messages.length < 2}
            style={{ '--progress': `${progress}%` } as CSSProperties}
            onChange={(event) => {
              setPlaying(false);
              setIndex(Number(event.target.value));
            }}
          />
          <button
            type="button"
            className="icon-button"
            disabled={messages.length < 2}
            aria-label={playing ? 'Pause preview' : 'Play preview'}
            title={playing ? 'Pause preview' : 'Play preview (2 messages/s)'}
            onClick={togglePlayback}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <span className="playback-time" title={`Message ${index + 1} of ${messages.length}`}>
            {timeLabel}
          </span>
        </div>
      </div>
      <details>
        <summary>Recording details</summary>
        <pre className="raw-preview" tabIndex={0} aria-label="Recording details">
          {text}
        </pre>
      </details>
    </div>
  );
}
