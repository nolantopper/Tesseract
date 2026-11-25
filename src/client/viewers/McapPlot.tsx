import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { McapPlotSeries } from '../../shared/mcap-recording';
import type { Artifact, Topic } from '../../shared/types';
import type { SharedItem } from '../../shared/view';
import { Icon } from '../Icon';
import PreviewPane from '../PreviewPane';
import { plotMcap } from './mcap-file';

const number = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 });
const seconds = (time: bigint) => `${(Number(time) / 1e9).toFixed(2)} s`;
const stepCount = 1_000_000;

interface Props {
  artifact: Artifact;
  topic: Topic;
  start: bigint;
  end: bigint;
  origin: bigint;
  timestamp: bigint;
  playing: boolean;
  transport?: boolean;
  initialField?: string;
  sharedItemId?: string;
  onTime: (time: bigint) => void;
  onPlayingChange: (playing: boolean) => void;
  onSeek: (time: bigint) => void;
  onShare: (time: bigint, item: SharedItem) => void;
}

export function useMcapPlaybackClock({
  playing,
  timestamp,
  end,
  onTime,
  onPlayingChange,
}: Pick<Props, 'playing' | 'timestamp' | 'end' | 'onTime' | 'onPlayingChange'>) {
  const timeRef = useRef(timestamp);
  timeRef.current = timestamp;
  useEffect(() => {
    if (!playing) return;
    const time = timeRef.current;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const next = time + BigInt(Math.round((performance.now() - startedAt) * 1e6));
      onTime(next < end ? next : end);
      if (next >= end) onPlayingChange(false);
    }, 33);
    return () => window.clearInterval(timer);
  }, [end, onTime, onPlayingChange, playing]);
}

export default function McapPlot({ artifact, topic, start, end, initialField, ...props }: Props) {
  const [series, setSeries] = useState<McapPlotSeries[]>();
  const [error, setError] = useState('');
  const [field, setField] = useState(initialField ?? '');
  const { playing, timestamp, onTime, onPlayingChange, transport = true } = props;
  useMcapPlaybackClock({ playing: playing && transport, timestamp, end, onTime, onPlayingChange });
  useEffect(() => {
    const controller = new AbortController();
    setSeries(undefined);
    setError('');
    void plotMcap(
      artifact,
      { channelId: topic.id, startNs: String(start), endNs: String(end) },
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        setSeries(next);
        if (!next.length && transport) onPlayingChange(false);
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setError(error.message);
        if (transport) onPlayingChange(false);
      });
    return () => controller.abort();
  }, [artifact, topic.id, start, end, transport, onPlayingChange]);

  const selected = field ? series?.find((entry) => entry.field === field) : series?.[0];
  return (
    <PreviewPane title={topic.topic} className="mcap-plot" aria-label={`${topic.topic} graph`}>
      {selected ? (
        <Plot
          series={selected}
          fieldPicker={
            series &&
            series.length > 1 && (
              <div className="mcap-select">
                <select
                  aria-label="Graph field"
                  value={selected.field}
                  onChange={(event) => setField(event.currentTarget.value)}
                >
                  {series.map(({ field }) => (
                    <option key={field}>{field}</option>
                  ))}
                </select>
                <Icon name="chevron" />
              </div>
            )
          }
          topic={topic}
          start={start}
          end={end}
          {...props}
        />
      ) : (
        <p className="muted" role="status">
          {error ||
            (series?.length
              ? 'Graph field unavailable.'
              : series
                ? 'No numeric readings in this range.'
                : 'Loading readings…')}
        </p>
      )}
    </PreviewPane>
  );
}

