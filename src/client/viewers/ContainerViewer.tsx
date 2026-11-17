import { Suspense, useEffect, useState } from 'react';
import type { Artifact, ViewerProps } from '../../shared/types';
import { openLocalFile, openPath, readBytes } from '../backend';
import { resolveViewer } from '../registry';
import ArchiveWorker from './archive.worker?worker&inline';
import { Icon } from '../Icon';
export default function ContainerViewer({ artifact, onSelect }: ViewerProps) {
  const [entries, setEntries] = useState<Record<string, Uint8Array>>({});
  const [selected, setSelected] = useState<Artifact>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    setSelected(undefined);
    setEntries({});
    setError('');
    setLoading(false);
    if (artifact.entries) return;
    if ((artifact.depth ?? 0) >= 3) {
      setError('Archive nesting limit is 3.');
      return;
    }
    const abort = new AbortController();
    const worker = new ArchiveWorker();
    setLoading(true);
    const timer = setTimeout(() => {
      worker.terminate();
      setLoading(false);
      setError('Archive parsing exceeded 20 seconds.');
    }, 20000);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      worker.terminate();
      setLoading(false);
      if (event.data.error) setError(event.data.error);
      else setEntries(event.data.entries);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      setLoading(false);
      setError('Archive worker failed.');
    };
    readBytes(artifact, undefined, false, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted)
          worker.postMessage({ data, kind: artifact.format.id, name: artifact.name }, [data]);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          clearTimeout(timer);
          worker.terminate();
          setLoading(false);
          setError(e.message);
        }
      });
    return () => {
      abort.abort();
      worker.terminate();
      clearTimeout(timer);
    };
  }, [artifact]);
  const names = artifact.entries?.map((e) => e.name) ?? Object.keys(entries).sort();
  const visibleNames = names.filter((name) => name.toLowerCase().includes(filter.toLowerCase()));
  const choose = async (name: string) => {
    setError('');
    try {
      const entry = artifact.entries?.find((e) => e.name === name);
      const child = entry
        ? await openPath(entry.path)
        : await openLocalFile(
            new File([Uint8Array.from(entries[name]).buffer], name),
            new AbortController().signal,
          );
      if (!entry) child.depth = (artifact.depth ?? 0) + 1;
      setSelected(child);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot open entry.');
    }
  };
  const Viewer = selected && resolveViewer(selected.format);
  return (
    <div className="container-view">
      <div className="container-layout">
        <aside className="file-list" aria-label="Files">
          <div className="file-filter">
            <Icon name="search" />
            <input
              type="search"
              aria-label="Filter entries"
              placeholder="Filter files"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <ul className="file-entries">
            {visibleNames.map((name) => (
              <li key={name}>
                <button
                  aria-pressed={selected?.name === name}
                  title={name}
                  onClick={() => void choose(name)}
                >
                  <Icon
                    name={
                      artifact.entries?.find((e) => e.name === name)?.directory ? 'folder' : 'file'
                    }
                  />
                  <span>{name}</span>
                  {selected?.name === name && <Icon name="check" />}
                </button>
              </li>
            ))}
          </ul>
          {loading && (
            <p className="preview-note" role="status">
              Reading archive…
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {!loading && !error && !visibleNames.length && (
            <p className="preview-note">{filter ? 'No matching files' : 'No files'}</p>
          )}
        </aside>
        <div className="file-preview">
          {selected && Viewer ? (
            <Suspense
              fallback={
                <div className="empty" role="status">
                  Loading preview…
                </div>
              }
            >
              <Viewer
                key={`${selected.id}:${selected.revision}`}
                artifact={selected}
                onSelect={onSelect}
              />
            </Suspense>
          ) : (
            !loading && !error && names.length > 0 && <div className="empty">Select a file</div>
          )}
        </div>
      </div>
    </div>
  );
}
