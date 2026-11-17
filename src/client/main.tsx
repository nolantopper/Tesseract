import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import type { Artifact, Selection } from '../shared/types';
import {
  canRetryHostFile,
  connect,
  embedded,
  openLocalFile,
  retryHostFile,
  select,
  state,
  stateById,
  toggleFullscreen,
} from './backend';
import { resolveViewer } from './registry';
import { Icon } from './Icon';
import './style.css';

class PreviewBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="empty" role="alert">
        {this.state.error}
      </div>
    ) : (
      this.props.children
    );
  }
}
function Viewer() {
  const [artifact, setArtifact] = useState<Artifact>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filePicker, setFilePicker] = useState(
    () => !embedded && !new URLSearchParams(location.hash.slice(1)).has('artifact'),
  );
  const [openingFile, setOpeningFile] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pendingFile = useRef<AbortController | null>(null);
  const openFile = async (file: File) => {
    pendingFile.current?.abort();
    const controller = new AbortController();
    pendingFile.current = controller;
    setError('');
    setOpeningFile(true);
    try {
      const next = await openLocalFile(file, controller.signal);
      if (!controller.signal.aborted) setArtifact(next);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'Couldn’t open file.');
    } finally {
      if (!controller.signal.aborted) setOpeningFile(false);
    }
  };
  const refresh = useCallback(async () => {
    if (!artifact) return;
    try {
      const next = await state(artifact);
      setArtifact((current) =>
        current?.id !== artifact.id || current.revision === next.revision ? current : next,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, [artifact]);
  useEffect(() => {
    const showArtifact = (a: Artifact) => {
      pendingFile.current?.abort();
      setOpeningFile(false);
      setArtifact(a);
      setError('');
    };
    connect(
      showArtifact,
      (theme) => {
        document.documentElement.dataset.theme = theme;
      },
      setError,
      () => setFilePicker(true),
    ).catch((e) => setError(e.message));
    const navigate = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get('artifact');
      if (id)
        stateById(id)
          .then((a) => {
            if (new URLSearchParams(location.hash.slice(1)).get('artifact') === id) showArtifact(a);
          })
          .catch((e) => setError(e.message));
    };
    navigate();
    window.addEventListener('hashchange', navigate);
    return () => {
      pendingFile.current?.abort();
      window.removeEventListener('hashchange', navigate);
    };
  }, []);
  useEffect(() => {
    if (!artifact || artifact.id.startsWith('local-')) return;
    const timer = window.setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [artifact, refresh]);
  const fullscreen = useCallback(() => {
    toggleFullscreen().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.toLowerCase() === 'f') fullscreen();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [fullscreen]);
  useEffect(() => {
    setMessage('');
  }, [artifact?.id, artifact?.revision]);
  const onSelect = useCallback((selection: Selection) => {
    select(selection)
      .then((shared) =>
        setMessage(
          shared
            ? selection.kind === 'object'
              ? `Selected ${selection.objectName || selection.objectId} · available to agent`
              : `Selected ${selection.timestampNs} ns · available to agent`
            : 'Local selection · open by workspace path to share',
        ),
      )
      .catch((e) => setError(e.message));
  }, []);
  const Renderer = artifact && resolveViewer(artifact.format);
  let preview: ReactNode;
  if (openingFile) {
    preview = (
      <div className="empty" role="status">
        Opening file…
      </div>
    );
  } else if (artifact && Renderer) {
    preview = (
      <PreviewBoundary key={`${artifact.id}-${artifact.revision}`}>
        <Suspense
          fallback={
            <div className="empty" role="status">
              Loading preview…
            </div>
          }
        >
          <Renderer artifact={artifact} onSelect={onSelect} />
        </Suspense>
      </PreviewBoundary>
    );
  } else if (filePicker) {
    preview = (
      <div className="file-drop">
        <span className="file-drop-icon">
          <Icon name="file" />
        </span>
        <button type="button" className="primary-button" onClick={() => input.current?.click()}>
          Open file
        </button>
        <span>or drop a file here</span>
      </div>
    );
  } else {
    preview = (
      <div className="empty" role="status">
        Waiting for file…
      </div>
    );
  }
  return (
    <main
      className="viewer"
      onDragOver={(event) => {
        if (filePicker && event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        const file = event.dataTransfer.files[0];
        if (!filePicker || !file) return;
        event.preventDefault();
        void openFile(file);
      }}
    >
      {filePicker && (
        <input
          ref={input}
          hidden
          type="file"
          aria-label="Choose a file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void openFile(file);
          }}
        />
      )}
      <header className="toolbar">
        <span className="file-icon">
          <Icon name="file" />
        </span>
        <span className="filename" title={artifact?.path}>
          {artifact?.name ?? 'Tesseract'}
        </span>
        {artifact && <span className="badge">{artifact.format.label}</span>}
        <div className="spacer" />
        {filePicker && artifact && (
          <button
            type="button"
            className="icon-button"
            aria-label="Open file"
            title="Open file"
            onClick={() => input.current?.click()}
          >
            <Icon name="folder" />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Toggle fullscreen"
          title="Toggle fullscreen (F)"
          onClick={fullscreen}
        >
          <Icon name="expand" />
        </button>
      </header>
      {error && (
        <div className="error" role="alert">
          <span>{error}</span>
          {canRetryHostFile() && (
            <button
              onClick={() => {
                setError('');
                void retryHostFile();
              }}
            >
              Retry file
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Dismiss error"
            title="Dismiss error"
            onClick={() => setError('')}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      <section className="viewport" aria-label="Artifact preview">
        {preview}
      </section>
      {artifact && (
        <footer>
          <span title={`${artifact.size.toLocaleString()} bytes`}>
            {artifact.size < 1024
              ? `${artifact.size} B`
              : artifact.size < 1024 * 1024
                ? `${(artifact.size / 1024).toFixed(1)} KB`
                : `${(artifact.size / 1024 / 1024).toFixed(1)} MB`}
          </span>
          <span className="status" role="status">
            {message}
          </span>
        </footer>
      )}
    </main>
  );
}
const root = createRoot(document.getElementById('root')!);
window.addEventListener('tesseract-teardown', () => root.unmount(), { once: true });
root.render(<Viewer />);
