import {
  BufferSource,
  BufferTarget,
  Conversion,
  FLAC,
  FlacOutputFormat,
  Input,
  MATROSKA,
  MkvOutputFormat,
  MP3,
  MP4,
  MovOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OGG,
  OggOutputFormat,
  Output,
  QTFF,
  WAVE,
  WEBM,
  WavOutputFormat,
  WebMOutputFormat,
} from 'mediabunny';

const formats = {
  mp4: [MP4, Mp4OutputFormat],
  m4v: [MP4, Mp4OutputFormat],
  mov: [QTFF, MovOutputFormat],
  mkv: [MATROSKA, MkvOutputFormat],
  mka: [MATROSKA, MkvOutputFormat],
  webm: [WEBM, WebMOutputFormat],
  weba: [WEBM, WebMOutputFormat],
  mp3: [MP3, Mp3OutputFormat],
  wav: [WAVE, WavOutputFormat],
  ogg: [OGG, OggOutputFormat],
  flac: [FLAC, FlacOutputFormat],
} as const;

export function canTrimMedia(format: string): format is keyof typeof formats {
  return Object.hasOwn(formats, format);
}

export async function trimMedia(
  bytes: ArrayBuffer,
  format: keyof typeof formats,
  start: number,
  end: number,
  signal: AbortSignal,
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
    throw new Error('Choose a start time before the end time.');
  signal.throwIfAborted();
  const [inputFormat, OutputFormat] = formats[format];
  const input = new Input({ source: new BufferSource(bytes), formats: [inputFormat] });
  try {
    const duration = await input.computeDuration();
    if (end > duration + 0.005) throw new Error('The trim range exceeds the recording.');
    if (start === 0 && end >= duration) throw new Error('Trim the start or end to save a change.');
    const target = new BufferTarget();
    const output = new Output({ format: new OutputFormat(), target });
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start, end: Math.min(end, duration) },
      copy: { mode: 'forced', boundaryPolicy: 'shrink', shiftTolerance: 0.1 },
      // Carry creation time and other supported tags through the remux.
      tags: (tags) => tags,
      showWarnings: false,
    });
    if (!conversion.isValid || conversion.discardedTracks.length)
      throw new Error('This range cannot be trimmed while preserving all tracks and codecs.');
    const abort = () => void conversion.cancel().catch(() => {});
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    try {
      await conversion.execute();
    } finally {
      signal.removeEventListener('abort', abort);
    }
    signal.throwIfAborted();
    if (!target.buffer?.byteLength) throw new Error('This range produced no media.');
    return target.buffer;
  } finally {
    input.dispose();
  }
}
