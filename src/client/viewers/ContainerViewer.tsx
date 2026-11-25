import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { Artifact, ViewerProps } from '../../shared/types';
import { indexZip, readZipEntry, type ZipEntry } from '../../shared/zip';
import { packageAssetPaths, resolveAssetPath } from '../../shared/asset-path';
import { renameGzipEntry, renameTarEntry, renameZipEntry } from '../../shared/archive-edits';
import {
  canSaveHostFile,
  embeddedParserWorker,
  openLocalFile,
  openPath,
  readBytes,
  readRange,
  releaseLocalFile,
  saveHostFile,
} from '../backend';
import { resolveViewer } from '../registry';
import ArchiveWorker from './archive.worker?worker&inline';
import extendedArchiveWorkerUrl from './extended-archive.worker?worker&url';
import { Icon } from '../Icon';
import InlineRename from '../InlineRename';
import './container.css';

type ZipIndex = Awaited<ReturnType<typeof indexZip>>;
type ArchiveRequest =
  { data: ArrayBuffer; kind: string; name: string } | { data: ArrayBuffer; zipEntry: ZipEntry };
type ArchiveResponse = { error?: string; entries?: Record<string, Uint8Array>; data?: ArrayBuffer };
type Row = { path: string; directory: boolean; name?: string; source?: string };
type SelectedEntry = { path: string; artifact: Artifact; source: string };

async function runArchiveWorker(request: ArchiveRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const worker =
    'zipEntry' in request || request.kind === 'gz' || request.kind === 'tar'
      ? new ArchiveWorker()
      : await embeddedParserWorker(extendedArchiveWorkerUrl, signal);
  if (signal.aborted) {
    worker.terminate();
    signal.throwIfAborted();
  }
  return new Promise<ArchiveResponse>((resolve, reject) => {
    const finish = (error?: unknown, result?: ArchiveResponse) => {
      signal.removeEventListener('abort', cancel);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const cancel = () => finish(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }: MessageEvent<ArchiveResponse>) => {
      if (data.error) finish(new Error(data.error));
      else finish(undefined, data);
    };
    worker.onerror = () => finish(new Error('Couldn’t read archive.'));
    worker.postMessage(request, [request.data]);
  });
}

const leafName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
function archiveRows(paths: Row[], folder: string, query: string) {
  const rows = new Map<string, Row>();
  const prefix = folder ? `${folder}/` : '';
  for (const row of paths) {
    if (query) {
      if (row.path.toLowerCase().includes(query)) rows.set(row.path, row);
      continue;
    }
    if (!row.path.startsWith(prefix)) continue;
    const split = row.path.indexOf('/', prefix.length);
    if (split === -1) rows.set(row.path, row);
    else {
      const path = row.path.slice(0, split);
      rows.set(path, { path, directory: true });
    }
  }
  return [...rows.values()].sort(
    (a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path),
  );
}

