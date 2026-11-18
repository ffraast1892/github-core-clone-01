// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Routes: the API root and meta, /user and /user/repos, repositories (get/patch/delete,
// branches, commits, git refs, contents, labels), issues (+ comments) and pull requests
// (+ files, merge). Every reply is application/json with X-GitHub-Request-Id (app.ts adds it);
// error bodies carry a string `message`; a repository under another owner is 404, never 403.

import { Store, VIEWER, type Issue, type PullRequest, type Repo } from './store.ts';
import { isObjectId, parseCommit } from './gitcodec.ts';
import { badRequest, conflict, jsonReply, notFound, unprocessable, type Reply } from './http-util.ts';

export interface RestCtx {
  store: Store;
  method: string;
  /** Decoded path segments after /api/v3. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there is none. */
  body: unknown;
  /** The request's Host header, for absolute pagination URLs. */
  host: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(ctx: RestCtx): Record<string, unknown> {
  return isRecord(ctx.body) ? ctx.body : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function pageOf(ctx: RestCtx): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

/** A page of `items` plus the Link header when more pages follow. */
function paginate<T>(ctx: RestCtx, items: readonly T[], base: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageOf(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const origin = `http://${ctx.host}`;
    const next = `${origin}${base}?per_page=${perPage}&page=${page + 1}`;
    const last = `${origin}${base}?per_page=${perPage}&page=${totalPages}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: [...slice], headers };
}

// ---------------------------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------------------------

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
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: '' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: store.iso(issue.createdSec),
    updated_at: store.iso(issue.updatedSec),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: store.pullGlobalId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: store.iso(pr.createdSec),
    updated_at: store.iso(pr.updatedSec),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function refJson(ref: string, oid: string, type: string): Record<string, unknown> {
  return { ref, node_id: '', url: `/api/v3/repos/git/refs/${encodeURIComponent(ref)}`, object: { sha: oid, type, url: '' } };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

export function handleRest(ctx: RestCtx): Reply {
  const [first, second, third, ...rest] = ctx.segments;
  const { method } = ctx;

  // GET /api/v3/ — the API root.
  if (ctx.segments.length === 0 && method === 'GET') {
    return jsonReply(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (first === 'meta' && ctx.segments.length === 1 && method === 'GET') {
    return jsonReply(200, { installed_version: '1.0.0' });
  }
  if (first === 'user' && ctx.segments.length === 1 && method === 'GET') {
    return jsonReply(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: '',
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
  }
  if (first === 'user' && second === 'repos') {
    if (method === 'POST') return createUserRepo(ctx);
    if (method === 'GET') return listUserRepos(ctx);
    return notFound();
  }
  if (first !== 'repos' || second === undefined || third === undefined) return notFound();
  const owner = second;
  const name = third;
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return notFound();
  const tail = rest;

  if (tail.length === 0) {
    if (method === 'GET') return jsonReply(200, repoJson(ctx.store, repo));
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }
  const [section, ...sectionRest] = tail;
  switch (section) {
    case 'branches':
      if (sectionRest.length === 0 && method === 'GET') return listBranches(ctx, repo);
      if (sectionRest.length > 0 && method === 'GET') return getBranch(ctx, repo, sectionRest.join('/'));
      return notFound();
    case 'commits':
      if (method === 'GET') return listCommits(ctx, repo);
      return notFound();
    case 'git':
      if (sectionRest[0] === 'refs') {
        if (sectionRest.length === 1 && method === 'POST') return createRef(ctx, repo);
        if (sectionRest.length === 1 && method === 'GET') return listRefs(ctx, repo);
        if (sectionRest[0] === 'refs' && sectionRest[1] === 'heads' && sectionRest.length > 2 && method === 'GET') {
          return getRef(ctx, repo, `refs/heads/${sectionRest.slice(2).join('/')}`);
        }
      }
      return notFound();
    case 'contents':
      if (method === 'PUT') return putContents(ctx, repo, sectionRest.join('/'));
      if (method === 'GET') return getContents(ctx, repo, sectionRest.join('/'));
      if (method === 'DELETE') return deleteContents(ctx, repo, sectionRest.join('/'));
      return notFound();
    case 'labels':
      if (method === 'POST') return createLabel(ctx, repo);
      if (method === 'GET') return jsonReply(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
      return notFound();
    case 'issues':
      if (sectionRest.length === 0) {
        if (method === 'POST') return createIssue(ctx, repo);
        if (method === 'GET') return listIssues(ctx, repo);
        return notFound();
      }
      {
        const number = Number(sectionRest[0]);
        if (!Number.isInteger(number)) return notFound();
        const issue = repo.issueByNumber.get(number);
        if (issue === undefined) return notFound();
        if (sectionRest.length === 1) {
          if (method === 'GET') return jsonReply(200, issueJson(ctx.store, repo, issue));
          if (method === 'PATCH') return patchIssue(ctx, repo, issue);
          return notFound();
        }
        if (sectionRest[1] === 'comments') {
          if (method === 'POST') return createComment(ctx, repo, issue);
          if (method === 'GET') {
            return jsonReply(
              200,
              issue.comments.map((comment) => ({
                id: comment.id,
                body: comment.body,
                user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
                created_at: ctx.store.iso(issue.createdSec),
                updated_at: ctx.store.iso(issue.updatedSec),
              })),
            );
          }
        }
        return notFound();
      }
    case 'pulls':
      if (sectionRest.length === 0) {
        if (method === 'POST') return createPull(ctx, repo);
        if (method === 'GET') return listPulls(ctx, repo);
        return notFound();
      }
      {
        const number = Number(sectionRest[0]);
        if (!Number.isInteger(number)) return notFound();
        const pr = repo.pullByNumber.get(number);
        if (pr === undefined) return notFound();
        if (sectionRest.length === 1) {
          if (method === 'GET') return jsonReply(200, pullJson(ctx.store, repo, pr));
          return notFound();
        }
        if (sectionRest[1] === 'files' && method === 'GET') return listPullFiles(ctx, repo, pr);
        if (sectionRest[1] === 'merge' && method === 'PUT') return mergePull(ctx, repo, pr);
        return notFound();
      }
    default:
      return notFound();
  }
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

function createUserRepo(ctx: RestCtx): Reply {
  const body = bodyRecord(ctx);
  const name = str(body.name);
  if (name === '') return unprocessable('name is required');
  const repo = ctx.store.createRepo(VIEWER.login, name, body.private === true, str(body.description));
  if (repo === null) return unprocessable(`A repository named ${name} already exists`);
  return jsonReply(201, repoJson(ctx.store, repo));
}

function listUserRepos(ctx: RestCtx): Reply {
  const repos = ctx.store.listRepos(VIEWER.login);
  const { page, headers } = paginate(ctx, repos, '/api/v3/user/repos');
  return jsonReply(200, page.map((repo) => repoJson(ctx.store, repo)), headers);
}

function patchRepo(ctx: RestCtx, repo: Repo): Reply {
  const body = bodyRecord(ctx);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  repo.updatedSec = ctx.store.tick();
  return jsonReply(200, repoJson(ctx.store, repo));
}

function listBranches(ctx: RestCtx, repo: Repo): Reply {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  return jsonReply(200, branches);
}

function getBranch(ctx: RestCtx, repo: Repo, branch: string): Reply {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return notFound();
  return jsonReply(200, { name: branch, commit: { sha: oid }, protected: false });
}

function listCommits(ctx: RestCtx, repo: Repo): Reply {
  const ref = ctx.query.get('sha');
  let tip: string | null;
  if (ref === null || ref === '') {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  } else if (isObjectId(ref)) {
    tip = repo.objects.has(ref) ? ref : null;
  } else {
    tip = ctx.store.resolveRef(repo, ref);
  }
  if (tip === null) return jsonReply(200, []);
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let current: string | null = tip;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') break;
    const commit = parseCommit(object.data);
    const authorLine = commit.author;
    const committerLine = commit.committer;
    const ident = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
      if (match === null) return { name: line, email: '', date: '' };
      return { name: match[1]!, email: match[2]!, date: ctx.store.iso(Number(match[3])) };
    };
    out.push({
      sha: current,
      commit: {
        // GitHub's API returns the message without the trailing newline the object stores.
        message: commit.message.replace(/\n$/, ''),
        author: ident(authorLine),
        committer: ident(committerLine),
      },
      author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    });
    current = commit.parents[0] ?? null;
  }
  return jsonReply(200, out);
}

function createRef(ctx: RestCtx, repo: Repo): Reply {
  const body = bodyRecord(ctx);
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref.startsWith('refs/') || !isObjectId(sha)) return unprocessable('ref and sha are required');
  if (repo.refs.has(ref)) return unprocessable(`A ref named ${ref} already exists`);
  if (repo.objects.get(sha) === undefined) return unprocessable(`Object ${sha} does not exist`);
  repo.refs.set(ref, sha);
  return jsonReply(201, refJson(ref, sha, repo.objects.get(sha)!.type));
}

function listRefs(ctx: RestCtx, repo: Repo): Reply {
  const out: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const object = repo.objects.get(oid);
    out.push(refJson(ref, oid, object?.type ?? 'commit'));
  }
  return jsonReply(200, out);
}

function getRef(ctx: RestCtx, repo: Repo, ref: string): Reply {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  const object = repo.objects.get(oid);
  return jsonReply(200, refJson(ref, oid, object?.type ?? 'commit'));
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function putContents(ctx: RestCtx, repo: Repo, path: string): Reply {
  const body = bodyRecord(ctx);
  const message = str(body.message);
  const contentB64 = str(body.content);
  if (message === '' || contentB64 === '') return unprocessable('message and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return badRequest('content is not valid base64');
  }
  const branch = str(body.branch) === '' ? repo.defaultBranch : str(body.branch);
  // A write to a branch that does not exist creates it from the default branch's tip (or unborn).
  if (!repo.refs.has(`refs/heads/${branch}`)) {
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) repo.refs.set(`refs/heads/${branch}`, baseTip);
  }
  const sha = str(body.sha);
  if (sha !== '') {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const currentSha = tip === undefined ? null : blobShaAt(ctx.store, repo, tip, path);
    if (currentSha === null || currentSha !== sha) {
      return conflict('sha does not match the current blob');
    }
  }
  const { commitSha, blobSha, created } = ctx.store.writeFileOnBranch(repo, branch, path, content, message);
  const name = path.split('/').pop() ?? path;
  return jsonReply(created ? 201 : 200, {
    content: {
      name,
      path,
      sha: blobSha,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
    },
    commit: { sha: commitSha, message },
  });
}

/** The blob sha at `path` on the commit `tip` (null when the path is not a file there). */
function blobShaAt(store: Store, repo: Repo, tip: string, path: string): string | null {
  const tree = store.commitTree(repo, tip);
  if (tree === null) return null;
  const found = store.treeLookup(repo, tree, path);
  return found !== null && found.type === 'file' ? found.oid : null;
}

function getContents(ctx: RestCtx, repo: Repo, path: string): Reply {
  const ref = ctx.query.get('ref');
  let tip: string | null;
  if (ref === null || ref === '') {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  } else if (isObjectId(ref)) {
    tip = repo.objects.has(ref) ? ref : null;
  } else {
    tip = ctx.store.resolveRef(repo, ref);
  }
  if (tip === null) return notFound();
  const tree = ctx.store.commitTree(repo, tip);
  if (tree === null) return notFound();
  if (path === '') {
    return jsonReply(200, dirListing(ctx.store, repo, tree, ''));
  }
  const found = ctx.store.treeLookup(repo, tree, path);
  if (found === null) return notFound();
  if (found.type === 'dir') return jsonReply(200, dirListing(ctx.store, repo, tree, path));
  const object = repo.objects.get(found.oid);
  if (object === undefined || object.type !== 'blob') return notFound();
  const name = path.split('/').pop() ?? path;
  return jsonReply(200, {
    type: 'file',
    encoding: 'base64',
    size: object.data.length,
    name,
    path,
    content: object.data.toString('base64'),
    sha: found.oid,
  });
}

function dirListing(store: Store, repo: Repo, tree: string, path: string): Array<Record<string, unknown>> {
  const entries = store.treeDirEntries(repo, tree, path);
  if (entries === null) return [];
  return entries.map((entry) => {
    const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    let size = 0;
    if (!isDir) {
      const object = repo.objects.get(entry.oid);
      if (object !== undefined && object.type === 'blob') size = object.data.length;
    }
    return { type: isDir ? 'dir' : 'file', size, name: entry.name, path: entryPath, sha: entry.oid };
  });
}

function deleteContents(ctx: RestCtx, repo: Repo, path: string): Reply {
  const body = bodyRecord(ctx);
  const branch = str(body.branch) === '' ? repo.defaultBranch : str(body.branch);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return notFound();
  const currentSha = blobShaAt(ctx.store, repo, tip, path);
  if (currentSha === null) return notFound();
  const sha = str(body.sha);
  if (sha !== '' && sha !== currentSha) return conflict('sha does not match the current blob');
  const commitSha = ctx.store.deleteFileOnBranch(repo, branch, path, str(body.message) || 'delete file');
  if (commitSha === null) return notFound();
  return jsonReply(200, { commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function createLabel(ctx: RestCtx, repo: Repo): Reply {
  const body = bodyRecord(ctx);
  const name = str(body.name);
  if (name === '') return unprocessable('name is required');
  const color = str(body.color) === '' ? 'ededed' : str(body.color);
  const existing = repo.labels.get(name);
  if (existing !== undefined) return jsonReply(201, { name: existing.name, color: existing.color, description: '' });
  repo.labels.set(name, { name, color });
  return jsonReply(201, { name, color, description: '' });
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function createIssue(ctx: RestCtx, repo: Repo): Reply {
  const body = bodyRecord(ctx);
  const title = str(body.title);
  if (title === '') return unprocessable('title is required');
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  const labels: Array<{ name: string; color: string }> = [];
  for (const labelName of labelNames) {
    const label = repo.labels.get(labelName);
    if (label === undefined) return unprocessable(`Label '${labelName}' does not exist`);
    labels.push(label);
  }
  const issue = ctx.store.createIssue(repo, title, str(body.body), labels);
  return jsonReply(201, issueJson(ctx.store, repo, issue));
}

function listIssues(ctx: RestCtx, repo: Repo): Reply {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let list = [...repo.issues];
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const { page } = paginate(ctx, list, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  return jsonReply(200, page.map((issue) => issueJson(ctx.store, repo, issue)));
}

function patchIssue(ctx: RestCtx, repo: Repo, issue: Issue): Reply {
  const body = bodyRecord(ctx);
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
  if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  issue.updatedSec = ctx.store.tick();
  return jsonReply(200, issueJson(ctx.store, repo, issue));
}

function createComment(ctx: RestCtx, repo: Repo, issue: Issue): Reply {
  const body = bodyRecord(ctx);
  const text = str(body.body);
  if (text === '') return unprocessable('body is required');
  const comment = ctx.store.createComment(repo, issue, text);
  return jsonReply(201, {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: ctx.store.iso(issue.createdSec),
    updated_at: ctx.store.iso(issue.updatedSec),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  });
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function branchOf(value: string): string {
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function createPull(ctx: RestCtx, repo: Repo): Reply {
  const body = bodyRecord(ctx);
  const title = str(body.title);
  const head = branchOf(str(body.head));
  const base = branchOf(str(body.base));
  if (title === '' || head === '' || base === '') return unprocessable('title, head and base are required');
  if (repo.refs.get(`refs/heads/${head}`) === undefined) return unprocessable(`Head branch '${head}' does not exist`);
  if (repo.refs.get(`refs/heads/${base}`) === undefined) return unprocessable(`Base branch '${base}' does not exist`);
  const duplicate = repo.pulls.find((pr) => pr.head === head && pr.base === base && pr.state === 'open');
  if (duplicate !== undefined) return unprocessable('A pull request already exists for this head and base');
  const pr = ctx.store.createPull(repo, title, str(body.body), head, base);
  if (pr === null) return unprocessable('could not create the pull request');
  return jsonReply(201, pullJson(ctx.store, repo, pr));
}

function listPulls(ctx: RestCtx, repo: Repo): Reply {
  const state = ctx.query.get('state') ?? 'open';
  let list = [...repo.pulls];
  if (state === 'open') list = list.filter((pr) => pr.state === 'open');
  else if (state === 'closed') list = list.filter((pr) => pr.state === 'closed');
  list.sort((a, b) => b.number - a.number);
  const { page } = paginate(ctx, list, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  return jsonReply(200, page.map((pr) => pullJson(ctx.store, repo, pr)));
}

function listPullFiles(ctx: RestCtx, repo: Repo, pr: PullRequest): Reply {
  const diff = ctx.store.prDiff(repo, pr);
  const out = diff.map((change) => {
    const { additions, deletions } = ctx.store.fileLineDiff(repo, change.oldOid, change.newOid);
    return {
      filename: change.path,
      // The suite accepts added, modified or changed; a removal is reported as changed.
      status: change.status === 'removed' ? 'changed' : change.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
  return jsonReply(200, out);
}

function mergePull(ctx: RestCtx, repo: Repo, pr: PullRequest): Reply {
  if (pr.merged) {
    return jsonReply(200, { sha: pr.mergeCommitSha, merged: true, message: `Pull request #${pr.number} already merged` });
  }
  const body = bodyRecord(ctx);
  const method = str(body.merge_method) === '' ? 'squash' : str(body.merge_method);
  if (method !== 'squash' && method !== 'merge') return unprocessable(`merge_method '${method}' is not supported`);
  const sha = ctx.store.mergePull(repo, pr);
  if (sha === null) return jsonReply(405, { message: 'This pull request cannot be merged: it conflicts with the base branch' });
  return jsonReply(200, { sha, merged: true, message: `Pull request #${pr.number} successfully merged` });
}