function Plot({
  series,
  fieldPicker,
  topic,
  start,
  end,
  origin,
  timestamp,
  playing,
  transport = true,
  sharedItemId,
  onTime,
  onPlayingChange,
  onSeek,
  onShare,
}: Omit<Props, 'artifact'> & { series: McapPlotSeries; fieldPicker?: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const graph = useMemo(() => {
    const span = end - start;
    const x = (time: bigint) => (span > 0n ? Number(time - start) / Number(span) : 0);
    const points = series.points.map((point) => ({ ...point, time: BigInt(point.timestampNs) }));
    const values = points.map(({ value }) => value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
    const extent = max / scale - min / scale;
    const y = (value: number) => (extent ? (max / scale - value / scale) / extent : 0.5);
    return { span, x, y, points, min, max };
  }, [series, start, end]);

  useEffect(() => {
    const node = canvas.current!;
    const context = node.getContext('2d');
    if (!context) return;
    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio, 2);
      const width = node.clientWidth;
      const height = node.clientHeight;
      node.width = Math.round(width * ratio);
      node.height = Math.round(height * ratio);
      context.scale(ratio, ratio);
      const color = getComputedStyle(node).color;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 1.5;
      context.lineJoin = 'round';
      context.beginPath();
      for (const [index, point] of graph.points.entries()) {
        const x = graph.x(point.time) * width;
        const y = graph.y(point.value) * height;
        if (graph.points.length === 1) {
          context.arc(x, y, 2.5, 0, Math.PI * 2);
          context.fill();
        } else if (index) context.lineTo(x, y);
        else context.moveTo(x, y);
      }
      context.stroke();
    };
    const observer = new ResizeObserver(draw);
    observer.observe(node);
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributeFilter: ['data-theme', 'style'] });
    draw();
    return () => {
      observer.disconnect();
      theme.disconnect();
    };
  }, [graph]);

  const closest = (time: bigint) => {
    const { points } = graph;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && time - points[lo - 1].time <= points[lo].time - time ? lo - 1 : lo;
  };
  const { field } = series;
  const itemPrefix = `plot:${topic.id}:${field}:`;
  const shared = useMemo(
    () => graph.points.find(({ timestampNs }) => itemPrefix + timestampNs === sharedItemId),
    [graph.points, itemPrefix, sharedItemId],
  );
  const timeAtStep = (step: number) => start + (graph.span * BigInt(step)) / BigInt(stepCount);
  const timeAt = ({ currentTarget, clientX }: MouseEvent<HTMLDivElement>) => {
    const rect = currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return timeAtStep(Math.round(fraction * stepCount));
  };
  const index = closest(timestamp);
  const current = graph.points[index];
  const share = (point: (typeof graph.points)[number]) => {
    onShare(point.time, {
      id: itemPrefix + point.timestampNs,
      label: `${topic.topic} · ${field}`.slice(0, 300),
      details: `${field} = ${point.value}`,
    });
  };
  const position = Math.max(0, Math.min(1, graph.x(timestamp)));
  return (
    <>
      <div className="mcap-plot-reading">
        {fieldPicker || <span>{field}</span>}
        <span className="mcap-plot-value" title={String(current.value)}>
          {number.format(current.value)}
        </span>
      </div>
      <div className="mcap-plot-body">
        <div className="mcap-plot-scale" aria-hidden="true">
          <span>{number.format(graph.max)}</span>
          {graph.min !== graph.max && <span>{number.format(graph.min)}</span>}
        </div>
        <div
          className="mcap-plot-surface"
          role="slider"
          tabIndex={0}
          aria-label={`${topic.topic} timeline`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(position * 100)}
          aria-valuetext={`${seconds(timestamp - origin)} · ${field} ${number.format(current.value)}`}
          aria-keyshortcuts="Enter"
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            onSeek(timeAt(event));
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) onSeek(timeAt(event));
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            share(graph.points[closest(timeAt(event))]);
          }}
          onKeyDown={(event) => {
            const last = graph.points.length - 1;
            let next = index;
            switch (event.key) {
              case 'Enter':
                event.preventDefault();
                share(current);
                return;
              case 'ArrowDown':
              case 'ArrowLeft':
                next = Math.max(0, index - 1);
                break;
              case 'ArrowUp':
              case 'ArrowRight':
                next = Math.min(last, index + 1);
                break;
              case 'Home':
                next = 0;
                break;
              case 'End':
                next = last;
                break;
              default:
                return;
            }
            event.preventDefault();
            onSeek(graph.points[next].time);
          }}
        >
          <canvas ref={canvas} aria-hidden="true" />
          <span className="mcap-plot-playhead" style={{ left: `${position * 100}%` }} />
          {shared && (
            <span
              className="mcap-plot-shared"
              style={{
                left: `${graph.x(shared.time) * 100}%`,
                top: `${graph.y(shared.value) * 100}%`,
              }}
              aria-hidden="true"
            />
          )}
        </div>
        <div className="mcap-plot-time" aria-hidden="true">
          <span>{seconds(start - origin)}</span>
          <span>{seconds(end - origin)}</span>
        </div>
      </div>
      {transport && (
        <McapPlayback
          label="Graph"
          {...{ start, end, timestamp, playing, onTime, onPlayingChange, onSeek }}
        />
      )}
    </>
  );
}

export function McapPlayback({
  label,
  start,
  end,
  timestamp,
  playing,
  onTime,
  onPlayingChange,
  onSeek,
}: Pick<
  Props,
  'start' | 'end' | 'timestamp' | 'playing' | 'onTime' | 'onPlayingChange' | 'onSeek'
> & {
  label: 'Graph' | 'Recording';
}) {
  const span = end - start;
  const fraction = span > 0n ? Number(timestamp - start) / Number(span) : 0;
  const position = Math.max(0, Math.min(1, fraction));
  const action = `${playing ? 'Pause' : 'Play'} ${label.toLowerCase()}`;
  return (
    <div
      className="message-controls mcap-plot-controls"
      role="group"
      aria-label={`${label} playback`}
    >
      <input
        type="range"
        aria-label={`${label} playback position`}
        aria-valuetext={seconds(timestamp - start)}
        min={0}
        max={stepCount}
        step="any"
        disabled={start === end}
        value={Math.round(position * stepCount)}
        style={{ '--progress': `${position * 100}%` } as CSSProperties}
        onChange={(event) =>
          onSeek(
            start +
              (span * BigInt(Math.round(event.currentTarget.valueAsNumber))) / BigInt(stepCount),
          )
        }
      />
      <button
        type="button"
        className="icon-button"
        aria-label={action}
        title={action}
        disabled={start === end}
        onClick={() => {
          if (!playing && timestamp >= end) onTime(start);
          onPlayingChange(!playing);
        }}
      >
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <span className="playback-time">
        {seconds(timestamp - start)} / {seconds(end - start)}
      </span>
    </div>
  );
}
