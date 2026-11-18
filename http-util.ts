// http-util.ts — the reply shape every handler returns, plus the small JSON helpers.
// Every reply the forge sends is application/json (except git's binary bodies) and carries a
// non-empty X-GitHub-Request-Id, as the protocol group requires.

export interface Reply {
  status: number;
  json?: unknown;
  buffer?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, json: body, contentType: 'application/json; charset=utf-8', headers };
}

export function rawReply(status: number, buffer: Buffer, contentType: string, headers: Record<string, string> = {}): Reply {
  return { status, buffer, contentType, headers };
}

export function notFound(message = 'Not Found'): Reply {
  return jsonReply(404, { message });
}

export function unauthorized(message = 'Requires authentication'): Reply {
  return jsonReply(401, { message });
}

export function badRequest(message = 'Bad request'): Reply {
  return jsonReply(400, { message });
}

export function unprocessable(message: string): Reply {
  return jsonReply(422, { message });
}

export function conflict(message: string): Reply {
  return jsonReply(409, { message });
}
