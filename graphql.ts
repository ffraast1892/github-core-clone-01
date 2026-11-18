// graphql.ts — a targeted GraphQL executor for the documents the suite sends.
//
// The suite sends a fixed set of 17 documents (see checks-graphql.ts): viewer, repository
// fields, __type introspection, SearchType enum values, issue lists (with ordering, state
// filters and cursor pagination), issue by number, create/close issue, pull-request reads,
// create/merge pull request, add comment, node(id:), and two operation documents in one body.
// This is not a general engine: a small tokenizer + recursive-descent parser builds a
// selection tree, which is then resolved against the same in-memory store as REST. Unknown
// fields answer HTTP 200 with an `errors` array naming the field (GitHub behaviour); unknown
// repositories answer data.repository null with no errors.

import { Store, VIEWER, type Issue, type IssueComment, type PullRequest, type Repo } from './store.ts';
import { jsonReply, type Reply } from './http-util.ts';

// ---------------------------------------------------------------------------------------------
// a minimal GraphQL document parser (selections, arguments, fragments, variables)
// ---------------------------------------------------------------------------------------------

export interface GqlSelection {
  name: string;
  alias: string;
  args: Record<string, unknown>;
  children: GqlSelection[];
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${ch}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly fragments = new Map<string, GqlSelection[]>();
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name');
    if (value !== undefined && token.value !== value) throw new Error(`Expected ${value}`);
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        this.fragments.set(name, this.parseSelectionSet());
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        kind = token.value;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value as string;
        const after = this.peek();
        if (after !== undefined && after.kind === 'punct' && after.value === '(') {
          // Variable definitions: skip them (values come from the request body).
          let depth = 0;
          do {
            const t = this.next();
            if (t.kind === 'punct' && t.value === '(') depth += 1;
            if (t.kind === 'punct' && t.value === ')') depth -= 1;
          } while (depth > 0);
        }
      }
      operations.push({ kind, name, selections: this.parseSelectionSet() });
    }
    return operations;
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    for (;;) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '}') break;
      if (token.kind === 'spread') {
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          this.expectName();
          selections.push(...this.parseSelectionSet());
        } else {
          const name = this.expectName();
          const found = this.fragments.get(name);
          if (found !== undefined) selections.push(...found);
        }
        continue;
      }
      if (token.kind !== 'name') throw new Error('Expected a field name');
      let name = token.value;
      let alias = name;
      const maybeColon = this.peek();
      if (maybeColon !== undefined && maybeColon.kind === 'punct' && maybeColon.value === ':') {
        this.next();
        alias = name;
        name = this.expectName();
      }
      let args: Record<string, unknown> = {};
      const maybeParen = this.peek();
      if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
        args = this.parseArguments();
      }
      let children: GqlSelection[] = [];
      const maybeBrace = this.peek();
      if (maybeBrace !== undefined && maybeBrace.kind === 'punct' && maybeBrace.value === '{') {
        children = this.parseSelectionSet();
      }
      selections.push({ name, alias, args, children });
    }
    return selections;
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    for (;;) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === ')') break;
      if (token.kind !== 'name') throw new Error('Expected an argument name');
      this.expectPunct(':');
      args[token.value] = this.parseValue();
    }
    return args;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === 'punct' && token.value === '$') return this.variables[this.expectName()] ?? null;
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      for (;;) {
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        list.push(this.parseValue());
      }
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      for (;;) {
        const next = this.next();
        if (next.kind === 'punct' && next.value === '}') break;
        if (next.kind !== 'name') throw new Error('Expected an object key');
        this.expectPunct(':');
        object[next.value] = this.parseValue();
      }
      return object;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum value
    }
    throw new Error('Unexpected value');
  }
}

// ---------------------------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { __type: 'Query' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: IssueComment }
  | { __type: 'User'; login: string }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; repo: Repo; items: Issue[]; args: Record<string, unknown> }
  | { __type: 'PullRequestConnection'; repo: Repo; items: PullRequest[]; args: Record<string, unknown> }
  | { __type: 'IssueCommentConnection'; repo: Repo; issue: Issue; args: Record<string, unknown> }
  | { __type: 'ChangedFileConnection'; files: Array<{ path: string }> }
  | { __type: 'ChangedFile'; path: string }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pr: PullRequest }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pr: PullRequest }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: '__Type'; name: string }
  | { __type: '__Schema' }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: 'Edge'; node: GqlValue; cursor: string }
  | null;

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
  ],
  User: ['id', 'login', 'name'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

const ALL_TYPES = ['Query', 'Mutation', 'Repository', 'Issue', 'PullRequest', 'User', 'Ref', 'IssueConnection', 'PullRequestConnection', 'IssueCommentConnection', 'IssueComment', 'PageInfo', 'SearchType', '__Type', '__Schema'];

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string | undefined | null): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

