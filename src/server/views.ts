import { randomUUID } from 'node:crypto';
import { validateViewAction } from '../shared/view.js';
import type {
  ViewAction,
  ViewCommand,
  ViewIdentity,
  ViewResult,
  ViewSnapshot,
} from '../shared/view.js';

type SharedView = ViewIdentity & {
  snapshot: ViewSnapshot;
  image?: string;
  imageMatchesSnapshot?: boolean;
  workspaceArtifactId?: string;
  lastSeen: number;
  command?: ViewCommand;
  result?: ViewResult;
};

const viewTimeout = 2 * 60 * 1000;

export class SharedViews {
  private readonly views = new Map<string, SharedView>();

  share(
    revision: string,
    snapshot: ViewSnapshot,
    image?: string,
    workspaceArtifactId?: string,
  ): ViewIdentity {
    for (const [id, view] of this.views) {
      if (Date.now() - view.lastSeen > viewTimeout) this.views.delete(id);
    }
    if (this.views.size >= 64) throw new Error('Too many shared panels. Close a panel and retry.');
    const viewId = randomUUID();
    this.views.set(viewId, {
      viewId,
      revision,
      snapshot,
      image,
      imageMatchesSnapshot: Boolean(image),
      workspaceArtifactId,
      lastSeen: Date.now(),
    });
    return { viewId, revision };
  }

  private get({ viewId, revision }: ViewIdentity): SharedView {
    const view = this.views.get(viewId);
    if (!view || Date.now() - view.lastSeen > viewTimeout)
      throw new Error('This preview is no longer shared. Add it to chat again.');
    if (view.revision !== revision)
      throw new Error('The file revision changed. Share the current preview.');
    return view;
  }

  read(identity: ViewIdentity) {
    const { snapshot, image, imageMatchesSnapshot, command, result } = this.get(identity);
    return {
      snapshot,
      image,
      imageMatchesSnapshot,
      pendingCommandId: command?.id,
      lastResult: result,
    };
  }

  workspaceArtifactId(identity: ViewIdentity) {
    return this.get(identity).workspaceArtifactId;
  }

  sync(identity: ViewIdentity, snapshot?: ViewSnapshot, result?: ViewResult, image?: string) {
    const view = this.get(identity);
    view.lastSeen = Date.now();
    if (snapshot) {
      view.snapshot = snapshot;
      view.image = image;
      view.imageMatchesSnapshot = Boolean(image);
    }
    if (result && result.id === view.command?.id) {
      if (view.command.action.kind === 'capture' && !result.error) {
        view.image = image;
        view.imageMatchesSnapshot = Boolean(image);
      }
      view.result = result;
      view.command = undefined;
    }
    return { command: view.command ?? null };
  }

  queue(identity: ViewIdentity, action: ViewAction): ViewCommand {
    const view = this.get(identity);
    if (view.command) throw new Error('A change is still pending. Read the preview status first.');
    validateViewAction(view.snapshot.context, action);
    if (!['capture', 'mcap_sample'].includes(action.kind)) {
      view.image = undefined;
      view.imageMatchesSnapshot = false;
    }
    view.command = { id: randomUUID(), action };
    return view.command;
  }

  close(identity: ViewIdentity) {
    if (this.views.get(identity.viewId)?.revision === identity.revision)
      this.views.delete(identity.viewId);
  }
}
