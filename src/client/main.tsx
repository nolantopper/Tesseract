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
  artifactChangedEvent,
  artifactRefreshDelay,
  cancelHostFile,
  canRefreshArtifact,
  canRetryHostFile,
  clearSelection,
  connect,
  hasPendingArtifactUpdate,
  openLocalFile,
  releaseLocalFile,
  retryHostFile,
  select,
  state,
  toggleFullscreen,
} from './backend';
import { resolveViewer } from './registry';
import { Icon } from './Icon';
import { useSharedView } from './view-session';
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
  const [activePreview, setActivePreview] = useState<{ owner: Artifact; artifact: Artifact }>();
  const activeArtifact =
    activePreview && activePreview.owner === artifact ? activePreview.artifact : artifact;
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filePicker, setFilePicker] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [saveCopy, setSaveCopy] = useState<{ artifact: Artifact; run: () => Promise<void> }>();
  const [saving, setSaving] = useState<Artifact>();
  const input = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const pendingFile = useRef<AbortController | null>(null);
  const { addToChat, reference, recordSelection, viewerProps } = useSharedView(
    activeArtifact,
    setMessage,
    setError,
  );
  const onPreview = useCallback(
    (current: Artifact) => {
      if (artifact) setActivePreview({ owner: artifact, artifact: current });
    },
    [artifact],
  );
  const openFile = async (file: File) => {
    cancelHostFile();
    pendingFile.current?.abort();
    const controller = new AbortController();
    pendingFile.current = controller;
    setError('');
    setOpeningFile(true);
    try {
      const next = await openLocalFile(file, controller.signal);
      if (controller.signal.aborted) releaseLocalFile(next);
      else setArtifact(next);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'Couldn’t open file.');
    } finally {
      if (!controller.signal.aborted) setOpeningFile(false);
    }
  };
  const copyReference = async () => {
    if (!reference) return;
    try {
      await navigator.clipboard.writeText(reference);
      setMessage('Reference copied');
    } catch {
      referenceInput.current?.focus();
      referenceInput.current?.select();
    }
  };
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
      (fullscreen, available) => {
        setIsFullscreen(fullscreen);
        setCanFullscreen(available);
      },
    ).catch((e) => setError(e.message));
    return () => pendingFile.current?.abort();
  }, []);
  useEffect(() => {
    if (!artifact || !canRefreshArtifact(artifact)) return;
    const controller = new AbortController();
    let checking = false;
    let queued = false;
    let timer: number | undefined;
    const schedule = () => {
      clearTimeout(timer);
      const delay = artifactRefreshDelay(artifact);
      if (delay !== undefined && !controller.signal.aborted)
        timer = window.setTimeout(() => {
          if (artifactRefreshDelay(artifact) !== undefined) void check();
        }, delay);
    };
    const check = async () => {
      if (controller.signal.aborted || document.hidden) return;
      if (checking) {
        queued = true;
        return;
      }
      clearTimeout(timer);
      checking = true;
      try {
        const next = await state(artifact, controller.signal);
        if (!controller.signal.aborted)
          setArtifact((current) =>
            current !== artifact || (current.id === next.id && current.revision === next.revision)
              ? current
              : next,
          );
      } catch (error) {
        if (!controller.signal.aborted && !artifact.id.startsWith('local-'))
          setError((error as Error).message);
      } finally {
        checking = false;
        if (queued) {
          queued = false;
          void check();
        } else schedule();
      }
    };
    window.addEventListener(artifactChangedEvent, check);
    document.addEventListener('visibilitychange', check);
    if (hasPendingArtifactUpdate(artifact)) void check();
    else schedule();
    return () => {
      clearTimeout(timer);
      controller.abort();
      window.removeEventListener(artifactChangedEvent, check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [artifact]);
  const fullscreen = useCallback(() => {
    if (!canFullscreen) return;
    toggleFullscreen()
      .then(setIsFullscreen)
      .catch((e) => setError(e.message));
  }, [canFullscreen]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && isFullscreen && canFullscreen) {
        e.preventDefault();
        e.stopPropagation();
        fullscreen();
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
      if (e.key.toLowerCase() === 'f') fullscreen();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [fullscreen, isFullscreen, canFullscreen]);
  useEffect(() => {
    setMessage('');
  }, [activeArtifact?.id, activeArtifact?.revision]);
  useEffect(
    () => () => {
      if (artifact) releaseLocalFile(artifact);
    },
    [artifact],
  );
  const onSelect = useCallback(
    (selection: Selection) => {
      recordSelection(selection);
      void select(selection).catch((e) => setError(e.message));
    },
    [recordSelection],
  );
  const onDeselect = useCallback(
    (opened: Artifact) => {
      recordSelection(undefined);
      void clearSelection(opened).catch((e) => setError(e.message));
    },
    [recordSelection],
  );
  const onSaveCopy = useCallback(
    (run?: () => Promise<void>) => {
      setSaveCopy((previous) =>
        run && activeArtifact
          ? { artifact: activeArtifact, run }
          : previous?.artifact === activeArtifact
            ? undefined
            : previous,
      );
    },
    [activeArtifact],
  );
  const exportModel = async () => {
    if (!saveCopy || saveCopy.artifact !== activeArtifact || saving === activeArtifact) return;
    setSaving(activeArtifact);
    try {
      await saveCopy.run();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Couldn’t save model.');
    } finally {
      setSaving((current) => (current === activeArtifact ? undefined : current));
    }
  };
  const Renderer = artifact && resolveViewer(artifact.format);
  let preview: ReactNode;
  if (artifact && Renderer) {
    preview = (
      <PreviewBoundary key={`${artifact.id}-${artifact.revision}`}>
        <Suspense
          fallback={
            <div className="empty" role="status">
              Loading preview…
            </div>
          }
        >
          <Renderer
            artifact={artifact}
            onSelect={onSelect}
            onDeselect={onDeselect}
            onSaveCopy={onSaveCopy}
            onPreview={onPreview}
            {...viewerProps}
          />
        </Suspense>
      </PreviewBoundary>
    );
  } else if (!openingFile && (filePicker || error)) {
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
  } else if (!openingFile) {
    preview = (
      <div className="empty" role="status">
        Waiting for file…
      </div>
    );
  }
  return (
    <main
      className="viewer"
      aria-label={artifact?.name ?? 'Tesseract'}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        const file = event.dataTransfer.files[0];
        if (!file) return;
        event.preventDefault();
        void openFile(file);
      }}
    >
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
      {reference && (
        <div className="view-reference">
          <input ref={referenceInput} aria-label="View reference" value={reference} readOnly />
          <button type="button" onClick={() => void copyReference()}>
            Copy reference
          </button>
        </div>
      )}
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
      <section
        className="viewport"
        aria-label="Artifact preview"
        onClickCapture={(event) => {
          // Chromium handles fullscreen on the preceding clicks, before dblclick.
          if (event.target instanceof HTMLVideoElement && event.detail > 0) event.preventDefault();
        }}
        onDoubleClick={(event) => {
          if (
            activeArtifact?.format.kind === 'model' ||
            activeArtifact?.format.kind === 'mcap' ||
            openingFile
          )
            return;
          if (
            event.target instanceof Element &&
            event.target.closest('button, input, textarea, select, summary, a, [role="button"]')
          )
            return;
          void addToChat();
        }}
      >
        {preview}
        {(canFullscreen || (saveCopy && saveCopy.artifact === activeArtifact)) && (
          <div className="preview-actions" role="group" aria-label="Preview actions">
            {saveCopy && saveCopy.artifact === activeArtifact && (
              <button
                type="button"
                className="icon-button"
                aria-label="Save copy"
                title="Save copy"
                disabled={saving === activeArtifact || openingFile}
                onClick={() => void exportModel()}
              >
                <Icon name="download" />
              </button>
            )}
            {canFullscreen && (
              <button
                type="button"
                className="icon-button"
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                title={`${isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} (F)`}
                onClick={fullscreen}
              >
                <Icon name={isFullscreen ? 'collapse' : 'expand'} />
              </button>
            )}
          </div>
        )}
        {openingFile && (
          <div className="opening-file">
            <span role="status">Opening file…</span>
            <button
              type="button"
              onClick={() => {
                pendingFile.current?.abort();
                setOpeningFile(false);
                setFilePicker(true);
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </section>
      {artifact && message && (
        <footer>
          <span className="status" role="status">
            {message}
          </span>
        </footer>
      )}
    </main>
  );
}
if (window.parent !== window) {
  const root = createRoot(document.getElementById('root')!);
  window.addEventListener('tesseract-teardown', () => root.unmount(), { once: true });
  root.render(<Viewer />);
}
