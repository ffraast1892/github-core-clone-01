// git.ts — the git smart-HTTP surface: info/refs (v0 + v2 advertisements), ls-refs,
// protocol v2 fetch (with shallow/deepen), a v0 fetch fallback, and receive-pack pushes.
//
// The wire is exactly what the suite's git client speaks:
//   - GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//     answers v2 when the request carries `Git-Protocol: version=2`, else v0.
//   - POST /{owner}/{repo}.git/git-upload-pack with `command=ls-refs` / `command=fetch`.
//   - POST /{owner}/{repo}.git/git-receive-pack with a v0 command list + a packfile.
// Packs are delta-free (plain objects); the suite verifies objects by SHA-1, not by deltas.

import {
  PKT_LINE_MAX_PAYLOAD,
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  isObjectId,
  packetLines,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  parseCommit,
  type GitObject,
  type PktPacket,
} from './gitcodec.ts';
import { Store, peelTag, type Repo } from './store.ts';
import { badRequest, jsonReply, notFound, rawReply, type Reply } from './http-util.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';

type Service = typeof UPLOAD_PACK | typeof RECEIVE_PACK;

/** The sideband chunk: one band byte plus pack bytes, inside one pkt-line. */
const SIDEBAND_CHUNK = PKT_LINE_MAX_PAYLOAD - 1;

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(service: Service): Buffer {
  return Buffer.concat([
    encodePktLine(`# service=${service}\n`),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('object-format=sha1\n'),
    pktLineFlush(),
  ]);
}

function v0Advertisement(repo: Repo, service: Service): Buffer {
  const caps =
    service === UPLOAD_PACK
      ? `side-band-64k thin-pack ofs-delta agent=${AGENT} shallow symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`)];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines: string[] = [];
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}\n`);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      lines.push(`${peelTag(repo, oid)} ${name}^{}\n`);
    }
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}\n`);
  // The first ref line carries the capabilities after a NUL.
  const first = lines[0]!;
  parts.push(encodePktLine(`${first.replace(/\n$/, '')}\0${caps}\n`));
  for (const line of lines.slice(1)) parts.push(encodePktLine(line));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): Reply {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service !== UPLOAD_PACK && service !== RECEIVE_PACK) return badRequest('Invalid service');
  const contentType = `application/x-${service}-advertisement`;
  if (service === UPLOAD_PACK && gitProtocol === 'version=2') {
    return rawReply(200, v2Advertisement(service), contentType);
  }
  return rawReply(200, v0Advertisement(repo, service), contentType);
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

export interface FetchComputation {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Add a tree and everything under it to `set`. */
function addTreeObjects(store: Store, repo: Repo, treeOid: string, set: Set<string>): void {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  set.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') addTreeObjects(store, repo, entry.oid, set);
    else if (entry.mode !== '160000') set.add(entry.oid);
  }
}

/**
 * Which objects a fetch sends, and the shallow boundary afterwards.
 *   wants: the tips the client asked for. haves: the tips it already holds.
 *   shallowIn: its current shallow boundary. depth: the deepen limit, or null.
 * A shallow `have` contributes only itself, its tree and its blobs (its parents are not held).
 * A commit is a new shallow boundary when it sits at the depth limit or one of its parents is
 * neither sent nor held; an old boundary whose parents are all now sent or held is unshallowed.
 */
export function computeFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | null,
): FetchComputation {
  const haveClosure = new Set<string>();
  const shallowSet = new Set(shallowIn);
  for (const have of haves) {
    if (!isObjectId(have)) continue;
    if (shallowSet.has(have)) {
      haveClosure.add(have);
      const tree = store.commitTree(repo, have);
      if (tree !== null) addTreeObjects(store, repo, tree, haveClosure);
    } else {
      try {
        for (const oid of store.reachable(repo, [have])) haveClosure.add(oid);
      } catch {
        // A have the server does not hold: nothing to exclude.
      }
    }
  }

  const send = new Set<string>();
  const sendCommits = new Map<string, number>(); // commit oid -> level (1 = a want)
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      send.add(want);
      queue.push({ oid: parseTag(object.data).object, level: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, level: 1 });
    } else {
      send.add(want);
    }
  }
  const seenCommit = new Set<string>();
  while (queue.length) {
    const { oid, level } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    sendCommits.set(oid, level);
    send.add(oid);
    const commit = parseCommit(object.data);
    addTreeObjects(store, repo, commit.tree, send);
    if (depth === null || level < depth) {
      for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
    }
  }
  for (const oid of [...send]) if (haveClosure.has(oid)) send.delete(oid);

  const shallow: string[] = [];
  for (const [oid, level] of sendCommits) {
    if (!send.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    const commit = parseCommit(object.data);
    const atDepth = depth !== null && level === depth;
    const missingParent = commit.parents.some((parent) => !send.has(parent) && !haveClosure.has(parent));
    if (atDepth || missingParent) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowIn) {
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const allParentsAvailable = commit.parents.every((parent) => send.has(parent) || haveClosure.has(parent));
    if (allParentsAvailable) unshallow.push(boundary);
    else if (!shallow.includes(boundary)) shallow.push(boundary);
  }

  const objects = [...send].sort().map((oid) => repo.objects.get(oid)!);
  return { objects, shallow, unshallow };
}

