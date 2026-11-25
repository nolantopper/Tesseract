import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Stats } from 'node:fs';
import { detectFormat } from '../shared/formats.js';
import type { Artifact, Selection } from '../shared/types.js';
import { selectionKey } from '../shared/view.js';
import { FileAccess } from './files.js';
import { inspectMcap } from './mcap.js';

function fileRevision(stat: Stats) {
  return `${stat.ino}-${stat.size}-${stat.mtimeMs}-${stat.ctimeMs}`;
}

export class ArtifactStore {
  readonly artifacts = new Map<string, Artifact>();
  readonly selections = new Map<string, Selection>();
  latestId?: string;
  constructor(readonly files: FileAccess) {}
  async inspect(input: string): Promise<Artifact> {
    const directory = await this.files.directory(input);
    if (directory) {
      const existing = [...this.artifacts.values()].find((a) => a.path === directory.path);
      const artifact: Artifact = {
        id: existing?.id ?? randomUUID(),
        path: directory.path,
        name: basename(directory.path),
        size: 0,
        modified: directory.info.mtimeMs,
        revision: createHash('sha256').update(JSON.stringify(directory.entries)).digest('hex'),
        format: {
          id: 'folder',
          label: 'Folder',
          extensions: [],
          mime: 'inode/directory',
          kind: 'container',
        },
        entries: directory.entries,
      };
      if (this.artifacts.size >= 128 && !existing) {
        const first = this.artifacts.keys().next().value!;
        this.artifacts.delete(first);
        this.selections.delete(first);
      }
      this.artifacts.set(artifact.id, artifact);
      return artifact;
    }
    const file = await this.files.open(input);
    try {
      const revision = fileRevision(file.stat);
      const existing = [...this.artifacts.values()].find((a) => a.path === file.path);
      if (existing?.revision === revision) return existing;
      const head = Buffer.alloc(Math.min(512, file.stat.size));
      await file.handle.read(head, 0, head.length, 0);
      const artifact: Artifact = {
        id: existing?.id ?? randomUUID(),
        path: file.path,
        name: basename(file.path),
        size: file.stat.size,
        modified: file.stat.mtimeMs,
        revision,
        format: detectFormat(file.path, head),
      };
      if (artifact.format.kind === 'mcap') {
        try {
          artifact.mcap = await inspectMcap(file.handle, file.stat.size);
        } catch (error) {
          artifact.warning = error instanceof Error ? error.message : 'Cannot inspect MCAP.';
        }
      }
      if (this.artifacts.size >= 128 && !existing) {
        const first = this.artifacts.keys().next().value!;
        this.artifacts.delete(first);
        this.selections.delete(first);
      }
      this.artifacts.set(artifact.id, artifact);
      this.selections.delete(artifact.id);
      return artifact;
    } finally {
      await file.handle.close();
    }
  }
  async get(id: string) {
    const a = this.artifacts.get(id);
    if (!a) throw new Error('Artifact is no longer registered. Open it again.');
    return this.inspect(a.path);
  }
  async read(id: string, offset: number, length: number, revision: string) {
    const a = await this.get(id);
    if (a.revision !== revision) throw new Error('Artifact changed. Refresh the viewer.');
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > 1024 * 1024 ||
      offset > a.size
    )
      throw new Error('Invalid byte range (maximum 1 MiB).');
    const file = await this.files.open(a.path);
    try {
      if (fileRevision(file.stat) !== revision)
        throw new Error('Artifact changed. Refresh the viewer.');
      const data = Buffer.alloc(Math.min(length, a.size - offset));
      const { bytesRead } = await file.handle.read(data, 0, data.length, offset);
      if (fileRevision(await file.handle.stat()) !== revision)
        throw new Error('Artifact changed. Refresh the viewer.');
      return data.subarray(0, bytesRead);
    } finally {
      await file.handle.close();
    }
  }
  async select(selection: Selection) {
    const a = await this.get(selection.artifactId);
    if (a.revision !== selection.revision)
      throw new Error('Selection belongs to an older artifact revision.');
    if (selection.kind === 'object' && a.format.kind !== 'model')
      throw new Error('Object selection requires a model.');
    if (selection.parts) {
      const ids = new Set(selection.parts.map(selectionKey));
      if (selection.kind !== 'object' || ids.size !== selection.parts.length)
        throw new Error('Select distinct parts of a model.');
    }
    if (selection.kind === 'time') {
      if (!a.mcap || selection.timestampNs === undefined)
        throw new Error('Time selection requires an MCAP recording.');
      const time = BigInt(selection.timestampNs);
      if (time < BigInt(a.mcap.startTime) || time > BigInt(a.mcap.endTime))
        throw new Error('Timestamp is outside the recording.');
      if (
        selection.channelId !== undefined &&
        !a.mcap.topics.some((t) => t.id === selection.channelId)
      )
        throw new Error('Unknown channel.');
    }
    const canonical = { ...selection, path: a.path };
    this.selections.set(a.id, canonical);
    this.latestId = a.id;
    return canonical;
  }

  async clearSelection(artifactId: string, revision: string) {
    const artifact = await this.get(artifactId);
    if (artifact.revision !== revision)
      throw new Error('Selection belongs to an older artifact revision.');
    this.selections.delete(artifact.id);
  }
}
