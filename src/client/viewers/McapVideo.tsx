import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { readBytes } from '../backend';
import { frameAt, type Camera, type CameraStream } from '../../shared/mcap-video';
import type { ViewerProps } from '../../shared/types';
import VideoWorker from './mcap-video.worker?worker&inline';
import { H264Player } from './h264-player';
import { Icon } from '../Icon';

interface Props extends ViewerProps {
  timestampNs: string;
  seekRevision: number;
  onTime: (time: bigint, channel: number) => void;
}
export default function McapVideo({
  artifact,
  timestampNs,
  seekRevision,
  onTime,
  onSelect,
}: Props) {
  const [cameras, setCameras] = useState<Camera[]>([]),
    [camera, setCamera] = useState<number>();
  const [stream, setStream] = useState<CameraStream>(),
    [ready, setReady] = useState(false),
    [playing, setPlaying] = useState(false);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null),
    worker = useRef<Worker>(undefined),
    player = useRef<H264Player>(undefined);
  const request = useRef(0),
    watchdog = useRef<ReturnType<typeof setTimeout>>(undefined);
  const timeRef = useRef(timestampNs),
    onTimeRef = useRef(onTime);
  timeRef.current = timestampNs;
  onTimeRef.current = onTime;
  const start = BigInt(artifact.mcap!.startTime),
    end = BigInt(artifact.mcap!.endTime);
  const fail = (message: string) => {
    setError(message);
    setLoading(false);
    setPlaying(false);
  };
  const armWatchdog = () => {
    clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => {
      worker.current?.terminate();
      worker.current = undefined;
      fail('Camera extraction exceeded 20 seconds. Reopen the recording to retry.');
    }, 20000);
  };
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    setLoading(true);
    setCameras([]);
    setCamera(undefined);
    setStream(undefined);
    setPlaying(false);
    const current = new VideoWorker();
    worker.current = current;
    armWatchdog();
    current.onmessage = (event) => {
      const response = event.data;
      if (response.request !== undefined && response.request !== request.current) return;
      clearTimeout(watchdog.current);
      if (response.type === 'cameras') {
        setCameras(response.cameras);
        setCamera(response.cameras[0]?.id);
        if (!response.cameras.length) {
          setLoading(false);
          fail('No protobuf foxglove.CompressedVideo camera channels were found.');
        }
      }
      if (response.type === 'stream') {
        setStream(response.stream);
        setLoading(false);
      }
      if (response.type === 'error') fail(response.error);
    };
    current.onerror = (event) => {
      clearTimeout(watchdog.current);
      fail(
        `Camera worker failed: ${event.message || 'inline workers are unavailable in this host.'}`,
      );
    };
    readBytes(artifact, undefined, false, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) current.postMessage({ type: 'load', data }, [data]);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          clearTimeout(watchdog.current);
          fail(e.message);
        }
      });
    return () => {
      abort.abort();
      current.terminate();
      clearTimeout(watchdog.current);
      worker.current = undefined;
    };
  }, [artifact.id, artifact.revision]);
  useEffect(() => {
    if (camera === undefined || !worker.current) return;
    setPlaying(false);
    setStream(undefined);
    setReady(false);
    setError('');
    setLoading(true);
    armWatchdog();
    worker.current.postMessage({ type: 'stream', id: camera, request: ++request.current });
  }, [camera]);
  useEffect(() => {
    if (!stream || !canvas.current) return;
    let active = true;
    const current = new H264Player(stream, canvas.current, start, (message) => {
      if (active) fail(message);
    });
    player.current = current;
    H264Player.supported(stream)
      .then(() => {
        if (active) {
          setReady(true);
          current.request(frameAt(stream.samples, BigInt(timeRef.current)), false);
        }
      })
      .catch((e) => {
        if (active) fail(e.message);
      });
    const surface = canvas.current;
    return () => {
      active = false;
      current.dispose();
      player.current = undefined;
      surface.getContext('2d')?.clearRect(0, 0, surface.width, surface.height);
      delete surface.dataset.frameTimestampNs;
    };
  }, [stream, artifact.id]);
  const index = stream ? frameAt(stream.samples, BigInt(timestampNs)) : 0;
  useEffect(() => {
    if (ready && stream) player.current?.request(index, playing);
  }, [index, ready, playing, stream]);
  useEffect(() => {
    setPlaying(false);
  }, [seekRevision]);
  useEffect(() => {
    if (!playing || !stream) return;
    const initial = BigInt(timeRef.current),
      wall = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const next = initial + BigInt(Math.round((now - wall) * 1e6));
      onTimeRef.current(next > end ? end : next, stream.camera.id);
      if (next >= end) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, stream]);
  const seek = (seconds: number) => {
    setPlaying(false);
    if (camera !== undefined) onTime(start + BigInt(Math.round(seconds * 1e9)), camera);
  };
  return (
    <section className="camera-player" aria-label="MCAP camera video">
      <div className="camera-toolbar">
        <div className="camera-select">
          <select
            aria-label="Camera channel"
            disabled={!cameras.length}
            value={camera ?? ''}
            onChange={(e) => setCamera(Number(e.target.value))}
          >
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.topic}
              </option>
            ))}
          </select>
          <Icon name="chevron" />
        </div>
        {stream && (
          <span className="muted">
            {stream.width} × {stream.height}
            <span className="camera-detail"> · H.264 · {stream.samples.length} frames</span>
          </span>
        )}
      </div>
      <div className="camera-screen">
        <canvas
          ref={canvas}
          aria-label="Recorded camera video"
          data-camera={stream?.camera.topic}
        />
        {loading && <span role="status">Loading camera frames…</span>}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="camera-controls playback-controls">
        <button
          className="icon-button play-button"
          disabled={!ready || loading || !!error}
          aria-label={playing ? 'Pause recording' : 'Play recording'}
          title={playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (!playing && BigInt(timestampNs) >= end && camera !== undefined)
              onTime(start, camera);
            setPlaying(!playing);
          }}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <input
          type="range"
          aria-label="Video seek"
          min="0"
          max={Number(end - start) / 1e9}
          step="0.001"
          value={Number(BigInt(timestampNs) - start) / 1e9}
          style={
            {
              '--progress': `${(Number(BigInt(timestampNs) - start) / Number(end - start || 1n)) * 100}%`,
            } as CSSProperties
          }
          onChange={(e) => seek(Number(e.target.value))}
        />
        <output aria-label="Video elapsed time">
          {(Number(BigInt(timestampNs) - start) / 1e9).toFixed(3)} /{' '}
          {(Number(end - start) / 1e9).toFixed(3)} s
        </output>
        <button
          className="icon-button"
          aria-label="Select video timestamp"
          title="Select timestamp"
          disabled={!stream || !ready}
          onClick={() => {
            if (stream) {
              const sample = stream.samples[index];
              onTime(BigInt(sample.timestampNs), stream.camera.id);
              onSelect({
                artifactId: artifact.id,
                revision: artifact.revision,
                path: artifact.path,
                kind: 'time',
                timestampNs: sample.timestampNs,
                channelId: stream.camera.id,
              });
            }
          }}
        >
          <Icon name="flag" />
        </button>
      </div>
    </section>
  );
}
