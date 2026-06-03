/**
 * Data layer for the interactive mail TUI (`emails interactive`).
 *
 * Presents a Gmail-like unified view over the local store: inbound mail
 * (SES-S3 / SMTP / Gmail, with read-state/star/archive/labels) and sent mail,
 * grouped into mailboxes. Pure-ish and DB-backed so it can be unit-tested
 * without a terminal.
 */
import type { Database } from "../../db/database.js";
import { getDatabase } from "../../db/database.js";
import {
  getInboundEmail,
  setInboundRead, setInboundArchived, setInboundStarred,
} from "../../db/inbound.js";
import { getEmail, createEmail } from "../../db/emails.js";
import { getEmailContent, storeEmailContent } from "../../db/email-content.js";
import { getThreadMessages } from "../../db/threads.js";
import { listProviders } from "../../db/providers.js";
import { sendWithFailover } from "../../lib/send.js";
import { marked } from "marked";

export type Mailbox = "inbox" | "unread" | "starred" | "sent" | "archived";

export const MAILBOXES: Mailbox[] = ["inbox", "unread", "starred", "sent", "archived"];

export function mailboxLabel(m: Mailbox): string {
  return { inbox: "Inbox", unread: "Unread", starred: "Starred", sent: "Sent", archived: "Archived" }[m];
}

export interface TuiMessage {
  kind: "inbound" | "sent";
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
  snippet: string;
  thread_id: string | null;
  attachments: number;
  /** True if I sent it (app-sent, or a Gmail-synced message labelled SENT). */
  sentByMe: boolean;
}

export interface AttachmentInfo {
  filename: string;
  content_type: string;
  size: number;
  location?: string; // local path or s3:// url, if downloaded
}

function snippetOf(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

interface LiteRow {
  id: string; from_address: string; to_addresses: string; subject: string; date: string;
  is_read?: number; is_starred?: number; label_ids_json?: string | null; thread_id?: string | null; snippet?: string | null;
  attachments?: number;
}

function liteToMessage(r: LiteRow, kind: "inbound" | "sent"): TuiMessage {
  let labels: string[] = [];
  try { const v = JSON.parse(r.label_ids_json ?? "[]"); if (Array.isArray(v)) labels = v as string[]; } catch { /* ignore */ }
  let to = r.to_addresses;
  try { const v = JSON.parse(r.to_addresses); if (Array.isArray(v)) to = v.join(", "); } catch { /* already a string */ }
  return {
    kind, id: r.id, from: r.from_address, to,
    subject: r.subject || "(no subject)", date: r.date,
    is_read: kind === "sent" ? true : !!r.is_read,
    is_starred: !!r.is_starred,
    labels, snippet: snippetOf(r.snippet), thread_id: r.thread_id ?? null,
    attachments: r.attachments ?? 0,
    sentByMe: kind === "sent" || labels.includes("SENT"),
  };
}

// Lean inbound projection columns (no html_body). Reused across folder queries.
const INBOUND_LITE_COLS = `id, from_address, to_addresses, subject, received_at AS date,
  is_read, is_starred, label_ids_json, thread_id, substr(text_body, 1, 140) AS snippet,
  (CASE WHEN attachments_json IS NULL OR attachments_json = '[]' THEN 0
        ELSE (LENGTH(attachments_json) - LENGTH(REPLACE(attachments_json, '"filename"', ''))) / LENGTH('"filename"') END) AS attachments`;

// The receiving folders exclude mail I sent (is_sent is a denormalized, indexed
// flag set from the Gmail SENT label at sync time — no JSON scanning at query time).
const FOLDER_WHERE: Record<Exclude<Mailbox, "sent">, string> = {
  inbox: "is_sent = 0 AND is_archived = 0",
  unread: "is_sent = 0 AND is_read = 0 AND is_archived = 0",
  starred: "is_sent = 0 AND is_starred = 1 AND is_archived = 0",
  archived: "is_archived = 1",
};

/**
 * List the messages in a mailbox, newest first. Uses a LEAN projection
 * (no html_body, snippet via substr) over indexed columns so it stays fast on
 * very large mailboxes. The Sent folder unions app-sent mail (`emails`) with
 * Gmail-synced sent mail (`inbound_emails` where is_sent = 1).
 */
export function listMailbox(mailbox: Mailbox, opts?: { limit?: number; search?: string }, db?: Database): TuiMessage[] {
  const d = db || getDatabase();
  const limit = Math.max(1, Math.trunc(opts?.limit ?? 200));
  let messages: TuiMessage[];

  if (mailbox === "sent") {
    const appSent = (d.query(
      `SELECT e.id, e.from_address, e.to_addresses, e.subject, e.sent_at AS date, e.thread_id,
              e.attachment_count AS attachments, substr(c.text_body, 1, 140) AS snippet
       FROM emails e LEFT JOIN email_content c ON c.email_id = e.id
       ORDER BY e.sent_at DESC LIMIT ?`,
    ).all(limit) as LiteRow[]).map((r) => liteToMessage(r, "sent"));
    const gmailSent = (d.query(
      `SELECT ${INBOUND_LITE_COLS} FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0
       ORDER BY received_at DESC LIMIT ?`,
    ).all(limit) as LiteRow[]).map((r) => liteToMessage(r, "inbound"));
    messages = [...appSent, ...gmailSent].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  } else {
    const rows = d.query(
      `SELECT ${INBOUND_LITE_COLS} FROM inbound_emails WHERE ${FOLDER_WHERE[mailbox]} ORDER BY received_at DESC LIMIT ?`,
    ).all(limit) as LiteRow[];
    messages = rows.map((r) => liteToMessage(r, "inbound"));
  }

  if (opts?.search) {
    const q = opts.search.toLowerCase();
    messages = messages.filter((m) =>
      m.subject.toLowerCase().includes(q) || m.from.toLowerCase().includes(q) || m.snippet.toLowerCase().includes(q));
  }
  return messages;
}

export interface MailboxCounts { inbox: number; unread: number; starred: number; sent: number; archived: number }

function count(d: Database, sql: string): number {
  const row = d.query(sql).get() as { c: number } | null;
  return row?.c ?? 0;
}

/** Folder counts via COUNT(*) over indexed columns — never materialize rows. */
export function mailboxCounts(db?: Database): MailboxCounts {
  const d = db || getDatabase();
  return {
    inbox: count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE ${FOLDER_WHERE.inbox}`),
    unread: count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE ${FOLDER_WHERE.unread}`),
    starred: count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE ${FOLDER_WHERE.starred}`),
    sent: count(d, "SELECT COUNT(*) AS c FROM emails") + count(d, "SELECT COUNT(*) AS c FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0"),
    archived: count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE ${FOLDER_WHERE.archived}`),
  };
}

