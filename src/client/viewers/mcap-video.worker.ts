import { videoRecording } from '../../shared/mcap-video';
import { mcapSource } from './mcap-source';
import { cameraMp4 } from './mcap-mp4';

type Stream = {
  type: 'stream';
  id: number;
  request: number;
  window?: { start: bigint; end: bigint };
};
type Load = { type: 'load'; data: ArrayBuffer } | { type: 'load'; size: number; port: MessagePort };
let recording: Awaited<ReturnType<typeof videoRecording>> | undefined;
let queued: Stream | undefined;
let streaming = false;

async function readStream() {
  if (streaming) return;
  streaming = true;
  try {
    while (queued) {
      const command = queued;
      queued = undefined;
      try {
        if (!recording) throw new Error('Recording is not loaded.');
        const stream = await recording.stream(command.id, command.window);
        if (queued) continue;
        const clip = await cameraMp4(stream, command.window?.start);
        if (!queued)
          self.postMessage(
            { type: 'stream', request: command.request, clip },
            { transfer: [clip.bytes] },
          );
      } catch (error) {
        if (!queued)
          self.postMessage({
            type: 'error',
            request: command.request,
            error: error instanceof Error ? error.message : 'Cannot extract camera video.',
          });
      }
    }
  } finally {
    streaming = false;
  }
}

self.onmessage = async ({ data: command }: MessageEvent<Load | Stream>) => {
  if (command.type === 'stream') {
    queued = command;
    void readStream();
    return;
  }
  try {
    recording = await videoRecording(
      'data' in command ? new Uint8Array(command.data) : mcapSource(command.size, command.port),
    );
    self.postMessage({ type: 'cameras', cameras: recording.cameras });
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : 'Cannot read camera index.',
    });
  }
};
