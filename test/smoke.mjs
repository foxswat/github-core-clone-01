import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const auth = 'Bearer smoke-token';
let registered;
let done = false;
const ready = new Promise(resolve => { registered = resolve; });
const environment = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/register' && req.method === 'POST') {
    const parts = [];
    for await (const part of req) parts.push(part);
    registered(JSON.parse(Buffer.concat(parts)).port);
    res.end('{}');
  } else if (req.url === '/done') res.end(JSON.stringify({ done }));
  else { res.statusCode = 404; res.end('{}'); }
});
environment.listen(0, '127.0.0.1');
await once(environment, 'listening');
const directory = await mkdtemp(join(import.meta.dirname, '.smoke-'));
const forge = spawn(process.execPath, ['main.ts'], {
  cwd: join(import.meta.dirname, '..'),
  env: { ...process.env, MAKEFUN_SHOP_TOKEN: 'smoke-token',
    MAKEFUN_ENV_URL: 'http://127.0.0.1:' + environment.address().port, MAKEFUN_TRIAL_NOW: '1000000000' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const exited = once(forge, 'exit');
const ownerPath = '/api/v3/repos/smoke/project';
let origin;
async function request(path, status, method = 'GET', data, authorized = true) {
  const headers = authorized ? { authorization: auth } : {};
  if (data !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(origin + path, {
    method, headers, body: typeof data === 'string' ? data : data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(3000),
  });
  const text = await response.text();
  assert.equal(response.status, status, method + ' ' + path + ' ' + text);
  assert.match(response.headers.get('content-type'), /application\/json/);
  if (path.startsWith('/api/v3')) assert.ok(response.headers.get('x-github-request-id'));
  return text ? JSON.parse(text) : undefined;
}
const rest = (suffix, status, method, data) => request(ownerPath + suffix, status, method, data);
const gql = (query, variables) => request('/api/graphql', 200, 'POST', { query, variables });
const rpc = (method, params, id = 1) => request('/mcp', 200, 'POST', { jsonrpc: '2.0', method, params, id });
async function call(name, args, id = name) {
  const reply = await rpc('tools/call', { name, arguments: args }, id);
  assert.equal(reply.id, id);
  assert.ok(!reply.error && !reply.result.isError, JSON.stringify(reply));
  return JSON.parse(reply.result.content[0].text);
}
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: '2001-09-09T01:46:40Z', GIT_COMMITTER_DATE: '2001-09-09T01:46:40Z' };
async function git(...args) {
  const { stdout } = await run('/usr/bin/git', ['-c', 'http.extraHeader=Authorization: ' + auth,
    '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', ...args],
  { cwd: directory, env: gitEnv, timeout: 10000 });
  return stdout.trim();
}
try {
  const port = await Promise.race([ready, exited.then(() => { throw new Error('Forge exited before registering'); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Registration timed out')), 5000).unref())]);
  origin = 'http://127.0.0.1:' + port;
  await request('/healthz', 200, 'GET', undefined, false);
  await request('/api/v3/', 401, 'GET', undefined, false);
  await request('/api/v3/', 200);
  await request('/api/v3/meta', 200);
  await request('/api/v3/user/repos', 400, 'POST', '{"name":');
  const repo = await request('/api/v3/user/repos', 201, 'POST', { name: 'project', private: true });
  assert.equal((await rest('', 200)).id, repo.id);
  await request('/api/v3/repos/foreign/project', 404);
  assert.equal((await rest('', 200, 'PATCH', { description: 'smoke' })).description, 'smoke');
  const file = '/contents/docs/readme.txt';
  const content = Buffer.from('base\n').toString('base64');
  const first = await rest(file, 201, 'PUT', { content, message: 'Initial' });
  assert.equal((await rest(file, 200)).content, content);
  assert.equal((await rest('/contents/docs', 200))[0].name, 'readme.txt');
  const updated = await rest(file, 200, 'PUT', { content, sha: first.content.sha, message: 'Update' });
  await rest(file, 409, 'PUT', { content, sha: 'stale', message: 'Stale' });
  await rest(file, 200, 'DELETE', { sha: updated.content.sha, message: 'Delete' });
  await rest(file, 404);
  await rest('/labels', 201, 'POST', { name: 'bug', color: '000000' });
  await rest('/issues', 422, 'POST', { title: 'Bad label', labels: ['missing'] });
  const issue = await rest('/issues', 201, 'POST', { title: 'First', labels: ['bug'] });
  const closed = await rest('/issues', 201, 'POST', { title: 'Closed' });
  await rest('/issues/' + closed.number, 200, 'PATCH', { state: 'closed' });
  const latest = await rest('/issues', 201, 'POST', { title: 'Latest' });
  await rest('/issues/' + issue.number + '/comments', 201, 'POST', { body: 'Test' });

  const remote = origin + '/smoke/project.git';
  await git('clone', remote, 'local');
  await git('clone', remote, 'peer');
  await git('-C', 'local', 'switch', '-c', 'feature');
  await writeFile(join(directory, 'local', 'feature.txt'), 'feature\n');
  await git('-C', 'local', 'add', 'feature.txt');
  await git('-C', 'local', 'commit', '-m', 'Feature');
  await git('-C', 'local', 'push', 'origin', 'feature');
  await git('-C', 'peer', 'fetch', 'origin');
  assert.equal(await git('-C', 'peer', 'show', 'origin/feature:feature.txt'), 'feature');

  const intro = await gql('{ __type(name:"Issue") { fields { name } } }');
  assert.ok(intro.data.__type.fields.some(field => field.name === 'body'));
  assert.deepEqual((await gql('{ repository(owner:"smoke",name:"project") { issues(states:[OPEN],orderBy:{field:CREATED_AT,direction:DESC}) { nodes { number } } } }'))
    .data.repository.issues.nodes.map(node => node.number), [latest.number, issue.number]);
  assert.match((await gql('{ viewer { badField } }')).errors[0].message, /badField/);
  assert.equal((await gql('{ repository(owner:"smoke", name:"missing") { id } }')).data.repository, null);
  const batch = await request('/api/graphql', 200, 'POST', [{ query: '{ viewer { login } }' }, { query: '{ viewer { login } }' }]);
  assert.equal(batch.length, 2);
  const mutation = await gql('mutation ($input: CreatePullRequestInput!) { createPullRequest(input:$input) { pullRequest { number headRefName baseRefName } } }',
    { input: { repositoryId: repo.id, title: 'Feature', headRefName: 'feature', baseRefName: 'main' } });
  const pull = mutation.data.createPullRequest.pullRequest;
  assert.equal((await rest('/pulls/' + pull.number, 200)).head.ref, 'feature');
  assert.ok((await rest('/pulls/' + pull.number + '/merge', 200, 'PUT', {})).merged);
  assert.equal((await rest('/contents/feature.txt', 200)).content, Buffer.from('feature\n').toString('base64'));

  await git('clone', '--depth', '1', remote, 'shallow');
  assert.equal(await git('-C', 'shallow', 'rev-list', '--count', 'HEAD'), '1');
  await git('-c', 'protocol.version=0', 'clone', remote, 'v0');
  assert.equal(await git('-C', 'v0', 'show', 'HEAD:feature.txt'), 'feature');
  await git('-C', 'peer', 'fetch', 'origin');
  await assert.rejects(git('-C', 'peer', 'push', '--force', 'origin', 'HEAD:main'), /non-fast-forward/);

  assert.equal((await rpc('initialize', { protocolVersion: '2025-11-25' })).result.protocolVersion, '2025-11-25');
  await request('/mcp', 202, 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.ok((await rpc('server/discover')).result.supportedVersions.includes('2026-07-28'));
  assert.equal(JSON.stringify(await rpc('tools/list')), JSON.stringify(await rpc('tools/list')));
  const toolRepo = await call('create_repo', { name: 'mcp' });
  assert.equal((await call('get_repo', { full_name: 'smoke/mcp' })).id, toolRepo.id);
  const args = { owner: 'smoke', repo: 'project' };
  const [toolIssue, readRepo] = await Promise.all([
    call('create_issue', { ...args, title: 'Via MCP' }), call('get_repo', args),
  ]);
  assert.equal(readRepo.id, repo.id);
  assert.ok((await call('list_issues', args)).some(row => row.id === toolIssue.id));
  const tip = (await rest('/branches/main', 200)).commit.sha;
  await rest('/git/refs', 201, 'POST', { ref: 'refs/heads/another', sha: tip });
  await rest('/contents/another.txt', 201, 'PUT', { branch: 'another', content, message: 'Another' });
  const restPull = await rest('/pulls', 201, 'POST', { title: 'REST pull', head: 'another', base: 'main' });
  assert.equal((await rest('/pulls/' + restPull.number + '/files', 200))[0].filename, 'another.txt');
  const toolPull = await call('create_pull_request', { ...args, title: 'MCP pull', head: 'another', base: 'main' });
  assert.ok((await call('merge_pull_request', { ...args, pull_number: toolPull.number })).merged);
  assert.equal((await rpc('tools/call', { name: 'missing' })).error.code, -32602);
  assert.ok((await rpc('tools/call', { name: 'create_repo', arguments: {} })).result.isError);
  assert.equal((await request('/mcp', 400, 'POST', 'bad')).error.code, -32700);
  await request('/mcp', 401, 'POST', {}, false);
  await rest('', 204, 'DELETE');
  await rest('', 404);
  done = true;
  assert.equal((await exited)[0], 0);
  console.log('Smoke passed: REST, GraphQL, MCP and system Git');
} finally {
  forge.kill();
  environment.closeAllConnections();
  environment.close();
  await rm(directory, { recursive: true, force: true });
}
