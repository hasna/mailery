/**
 * Shared utilities for API route modules.
 */
import { getDatabase, resolvePartialId } from "../../db/database.js";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export function notFound(msg = "Not found"): Response {
  return json({ error: msg }, 404);
}

export function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

export function internalError(e: unknown): Response {
  if (e instanceof RouteInputError) return json({ error: e.message }, e.status);
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}

export class RouteInputError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RouteInputError";
    this.status = status;
  }
}

export function resolveId(table: string, partialId: string): string | null {
  const db = getDatabase();
  return resolvePartialId(db, table, partialId);
}

export function resolveIdStrict(table: string, partialId: string): string {
  const db = getDatabase();
  const value = partialId.trim();
  if (!value) throw new RouteInputError(`Missing ID for table '${table}'.`);

  const id = resolvePartialId(db, table, value);
  if (id) return id;

  const rows = db
    .query(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT ?`)
    .all(`${value}%`, 2) as { id: string }[];

  if (rows.length > 1) {
    throw new RouteInputError(`Ambiguous ID '${value}' in table '${table}'. Use a longer prefix or full ID.`);
  }

  throw new RouteInputError(`Could not resolve ID '${value}' in table '${table}'.`);
}

export function resolveOptionalId(table: string, partialId: string | null | undefined): string | undefined {
  if (partialId === undefined || partialId === null || partialId === "") return undefined;
  return resolveIdStrict(table, partialId);
}

export async function parseBody(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return {}; }
}

export interface IntegerParseOptions {
  min?: number;
  max?: number;
}

export function parseInteger(value: unknown, fallback: number, opts: IntegerParseOptions = {}): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  let n = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  if (opts.min !== undefined) n = Math.max(opts.min, n);
  if (opts.max !== undefined) n = Math.min(opts.max, n);
  return n;
}

function parseOptionalInteger(value: unknown, opts: IntegerParseOptions = {}): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return undefined;
  let n = Math.trunc(parsed);
  if (opts.min !== undefined) n = Math.max(opts.min, n);
  if (opts.max !== undefined) n = Math.min(opts.max, n);
  return n;
}

export function queryInteger(url: URL, key: string, fallback: number, opts: IntegerParseOptions = {}): number {
  return parseInteger(url.searchParams.get(key), fallback, opts);
}

export function optionalQueryInteger(url: URL, key: string, opts: IntegerParseOptions = {}): number | undefined {
  if (!url.searchParams.has(key)) return undefined;
  return parseOptionalInteger(url.searchParams.get(key), opts);
}

export function queryPage(url: URL, defaultLimit = 100, maxLimit = 1000): { limit: number; offset: number } {
  return {
    limit: queryInteger(url, "limit", defaultLimit, { min: 1, max: maxLimit }),
    offset: queryInteger(url, "offset", 0, { min: 0 }),
  };
}

const CREDENTIAL_FIELDS = ["api_key", "secret_key", "access_key", "oauth_client_secret", "oauth_refresh_token", "oauth_access_token"] as const;

export function sanitizeProvider(provider: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...provider };
  for (const field of CREDENTIAL_FIELDS) {
    if (sanitized[field]) sanitized[field] = "***";
  }
  return sanitized;
}

const rateLimitWindows = new Map<string, number[]>();
export function checkRateLimit(ip: string, key: string, maxPerMinute: number): boolean {
  const mapKey = `${ip}:${key}`;
  const now = Date.now();
  const hits = (rateLimitWindows.get(mapKey) ?? []).filter(t => now - t < 60_000);
  if (hits.length >= maxPerMinute) return false;
  hits.push(now);
  rateLimitWindows.set(mapKey, hits);
  return true;
}

export function tooManyRequests(): Response {
  return json({ error: "Too many requests. Please slow down." }, 429);
}
