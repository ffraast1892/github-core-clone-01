// mcp.ts — the Model Context Protocol endpoint at /mcp (JSON-RPC 2.0 over Streamable HTTP).
//
// The suite connects in the legacy era: `server/discover` answers -32601 (so the client falls
// back to `initialize`, which it tries at revisions 2025-11-25, 2025-06-18, 2025-03-26 and
// 2024-11-05), then `notifications/initialized` (a notification: no response), then tools/list
// and tools/call. tools/list is a module-level constant, so two calls serialize byte-identical.
// Tool results carry both a JSON text block and structuredContent; the suite reads the JSON
// (list_issues must embed the issue title and `"number": N` in its text).

import { Store, VIEWER, type Repo } from './store.ts';
import { jsonReply, type Reply } from './http-util.ts';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch (the branch with the changes).' },
        base: { type: 'string', description: 'The base branch (the branch the changes go into).' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.iso(repo.createdSec),
    updated_at: store.iso(repo.updatedSec),
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Resolve owner/repo from the arguments, accepting a full_name as well. */
function repoOf(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = str(args.owner);
  let repo = str(args.repo ?? args.repository);
  const fullName = str(args.full_name);
  if (fullName.includes('/')) {
    const [namedOwner, namedRepo] = fullName.split('/', 2);
    owner = namedOwner ?? owner;
    repo = namedRepo ?? repo;
  }
  if (owner === '' || repo === '') return null;
  return store.getRepo(owner, repo) ?? null;
}

export function handleMcp(store: Store, rawBody: Buffer): Reply {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // A truncated body still names its id in the text; echo it when recoverable.
    const idMatch = /"id"\s*:\s*(\d+|"[^"]*")/.exec(rawBody.toString('utf8'));
    let id: unknown = null;
    if (idMatch !== null) {
      try {
        id = JSON.parse(idMatch[1]!);
      } catch {
        id = null;
      }
    }
    return jsonReply(400, { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const req = body as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = String(req.method ?? '');

  // Notifications carry no id and want no response: 202 with an empty body.
  if (method.startsWith('notifications/')) return { status: 202 };

  const result = (value: unknown): Reply => jsonReply(200, { jsonrpc: '2.0', id, result: value });
  const rpcError = (code: number, message: string): Reply => jsonReply(200, { jsonrpc: '2.0', id, error: { code, message } });
  const toolResult = (payload: unknown): Reply =>
    result({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false });
  const toolError = (message: string): Reply => result({ content: [{ type: 'text', text: message }], isError: true });

  switch (method) {
    case 'server/discover':
      // Not a modern-era server: the client falls back to initialize.
      return rpcError(-32601, 'Method not found: server/discover');
    case 'initialize': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const requested = String(params.protocolVersion ?? '');
      const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return result({
        protocolVersion: supported.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(-32602, `Unknown tool: ${name}`);
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return toolError(`Missing required argument: ${missing.join(', ')}`);
      return callTool(store, tool.name, args, toolResult, toolError);
    }
    default:
      return rpcError(-32601, `Method not found: ${method}`);
  }
}

function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  ok: (payload: unknown) => Reply,
  fail: (message: string) => Reply,
): Reply {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      const repo = store.createRepo(VIEWER.login, repoName, args.private === true, str(args.description));
      if (repo === null) return fail(`A repository named ${repoName} already exists`);
      return ok(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = repoOf(store, args);
      if (repo === null) return fail('Repository not found');
      return ok(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = repoOf(store, args);
      if (repo === null) return fail('Repository not found');
      const issue = store.createIssue(repo, str(args.title), str(args.body), []);
      return ok({
        id: issue.id,
        node_id: store.issueGlobalId(repo, issue),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        created_at: store.iso(issue.createdSec),
        updated_at: store.iso(issue.updatedSec),
      });
    }
    case 'list_issues': {
      const repo = repoOf(store, args);
      if (repo === null) return fail('Repository not found');
      const state = str(args.state) === '' ? 'open' : str(args.state);
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return ok({
        issues: issues.map((issue) => ({
          id: issue.id,
          node_id: store.issueGlobalId(repo, issue),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          created_at: store.iso(issue.createdSec),
          updated_at: store.iso(issue.updatedSec),
        })),
      });
    }
    case 'create_pull_request': {
      const repo = repoOf(store, args);
      if (repo === null) return fail('Repository not found');
      const head = str(args.head);
      const base = str(args.base);
      const pr = store.createPull(repo, str(args.title), str(args.body), head, base);
      if (pr === null) return fail('Head or base branch not found, or a pull request already exists for this head and base');
      return ok({
        id: pr.id,
        node_id: store.pullGlobalId(repo, pr),
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        merged: pr.merged,
        head: { ref: pr.head, sha: pr.headSha },
        base: { ref: pr.base, sha: pr.baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = repoOf(store, args);
      if (repo === null) return fail('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pr = repo.pullByNumber.get(number);
      if (pr === undefined) return fail(`Pull request #${number} not found`);
      if (pr.merged) {
        return ok({ sha: pr.mergeCommitSha, merged: true, number: pr.number, state: pr.state });
      }
      const sha = store.mergePull(repo, pr);
      if (sha === null) return fail('This pull request cannot be merged: it conflicts with the base branch');
      return ok({ sha, merged: true, number: pr.number, state: pr.state });
    }
    default:
      return fail(`Unknown tool: ${name}`);
  }
}
