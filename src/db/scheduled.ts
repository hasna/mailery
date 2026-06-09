import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

export type ScheduledStatus = "pending" | "sent" | "cancelled" | "failed";

export interface ScheduledEmail {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments_json: unknown[];
  template_name: string | null;
  template_vars: Record<string, string> | null;
  scheduled_at: string;
  status: ScheduledStatus;
  error: string | null;
  created_at: string;
}

export type ScheduledEmailSummary = Omit<ScheduledEmail, "html" | "text_body" | "attachments_json" | "template_vars">;

interface ScheduledEmailRow {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments_json: string;
  template_name: string | null;
  template_vars: string | null;
  scheduled_at: string;
  status: string;
  error: string | null;
  created_at: string;
}

type ScheduledEmailSummaryRow = Omit<ScheduledEmailRow, "html" | "text_body" | "attachments_json" | "template_vars">;

const SCHEDULED_EMAIL_COLUMNS = [
  "id",
  "provider_id",
  "from_address",
  "to_addresses",
  "cc_addresses",
  "bcc_addresses",
  "reply_to",
  "subject",
  "html",
  "text_body",
  "attachments_json",
  "template_name",
  "template_vars",
  "scheduled_at",
  "status",
  "error",
  "created_at",
].join(", ");

const SCHEDULED_EMAIL_SUMMARY_COLUMNS = [
  "id",
  "provider_id",
  "from_address",
  "to_addresses",
  "cc_addresses",
  "bcc_addresses",
  "reply_to",
  "subject",
  "template_name",
  "scheduled_at",
  "status",
  "error",
  "created_at",
].join(", ");

function rowToScheduledEmail(row: ScheduledEmailRow): ScheduledEmail {
  return {
    ...row,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    bcc_addresses: parseJsonArray<string>(row.bcc_addresses),
    attachments_json: parseJsonArray(row.attachments_json),
    template_vars: row.template_vars ? parseJsonObject<Record<string, string>>(row.template_vars) : null,
    status: row.status as ScheduledStatus,
  };
}

function rowToScheduledEmailSummary(row: ScheduledEmailSummaryRow): ScheduledEmailSummary {
  return {
    ...row,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    bcc_addresses: parseJsonArray<string>(row.bcc_addresses),
    status: row.status as ScheduledStatus,
  };
}

export function createScheduledEmail(
  input: {
    provider_id: string;
    from_address: string;
    to_addresses: string[];
    cc_addresses?: string[];
    bcc_addresses?: string[];
    reply_to?: string;
    subject: string;
    html?: string;
    text_body?: string;
    attachments_json?: unknown[];
    template_name?: string;
    template_vars?: Record<string, string>;
    scheduled_at: string;
  },
  db?: Database,
): ScheduledEmail {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO scheduled_emails (id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, html, text_body, attachments_json, template_name, template_vars, scheduled_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id,
      input.provider_id,
      input.from_address,
      JSON.stringify(input.to_addresses),
      JSON.stringify(input.cc_addresses || []),
      JSON.stringify(input.bcc_addresses || []),
      input.reply_to || null,
      input.subject,
      input.html || null,
      input.text_body || null,
      JSON.stringify(input.attachments_json || []),
      input.template_name || null,
      input.template_vars ? JSON.stringify(input.template_vars) : null,
      input.scheduled_at,
      timestamp,
    ],
  );

  return getScheduledEmail(id, d)!;
}

export function getScheduledEmail(id: string, db?: Database): ScheduledEmail | null {
  const d = db || getDatabase();
  const row = d.query(`SELECT ${SCHEDULED_EMAIL_COLUMNS} FROM scheduled_emails WHERE id = ?`).get(id) as ScheduledEmailRow | null;
  if (!row) return null;
  return rowToScheduledEmail(row);
}

export interface ListScheduledEmailOptions {
  status?: ScheduledStatus;
  limit?: number;
  offset?: number;
}

export interface ListDueEmailOptions {
  limit?: number;
}

function isDatabase(value: unknown): value is Database {
  return Boolean(value && typeof (value as { query?: unknown }).query === "function");
}

export function listScheduledEmails(opts?: ListScheduledEmailOptions, db?: Database): ScheduledEmail[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  if (limit !== null) params.push(limit, offset);
  const rows = d
    .query(`SELECT ${SCHEDULED_EMAIL_COLUMNS} FROM scheduled_emails${where} ORDER BY scheduled_at ASC${limit !== null ? " LIMIT ? OFFSET ?" : ""}`)
    .all(...params) as ScheduledEmailRow[];
  return rows.map(rowToScheduledEmail);
}

export function listScheduledEmailSummaries(opts?: ListScheduledEmailOptions, db?: Database): ScheduledEmailSummary[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  if (limit !== null) params.push(limit, offset);
  const rows = d
    .query(`SELECT ${SCHEDULED_EMAIL_SUMMARY_COLUMNS} FROM scheduled_emails${where} ORDER BY scheduled_at ASC${limit !== null ? " LIMIT ? OFFSET ?" : ""}`)
    .all(...params) as ScheduledEmailSummaryRow[];
  return rows.map(rowToScheduledEmailSummary);
}

export function cancelScheduledEmail(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run(
    "UPDATE scheduled_emails SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    [id],
  );
  return result.changes > 0;
}

export function getDueEmails(db?: Database): ScheduledEmail[];
export function getDueEmails(opts?: ListDueEmailOptions, db?: Database): ScheduledEmail[];
export function getDueEmails(optsOrDb?: ListDueEmailOptions | Database, maybeDb?: Database): ScheduledEmail[] {
  const d = isDatabase(optsOrDb) ? optsOrDb : maybeDb || getDatabase();
  const opts = isDatabase(optsOrDb) ? undefined : optsOrDb;
  const currentTime = now();
  const limit = safeOptionalLimit(opts?.limit);
  const params: Array<string | number> = [currentTime];
  if (limit !== null) params.push(limit);
  const rows = d
    .query(`SELECT ${SCHEDULED_EMAIL_COLUMNS} FROM scheduled_emails
      WHERE status = 'pending' AND scheduled_at <= ?
      ORDER BY scheduled_at ASC, id ASC${limit !== null ? " LIMIT ?" : ""}`)
    .all(...params) as ScheduledEmailRow[];
  return rows.map(rowToScheduledEmail);
}

export function markSent(id: string, db?: Database): void {
  const d = db || getDatabase();
  d.run("UPDATE scheduled_emails SET status = 'sent' WHERE id = ?", [id]);
}

export function markFailed(id: string, error: string, db?: Database): void {
  const d = db || getDatabase();
  d.run("UPDATE scheduled_emails SET status = 'failed', error = ? WHERE id = ?", [error, id]);
}
