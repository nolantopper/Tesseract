import { useEffect, useState, type CSSProperties } from 'react';
import type { ViewerProps } from '../../shared/types';
import { embeddedParserWorker, readBytes } from '../backend';
import { Icon } from '../Icon';
import dataWorkerUrl from './data.worker?worker&url';
export default function DataViewer({ artifact, onSelect }: ViewerProps) {
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
  if (!message)
    return (
      <div className="text-view">
        <pre className="raw-preview" tabIndex={0} aria-label="Data preview">
          {text}
        </pre>
      </div>
    );

  const togglePlayback = () => {
    if (!playing && index + 1 === messages.length) setIndex(0);
    setPlaying(!playing);
  };
  const progress = (100 * index) / Math.max(1, messages.length - 1);
  return (
    <div className="text-view message-view">
      <div className="preview-note" title={message.topic}>
        <code>{message.topic}</code>
      </div>
      <pre className="raw-preview" tabIndex={0} aria-label="Decoded message">
        {JSON.stringify(message, null, 2)}
      </pre>
      <div className="playback-controls" role="group" aria-label="Message controls">
        <button
          className="icon-button play-button"
          disabled={messages.length < 2}
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          title={playing ? 'Pause preview' : 'Play preview (2 messages/s)'}
          onClick={togglePlayback}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <input
          type="range"
          aria-label="Message preview index"
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
        <span className="playback-time" title={`${messages.length} sampled messages`}>
          {index + 1} / {messages.length}
        </span>
        {message.timestampNs && (
          <button
            className="icon-button"
            aria-label="Select message timestamp"
            title="Select timestamp"
            onClick={() =>
              onSelect({
                artifactId: artifact.id,
                revision: artifact.revision,
                path: artifact.path,
                kind: 'time',
                timestampNs: message.timestampNs,
                channelId: message.channelId,
              })
            }
          >
            <Icon name="flag" />
          </button>
        )}
      </div>
      <details>
        <summary>Recording metadata and sampled messages</summary>
        <pre className="raw-preview" tabIndex={0} aria-label="Recording details">
          {text}
        </pre>
      </details>
    </div>
  );
}
