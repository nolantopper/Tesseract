import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const mediaInputLimit = 4 * 1024 * 1024;
export const mediaOutputLimit = 3 * 1024 * 1024;
export const mediaPreviewSeconds = 20;
let conversions = 0;

export async function convertMedia(bytes: Buffer, kind: 'video' | 'audio', signal: AbortSignal) {
  if (conversions >= 2) throw new Error('Media conversion is busy. Try again.');
  const configured = process.env.TESSERACT_FFMPEG;
  if (configured && !isAbsolute(configured))
    throw new Error('TESSERACT_FFMPEG must specify an absolute executable path.');
  const ffmpeg = configured || 'ffmpeg';
  const output =
    kind === 'video'
      ? [
          '-map',
          '0:V:0',
          '-map',
          '0:a:0?',
          '-vf',
          "scale='min(640,iw)':-2",
          '-r',
          '24',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-b:v',
          '520k',
          '-g',
          '24',
          '-c:a',
          'aac',
          '-b:a',
          '64k',
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof',
          '-f',
          'mp4',
        ]
      : ['-map', '0:a:0', '-c:a', 'libopus', '-b:a', '96k', '-f', 'ogg'];

  conversions++;
  try {
    signal.throwIfAborted();
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-max_alloc',
          '67108864',
          '-threads',
          '1',
          '-filter_threads',
          '1',
          '-protocol_whitelist',
          'pipe',
          '-format_whitelist',
          'avi,mpeg,mpegts,mpegvideo,asf,mov,matroska,flac,aiff,mp3,wav,ogg,aac',
          '-i',
          'pipe:0',
          '-map_metadata',
          '-1',
          '-map_chapters',
          '-1',
          '-t',
          String(mediaPreviewSeconds),
          '-threads',
          '1',
          ...output,
          'pipe:1',
        ],
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
          killSignal: 'SIGKILL',
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
      let size = 0;
      const chunks: Buffer[] = [];
      child.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.code === 'ENOENT'
              ? 'Install FFmpeg to preview this codec.'
              : 'Media conversion stopped.',
          ),
        ),
      );
      child.stdin.on('error', () => {}); // A decoder can finish before consuming the whole input.
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > mediaOutputLimit) {
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      child.once('close', (code) => {
        if (size > mediaOutputLimit) reject(new Error('Converted preview exceeds 3 MiB.'));
        else if (code !== 0 || !size) reject(new Error('Couldn’t convert this media file.'));
        else resolve(Buffer.concat(chunks, size));
      });
      child.stdin.end(bytes);
    });
  } finally {
    conversions--;
  }
}
