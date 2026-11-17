import { Store, fail, type Input, type Issue, type Pull, type Repository } from './store.ts';

interface Field { name: string; alias: string; args: Input; fields: Field[] }
const schema: Record<string, string[]> = {
  Issue: 'id number title state body'.split(' '),
  PullRequest: 'id number title body headRefName baseRefName mergeable state merged files'.split(' '),
  Repository: 'id databaseId name nameWithOwner owner defaultBranchRef viewerPermission hasIssuesEnabled issue issues pullRequests pullRequest'.split(' '),
};

function parse(source: string, variables: Input) {
  const tokens = source.match(/#[^\n\r]*|"(?:[^"\\]|\\.)*"|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[^\s,]/g)
    ?.filter(token => !token.startsWith('#')) ?? [];
  let index = 0;
  const peek = () => tokens[index];
  const take = () => {
    if (index >= tokens.length) throw new Error('Unexpected end of query');
    return tokens[index++];
  };
  const expect = (token: string) => {
    if (take() !== token) throw new Error('Expected ' + token);
  };
  const name = () => {
    const token = take();
    if (!/^[_A-Za-z]\w*$/.test(token)) throw new Error('Expected a name');
    return token;
  };
  function value(): unknown {
    const token = take();
    if (token === '$') return variables[name()];
    if (token === '[') {
      const items = [];
      while (peek() !== ']') items.push(value());
      take();
      return items;
    }
    if (token === '{') return entries('}');
    if (/^["\d-]/.test(token) || ['null', 'true', 'false'].includes(token)) return JSON.parse(token);
    return token;
  }
  function entries(end: string) {
    const args: Input = Object.create(null);
    while (peek() !== end) {
      const key = name();
      expect(':');
      args[key] = value();
    }
    take();
    return args;
  }
  function selection(): Field[] {
    expect('{');
    const fields: Field[] = [];
    while (peek() !== '}') {
      if (peek() === '...') {
        take();
        expect('on');
        name();
        fields.push(...selection());
        continue;
      }
      const alias = name();
      let fieldName = alias;
      if (peek() === ':') {
        take();
        fieldName = name();
      }
      const args = peek() === '(' ? (take(), entries(')')) : {};
      fields.push({ name: fieldName, alias, args, fields: peek() === '{' ? selection() : [] });
    }
    take();
    return fields;
  }
  if (peek() !== '{') {
    const kind = take();
    if (kind !== 'query' && kind !== 'mutation') throw new Error('Unsupported operation');
    if (/^\w/.test(peek() ?? '')) name();
    if (peek() === '(') {
      while (take() !== ')') { /* Variable definitions are supplied separately. */ }
    }
  }
  return selection();
}

type Resolver = (args: Input) => unknown;
function project(value: unknown, fields: Field[]): unknown {
  if (value == null || !fields.length) return value ?? null;
  if (Array.isArray(value)) return value.map(item => project(item, fields));
  const record = value as Record<string, unknown>;
  const result: Input = Object.create(null);
  for (const field of fields) {
    if (!Object.hasOwn(record, field.name)) throw new Error('Cannot query field "' + field.name + '"');
    const property = record[field.name];
    result[field.alias] = project(typeof property === 'function' ? (property as Resolver)(field.args) : property, field.fields);
  }
  return result;
}

function connection<T>(items: T[], args: Input, view: (item: T) => unknown) {
  const offset = Math.max(0, Number(args.after?.split(':')[1]) || 0);
  const nodes = items.slice(offset, offset + (args.first ?? items.length)).map(view);
  const end = offset + nodes.length;
  return { nodes, totalCount: items.length, pageInfo: { hasNextPage: end < items.length, endCursor: nodes.length ? 'cursor:' + end : null } };
}
const issueView = (issue?: Issue) => issue ? { ...issue, state: issue.state.toUpperCase() } : null;
function pullView(store: Store, repo: Repository, pull?: Pull) {
  return pull ? {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body, merged: pull.merged,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(), headRefName: pull.head.ref, baseRefName: pull.base.ref,
    mergeable: () => store.mergeFiles(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    files: (args: Input) => connection(store.pullFiles(repo, pull), args, file => ({ path: file.filename })),
  } : null;
}
function repoView(store: Store, repo?: Repository) {
  if (!repo) return null;
  return {
    id: repo.id, databaseId: repo.databaseId, name: repo.name, nameWithOwner: store.login + '/' + repo.name,
    owner: { login: store.login }, defaultBranchRef: repo.resolve(repo.branch) ? { name: repo.branch } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    issue: (args: Input) => issueView(repo.issues.get(args.number)),
    issues: (args: Input) => {
      const items = [...repo.issues.values()].filter(item => !args.states || args.states.includes(item.state.toUpperCase()));
      if (args.orderBy?.direction !== 'ASC') items.reverse();
      return connection(items, args, issueView);
    },
    pullRequest: (args: Input) => pullView(store, repo, repo.pulls.get(args.number)),
    pullRequests: (args: Input) => {
      const items = [...repo.pulls.values()].filter(item => !args.states || args.states.includes(item.merged ? 'MERGED' : item.state.toUpperCase()));
      return connection(items.reverse(), args, item => pullView(store, repo, item));
    },
  };
}

function repoById(store: Store, id: string) {
  return [...store.repos.values()].find(repo => repo.id === id);
}
function recordById<T extends Issue | Pull>(store: Store, id: string, list: (repo: Repository) => Iterable<T>): [Repository, T] {
  for (const repo of store.repos.values()) for (const item of list(repo)) {
    if (item.id === id) return [repo, item];
  }
  return fail();
}
function root(store: Store) {
  return {
    viewer: () => ({ login: store.login }),
    repository: ({ owner, name }: Input) => repoView(store, store.find(owner, name)),
    node: ({ id }: Input) => repoView(store, repoById(store, id)),
    __type: ({ name }: Input) => {
      if (name === 'SearchType') return { name, kind: 'ENUM', fields: null, enumValues: [{ name: 'ISSUE' }] };
      if (!Object.hasOwn(schema, name)) return null;
      return { name, kind: 'OBJECT', enumValues: null, fields: schema[name].map(name => ({ name })) };
    },
    createIssue: ({ input }: Input) => ({
      issue: issueView(store.createIssue(repoById(store, input.repositoryId) ?? fail(), input)),
    }),
    closeIssue: ({ input }: Input) => {
      const [, issue] = recordById(store, input.issueId, repo => repo.issues.values());
      issue.state = 'closed';
      return { issue: issueView(issue) };
    },
    addComment: ({ input }: Input) => {
      const [repo, issue] = recordById(store, input.subjectId, repo => repo.issues.values());
      const comment = store.comment(repo, issue, input);
      return { commentEdge: { node: { ...comment, id: comment.node_id } } };
    },
    createPullRequest: ({ input }: Input) => {
      const repo = repoById(store, input.repositoryId) ?? fail();
      const pull = store.createPull(repo, { ...input, head: input.headRefName, base: input.baseRefName });
      return { pullRequest: pullView(store, repo, pull) };
    },
    mergePullRequest: ({ input }: Input) => {
      const [repo, pull] = recordById(store, input.pullRequestId, repo => repo.pulls.values());
      store.merge(repo, pull, { commit_title: input.commitHeadline });
      return { pullRequest: pullView(store, repo, pull) };
    },
  };
}

export function graphql(store: Store, body: Input) {
  const execute = (operation: Input) => {
    try {
      if (typeof operation?.query !== 'string') throw new Error('Expected a query');
      return { data: project(root(store), parse(operation.query, operation.variables ?? {})) };
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'Query failed' }] };
    }
  };
  return Array.isArray(body) ? body.map(execute) : execute(body);
}
