import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { frameAt, keyframeAt, type Camera, type CameraStream } from '../../shared/mcap-video';

const ticksPerSecond = 57_600;
export interface CameraClip {
  camera: Camera;
  bytes: ArrayBuffer;
  originNs: string;
  frames: { tick: number; timestampNs: string }[];
}

export const clipSeconds = (clip: CameraClip, time: bigint) =>
  Number(time - BigInt(clip.originNs)) / 1e9;

export function clipFrameAt(clip: CameraClip, time: number) {
  const tick = Math.round(time * ticksPerSecond);
  let first = 0;
  let end = clip.frames.length;
  while (first < end) {
    const mid = (first + end) >>> 1;
    if (clip.frames[mid].tick <= tick) first = mid + 1;
    else end = mid;
  }
  return Math.max(0, first - 1);
}

export async function cameraMp4(stream: CameraStream, lower?: bigint): Promise<CameraClip> {
  const first =
    lower === undefined ? 0 : keyframeAt(stream.samples, frameAt(stream.samples, lower));
  const samples = stream.samples.slice(first);
  const originNs = samples[0].timestampNs;
  const origin = BigInt(originNs);
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const track = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(track, { frameRate: ticksPerSecond });
  await output.start();
  let lastTick = -1;
  const frames = samples.map(({ timestampNs }) => {
    const elapsed = Number(BigInt(timestampNs) - origin) / 1e9;
    // Preserve separate frames when the source log times round to the same MP4 tick.
    lastTick = Math.max(lastTick + 1, Math.round(elapsed * ticksPerSecond));
    return { timestampNs, tick: lastTick };
  });
  for (const [i, sample] of samples.entries()) {
    const { tick } = frames[i];
    const duration = frames[i + 1]
      ? frames[i + 1].tick - tick
      : frames[i - 1]
        ? tick - frames[i - 1].tick
        : ticksPerSecond / 30;
    await track.add(
      new EncodedPacket(
        sample.data,
        sample.key ? 'key' : 'delta',
        tick / ticksPerSecond,
        duration / ticksPerSecond,
      ),
      i === 0
        ? {
            decoderConfig: {
              codec: stream.codec,
              codedWidth: stream.width,
              codedHeight: stream.height,
            },
          }
        : undefined,
    );
  }
  await output.finalize();
  if (!target.buffer) throw new Error('Couldn’t prepare MP4 playback.');
  return { camera: stream.camera, bytes: target.buffer, originNs, frames };
}
