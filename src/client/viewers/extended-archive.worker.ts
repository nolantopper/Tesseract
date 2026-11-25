import { unpackExtended } from './extended-archive';

self.onmessage = async ({
  data,
}: MessageEvent<{ data: ArrayBuffer; kind: string; name: string }>) => {
  try {
    const entries = await unpackExtended(data.data, data.kind, data.name);
    self.postMessage(
      { entries },
      { transfer: Object.values(entries).map((entry) => entry.buffer) },
    );
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Couldn’t read archive.' });
  }
};