export default function ContainerViewer({
  artifact,
  onContext,
  onPreview,
  breadcrumbs = [],
  readAsset: _parentReadAsset,
  ...viewerProps
}: ViewerProps) {
  const [zip, setZip] = useState<ZipIndex>();
  const [packedEntries, setPackedEntries] = useState<Record<string, Uint8Array>>();
  const [selected, setSelected] = useState<SelectedEntry>();
  const [zipPath, setZipPath] = useState('');
  const [folders, setFolders] = useState<Artifact[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [filter, setFilter] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const pendingEntry = useRef<AbortController>(undefined);
  const requestedFocus = useRef<{ path?: string }>(undefined);
  const workspaceFolder = folders.at(-1) ?? (artifact.entries ? artifact : undefined);
  const canRename =
    !workspaceFolder &&
    canSaveHostFile(artifact) &&
    /\.(zip|npz|tar|gz|gzip|tgz)$/i.test(artifact.name);
  const currentPath = workspaceFolder?.path ?? zipPath;
  const readArchive = (signal: AbortSignal) => (offset: number, length: number) =>
    readRange(artifact, offset, length, signal);

  useEffect(() => {
    if (artifact.entries) return;
    if ((artifact.depth ?? 0) >= 3) {
      setError('Archive nesting limit is 3.');
      return;
    }
    const abort = new AbortController();
    const { signal } = abort;
    const timeout = new Error('Archive preview timed out.');
    const timer = setTimeout(() => abort.abort(timeout), 20000);
    setLoading(true);
    const load = async () => {
      if (artifact.format.id === 'zip' || artifact.format.id === 'npz') {
        const index = await indexZip(artifact.size, (offset, length) =>
          readRange(artifact, offset, length, signal),
        );
        if (!signal.aborted) setZip(index);
      } else {
        const bytes = await readBytes(artifact, undefined, false, signal);
        const result = await runArchiveWorker(
          { data: bytes, kind: artifact.format.id, name: artifact.name },
          signal,
        );
        if (!signal.aborted) setPackedEntries(result.entries);
      }
    };
    void load()
      .catch((e: unknown) => {
        if (!signal.aborted || signal.reason === timeout)
          setError(e instanceof Error ? e.message : 'Couldn’t read archive.');
      })
      .finally(() => {
        clearTimeout(timer);
        if (!signal.aborted || signal.reason === timeout) setLoading(false);
      });
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [artifact]);

  useEffect(() => () => pendingEntry.current?.abort(), []);
  useEffect(() => {
    const file = selected?.artifact;
    return () => {
      if (file) releaseLocalFile(file);
    };
  }, [selected]);
  useEffect(() => {
    if (!onContext || ['model', 'mcap', 'container'].includes(selected?.artifact.format.kind ?? ''))
      return;
    const context = {
      kind: 'container' as const,
      entry: selected?.path,
      entryFormat: selected?.artifact.format.id,
    };
    onContext(context);
    if (selected?.artifact.format.id !== 'text') return;
    const abort = new AbortController();
    void readBytes(selected.artifact, 4096, true, abort.signal)
      .then((bytes) => {
        if (abort.signal.aborted) return;
        const textPreview = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
          stream: bytes.byteLength < selected.artifact.size,
        });
        onContext({ ...context, textPreview });
      })
      .catch(() => {});
    return () => abort.abort();
  }, [selected, onContext]);

  const contents = useMemo<Row[]>(
    () =>
      zip
        ? [...zip.entries.values()]
        : Object.keys(packedEntries ?? {}).map((source) => ({
            path: source
              .split('/')
              .filter((part) => part && part !== '.')
              .join('/'),
            directory: false,
            source,
          })),
    [zip, packedEntries],
  );
  const rows = workspaceFolder?.entries ?? contents;
  const query = filter.trim().toLowerCase();
  const visibleRows: Row[] =
    workspaceFolder?.entries?.filter(({ name }) => name.toLowerCase().includes(query)) ??
    archiveRows(contents, zipPath, query);

  useLayoutEffect(() => {
    const focus = requestedFocus.current;
    if (!focus) return;
    requestedFocus.current = undefined;
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const row = buttons.find((button) => button.dataset.path === focus.path) ?? buttons[0];
    row?.focus();
  }, [currentPath, selected]);

  const clearSelection = () => {
    pendingEntry.current?.abort();
    setOpening(false);
    setSelected(undefined);
    onPreview?.(artifact);
    setError('');
    setFilter('');
  };
  const showFolder = (index: number) => {
    const source = selected?.source;
    const segments = (selected ? selected.source.split('/').slice(0, -1).join('/') : zipPath)
      .split('/')
      .filter(Boolean);
    clearSelection();
    if (workspaceFolder) {
      requestedFocus.current = { path: folders[index]?.path ?? source };
      setFolders(folders.slice(0, index));
    } else {
      requestedFocus.current = {
        path: index === segments.length && source ? source : segments.slice(0, index + 1).join('/'),
      };
      setZipPath(segments.slice(0, index).join('/'));
    }
  };
  const folderNames = workspaceFolder
    ? [artifact.name, ...folders.map((folder) => folder.name)]
    : [
        leafName(artifact.name),
        ...(selected ? selected.source.split('/').slice(0, -1) : zipPath.split('/')).filter(
          Boolean,
        ),
      ];
  const folderCrumbs = folderNames.map((name, index) => ({
    name,
    navigate: () => showFolder(index),
  }));
  const trail = [...breadcrumbs, ...folderCrumbs];
  if (selected) trail.push({ name: leafName(selected.source), navigate: undefined });

  const readEntry = async (path: string, signal: AbortSignal) => {
    const row = contents.find((row) => row.path === path && !row.directory);
    if (!row) throw new Error(`Missing asset: ${path}`);
    if (zip) {
      const entry = zip.entries.get(path)!;
      const data = await readZipEntry(entry, readArchive(signal));
      return (await runArchiveWorker({ data, zipEntry: entry }, signal)).data!;
    }
    signal.throwIfAborted();
    return Uint8Array.from(packedEntries![row.source ?? path]).buffer;
  };

  const readSelectedAsset = useMemo(() => {
    const cache = new Map<string, Promise<ArrayBuffer>>();
    let bytes = 0;
    return async (reference: string, signal: AbortSignal): Promise<ArrayBuffer> => {
      signal.throwIfAborted();
      if (!selected) throw new Error('Open a file to load its assets.');
      const packagePaths = packageAssetPaths(reference);
      let path: string;
      let dependency: Artifact | undefined;
      if (workspaceFolder) {
        if (packagePaths) {
          const candidates = await Promise.allSettled(
            packagePaths.map((path) => openPath(`${artifact.path}/${path}`, signal)),
          );
          signal.throwIfAborted();
          const found = candidates.flatMap((result) =>
            result.status === 'fulfilled' && !result.value.entries ? [result.value] : [],
          );
          if (found.length !== 1)
            throw new Error(
              `${found.length ? 'Ambiguous' : 'Missing'} package asset: ${reference}`,
            );
          dependency = found[0];
          path = dependency.path;
        } else {
          path = resolveAssetPath(selected.source, reference);
          dependency = await openPath(path, signal);
        }
        if (dependency.entries) throw new Error(`Asset is a folder: ${reference}`);
      } else if (packagePaths) {
        const found = packagePaths.filter((path) =>
          contents.some((row) => row.path === path && !row.directory),
        );
        if (found.length !== 1)
          throw new Error(`${found.length ? 'Ambiguous' : 'Missing'} package asset: ${reference}`);
        path = found[0];
      } else path = resolveAssetPath(selected.source, reference);
      let pending = cache.get(path);
      if (!pending) {
        const size =
          dependency?.size ??
          zip?.entries.get(path)?.size ??
          packedEntries?.[contents.find((row) => row.path === path)?.source ?? path]?.byteLength;
        if (size === undefined) throw new Error(`Missing asset: ${reference}`);
        if (cache.size >= 64 || size > 64 * 1024 * 1024 - bytes)
          throw new Error('Model assets exceed the 64 MiB or 64 file preview limit.');
        bytes += size;
        pending = dependency
          ? readBytes(dependency, undefined, false, signal)
          : readEntry(path, signal);
        cache.set(path, pending);
      }
      const data = await pending;
      signal.throwIfAborted();
      // The parser can transfer ownership to a worker without detaching the cached copy.
      return data.slice(0);
    };
  }, [artifact, selected, zip, packedEntries, contents, workspaceFolder]);

  const choose = async (row: Row) => {
    pendingEntry.current?.abort();
    const abort = new AbortController();
    pendingEntry.current = abort;
    const { signal } = abort;
    const timeout = new Error('File preview timed out.');
    const timer = setTimeout(() => abort.abort(timeout), 20000);
    setError('');
    setOpening(true);
    let temporaryFile: Artifact | undefined;
    try {
      const { path, directory } = row;
      if (directory) {
        const folder = workspaceFolder ? await openPath(path, signal) : undefined;
        signal.throwIfAborted();
        clearSelection();
        requestedFocus.current = {};
        if (folder) setFolders((ancestors) => [...ancestors, folder]);
        else setZipPath(path);
        return;
      }
      let child: Artifact;
      if (workspaceFolder) {
        child = await openPath(path, signal);
      } else {
        const bytes = await readEntry(path, signal);
        signal.throwIfAborted();
        child = await openLocalFile(new File([bytes], path), signal);
        temporaryFile = child;
        child.depth = (artifact.depth ?? 0) + 1;
      }
      signal.throwIfAborted();
      onPreview?.(child);
      setSelected({
        path: workspaceFolder
          ? [...folders.map((folder) => folder.name), child.name].join('/')
          : path,
        artifact: child,
        source: path,
      });
      temporaryFile = undefined;
    } catch (e) {
      if (!signal.aborted || signal.reason === timeout)
        setError(e instanceof Error ? e.message : 'Couldn’t open file.');
    } finally {
      if (temporaryFile) releaseLocalFile(temporaryFile);
      clearTimeout(timer);
      if (!signal.aborted || signal.reason === timeout) setOpening(false);
    }
  };
  const navigate = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
    const index = buttons.indexOf(event.target);
    const next = {
      ArrowUp: Math.max(0, index - 1),
      ArrowDown: Math.min(buttons.length - 1, index + 1),
      Home: 0,
      End: buttons.length - 1,
    }[event.key];
    if (next !== undefined) buttons[next]?.focus();
    else if (event.key === 'ArrowRight' && event.target.dataset.directory) event.target.click();
    else if (event.key === 'ArrowLeft' && (selected || folderNames.length > 1))
      showFolder(folderNames.length - (selected ? 1 : 2));
    else return;
    event.preventDefault();
  };
  const Viewer = selected && resolveViewer(selected.artifact.format);
  const nested = selected?.artifact.format.kind === 'container';

  return (
    <div className="container-view">
      <div className="container-layout" data-nested={nested || undefined}>
        <aside className="file-list" aria-label="Files" hidden={nested}>
          {!nested && (
            <nav className="file-breadcrumbs" aria-label="Folder location">
              {trail.map(({ name, navigate }, index) => (
                <span key={index}>
                  {index > 0 && <Icon name="chevron" />}
                  {index === trail.length - 1 ? (
                    <span title={name} aria-current="location">
                      {name}
                    </span>
                  ) : (
                    <button type="button" title={name} onClick={navigate}>
                      <span>{name}</span>
                    </button>
                  )}
                </span>
              ))}
            </nav>
          )}
          <div className="file-filter">
            <Icon name="search" />
            <input
              type="search"
              aria-label="Filter entries"
              placeholder="Filter files"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && list.current?.querySelector('button')) {
                  list.current.querySelector('button')?.focus();
                  e.preventDefault();
                }
              }}
            />
          </div>
          <ul ref={list} className="file-entries" onKeyDown={navigate}>
            {visibleRows.map((row) => {
              const active = !row.directory && selected?.source === row.path;
              const label = row.name ?? (query ? row.path : leafName(row.path));
              return (
                <li key={row.path}>
                  <button
                    type="button"
                    aria-pressed={row.directory ? undefined : active}
                    data-path={row.path}
                    data-directory={row.directory || undefined}
                    title={row.path}
                    onClick={() => void choose(row)}
                  >
                    <Icon name={row.directory ? 'folder' : 'file'} />
                    <span>{label}</span>
                    {active && <Icon name="check" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {loading && (
            <p className="preview-note" role="status">
              Reading archive…
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {!loading && !error && !visibleRows.length && (
            <p className="preview-note">{query ? 'No matching files' : 'No files'}</p>
          )}
        </aside>
        <div className="file-preview">
          {selected && canRename && (
            <div className="archive-edit-actions">
              <InlineRename
                key={selected.source}
                label="Rename archive entry"
                value={leafName(selected.source)}
                onSave={async (name) => {
                  const bytes = await readBytes(artifact);
                  let renamed: Uint8Array;
                  if (artifact.format.id === 'tar')
                    renamed = renameTarEntry(bytes, selected.source, name);
                  else if (artifact.format.id === 'gz') renamed = renameGzipEntry(bytes, name);
                  else
                    renamed = await renameZipEntry(
                      bytes,
                      selected.source,
                      name,
                      artifact.format.id === 'npz',
                    );
                  await saveHostFile(artifact, renamed);
                }}
              />
            </div>
          )}
          {selected && Viewer ? (
            <Suspense
              fallback={
                <div className="empty" role="status">
                  Loading preview…
                </div>
              }
            >
              <Viewer
                key={`${selected.artifact.id}:${selected.artifact.revision}`}
                artifact={selected.artifact}
                onContext={onContext}
                onPreview={onPreview}
                {...viewerProps}
                readAsset={readSelectedAsset}
                breadcrumbs={[...breadcrumbs, ...folderCrumbs]}
              />
            </Suspense>
          ) : (
            !loading &&
            !error &&
            rows.length > 0 && (
              <div className="empty" role={opening ? 'status' : undefined}>
                {opening ? 'Opening file…' : 'Select a file'}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
