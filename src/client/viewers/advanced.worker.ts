import { decodeAdditionalModel } from './additional-models';

self.onmessage = async ({
  data,
}: MessageEvent<{ format: string; data: ArrayBuffer; wasm?: ArrayBuffer }>) => {
  try {
    const { parts } = await decodeAdditionalModel(data.format, data.data, data.wasm);
    const transfer = parts.flatMap((part) => {
      const buffers = Object.values(part.attributes).map(
        (attribute) => attribute.array.buffer as ArrayBuffer,
      );
      if (part.index) buffers.push(part.index.buffer as ArrayBuffer);
      return buffers;
    });
    self.postMessage({ parts }, { transfer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Malformed model.' });
  }
};
