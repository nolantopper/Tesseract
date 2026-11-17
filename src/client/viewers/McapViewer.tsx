import { useState } from 'react';
import DataViewer from './DataViewer';
import type { ViewerProps } from '../../shared/types';
import McapVideo from './McapVideo';
import { Icon } from '../Icon';

export default function McapViewer({ artifact, onSelect }: ViewerProps) {
  const [decode, setDecode] = useState(false);
  const info = artifact.mcap;
  const [time, setTime] = useState<string>();
  const [channel, setChannel] = useState<number>();
  const [seekRevision, setSeekRevision] = useState(0);
  if (!info)
    return (
      <div className="empty" role="alert">
        {artifact.warning ?? 'No MCAP metadata available.'}
      </div>
    );
  const start = BigInt(info.startTime),
    end = BigInt(info.endTime),
    duration = end - start;
  const timestamp = BigInt(time ?? info.startTime);
  const position = duration > 0n ? Number(((timestamp - start) * 10000n) / duration) : 0;
  const hasVideo = info.topics.some(
    (t) => t.schema === 'foxglove.CompressedVideo' && t.encoding === 'protobuf',
  );
  const choose = (value: number, channelId = channel) => {
    const next = start + (duration * BigInt(value)) / 10000n;
    setTime(String(next));
    setSeekRevision((r) => r + 1);
    onSelect({
      artifactId: artifact.id,
      revision: artifact.revision,
      path: artifact.path,
      kind: 'time',
      timestampNs: String(next),
      channelId,
    });
  };
  return (
    <div className="mcap-view">
      <div className="recording-summary">
        <span>{info.topics.length} topics</span>
        <span>{BigInt(info.messageCount).toLocaleString()} messages</span>
        <span>{(Number(duration) / 1e9).toFixed(3)} s</span>
        <span className="muted">
          {info.profile || 'MCAP'} · {info.indexed ? 'indexed' : 'scanned'}
        </span>
      </div>
      {hasVideo && (
        <McapVideo
          artifact={artifact}
          onSelect={onSelect}
          timestampNs={String(timestamp)}
          seekRevision={seekRevision}
          onTime={(next, id) => {
            setTime(String(next));
            setChannel(id);
          }}
        />
      )}
      {!hasVideo && (
        <div className="timeline">
          <div className="time-label">
            <span>+{(Number(timestamp - start) / 1e9).toFixed(3)} s</span>
            <code>{String(timestamp)} ns</code>
          </div>
          <input
            aria-label="Recording timeline"
            type="range"
            min="0"
            max="10000"
            value={position}
            onChange={(e) => choose(Number(e.target.value))}
          />
          <div className="time-label muted">
            <span>0 s</span>
            <span>{(Number(duration) / 1e9).toFixed(3)} s</span>
          </div>
        </div>
      )}
      <div className="topic-scroll">
        <table>
          <thead>
            <tr>
              <th>Topic</th>
              <th>Schema</th>
              <th>Encoding</th>
              <th>Messages</th>
            </tr>
          </thead>
          <tbody>
            {info.topics.map((topic) => (
              <tr key={topic.id} className={channel === topic.id ? 'selected' : ''}>
                <td>
                  <button
                    className="topic-button"
                    aria-pressed={channel === topic.id}
                    onClick={() => {
                      setChannel(topic.id);
                      choose(position, topic.id);
                    }}
                  >
                    {topic.topic}
                  </button>
                </td>
                <td title={topic.schema}>{topic.schema || '—'}</td>
                <td>{topic.encoding}</td>
                <td>{topic.count ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!artifact.id.startsWith('local-') && (
        <button
          className="disclosure"
          onClick={() => setDecode((value) => !value)}
          aria-expanded={decode}
        >
          <Icon name="chevron" />
          Decoded message preview
        </button>
      )}
      {decode && <DataViewer artifact={artifact} onSelect={onSelect} />}
      {info.metadata.length > 0 && (
        <details>
          <summary>Recording metadata</summary>
          {info.metadata.map((record, i) => (
            <div key={i}>
              <strong>{record.name}</strong>
              <pre>{JSON.stringify(record.values, null, 2)}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
