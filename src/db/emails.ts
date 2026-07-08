import type { Database } from "./database.js";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Email, EmailFilter, EmailRow, EmailStatus, SendEmailOptions } from "../types/index.js";
import { EmailNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid, resolvePartialId } from "./database.js";
import { sqlEmailAddress } from "./email-address-sql.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { canonicalSender } from "../lib/email-address.js";
import { cloudResource, cloudListQuery, cloudPage, carray, cstrArray, ciso, cnum, cstr, cstrOrNull } from "./cloud-resource.js";

// The outbound sent-ledger (`email list` / `log` / `search`) is backed by the
// shared `/v1/messages` store in cloud mode. A cloud message row maps to the
// local Email shape; only outbound messages are surfaced as sent-log entries.
const MESSAGE_RESOURCE = "messages";

const EMAIL_STATUSES = new Set<EmailStatus>(["sent", "delivered", "bounced", "complained", "failed"]);

function apiMessageToEmail(e: Record<string, unknown>): Email {
  const createdAt = ciso(e["created_at"]);
  const sentAt = ciso(e["received_at"] ?? e["created_at"], createdAt);
  const rawStatus = cstr(e["status"]);
  const status: EmailStatus = EMAIL_STATUSES.has(rawStatus as EmailStatus) ? (rawStatus as EmailStatus) : "sent";
  const attachments = carray(e["attachments"]);
  const attachCount = cnum(e["attachment_count"], attachments.length);
  return {
    id: cstr(e["id"]),
    provider_id: cstrOrNull(e["provider_id"]) ?? "cloud",
    provider_message_id: cstrOrNull(e["provider_message_id"]),
    from_address: cstr(e["from_addr"] ?? e["from_address"]),
    to_addresses: cstrArray(e["to_addrs"] ?? e["to_addresses"]),
    cc_addresses: cstrArray(e["cc_addrs"] ?? e["cc_addresses"]),
    bcc_addresses: cstrArray(e["bcc_addrs"] ?? e["bcc_addresses"]),
    reply_to: cstrOrNull(e["reply_to"]),
    subject: cstr(e["subject"]),
    status,
    has_attachments: attachCount > 0,
    attachment_count: attachCount,
    tags: {},
    sent_at: sentAt,
    created_at: createdAt,
    updated_at: ciso(e["updated_at"], createdAt),
  };
}

/** True when a cloud message row is an outbound (sent-ledger) entry. */
function isOutbound(e: Record<string, unknown>): boolean {
  const dir = cstr(e["direction"]).toLowerCase();
  return dir === "" || dir === "outbound" || dir === "sent";
}

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
  const cloud = cloudResource(MESSAGE_RESOURCE);
  if (cloud) {
    const rec = cloud.get(id);
    return rec ? apiMessageToEmail(rec) : null;
  }

  const d = db || getDatabase();
  const row = d.query("SELECT * FROM emails WHERE id = ?").get(id) as EmailRow | null;
  if (!row) return null;
  return rowToEmail(row);
}

/**
 * Resolve a full or partial email id to a canonical id, routed through the
 * active Store. In cloud mode a full-length id is confirmed via the messages
 * `/v1` endpoint and a prefix is matched against the cloud message list; in
 * local mode it falls back to the SQLite partial-id resolver. This keeps
 * `show`/`replies` consistent with `list`/`search` instead of always reading
 * the (empty, in cloud mode) local `emails` table.
 */
export function resolveEmailId(id: string, db?: Database): string | null {
  const cloud = cloudResource(MESSAGE_RESOURCE);
  if (cloud) {
    const trimmed = id.trim();
    if (!trimmed) return null;
    if (trimmed.length >= 36) return cloud.get(trimmed) ? trimmed : null;
    const matches = cloud
      .list({ limit: 1000, direction: "outbound" })
      .map((row) => cstr(row["id"]))
      .filter((mid) => mid.startsWith(trimmed));
    return matches.length === 1 ? matches[0]! : null;
  }

  return resolvePartialId(db || getDatabase(), "emails", id);
}

export function listEmails(filter: EmailFilter = {}, db?: Database): Email[] {
  const cloud = cloudResource(MESSAGE_RESOURCE);
  if (cloud) {
    const { query, limit, offset } = cloudListQuery(filter);
    // Push the outbound (sent-ledger) selection to the server so the page holds
    // sent mail — not a date-ordered slice dominated by inbound (which buried
    // the sent rows and made `log`/`email list` show nothing on a busy inbox).
    // A pre-counts serve ignores the param; the isOutbound filter still applies.
    query["direction"] = "outbound";
    let rows = cloud.list(query).filter(isOutbound).map(apiMessageToEmail);
    if (filter.provider_id) rows = rows.filter((e) => e.provider_id === filter.provider_id);
    if (filter.status) {
      const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
      rows = rows.filter((e) => wanted.includes(e.status));
    }
    if (filter.from_address) {
      const want = canonicalSender(filter.from_address) ?? filter.from_address.trim().toLowerCase();
      rows = rows.filter((e) => (canonicalSender(e.from_address) ?? e.from_address.toLowerCase()) === want);
    }
    if (filter.since) rows = rows.filter((e) => e.sent_at >= filter.since!);
    if (filter.until) rows = rows.filter((e) => e.sent_at <= filter.until!);
    rows.sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
    return cloudPage(rows, limit, offset);
  }

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
  const cloud = cloudResource(MESSAGE_RESOURCE);
  if (cloud) {
    const { query: q, limit, offset } = cloudListQuery(opts);
    q["direction"] = "outbound";
    const needle = query.toLowerCase();
    let rows = cloud.list(q).filter(isOutbound).map(apiMessageToEmail);
    rows = rows.filter((e) =>
      e.subject.toLowerCase().includes(needle) ||
      e.from_address.toLowerCase().includes(needle) ||
      e.to_addresses.some((t) => t.toLowerCase().includes(needle)),
    );
    if (opts?.since) rows = rows.filter((e) => e.sent_at >= opts.since!);
    rows.sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
    return cloudPage(rows, limit, offset);
  }

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
