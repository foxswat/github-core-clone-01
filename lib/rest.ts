import {
  fail, required, stateList, Store,
  type Input, type Repository,
} from './store.ts';

type RestResponse = [number, unknown?, Record<string, string>?];

export function rest(
  store: Store, method: string, parts: string[], url: URL, body: Input,
): RestResponse {
  const [segment, account, project, endpoint, identifier, operation] = parts;
  const params = url.searchParams;
  if (method === 'GET' && !segment) {
    return [200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' }];
  }
  if (segment === 'meta' && parts.length === 1 && method === 'GET') {
    return [200, { installed_version: '1.0.0' }];
  }
  if (segment === 'user' && parts.length === 1 && method === 'GET' && store.owner) {
    return [200, { login: store.login }];
  }
  if (segment === 'user' && account === 'repos' && parts.length === 2) {
    if (method === 'POST') {
      return [201, store.view(store.createRepo(body))];
    }
    if (method === 'GET') {
      const pageSize = Math.max(1, Math.min(100, Number(params.get('per_page')) || 30));
      const pageIndex = Math.max(1, Number(params.get('page')) || 1);
      const allRepos = Array.from(store.repos.values());
      const followingPage = new URL(url);
      followingPage.searchParams.set('page', String(pageIndex + 1));
      const selectedRepos = allRepos.slice((pageIndex - 1) * pageSize, pageIndex * pageSize);
      const responseHeaders = pageIndex * pageSize < allRepos.length
        ? { link: `<${followingPage}>; rel="next"` }
        : undefined;
      return [200, selectedRepos.map(projectRepo => store.view(projectRepo)), responseHeaders];
    }
  }
  if (segment !== 'repos' || !account || !project) {
    fail();
  }
  const repository = store.repo(account, project);
  if (!endpoint) {
    switch (method) {
      case 'GET':
        return [200, store.view(repository)];
      case 'PATCH':
        if (typeof body.description === 'string') {
          repository.description = body.description;
        }
        return [200, store.view(repository)];
      case 'DELETE':
        store.repos.delete(project.toLowerCase());
        return [204];
    }
  }
  if (endpoint === 'git' && identifier === 'refs') {
    if (method === 'POST' && !operation) {
      const reference = required(body.ref, 'ref');
      const objectId = required(body.sha, 'sha');
      if (!/^refs\/(heads|tags)\/.+/.test(reference)
        || !repository.objects.has(objectId) || repository.refs.has(reference)) {
        fail(422, 'Invalid ref');
      }
      repository.refs.set(reference, objectId);
      return [201, { ref: reference, object: { sha: objectId } }];
    }
    if (method === 'GET' && operation) {
      const reference = `refs/${parts.slice(5).join('/')}`;
      const objectId = repository.refs.get(reference) ?? fail();
      return [200, { ref: reference, object: { sha: objectId } }];
    }
  }
  if (endpoint === 'branches' && method === 'GET') {
    const branchView = (branchName: string, objectId: string) => ({
      name: branchName, commit: { sha: objectId },
    });
    if (identifier) {
      const branchRef = `refs/heads/${parts.slice(4).join('/')}`;
      return [200, branchView(identifier, repository.refs.get(branchRef) ?? fail())];
    }
    const branchRefs = Array.from(repository.refs).filter(([reference]) => reference.startsWith('refs/heads/'));
    return [200, branchRefs.map(([reference, objectId]) => branchView(reference.slice(11), objectId))];
  }
  if (endpoint === 'commits' && method === 'GET' && !identifier) {
    const startingCommit = repository.resolve(params.get('sha') ?? repository.branch);
    const history = Array.from(repository.ancestors(startingCommit));
    return [200, history.map(objectId => ({
      sha: objectId, commit: { message: repository.readCommit(objectId)!.message },
    }))];
  }
  if (endpoint === 'contents') {
    return handleContents(repository, method, parts.slice(4).join('/'), params, body);
  }
  if (endpoint === 'labels' && !identifier && method === 'POST') {
    const createdLabel = {
      name: required(body.name, 'name'),
      color: body.color ?? '',
      description: body.description ?? '',
    };
    repository.labels.set(createdLabel.name, createdLabel);
    return [201, createdLabel];
  }
  if (endpoint === 'issues') {
    if (!identifier) {
      switch (method) {
        case 'POST':
          return [201, store.createIssue(repository, body)];
        case 'GET': {
          const matchingIssues = stateList(repository.issues.values(), params.get('state') ?? 'open');
          if (params.get('direction') !== 'asc') matchingIssues.reverse();
          return [200, matchingIssues];
        }
      }
    } else {
      const selectedIssue = repository.issues.get(Number(identifier)) ?? fail();
      if (!operation) {
        if (method === 'GET') return [200, selectedIssue];
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') selectedIssue.state = body.state;
          if (typeof body.title === 'string') selectedIssue.title = body.title;
          if (typeof body.body === 'string') selectedIssue.body = body.body;
          return [200, selectedIssue];
        }
      }
      if (operation === 'comments' && parts.length === 6) {
        if (method === 'GET') return [200, repository.comments.get(selectedIssue.number) ?? []];
        if (method === 'POST') return [201, store.comment(repository, selectedIssue, body)];
      }
    }
  }
  if (endpoint === 'pulls') {
    if (!identifier) {
      switch (method) {
        case 'POST':
          return [201, store.createPull(repository, body)];
        case 'GET':
          return [200, stateList(repository.pulls.values(), params.get('state') ?? 'open').reverse()];
      }
    } else {
      const selectedPull = repository.pulls.get(Number(identifier)) ?? fail();
      if (!operation && method === 'GET') return [200, selectedPull];
      if (operation === 'files' && method === 'GET' && parts.length === 6) {
        return [200, store.pullFiles(repository, selectedPull)];
      }
      if (operation === 'merge' && method === 'PUT' && parts.length === 6) {
        return [200, store.merge(repository, selectedPull, body)];
      }
    }
  }
  return fail();
}

