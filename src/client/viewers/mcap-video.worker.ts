import { videoRecording } from '../../shared/mcap-video';
let recording: Awaited<ReturnType<typeof videoRecording>> | undefined;
self.onmessage = async (
  event: MessageEvent<
    { type: 'load'; data: ArrayBuffer } | { type: 'stream'; id: number; request: number }
  >,
) => {
  const command = event.data;
  try {
    if (command.type === 'load') {
      recording = await videoRecording(new Uint8Array(command.data));
      self.postMessage({ type: 'cameras', cameras: recording.cameras });
    } else {
      if (!recording) throw new Error('Recording is not loaded.');
      const stream = await recording.stream(command.id);
      self.postMessage(
        { type: 'stream', request: command.request, stream },
        { transfer: stream.samples.map((s) => s.data.buffer) },
      );
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      request: command.type === 'stream' ? command.request : undefined,
      error: error instanceof Error ? error.message : 'Cannot extract camera video.',
    });
  }
};
