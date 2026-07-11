import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { cappedLimit, safeLimit, safeOffset, safeOptionalLimit } from "./pagination.js";

export interface AttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
}

export interface AttachmentPath {
  filename: string;
  content_type: string;
  size: number;
  /** Local file path, e.g. ~/.hasna/emails/attachments/<email_id>/filename */
  local_path?: string;
  /** S3 URL if uploaded, e.g. s3://bucket/emails/<email_id>/filename */
  s3_url?: string;
}

export interface InboundEmail {
  id: string;
  provider_id: string | null;
  message_id: string | null;
  in_reply_to_email_id: string | null;  // linked sent email if this is a reply
  provider_thread_id: string | null;
  thread_id: string | null;
  provider_history_id: string | null;
  provider_internal_date: string | null;
  label_ids: string[];
  raw_s3_url: string | null;
  metadata_s3_url: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  text_body: string | null;
  html_body: string | null;
  attachments: AttachmentMeta[];
  attachment_paths: AttachmentPath[];
  headers: Record<string, string>;
  raw_size: number;
  is_read: boolean;
  read_at: string | null;
  is_archived: boolean;
  is_starred: boolean;
  is_sent: boolean;
  received_at: string;
  created_at: string;
}

export type InboundEmailSummary = Omit<InboundEmail, "text_body" | "html_body" | "headers">;

interface InboundEmailRow {
  id: string;
  provider_id: string | null;
  message_id: string | null;
  in_reply_to_email_id?: string | null;
  provider_thread_id?: string | null;
  thread_id?: string | null;
  provider_history_id?: string | null;
  provider_internal_date?: string | null;
  label_ids_json?: string;
  raw_s3_url?: string | null;
  metadata_s3_url?: string | null;
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  attachments_json: string;
  attachment_paths: string;
  headers_json: string;
  raw_size: number;
  is_read?: number;
  read_at?: string | null;
  is_archived?: number;
  is_starred?: number;
  is_sent?: number;
  received_at: string;
  created_at: string;
}

type InboundEmailSummaryRow = Omit<InboundEmailRow, "text_body" | "html_body" | "headers_json">;

const INBOUND_SUMMARY_COLS = `
  id,
  provider_id,
  message_id,
  in_reply_to_email_id,
  provider_thread_id,
  thread_id,
  provider_history_id,
  provider_internal_date,
  label_ids_json,
  raw_s3_url,
  metadata_s3_url,
  from_address,
  to_addresses,
  cc_addresses,
  subject,
  attachments_json,
  attachment_paths,
  raw_size,
  is_read,
  read_at,
  is_archived,
  is_starred,
  is_sent,
  received_at,
  created_at
`;

