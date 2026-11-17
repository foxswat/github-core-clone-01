import { Store, HttpError, fail, required, stateList, type Input } from './store.ts';

const info = { serverInfo: { name: 'makefun-forge', version: '1.0.0' }, capabilities: { tools: {} } };
const versions = ['2026-07-28', '2025-11-25'];
const location = ['owner', 'repo'];
function tool(name: string, description: string, fields: string[], required: string[]) {
  return {
    name, description, inputSchema: { type: 'object', properties: Object.fromEntries(fields.map(field =>
      [field, { type: field === 'pull_number' ? 'integer' : field === 'private' ? 'boolean' : 'string' }])), required,
      ...(fields.includes('full_name') ? { anyOf: [{ required: location }, { required: ['full_name'] }] } : {}),
    },
  };
}
const names = [
  tool('create_repo', 'Create a repository for the authenticated user.', ['name', 'description', 'private'], ['name']),
  tool('get_repo', 'Read a repository by owner and name.', [...location, 'full_name'], []),
  tool('create_issue', 'Open an issue in a repository.', [...location, 'full_name', 'title', 'body'], ['title']),
  tool('list_issues', 'List repository issues filtered by state.', [...location, 'full_name', 'state'], []),
  tool('create_pull_request', 'Open a pull request from a head branch to a base branch.',
    [...location, 'full_name', 'title', 'body', 'head', 'base'], ['title', 'head', 'base']),
  tool('merge_pull_request', 'Squash and merge an open pull request.', [...location, 'full_name', 'pull_number'], ['pull_number']),
];
const tools = new Set(names.map(tool => tool.name));

function call(store: Store, name: string, args: Input) {
  if (name === 'create_repo') return store.view(store.createRepo(args));
  const full = typeof args.full_name === 'string' ? args.full_name.split('/') : [];
  const repo = store.repo(required(args.owner ?? full[0], 'owner'), required(args.repo ?? full[1], 'repo'));
  switch (name) {
    case 'get_repo': return store.view(repo);
    case 'create_issue': return store.createIssue(repo, args);
    case 'list_issues': return stateList(repo.issues.values(), args.state ?? 'open').reverse();
    case 'create_pull_request': return store.createPull(repo, args);
    case 'merge_pull_request': return store.merge(repo, repo.pulls.get(Number(args.pull_number)) ?? fail(), args);
    default: return fail();
  }
}

export function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function mcp(store: Store, body: Input): [number, unknown?] {
  const { id, method, params } = body;
  const result = (value: unknown): [number, unknown] => [200, { jsonrpc: '2.0', id: id ?? null, result: value }];
  switch (method) {
    case 'server/discover': return result({ ...info, supportedVersions: versions });
    case 'initialize': return result({ ...info, protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[1] });
    case 'notifications/initialized': return [202];
    case 'ping': return result({});
    case 'tools/list': return result({ tools: names });
    case 'tools/call': {
      const name = params?.name;
      if (!tools.has(name)) return [200, rpcError(id, -32602, 'Unknown tool')];
      try {
        const value = call(store, name, params.arguments ?? {});
        return result({ content: [{ type: 'text', text: JSON.stringify(value) }] });
      } catch (error) {
        const message = error instanceof HttpError ? error.message : 'Invalid arguments';
        return result({ isError: true, content: [{ type: 'text', text: message }] });
      }
    }
    default: return [200, rpcError(id, -32601, 'Method not found')];
  }
}