/** Sideband pkt-lines carrying a pack (band 1), each within the pkt-line maximum. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

/** The argument lines of a v2 request (the lines after the delim), as a name → values map. */
function v2Args(packets: readonly PktPacket[]): Map<string, string[]> {
  const args = new Map<string, string[]>();
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text === '') continue;
    const space = text.indexOf(' ');
    const name = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? '' : text.slice(space + 1);
    const list = args.get(name) ?? [];
    list.push(value);
    args.set(name, list);
  }
  return args;
}

function handleLsRefs(store: Store, repo: Repo, packets: readonly PktPacket[]): Reply {
  const args = v2Args(packets);
  const peel = args.has('peel');
  const prefixes = args.get('ref-prefix') ?? [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      parts.push(encodePktLine(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else {
      parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    const object = repo.objects.get(oid);
    if (peel && object !== undefined && object.type === 'tag') {
      line += ` peeled:${peelTag(repo, oid)}`;
    }
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktLineFlush());
  return rawReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV2(store: Store, repo: Repo, packets: readonly PktPacket[]): Reply {
  const args = v2Args(packets);
  const wants = args.get('want') ?? [];
  const haves = args.get('have') ?? [];
  const shallowIn = args.get('shallow') ?? [];
  const deepenRaw = args.get('deepen')?.[0];
  const depth = deepenRaw === undefined ? null : Number.parseInt(deepenRaw, 10);
  const result = computeFetch(store, repo, wants, haves, shallowIn, Number.isFinite(depth) ? depth : null);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(pktLineDelim());
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  if (result.objects.length > 0) {
    parts.push(encodePktLine('packfile\n'));
    parts.push(...sidebandPack(writePack(result.objects)));
  }
  parts.push(pktLineFlush());
  return rawReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(store: Store, repo: Repo, packets: readonly PktPacket[]): Reply {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]!.trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
  }
  const result = computeFetch(store, repo, wants, haves, shallowIn, Number.isFinite(depth) ? depth : null);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (result.objects.length > 0) parts.push(...sidebandPack(writePack(result.objects)));
  parts.push(pktLineFlush());
  return rawReply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): Reply {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let parsed;
  try {
    parsed = decodePktLines(body, { allowTrailing: true });
  } catch {
    return badRequest('Bad request');
  }
  const lines = packetLines(parsed.packets);
  const first = lines[0] ?? '';
  if (first.startsWith('command=ls-refs')) return handleLsRefs(store, repo, parsed.packets);
  if (first.startsWith('command=fetch')) return handleFetchV2(store, repo, parsed.packets);
  if (first.startsWith('want ')) return handleFetchV0(store, repo, parsed.packets);
  return badRequest('Bad request');
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyPushCommand(store: Store, repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'old value does not match' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const newObject = repo.objects.get(newOid);
  if (newObject === undefined) return { ok: false, reason: 'object not found' };
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (ref.startsWith('refs/heads/') && newObject.type !== 'commit') return { ok: false, reason: 'not a commit' };
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  if (current === undefined) return { ok: false, reason: 'ref does not exist' };
  if (oldOid !== current) return { ok: false, reason: 'old value does not match' };
  if (newObject.type !== 'commit') return { ok: false, reason: 'not a commit' };
  if (newOid !== oldOid && !store.isAncestor(repo, oldOid, newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): Reply {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let parsed;
  try {
    parsed = decodePktLines(body, { allowTrailing: true });
  } catch {
    return badRequest('Bad request');
  }
  if (!parsed.packets.some((packet) => packet.kind === 'flush')) return badRequest('Bad request');
  const commands: PushCommand[] = [];
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    text = text.replace(/\n$/, '');
    if (text === '') continue;
    const parts = text.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      return badRequest('Bad request');
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) return badRequest('Bad request');
  const packBytes = body.subarray(parsed.consumed);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message;
    }
  }
  const reportLines: string[] = [];
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}`);
  } else {
    reportLines.push('unpack ok');
    for (const command of commands) {
      const result = applyPushCommand(store, repo, command);
      reportLines.push(result.ok ? `ok ${command.ref}` : `ng ${command.ref} ${result.reason}`);
    }
  }
  // The report-status stream is itself pkt-lined inside sideband band 1.
  const parts: Buffer[] = [];
  for (const line of reportLines) {
    const inner = encodePktLine(`${line}\n`);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), inner])));
  }
  parts.push(pktLineFlush());
  return rawReply(200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}
