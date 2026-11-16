// Shared plumbing types for the forge's HTTP surfaces.

import type { Store } from './store.ts';

/** One HTTP request, pre-digested for the surface handlers. */
export interface Ctx {
  store: Store;
  method: string;
  /** The URL path, still percent-encoded per segment. */
  path: string;
  /** The path split into percent-decoded segments. */
  segments: string[];
  query: URLSearchParams;
  /** `http://<host>` for building absolute URLs (pagination links). */
  origin: string;
  body: Buffer;
}

/** What a handler returns: a status, an optional JSON value or raw body, extra headers. */
export interface Result {
  status: number;
  json?: unknown;
  raw?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

/** An error that maps straight onto an HTTP status and a `{message}` body. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

/** The request body as a JSON object: empty is `{}`, malformed JSON is a 400. */
export function jsonBody(ctx: Ctx): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

/** The raw request body parsed as any JSON value (the MCP surface speaks JSON-RPC). */
export function jsonValue(ctx: Ctx): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(ctx.body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Pagination parameters, GitHub-style: per_page defaults to 30 and caps at 100. */
export function pageParams(ctx: Ctx): { perPage: number; page: number } {
  const perRaw = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(perRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/** Slice one page out of a list and build the Link header for the next page, if any. */
export function paginate<T>(ctx: Ctx, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    headers.Link = `<${ctx.origin}${ctx.path}?${params.toString()}>; rel="next"`;
  }
  return { page: slice, headers };
}
