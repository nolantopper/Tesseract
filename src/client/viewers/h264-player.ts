import { keyframeAt, type CameraStream } from '../../shared/mcap-video';

// Encoded access units stay bounded; decoded frames are painted and closed
// immediately. Only up to six decode requests are queued at a time.
export class H264Player {
  private decoder?: VideoDecoder;
  private decoded = -1;
  private requested?: { index: number; continuous: boolean };
  private busy = false;
  private disposed = false;
  private generation = 0;
  private targetUs = 0;
  constructor(
    private stream: CameraStream,
    private canvas: HTMLCanvasElement,
    private startNs: bigint,
    private failure: (error: string) => void,
  ) {}
  static async supported(stream: CameraStream) {
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined')
      throw new Error(
        'This browser or native panel does not expose WebCodecs VideoDecoder. Open this recording in a WebCodecs-capable local browser.',
      );
    const result = await VideoDecoder.isConfigSupported({
      codec: stream.codec,
      codedWidth: stream.width,
      codedHeight: stream.height,
      optimizeForLatency: true,
    });
    if (!result.supported) throw new Error(`This host cannot decode H.264 (${stream.codec}).`);
  }
  request(index: number, continuous: boolean) {
    if (this.disposed) return;
    this.requested = { index, continuous };
    this.targetUs = this.time(index);
    if (!continuous) {
      this.generation++;
      this.reset();
    }
    if (!this.busy) void this.drain();
  }
  private time(index: number) {
    return Number((BigInt(this.stream.samples[index].timestampNs) - this.startNs) / 1000n);
  }
  private reset() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
    this.decoded = -1;
  }
  private async drain() {
    this.busy = true;
    try {
      while (this.requested && !this.disposed) {
        const { index, continuous } = this.requested;
        this.requested = undefined;
        const generation = this.generation;
        if (!this.decoder || index < this.decoded) {
          this.reset();
          this.decoder = new VideoDecoder({
            output: (frame) => {
              try {
                if (
                  !this.disposed &&
                  generation === this.generation &&
                  frame.timestamp <= this.targetUs
                ) {
                  const { width, height } = this.stream;
                  if (frame.displayWidth !== width || frame.displayHeight !== height)
                    throw new Error('Decoded video dimensions changed unexpectedly.');
                  this.canvas.width = width;
                  this.canvas.height = height;
                  const context = this.canvas.getContext('2d');
                  if (!context) throw new Error('Video canvas is unavailable.');
                  context.drawImage(frame, 0, 0, width, height);
                  this.canvas.dataset.frameTimestampNs = String(
                    this.startNs + BigInt(frame.timestamp) * 1000n,
                  );
                }
              } catch (error) {
                this.failure(
                  error instanceof Error ? error.message : 'Cannot display video frame.',
                );
              } finally {
                frame.close();
              }
            },
            error: (error) => {
              if (!this.disposed && generation === this.generation) {
                this.failure(`H.264 decode failed: ${error.message}`);
                this.reset();
              }
            },
          });
          this.decoder.configure({
            codec: this.stream.codec,
            codedWidth: this.stream.width,
            codedHeight: this.stream.height,
            optimizeForLatency: true,
          });
          this.decoded = keyframeAt(this.stream.samples, index) - 1;
        }
        const decoder = this.decoder;
        while (this.decoded < index && !this.disposed && generation === this.generation) {
          const next = this.stream.samples[++this.decoded];
          decoder.decode(
            new EncodedVideoChunk({
              type: next.key ? 'key' : 'delta',
              timestamp: this.time(this.decoded),
              data: next.data,
            }),
          );
          if (decoder.decodeQueueSize >= 6)
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => finish(new Error('Video decoder exceeded 5 seconds.')),
                5000,
              );
              const finish = (error?: Error) => {
                clearTimeout(timeout);
                decoder.removeEventListener('dequeue', ready);
                error ? reject(error) : resolve();
              };
              const ready = () => {
                if (decoder.decodeQueueSize < 6) finish();
              };
              decoder.addEventListener('dequeue', ready);
            });
        }
        // A seek can close this decoder while backpressure yields to the UI.
        if (this.disposed || generation !== this.generation) continue;
        if (!continuous || index === this.stream.samples.length - 1) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (decoder.state !== 'closed') decoder.close();
              reject(new Error('Video decoder flush exceeded 5 seconds.'));
            }, 5000);
            decoder
              .flush()
              .then(resolve, reject)
              .finally(() => clearTimeout(timer));
          });
          if (generation === this.generation) this.reset();
        }
      }
    } catch (error) {
      if (!this.disposed && !(error instanceof DOMException && error.name === 'AbortError'))
        this.failure(error instanceof Error ? error.message : 'Video decode failed.');
    } finally {
      this.busy = false;
      if (this.requested && !this.disposed) void this.drain();
    }
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.requested = undefined;
    this.reset();
  }
}
