import { fail, Store, type Repository, type Pull, type Issue, type Input } from './store.ts';

interface SelectionEntry {
  fieldName: string;
  responseName: string;
  parameters: Input;
  children: SelectionEntry[];
}
type FieldResolver = (parameters: Input) => unknown;

const typeFields: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
};

function findRepoById(forge: Store, identifier: string) {
  return Array.from(forge.repos.values()).find(candidate => candidate.id === identifier);
}

function findRecordById<T extends Issue | Pull>(
  forge: Store, identifier: string, records: (repository: Repository) => Iterable<T>,
): [Repository, T] {
  for (const repository of forge.repos.values()) {
    for (const candidate of records(repository)) {
      if (candidate.id === identifier) return [repository, candidate];
    }
  }
  return fail();
}

function paginate<T>(collection: T[], parameters: Input, render: (entry: T) => unknown) {
  const start = Math.max(0, Number(parameters.after?.split(':')[1]) || 0);
  const selected = collection.slice(start, start + (parameters.first ?? collection.length));
  const nodes = selected.map(render);
  const pageEnd = start + nodes.length;
  return {
    nodes,
    totalCount: collection.length,
    pageInfo: {
      hasNextPage: pageEnd < collection.length,
      endCursor: nodes.length ? `cursor:${pageEnd}` : null,
    },
  };
}

function issueNode(ticket?: Issue) {
  if (!ticket) return null;
  return { ...ticket, state: ticket.state.toUpperCase() };
}

function pullNode(forge: Store, repository: Repository, request?: Pull) {
  if (!request) return null;
  return {
    id: request.id,
    number: request.number,
    title: request.title,
    body: request.body,
    merged: request.merged,
    state: request.merged ? 'MERGED' : request.state.toUpperCase(),
    headRefName: request.head.ref,
    baseRefName: request.base.ref,
    mergeable: () => forge.mergeFiles(repository, request) ? 'MERGEABLE' : 'CONFLICTING',
    files: (parameters: Input) => paginate(
      forge.pullFiles(repository, request), parameters, changed => ({ path: changed.filename }),
    ),
  };
}

