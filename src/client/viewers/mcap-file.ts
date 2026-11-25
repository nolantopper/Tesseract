import type { Artifact } from '../../shared/types';
import type {
  McapPlot,
  McapPlotSeries,
  McapRecordingRequest,
  McapSample,
} from '../../shared/mcap-recording';
import type { ViewSample } from '../../shared/view';
import { readRange } from '../backend';
import RecordingWorker from './mcap-recording.worker?worker&inline';

export function serveMcapSource(artifact: Artifact, signal: AbortSignal) {
  signal.throwIfAborted();
  const { port1, port2 } = new MessageChannel();
  signal.addEventListener('abort', () => port1.close(), { once: true });
  port1.onmessage = async ({ data: { id, offset, length } }) => {
    try {
      const bytes = await readRange(artifact, offset, length, signal);
      port1.postMessage({ id, bytes }, [bytes]);
    } catch (error) {
      port1.postMessage({
        id,
        error: error instanceof Error ? error.message : 'Cannot read MCAP.',
      });
    }
  };
  return port2;
}

export function sampleMcap(artifact: Artifact, sample: McapSample, signal: AbortSignal) {
  return readRecording<ViewSample[]>(artifact, { kind: 'sample', query: sample }, signal);
}

export function plotMcap(artifact: Artifact, plot: McapPlot, signal: AbortSignal) {
  return readRecording<McapPlotSeries[]>(artifact, { kind: 'plot', query: plot }, signal);
}

export function renameMcapTopic(
  artifact: Artifact,
  channelId: number,
  topic: string,
  signal: AbortSignal,
) {
  return readRecording<Uint8Array>(artifact, { kind: 'rename', channelId, topic }, signal);
}

function readRecording<Result>(
  artifact: Artifact,
  request: McapRecordingRequest,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const reader = new AbortController();
  const port = serveMcapSource(artifact, reader.signal);
  return new Promise<Result>((resolve, reject) => {
    const worker = new RecordingWorker();
    const close = () => {
      reader.abort();
      worker.terminate();
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      close();
      reject(new Error('Recording read cancelled.'));
    };
    const timer = setTimeout(() => {
      close();
      reject(new Error('Recording read timed out. Try a shorter range.'));
    }, 20000);
    worker.onmessage = ({ data }) => {
      close();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = () => {
      close();
      reject(new Error('Recording worker unavailable.'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    else worker.postMessage({ size: artifact.size, port, request }, [port]);
  });
}