export interface MessageBody {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  text: string | null;
  html: string | null;
  flags: string[];
  attachments: AttachmentInfo[];
}

/** Merge attachment metadata with downloaded-path info (local/s3 location). */
function mergeAttachments(meta: { filename: string; content_type: string; size: number }[], paths: { filename: string; local_path?: string; s3_url?: string }[]): AttachmentInfo[] {
  const byName = new Map(paths.map((p) => [p.filename, p.local_path ?? p.s3_url]));
  return meta.map((a) => ({ filename: a.filename, content_type: a.content_type, size: a.size, location: byName.get(a.filename) }));
}

export function getMessageBody(msg: TuiMessage, db?: Database): MessageBody | null {
  const d = db || getDatabase();
  if (msg.kind === "inbound") {
    const e = getInboundEmail(msg.id, d);
    if (!e) return null;
    return {
      from: e.from_address, to: e.to_addresses.join(", "), cc: e.cc_addresses.join(", "),
      subject: e.subject || "(no subject)", date: e.received_at,
      text: e.text_body, html: e.html_body,
      flags: [e.is_read ? "read" : "unread", e.is_starred && "starred", e.is_archived && "archived", ...e.label_ids].filter(Boolean) as string[],
      attachments: mergeAttachments(e.attachments ?? [], e.attachment_paths ?? []),
    };
  }
  const e = getEmail(msg.id, d);
  if (!e) return null;
  const content = getEmailContent(e.id, d);
  return {
    from: e.from_address, to: e.to_addresses.join(", "), cc: e.cc_addresses.join(", "),
    subject: e.subject || "(no subject)", date: e.sent_at,
    text: content?.text_body ?? null, html: content?.html ?? null,
    flags: ["sent", e.status].filter(Boolean) as string[],
    attachments: [],
  };
}

/** The full conversation (sent + received) for a message's thread, oldest first. */
export function getConversation(msg: TuiMessage, db?: Database): Array<{ kind: "sent" | "received"; from: string; subject: string; at: string }> {
  if (!msg.thread_id) return [];
  return getThreadMessages(msg.thread_id, db);
}

