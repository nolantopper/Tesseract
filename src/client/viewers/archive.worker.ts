import { unpack } from '../../shared/archives';
import { decodeZipEntry, type ZipEntry } from '../../shared/zip';

type ArchiveRequest =
  | { data: ArrayBuffer; kind: string; name: string }
  | { data: ArrayBuffer; zipEntry: Pick<ZipEntry, 'size' | 'method' | 'checksum'> };

self.onmessage = ({ data: request }: MessageEvent<ArchiveRequest>) => {
  try {
    if ('zipEntry' in request) {
      const data = decodeZipEntry(request.data, request.zipEntry);
      self.postMessage({ data }, { transfer: [data] });
      return;
    }
    const entries = unpack(new Uint8Array(request.data), request.kind, request.name);
    self.postMessage(
      { entries },
      { transfer: Object.values(entries).map((b) => b.buffer as ArrayBuffer) },
    );
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Invalid archive.' });
  }
};
