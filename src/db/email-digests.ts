import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { cappedLimit, safeOffset } from "./pagination.js";

export type EmailDigestPeriod = "today" | "yesterday" | "last7" | "month";
export type EmailDigestStatus = "ok" | "error";
export type EmailDigestProvider = "local" | "external";

export interface EmailDigest {
  id: string;
  period: EmailDigestPeriod;
  since: string;
  until: string;
  provider: EmailDigestProvider;
  model: string;
  status: EmailDigestStatus;
  message_count: number;
  summary: string | null;
  highlights: string[];
  action_items: string[];
  important_email_ids: string[];
  label_counts: Record<string, number>;
  error: string | null;
  started_at: string;
  completed_at: string;
  created_at: string;
}

export interface SaveEmailDigestInput {
  period: EmailDigestPeriod;
  since: string;
  until: string;
  provider: EmailDigestProvider;
  model: string;
  status: EmailDigestStatus;
  message_count: number;
  summary?: string | null;
  highlights?: string[];
  action_items?: string[];
  important_email_ids?: string[];
  label_counts?: Record<string, number>;
  error?: string | null;
  started_at?: string;
  completed_at?: string;
}

export interface ListEmailDigestsOptions {
  period?: EmailDigestPeriod;
  status?: EmailDigestStatus;
  limit?: number;
  offset?: number;
}

const MAX_DIGEST_LIST_LIMIT = 200;
const PERIODS = new Set<EmailDigestPeriod>(["today", "yesterday", "last7", "month"]);
const STATUSES = new Set<EmailDigestStatus>(["ok", "error"]);

export function normalizeEmailDigestPeriod(value: string | undefined): EmailDigestPeriod {
  const normalized = (value ?? "today").trim().toLowerCase().replace(/[_\s-]+/g, "");
  const aliases: Record<string, EmailDigestPeriod> = {
    today: "today",
    yesterday: "yesterday",
    last7: "last7",
    lastseven: "last7",
    last7days: "last7",
    week: "last7",
    month: "month",
    thismonth: "month",
  };
  const period = aliases[normalized];
  if (!period || !PERIODS.has(period)) {
    throw new Error("Digest period must be today, yesterday, last7, or month.");
  }
  return period;
}

export function emailDigestPeriodLabel(period: EmailDigestPeriod): string {
  return {
    today: "Today",
    yesterday: "Yesterday",
    last7: "Last 7 Days",
    month: "This Month",
  }[period];
}

function normalizeStringArray(values: string[] | undefined, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values ?? []) {
    const value = String(item ?? "").replace(/\s+/g, " ").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value.slice(0, 500));
    if (out.length >= max) break;
  }
  return out;
}

function normalizeLabelCounts(value: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const label = key.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
    const count = Number(raw);
    if (!label || !Number.isFinite(count) || count <= 0) continue;
    out[label] = Math.trunc(count);
  }
  return out;
}

function rowToDigest(row: Record<string, unknown>): EmailDigest {
  const period = row.period as EmailDigestPeriod;
  if (!PERIODS.has(period)) throw new Error(`Invalid digest period in database: ${String(row.period)}`);
  const status = row.status as EmailDigestStatus;
  if (!STATUSES.has(status)) throw new Error(`Invalid digest status in database: ${String(row.status)}`);
  return {
    id: row.id as string,
    period,
    since: row.since as string,
    until: row.until as string,
    provider: row.provider as EmailDigestProvider,
    model: row.model as string,
    status,
    message_count: Number(row.message_count ?? 0),
    summary: (row.summary as string) || null,
    highlights: parseJsonArray<string>(row.highlights_json as string | null | undefined),
    action_items: parseJsonArray<string>(row.action_items_json as string | null | undefined),
    important_email_ids: parseJsonArray<string>(row.important_email_ids_json as string | null | undefined),
    label_counts: parseJsonObject<Record<string, number>>(row.label_counts_json as string | null | undefined),
    error: (row.error as string) || null,
    started_at: row.started_at as string,
    completed_at: row.completed_at as string,
    created_at: row.created_at as string,
  };
}

export function saveEmailDigest(input: SaveEmailDigestInput, db?: Database): EmailDigest {
  const d = db || getDatabase();
  const id = uuid();
  const startedAt = input.started_at ?? now();
  const completedAt = input.completed_at ?? now();
  d.run(
    `INSERT INTO email_digests
       (id, period, since, until, provider, model, status, message_count, summary,
        highlights_json, action_items_json, important_email_ids_json, label_counts_json,
        error, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.period,
      input.since,
      input.until,
      input.provider,
      input.model,
      input.status,
      Math.max(0, Math.trunc(input.message_count)),
      input.summary ?? null,
      JSON.stringify(normalizeStringArray(input.highlights, 12)),
      JSON.stringify(normalizeStringArray(input.action_items, 12)),
      JSON.stringify(normalizeStringArray(input.important_email_ids, 30)),
      JSON.stringify(normalizeLabelCounts(input.label_counts)),
      input.error ?? null,
      startedAt,
      completedAt,
      completedAt,
    ],
  );
  return getEmailDigest(id, d)!;
}

export function getEmailDigest(id: string, db?: Database): EmailDigest | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM email_digests WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | null;
  return row ? rowToDigest(row) : null;
}

export function getLatestEmailDigest(period: EmailDigestPeriod, db?: Database): EmailDigest | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM email_digests WHERE period = ? AND status = 'ok' ORDER BY completed_at DESC LIMIT 1")
    .get(period) as Record<string, unknown> | null;
  return row ? rowToDigest(row) : null;
}

export function listEmailDigests(opts: ListEmailDigestsOptions = {}, db?: Database): EmailDigest[] {
  const d = db || getDatabase();
  const where: string[] = [];
  const params: string[] = [];
  if (opts.period) {
    where.push("period = ?");
    params.push(opts.period);
  }
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = d
    .query(`SELECT * FROM email_digests ${sqlWhere} ORDER BY completed_at DESC LIMIT ? OFFSET ?`)
    .all(...params, cappedLimit(opts.limit, 20, MAX_DIGEST_LIST_LIMIT), safeOffset(opts.offset)) as Record<string, unknown>[];
  return rows.map(rowToDigest);
}
