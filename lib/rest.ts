import { Store, fail, required, stateList, type Repository, type Input } from './store.ts';

export function rest(store: Store, method: string, parts: string[], url: URL, body: Input): [number, unknown?, Record<string, string>?] {
  const [group, owner, name, resource, number, action] = parts;
  const query = url.searchParams;
  if (!group && method === 'GET') {
    return [200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }];
  }
  if (group === 'meta' && parts.length === 1 && method === 'GET') return [200, { installed_version: '1.0.0' }];
  if (group === 'user' && parts.length === 1 && method === 'GET' && store.owner) return [200, { login: store.login }];
  if (group === 'user' && owner === 'repos' && parts.length === 2) {
    if (method === 'POST') return [201, store.view(store.createRepo(body))];
    if (method === 'GET') {
      const limit = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
      const page = Math.max(1, Number(query.get('page')) || 1);
      const repos = [...store.repos.values()];
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      return [200, repos.slice((page - 1) * limit, page * limit).map(repo => store.view(repo)),
        page * limit < repos.length ? { link: '<' + next + '>; rel="next"' } : undefined];
    }
  }
  if (group !== 'repos' || !owner || !name) fail();
  const repo = store.repo(owner, name);
  if (!resource) {
    if (method === 'GET') return [200, store.view(repo)];
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      return [200, store.view(repo)];
    }
    if (method === 'DELETE') {
      store.repos.delete(name.toLowerCase());
      return [204];
    }
  }
  if (resource === 'git' && number === 'refs') {
    if (method === 'POST' && !action) {
      const ref = required(body.ref, 'ref');
      const sha = required(body.sha, 'sha');
      if (!/^refs\/(heads|tags)\/.+/.test(ref) || !repo.objects.has(sha) || repo.refs.has(ref)) fail(422, 'Invalid ref');
      repo.refs.set(ref, sha);
      return [201, { ref, object: { sha } }];
    }
    if (method === 'GET' && action) {
      const ref = 'refs/' + parts.slice(5).join('/');
      const sha = repo.refs.get(ref) ?? fail();
      return [200, { ref, object: { sha } }];
    }
  }
  if (method === 'GET' && resource === 'branches') {
    const view = (name: string, sha: string) => ({ name, commit: { sha } });
    if (number) return [200, view(number, repo.refs.get('refs/heads/' + parts.slice(4).join('/')) ?? fail())];
    return [200, [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => view(ref.slice(11), sha))];
  }
  if (method === 'GET' && resource === 'commits' && !number) {
    return [200, [...repo.ancestors(repo.resolve(query.get('sha') ?? repo.branch))]
      .map(sha => ({ sha, commit: { message: repo.readCommit(sha)!.message } }))];
  }
  if (resource === 'contents') return contents(repo, method, parts.slice(4).join('/'), query, body);
  if (resource === 'labels' && !number && method === 'POST') {
    const label = { name: required(body.name, 'name'), color: body.color ?? '', description: body.description ?? '' };
    repo.labels.set(label.name, label);
    return [201, label];
  }
  if (resource === 'issues') {
    if (!number) {
      if (method === 'POST') return [201, store.createIssue(repo, body)];
      if (method === 'GET') {
        const list = stateList(repo.issues.values(), query.get('state') ?? 'open');
        return [200, query.get('direction') === 'asc' ? list : list.reverse()];
      }
    } else {
      const issue = repo.issues.get(Number(number)) ?? fail();
      if (!action && method === 'GET') return [200, issue];
      if (!action && method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        return [200, issue];
      }
      if (action === 'comments' && parts.length === 6) {
        if (method === 'GET') return [200, repo.comments.get(issue.number) ?? []];
        if (method === 'POST') return [201, store.comment(repo, issue, body)];
      }
    }
  }
  if (resource === 'pulls') {
    if (!number) {
      if (method === 'POST') return [201, store.createPull(repo, body)];
      if (method === 'GET') return [200, stateList(repo.pulls.values(), query.get('state') ?? 'open').reverse()];
    } else {
      const pull = repo.pulls.get(Number(number)) ?? fail();
      if (!action && method === 'GET') return [200, pull];
      if (action === 'files' && method === 'GET' && parts.length === 6) return [200, store.pullFiles(repo, pull)];
      if (action === 'merge' && method === 'PUT' && parts.length === 6) return [200, store.merge(repo, pull, body)];
    }
  }
  fail();
}

function contents(repo: Repository, method: string, path: string, query: URLSearchParams, body: Input): [number, unknown] {
  if (method === 'GET') {
    const tip = repo.resolve(query.get('ref') ?? repo.branch);
    const tree = repo.readCommit(tip)?.tree ?? fail();
    let sha = tree;
    for (const name of path.split('/').filter(Boolean)) {
      if (repo.objects.get(sha)?.type !== 2) fail();
      sha = repo.entries(sha).find(entry => entry.name === name)?.sha ?? fail();
    }
    const object = repo.objects.get(sha) ?? fail();
    if (object.type === 2) return [200, repo.entries(sha).map(entry => ({
      name: entry.name, path: path ? path + '/' + entry.name : entry.name, sha: entry.sha,
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: repo.objects.get(entry.sha)?.data.length ?? 0,
    }))];
    return [200, { type: 'file', name: path.split('/').at(-1), path, sha, size: object.data.length,
      encoding: 'base64', content: object.data.toString('base64') }];
  }
  if (method !== 'PUT' && method !== 'DELETE') fail();
  if (!path || path.split('/').some(name => !name || name === '.' || name === '..' || name.includes('\0'))) fail(422, 'Invalid path');
  const branch = body.branch ?? repo.branch;
  const ref = 'refs/heads/' + branch;
  const tip = repo.refs.get(ref);
  if (!tip && branch !== repo.branch) fail(422, 'Unknown branch');
  const files = repo.files(tip);
  const current = files.get(path);
  if (method === 'DELETE' && !current) fail();
  if (body.sha !== current?.sha) fail(409, 'SHA does not match');
  const message = required(body.message, 'message');
  if (method === 'DELETE') {
    files.delete(path);
    return [200, { commit: { sha: repo.commit(branch, files, message) } }];
  }
  if (typeof body.content !== 'string') fail(422, 'Missing content');
  for (const existing of files.keys()) {
    if (existing.startsWith(path + '/') || path.startsWith(existing + '/')) fail(409, 'Path conflicts with existing content');
  }
  const sha = repo.put(3, Buffer.from(body.content, 'base64'));
  files.set(path, { sha, mode: current?.mode ?? '100644' });
  return [current ? 200 : 201, { content: { sha, encoding: 'base64' }, commit: { sha: repo.commit(branch, files, message) } }];
}