function paginateConnection<T>(items: readonly T[], args: Record<string, unknown>): { window: T[]; hasNextPage: boolean; endCursor: string | null } {
  const after = indexOfCursor(args.after as string | undefined);
  const start = after + 1;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const window = items.slice(start, start + first);
  const hasNextPage = start + window.length < items.length;
  const endCursor = window.length === 0 ? null : cursorFor(start + window.length - 1);
  return { window, hasNextPage, endCursor };
}

class Executor {
  readonly errors: Array<{ message: string }> = [];
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  resolveSelections(parent: GqlValue, selections: GqlSelection[]): Record<string, unknown> | null {
    if (parent === null) return null;
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      out[sel.alias] = this.resolveField(parent, sel);
    }
    return out;
  }

  private unknownField(parentType: string, name: string): null {
    this.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
    return null;
  }

  private resolveField(parent: GqlValue, sel: GqlSelection): unknown {
    if (parent === null) return null;
    const type = parent.__type;
    switch (type) {
      case 'Query': {
        if (sel.name === 'viewer') return this.resolveSelections({ __type: 'User', login: VIEWER.login }, sel.children);
        if (sel.name === 'repository') {
          const repo = this.store.getRepo(String(sel.args.owner ?? ''), String(sel.args.name ?? ''));
          return repo === undefined ? null : this.resolveSelections({ __type: 'Repository', repo }, sel.children);
        }
        if (sel.name === 'node') return this.resolveNode(String(sel.args.id ?? ''), sel.children);
        if (sel.name === '__type') {
          const name = String(sel.args.name ?? '');
          return TYPE_FIELDS[name] === undefined && !ALL_TYPES.includes(name)
            ? null
            : this.resolveSelections({ __type: '__Type', name }, sel.children);
        }
        if (sel.name === '__schema') return this.resolveSelections({ __type: '__Schema' }, sel.children);
        if (sel.name === 'createIssue' || sel.name === 'closeIssue' || sel.name === 'createPullRequest' || sel.name === 'mergePullRequest' || sel.name === 'addComment') {
          return this.resolveMutation(sel);
        }
        return this.unknownField('Query', sel.name);
      }
      case 'Repository': {
        const repo = parent.repo;
        switch (sel.name) {
          case 'id': return this.store.repoGlobalId(repo);
          case 'databaseId': return repo.id;
          case 'name': return repo.name;
          case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
          case 'owner': return this.resolveSelections({ __type: 'User', login: repo.owner }, sel.children);
          case 'defaultBranchRef': return this.resolveSelections({ __type: 'Ref', name: repo.defaultBranch }, sel.children);
          case 'viewerPermission': return 'WRITE';
          case 'hasIssuesEnabled': return true;
          case 'issue': {
            const issue = repo.issueByNumber.get(Number(sel.args.number));
            return issue === undefined ? null : this.resolveSelections({ __type: 'Issue', repo, issue }, sel.children);
          }
          case 'issues': {
            let items = [...repo.issues];
            const states = sel.args.states;
            if (Array.isArray(states) && states.length > 0) {
              const wanted = new Set(states.map((state) => String(state).toLowerCase()));
              items = items.filter((issue) => wanted.has(issue.state));
            }
            const orderBy = sel.args.orderBy;
            if (orderBy !== undefined && typeof orderBy === 'object' && orderBy !== null) {
              const field = String((orderBy as Record<string, unknown>).field ?? '');
              const direction = String((orderBy as Record<string, unknown>).direction ?? '');
              if (field === 'CREATED_AT') items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
            }
            const conn: GqlValue = { __type: 'IssueConnection', repo, items, args: sel.args };
            return this.resolveSelections(conn, sel.children);
          }
          case 'pullRequest': {
            const pr = repo.pullByNumber.get(Number(sel.args.number));
            return pr === undefined ? null : this.resolveSelections({ __type: 'PullRequest', repo, pr }, sel.children);
          }
          case 'pullRequests': {
            const items = [...repo.pulls].sort((a, b) => b.number - a.number);
            const conn: GqlValue = { __type: 'PullRequestConnection', repo, items, args: sel.args };
            return this.resolveSelections(conn, sel.children);
          }
          default: return this.unknownField('Repository', sel.name);
        }
      }
      case 'Issue': {
        const { repo, issue } = parent;
        switch (sel.name) {
          case 'id': return this.store.issueGlobalId(repo, issue);
          case 'number': return issue.number;
          case 'title': return issue.title;
          case 'state': return issue.state.toUpperCase();
          case 'body': return issue.body;
          case 'comments': {
            const conn: GqlValue = { __type: 'IssueCommentConnection', repo, issue, args: sel.args };
            return this.resolveSelections(conn, sel.children);
          }
          default: return this.unknownField('Issue', sel.name);
        }
      }
      case 'PullRequest': {
        const { repo, pr } = parent;
        switch (sel.name) {
          case 'id': return this.store.pullGlobalId(repo, pr);
          case 'number': return pr.number;
          case 'title': return pr.title;
          case 'state': return pr.state.toUpperCase();
          case 'merged': return pr.merged;
          case 'headRefName': return pr.head;
          case 'baseRefName': return pr.base;
          case 'mergeable': return this.store.prMergeable(repo, pr);
          case 'files': {
            const diff = this.store.prDiff(repo, pr);
            const first = typeof sel.args.first === 'number' ? sel.args.first : diff.length;
            const files = diff.slice(0, first).map((change) => ({ path: change.path }));
            return this.resolveSelections({ __type: 'ChangedFileConnection', files }, sel.children);
          }
          default: return this.unknownField('PullRequest', sel.name);
        }
      }
      case 'IssueComment': {
        const { repo, issue, comment } = parent;
        switch (sel.name) {
          case 'id': return this.store.commentGlobalId(repo, issue, comment);
          case 'body': return comment.body;
          default: return this.unknownField('IssueComment', sel.name);
        }
      }
      case 'User': {
        if (sel.name === 'login') return parent.login;
        if (sel.name === 'id') return Buffer.from(`User:${parent.login}`, 'utf8').toString('base64');
        if (sel.name === 'name') return parent.login;
        return this.unknownField('User', sel.name);
      }
      case 'Ref': {
        if (sel.name === 'name') return parent.name;
        return this.unknownField('Ref', sel.name);
      }
      case 'IssueConnection': {
        const { window, hasNextPage, endCursor } = paginateConnection(parent.items, parent.args);
        switch (sel.name) {
          case 'nodes': return window.map((issue) => this.resolveSelections({ __type: 'Issue', repo: parent.repo, issue }, sel.children));
          case 'edges': return window.map((issue, i) => this.resolveSelections({ __type: 'Edge', node: { __type: 'Issue', repo: parent.repo, issue }, cursor: cursorFor(i) }, sel.children));
          case 'pageInfo': return this.resolveSelections({ __type: 'PageInfo', hasNextPage, endCursor }, sel.children);
          case 'totalCount': return parent.items.length;
          default: return this.unknownField('IssueConnection', sel.name);
        }
      }
      case 'PullRequestConnection': {
        const { window, hasNextPage, endCursor } = paginateConnection(parent.items, parent.args);
        switch (sel.name) {
          case 'nodes': return window.map((pr) => this.resolveSelections({ __type: 'PullRequest', repo: parent.repo, pr }, sel.children));
          case 'edges': return window.map((pr, i) => this.resolveSelections({ __type: 'Edge', node: { __type: 'PullRequest', repo: parent.repo, pr }, cursor: cursorFor(i) }, sel.children));
          case 'pageInfo': return this.resolveSelections({ __type: 'PageInfo', hasNextPage, endCursor }, sel.children);
          case 'totalCount': return parent.items.length;
          default: return this.unknownField('PullRequestConnection', sel.name);
        }
      }
      case 'IssueCommentConnection': {
        const { window, hasNextPage, endCursor } = paginateConnection(parent.issue.comments, parent.args);
        switch (sel.name) {
          case 'nodes': return window.map((comment) => this.resolveSelections({ __type: 'IssueComment', repo: parent.repo, issue: parent.issue, comment }, sel.children));
          case 'edges': return window.map((comment, i) => this.resolveSelections({ __type: 'Edge', node: { __type: 'IssueComment', repo: parent.repo, issue: parent.issue, comment }, cursor: cursorFor(i) }, sel.children));
          case 'pageInfo': return this.resolveSelections({ __type: 'PageInfo', hasNextPage, endCursor }, sel.children);
          case 'totalCount': return parent.issue.comments.length;
          default: return this.unknownField('IssueCommentConnection', sel.name);
        }
      }
      case 'Edge': {
        if (sel.name === 'node') return this.resolveSelections(parent.node, sel.children);
        if (sel.name === 'cursor') return parent.cursor;
        return this.unknownField('Edge', sel.name);
      }
      case 'ChangedFileConnection': {
        switch (sel.name) {
          case 'nodes': return parent.files.map((file) => this.resolveSelections({ __type: 'ChangedFile', path: file.path }, sel.children));
          case 'edges': return parent.files.map((file, i) => this.resolveSelections({ __type: 'Edge', node: { __type: 'ChangedFile', path: file.path }, cursor: cursorFor(i) }, sel.children));
          case 'pageInfo': return this.resolveSelections({ __type: 'PageInfo', hasNextPage: false, endCursor: null }, sel.children);
          case 'totalCount': return parent.files.length;
          default: return this.unknownField('ChangedFileConnection', sel.name);
        }
      }
      case 'ChangedFile': {
        if (sel.name === 'path') return parent.path;
        return this.unknownField('ChangedFile', sel.name);
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        if (sel.name === 'issue') return this.resolveSelections({ __type: 'Issue', repo: parent.repo, issue: parent.issue }, sel.children);
        if (sel.name === 'clientMutationId') return null;
        return this.unknownField(type, sel.name);
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (sel.name === 'pullRequest') return this.resolveSelections({ __type: 'PullRequest', repo: parent.repo, pr: parent.pr }, sel.children);
        if (sel.name === 'clientMutationId') return null;
        return this.unknownField(type, sel.name);
      }
      case 'PageInfo': {
        if (sel.name === 'hasNextPage') return parent.hasNextPage;
        if (sel.name === 'endCursor') return parent.endCursor;
        if (sel.name === 'hasPreviousPage') return false;
        if (sel.name === 'startCursor') return null;
        return this.unknownField('PageInfo', sel.name);
      }
      case '__Type': {
        switch (sel.name) {
          case 'name': return parent.name;
          case 'kind': return parent.name === 'SearchType' ? 'ENUM' : 'OBJECT';
          case 'fields': {
            const names = TYPE_FIELDS[parent.name] ?? [];
            return names.map((name) => this.resolveSelections({ __type: '__Field', name }, sel.children));
          }
          case 'enumValues': {
            if (parent.name !== 'SearchType') return null;
            return TYPE_FIELDS.SearchType!.map((name) => this.resolveSelections({ __type: '__EnumValue', name }, sel.children));
          }
          default: return this.unknownField('__Type', sel.name);
        }
      }
      case '__Schema': {
        if (sel.name === 'types') return ALL_TYPES.map((name) => this.resolveSelections({ __type: '__Type', name }, sel.children));
        if (sel.name === 'queryType') return this.resolveSelections({ __type: '__Type', name: 'Query' }, sel.children);
        if (sel.name === 'mutationType') return this.resolveSelections({ __type: '__Type', name: 'Mutation' }, sel.children);
        return this.unknownField('__Schema', sel.name);
      }
      case '__Field': {
        if (sel.name === 'name') return parent.name;
        if (sel.name === 'description') return null;
        return this.unknownField('__Field', sel.name);
      }
      case '__EnumValue': {
        if (sel.name === 'name') return parent.name;
        if (sel.name === 'description') return null;
        return this.unknownField('__EnumValue', sel.name);
      }
      default:
        return this.unknownField(type, sel.name);
    }
  }

  private resolveNode(id: string, children: GqlSelection[]): Record<string, unknown> | null {
    const decoded = this.store.decodeGlobalId(id);
    if (decoded === null) return null;
    const fields = decoded.parts.split(':');
    if (decoded.kind === 'Repository') {
      const repo = this.store.repoById(Number(fields[0] ?? ''));
      return repo === undefined ? null : this.resolveSelections({ __type: 'Repository', repo }, children);
    }
    if (decoded.kind === 'Issue') {
      const repo = this.store.repoById(Number(fields[0] ?? ''));
      const issue = repo?.issueByNumber.get(Number(fields[1] ?? ''));
      return repo === undefined || issue === undefined ? null : this.resolveSelections({ __type: 'Issue', repo, issue }, children);
    }
    if (decoded.kind === 'PullRequest') {
      const repo = this.store.repoById(Number(fields[0] ?? ''));
      const pr = repo?.pullByNumber.get(Number(fields[1] ?? ''));
      return repo === undefined || pr === undefined ? null : this.resolveSelections({ __type: 'PullRequest', repo, pr }, children);
    }
    return null;
  }

  private resolveMutation(sel: GqlSelection): Record<string, unknown> | null {
    const input = (sel.args.input ?? {}) as Record<string, unknown>;
    if (sel.name === 'createIssue') {
      const repo = this.repoFromGlobalId(String(input.repositoryId ?? ''));
      if (repo === undefined) {
        this.errors.push({ message: 'Repository not found' });
        return null;
      }
      const issue = this.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return this.resolveSelections({ __type: 'CreateIssuePayload', repo, issue }, sel.children);
    }
    if (sel.name === 'closeIssue') {
      const found = this.issueFromGlobalId(String(input.issueId ?? ''));
      if (found === undefined) {
        this.errors.push({ message: 'Issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.updatedSec = this.store.tick();
      return this.resolveSelections({ __type: 'CloseIssuePayload', repo: found.repo, issue: found.issue }, sel.children);
    }
    if (sel.name === 'createPullRequest') {
      const repo = this.repoFromGlobalId(String(input.repositoryId ?? ''));
      if (repo === undefined) {
        this.errors.push({ message: 'Repository not found' });
        return null;
      }
      const pr = this.store.createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (pr === null) {
        this.errors.push({ message: 'Head or base branch not found' });
        return null;
      }
      return this.resolveSelections({ __type: 'CreatePullRequestPayload', repo, pr }, sel.children);
    }
    if (sel.name === 'mergePullRequest') {
      const found = this.pullFromGlobalId(String(input.pullRequestId ?? ''));
      if (found === undefined) {
        this.errors.push({ message: 'Pull request not found' });
        return null;
      }
      const sha = this.store.mergePull(found.repo, found.pr);
      if (sha === null) {
        this.errors.push({ message: 'This pull request cannot be merged' });
        return null;
      }
      return this.resolveSelections({ __type: 'MergePullRequestPayload', repo: found.repo, pr: found.pr }, sel.children);
    }
    if (sel.name === 'addComment') {
      const found = this.issueFromGlobalId(String(input.subjectId ?? ''));
      if (found === undefined) {
        this.errors.push({ message: 'Issue not found' });
        return null;
      }
      const comment = this.store.createComment(found.repo, found.issue, String(input.body ?? ''));
      const node = { __type: 'IssueComment', repo: found.repo, issue: found.issue, comment } as GqlValue;
      const edge = { __type: 'Edge', node, cursor: cursorFor(found.issue.comments.length - 1) } as GqlValue;
      const out: Record<string, unknown> = {};
      for (const child of sel.children) {
        if (child.name === 'commentEdge') out[child.alias] = this.resolveSelections(edge, child.children);
        else this.unknownField('AddCommentPayload', child.name);
      }
      return out;
    }
    return this.unknownField('Mutation', sel.name);
  }

  private repoFromGlobalId(id: string): Repo | undefined {
    const decoded = this.store.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Repository') return undefined;
    return this.store.repoById(Number(decoded.parts.split(':')[0] ?? ''));
  }

  private issueFromGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
    const decoded = this.store.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return undefined;
    const fields = decoded.parts.split(':');
    const repo = this.store.repoById(Number(fields[0] ?? ''));
    const issue = repo?.issueByNumber.get(Number(fields[1] ?? ''));
    return repo === undefined || issue === undefined ? undefined : { repo, issue };
  }

  private pullFromGlobalId(id: string): { repo: Repo; pr: PullRequest } | undefined {
    const decoded = this.store.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return undefined;
    const fields = decoded.parts.split(':');
    const repo = this.store.repoById(Number(fields[0] ?? ''));
    const pr = repo?.pullByNumber.get(Number(fields[1] ?? ''));
    return repo === undefined || pr === undefined ? undefined : { repo, pr };
  }
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export function handleGraphQL(store: Store, body: unknown): Reply {
  const documents = Array.isArray(body) ? body : [body];
  const results: Array<Record<string, unknown>> = [];
  for (const document of documents) {
    if (typeof document !== 'object' || document === null) {
      results.push({ data: null, errors: [{ message: 'Invalid request body' }] });
      continue;
    }
    const query = String((document as Record<string, unknown>).query ?? '');
    const variables = ((document as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    if (query.trim() === '') {
      results.push({ data: null, errors: [{ message: 'Must provide a query string.' }] });
      continue;
    }
    let operations: GqlOperation[];
    try {
      operations = new Parser(tokenize(query), variables).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: (err as Error).message }] });
      continue;
    }
    const executor = new Executor(store);
    const operation = operations[0];
    if (operation === undefined) {
      results.push({ data: null, errors: [{ message: 'Must provide an operation.' }] });
      continue;
    }
    const data = executor.resolveSelections({ __type: 'Query' }, operation.selections);
    const result: Record<string, unknown> = { data };
    if (executor.errors.length > 0) result.errors = executor.errors;
    results.push(result);
  }
  return jsonReply(200, Array.isArray(body) ? results : results[0]);
}
