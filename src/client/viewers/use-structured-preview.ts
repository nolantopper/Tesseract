import { useEffect, useRef, useState } from 'react';
import type { ViewerProps } from '../../shared/types';
import { embeddedParserWorker, readAsset, readRange } from '../backend';
import structuredWorkerUrl from './structured.worker?worker&url';
import type {
  StructuredEdit,
  StructuredOutput,
  StructuredRequest,
  WorkerInput,
  WorkerOutput,
} from './structured';

export function useStructuredPreview<T extends StructuredOutput>(
  artifact: ViewerProps['artifact'],
  companion?: ViewerProps['readAsset'],
) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const send = useRef<(request: StructuredRequest) => void>(undefined);
  const edit = useRef<(request: StructuredEdit) => Promise<Uint8Array>>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let bytes = 0;
    let pendingEdit:
      { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } | undefined;
    const stop = () => {
      clearTimeout(timer);
      controller.abort();
      worker?.terminate();
      send.current = undefined;
      edit.current = undefined;
      pendingEdit?.reject(new Error('The file preview closed before the edit finished.'));
    };
    const fail = (message: string) => {
      stop();
      setError(message);
      setLoading(false);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail('Preview exceeded 20 seconds.'), 20000);
    };
    setData(undefined);
    setLoading(true);
    setError('');
    schedule();
    void embeddedParserWorker(structuredWorkerUrl, signal)
      .then((parser) => {
        if (signal.aborted) {
          parser.terminate();
          return;
        }
        worker = parser;
        const post = (response: WorkerInput, transfer: Transferable[] = []) =>
          parser.postMessage(response, transfer);
        parser.onmessage = async ({ data: result }: MessageEvent<WorkerOutput>) => {
          if (signal.aborted) return;
          if (result.kind === 'edit') {
            clearTimeout(timer);
            if (result.bytes) pendingEdit?.resolve(result.bytes);
            else pendingEdit?.reject(new Error(result.error ?? 'Couldn’t edit the file.'));
            pendingEdit = undefined;
            return;
          }
          if (result.kind === 'result' || result.kind === 'error') {
            clearTimeout(timer);
            setLoading(false);
            if (result.kind === 'result') setData(result.data as T);
            else setError(result.error);
            return;
          }
          const sendBytes = (value: ArrayBuffer) => {
            if (!signal.aborted) post({ kind: 'bytes', id: result.id, data: value }, [value]);
          };
          try {
            const limit = 64 * 1024 * 1024;
            if (result.kind === 'read') {
              if (!Number.isSafeInteger(result.length) || result.length < 0)
                throw new Error('Invalid preview byte range.');
              bytes += result.length;
              if (bytes > limit) throw new Error('Preview exceeds the 64 MiB read limit.');
              sendBytes(await readRange(artifact, result.start, result.length, signal));
            } else {
              if (artifact.format.id !== 'shp' || !['dbf', 'prj', 'cpg'].includes(result.extension))
                throw new Error('Invalid companion file.');
              const name = artifact.name.split(/[\\/]/).at(-1)!;
              const path = encodeURIComponent(name.replace(/\.shp$/i, '') + '.' + result.extension);
              const content = await (companion
                ? companion(path, signal)
                : readAsset(artifact, path, signal));
              bytes += content.byteLength;
              if (bytes > limit) throw new Error('Preview exceeds the 64 MiB read limit.');
              sendBytes(content);
            }
          } catch (error) {
            if (!signal.aborted)
              post({
                kind: 'bytes',
                id: result.id,
                error: error instanceof Error ? error.message : 'Couldn’t read file.',
              });
          }
        };
        parser.onerror = () => fail('Preview worker unavailable.');
        send.current = (request) => {
          if (pendingEdit) return;
          bytes = 0;
          setLoading(true);
          setError('');
          schedule();
          post({ kind: 'inspect', format: artifact.format.id, size: artifact.size, request });
        };
        edit.current = (request) =>
          new Promise((resolve, reject) => {
            if (pendingEdit) {
              reject(new Error('Another file edit is in progress.'));
              return;
            }
            pendingEdit = { resolve, reject };
            bytes = 0;
            schedule();
            post({ kind: 'edit', format: artifact.format.id, size: artifact.size, edit: request });
          });
        send.current({});
      })
      .catch((error: unknown) => {
        if (!signal.aborted)
          fail(error instanceof Error ? error.message : 'Couldn’t open preview.');
      });
    return stop;
  }, [artifact, companion]);
  return {
    data,
    loading,
    error,
    inspect: (request: StructuredRequest) => send.current?.(request),
    edit: (request: StructuredEdit) =>
      edit.current?.(request) ?? Promise.reject(new Error('The preview is unavailable.')),
  };
}
