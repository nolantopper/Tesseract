import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, Selection } from '../shared/types';
import type {
  ViewCommand,
  ViewIdentity,
  ViewerContext,
  ViewResult,
  ViewSample,
  ViewSnapshot,
  SharedItem,
  SelectedPart,
} from '../shared/view';
import {
  maxModelParts,
  selectionKey,
  sharedItem,
  validateViewAction,
  viewImage,
} from '../shared/view';
import { addViewToChat, clearChatContext, closeView, shareView, syncView } from './backend';
import { registerWebMcp, type LivePanel } from './webmcp';

type Session = {
  active: boolean;
  context: ViewerContext | null;
  selection?: Selection;
  sharedSelection?: Selection;
  timeImage?: string;
  item?: SharedItem;
  itemImage?: string;
  chatAttached?: boolean;
  contextRequest?: object;
  sharing?: object;
  contextVersion: number;
  sync?: () => void;
  pendingCommand?: { id: string; complete?: (result: ViewResult) => void };
  result?: ViewResult;
  image?: string;
  captureRef: { current: ((objectIds?: readonly string[]) => string | undefined) | null };
  resolvePartRef: { current: ((part: SelectedPart) => SelectedPart) | null };
  clearSelectionRef: { current: (() => void) | null };
};

function partNames(selection?: ViewSnapshot['selected']): string[] {
  if (selection?.parts?.length)
    return selection.parts.map(({ objectName, face }) =>
      face
        ? `${objectName} (${face.kind === 'triangle' ? 'triangle' : 'face'} ${face.index + 1})`
        : objectName,
    );
  return selection?.objectName ? [selection.objectName] : [];
}

const listNames = new Intl.ListFormat('en', { type: 'conjunction' });

function modelSummary(content: ViewSnapshot) {
  const names = partNames(content.selected);
  const visible = names.slice(0, 3).map((name) => JSON.stringify(name));
  if (names.length > 3) visible.push(`${names.length - 3} more`);
  const selection = names.length
    ? `The selected ${names.length === 1 ? 'part is' : 'parts are'} ${listNames.format(visible)}.`
    : 'The current context is the model overview.';
  return `Tesseract is showing ${JSON.stringify(content.name)}. ${selection}`;
}

function snapshot(artifact: Artifact, session: Session, live = false): ViewSnapshot {
  const current = live
    ? (session.selection ?? session.sharedSelection)
    : artifact.format.kind === 'model' || session.sharedSelection?.kind === 'time'
      ? session.sharedSelection
      : session.selection;
  const selection = current?.artifactId === artifact.id ? current : undefined;
  const parts = selection?.parts?.map((part) => session.resolvePartRef.current?.(part) ?? part);
  const last = parts?.at(-1) ?? selection;
  return {
    name: artifact.name.slice(0, 512),
    format: artifact.format.id,
    size: artifact.size,
    context: session.context,
    selected: (selection || session.item) && {
      objectId: last?.objectId,
      objectName: last?.objectName?.slice(0, 200),
      coordinates: last?.coordinates,
      face: last?.face,
      parts,
      timestampNs: selection?.timestampNs,
      channelId: selection?.channelId,
      item: selection?.item ?? session.item,
    },
    recording: artifact.mcap && {
      startNs: artifact.mcap.startTime,
      endNs: artifact.mcap.endTime,
      topics: artifact.mcap.topics.slice(0, 200).map((topic) => ({
        id: topic.id,
        name: topic.topic.slice(0, 300),
        schema: topic.schema.slice(0, 300),
      })),
    },
  };
}

function capture(session: Session, live = false): string | undefined {
  if (!live && session.item) return session.itemImage;
  if (!live && session.sharedSelection?.kind === 'time') return session.timeImage;
  try {
    const selection = live ? session.selection : session.sharedSelection;
    const ids =
      selection?.parts?.map(selectionKey) ?? (selection?.objectId ? [selection.objectId] : []);
    const thumbnail = session.captureRef.current?.(live && !selection ? undefined : ids);
    const image = /^data:image\/jpeg;base64,(\/9j\/[\w+/=]+)$/.exec(thumbnail ?? '')?.[1];
    return image && image.length <= 275000 ? image : undefined;
  } catch {
    return undefined;
  }
}

