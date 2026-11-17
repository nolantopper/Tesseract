import { constants } from 'node:fs';
import { open, opendir, realpath, stat as pathStat } from 'node:fs/promises';
import path from 'node:path';

export class FileAccess {
  constructor(readonly roots: string[]) {}
  static async create(roots: string[]) {
    if (!roots.length) throw new Error('At least one workspace folder is required.');
    const directories = await Promise.all(
      roots.map(async (root) => {
        const resolved = await realpath(root);
        if (!(await pathStat(resolved)).isDirectory())
          throw new Error(`Workspace root must be a folder: ${root}`);
        return resolved;
      }),
    );
    return new FileAccess(directories);
  }
  private async resolve(input: string, kind: 'File' | 'Folder') {
    const resolved = await realpath(path.resolve(this.roots[0], input));
    const allowed = this.roots.some((root) => {
      const relative = path.relative(root, resolved);
      return (
        relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    });
    if (!allowed) throw new Error(`${kind} is outside the configured workspace roots.`);
    return resolved;
  }
  async directory(input: string) {
    const resolved = await this.resolve(input, 'Folder');
    const info = await pathStat(resolved);
    if (!info.isDirectory()) return;
    const entries: { name: string; path: string; directory: boolean }[] = [];
    const dir = await opendir(resolved);
    for await (const entry of dir) {
      if (entries.length >= 2000) throw new Error('Folder exceeds the 2,000 entry limit.');
      if (!entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()))
        entries.push({
          name: entry.name,
          path: path.join(resolved, entry.name),
          directory: entry.isDirectory(),
        });
    }
    return {
      path: resolved,
      info,
      entries: entries.sort(
        (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
      ),
    };
  }
  async open(input: string) {
    const resolved = await this.resolve(input, 'File');
    const handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Only regular files can be viewed.');
      // Recheck the resolved path after opening (including parent symlinks).
      if ((await realpath(resolved)) !== resolved)
        throw new Error('File path changed while opening.');
      const current = await pathStat(resolved);
      if (current.dev !== stat.dev || current.ino !== stat.ino)
        throw new Error('File changed while opening.');
      return { handle, stat, path: resolved };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
