import { unpack } from '../../shared/archives';
self.onmessage = (event: MessageEvent<{ data: ArrayBuffer; kind: string; name: string }>) => {
  try {
    const entries = unpack(new Uint8Array(event.data.data), event.data.kind, event.data.name);
    self.postMessage(
      { entries },
      { transfer: Object.values(entries).map((b) => b.buffer as ArrayBuffer) },
    );
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Invalid archive.' });
  }
};