export function useSharedView(
  artifact: Artifact | undefined,
  setMessage: (message: string) => void,
  setError: (message: string) => void,
) {
  const session = useMemo<Session>(
    () => ({
      active: false,
      context: null,
      contextVersion: 0,
      captureRef: { current: null },
      resolvePartRef: { current: null },
      clearSelectionRef: { current: null },
    }),
    [artifact],
  );
  useLayoutEffect(() => {
    session.active = true;
    return () => {
      session.active = false;
    };
  }, [session]);

  const [share, setShare] = useState<{
    session: Session;
    identity: ViewIdentity;
    snapshot: string;
    reference?: string;
  }>();
  const current = share?.session === session ? share : undefined;
  const identity = current?.identity;
  const initialSnapshot = current?.snapshot;
  const [command, setCommand] = useState<{
    session: Session;
    value: ViewCommand & { signal?: AbortSignal };
  }>();
  const [chatSelection, setChatSelection] = useState<{ session: Session; ids: string[] }>();
  const livePanel = useRef<LivePanel>(undefined);
  const startCommand = useCallback(
    (value: ViewCommand & { signal?: AbortSignal }, complete?: (result: ViewResult) => void) => {
      if (!session.active || session.pendingCommand) return false;
      session.pendingCommand = { id: value.id, complete };
      setCommand({ session, value });
      return true;
    },
    [session],
  );
  const clearCommand = useCallback(
    (id: string) => {
      if (session.pendingCommand?.id !== id) return;
      session.pendingCommand = undefined;
      setCommand((pending) =>
        pending?.session === session && pending.value.id === id ? undefined : pending,
      );
    },
    [session],
  );
  useEffect(() => registerWebMcp(() => livePanel.current), []);
  useLayoutEffect(() => {
    if (!artifact) return;
    const lifetime = new AbortController();
    livePanel.current = {
      artifact,
      read: () => snapshot(artifact, session, true),
      capture: () => capture(session, true),
      change: async (action, signal, save) => {
        try {
          validateViewAction(session.context, action);
        } catch (error) {
          return { error: (error as Error).message };
        }
        const id = crypto.randomUUID();
        const stopped = AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(25000),
          ...(signal ? [signal] : []),
        ]);
        if (stopped.aborted) return { error: 'Preview change canceled.' };
        return new Promise((resolve) => {
          const cancel = () => {
            clearCommand(id);
            resolve({ error: 'Preview change canceled or timed out.' });
          };
          const complete = (result: ViewResult) => {
            stopped.removeEventListener('abort', cancel);
            resolve(result.error ? { error: result.message } : result);
          };
          if (startCommand({ id, action, save, signal: stopped }, complete)) {
            stopped.addEventListener('abort', cancel, { once: true });
          } else {
            resolve({ error: 'A preview change is already pending.' });
          }
        });
      },
    };
    return () => {
      livePanel.current = undefined;
      lifetime.abort();
    };
  }, [artifact, session, startCommand, clearCommand]);
  const isModel = artifact?.format.kind === 'model';
  const attachment = (content: ViewSnapshot) => {
    const group = content.name;
    const prefix = `Tesseract is showing ${JSON.stringify(group)}.`;
    if (content.selected?.item) {
      const { item, timestampNs } = content.selected;
      const point = timestampNs ? ` at ${timestampNs} ns. ${item.details ?? ''}` : '.';
      return {
        group,
        title: item.label,
        summary: `${prefix} Selected ${JSON.stringify(item.label)}${point}`,
      };
    }
    if (content.selected?.timestampNs) {
      const topic = content.recording?.topics.find(({ id }) => id === content.selected?.channelId);
      const channel = topic ? ` on ${JSON.stringify(topic.name)}` : '';
      const time = `${content.selected.timestampNs} ns`;
      return { group, title: time, summary: `${prefix} Selected ${time}${channel}.` };
    }
    const names = partNames(content.selected);
    return {
      group,
      title: names.length > 1 ? `${names.length} selected` : names[0] || group,
      summary: content.context?.kind === 'model' ? modelSummary(content) : undefined,
    };
  };
  const confirmChatSelection = useCallback(
    (selection?: ViewSnapshot['selected']) => {
      const ids =
        selection?.parts?.map(selectionKey) ??
        (selection?.item ? [selection.item.id] : selection?.objectId ? [selection.objectId] : []);
      setChatSelection((previous) =>
        previous?.session === session &&
        previous.ids.length === ids.length &&
        previous.ids.every((id, index) => ids[index] === id)
          ? previous
          : { session, ids },
      );
    },
    [session],
  );
  const onContext = useCallback(
    (context: ViewerContext | null) => {
      session.context = context;
    },
    [session],
  );
  const detach = useCallback(() => {
    session.contextVersion++;
    session.chatAttached = false;
    session.sharedSelection = undefined;
    session.timeImage = undefined;
    session.item = undefined;
    session.itemImage = undefined;
    session.contextRequest = undefined;
    session.sharing = undefined;
    session.clearSelectionRef.current?.();
    confirmChatSelection(undefined);
    setShare((current) => (current?.session === session ? undefined : current));
    if (session.pendingCommand && !session.pendingCommand.complete)
      clearCommand(session.pendingCommand.id);
  }, [session, confirmChatSelection, clearCommand]);
  useEffect(() => {
    const removed = () => {
      if (session.chatAttached || session.sharing) detach();
    };
    window.addEventListener('tesseract-context-removed', removed);
    return () => window.removeEventListener('tesseract-context-removed', removed);
  }, [detach, session]);
  const recordSelection = useCallback(
    (selection?: Selection) => {
      session.selection = selection;
    },
    [session],
  );
  const onCommandResult = useCallback(
    (id: string, message: string, error?: boolean, samples?: ViewSample[]) => {
      const pending = session.pendingCommand;
      if (pending?.id !== id) return;
      clearCommand(id);
      const result = { id, message: message.slice(0, 300), error, samples };
      if (pending.complete) {
        pending.complete(result);
        return;
      }
      session.result = result;
      if (artifact?.format.kind === 'model' && session.chatAttached) session.contextRequest = {};
      if (session.active && error) setError(message);
      else if (session.active && artifact?.format.kind !== 'model') setMessage(message);
    },
    [artifact, session, setError, setMessage, clearCommand],
  );

  const addToChat = async (toggleId?: string) => {
    if (!artifact) return;
    const sharing = {};
    const version = session.contextVersion;
    try {
      const selection = session.selection;
      if (isModel && selection?.parts) {
        const parts = new Map(
          session.sharedSelection?.parts?.map((part) => [selectionKey(part), part]),
        );
        const removing =
          toggleId !== undefined &&
          parts.has(toggleId) &&
          selection.parts.every((part) => parts.has(selectionKey(part)));
        if (removing) parts.delete(toggleId);
        else for (const part of selection.parts) parts.set(selectionKey(part), part);
        if (parts.size > maxModelParts)
          throw new Error(`Chat context supports up to ${maxModelParts} parts.`);
        const sharedParts = [...parts.values()];
        const last = sharedParts.at(-1);
        session.sharedSelection = last ? { ...selection, ...last, parts: sharedParts } : undefined;
        if (removing) {
          if (!last) {
            const clearing = clearChatContext();
            detach();
            await clearing;
            return;
          }
          session.clearSelectionRef.current?.();
        }
      } else if (isModel) session.sharedSelection = session.selection;
      if (session.sharing) {
        session.contextRequest = {};
        return;
      }
      session.sharing = sharing;
      if (
        identity &&
        session.chatAttached &&
        (isModel || session.item || session.sharedSelection?.kind === 'time')
      ) {
        session.contextRequest = {};
        session.sync?.();
        return;
      }
      const content = snapshot(artifact, session);
      const image = capture(session);
      const published = identity ?? (await shareView(artifact, content, image));
      if (!session.active || version !== session.contextVersion) {
        await closeView(published);
        return;
      }
      const added = await addViewToChat(published, attachment(content), image);
      if (!session.active || version !== session.contextVersion) {
        await closeView(published);
        return;
      }
      session.chatAttached = added;
      if (added) confirmChatSelection(content.selected);
      setShare({
        session,
        identity: published,
        snapshot: initialSnapshot ?? JSON.stringify(content),
        reference: added ? undefined : `Tesseract preview ${JSON.stringify(published)}`,
      });
    } catch (error) {
      if (session.active)
        setError(error instanceof Error ? error.message : 'Couldn’t share preview.');
    } finally {
      if (session.sharing === sharing) {
        session.sharing = undefined;
      }
    }
  };

  const onShareTime = (selection: Selection, image?: string) => {
    session.sharedSelection = selection;
    session.timeImage = viewImage.safeParse(image?.replace(/^data:image\/jpeg;base64,/, '')).data;
    void addToChat();
  };

  const onShareItem = (item: SharedItem, image?: string) => {
    const parsed = sharedItem.safeParse({
      id: item.id,
      label: item.label.slice(0, 300),
      details: item.details?.slice(0, 4096),
    });
    if (!parsed.success) return;
    session.item = parsed.data;
    session.itemImage = viewImage.safeParse(image?.replace(/^data:image\/jpeg;base64,/, '')).data;
    void addToChat();
  };

  useEffect(() => {
    if (!identity || !artifact) return;
    let active = true;
    let sent = initialSnapshot;
    let inFlight = false;
    let queued = false;
    let lastCommand: string | undefined;
    const sync = async () => {
      if (!active) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const content = snapshot(artifact, session);
        const serialized = JSON.stringify(content);
        const changed = serialized !== sent;
        const contextRequest = session.contextRequest;
        const sharedTime = session.sharedSelection?.kind === 'time';
        const sharesSelection = isModel || session.item !== undefined || sharedTime;
        const needsContext =
          sharesSelection && session.chatAttached && contextRequest !== undefined;
        const refreshImage = sharesSelection && (changed || needsContext);
        const image = refreshImage ? capture(session) : session.image;
        const result = session.result;
        const nextCommand = await syncView(
          identity,
          changed || refreshImage ? content : undefined,
          result,
          image,
        );
        sent = serialized;
        if (session.result === result) {
          session.result = undefined;
          session.image = undefined;
        }
        if (active && nextCommand && nextCommand.id !== lastCommand && !session.pendingCommand) {
          if (nextCommand.action.kind === 'capture') {
            lastCommand = nextCommand.id;
            session.image = capture(session);
            session.result = {
              id: nextCommand.id,
              message: session.image ? 'Captured preview.' : 'No rendered frame is available.',
              error: !session.image,
            };
            if (isModel && session.chatAttached) session.contextRequest = {};
          } else if (startCommand(nextCommand)) lastCommand = nextCommand.id;
        }
        if (active && sharesSelection && session.chatAttached) {
          if (
            (!sharedTime && JSON.stringify(snapshot(artifact, session)) !== serialized) ||
            session.contextRequest !== contextRequest
          ) {
            queued = true;
            return;
          }
          if (needsContext && (await addViewToChat(identity, attachment(content), image))) {
            if (session.contextRequest === contextRequest) session.contextRequest = undefined;
            if (active) confirmChatSelection(content.selected);
          }
        }
      } catch (error) {
        if (active && error instanceof Error && error.message.includes('no longer shared')) {
          setShare(undefined);
          setMessage('Double-click the preview to reconnect');
        }
      } finally {
        inFlight = false;
        if (active && queued) {
          queued = false;
          void sync();
        }
      }
    };
    const requestSync = () => void sync();
    session.sync = requestSync;
    requestSync();
    const timer = window.setInterval(requestSync, 750);
    return () => {
      active = false;
      if (session.sync === requestSync) session.sync = undefined;
      window.clearInterval(timer);
      void closeView(identity).catch(() => {});
    };
  }, [
    artifact,
    confirmChatSelection,
    identity,
    initialSnapshot,
    isModel,
    session,
    setMessage,
    startCommand,
  ]);

  return {
    addToChat,
    reference: current?.reference,
    recordSelection,
    viewerProps: {
      onShareSelection: addToChat,
      onShareTime,
      onShareItem,
      sharedItemId:
        !isModel && current && chatSelection?.session === session
          ? chatSelection.ids[0]
          : undefined,
      onContext,
      onCommandResult,
      captureRef: session.captureRef,
      resolvePartRef: session.resolvePartRef,
      clearSelectionRef: session.clearSelectionRef,
      chatPartIds:
        current && !current.reference && chatSelection?.session === session
          ? chatSelection.ids
          : undefined,
      command: command?.session === session ? command.value : undefined,
    },
  };
}
