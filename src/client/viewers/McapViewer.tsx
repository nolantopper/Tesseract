import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DataViewer from './DataViewer';
import { isCamera, isPlot, layoutPanes } from '../../shared/mcap-layout';
import type { Selection, Topic, ViewerProps } from '../../shared/types';
import { videoLimits } from '../../shared/mcap-video';
import type { McapPane } from '../../shared/view';
import McapPlot, { McapPlayback, useMcapPlaybackClock } from './McapPlot';
import McapVideo from './McapVideo';
import McapMessage from './McapMessage';
import McapVisiblePane from './McapVisiblePane';
import { Icon } from '../Icon';
import PreviewPane from '../PreviewPane';
import { updateMcapView, type McapView } from './mcap-review';
import { renameMcapTopic, sampleMcap } from './mcap-file';
import { canSaveHostFile, saveHostFile } from '../backend';
import InlineRename from '../InlineRename';

const labelSeconds = (time: bigint) => (Number(time) / 1e9).toFixed(3);

export default function McapViewer({
  artifact,
  onSelect,
  onShareTime,
  onContext,
  command,
  onCommandResult,
  captureRef,
  sharedItemId,
}: ViewerProps) {
  const info = artifact.mcap;
  const cameras = useMemo(() => info?.topics.filter(isCamera) ?? [], [info]);
  const topicsById = useMemo(() => new Map(info?.topics.map((topic) => [topic.id, topic])), [info]);
  const [view, setView] = useState<McapView>(() => {
    const startNs = info?.startTime ?? '0';
    const start = BigInt(startNs);
    const end = BigInt(info?.endTime ?? startNs);
    const bounded = info?.indexed && cameras.length && artifact.size > videoLimits.input;
    const firstWindow = start + 10000000000n;
    const initial = {
      timestampNs: startNs,
      topicChannelId: cameras[0]?.id,
      cameraChannelId: cameras[0]?.id,
      range: bounded && firstWindow < end ? { startNs, endNs: String(firstWindow) } : undefined,
    };
    return info && artifact.initialMcapLayout
      ? updateMcapView(initial, { kind: 'mcap_view', layout: artifact.initialMcapLayout }, info)
      : initial;
  });
  const [decode, setDecode] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [seekRevision, setSeekRevision] = useState(0);
  const readVideoTime = useRef<(() => bigint | undefined) | null>(null);
  const sampleController = useRef<AbortController | null>(null);
  const previous = useRef<McapView>(undefined);
  const handled = useRef<string>(undefined);
  const current = useRef(view);
  current.current = view;
  const cameraChannelIds = useMemo(() => cameras.map((topic) => topic.id).slice(0, 200), [cameras]);
  const plotChannelIds = useMemo(
    () =>
      info?.topics
        .filter((topic) => isPlot(info, topic))
        .map(({ id }) => id)
        .slice(0, 200),
    [info],
  );
  const start = BigInt(info?.startTime ?? '0');
  const lower = BigInt(view.range?.startNs ?? start);
  const upper = BigInt(view.range?.endNs ?? info?.endTime ?? start);
  const timestamp = BigInt(view.timestampNs);
  const configuredPanes = useMemo(
    () => (view.layout && info ? layoutPanes(view.layout, info) : undefined),
    [view.layout, info],
  );
  const selectedTopic =
    view.topicChannelId !== undefined &&
    (!view.channelIds || view.channelIds.includes(view.topicChannelId))
      ? topicsById.get(view.topicChannelId)
      : undefined;
  const panes: McapPane[] =
    configuredPanes ?? (selectedTopic ? [{ channelId: selectedTopic.id }] : []);
  const overview = panes.length > 4;
  const multiple = panes.length > 1;
  const firstTopic = panes.length ? topicsById.get(panes[0].channelId) : undefined;
  const usesRecordingClock =
    multiple || Boolean(firstTopic && info && !isCamera(firstTopic) && !isPlot(info, firstTopic));

  useEffect(() => {
    if (info) onContext?.({ kind: 'mcap', ...view, cameraChannelIds, plotChannelIds, playing });
  }, [view, cameraChannelIds, plotChannelIds, playing, info, onContext]);
  useEffect(
    () => () => {
      sampleController.current?.abort();
    },
    [],
  );

  const commit = (next: McapView) => {
    setPlaying(false);
    setView(next);
    setSeekRevision((revision) => revision + 1);
  };
  const updateTime = useCallback((next: bigint) => {
    const timestampNs = String(next);
    setView((current) =>
      current.timestampNs === timestampNs ? current : { ...current, timestampNs },
    );
  }, []);
  useMcapPlaybackClock({
    playing: playing && usesRecordingClock,
    timestamp,
    end: upper,
    onTime: updateTime,
    onPlayingChange: setPlaying,
  });

  useEffect(() => {
    if (!info || !command || command.id === handled.current) return;
    handled.current = command.id;
    try {
      if (command.action.kind === 'undo') {
        if (!previous.current) throw new Error('No recording view change to undo.');
        commit(previous.current);
        previous.current = undefined;
        onCommandResult?.(command.id, 'Restored recording view.');
      } else if (command.action.kind === 'mcap_view') {
        const action = command.action;
        const currentView = current.current;
        const timestampNs = readVideoTime.current?.()?.toString() ?? currentView.timestampNs;
        const next = updateMcapView({ ...currentView, timestampNs }, action, info);
        const topic = info.topics.find(({ id }) => id === next.topicChannelId);
        const playable = next.layout ? layoutPanes(next.layout, info).length : topic;
        previous.current = { ...currentView, timestampNs };
        if (
          action.timestampNs !== undefined ||
          action.range !== undefined ||
          action.cameraChannelId !== undefined
        )
          commit(next);
        else setView(next);
        if (!playable) setPlaying(false);
        onCommandResult?.(command.id, 'Updated recording view.');
      } else if (command.action.kind === 'mcap_sample') {
        if (!info.indexed) throw new Error('Topic samples require an indexed recording.');
        const { channelId, startNs, endNs, limit } = command.action;
        const controller = new AbortController();
        sampleController.current = controller;
        const view = current.current;
        void sampleMcap(
          artifact,
          {
            channelId,
            startNs:
              startNs ?? (endNs ? (view.range?.startNs ?? info.startTime) : view.timestampNs),
            endNs: endNs ?? view.range?.endNs ?? info.endTime,
            limit: limit ?? 5,
          },
          controller.signal,
        )
          .then((samples) => {
            if (!controller.signal.aborted)
              onCommandResult?.(
                command.id,
                samples.length
                  ? `Read ${samples.length} topic samples.`
                  : 'No messages in this range.',
                false,
                samples,
              );
          })
          .catch((error) => {
            if (!controller.signal.aborted)
              onCommandResult?.(
                command.id,
                error instanceof Error ? error.message : 'Cannot sample topic.',
                true,
              );
          })
          .finally(() => {
            if (sampleController.current === controller) sampleController.current = null;
          });
      } else throw new Error('This action is unavailable for recordings.');
    } catch (error) {
      onCommandResult?.(
        command.id,
        error instanceof Error ? error.message : 'Cannot update view.',
        true,
      );
    }
  }, [artifact, command, info, onCommandResult]);

  if (!info)
    return (
      <div className="empty" role="alert">
        {artifact.warning ?? 'No MCAP metadata available.'}
      </div>
    );

  const position = upper > lower ? Number(((timestamp - lower) * 10000n) / (upper - lower)) : 0;
  const tableTopics = view.channelIds
    ? info.topics.filter((topic) => view.channelIds!.includes(topic.id))
    : info.topics;
  const editable = canSaveHostFile(artifact);

  const paneIds = new Set(panes.map(({ channelId }) => channelId));
  const firstCamera = panes.find(({ channelId }) =>
    isCamera(topicsById.get(channelId)!),
  )?.channelId;
  const playback = {
    start: lower,
    end: upper,
    timestamp,
    playing,
    onTime: updateTime,
    onPlayingChange: setPlaying,
    onSeek: (time: bigint) => commit({ ...current.current, timestampNs: String(time) }),
  };
  const selectionAt = (timestampNs: string, channelId = selectedTopic?.id): Selection => ({
    artifactId: artifact.id,
    revision: artifact.revision,
    path: artifact.path,
    kind: 'time',
    timestampNs,
    channelId,
  });
  const shareTime = (timestampNs: string, channelId?: number, image?: string) => {
    const selection = selectionAt(timestampNs, channelId);
    onSelect(selection);
    onShareTime?.(selection, image);
  };
  const shareTopic = (topic: Topic) => {
    const timestampNs = readVideoTime.current?.()?.toString() ?? current.current.timestampNs;
    const selection = {
      ...selectionAt(timestampNs, topic.id),
      item: {
        id: `topic:${topic.id}`,
        label: topic.topic.slice(0, 300) || `Channel ${topic.id}`,
      },
    };
    onSelect(selection);
    onShareTime?.(selection);
  };
  const seek = (next: bigint) => {
    const timestampNs = String(next);
    commit({ ...view, timestampNs });
    onSelect(selectionAt(timestampNs));
  };
  const selectTopic = (topic: Topic) => {
    if (paneIds.has(topic.id)) return;
    const currentView = current.current;
    const cameraChannelId = isCamera(topic) ? topic.id : undefined;
    const timestampNs = readVideoTime.current?.()?.toString() ?? currentView.timestampNs;
    if (cameraChannelId !== undefined && currentView.cameraChannelId !== undefined && !multiple) {
      setPlaying(false);
    }
    setView({
      ...currentView,
      timestampNs,
      topicChannelId: topic.id,
      cameraChannelId,
      layout: undefined,
    });
    onSelect(selectionAt(timestampNs, topic.id));
  };

  return (
    <div className="mcap-view">
      <div className="mcap-preview">
        {panes.length ? (
          <div
            className="mcap-panes"
            data-overview={overview || undefined}
            data-columns={multiple ? (view.layout?.columns ?? (overview ? 4 : 2)) : 1}
          >
            {panes.map(({ channelId, field, fullWidth }) => {
              const topic = topicsById.get(channelId)!;
              const key = JSON.stringify([channelId, field]);
              const camera = isCamera(topic);
              const plot = isPlot(info, topic);
              const renderPane = (visible: boolean) => {
                if (!visible && (camera || plot)) return null;
                return camera ? (
                  <McapVideo
                    key={key}
                    title={topic.topic}
                    artifact={artifact}
                    onShareTime={(time, id, image) => {
                      if (multiple) playback.onSeek(BigInt(time));
                      shareTime(time, id, image);
                    }}
                    timestampNs={view.timestampNs}
                    camera={topic.id}
                    range={view.range}
                    seekRevision={seekRevision}
                    playing={playing}
                    synchronized={multiple}
                    readTimeRef={multiple ? undefined : readVideoTime}
                    captureRef={topic.id === firstCamera ? captureRef : undefined}
                    onTime={updateTime}
                    onPlayingChange={setPlaying}
                  />
                ) : plot ? (
                  <McapPlot
                    key={key}
                    artifact={artifact}
                    topic={topic}
                    initialField={field}
                    origin={start}
                    transport={!multiple}
                    sharedItemId={sharedItemId}
                    {...playback}
                    onShare={(time, item) => {
                      const selection = selectionAt(String(time), topic.id);
                      playback.onSeek(time);
                      onSelect(selection);
                      onShareTime?.({ ...selection, item });
                    }}
                  />
                ) : (
                  <McapMessage
                    key={key}
                    artifact={artifact}
                    topic={topic}
                    timestamp={timestamp}
                    playing={playing}
                    visible={visible}
                    transport={
                      multiple ? undefined : <McapPlayback label="Recording" {...playback} />
                    }
                    onShare={(time, item) => {
                      const selection = selectionAt(time, topic.id);
                      onSelect(selection);
                      onShareTime?.({ ...selection, item });
                    }}
                  />
                );
              };
              const preview = overview ? (
                <McapVisiblePane key={key} title={topic.topic}>
                  {renderPane}
                </McapVisiblePane>
              ) : (
                renderPane(true)
              );
              return fullWidth ? (
                <div key={key} className="mcap-full-width-pane">
                  {preview}
                </div>
              ) : (
                preview
              );
            })}
          </div>
        ) : (
          <PreviewPane
            title="Timeline"
            className="timeline"
            onDoubleClick={(event) => {
              event.stopPropagation();
              shareTime(view.timestampNs);
            }}
          >
            <div className="time-label">
              <span>+{labelSeconds(timestamp - start)} s</span>
            </div>
            <div className="playback-controls">
              <input
                aria-label="Recording timeline"
                aria-keyshortcuts="Enter"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') shareTime(view.timestampNs);
                }}
                type="range"
                min="0"
                max="10000"
                value={position}
                onChange={(event) =>
                  seek(lower + ((upper - lower) * BigInt(event.target.value)) / 10000n)
                }
              />
            </div>
            <div className="time-label muted">
              <span>{labelSeconds(lower - start)} s</span>
              <span>{labelSeconds(upper - start)} s</span>
            </div>
          </PreviewPane>
        )}
        {multiple && (
          <div className="mcap-shared-playback">
            <McapPlayback label="Recording" {...playback} />
          </div>
        )}
      </div>
      <div className="topic-scroll">
        <table>
          <thead>
            <tr>
              <th>Topic</th>
              <th>Schema</th>
              <th>Encoding</th>
              <th>Messages</th>
            </tr>
          </thead>
          <tbody>
            {tableTopics.map((topic) => (
              <tr
                key={topic.id}
                className={
                  paneIds.has(topic.id) || selectedTopic?.id === topic.id ? 'selected' : ''
                }
                onClick={() => selectTopic(topic)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  shareTopic(topic);
                }}
              >
                <td>
                  <div className="mcap-topic-actions">
                    <button
                      type="button"
                      className="topic-button"
                      aria-pressed={paneIds.has(topic.id) || selectedTopic?.id === topic.id}
                      aria-keyshortcuts="Shift+Enter"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && event.shiftKey) {
                          event.preventDefault();
                          shareTopic(topic);
                        }
                      }}
                    >
                      {topic.topic}
                    </button>
                    {editable && (
                      <InlineRename
                        label={`Rename ${topic.topic}`}
                        value={topic.topic}
                        onSave={async (name) => {
                          const signal = AbortSignal.timeout(20_000);
                          const bytes = await renameMcapTopic(artifact, topic.id, name, signal);
                          await saveHostFile(artifact, bytes, signal);
                        }}
                      />
                    )}
                  </div>
                </td>
                <td title={topic.schema}>{topic.schema || '—'}</td>
                <td>{topic.encoding}</td>
                <td>{topic.count ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {artifact.size <= videoLimits.input && !artifact.id.startsWith('local-') && (
        <button
          className="disclosure"
          onClick={() => setDecode((value) => !value)}
          aria-expanded={decode}
        >
          <Icon name="chevron" />
          Decoded message preview
        </button>
      )}
      {decode && <DataViewer artifact={artifact} onSelect={onSelect} onShareTime={onShareTime} />}
      {info.metadata.length > 0 && (
        <details>
          <summary>Recording metadata</summary>
          {info.metadata.map((record, i) => (
            <div key={i}>
              <strong>{record.name}</strong>
              <pre>{JSON.stringify(record.values, null, 2)}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
