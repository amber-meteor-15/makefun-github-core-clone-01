// The HTTP wiring: one node:http server that routes each request to the git transport, the REST
// API, GraphQL or MCP, enforces the bearer token everywhere except the health check, and stamps
// every response with a request id. State lives in a single in-memory Store.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { advertiseV0, advertiseV2, lsRefsV2, fetchV2, fetchV0, receivePack, parsePkts } from './git.ts';
import { HttpError } from './types.ts';
import type { Ctx, Result } from './types.ts';

export interface AppOptions {
  /** The bearer token to require; defaults to the MAKEFUN_SHOP_TOKEN environment variable. */
  token?: string;
}

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Route the git smart-HTTP endpoints: /{owner}/{repo}.git/... */
function handleGit(ctx: Ctx, owner: string, repoName: string, sub: string | undefined, gitProtocol: string): Result {
  const repo = ctx.store.repoFor(owner, repoName);
  if (sub === 'info/refs') {
    if (ctx.method !== 'GET') throw new HttpError(404, 'Not Found');
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(404, 'Not Found');
    if (repo === null) throw new HttpError(404, 'Not Found');
    if (service === 'git-upload-pack' && gitProtocol.includes('version=2')) {
      return { status: 200, raw: advertiseV2(), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    return {
      status: 200,
      raw: advertiseV0(ctx.store, repo, service),
      contentType: `application/x-${service}-advertisement`,
    };
  }
  if (repo === null) throw new HttpError(404, 'Not Found');
  if (sub === 'git-upload-pack' && ctx.method === 'POST') {
    if (gitProtocol.includes('version=2')) {
      const { packets } = parsePkts(ctx.body);
      let command = '';
      const args: string[] = [];
      let afterDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (packet.kind === 'flush') break;
        if (packet.kind !== 'data') continue;
        const line = packet.data.toString('utf8').replace(/\n$/, '');
        if (!afterDelim) {
          if (line.startsWith('command=')) command = line.slice('command='.length);
          continue;
        }
        args.push(line);
      }
      if (command === 'ls-refs') return { status: 200, raw: lsRefsV2(ctx.store, repo, args), contentType: 'application/x-git-upload-pack-result' };
      if (command === 'fetch') return { status: 200, raw: fetchV2(ctx.store, args), contentType: 'application/x-git-upload-pack-result' };
      throw new HttpError(400, `unsupported protocol v2 command '${command}'`);
    }
    const outcome = fetchV0(ctx.store, ctx.body);
    return { status: 200, raw: outcome.body, contentType: 'application/x-git-upload-pack-result' };
  }
  if (sub === 'git-receive-pack' && ctx.method === 'POST') {
    const outcome = receivePack(ctx.store, repo, ctx.body);
    return { status: 200, raw: outcome.report, contentType: 'application/x-git-receive-pack-result' };
  }
  throw new HttpError(404, 'Not Found');
}

function route(ctx: Ctx, gitProtocol: string): Result {
  const path = ctx.path === '/' ? '/' : ctx.path.replace(/\/+$/, '');
  if (path === '/mcp') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
    return handleMcp(ctx);
  }
  if (path === '/api/graphql') {
    if (ctx.method !== 'POST') throw new HttpError(404, 'Not Found');
    return handleGraphql(ctx);
  }
  if (ctx.segments[0] === 'api' && ctx.segments[1] === 'v3') {
    const result = handleRest(ctx);
    if (result !== null) return result;
    throw new HttpError(404, 'Not Found');
  }
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(ctx.path);
  if (gitMatch !== null) {
    return handleGit(ctx, decodeSegment(gitMatch[1] as string), decodeSegment(gitMatch[2] as string), gitMatch[3], gitProtocol);
  }
  throw new HttpError(404, 'Not Found');
}

function writeResult(res: ServerResponse, result: Result, requestId: string): void {
  const headers: Record<string, string> = { 'X-GitHub-Request-Id': requestId, ...(result.headers ?? {}) };
  let body: Buffer = Buffer.alloc(0);
  if (result.json !== undefined) {
    body = Buffer.from(JSON.stringify(result.json), 'utf8');
    headers['Content-Type'] = 'application/json; charset=utf-8';
  } else if (result.raw !== undefined) {
    body = result.raw;
    headers['Content-Type'] = result.contentType ?? 'application/octet-stream';
  }
  if (result.status !== 204 && result.status !== 202) headers['Content-Length'] = String(body.length);
  res.writeHead(result.status, headers);
  res.end(result.status === 204 || result.status === 202 ? undefined : body);
}

/** Create the forge's HTTP server (not yet listening). */
export function createApp(options: AppOptions = {}): Server {
  const store = new Store();
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requestCounter += 1;
    const requestId = `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      if (url.pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
        writeResult(res, { status: 200, json: { ok: true } }, requestId);
        return;
      }
      if (token !== '') {
        const authorization = req.headers.authorization ?? '';
        if (authorization !== `Bearer ${token}`) {
          writeResult(res, { status: 401, json: { message: 'Unauthorized' } }, requestId);
          return;
        }
      }
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const host = req.headers.host ?? 'localhost';
      const ctx: Ctx = {
        store,
        method,
        path: url.pathname,
        segments: url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment),
        query: url.searchParams,
        origin: `http://${host}`,
        body,
      };
      const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : '';
      writeResult(res, route(ctx, gitProtocol), requestId);
    } catch (error) {
      if (error instanceof HttpError) {
        writeResult(res, { status: error.status, json: { message: error.message } }, requestId);
      } else {
        console.error('forge: unhandled error', error);
        writeResult(res, { status: 500, json: { message: 'Internal Server Error' } }, requestId);
      }
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('forge: response failed', error);
      try {
        res.destroy();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
}
