/**
 * Data layer for the email UI (`emails ui`).
 *
 * Presents a Gmail-like unified view over the local store: inbound mail
 * (SES-S3 / SMTP / Gmail, with read-state/star/archive/labels) and sent mail,
 * grouped into mailboxes. Pure-ish and DB-backed so it can be unit-tested
 * without a terminal.
 */
import type { Database } from "../../db/database.js";
import { getDatabase, now, resolvePartialIdOrThrow } from "../../db/database.js";
import { sqlEmailAddress, sqlEmailDomain } from "../../db/email-address-sql.js";
import { parseJsonArray } from "../../db/json.js";
import { countValue } from "../../db/scalars.js";
import {
  getReceivedInboundCount,
  getLatestReceivedInboundAt,
  setInboundReadFlag, setInboundArchivedFlag, setInboundStarredFlag,
} from "../../db/inbound.js";
import { getEmail, createEmail } from "../../db/emails.js";
import { getEmailContent, storeEmailContent } from "../../db/email-content.js";
import { getThreadMessages } from "../../db/threads.js";
import { getLatestActiveProviderId, listActiveProviderSummaries, listProviderNamesByIds, listProviderSummaries } from "../../db/providers.js";
import { listDomains, listDomainsByProviderIds } from "../../db/domains.js";
import { findAddressesByEmail, getPreferredActiveAddressEmail, listActiveAddressCountsByDomains, listActiveAddressEmails, listAddressesByProviderIds } from "../../db/addresses.js";
import { listAliasesByTargets } from "../../db/aliases.js";
import { listSendKeySummariesByOwners } from "../../db/send-keys.js";
import { listOwnerNamesByIds } from "../../db/owners.js";
import { listAddressProvisioningByIds, listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../../db/provisioning.js";
import { loadConfig, saveConfig } from "../../lib/config.js";
import { assessDomainReadiness, type DomainReadiness } from "../../lib/domain-readiness.js";
import { marked } from "marked";
import { normalizeThemeMode, type TuiThemeMode } from "./theme.js";

export type Mailbox = "inbox" | "unread" | "starred" | "sent" | "archived";

export const MAILBOXES: Mailbox[] = ["inbox", "unread", "starred", "sent", "archived"];

export function mailboxLabel(m: Mailbox): string {
  return { inbox: "Inbox", unread: "Unread", starred: "Starred", sent: "Sent", archived: "Archived" }[normalizeMailbox(m)];
}

function normalizeMailbox(value: unknown): Mailbox {
  return MAILBOXES.includes(value as Mailbox) ? (value as Mailbox) : "inbox";
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

function isDatabase(value: unknown): value is Database {
  return typeof (value as { query?: unknown } | undefined)?.query === "function";
}

function pageFromOptions(opts: { limit?: number; offset?: number } | undefined, fallbackLimit: number): { limit: number; offset: number } | undefined {
  if (!opts) return undefined;
  return {
    limit: positiveInt(opts.limit, fallbackLimit),
    offset: nonNegativeInt(opts.offset, 0),
  };
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

interface MailboxUnionRow extends LiteRow {
  kind: "inbound" | "sent";
}

function liteToMessage(r: LiteRow, kind: "inbound" | "sent"): TuiMessage {
  const labels = parseJsonArray<unknown>(r.label_ids_json).filter((item): item is string => typeof item === "string");
  let to = r.to_addresses;
  const parsedTo = parseJsonArray<unknown>(r.to_addresses);
  if (parsedTo.length > 0) to = parsedTo.map((item) => String(item)).join(", ");
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
const MAILBOX_UNION_COLS = "kind, id, from_address, to_addresses, subject, date, is_read, is_starred, label_ids_json, thread_id, snippet, attachments";

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
export interface MailboxSource { providerId?: string; domain?: string; address?: string }

interface SqlClause { sql: string; params: string[] }

function addressDomainParams(domain: string): [string] {
  return [domain.toLowerCase()];
}

function addressDomainSql(column: string): string {
  return `${sqlEmailDomain(column)} = ?`;
}

function recipientSourceClause(src?: MailboxSource): SqlClause {
  const params: string[] = [];
  let sql = "";
  if (src?.providerId) { sql += " AND provider_id = ?"; params.push(src.providerId); }
  if (src?.address) {
    const address = src.address.toLowerCase();
    sql += ` AND inbound_emails.id IN (
      SELECT recipient.inbound_email_id
        FROM inbound_recipients recipient
       WHERE recipient.address = ?
    )`;
    params.push(address);
  }
  if (src?.domain) {
    sql += ` AND inbound_emails.id IN (
      SELECT recipient.inbound_email_id
        FROM inbound_recipients recipient
       WHERE recipient.domain = ?
    )`;
    params.push(src.domain.toLowerCase());
  }
  return { sql, params };
}

function senderSourceClause(src?: MailboxSource): SqlClause {
  const params: string[] = [];
  let sql = "";
  if (src?.providerId) { sql += " AND provider_id = ?"; params.push(src.providerId); }
  if (src?.address) { sql += ` AND ${sqlEmailAddress("from_address")} = ?`; params.push(src.address.toLowerCase()); }
  if (src?.domain) { sql += ` AND ${addressDomainSql("from_address")}`; params.push(...addressDomainParams(src.domain)); }
  return { sql, params };
}

function searchClause(search: string | undefined, columns: string[]): SqlClause {
  const q = search?.trim().toLowerCase();
  if (!q) return { sql: "", params: [] };
  const like = `%${q}%`;
  return {
    sql: ` AND (${columns.map((column) => `LOWER(COALESCE(${column}, '')) LIKE ?`).join(" OR ")})`,
    params: columns.map(() => like),
  };
}

function appSentSourceClause(src?: MailboxSource, search?: string): SqlClause {
  const params: string[] = [];
  const where: string[] = [];
  if (src?.providerId) { where.push("e.provider_id = ?"); params.push(src.providerId); }
  if (src?.address) { where.push(`${sqlEmailAddress("e.from_address")} = ?`); params.push(src.address.toLowerCase()); }
  if (src?.domain) { where.push(addressDomainSql("e.from_address")); params.push(...addressDomainParams(src.domain)); }
  const searchTerm = search?.trim().toLowerCase();
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    where.push("(LOWER(COALESCE(e.subject, '')) LIKE ? OR LOWER(COALESCE(e.from_address, '')) LIKE ? OR LOWER(COALESCE(e.to_addresses, '')) LIKE ? OR LOWER(COALESCE(c.text_body, '')) LIKE ?)");
    params.push(like, like, like, like);
  }
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

export interface MailboxListOptions {
  limit?: number;
  offset?: number;
  search?: string;
  source?: MailboxSource;
  sort?: "newest" | "oldest";
}

export function listMailbox(mailbox: Mailbox, opts?: MailboxListOptions, db?: Database): TuiMessage[] {
  const d = db || getDatabase();
  const selectedMailbox = normalizeMailbox(mailbox);
  const limit = positiveInt(opts?.limit, 200);
  const offset = nonNegativeInt(opts?.offset, 0);
  const order = opts?.sort === "oldest" ? "ASC" : "DESC";
  let messages: TuiMessage[];

  const src = opts?.source;
  const recipientSrc = recipientSourceClause(src);
  const inboundSearch = searchClause(opts?.search, ["subject", "from_address", "to_addresses", "text_body"]);

  if (selectedMailbox === "sent") {
    const appSrc = appSentSourceClause(src, opts?.search);
    const senderSrc = senderSourceClause(src);
    const sentSearch = searchClause(opts?.search, ["subject", "from_address", "to_addresses", "text_body"]);
    const branchLimit = limit + offset;
    const rows = d.query(
      `WITH app_sent AS (
         SELECT 'sent' AS kind, e.id, e.from_address, e.to_addresses, e.subject, e.sent_at AS date,
                1 AS is_read, 0 AS is_starred, '[]' AS label_ids_json, e.thread_id,
                substr(c.text_body, 1, 140) AS snippet, e.attachment_count AS attachments
         FROM emails e LEFT JOIN email_content c ON c.email_id = e.id${appSrc.sql}
         ORDER BY e.sent_at ${order}
         LIMIT ?
       ),
       synced_sent AS (
         SELECT 'inbound' AS kind, id, from_address, to_addresses, subject, received_at AS date,
                is_read, is_starred, label_ids_json, thread_id, substr(text_body, 1, 140) AS snippet,
                (CASE WHEN attachments_json IS NULL OR attachments_json = '[]' THEN 0
                      ELSE (LENGTH(attachments_json) - LENGTH(REPLACE(attachments_json, '"filename"', ''))) / LENGTH('"filename"') END) AS attachments
         FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0${senderSrc.sql}${sentSearch.sql}
         ORDER BY received_at ${order}
         LIMIT ?
       )
       SELECT ${MAILBOX_UNION_COLS} FROM (
         SELECT ${MAILBOX_UNION_COLS} FROM app_sent
         UNION ALL
         SELECT ${MAILBOX_UNION_COLS} FROM synced_sent
       ) ORDER BY date ${order} LIMIT ? OFFSET ?`,
    ).all(...appSrc.params, branchLimit, ...senderSrc.params, ...sentSearch.params, branchLimit, limit, offset) as MailboxUnionRow[];
    messages = rows.map((r) => liteToMessage(r, r.kind));
  } else {
    const rows = d.query(
      `SELECT ${INBOUND_LITE_COLS} FROM inbound_emails WHERE ${FOLDER_WHERE[selectedMailbox]}${recipientSrc.sql}${inboundSearch.sql} ORDER BY received_at ${order} LIMIT ? OFFSET ?`,
    ).all(...recipientSrc.params, ...inboundSearch.params, limit, offset) as LiteRow[];
    messages = rows.map((r) => liteToMessage(r, "inbound"));
  }

  return messages;
}

export interface MailboxCounts { inbox: number; unread: number; starred: number; sent: number; archived: number }

function hasSourceFilter(source: MailboxSource | undefined): boolean {
  return !!(source?.providerId || source?.domain || source?.address);
}

function unscopedMailboxCounts(db: Database): MailboxCounts {
  const row = db.query(
    `SELECT
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.inbox}) AS inbox,
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.unread}) AS unread,
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.starred}) AS starred,
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.archived}) AS archived,
       (SELECT COUNT(*) FROM emails) +
       (SELECT COUNT(*) FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0) AS sent`,
  ).get() as Partial<Record<keyof MailboxCounts, unknown>> | null;
  return {
    inbox: countValue(row?.inbox),
    unread: countValue(row?.unread),
    starred: countValue(row?.starred),
    sent: countValue(row?.sent),
    archived: countValue(row?.archived),
  };
}

/** Folder counts without materializing mailbox rows. */
export function mailboxCounts(db?: Database): MailboxCounts;
export function mailboxCounts(opts?: { source?: MailboxSource }, db?: Database): MailboxCounts;
export function mailboxCounts(optsOrDb?: Database | { source?: MailboxSource }, maybeDb?: Database): MailboxCounts {
  const isDb = typeof (optsOrDb as { query?: unknown } | undefined)?.query === "function";
  const d = (isDb ? optsOrDb as Database : maybeDb) || getDatabase();
  const opts = isDb ? undefined : optsOrDb as { source?: MailboxSource } | undefined;
  if (!hasSourceFilter(opts?.source)) return unscopedMailboxCounts(d);

  const recipientSrc = recipientSourceClause(opts?.source);
  const senderSrc = senderSourceClause(opts?.source);
  const appSrc = appSentSourceClause(opts?.source);
  const row = d.query(
    `SELECT
       COALESCE(inbound.inbox, 0) AS inbox,
       COALESCE(inbound.unread, 0) AS unread,
       COALESCE(inbound.starred, 0) AS starred,
       COALESCE(inbound.archived, 0) AS archived,
       (SELECT COUNT(*) FROM emails e${appSrc.sql}) +
       (SELECT COUNT(*) FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0${senderSrc.sql}) AS sent
     FROM (
       SELECT
         SUM(CASE WHEN ${FOLDER_WHERE.inbox} THEN 1 ELSE 0 END) AS inbox,
         SUM(CASE WHEN ${FOLDER_WHERE.unread} THEN 1 ELSE 0 END) AS unread,
         SUM(CASE WHEN ${FOLDER_WHERE.starred} THEN 1 ELSE 0 END) AS starred,
         SUM(CASE WHEN ${FOLDER_WHERE.archived} THEN 1 ELSE 0 END) AS archived
       FROM inbound_emails
       WHERE 1 = 1${recipientSrc.sql}
     ) inbound`,
  ).get(...appSrc.params, ...senderSrc.params, ...recipientSrc.params) as Partial<Record<keyof MailboxCounts, unknown>> | null;
  return {
    inbox: countValue(row?.inbox),
    unread: countValue(row?.unread),
    starred: countValue(row?.starred),
    sent: countValue(row?.sent),
    archived: countValue(row?.archived),
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

interface InboundBodyRow {
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  subject: string;
  received_at: string;
  text_body: string | null;
  html_body: string | null;
  is_read: number;
  is_starred: number;
  is_archived: number;
  label_ids_json: string | null;
  attachments_json: string | null;
  attachment_paths: string | null;
}

/** Merge attachment metadata with downloaded-path info (local/s3 location). */
function mergeAttachments(meta: { filename: string; content_type: string; size: number }[], paths: { filename: string; local_path?: string; s3_url?: string }[]): AttachmentInfo[] {
  const byName = new Map(paths.map((p) => [p.filename, p.local_path ?? p.s3_url]));
  return meta.map((a) => ({ filename: a.filename, content_type: a.content_type, size: a.size, location: byName.get(a.filename) }));
}

export function getMessageBody(msg: TuiMessage, db?: Database): MessageBody | null {
  const d = db || getDatabase();
  if (msg.kind === "inbound") {
    const e = d.query(
      `SELECT from_address, to_addresses, cc_addresses, subject, received_at,
              text_body, html_body, is_read, is_starred, is_archived,
              label_ids_json, attachments_json, attachment_paths
         FROM inbound_emails
        WHERE id = ?`,
    ).get(msg.id) as InboundBodyRow | null;
    if (!e) return null;
    const labels = parseJsonArray<string>(e.label_ids_json);
    return {
      from: e.from_address,
      to: parseJsonArray<string>(e.to_addresses).join(", "),
      cc: parseJsonArray<string>(e.cc_addresses).join(", "),
      subject: e.subject || "(no subject)", date: e.received_at,
      text: e.text_body, html: e.html_body,
      flags: [e.is_read ? "read" : "unread", e.is_starred && "starred", e.is_archived && "archived", ...labels].filter(Boolean) as string[],
      attachments: mergeAttachments(parseJsonArray(e.attachments_json), parseJsonArray(e.attachment_paths)),
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
  return setInboundStarredFlag(msg.id, !msg.is_starred, db);
}
export function toggleRead(msg: TuiMessage, db?: Database): boolean {
  if (msg.kind !== "inbound") return msg.is_read;
  return setInboundReadFlag(msg.id, !msg.is_read, db);
}
export function markRead(msg: TuiMessage, db?: Database): void {
  if (msg.kind === "inbound" && !msg.is_read) setInboundReadFlag(msg.id, true, db);
}
export function archiveMessage(msg: TuiMessage, archived = true, db?: Database): void {
  if (msg.kind === "inbound") setInboundArchivedFlag(msg.id, archived, db);
}

// ── compose / reply ────────────────────────────────────────────────────────────

export function activeProviderId(db?: Database): string | null {
  const d = db || getDatabase();
  return getLatestActiveProviderId(undefined, d);
}

export function providerIdForSender(address: string, db?: Database): string | null {
  const d = db || getDatabase();
  const normalized = extractEmail(address);
  if (!normalized) return null;
  const matches = findAddressesByEmail(normalized, d).filter((a) => (a.status ?? "active") === "active");
  return matches.find((a) => a.verified)?.provider_id ?? matches[0]?.provider_id ?? null;
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

/** Pick the best configured sender for a new TUI compose. */
export function defaultFromAddress(opts?: { source?: MailboxSource; fallback?: string }, db?: Database): string {
  const d = db || getDatabase();
  if (opts?.source?.address) return opts.source.address;
  const domain = opts?.source?.domain?.toLowerCase();
  if (domain) {
    const domainSender = getPreferredActiveAddressEmail({ provider_id: opts?.source?.providerId, domain }, d);
    if (domainSender) return domainSender;
    if (opts?.fallback) return opts.fallback;
  }
  return getPreferredActiveAddressEmail({ provider_id: opts?.source?.providerId }, d) || opts?.fallback || "";
}

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
  const raw = input.providerId ?? providerIdForSender(input.from, d) ?? activeProviderId(d);
  if (!raw) throw new Error("No active provider. Add one with 'emails provider add'.");
  // Accept a full or partial provider id, but fail loudly on missing/ambiguous values.
  const providerId = resolvePartialIdOrThrow(d, "providers", raw);
  const to = input.to.split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) throw new Error("At least one recipient is required.");
  if (!input.from) throw new Error("A From address is required.");
  const useMd = input.markdown !== false && input.body.trim().length > 0;
  const html = useMd ? renderMarkdown(input.body) : undefined;
  const sendOpts = { provider_id: providerId, from: input.from, to, subject: input.subject, text: input.body, ...(html ? { html } : {}) };
  const { sendWithFailover } = await import("../../lib/send.js");
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
  domain_details: ProfileDomainInfo[];
  address_details: ProfileAddressInfo[];
  send_keys: ProfileSendKeyInfo[];
}

export interface ProfileDomainInfo {
  domain: string;
  readiness: DomainReadiness;
  provisioning_status: string;
}

export interface ProfileAddressInfo {
  email: string;
  verified: boolean;
  status: string;
  owner: string | null;
  administrator: string | null;
  receive_status: string;
  daily_quota: number | null;
  sent_today: number;
  aliases: string[];
  send_keys: ProfileSendKeyInfo[];
}

export interface ProfileSendKeyInfo {
  id: string;
  owner: string | null;
  label: string | null;
  prefix: string;
  active: boolean;
}

export interface DomainSummary {
  domain: string;
  provider: string;
  addresses: number;
  inbox: number;
  unread: number;
  sent: number;
  archived: number;
  total: number;
  readiness: string;
}

interface DomainMailCounts {
  inbox: number;
  unread: number;
  sent: number;
  archived: number;
}

function emptyDomainCounts(): DomainMailCounts {
  return { inbox: 0, unread: 0, sent: 0, archived: 0 };
}

function extractEmail(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  const bracketed = raw.match(/<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>/);
  const email = bracketed?.[1] ?? raw;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function allDomainMailCounts(db: Database, domains: string[]): Map<string, DomainMailCounts> {
  const counts = new Map<string, DomainMailCounts>();
  const requested = new Set(domains.map((domain) => domain.toLowerCase()));
  if (requested.size === 0) return counts;

  for (const domain of requested) counts.set(domain, emptyDomainCounts());
  const domainParams = [...requested];
  const domainPlaceholders = domainParams.map(() => "?").join(", ");

  const inboundRows = db.query(
    `WITH recipient_domains AS (
       SELECT DISTINCT r.inbound_email_id AS id, r.domain, e.is_sent, e.is_archived, e.is_read
         FROM inbound_recipients r
         JOIN inbound_emails e ON e.id = r.inbound_email_id
        WHERE r.domain IN (${domainPlaceholders})
     )
     SELECT
       domain,
       COALESCE(SUM(CASE WHEN is_sent = 0 AND is_archived = 0 THEN 1 ELSE 0 END), 0) AS inbox,
       COALESCE(SUM(CASE WHEN is_sent = 0 AND is_read = 0 AND is_archived = 0 THEN 1 ELSE 0 END), 0) AS unread,
       COALESCE(SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END), 0) AS archived
     FROM recipient_domains
     GROUP BY domain`,
  ).all(...domainParams) as Array<{ domain: string; inbox: unknown; unread: unknown; archived: unknown }>;

  for (const row of inboundRows) {
    const domain = row.domain.toLowerCase();
    const current = counts.get(domain);
    if (!current) continue;
    counts.set(domain, {
      ...current,
      inbox: countValue(row.inbox),
      unread: countValue(row.unread),
      archived: countValue(row.archived),
    });
  }

  const appSenderDomain = sqlEmailDomain("from_address");
  const appSentRows = db.query(
    `SELECT ${appSenderDomain} AS domain, COUNT(*) AS sent
     FROM emails
     WHERE ${appSenderDomain} IN (${domainPlaceholders})
     GROUP BY ${appSenderDomain}`,
  ).all(...domainParams) as Array<{ domain: string | null; sent: unknown }>;

  const syncedSenderDomain = sqlEmailDomain("from_address");
  const syncedSentRows = db.query(
    `SELECT ${syncedSenderDomain} AS domain, COUNT(*) AS sent
     FROM inbound_emails
     WHERE is_sent = 1
       AND is_archived = 0
       AND ${syncedSenderDomain} IN (${domainPlaceholders})
     GROUP BY ${syncedSenderDomain}`,
  ).all(...domainParams) as Array<{ domain: string | null; sent: unknown }>;

  for (const row of [...appSentRows, ...syncedSentRows]) {
    if (!row.domain) continue;
    const domain = row.domain.toLowerCase();
    const current = counts.get(domain);
    if (!current) continue;
    counts.set(domain, { ...current, sent: current.sent + countValue(row.sent) });
  }

  return counts;
}

function sentTodayByAddresses(db: Database, addresses: Iterable<string>): Map<string, number> {
  const normalized = [...new Set([...addresses].map((address) => address.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return new Map();
  const today = now().slice(0, 10);
  const placeholders = normalized.map(() => "?").join(", ");
  const rows = db.query(
    `SELECT email, COUNT(*) AS c
     FROM (
       SELECT ${sqlEmailAddress("from_address")} AS email
       FROM emails
       WHERE sent_at LIKE ?
     )
     WHERE email IN (${placeholders})
     GROUP BY email`,
  ).all(`${today}%`, ...normalized) as Array<{ email: string; c: number }>;
  return new Map(rows.map((row) => [row.email, row.c]));
}

export interface ListDomainSummaryOptions {
  limit?: number;
  offset?: number;
}

export function listDomainSummaries(db?: Database): DomainSummary[];
export function listDomainSummaries(opts?: ListDomainSummaryOptions, db?: Database): DomainSummary[];
export function listDomainSummaries(optsOrDb?: ListDomainSummaryOptions | Database, maybeDb?: Database): DomainSummary[] {
  const d = isDatabase(optsOrDb) ? optsOrDb : maybeDb || getDatabase();
  const opts = isDatabase(optsOrDb) ? undefined : optsOrDb;
  const page = pageFromOptions(opts, 50);
  const domains = listDomains(undefined, d, page);
  const domainIds = domains.map((domain) => domain.id);
  const domainNames = domains.map((domain) => domain.domain);
  const providers = listProviderNamesByIds(domains.map((domain) => domain.provider_id), d);
  const addressCountByDomain = listActiveAddressCountsByDomains(domainNames, d);
  const provisioningById = listDomainProvisioningByIds(domainIds, d);
  const readyAddressesByDomain = listReadyAddressCountsByDomains(domainIds, d);
  const countsByDomain = allDomainMailCounts(d, domains.map((domain) => domain.domain));
  return domains
    .map((domain) => {
      const key = domain.domain.toLowerCase();
      const counts = countsByDomain.get(key) ?? emptyDomainCounts();
      const addressCount = addressCountByDomain.get(key) ?? 0;
      const provisioning = provisioningById.get(domain.id) ?? null;
      return {
        domain: domain.domain,
        provider: providers.get(domain.provider_id) ?? domain.provider_id,
        addresses: addressCount,
        inbox: counts.inbox,
        unread: counts.unread,
        sent: counts.sent,
        archived: counts.archived,
        total: counts.inbox + counts.sent + counts.archived,
        readiness: assessDomainReadiness(domain, provisioning, { ready_addresses: readyAddressesByDomain.get(domain.id) ?? 0 }).state,
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

// ── inbox address choices ──────────────────────────────────────────────────────

export interface InboxAddressChoice {
  id: string;
  label: string;
  address?: string;
  configured: boolean;
  observed: boolean;
}

export const ALL_ADDRESSES: InboxAddressChoice = {
  id: "all",
  label: "All inboxes",
  configured: false,
  observed: false,
};

function upsertAddressChoice(
  map: Map<string, InboxAddressChoice>,
  address: string,
  patch: Partial<Pick<InboxAddressChoice, "configured" | "observed">>,
): void {
  const existing = map.get(address) ?? { id: `a:${address}`, label: address, address, configured: false, observed: false };
  map.set(address, { ...existing, ...patch });
}

interface ObservedInboxAddressCache {
  count: number;
  latest: string | null;
  limit: number;
  addresses: string[];
}

const DEFAULT_OBSERVED_INBOX_ADDRESS_LIMIT = 200;
const DEFAULT_OBSERVED_INBOX_SCAN_LIMIT = 2000;
const MIN_OBSERVED_INBOX_SCAN_LIMIT = 50;
const OBSERVED_INBOX_SCAN_MULTIPLIER = 8;
const observedInboxAddressCache = new WeakMap<Database, ObservedInboxAddressCache>();

export interface ListInboxAddressOptions {
  limit?: number;
  search?: string;
}

function listConfiguredInboxAddresses(db: Database, opts?: ListInboxAddressOptions): string[] {
  if (!opts) return listActiveAddressEmails(undefined, db);
  const limit = positiveInt(opts.limit, 200);
  const q = opts.search?.trim().toLowerCase();
  const searchSql = q ? " AND LOWER(email) LIKE ?" : "";
  const params: Array<string | number> = [];
  if (q) params.push(`%${q}%`);
  params.push(limit);
  const rows = db
    .query(`SELECT email FROM addresses WHERE COALESCE(status, 'active') = 'active'${searchSql} ORDER BY created_at DESC, email ASC LIMIT ?`)
    .all(...params) as Array<{ email: string }>;
  return rows.map((row) => row.email);
}

function listObservedInboxAddresses(db: Database, opts?: ListInboxAddressOptions): string[] {
  const limit = positiveInt(opts?.limit, DEFAULT_OBSERVED_INBOX_ADDRESS_LIMIT);
  const q = opts?.search?.trim().toLowerCase();
  if (q) {
    const inboundRecipients = db.query(
      `SELECT DISTINCT r.address AS email
       FROM inbound_recipients r
       JOIN inbound_emails e ON e.id = r.inbound_email_id
       WHERE e.is_sent = 0
         AND r.address LIKE ?
       ORDER BY r.address
       LIMIT ?`,
    ).all(`%${q}%`, limit) as { email: string }[];
    return inboundRecipients
      .map((row) => extractEmail(row.email))
      .filter((address): address is string => !!address);
  }

  const count = getReceivedInboundCount(undefined, db);
  const latest = getLatestReceivedInboundAt(db);
  const cached = observedInboxAddressCache.get(db);
  if (cached && cached.count === count && cached.latest === latest && cached.limit >= limit) {
    return cached.addresses.slice(0, limit);
  }
  if (count === 0) {
    const empty: string[] = [];
    observedInboxAddressCache.set(db, { count, latest, limit, addresses: empty });
    return empty;
  }

  let scanLimit = Math.max(
    limit,
    Math.min(
      DEFAULT_OBSERVED_INBOX_SCAN_LIMIT,
      Math.max(MIN_OBSERVED_INBOX_SCAN_LIMIT, limit * OBSERVED_INBOX_SCAN_MULTIPLIER),
    ),
  );
  let addresses: string[] = [];
  while (true) {
    const inboundRecipients = db.query(
      `WITH recent AS (
         SELECT id, received_at
           FROM inbound_emails
          WHERE is_sent = 0
          ORDER BY received_at DESC
          LIMIT ?
       )
       SELECT r.address AS email
         FROM recent e
         JOIN inbound_recipients r ON r.inbound_email_id = e.id
        GROUP BY r.address
       ORDER BY MAX(e.received_at) DESC, r.address ASC
       LIMIT ?`,
    ).all(scanLimit, limit) as { email: string }[];
    addresses = inboundRecipients
      .map((row) => extractEmail(row.email))
      .filter((address): address is string => !!address)
      .slice(0, limit);
    if (addresses.length >= limit || scanLimit >= DEFAULT_OBSERVED_INBOX_SCAN_LIMIT || scanLimit >= count) break;
    scanLimit = Math.min(DEFAULT_OBSERVED_INBOX_SCAN_LIMIT, Math.max(scanLimit + 1, scanLimit * 2));
  }
  observedInboxAddressCache.set(db, { count, latest, limit, addresses });
  return addresses;
}

/**
 * User-facing inbox choices. The normal TUI exposes only "All inboxes" or a
 * concrete email address; providers/domains stay in Profiles/diagnostics.
 */
export function listInboxAddresses(db?: Database): InboxAddressChoice[];
export function listInboxAddresses(opts?: ListInboxAddressOptions, db?: Database): InboxAddressChoice[];
export function listInboxAddresses(optsOrDb?: ListInboxAddressOptions | Database, maybeDb?: Database): InboxAddressChoice[] {
  const d = isDatabase(optsOrDb) ? optsOrDb : maybeDb || getDatabase();
  const opts = isDatabase(optsOrDb) ? undefined : optsOrDb;
  const byAddress = new Map<string, InboxAddressChoice>();

  for (const email of listConfiguredInboxAddresses(d, opts)) {
    const address = extractEmail(email);
    if (address) upsertAddressChoice(byAddress, address, { configured: true });
  }

  for (const address of listObservedInboxAddresses(d, opts)) {
    upsertAddressChoice(byAddress, address, { observed: true });
  }

  const choices = [...byAddress.values()].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  const limit = opts ? positiveInt(opts.limit, 200) : null;
  const visibleChoices = limit === null ? choices : choices.slice(0, limit);
  return opts?.search?.trim() ? visibleChoices : [ALL_ADDRESSES, ...visibleChoices];
}

export function addressChoiceByAddress(address: string | null | undefined, db?: Database): InboxAddressChoice {
  const normalized = extractEmail(address);
  if (!normalized) return ALL_ADDRESSES;
  const d = db || getDatabase();
  const configured = d
    .query("SELECT email FROM addresses WHERE email = ? COLLATE NOCASE AND COALESCE(status, 'active') = 'active' LIMIT 1")
    .get(normalized) as { email: string } | null;
  const observed = d
    .query(
      `SELECT r.address AS email
       FROM inbound_recipients r
       JOIN inbound_emails e ON e.id = r.inbound_email_id
       WHERE e.is_sent = 0
         AND r.address = ?
       LIMIT 1`,
    )
    .get(normalized) as { email: string } | null;
  if (configured || observed) {
    return {
      id: `a:${normalized}`,
      label: configured?.email ?? observed?.email ?? normalized,
      address: normalized,
      configured: !!configured,
      observed: !!observed,
    };
  }
  return {
    id: `a:${normalized}`,
    label: normalized,
    address: normalized,
    configured: false,
    observed: true,
  };
}

// ── legacy inbox sources (kept for non-UI callers/tests) ──────────────────────

export interface InboxSource { id: string; label: string; providerId?: string; domain?: string }

/** The selectable inboxes: All, each account, and each registered domain. */
export function listSources(db?: Database): InboxSource[] {
  const d = db || getDatabase();
  const out: InboxSource[] = [{ id: "all", label: "All Mail" }];
  for (const p of listActiveProviderSummaries(undefined, d)) out.push({ id: `p:${p.id}`, label: p.name, providerId: p.id });
  const doms = d.query("SELECT DISTINCT domain FROM domains ORDER BY domain").all() as { domain: string }[];
  for (const r of doms) out.push({ id: `d:${r.domain}`, label: `@${r.domain}`, domain: r.domain });
  return out;
}

// ── settings (persisted to config.json) ────────────────────────────────────────

export interface TuiSettings {
  autoPull: boolean;
  gmailAutoPull: boolean;
  dimRead: boolean;
  defaultMailbox: Mailbox;
  defaultAddress: string | null;
  defaultFrom: string | null;
  theme: TuiThemeMode;
}

export function getSettings(): TuiSettings {
  const c = loadConfig();
  return {
    autoPull: c["tui_autopull"] !== false,
    gmailAutoPull: c["tui_gmail_autopull"] !== false,
    dimRead: c["tui_dim_read"] === true, // default false = high contrast
    defaultMailbox: normalizeMailbox(c["default_mailbox"]),
    defaultAddress: extractEmail(c["tui_default_address"]) ?? null,
    defaultFrom: extractEmail(c["tui_default_from"]) ?? null,
    theme: normalizeThemeMode(c["tui_theme"]),
  };
}

export function setSetting<K extends keyof TuiSettings>(key: K, value: TuiSettings[K]): void {
  const c = loadConfig();
  const map: Record<keyof TuiSettings, string> = {
    autoPull: "tui_autopull",
    gmailAutoPull: "tui_gmail_autopull",
    dimRead: "tui_dim_read",
    defaultMailbox: "default_mailbox",
    defaultAddress: "tui_default_address",
    defaultFrom: "tui_default_from",
    theme: "tui_theme",
  };
  c[map[key]] = value as never;
  saveConfig(c);
}

/**
 * A "profile" is a configured account (a row in `providers`); the "provider" is
 * the kind of service it uses (gmail/ses/resend/cloudflare). This returns each
 * profile with the domains and sender addresses registered under it.
 */
export interface ListProfileOptions {
  limit?: number;
  offset?: number;
}

export function listProfiles(db?: Database): ProfileInfo[];
export function listProfiles(opts?: ListProfileOptions, db?: Database): ProfileInfo[];
export function listProfiles(optsOrDb?: ListProfileOptions | Database, maybeDb?: Database): ProfileInfo[] {
  const d = isDatabase(optsOrDb) ? optsOrDb : maybeDb || getDatabase();
  const opts = isDatabase(optsOrDb) ? undefined : optsOrDb;
  const page = pageFromOptions(opts, 50);
  const providers = listProviderSummaries(d, page);
  const providerIds = providers.map((provider) => provider.id);
  const domains = listDomainsByProviderIds(providerIds, d);
  const addresses = listAddressesByProviderIds(providerIds, d);
  const ownerIds = new Set<string>();
  for (const address of addresses) {
    if (address.owner_id) ownerIds.add(address.owner_id);
    if (address.administrator_id) ownerIds.add(address.administrator_id);
  }
  const aliases = listAliasesByTargets(addresses.map((address) => address.email), d);
  const keys = listSendKeySummariesByOwners(ownerIds, d);
  const ownerNames = listOwnerNamesByIds(ownerIds, d);
  const domainProvisioning = listDomainProvisioningByIds(domains.map((domain) => domain.id), d);
  const addressProvisioning = listAddressProvisioningByIds(addresses.map((address) => address.id), d);
  const sendsToday = sentTodayByAddresses(d, addresses.map((address) => address.email));
  const domainsByProvider = new Map<string, typeof domains>();
  const addressesByProvider = new Map<string, typeof addresses>();
  const aliasesByTarget = new Map<string, string[]>();
  const keysByOwner = new Map<string, ProfileSendKeyInfo[]>();

  for (const domain of domains) {
    const list = domainsByProvider.get(domain.provider_id) ?? [];
    list.push(domain);
    domainsByProvider.set(domain.provider_id, list);
  }

  for (const address of addresses) {
    const list = addressesByProvider.get(address.provider_id) ?? [];
    list.push(address);
    addressesByProvider.set(address.provider_id, list);
  }

  for (const alias of aliases) {
    const target = alias.target_address.toLowerCase();
    const list = aliasesByTarget.get(target) ?? [];
    list.push(alias.local_part === "*" ? `*@${alias.domain}` : `${alias.local_part}@${alias.domain}`);
    aliasesByTarget.set(target, list);
  }

  for (const key of keys) {
    const list = keysByOwner.get(key.owner_id) ?? [];
    list.push({
      id: key.id,
      owner: ownerNames.get(key.owner_id) ?? null,
      label: key.label,
      prefix: key.prefix,
      active: !key.revoked_at,
    });
    keysByOwner.set(key.owner_id, list);
  }

  return providers.map((p) => {
    const rawDomains = domainsByProvider.get(p.id) ?? [];
    const providerAddresses = addressesByProvider.get(p.id) ?? [];
    const readyAddressesByDomain = new Map<string, number>();
    for (const address of providerAddresses) {
      const provisioning = addressProvisioning.get(address.id);
      if (provisioning?.domain_id && provisioning.provisioning_status === "ready") {
        readyAddressesByDomain.set(provisioning.domain_id, (readyAddressesByDomain.get(provisioning.domain_id) ?? 0) + 1);
      }
    }
    const domain_details = rawDomains.map((domain) => {
      const ready_addresses = readyAddressesByDomain.get(domain.id) ?? 0;
      const provisioning = domainProvisioning.get(domain.id) ?? null;
      return {
        domain: domain.domain,
        readiness: assessDomainReadiness(domain, provisioning, { ready_addresses }),
        provisioning_status: provisioning?.provisioning_status ?? "none",
      };
    });
    const profileKeyIds = new Set<string>();
    const address_details = providerAddresses
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((address) => {
        const receive = addressProvisioning.get(address.id);
        const ownerIds = [address.owner_id, address.administrator_id].filter((id): id is string => !!id);
        const addressKeyMap = new Map<string, ProfileSendKeyInfo>();
        for (const ownerId of ownerIds) {
          for (const key of keysByOwner.get(ownerId) ?? []) addressKeyMap.set(key.id, key);
        }
        const addressKeys = [...addressKeyMap.values()];
        for (const key of addressKeys) profileKeyIds.add(key.id);
        return {
          email: address.email,
          verified: !!address.verified,
          status: address.status ?? "active",
          owner: address.owner_id ? ownerNames.get(address.owner_id) ?? null : null,
          administrator: address.administrator_id ? ownerNames.get(address.administrator_id) ?? null : null,
          receive_status: receive?.provisioning_status ?? "none",
          daily_quota: address.daily_quota ?? null,
          sent_today: sendsToday.get(address.email.toLowerCase()) ?? 0,
          aliases: aliasesByTarget.get(address.email.toLowerCase()) ?? [],
          send_keys: addressKeys,
        };
      });
    const send_keys = keys
      .filter((key) => profileKeyIds.has(key.id))
      .map((key) => ({
        id: key.id,
        owner: ownerNames.get(key.owner_id) ?? null,
        label: key.label,
        prefix: key.prefix,
        active: !key.revoked_at,
      }));
    return {
      id: p.id,
      name: p.name,
      provider: p.type,
      active: !!p.active,
      domains: domain_details.map((domain) => domain.domain),
      addresses: address_details.map((address) => address.email),
      domain_details,
      address_details,
      send_keys,
    };
  });
}
