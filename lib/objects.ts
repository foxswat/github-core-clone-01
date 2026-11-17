import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const types = ['', 'commit', 'tree', 'blob', 'tag'] as const;
export const zero = '0'.repeat(40);
export const digest = (bytes: Buffer) => createHash('sha1').update(bytes).digest();
export interface GitObject {
  type: number;
  data: Buffer;
  loose: Buffer;
  compressed?: Buffer;
  commit?: { tree: string; parents: string[]; message: string };
}
export interface FileEntry { sha: string; mode: string }
export type Files = Map<string, FileEntry>;
export const epoch = (() => {
  const value = process.env.MAKEFUN_TRIAL_NOW;
  const seconds = value ? Number(value) : 0;
  if (Number.isFinite(seconds)) return Math.floor(seconds > 1e12 ? seconds / 1000 : seconds);
  return Math.floor((Date.parse(value!) || 0) / 1000);
})();
export const timestamp = '1970-01-01T00:00:00Z';

export class Objects {
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  constructor(publicBranch: string) { this.branch = publicBranch; }
  branch: string;
  get head() { return 'refs/heads/' + this.branch; }
  resolve(ref: string) {
    return this.refs.get(ref === 'HEAD' ? this.head : ref) ??
      this.refs.get('refs/heads/' + ref) ?? this.refs.get('refs/tags/' + ref) ??
      (this.objects.has(ref) ? ref : undefined);
  }
  put(type: number, data: Buffer, compressed?: Buffer) {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, makeObject(type, data, compressed));
    return sha;
  }
  peel(sha: string): string {
    const object = this.objects.get(sha);
    return object?.type === 4 ? this.peel(object.data.toString('ascii', 7, 47)) : sha;
  }
  readCommit(sha: string | undefined) {
    const object = sha ? this.objects.get(sha) : undefined;
    if (object?.type !== 1) return undefined;
    if (!object.commit) {
      const raw = object.data.toString();
      const split = raw.indexOf('\n\n');
      const headers = raw.slice(0, split).split('\n');
      object.commit = {
        tree: headers.find(line => line.startsWith('tree '))?.slice(5) ?? '',
        parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
        message: raw.slice(split + 2).replace(/\n$/, ''),
      };
    }
    return object.commit;
  }
  ancestors(start: string | undefined) {
    const seen = new Set<string>();
    const queue = start ? [start] : [];
    while (queue.length) {
      const sha = queue.pop()!;
      if (seen.has(sha)) continue;
      const commit = this.readCommit(sha);
      if (!commit) continue;
      seen.add(sha);
      for (let i = commit.parents.length - 1; i >= 0; i--) queue.push(commit.parents[i]);
    }
    return seen;
  }
  fastForward(old: string, next: string) {
    if (old === next) return true;
    const queue = [next];
    const seen = new Set<string>();
    while (queue.length) {
      const sha = queue.pop()!;
      if (sha === old) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      queue.push(...(this.readCommit(sha)?.parents ?? []));
    }
    return false;
  }
  entries(tree: string) {
    const data = this.objects.get(tree)?.data;
    const entries: (FileEntry & { name: string })[] = [];
    if (!data) return entries;
    for (let offset = 0; offset < data.length;) {
      const space = data.indexOf(32, offset);
      const end = data.indexOf(0, space + 1);
      if (space < offset || end < space || end + 21 > data.length) throw new Error('Invalid tree');
      entries.push({
        mode: data.toString('ascii', offset, space),
        name: data.toString('utf8', space + 1, end),
        sha: data.toString('hex', end + 1, end + 21),
      });
      offset = end + 21;
    }
    return entries;
  }
  files(commit: string | undefined): Files {
    const files: Files = new Map();
    const walk = (tree: string, prefix: string) => {
      for (const { name, mode, sha } of this.entries(tree)) {
        if (mode === '40000') walk(sha, prefix + name + '/');
        else files.set(prefix + name, { mode, sha });
      }
    };
    const tree = this.readCommit(commit)?.tree;
    if (tree) walk(tree, '');
    return files;
  }
  writeTree(files: Files): string {
    const entries: { sort: Buffer; data: Buffer }[] = [];
    const dirs = new Map<string, Files>();
    const add = (name: string, mode: string, sha: string) => {
      entries.push({
        sort: Buffer.from(name + (mode === '40000' ? '/' : '')),
        data: Buffer.concat([Buffer.from(mode + ' ' + name + '\0'), Buffer.from(sha, 'hex')]),
      });
    };
    for (const [path, file] of files) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        add(path, file.mode, file.sha);
      } else {
        const name = path.slice(0, slash);
        if (!dirs.has(name)) dirs.set(name, new Map());
        dirs.get(name)!.set(path.slice(slash + 1), file);
      }
    }
    for (const [name, children] of dirs) add(name, '40000', this.writeTree(children));
    entries.sort((a, b) => Buffer.compare(a.sort, b.sort));
    return this.put(2, Buffer.concat(entries.map(entry => entry.data)));
  }
  commit(branch: string, files: Files, message: string) {
    const ref = 'refs/heads/' + branch;
    const parent = this.refs.get(ref);
    const identity = 'Forge <forge@localhost> ' + epoch + ' +0000';
    const tree = this.writeTree(files);
    const sha = this.put(1, Buffer.from(
      'tree ' + tree + '\n' + (parent ? 'parent ' + parent + '\n' : '') +
      'author ' + identity + '\ncommitter ' + identity + '\n\n' + message + '\n',
    ));
    this.refs.set(ref, sha);
    return sha;
  }
}

export function hashObject(type: number, data: Buffer) {
  return createHash('sha1').update(looseHeader(type, data.length)).update(data).digest('hex');
}
function looseHeader(type: number, size: number) {
  return types[type] + ' ' + size + '\0';
}
export function makeObject(type: number, data: Buffer, compressed?: Buffer): GitObject {
  const loose = deflateSync(Buffer.concat([Buffer.from(looseHeader(type, data.length)), data]), { level: 1 });
  return { type, data, loose, compressed };
}
export function compressedObject(object: GitObject) {
  return object.compressed ??= deflateSync(object.data, { level: 1 });
}
