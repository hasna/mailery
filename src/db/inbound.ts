import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";

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
  received_at: string;
  created_at: string;
}

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
  received_at: string;
  created_at: string;
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
    label_ids: JSON.parse(row.label_ids_json ?? "[]") as string[],
    raw_s3_url: row.raw_s3_url ?? null,
    metadata_s3_url: row.metadata_s3_url ?? null,
    from_address: row.from_address,
    to_addresses: JSON.parse(row.to_addresses) as string[],
    cc_addresses: JSON.parse(row.cc_addresses) as string[],
    subject: row.subject,
    text_body: row.text_body,
    html_body: row.html_body,
    attachments: JSON.parse(row.attachments_json) as AttachmentMeta[],
    attachment_paths: JSON.parse(row.attachment_paths ?? "[]") as AttachmentPath[],
    headers: JSON.parse(row.headers_json) as Record<string, string>,
    raw_size: row.raw_size,
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
    "provider_internal_date" | "label_ids" | "raw_s3_url" | "metadata_s3_url" | "thread_id"
  > & Partial<Pick<
    InboundEmail,
    "provider_thread_id" | "provider_history_id" | "provider_internal_date" |
    "label_ids" | "raw_s3_url" | "metadata_s3_url" | "thread_id"
  >>,
  db?: Database,
): InboundEmail {
  const d = db || getDatabase();
  const id = uuid();

  // Auto-detect reply linkage from email headers
  const replyToEmailId = input.in_reply_to_email_id ?? detectReplyToEmailId(input.headers, d);

  d.run(
    `INSERT INTO inbound_emails
       (id, provider_id, message_id, in_reply_to_email_id, provider_thread_id, provider_history_id,
        provider_internal_date, label_ids_json, raw_s3_url, metadata_s3_url, from_address, to_addresses, cc_addresses,
        subject, text_body, html_body, attachments_json, attachment_paths, headers_json, raw_size, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify((input as InboundEmail).attachment_paths ?? []),
      JSON.stringify(input.headers),
      input.raw_size,
      input.received_at || now(),
    ],
  );

  const row = d.query("SELECT * FROM inbound_emails WHERE id = ?").get(id) as InboundEmailRow;
  const stored = rowToEmail(row);

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

export function listReplies(emailId: string, db?: Database): InboundEmail[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM inbound_emails WHERE in_reply_to_email_id = ? ORDER BY received_at ASC")
    .all(emailId) as InboundEmailRow[];
  return rows.map(rowToEmail);
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

export function listInboundEmails(
  opts?: { provider_id?: string; since?: string; limit?: number; offset?: number },
  db?: Database,
): InboundEmail[] {
  const d = db || getDatabase();
  const rawLimit = opts?.limit ?? 50;
  const rawOffset = opts?.offset ?? 0;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.trunc(rawLimit)) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.provider_id) {
    conditions.push("provider_id = ?");
    params.push(opts.provider_id);
  }
  if (opts?.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }

  const where = conditions.length > 0 ? 
    `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  params.push(offset);

  const rows = d
    .query(`SELECT * FROM inbound_emails ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as InboundEmailRow[];
  return rows.map(rowToEmail);
}

export function deleteInboundEmail(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM inbound_emails WHERE id = ?", [id]);
  return result.changes > 0;
}

export function clearInboundEmails(provider_id?: string, db?: Database): number {
  const d = db || getDatabase();
  let result: { changes: number };
  if (provider_id) {
    result = d.run("DELETE FROM inbound_emails WHERE provider_id = ?", [provider_id]);
  } else {
    result = d.run("DELETE FROM inbound_emails");
  }
  return result.changes;
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