function repoNode(forge: Store, repository?: Repository) {
  if (!repository) return null;
  return {
    id: repository.id,
    databaseId: repository.databaseId,
    name: repository.name,
    nameWithOwner: `${forge.login}/${repository.name}`,
    owner: { login: forge.login },
    defaultBranchRef: repository.resolve(repository.branch) ? { name: repository.branch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issue: (parameters: Input) => issueNode(repository.issues.get(parameters.number)),
    issues: (parameters: Input) => {
      const tickets = Array.from(repository.issues.values()).filter(ticket =>
        !parameters.states || parameters.states.includes(ticket.state.toUpperCase()));
      if (parameters.orderBy?.direction !== 'ASC') tickets.reverse();
      return paginate(tickets, parameters, issueNode);
    },
    pullRequest: (parameters: Input) => pullNode(forge, repository, repository.pulls.get(parameters.number)),
    pullRequests: (parameters: Input) => {
      const requests = Array.from(repository.pulls.values()).filter(request =>
        !parameters.states || parameters.states.includes(request.merged ? 'MERGED' : request.state.toUpperCase()));
      requests.reverse();
      return paginate(requests, parameters, request => pullNode(forge, repository, request));
    },
  };
}

function rootResolvers(forge: Store) {
  return {
    viewer: () => ({ login: forge.login }),
    repository: (parameters: Input) => repoNode(forge, forge.find(parameters.owner, parameters.name)),
    node: (parameters: Input) => repoNode(forge, findRepoById(forge, parameters.id)),
    __type: (parameters: Input) => {
      const requestedType = parameters.name;
      if (requestedType === 'SearchType') {
        return { name: requestedType, kind: 'ENUM', fields: null, enumValues: [{ name: 'ISSUE' }] };
      }
      if (!Object.hasOwn(typeFields, requestedType)) return null;
      return {
        name: requestedType,
        kind: 'OBJECT',
        enumValues: null,
        fields: typeFields[requestedType].map(fieldName => ({ name: fieldName })),
      };
    },
    createIssue: (parameters: Input) => {
      const payload = parameters.input;
      const destination = findRepoById(forge, payload.repositoryId) ?? fail();
      return { issue: issueNode(forge.createIssue(destination, payload)) };
    },
    closeIssue: (parameters: Input) => {
      const [, ticket] = findRecordById(forge, parameters.input.issueId, repository => repository.issues.values());
      ticket.state = 'closed';
      return { issue: issueNode(ticket) };
    },
    addComment: (parameters: Input) => {
      const payload = parameters.input;
      const [destination, ticket] = findRecordById(forge, payload.subjectId, repository => repository.issues.values());
      const posted = forge.comment(destination, ticket, payload);
      return { commentEdge: { node: { ...posted, id: posted.node_id } } };
    },
    createPullRequest: (parameters: Input) => {
      const payload = parameters.input;
      const destination = findRepoById(forge, payload.repositoryId) ?? fail();
      const created = forge.createPull(destination, { ...payload, head: payload.headRefName, base: payload.baseRefName });
      return { pullRequest: pullNode(forge, destination, created) };
    },
    mergePullRequest: (parameters: Input) => {
      const payload = parameters.input;
      const [destination, request] = findRecordById(forge, payload.pullRequestId, repository => repository.pulls.values());
      forge.merge(destination, request, { commit_title: payload.commitHeadline });
      return { pullRequest: pullNode(forge, destination, request) };
    },
  };
}

function parseDocument(document: string, bindings: Input) {
  const lexemes = (document.match(/#[^\n\r]*|"(?:[^"\\]|\\.)*"|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[^\s,]/g) ?? [])
    .filter(lexeme => !lexeme.startsWith('#'));
  let cursor = 0;
  const upcoming = () => lexemes[cursor];
  function consume() {
    if (cursor >= lexemes.length) throw new Error('Unexpected end of query');
    const consumed = lexemes[cursor];
    cursor += 1;
    return consumed;
  }
  function requireToken(wanted: string) {
    if (consume() !== wanted) throw new Error(`Expected ${wanted}`);
  }
  function readName() {
    const identifier = consume();
    if (!/^[_A-Za-z]\w*$/.test(identifier)) throw new Error('Expected a name');
    return identifier;
  }
  function readValue(): unknown {
    const literal = consume();
    switch (literal) {
      case '$': return bindings[readName()];
      case '{': return readProperties('}');
      case '[': {
        const elements: unknown[] = [];
        for (; upcoming() !== ']';) elements.push(readValue());
        consume();
        return elements;
      }
      default:
        if (/^["\d-]/.test(literal) || literal === 'null' || literal === 'true' || literal === 'false') {
          return JSON.parse(literal);
        }
        return literal;
    }
  }
  function readProperties(terminator: string): Input {
    const properties: Input = Object.create(null);
    for (; upcoming() !== terminator;) {
      const propertyName = readName();
      requireToken(':');
      properties[propertyName] = readValue();
    }
    consume();
    return properties;
  }
  function readSelection(): SelectionEntry[] {
    requireToken('{');
    const selections: SelectionEntry[] = [];
    for (; upcoming() !== '}';) {
      if (upcoming() === '...') {
        consume();
        requireToken('on');
        readName();
        selections.push(...readSelection());
      } else {
        const responseName = readName();
        let fieldName = responseName;
        if (upcoming() === ':') {
          consume();
          fieldName = readName();
        }
        let parameters: Input = {};
        if (upcoming() === '(') {
          consume();
          parameters = readProperties(')');
        }
        const children = upcoming() === '{' ? readSelection() : [];
        selections.push({ fieldName, responseName, parameters, children });
      }
    }
    consume();
    return selections;
  }
  if (upcoming() !== '{') {
    const operationKind = consume();
    if (!['query', 'mutation'].includes(operationKind)) throw new Error('Unsupported operation');
    if (/^\w/.test(upcoming() ?? '')) readName();
    if (upcoming() === '(') {
      // Bindings arrive independently; discard declarations through the closing parenthesis.
      for (; consume() !== ')';) {}
    }
  }
  return readSelection();
}

function shapeResult(resolved: unknown, selections: SelectionEntry[]): unknown {
  if (resolved == null) return null;
  if (selections.length === 0) return resolved;
  if (Array.isArray(resolved)) return resolved.map(element => shapeResult(element, selections));
  const sourceRecord = resolved as Record<string, unknown>;
  const shaped: Input = Object.create(null);
  selections.forEach(selection => {
    if (!Object.hasOwn(sourceRecord, selection.fieldName)) {
      throw new Error(`Cannot query field "${selection.fieldName}"`);
    }
    const member = sourceRecord[selection.fieldName];
    const answer = typeof member === 'function' ? (member as FieldResolver)(selection.parameters) : member;
    shaped[selection.responseName] = shapeResult(answer, selection.children);
  });
  return shaped;
}

export function graphql(store: Store, body: Input) {
  function runOperation(documentBody: Input) {
    try {
      if (typeof documentBody?.query !== 'string') throw new Error('Expected a query');
      const resolvers = rootResolvers(store);
      const selections = parseDocument(documentBody.query, documentBody.variables ?? {});
      return { data: shapeResult(resolvers, selections) };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Query failed';
      return { errors: [{ message }] };
    }
  }
  if (Array.isArray(body)) return body.map(runOperation);
  return runOperation(body);
}
