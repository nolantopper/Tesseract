import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Artifact, Topic } from '../../shared/types';
import type { SharedItem, ViewSample } from '../../shared/view';
import PreviewPane from '../PreviewPane';
import { sampleMcap } from './mcap-file';

function messageText(value: string) {
  try {
    const message = JSON.parse(value);
    if (typeof message === 'string') return message;
    if (typeof message?.data === 'string') return message.data;
    return JSON.stringify(message, null, 2);
  } catch {
    return value;
  }
}

export default function McapMessage({
  artifact,
  topic,
  timestamp,
  playing,
  visible,
  transport,
  onShare,
}: {
  artifact: Artifact;
  topic: Topic;
  timestamp: bigint;
  playing: boolean;
  visible: boolean;
  transport?: ReactNode;
  onShare: (timestampNs: string, item: SharedItem) => void;
}) {
  const info = artifact.mcap!;
  const start = BigInt(info.startTime);
  const time = playing
    ? start + ((timestamp - start) / 1_000_000_000n) * 1_000_000_000n
    : timestamp;
  const [sample, setSample] = useState<ViewSample>();
  const text = useMemo(() => (sample ? messageText(sample.value) : undefined), [sample]);
  const [status, setStatus] = useState('Loading message…');
  const lastRead = useRef<{ artifact: Artifact; time: bigint }>(undefined);
  useEffect(() => {
    if (
      !visible ||
      !info.indexed ||
      (lastRead.current?.artifact === artifact && lastRead.current.time === time)
    )
      return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void sampleMcap(
        artifact,
        {
          channelId: topic.id,
          startNs: info.startTime,
          endNs: String(time),
          limit: 1,
          reverse: true,
        },
        controller.signal,
      )
        .then(([message]) => {
          if (controller.signal.aborted) return;
          lastRead.current = { artifact, time };
          setSample(message);
          setStatus('No message at this time.');
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          lastRead.current = undefined;
          setSample(undefined);
          setStatus('Message unavailable.');
        });
    }, 80);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [artifact, info.indexed, info.startTime, time, topic.id, visible]);

  const share = () => {
    if (!sample) return;
    onShare(sample.timestampNs, {
      id: `message:${topic.id}:${sample.timestampNs}`,
      label: topic.topic.slice(0, 300),
      details: sample.value,
    });
  };
  return (
    <PreviewPane
      title={topic.topic}
      className="mcap-message-pane"
      aria-label={`${topic.topic} messages`}
    >
      {sample ? (
        <pre
          className="raw-preview"
          tabIndex={0}
          aria-label={`${topic.topic} message`}
          onDoubleClick={(event) => {
            event.stopPropagation();
            share();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') share();
          }}
        >
          {text}
        </pre>
      ) : (
        <p className="muted" role="status">
          {info.indexed ? status : topic.schema || topic.encoding}
        </p>
      )}
      {transport}
    </PreviewPane>
  );
}