export function normalizeEmailAddress(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const bracketed = raw.match(/<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>/);
  const email = bracketed?.[1] ?? raw;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

export function inboundRecipientMatches(
  recipient: string,
  addresses: Iterable<string>,
  domains: Iterable<string>,
): boolean {
  const email = normalizeEmailAddress(recipient);
  if (!email) return false;
  const addressSet = new Set([...addresses].map((address) => normalizeEmailAddress(address)).filter((address): address is string => !!address));
  if (addressSet.has(email)) return true;
  const domain = email.split("@").pop();
  if (!domain) return false;
  const domainSet = new Set([...domains].map((item) => item.trim().toLowerCase()).filter(Boolean));
  return domainSet.has(domain);
}

function rowToEmail(row: InboundEmailRow): InboundEmail {
  return {
    id: row.id,
    provider_id: row.provider_id,
    message_id: row.message_id,
    in_reply_to_email_id: row.in_reply_to_email_id ?? null,
    provider_thread_id: row.provider_thread_id ?? null,
    thread_id: row.thread_id ?? null,
    provider_history_id: row.provider_history_id ?? null,
    provider_internal_date: row.provider_internal_date ?? null,
    label_ids: parseJsonArray<string>(row.label_ids_json),
    raw_s3_url: row.raw_s3_url ?? null,
    metadata_s3_url: row.metadata_s3_url ?? null,
    from_address: row.from_address,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    subject: row.subject,
    text_body: row.text_body,
    html_body: row.html_body,
    attachments: parseJsonArray<AttachmentMeta>(row.attachments_json),
    attachment_paths: parseJsonArray<AttachmentPath>(row.attachment_paths),
    headers: parseJsonObject(row.headers_json),
    raw_size: row.raw_size,
    is_read: !!row.is_read,
    read_at: row.read_at ?? null,
    is_archived: !!row.is_archived,
    is_starred: !!row.is_starred,
    is_sent: !!row.is_sent,
    received_at: row.received_at,
    created_at: row.created_at,
  };
}

function rowToEmailSummary(row: InboundEmailSummaryRow): InboundEmailSummary {
  return {
    id: row.id,
    provider_id: row.provider_id,
    message_id: row.message_id,
    in_reply_to_email_id: row.in_reply_to_email_id ?? null,
    provider_thread_id: row.provider_thread_id ?? null,
    thread_id: row.thread_id ?? null,
    provider_history_id: row.provider_history_id ?? null,
    provider_internal_date: row.provider_internal_date ?? null,
    label_ids: parseJsonArray<string>(row.label_ids_json),
    raw_s3_url: row.raw_s3_url ?? null,
    metadata_s3_url: row.metadata_s3_url ?? null,
    from_address: row.from_address,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    subject: row.subject,
    attachments: parseJsonArray<AttachmentMeta>(row.attachments_json),
    attachment_paths: parseJsonArray<AttachmentPath>(row.attachment_paths),
    raw_size: row.raw_size,
    is_read: !!row.is_read,
    read_at: row.read_at ?? null,
    is_archived: !!row.is_archived,
    is_starred: !!row.is_starred,
    is_sent: !!row.is_sent,
    received_at: row.received_at,
    created_at: row.created_at,
  };
}

function detectReplyToEmailId(headers: Record<string, string>, d: Database): string | null {
  // Check In-Reply-To and References headers for a known provider_message_id
  const candidates: string[] = [];
  const inReplyTo = headers["In-Reply-To"] || headers["in-reply-to"];
  const references = headers["References"] || headers["references"];
  if (inReplyTo) candidates.push(...inReplyTo.split(/\s+/).map(s => s.replace(/[<>]/g, "").trim()));
  if (references) candidates.push(...references.split(/\s+/).map(s => s.replace(/[<>]/g, "").trim()));

  for (const msgId of candidates) {
    if (!msgId) continue;
    const row = d.query("SELECT id FROM emails WHERE provider_message_id = ? LIMIT 1").get(msgId) as { id: string } | null;
    if (row) return row.id;
  }
  return null;
}

export function storeInboundEmail(
  input: Omit<
    InboundEmail,
    "id" | "created_at" | "provider_thread_id" | "provider_history_id" |
    "provider_internal_date" | "label_ids" | "raw_s3_url" | "metadata_s3_url" | "thread_id" |
    "is_read" | "read_at" | "is_archived" | "is_starred" | "is_sent"
  > & Partial<Pick<
    InboundEmail,
    "provider_thread_id" | "provider_history_id" | "provider_internal_date" |
    "label_ids" | "raw_s3_url" | "metadata_s3_url" | "thread_id"
  >>,
  db?: Database,
): InboundEmail {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  const receivedAt = input.received_at || timestamp;
  const attachmentPaths = (input as InboundEmail).attachment_paths ?? [];

  // Auto-detect reply linkage from email headers
  const replyToEmailId = input.in_reply_to_email_id ?? detectReplyToEmailId(input.headers, d);

  // Imported sent mail can carry the SENT label — flag it so it
  // lands in the Sent folder, not the inbox.
  const isSent = (input.label_ids ?? []).some((label) => label.trim().toLowerCase() === "sent") ? 1 : 0;

  d.run(
    `INSERT INTO inbound_emails
       (id, provider_id, message_id, in_reply_to_email_id, provider_thread_id, provider_history_id,
        provider_internal_date, label_ids_json, raw_s3_url, metadata_s3_url, from_address, to_addresses, cc_addresses,
        subject, text_body, html_body, attachments_json, attachment_paths, headers_json, raw_size, received_at, is_sent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.provider_id,
      input.message_id,
      replyToEmailId,
      input.provider_thread_id ?? null,
      input.provider_history_id ?? null,
      input.provider_internal_date ?? null,
      JSON.stringify(input.label_ids ?? []),
      input.raw_s3_url ?? null,
      input.metadata_s3_url ?? null,
      input.from_address,
      JSON.stringify(input.to_addresses),
      JSON.stringify(input.cc_addresses),
      input.subject,
      input.text_body,
      input.html_body,
      JSON.stringify(input.attachments),
      JSON.stringify(attachmentPaths),
      JSON.stringify(input.headers),
      input.raw_size,
      receivedAt,
      isSent,
      timestamp,
    ],
  );

  const stored: InboundEmail = {
    id,
    provider_id: input.provider_id,
    message_id: input.message_id,
    in_reply_to_email_id: replyToEmailId,
    provider_thread_id: input.provider_thread_id ?? null,
    thread_id: null,
    provider_history_id: input.provider_history_id ?? null,
    provider_internal_date: input.provider_internal_date ?? null,
    label_ids: input.label_ids ?? [],
    raw_s3_url: input.raw_s3_url ?? null,
    metadata_s3_url: input.metadata_s3_url ?? null,
    from_address: input.from_address,
    to_addresses: input.to_addresses,
    cc_addresses: input.cc_addresses,
    subject: input.subject,
    text_body: input.text_body,
    html_body: input.html_body,
    attachments: input.attachments,
    attachment_paths: attachmentPaths,
    headers: input.headers,
    raw_size: input.raw_size,
    is_read: false,
    read_at: null,
    is_archived: false,
    is_starred: false,
    is_sent: !!isSent,
    received_at: receivedAt,
    created_at: timestamp,
  };

  // Auto-unenroll from active sequences if this is a reply (respects sequence-auto-unenroll config)
  if (replyToEmailId && input.from_address) {
    try {
      // Check if this sender is enrolled in any active sequences
      const enrollments = d
        .query("SELECT id, sequence_id FROM sequence_enrollments WHERE contact_email = ? AND status = 'active'")
        .all(input.from_address) as { id: string; sequence_id: string }[];
      for (const e of enrollments) {
        d.run(
          "UPDATE sequence_enrollments SET status = 'cancelled', completed_at = ? WHERE id = ?",
          [now(), e.id],
        );
        process.stderr.write(`[sequences] Auto-unenrolled ${input.from_address} from sequence ${e.sequence_id} (replied to email)\n`);
      }
    } catch {
      // Non-fatal — sequence tables may not exist on all installs
    }
  }

  return stored;
}

export function updateAttachmentPaths(id: string, paths: AttachmentPath[], db?: Database): void {
  const d = db || getDatabase();
  d.run("UPDATE inbound_emails SET attachment_paths = ? WHERE id = ?", [JSON.stringify(paths), id]);
}

export interface ListRepliesOptions {
  limit?: number;
  offset?: number;
}

export interface ReplyPromptPart {
  from_address: string;
  subject: string;
  text_body: string | null;
}

export function listReplies(emailId: string, db?: Database, opts?: ListRepliesOptions): InboundEmail[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const params: Array<string | number> = [emailId];
  if (limit !== null) params.push(limit, offset);
  const rows = d
    .query(`SELECT * FROM inbound_emails WHERE in_reply_to_email_id = ? ORDER BY received_at ASC${limit !== null ? " LIMIT ? OFFSET ?" : ""}`)
    .all(...params) as InboundEmailRow[];
  return rows.map(rowToEmail);
}

export function listReplySummaries(emailId: string, db?: Database, opts?: ListRepliesOptions): InboundEmailSummary[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const params: Array<string | number> = [emailId];
  if (limit !== null) params.push(limit, offset);
  const rows = d
    .query(`SELECT ${INBOUND_SUMMARY_COLS} FROM inbound_emails WHERE in_reply_to_email_id = ? ORDER BY received_at ASC${limit !== null ? " LIMIT ? OFFSET ?" : ""}`)
    .all(...params) as InboundEmailSummaryRow[];
  return rows.map(rowToEmailSummary);
}

export function listReplyPromptParts(emailId: string, db?: Database, opts?: ListRepliesOptions): ReplyPromptPart[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const params: Array<string | number> = [emailId];
  if (limit !== null) params.push(limit, offset);
  return d
    .query(`SELECT from_address, subject, text_body FROM inbound_emails WHERE in_reply_to_email_id = ? ORDER BY received_at ASC${limit !== null ? " LIMIT ? OFFSET ?" : ""}`)
    .all(...params) as ReplyPromptPart[];
}

export function getReplyCount(emailId: string, db?: Database): number {
  const d = db || getDatabase();
  const result = d.query("SELECT COUNT(*) as count FROM inbound_emails WHERE in_reply_to_email_id = ?").get(emailId) as { count: number } | null;
  return result?.count ?? 0;
}

export function getInboundEmail(id: string, db?: Database): InboundEmail | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM inbound_emails WHERE id = ?").get(id) as InboundEmailRow | null;
  if (!row) return null;
  return rowToEmail(row);
}

export function getInboundEmailSummary(id: string, db?: Database): InboundEmailSummary | null {
  const d = db || getDatabase();
  const row = d
    .query(`SELECT ${INBOUND_SUMMARY_COLS} FROM inbound_emails WHERE id = ?`)
    .get(id) as InboundEmailSummaryRow | null;
  if (!row) return null;
  return rowToEmailSummary(row);
}

export function getInboundAttachmentPaths(id: string, db?: Database): AttachmentPath[] | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT attachment_paths FROM inbound_emails WHERE id = ? LIMIT 1")
    .get(id) as { attachment_paths: string | null } | null;
  return row ? parseJsonArray<AttachmentPath>(row.attachment_paths) : null;
}

export function listInboundSubjectsForRecipient(
  recipient: string,
  opts?: { since?: string; limit?: number },
  db?: Database,
): Array<{ subject: string }> {
  const normalized = normalizeEmailAddress(recipient);
  if (!normalized) return [];

  const d = db || getDatabase();
  const limit = cappedLimit(opts?.limit, 100, 10000);
  const conditions = [
    "recipient.address = ?",
    "inbound_emails.is_sent = 0",
    "inbound_emails.is_archived = 0",
  ];
  const params: Array<string | number> = [normalized];

  if (opts?.since) {
    conditions.push("inbound_emails.received_at >= ?");
    params.push(opts.since);
  }
  params.push(limit);

  return d.query(
    `SELECT inbound_emails.subject
       FROM inbound_recipients recipient
       JOIN inbound_emails ON inbound_emails.id = recipient.inbound_email_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY inbound_emails.received_at DESC
      LIMIT ?`,
  ).all(...params) as Array<{ subject: string }>;
}

export interface ListInboundOpts {
  provider_id?: string;
  since?: string;
  limit?: number;
  offset?: number;
  /** Filter by read state. */
  unread?: boolean;
  read?: boolean;
  /** When false (default), archived mail is excluded; when true, only archived. */
  archived?: boolean;
  /** When true, only imported sent rows are returned. Defaults to received mail only. */
  sent?: boolean;
  /** When true, do not filter by sent/received state. */
  includeSent?: boolean;
  starred?: boolean;
  /** Only mail carrying this label. */
  label?: string;
  /** Only mail whose From contains this text (case-insensitive). */
  from?: string;
  /** Only mail whose subject contains this text (case-insensitive). */
  subject?: string;
  /** Local text search across subject, sender, recipient, and text body. */
  search?: string;
  /** Only mail addressed (To) to one of these addresses (case-insensitive). */
  recipients?: string[];
  /** ...or addressed to any address on one of these domains (catch-all routing). */
  recipientDomains?: string[];
}

function applyInboundFilters(opts: ListInboundOpts | undefined, conditions: string[], params: (string | number)[]): void {
  if (opts?.provider_id) {
    conditions.push("provider_id = ?");
    params.push(opts.provider_id);
  }
  if (opts?.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }
  if (opts?.unread) conditions.push("is_read = 0");
  if (opts?.read) conditions.push("is_read = 1");
  if (opts?.starred) conditions.push("is_starred = 1");
  if (!opts?.includeSent) conditions.push(opts?.sent ? "is_sent = 1" : "is_sent = 0");
  // Archived mail is hidden unless explicitly requested.
  conditions.push(opts?.archived ? "is_archived = 1" : "is_archived = 0");
  if (opts?.label) {
    conditions.push(`EXISTS (
      SELECT 1
        FROM inbound_labels label
       WHERE label.inbound_email_id = inbound_emails.id
         AND label.label = ?
    )`);
    params.push(normalizeInboundLabel(opts.label));
  }
  const from = opts?.from?.trim().toLowerCase();
  if (from) {
    conditions.push("LOWER(COALESCE(inbound_emails.from_address, '')) LIKE ?");
    params.push(`%${from}%`);
  }
  const subject = opts?.subject?.trim().toLowerCase();
  if (subject) {
    conditions.push("LOWER(COALESCE(inbound_emails.subject, '')) LIKE ?");
    params.push(`%${subject}%`);
  }
  const search = opts?.search?.trim().toLowerCase();
  if (search) {
    const like = `%${search}%`;
    conditions.push(`(
      LOWER(COALESCE(inbound_emails.subject, '')) LIKE ?
      OR LOWER(COALESCE(inbound_emails.from_address, '')) LIKE ?
      OR LOWER(COALESCE(inbound_emails.to_addresses, '')) LIKE ?
      OR LOWER(COALESCE(inbound_emails.text_body, '')) LIKE ?
    )`);
    params.push(like, like, like, like);
  }
}

function normalizeInboundLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
}

function applyExplicitRecipientFilters(opts: ListInboundOpts | undefined, conditions: string[], params: (string | number)[]): void {
  const requestedRecipients = (opts?.recipients ?? []).length > 0;
  const requestedRecipientDomains = (opts?.recipientDomains ?? []).length > 0;
  const recip = (opts?.recipients ?? []).map((r) => normalizeEmailAddress(r)).filter((r): r is string => !!r);
  const recipDomains = (opts?.recipientDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if ((requestedRecipients || requestedRecipientDomains) && recip.length === 0 && recipDomains.length === 0) {
    conditions.push("0 = 1");
  } else if (recip.length > 0 || recipDomains.length > 0) {
    const ors: string[] = [];
    if (recip.length > 0) {
      ors.push(`recipient.address IN (${recip.map(() => "?").join(", ")})`);
      params.push(...recip);
    }
    if (recipDomains.length > 0) {
      ors.push(`recipient.domain IN (${recipDomains.map(() => "?").join(", ")})`);
      params.push(...recipDomains);
    }
    conditions.push(`inbound_emails.id IN (
      SELECT recipient.inbound_email_id
        FROM inbound_recipients recipient
       WHERE ${ors.join(" OR ")}
    )`);
  }
}

function ownerRecipientScopeSql(): string {
  return `EXISTS (
    SELECT 1
    FROM inbound_recipients recipient
    WHERE recipient.inbound_email_id = inbound_emails.id
      AND (
        EXISTS (
          SELECT 1
          FROM addresses scoped
          WHERE (scoped.owner_id = ? OR scoped.administrator_id = ?)
            AND recipient.address = LOWER(scoped.email)
        )
        OR EXISTS (
          SELECT 1
          FROM aliases al
          JOIN addresses target ON LOWER(al.target_address) = LOWER(target.email)
          WHERE (target.owner_id = ? OR target.administrator_id = ?)
            AND al.local_part != '*'
            AND recipient.address = LOWER(al.local_part || '@' || al.domain)
        )
        OR EXISTS (
          SELECT 1
          FROM aliases al
          JOIN addresses target ON LOWER(al.target_address) = LOWER(target.email)
          WHERE (target.owner_id = ? OR target.administrator_id = ?)
            AND al.local_part = '*'
            AND al.domain != '*'
            AND recipient.domain = LOWER(al.domain)
        )
      )
  )`;
}

function appendOwnerRecipientScope(ownerId: string, conditions: string[], params: (string | number)[]): void {
  conditions.push(`(${ownerRecipientScopeSql()})`);
  params.push(ownerId, ownerId, ownerId, ownerId, ownerId, ownerId);
}

export function listInboundEmails(
  opts?: ListInboundOpts,
  db?: Database,
): InboundEmail[] {
  const d = db || getDatabase();
  const limit = safeLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  applyInboundFilters(opts, conditions, params);
  applyExplicitRecipientFilters(opts, conditions, params);

  const where = conditions.length > 0 ?
    `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  params.push(offset);

  const rows = d
    .query(`SELECT * FROM inbound_emails ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as InboundEmailRow[];
  return rows.map(rowToEmail);
}

export function listInboundEmailSummaries(
  opts?: ListInboundOpts,
  db?: Database,
): InboundEmailSummary[] {
  const d = db || getDatabase();
  const limit = safeLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  applyInboundFilters(opts, conditions, params);
  applyExplicitRecipientFilters(opts, conditions, params);

  const where = conditions.length > 0 ?
    `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  params.push(offset);

  const rows = d
    .query(`SELECT ${INBOUND_SUMMARY_COLS} FROM inbound_emails ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as InboundEmailSummaryRow[];
  return rows.map(rowToEmailSummary);
}

export function listInboundEmailsForOwner(ownerId: string, opts?: Omit<ListInboundOpts, "recipients" | "recipientDomains">, db?: Database): InboundEmail[] {
  const d = db || getDatabase();
  const limit = safeLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  applyInboundFilters(opts, conditions, params);
  appendOwnerRecipientScope(ownerId, conditions, params);
  params.push(limit, offset);

  const rows = d
    .query(`SELECT * FROM inbound_emails WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as InboundEmailRow[];
  return rows.map(rowToEmail);
}

export function listInboundEmailSummariesForOwner(ownerId: string, opts?: Omit<ListInboundOpts, "recipients" | "recipientDomains">, db?: Database): InboundEmailSummary[] {
  const d = db || getDatabase();
  const limit = safeLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  applyInboundFilters(opts, conditions, params);
  appendOwnerRecipientScope(ownerId, conditions, params);
  params.push(limit, offset);

  const rows = d
    .query(`SELECT ${INBOUND_SUMMARY_COLS} FROM inbound_emails WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as InboundEmailSummaryRow[];
  return rows.map(rowToEmailSummary);
}

export function inboundEmailBelongsToOwner(id: string, ownerId: string, db?: Database): boolean {
  const d = db || getDatabase();
  const params: (string | number)[] = [id];
  const conditions = ["inbound_emails.id = ?"];
  appendOwnerRecipientScope(ownerId, conditions, params);
  const row = d.query(`SELECT 1 AS ok FROM inbound_emails WHERE ${conditions.join(" AND ")} LIMIT 1`).get(...params) as { ok: number } | null;
  return !!row;
}

export function deleteInboundEmail(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM inbound_emails WHERE id = ?", [id]);
  return result.changes > 0;
}

export function clearInboundEmails(provider_id?: string, db?: Database): number {
  const d = db || getDatabase();
  const count = getInboundCount(provider_id, d);
  if (provider_id) {
    d.run("DELETE FROM inbound_emails WHERE provider_id = ?", [provider_id]);
  } else {
    d.run("DELETE FROM inbound_emails");
  }
  return count;
}

export function getInboundCount(provider_id?: string, db?: Database): number {
  const d = db || getDatabase();
  let row: { count: number } | null;
  if (provider_id) {
    row = d
      .query("SELECT COUNT(*) as count FROM inbound_emails WHERE provider_id = ?")
      .get(provider_id) as { count: number } | null;
  } else {
    row = d.query("SELECT COUNT(*) as count FROM inbound_emails").get() as { count: number } | null;
  }
  return row?.count ?? 0;
}

export function getReceivedInboundCount(provider_id?: string, db?: Database): number {
  const d = db || getDatabase();
  let row: { count: number } | null;
  if (provider_id) {
    row = d
      .query("SELECT COUNT(*) as count FROM inbound_emails WHERE is_sent = 0 AND provider_id = ?")
      .get(provider_id) as { count: number } | null;
  } else {
    row = d.query("SELECT COUNT(*) as count FROM inbound_emails WHERE is_sent = 0").get() as { count: number } | null;
  }
  return row?.count ?? 0;
}

export function getLatestInboundReceivedAt(db?: Database): string | null {
  const d = db || getDatabase();
  const row = d.query("SELECT MAX(received_at) as latest FROM inbound_emails").get() as { latest: string | null } | null;
  return row?.latest ?? null;
}

export function getLatestReceivedInboundAt(db?: Database): string | null {
  const d = db || getDatabase();
  const row = d.query("SELECT MAX(received_at) as latest FROM inbound_emails WHERE is_sent = 0").get() as { latest: string | null } | null;
  return row?.latest ?? null;
}

// ── Local read-state / archive / star / labels (provider-independent) ──────────

function requireInboundExists(id: string, d: Database): void {
  const row = d.query("SELECT 1 AS ok FROM inbound_emails WHERE id = ? LIMIT 1").get(id) as { ok: number } | null;
  if (!row) throw new Error(`Inbound email not found: ${id}`);
}

function requireInboundLabels(id: string, d: Database): { label_ids_json?: string } {
  const row = d.query("SELECT label_ids_json FROM inbound_emails WHERE id = ? LIMIT 1").get(id) as { label_ids_json?: string } | null;
  if (!row) throw new Error(`Inbound email not found: ${id}`);
  return row;
}

function inboundStateMessagePredicate(): string {
  return "mail_message_id = COALESCE((SELECT mail_message_id FROM inbound_emails WHERE id = ?), 'msg:inbound:' || ?)";
}

function syncMailboxReadState(id: string, read: boolean, readAt: string | null, d: Database): void {
  d.run(
    `UPDATE mailbox_message_state
        SET is_read = ?,
            read_at = ?,
            updated_at = ?
      WHERE ${inboundStateMessagePredicate()}`,
    [read ? 1 : 0, readAt, now(), id, id],
  );
}

function syncMailboxArchivedState(id: string, archived: boolean, d: Database): void {
  d.run(
    `UPDATE mailbox_message_state
        SET is_archived = ?,
            folder_id = CASE
              WHEN direction IN ('sent', 'outbound') THEN 'folder:' || mailbox_id || ':sent'
              WHEN is_trash = 1 THEN 'folder:' || mailbox_id || ':trash'
              WHEN is_spam = 1 THEN 'folder:' || mailbox_id || ':spam'
              WHEN ? = 1 THEN 'folder:' || mailbox_id || ':archive'
              ELSE 'folder:' || mailbox_id || ':inbox'
            END,
            updated_at = ?
      WHERE ${inboundStateMessagePredicate()}`,
    [archived ? 1 : 0, archived ? 1 : 0, now(), id, id],
  );
}

function syncMailboxStarredState(id: string, starred: boolean, d: Database): void {
  d.run(
    `UPDATE mailbox_message_state
        SET is_starred = ?,
            updated_at = ?
      WHERE ${inboundStateMessagePredicate()}`,
    [starred ? 1 : 0, now(), id, id],
  );
}

function syncMailboxLabelState(id: string, labels: string[], d: Database): void {
  const isSpam = labels.some((label) => normalizeInboundLabel(label) === "spam");
  const isTrash = labels.some((label) => normalizeInboundLabel(label) === "trash");
  d.run(
    `UPDATE mailbox_message_state
        SET labels_json = ?,
            is_spam = ?,
            is_trash = ?,
            folder_id = CASE
              WHEN direction IN ('sent', 'outbound') THEN 'folder:' || mailbox_id || ':sent'
              WHEN ? = 1 THEN 'folder:' || mailbox_id || ':trash'
              WHEN ? = 1 THEN 'folder:' || mailbox_id || ':spam'
              WHEN is_archived = 1 THEN 'folder:' || mailbox_id || ':archive'
              ELSE 'folder:' || mailbox_id || ':inbox'
            END,
            updated_at = ?
      WHERE ${inboundStateMessagePredicate()}`,
    [JSON.stringify(labels), isSpam ? 1 : 0, isTrash ? 1 : 0, isTrash ? 1 : 0, isSpam ? 1 : 0, now(), id, id],
  );
}

/** Mark an inbound email read (stamps read_at) or unread (clears it). */
export function setInboundRead(id: string, read: boolean, db?: Database): InboundEmail {
  const d = db || getDatabase();
  setInboundReadFlag(id, read, d);
  return getInboundEmail(id, d)!;
}

export function setInboundReadSummary(id: string, read: boolean, db?: Database): InboundEmailSummary {
  const d = db || getDatabase();
  setInboundReadFlag(id, read, d);
  return getInboundEmailSummary(id, d)!;
}

export function setInboundReadFlag(id: string, read: boolean, db?: Database): boolean {
  const d = db || getDatabase();
  requireInboundExists(id, d);
  const readAt = read ? now() : null;
  d.run("UPDATE inbound_emails SET is_read = ?, read_at = ? WHERE id = ?", [read ? 1 : 0, readAt, id]);
  syncMailboxReadState(id, read, readAt, d);
  return read;
}

export function setInboundArchived(id: string, archived: boolean, db?: Database): InboundEmail {
  const d = db || getDatabase();
  setInboundArchivedFlag(id, archived, d);
  return getInboundEmail(id, d)!;
}

export function setInboundArchivedSummary(id: string, archived: boolean, db?: Database): InboundEmailSummary {
  const d = db || getDatabase();
  setInboundArchivedFlag(id, archived, d);
  return getInboundEmailSummary(id, d)!;
}

export function setInboundArchivedFlag(id: string, archived: boolean, db?: Database): boolean {
  const d = db || getDatabase();
  requireInboundExists(id, d);
  d.run("UPDATE inbound_emails SET is_archived = ? WHERE id = ?", [archived ? 1 : 0, id]);
  syncMailboxArchivedState(id, archived, d);
  return archived;
}

export function setInboundStarred(id: string, starred: boolean, db?: Database): InboundEmail {
  const d = db || getDatabase();
  setInboundStarredFlag(id, starred, d);
  return getInboundEmail(id, d)!;
}

export function setInboundStarredSummary(id: string, starred: boolean, db?: Database): InboundEmailSummary {
  const d = db || getDatabase();
  setInboundStarredFlag(id, starred, d);
  return getInboundEmailSummary(id, d)!;
}

export function setInboundStarredFlag(id: string, starred: boolean, db?: Database): boolean {
  const d = db || getDatabase();
  requireInboundExists(id, d);
  d.run("UPDATE inbound_emails SET is_starred = ? WHERE id = ?", [starred ? 1 : 0, id]);
  syncMailboxStarredState(id, starred, d);
  return starred;
}

function mutateInboundLabel(id: string, label: string, remove: boolean, d: Database): void {
  const row = requireInboundLabels(id, d);
  const labels = parseJsonArray<string>(row.label_ids_json);
  const normalized = normalizeInboundLabel(label);
  const sameLabel = (value: string) => normalizeInboundLabel(value) === normalized;
  const next = remove
    ? labels.filter((l) => !sameLabel(l))
    : labels.some(sameLabel)
      ? labels
      : [...labels, label];
  d.run("UPDATE inbound_emails SET label_ids_json = ? WHERE id = ?", [JSON.stringify(next), id]);
  syncMailboxLabelState(id, next, d);
}

/** Add a label (no-op if already present). */
export function addInboundLabel(id: string, label: string, db?: Database): InboundEmail {
  const d = db || getDatabase();
  mutateInboundLabel(id, label, false, d);
  return getInboundEmail(id, d)!;
}

export function addInboundLabelSummary(id: string, label: string, db?: Database): InboundEmailSummary {
  const d = db || getDatabase();
  mutateInboundLabel(id, label, false, d);
  return getInboundEmailSummary(id, d)!;
}

/** Remove a label (no-op if absent). */
export function removeInboundLabel(id: string, label: string, db?: Database): InboundEmail {
  const d = db || getDatabase();
  mutateInboundLabel(id, label, true, d);
  return getInboundEmail(id, d)!;
}

export function removeInboundLabelSummary(id: string, label: string, db?: Database): InboundEmailSummary {
  const d = db || getDatabase();
  mutateInboundLabel(id, label, true, d);
  return getInboundEmailSummary(id, d)!;
}

/** Count unread, non-archived inbound mail (optionally scoped to a provider). */
export function getUnreadCount(provider_id?: string, db?: Database): number {
  const d = db || getDatabase();
  const sql = provider_id
    ? "SELECT COUNT(*) as count FROM inbound_emails WHERE is_sent = 0 AND is_read = 0 AND is_archived = 0 AND provider_id = ?"
    : "SELECT COUNT(*) as count FROM inbound_emails WHERE is_sent = 0 AND is_read = 0 AND is_archived = 0";
  const row = (provider_id ? d.query(sql).get(provider_id) : d.query(sql).get()) as { count: number } | null;
  return row?.count ?? 0;
}
