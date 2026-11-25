import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { readBytes } from '../backend';
import { videoLimits, type Camera } from '../../shared/mcap-video';
import type { ViewerProps } from '../../shared/types';
import PreviewPane from '../PreviewPane';
import VideoWorker from './mcap-video.worker?worker&inline';
import { clipFrameAt, clipSeconds, type CameraClip } from './mcap-mp4';
import { serveMcapSource } from './mcap-file';

interface Props extends Pick<ViewerProps, 'artifact' | 'captureRef'> {
  timestampNs: string;
  camera?: number;
  title: string;
  synchronized?: boolean;
  range?: { startNs: string; endNs: string };
  seekRevision: number;
  playing: boolean;
  readTimeRef?: RefObject<(() => bigint | undefined) | null>;
  onTime: (time: bigint) => void;
  onPlayingChange: (playing: boolean) => void;
  onShareTime: (timestampNs: string, channelId: number, image?: string) => void;
}

export default function McapVideo({
  artifact,
  timestampNs,
  camera,
  title,
  synchronized = false,
  range,
  seekRevision,
  playing,
  readTimeRef,
  onTime,
  onPlayingChange,
  onShareTime,
  captureRef,
}: Props) {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [clip, setClip] = useState<CameraClip>();
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const video = useRef<HTMLVideoElement>(null),
    worker = useRef<Worker>(undefined);
  const request = useRef(0),
    watchdog = useRef<ReturnType<typeof setTimeout>>(undefined);
  const timeRef = useRef(timestampNs),
    onTimeRef = useRef(onTime);
  timeRef.current = timestampNs;
  onTimeRef.current = onTime;

  const start = BigInt(artifact.mcap!.startTime);
  const end = BigInt(artifact.mcap!.endTime);
  const lower = BigInt(range?.startNs ?? start);
  const upper = BigInt(range?.endNs ?? end);
  const needsWindow = artifact.size > videoLimits.input;
  const windowStart = needsWindow || range ? lower : undefined;
  const windowEnd = needsWindow || range ? upper : undefined;
  const fail = (message: string) => {
    setError(message);
    setLoading(false);
    if (!synchronized) onPlayingChange(false);
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
    setClip(undefined);
    const current = new VideoWorker();
    worker.current = current;
    armWatchdog();
    current.onmessage = (event) => {
      const response = event.data;
      if (response.request !== undefined && response.request !== request.current) return;
      clearTimeout(watchdog.current);
      if (response.type === 'cameras') {
        setCameras(response.cameras);
        if (!response.cameras.length) fail('No supported camera channels were found.');
      }
      if (response.type === 'stream') {
        setClip(response.clip);
      }
      if (response.type === 'error') fail(response.error);
    };
    current.onerror = (event) => {
      clearTimeout(watchdog.current);
      fail(`Camera worker failed: ${event.message || 'Inline workers unavailable.'}`);
    };
    if (needsWindow) {
      const port = serveMcapSource(artifact, abort.signal);
      current.postMessage({ type: 'load', size: artifact.size, port }, [port]);
    } else {
      void readBytes(artifact, undefined, false, abort.signal)
        .then((data) => {
          if (!abort.signal.aborted) current.postMessage({ type: 'load', data }, [data]);
        })
        .catch((e) => {
          if (!abort.signal.aborted) {
            clearTimeout(watchdog.current);
            fail(e.message);
          }
        });
    }
    return () => {
      abort.abort();
      current.terminate();
      clearTimeout(watchdog.current);
      worker.current = undefined;
    };
  }, [artifact.id, artifact.revision, needsWindow]);
  useEffect(() => {
    if (!cameras.length || !worker.current || camera === undefined) return;
    const revision = ++request.current;
    setClip(undefined);
    setError('');
    if (
      needsWindow &&
      windowStart !== undefined &&
      windowEnd !== undefined &&
      windowEnd - windowStart > 60000000000n
    ) {
      clearTimeout(watchdog.current);
      fail('Camera playback is limited to 60-second windows.');
      return;
    }
    setLoading(true);
    armWatchdog();
    worker.current.postMessage({
      type: 'stream',
      id: camera,
      request: revision,
      window:
        windowStart !== undefined && windowEnd !== undefined
          ? { start: windowStart, end: windowEnd }
          : undefined,
    });
  }, [camera, cameras, needsWindow, windowStart, windowEnd]);
  useEffect(() => {
    const media = video.current;
    if (!clip || !media) return;
    const url = URL.createObjectURL(new Blob([clip.bytes], { type: 'video/mp4' }));
    let request: number | undefined;
    if (typeof media.requestVideoFrameCallback === 'function') {
      const observe = (_now: number, frame: VideoFrameCallbackMetadata) => {
        media.dataset.frameTimestampNs =
          clip.frames[clipFrameAt(clip, frame.mediaTime)].timestampNs;
        request = media.requestVideoFrameCallback(observe);
      };
      request = media.requestVideoFrameCallback(observe);
    }
    media.src = url;
    return () => {
      if (request !== undefined) media.cancelVideoFrameCallback(request);
      media.pause();
      media.removeAttribute('src');
      media.load();
      delete media.dataset.frameTimestampNs;
      URL.revokeObjectURL(url);
    };
  }, [clip]);

  useEffect(() => {
    const media = video.current;
    if (synchronized || !clip || !media || !media.readyState) return;
    media.pause();
    media.currentTime = Math.max(0, clipSeconds(clip, BigInt(timeRef.current)));
  }, [clip, seekRevision, synchronized]);

  useEffect(() => {
    const media = video.current;
    if (synchronized || !media || !clip || loading || error) return;
    if (!playing) {
      media.pause();
      return;
    }
    if (!media.paused) return;
    // Resuming at the end of a shorter camera track would rewind the video.
    if (media.currentTime >= media.duration) {
      onPlayingChange(false);
      return;
    }
    let active = true;
    void media.play().catch((error) => {
      if (active && error.name !== 'AbortError') onPlayingChange(false);
    });
    return () => {
      active = false;
    };
  }, [clip, error, loading, onPlayingChange, playing, synchronized]);

  useEffect(() => {
    const media = video.current;
    if (!synchronized || !clip || loading || !media?.readyState) return;
    const time = clipSeconds(clip, BigInt(timestampNs));
    const target = Math.max(0, Math.min(time, media.duration));
    const advance = playing && time >= 0 && time < media.duration;
    // Let the recording clock lead all panes while correcting native decoder drift.
    if (!advance) media.pause();
    if (Math.abs(media.currentTime - target) > (advance && !media.paused ? 0.12 : 0.001))
      media.currentTime = target;
    if (advance && media.paused) void media.play().catch(() => {});
  }, [clip, loading, playing, synchronized, timestampNs, seekRevision]);

  const readTime = useCallback(() => {
    const media = video.current;
    if (!clip || !media?.readyState) return;
    const time = BigInt(clip.originNs) + BigInt(Math.round(media.currentTime * 1e9));
    return time < lower ? lower : time > upper ? upper : time;
  }, [clip, lower, upper]);
  useEffect(() => {
    if (!readTimeRef) return;
    readTimeRef.current = readTime;
    return () => {
      if (readTimeRef.current === readTime) readTimeRef.current = null;
    };
  }, [readTime, readTimeRef]);

  const capture = useCallback(() => {
    const frame = video.current;
    if (!frame?.dataset.frameTimestampNs || frame.seeking || frame.readyState < 2) return;
    const scaled = document.createElement('canvas');
    const ratio = Math.min(1, 480 / Math.max(frame.videoWidth, frame.videoHeight));
    scaled.width = Math.max(1, Math.round(frame.videoWidth * ratio));
    scaled.height = Math.max(1, Math.round(frame.videoHeight * ratio));
    const context = scaled.getContext('2d');
    if (!context) return;
    context.drawImage(frame, 0, 0, scaled.width, scaled.height);
    return scaled.toDataURL('image/jpeg', 0.72);
  }, []);
  useEffect(() => {
    if (!captureRef) return;
    captureRef.current = capture;
    return () => {
      if (captureRef.current === capture) captureRef.current = null;
    };
  }, [capture, captureRef]);

  const updateTime = (media: HTMLVideoElement, seeked = false) => {
    if (!clip || media.seeking || media.readyState < 2) return;
    // Seeking within the same frame may leave the video frame callback idle.
    if (
      typeof media.requestVideoFrameCallback !== 'function' ||
      (seeked && !media.dataset.frameTimestampNs)
    )
      media.dataset.frameTimestampNs =
        clip.frames[clipFrameAt(clip, media.currentTime)].timestampNs;
    const time = readTime();
    if (!synchronized && time !== undefined) onTimeRef.current(time);
  };
  const canPlay = !!clip && !loading && !error;
  const shareFrame = () => {
    const media = video.current;
    const frameTime = media?.dataset.frameTimestampNs;
    if (!canPlay || !clip || !media || media.seeking || !frameTime) return;
    let image: string | undefined;
    try {
      image = capture();
    } catch {
      // Share the timestamp if the thumbnail cannot be captured.
    }
    onShareTime(frameTime, clip.camera.id, image);
  };
  return (
    <section className="camera-player" aria-label="MCAP camera video">
      <PreviewPane
        title={title}
        className="camera-screen"
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          shareFrame();
        }}
      >
        <video
          ref={video}
          controls={canPlay && !synchronized}
          controlsList="nodownload"
          playsInline
          aria-label="Recorded camera video"
          aria-keyshortcuts="Shift+Enter"
          data-camera={clip?.camera.topic}
          onLoadedMetadata={({ currentTarget: media }) => {
            if (!clip) return;
            const target = Math.max(0, clipSeconds(clip, BigInt(timeRef.current)));
            if (target > 0) media.currentTime = Math.min(target, media.duration);
          }}
          onLoadedData={({ currentTarget: media }) => {
            if (!clip) return;
            setLoading(false);
            updateTime(media);
          }}
          onTimeUpdate={({ currentTarget: media }) => updateTime(media)}
          onSeeked={({ currentTarget: media }) => updateTime(media, true)}
          onPlay={() => {
            if (!synchronized) onPlayingChange(true);
          }}
          onPause={({ currentTarget: media }) => {
            updateTime(media);
            if (!synchronized) onPlayingChange(false);
          }}
          onEnded={() => {
            if (!synchronized) onPlayingChange(false);
          }}
          onSeeking={({ currentTarget: media }) => {
            delete media.dataset.frameTimestampNs;
            if (!clip) return;
            const min = Math.max(0, clipSeconds(clip, lower));
            if (media.currentTime < min - 0.000001) media.currentTime = min;
          }}
          onError={() => {
            if (clip) fail('This host couldn’t play the camera’s H.264 video.');
          }}
          onKeyDown={(event) => {
            if (event.shiftKey && event.key === 'Enter') {
              event.preventDefault();
              shareFrame();
            }
          }}
        />
        {loading && <span role="status">Loading camera frames…</span>}
      </PreviewPane>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
