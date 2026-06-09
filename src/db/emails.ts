import type { Database } from "./database.js";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Email, EmailFilter, EmailRow, EmailStatus, SendEmailOptions } from "../types/index.js";
import { EmailNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { sqlEmailAddress } from "./email-address-sql.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { canonicalSender } from "../lib/email-address.js";

function parseEmailRow(row: EmailRow): Email {
  return {
    ...row,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    bcc_addresses: parseJsonArray<string>(row.bcc_addresses),
    tags: parseJsonObject<Record<string, string>>(row.tags),
    status: row.status as EmailStatus,
    has_attachments: !!row.has_attachments,
  };
}

const rowToEmail = parseEmailRow;

const EMAIL_LIST_COLS = [
  "id",
  "provider_id",
  "provider_message_id",
  "from_address",
  "to_addresses",
  "cc_addresses",
  "bcc_addresses",
  "reply_to",
  "subject",
  "status",
  "has_attachments",
  "attachment_count",
  "tags",
  "sent_at",
  "created_at",
  "updated_at",
].join(", ");

export function createEmail(
  provider_id: string,
  opts: SendEmailOptions,
  provider_message_id?: string,
  db?: Database,
): Email {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
  const ccArr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : [];
  const bccArr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : [];
  const attachCount = opts.attachments?.length ?? 0;

  // Idempotency: if key provided and already sent, return existing email
  const idempotencyKey = (opts as unknown as Record<string, unknown>).idempotency_key as string | undefined;
  if (idempotencyKey) {
    const existing = d.query("SELECT * FROM emails WHERE idempotency_key = ?").get(idempotencyKey) as EmailRow | null;
    if (existing) return rowToEmail(existing);
  }

  d.run(
    `INSERT INTO emails (id, provider_id, provider_message_id, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, status, has_attachments, attachment_count, tags, idempotency_key, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      provider_id,
      provider_message_id || null,
      opts.from,
      JSON.stringify(toArr),
      JSON.stringify(ccArr),
      JSON.stringify(bccArr),
      opts.reply_to || null,
      opts.subject,
      attachCount > 0 ? 1 : 0,
      attachCount,
      JSON.stringify(opts.tags || {}),
      idempotencyKey || null,
      timestamp,
      timestamp,
      timestamp,
    ],
  );

  return getEmail(id, d)!;
}

export function getEmail(id: string, db?: Database): Email | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM emails WHERE id = ?").get(id) as EmailRow | null;
  if (!row) return null;
  return rowToEmail(row);
}

export function listEmails(filter: EmailFilter = {}, db?: Database): Email[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.provider_id) {
    conditions.push("provider_id = ?");
    params.push(filter.provider_id);
  }

  if (filter.status) {
    if (Array.isArray(filter.status)) {
      conditions.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      params.push(...filter.status);
    } else {
      conditions.push("status = ?");
      params.push(filter.status);
    }
  }

  if (filter.from_address) {
    conditions.push(`${sqlEmailAddress("from_address")} = ?`);
    params.push(canonicalSender(filter.from_address) ?? filter.from_address.trim().toLowerCase());
  }

  if (filter.since) {
    conditions.push("sent_at >= ?");
    params.push(filter.since);
  }

  if (filter.until) {
    conditions.push("sent_at <= ?");
    params.push(filter.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let limitClause = "";
  const limit = safeOptionalLimit(filter.limit);
  if (limit !== null) {
    limitClause = " LIMIT ?";
    params.push(limit);
    limitClause += " OFFSET ?";
    params.push(safeOffset(filter.offset));
  }

  const rows = d
    .query(`SELECT ${EMAIL_LIST_COLS} FROM emails ${where} ORDER BY sent_at DESC${limitClause}`)
    .all(...params) as EmailRow[];

  return rows.map(rowToEmail);
}

export function searchEmails(query: string, opts?: { since?: string; limit?: number; offset?: number }, db?: Database): Email[] {
  const d = db || getDatabase();
  let sql = `SELECT ${EMAIL_LIST_COLS} FROM emails WHERE (subject LIKE ? OR from_address LIKE ? OR to_addresses LIKE ?)`;
  const params: any[] = [`%${query}%`, `%${query}%`, `%${query}%`];
  if (opts?.since) { sql += " AND sent_at >= ?"; params.push(opts.since); }
  sql += " ORDER BY sent_at DESC";
  const limit = safeOptionalLimit(opts?.limit);
  if (limit !== null) { sql += " LIMIT ? OFFSET ?"; params.push(limit, safeOffset(opts?.offset)); }
  return (d.query(sql).all(...params) as any[]).map(parseEmailRow);
}

export function updateEmailStatus(id: string, status: EmailStatus, db?: Database): Email {
  const d = db || getDatabase();
  const email = getEmail(id, d);
  if (!email) throw new EmailNotFoundError(id);

  d.run("UPDATE emails SET status = ?, updated_at = ? WHERE id = ?", [status, now(), id]);
  return getEmail(id, d)!;
}

export function deleteEmail(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM emails WHERE id = ?", [id]);
  return result.changes > 0;
}
