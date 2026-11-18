// store.ts — the forge's in-memory state: repositories, git objects, refs, issues, pull requests.
// Determinism: no wall-clock timestamps and no unseeded randomness anywhere the suite can observe.
// Every created thing takes the next tick of a monotonic counter clock (base 2025-01-01T00:00:00Z),
// so two runs that send the same requests in the same order produce the same bytes.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcodec.ts';

/** The token owner's identity: wire.ts's seeded scenario viewer (fixed seed, always this user). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSec: number;
  updatedSec: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string | null;
  createdSec: number;
  updatedSec: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSec: number;
  updatedSec: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  nextIssue: number;
  nextCommentId: number;
  pulls: PullRequest[];
  pullByNumber: Map<number, PullRequest>;
  nextPull: number;
  labels: Map<string, Label>;
}

/** The deterministic clock's base: 2025-01-01T00:00:00Z (wire.ts SCENARIO_EPOCH_SEC). */
export const CLOCK_BASE_SEC = 1735689600;

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly byOwner = new Map<string, Repo[]>();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private clock = CLOCK_BASE_SEC;
  private reqSeq = 0;

  /** The next tick of the deterministic clock, in Unix seconds. */
  tick(): number {
    return this.clock++;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  /** A non-empty request id for X-GitHub-Request-Id (a counter, never a clock). */
  requestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq.toString(36)}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const now = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSec: now,
      updatedSec: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueByNumber: new Map(),
      nextIssue: 1,
      nextCommentId: 1,
      pulls: [],
      pullByNumber: new Map(),
      nextPull: 1,
      labels: new Map(),
    };
    this.repos.set(key, repo);
    const list = this.byOwner.get(owner) ?? [];
    list.push(repo);
    this.byOwner.set(owner, list);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.key(owner, name);
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    const list = this.byOwner.get(owner);
    if (list !== undefined) {
      const index = list.indexOf(repo);
      if (index >= 0) list.splice(index, 1);
    }
    return true;
  }

  listRepos(owner: string): Repo[] {
    return this.byOwner.get(owner) ?? [];
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /**
   * Resolve a ref-ish: a full ref name, a branch name, a tag name, or a 40-hex object id that the
   * repository holds. Returns the object id, or null.
   */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head !== undefined) return head;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    return null;
  }

  /** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The nearest common ancestor of two commits (first-parent BFS from `b` into `a`'s ancestors). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length) {
      const oid = stackA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stackA.push(parent);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length) {
      const oid = queue.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Every object reachable from `tips` (throws on a missing object). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, (oid) => repo.objects.get(oid));
  }

  /** The commit's tree, or null when the object is not a commit. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** A tree flattened to path → {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build the nested trees for a flat path map; returns the root tree's oid. */
  buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object; returns its oid. */
  createCommit(
    repo: Repo,
    fields: { tree: string; parents: readonly string[]; message: string; timestamp: number },
  ): string {
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      message: fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`,
      author: identity,
      committer: identity,
      timestamp: fields.timestamp,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** The object id at `path` inside the tree at `treeOid` (or null), plus its type. */
  treeLookup(
    repo: Repo,
    treeOid: string,
    path: string,
  ): { oid: string; type: 'file' | 'dir' } | null {
    if (path === '' || path === '/') return { oid: treeOid, type: 'dir' };
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) {
        return { oid: entry.oid, type: entry.mode === '40000' ? 'dir' : 'file' };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The entries of the directory at `path` inside `treeOid` (null when it is not a directory). */
  treeDirEntries(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
    let current = treeOid;
    if (path !== '' && path !== '/') {
      const found = this.treeLookup(repo, treeOid, path);
      if (found === null || found.type !== 'dir') return null;
      current = found.oid;
    }
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  // -------------------------------------------------------------------------------------------
  // contents API commits
  // -------------------------------------------------------------------------------------------

  /**
   * Write one file on a branch (creating the branch's first commit when unborn). Returns the new
   * commit sha, the blob sha, and whether the file is new.
   */
  writeFileOnBranch(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const blobSha = this.putObject(repo, 'blob', content);
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const flat = tip === undefined ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, this.commitTree(repo, tip)!);
    const created = !flat.has(path);
    flat.set(path, { oid: blobSha, mode: '100644' });
    const tree = this.buildTreeFromMap(repo, flat);
    const commitSha = this.createCommit(repo, {
      tree,
      parents: tip === undefined ? [] : [tip],
      message,
      timestamp: this.tick(),
    });
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created };
  }

  /** Delete one file on a branch; returns the new commit sha, or null when the file is absent. */
  deleteFileOnBranch(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const flat = this.flattenTree(repo, this.commitTree(repo, tip)!);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const tree = this.buildTreeFromMap(repo, flat);
    const commitSha = this.createCommit(repo, { tree, parents: [tip], message, timestamp: this.tick() });
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = this.tick();
    const issue: Issue = {
      id: this.nextGlobalId++,
      number: repo.nextIssue++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSec: now,
      updatedSec: now,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: repo.nextCommentId++, body };
    issue.comments.push(comment);
    issue.updatedSec = this.tick();
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const now = this.tick();
    const pr: PullRequest = {
      id: this.nextGlobalId++,
      number: repo.nextPull++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      mergeBaseSha: this.mergeBase(repo, headSha, baseSha),
      createdSec: now,
      updatedSec: now,
    };
    repo.pulls.push(pr);
    repo.pullByNumber.set(pr.number, pr);
    return pr;
  }

  /** The file changes between the merge-base tree and the head tree (for files lists and merges). */
  prDiff(
    repo: Repo,
    pr: PullRequest,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const baseTree = pr.mergeBaseSha === null ? null : this.commitTree(repo, pr.mergeBaseSha);
    const headTree = this.commitTree(repo, pr.headSha);
    const baseFlat = baseTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, baseTree);
    const headFlat = headTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, headTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = baseFlat.get(path);
      const newEntry = headFlat.get(path);
      if (oldEntry === undefined && newEntry !== undefined) {
        out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
    return out;
  }

  /** Line counts for a changed file (multiset difference of lines). */
  fileLineDiff(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    const linesOf = (oid: string | null): string[] => {
      if (oid === null) return [];
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'blob') return [];
      const text = object.data.toString('utf8');
      if (text === '') return [];
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const oldLines = linesOf(oldOid);
    const newLines = linesOf(newOid);
    const oldCount = new Map<string, number>();
    for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const left = oldCount.get(line) ?? 0;
      if (left > 0) oldCount.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of oldCount.values()) deletions += left;
    return { additions, deletions };
  }

  /** Whether the pull request conflicts: a path changed on both sides of the merge-base, differently. */
  prConflicted(repo: Repo, pr: PullRequest): boolean {
    if (pr.mergeBaseSha === null) return false;
    const baseTree = this.commitTree(repo, pr.mergeBaseSha);
    const headTree = this.commitTree(repo, pr.headSha);
    const baseTipTree = this.commitTree(repo, pr.baseSha);
    if (baseTree === null || headTree === null || baseTipTree === null) return false;
    const mbFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const baseFlat = this.flattenTree(repo, baseTipTree);
    const paths = new Set([...mbFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
    for (const path of paths) {
      const mb = mbFlat.get(path)?.oid ?? null;
      const head = headFlat.get(path)?.oid ?? null;
      const base = baseFlat.get(path)?.oid ?? null;
      const headChanged = head !== mb;
      const baseChanged = base !== mb;
      if (headChanged && baseChanged && head !== base) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request: the merged tree is the base tree with the head side's changes
   * applied (a three-way merge at file granularity). Updates the base branch, closes the PR.
   * Returns the merge commit sha, or null when conflicted.
   */
  mergePull(repo: Repo, pr: PullRequest): string | null {
    if (pr.merged) return pr.mergeCommitSha;
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    if (baseTip === undefined || headTip === undefined) return null;
    // Refresh the PR's view of the tips (the base may have moved since creation).
    pr.baseSha = baseTip;
    pr.headSha = headTip;
    pr.mergeBaseSha = this.mergeBase(repo, headTip, baseTip);
    if (this.prConflicted(repo, pr)) return null;
    const baseTree = this.commitTree(repo, baseTip)!;
    const merged = this.flattenTree(repo, baseTree);
    if (pr.mergeBaseSha !== null) {
      const mbFlat = this.flattenTree(repo, this.commitTree(repo, pr.mergeBaseSha)!);
      const headFlat = this.flattenTree(repo, this.commitTree(repo, headTip)!);
      for (const [path, entry] of headFlat) {
        if ((mbFlat.get(path)?.oid ?? null) !== entry.oid) merged.set(path, entry);
      }
      for (const path of mbFlat.keys()) {
        if (!headFlat.has(path)) merged.delete(path);
      }
    } else {
      const headFlat = this.flattenTree(repo, this.commitTree(repo, headTip)!);
      for (const [path, entry] of headFlat) merged.set(path, entry);
    }
    const tree = this.buildTreeFromMap(repo, merged);
    const timestamp = this.tick();
    const message = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
    const mergeSha = this.createCommit(repo, { tree, parents: [baseTip], message, timestamp });
    repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.iso(timestamp);
    pr.mergeCommitSha = mergeSha;
    pr.updatedSec = timestamp;
    return mergeSha;
  }

  /** 'MERGEABLE' or 'CONFLICTING' for a pull request's mergeable field. */
  prMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    if (pr.merged) return 'MERGEABLE';
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    if (baseTip === undefined || headTip === undefined) return 'CONFLICTING';
    const probe: PullRequest = { ...pr, baseSha: baseTip, headSha: headTip, mergeBaseSha: this.mergeBase(repo, headTip, baseTip) };
    return this.prConflicted(repo, probe) ? 'CONFLICTING' : 'MERGEABLE';
  }

  // -------------------------------------------------------------------------------------------
  // global (Relay) ids for GraphQL
  // -------------------------------------------------------------------------------------------

  globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', parts: string): string {
    return Buffer.from(`${kind}:${parts}`, 'utf8').toString('base64');
  }

  repoGlobalId(repo: Repo): string {
    return this.globalId('Repository', `${repo.id}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return this.globalId('Issue', `${repo.id}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pr: PullRequest): string {
    return this.globalId('PullRequest', `${repo.id}:${pr.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return this.globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
  }

  /** Look up a repository by its numeric id, or undefined. */
  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** Decode a global id into its kind and parts, or null. */
  decodeGlobalId(id: string): { kind: string; parts: string } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const colon = text.indexOf(':');
      if (colon < 0) return null;
      const kind = text.slice(0, colon);
      const parts = text.slice(colon + 1);
      if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
      if (parts === '') return null;
      return { kind, parts };
    } catch {
      return null;
    }
  }

  /** Look up the object a global id names (Repository, Issue or PullRequest), or null. */
  nodeByGlobalId(id: string): { kind: 'Repository'; repo: Repo } | { kind: 'Issue'; repo: Repo; issue: Issue } | { kind: 'PullRequest'; repo: Repo; pr: PullRequest } | null {
    const decoded = this.decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const slash = decoded.parts.indexOf('/');
      if (slash >= 0) {
        const repo = this.getRepo(decoded.parts.slice(0, slash), decoded.parts.slice(slash + 1));
        return repo === undefined ? null : { kind: 'Repository', repo };
      }
      const id = Number(decoded.parts);
      if (!Number.isInteger(id)) return null;
      const repo = this.repoById(id);
      return repo === undefined ? null : { kind: 'Repository', repo };
    }
    const fields = decoded.parts.split(':');
    const repoId = Number(fields[0]);
    if (!Number.isInteger(repoId)) return null;
    let repo: Repo | undefined;
    for (const candidate of this.repos.values()) {
      if (candidate.id === repoId) {
        repo = candidate;
        break;
      }
    }
    if (repo === undefined) return null;
    if (decoded.kind === 'Issue') {
      const issue = repo.issueByNumber.get(Number(fields[1]));
      return issue === undefined ? null : { kind: 'Issue', repo, issue };
    }
    if (decoded.kind === 'PullRequest') {
      const pr = repo.pullByNumber.get(Number(fields[1]));
      return pr === undefined ? null : { kind: 'PullRequest', repo, pr };
    }
    return null;
  }
}

/** The object id a tag ref peels to (its commit), or the oid itself when it is not a tag object. */
export function peelTag(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return oid;
  const target = parseTag(object.data).object;
  return peelTag(repo, target);
}
