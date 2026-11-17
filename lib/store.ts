import { Objects, timestamp, type Files, type FileEntry } from './objects.ts';

export type Input = Record<string, any>;
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function fail(status = 404, message = 'Not Found'): never { throw new HttpError(status, message); }
export function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(422, 'Missing ' + field);
  return value;
}
type State = 'open' | 'closed';
interface Identity { id: string; number: number; node_id: string }
interface Label { name: string; color: string; description: string }
export interface Issue extends Identity {
  title: string; body: string; state: State; labels: Label[]; created_at: string;
}
export interface Comment { id: number; node_id: string; body: string; created_at: string }
export interface Pull extends Identity {
  title: string; body: string; state: State; merged: boolean; merged_at: string | null;
  merge_commit_sha: string | null; head: { ref: string; sha: string }; base: { ref: string; sha: string };
}
export class Repository extends Objects {
  id: string;
  databaseId: number;
  name: string;
  description: string;
  privateRepo: boolean;
  issues = new Map<number, Issue>();
  comments = new Map<number, Comment[]>();
  pulls = new Map<number, Pull>();
  labels = new Map<string, Label>();
  nextNumber = 1;
  constructor(id: number, input: Input) {
    super(input.default_branch || 'main');
    this.name = input.name;
    this.description = input.description ?? '';
    this.privateRepo = input.private === true || input.visibility === 'private';
    this.id = 'repo-' + id;
    this.databaseId = id;
  }
}

function sameFile(a?: FileEntry, b?: FileEntry) {
  return a?.sha === b?.sha && a?.mode === b?.mode;
}
export function stateList<T extends { state: string }>(items: Iterable<T>, state = 'open') {
  return Array.from(items).filter(item => state === 'all' || item.state === state);
}

export class Store {
  owner?: string;
  repos = new Map<string, Repository>();
  private repoId = 0;
  private issueId = 0;
  private pullId = 0;
  private commentId = 0;
  get login() { return this.owner ?? 'forge'; }
  identify(owner: string) {
    this.owner ??= owner;
    return this.owner.toLowerCase() === owner.toLowerCase();
  }
  find(owner: string, name: string) {
    return this.identify(owner) ? this.repos.get(name.toLowerCase()) : undefined;
  }
  repo(owner: string, name: string) { return this.find(owner, name) ?? fail(); }
  view(repo: Repository) {
    return {
      id: repo.id, node_id: repo.id, name: repo.name, full_name: this.login + '/' + repo.name,
      owner: { login: this.login }, description: repo.description, private: repo.privateRepo,
      visibility: repo.privateRepo ? 'private' : 'public', default_branch: repo.branch,
    };
  }
  createRepo(input: Input) {
    const name = required(input.name, 'name');
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') fail(422, 'Invalid name');
    const key = name.toLowerCase();
    if (this.repos.has(key)) fail(422, 'Repository already exists');
    const repo = new Repository(++this.repoId, input);
    this.repos.set(key, repo);
    return repo;
  }
  createIssue(repo: Repository, input: Input) {
    const title = required(input.title, 'title');
    if (input.labels != null && !Array.isArray(input.labels)) fail(422, 'Invalid labels');
    const labels = (input.labels ?? []).map((name: string | Label) =>
      repo.labels.get(typeof name === 'string' ? name : name?.name) ?? fail(422, 'Unknown label'));
    const id = 'issue-' + ++this.issueId;
    const issue: Issue = { id, node_id: id, number: repo.nextNumber++, title, body: input.body ?? '',
      state: 'open', labels, created_at: timestamp };
    repo.issues.set(issue.number, issue);
    return issue;
  }
  comment(repo: Repository, issue: Issue, input: Input) {
    const body = required(input.body, 'body');
    const id = ++this.commentId;
    const comment = { id, node_id: 'comment-' + id, body, created_at: timestamp };
    const comments = repo.comments.get(issue.number) ?? [];
    comments.push(comment);
    repo.comments.set(issue.number, comments);
    return comment;
  }
  createPull(repo: Repository, input: Input) {
    const title = required(input.title, 'title');
    const head = required(input.head, 'head').replace(/^.*:/, '');
    const base = required(input.base, 'base');
    const headSha = repo.resolve(head);
    const baseSha = repo.resolve(base);
    if (!headSha || !baseSha) fail(422, 'Unknown head or base');
    const id = 'pull-' + ++this.pullId;
    const pull: Pull = { id, node_id: id, number: repo.nextNumber++, title, body: input.body ?? '',
      state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
      head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } };
    repo.pulls.set(pull.number, pull);
    return pull;
  }
  changes(repo: Repository, pull: Pull) {
    const head = repo.resolve(pull.head.ref) ?? pull.head.sha;
    const common = repo.ancestors(repo.resolve(pull.base.ref));
    const ancestor = [...repo.ancestors(head)].find(sha => common.has(sha));
    const before = repo.files(ancestor);
    const after = repo.files(head);
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    return paths.filter(path => !sameFile(before.get(path), after.get(path)))
      .map(path => ({ path, before: before.get(path), after: after.get(path) }));
  }
  pullFiles(repo: Repository, pull: Pull) {
    const lines = (entry?: FileEntry) => {
      const content = entry && repo.objects.get(entry.sha)?.data.toString();
      return content ? content.replace(/\n$/, '').split('\n').length : 0;
    };
    return this.changes(repo, pull).map(({ path, before, after }) => {
      const additions = lines(after);
      const deletions = lines(before);
      return { filename: path, status: before ? (after ? 'modified' : 'removed') : 'added',
        additions, deletions, changes: additions + deletions };
    });
  }
  mergeFiles(repo: Repository, pull: Pull): Files | null {
    const files = repo.files(repo.resolve(repo.branch));
    for (const { path, before, after } of this.changes(repo, pull)) {
      const current = files.get(path);
      if (!sameFile(current, before) && !sameFile(current, after)) return null;
      if (after) {
        for (const existing of files.keys()) {
          if (existing.startsWith(path + '/') || path.startsWith(existing + '/')) return null;
        }
        files.set(path, after);
      } else files.delete(path);
    }
    return files;
  }
  merge(repo: Repository, pull: Pull, input: Input = {}) {
    if (pull.state !== 'open') fail(405, 'Pull request is closed');
    const files = this.mergeFiles(repo, pull);
    if (!files) fail(405, 'Pull request is conflicted');
    const sha = repo.commit(repo.branch, files, input.commit_title ?? pull.title);
    Object.assign(pull, { state: 'closed', merged: true, merged_at: timestamp, merge_commit_sha: sha });
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  }
}