function handleContents(
  repository: Repository, method: string, pathname: string, params: URLSearchParams, body: Input,
): [number, unknown] {
  if (method === 'GET') {
    const resolvedCommit = repository.resolve(params.get('ref') ?? repository.branch);
    let objectId = repository.readCommit(resolvedCommit)?.tree ?? fail();
    const components = pathname.split('/').filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      if (repository.objects.get(objectId)?.type !== 2) fail();
      const child = repository.entries(objectId).find(candidate => candidate.name === components[index]);
      objectId = child?.sha ?? fail();
    }
    const storedObject = repository.objects.get(objectId) ?? fail();
    if (storedObject.type === 2) {
      const children = repository.entries(objectId).map(child => ({
        name: child.name,
        path: pathname ? `${pathname}/${child.name}` : child.name,
        sha: child.sha,
        type: child.mode === '40000' ? 'dir' : 'file',
        size: repository.objects.get(child.sha)?.data.length ?? 0,
      }));
      return [200, children];
    }
    return [200, {
      type: 'file', name: pathname.split('/').at(-1), path: pathname,
      sha: objectId, size: storedObject.data.length,
      encoding: 'base64', content: storedObject.data.toString('base64'),
    }];
  }
  if (method !== 'PUT' && method !== 'DELETE') return fail();
  const invalidPath = !pathname || pathname.split('/').some(component => (
    !component || component === '.' || component === '..' || component.includes('\0')
  ));
  if (invalidPath) {
    fail(422, 'Invalid path');
  }
  const targetBranch = body.branch ?? repository.branch;
  const branchReference = `refs/heads/${targetBranch}`;
  const branchTip = repository.refs.get(branchReference);
  if (!branchTip && targetBranch !== repository.branch) {
    fail(422, 'Unknown branch');
  }
  const updatedFiles = repository.files(branchTip);
  const previousEntry = updatedFiles.get(pathname);
  if (method === 'DELETE' && !previousEntry) return fail();
  if (body.sha !== previousEntry?.sha) {
    fail(409, 'SHA does not match');
  }
  const commitMessage = required(body.message, 'message');
  if (method === 'DELETE') {
    updatedFiles.delete(pathname);
    return [200, { commit: { sha: repository.commit(targetBranch, updatedFiles, commitMessage) } }];
  }
  if (typeof body.content !== 'string') {
    fail(422, 'Missing content');
  }
  for (const occupiedPath of updatedFiles.keys()) {
    if (occupiedPath.startsWith(`${pathname}/`) || pathname.startsWith(`${occupiedPath}/`)) {
      fail(409, 'Path conflicts with existing content');
    }
  }
  const blobId = repository.put(3, Buffer.from(body.content, 'base64'));
  updatedFiles.set(pathname, { sha: blobId, mode: previousEntry?.mode ?? '100644' });
  return [previousEntry ? 200 : 201, {
    content: { sha: blobId, encoding: 'base64' },
    commit: { sha: repository.commit(targetBranch, updatedFiles, commitMessage) },
  }];
}
