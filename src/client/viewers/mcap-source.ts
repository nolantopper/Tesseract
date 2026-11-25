import type { IReadable } from '@mcap/core';

export function mcapSource(size: number, port: MessagePort): IReadable {
  let sequence = 0;
  port.start();
  return {
    size: async () => BigInt(size),
    read: (offset, length) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const id = ++sequence;
        const receive = ({ data }: MessageEvent) => {
          if (data.id !== id) return;
          port.removeEventListener('message', receive);
          if (typeof data.error === 'string') reject(new Error(data.error));
          else resolve(new Uint8Array(data.bytes));
        };
        port.addEventListener('message', receive);
        port.postMessage({ id, offset: Number(offset), length: Number(length) });
      }),
  };
}
