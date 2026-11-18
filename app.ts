// app.ts — the HTTP server for the forge.
//
// Routes:
//   GET  /healthz                         200 {"ok":true} (no auth; the env's boot probe)
//   /api/v3/...                           GitHub REST v3 (rest.ts)
//   POST /api/graphql                     GraphQL v4 (graphql.ts)
//   POST /mcp                             MCP JSON-RPC 2.0 (mcp.ts)
//   /{owner}/{repo}.git/info/refs        git smart-HTTP advertisements (git.ts)
//   /{owner}/{repo}.git/git-upload-pack   protocol v2 ls-refs / fetch, v0 fetch fallback
//   /{owner}/{repo}.git/git-receive-pack  protocol v0 pushes
//
// Auth: every route except /healthz requires `Authorization: Bearer <token>` where the token is
// process.env.MAKEFUN_SHOP_TOKEN. When the variable is unset (local testing), any non-empty bearer
// token is accepted — a missing header is still 401, so the auth checks hold either way.
// Every reply carries a non-empty X-GitHub-Request-Id. A handler that throws never kills the
// server: the request answers 500 JSON and the process keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { badRequest, jsonReply, notFound, unauthorized, type Reply } from './http-util.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Read the whole request body (as Buffers, never strings). */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/** The path segments of a request URL, percent-decoded, or [] when it does not parse. */
function pathSegments(req: IncomingMessage): string[] {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
  } catch {
    return [];
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Send one Reply, with the request-id header and a JSON body unless the reply is binary/empty. */
function send(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(reply.headers ?? {}) };
  if (reply.status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (reply.buffer !== undefined) {
    res.writeHead(reply.status, {
      'content-type': reply.contentType ?? 'application/octet-stream',
      'content-length': reply.buffer.length,
      ...headers,
    });
    res.end(reply.buffer);
    return;
  }
  const text = `${JSON.stringify(reply.json ?? null)}\n`;
  res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${++requestSeq}`;
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const segments = pathSegments(req);

        // The env's boot check calls this twice: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          send(res, jsonReply(200, { ok: true }), requestId);
          return;
        }

        // Auth: a bearer token is required everywhere else.
        const expected = process.env.MAKEFUN_SHOP_TOKEN;
        const authorization = req.headers.authorization ?? '';
        const authenticated =
          expected !== undefined && expected !== '' ? authorization === `Bearer ${expected}` : authorization.startsWith('Bearer ') && authorization.length > 7;
        if (!authenticated) {
          send(res, unauthorized(), requestId);
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          let body: unknown;
          if (method !== 'GET' && method !== 'HEAD') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                send(res, badRequest('Invalid JSON'), requestId);
                return;
              }
            }
          }
          send(
            res,
            handleRest({ store, method, segments: segments.slice(2), query: queryOf(req), body, host: req.headers.host ?? '127.0.0.1' }),
            requestId,
          );
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            send(res, badRequest('Invalid JSON'), requestId);
            return;
          }
          send(res, handleGraphQL(store, body), requestId);
          return;
        }

        // MCP.
        if (method === 'POST' && path === '/mcp') {
          send(res, handleMcp(store, await readBody(req)), requestId);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/<action>.
        if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
          const owner = segments[0]!;
          const repoName = segments[1]!.slice(0, -'.git'.length);
          const action = segments[2];
          if (method === 'GET' && action === 'info' && segments[3] === 'refs') {
            send(res, handleInfoRefs(store, owner, repoName, queryOf(req).get('service') ?? '', req.headers['git-protocol']), requestId);
            return;
          }
          if (method === 'POST' && action === 'git-upload-pack') {
            send(res, handleUploadPack(store, owner, repoName, await readBody(req)), requestId);
            return;
          }
          if (method === 'POST' && action === 'git-receive-pack') {
            send(res, handleReceivePack(store, owner, repoName, await readBody(req)), requestId);
            return;
          }
          send(res, notFound(), requestId);
          return;
        }

        send(res, notFound(), requestId);
      } catch (err) {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          send(res, jsonReply(500, { message: 'Internal Server Error' }), requestId);
        } catch {
          // The socket is gone; nothing more to do.
        }
      }
    })();
  });
}