// ── mutations (inbound only; sent messages are immutable) ──────────────────────

export function toggleStar(msg: TuiMessage, db?: Database): boolean {
  if (msg.kind !== "inbound") return msg.is_starred;
  return setInboundStarred(msg.id, !msg.is_starred, db).is_starred;
}
export function toggleRead(msg: TuiMessage, db?: Database): boolean {
  if (msg.kind !== "inbound") return msg.is_read;
  return setInboundRead(msg.id, !msg.is_read, db).is_read;
}
export function markRead(msg: TuiMessage, db?: Database): void {
  if (msg.kind === "inbound" && !msg.is_read) setInboundRead(msg.id, true, db);
}
export function archiveMessage(msg: TuiMessage, archived = true, db?: Database): void {
  if (msg.kind === "inbound") setInboundArchived(msg.id, archived, db);
}

// ── compose / reply ────────────────────────────────────────────────────────────

export function activeProviderId(db?: Database): string | null {
  const d = db || getDatabase();
  const active = listProviders(d).filter((p) => p.active);
  return active[0]?.id ?? null;
}

/** Pre-fill values for replying to a message. */
export function replyDefaults(msg: TuiMessage): { from: string; to: string; subject: string } {
  const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
  // Reply goes back to the sender for inbound, to the recipient for sent.
  const to = msg.kind === "inbound" ? msg.from : msg.to;
  const from = msg.kind === "inbound" ? (msg.to.split(",")[0]?.trim() ?? "") : msg.from;
  return { from, to, subject };
}

export interface ComposeInput { from: string; to: string; subject: string; body: string; providerId?: string; markdown?: boolean }

/** Render markdown body to a simple, email-safe HTML document. */
export function renderMarkdown(md: string): string {
  // marked is synchronous in default mode; wrap output in a minimal HTML shell.
  const inner = marked.parse(md, { async: false, gfm: true, breaks: true }) as string;
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${inner}</body></html>`;
}

/**
 * Send a composed/replied message. By default the body is treated as MARKDOWN:
 * it's rendered to HTML and sent as a multipart message (HTML + the raw
 * markdown as the plain-text part), so it arrives nicely formatted.
 */
export async function sendComposed(input: ComposeInput, db?: Database): Promise<{ id: string; messageId: string }> {
  const d = db || getDatabase();
  const raw = input.providerId ?? activeProviderId(d);
  if (!raw) throw new Error("No active provider. Add one with 'emails provider add'.");
  // Accept a full or partial provider id.
  const providerId = (await import("../../db/database.js")).resolvePartialId(d, "providers", raw) ?? raw;
  const to = input.to.split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) throw new Error("At least one recipient is required.");
  if (!input.from) throw new Error("A From address is required.");
  const useMd = input.markdown !== false && input.body.trim().length > 0;
  const html = useMd ? renderMarkdown(input.body) : undefined;
  const sendOpts = { provider_id: providerId, from: input.from, to, subject: input.subject, text: input.body, ...(html ? { html } : {}) };
  const { messageId, providerId: actual } = await sendWithFailover(providerId, sendOpts, d);
  const email = createEmail(actual, sendOpts, messageId, d);
  storeEmailContent(email.id, { text: input.body, ...(html ? { html } : {}) }, d);
  return { id: email.id, messageId };
}

// ── profiles (configured accounts) + their domains/addresses ───────────────────

export interface ProfileInfo {
  id: string;
  name: string;
  provider: string;   // the kind: gmail | ses | resend | cloudflare | sandbox
  active: boolean;
  domains: string[];
  addresses: string[];
}

/**
 * A "profile" is a configured account (a row in `providers`); the "provider" is
 * the kind of service it uses (gmail/ses/resend/cloudflare). This returns each
 * profile with the domains and sender addresses registered under it.
 */
export function listProfiles(db?: Database): ProfileInfo[] {
  const d = db || getDatabase();
  return listProviders(d).map((p) => ({
    id: p.id,
    name: p.name,
    provider: p.type,
    active: !!p.active,
    domains: (d.query("SELECT domain FROM domains WHERE provider_id = ? ORDER BY domain").all(p.id) as { domain: string }[]).map((r) => r.domain),
    addresses: (d.query("SELECT email FROM addresses WHERE provider_id = ? ORDER BY email").all(p.id) as { email: string }[]).map((r) => r.email),
  }));
}
