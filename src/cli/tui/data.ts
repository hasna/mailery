/**
 * Data layer for the email UI (`emails ui`).
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
import { listDomains } from "../../db/domains.js";
import { listAddresses } from "../../db/addresses.js";
import { listAliases } from "../../db/aliases.js";
import { listSendKeys } from "../../db/send-keys.js";
import { getAddressProvisioning, getDomainProvisioning } from "../../db/provisioning.js";
import { sendWithFailover } from "../../lib/send.js";
import { countSendsToday } from "../../db/address-lifecycle.js";
import { loadConfig, saveConfig } from "../../lib/config.js";
import { assessDomainReadiness, type DomainReadiness } from "../../lib/domain-readiness.js";
import { listEnrichedAddresses } from "../../lib/address-ownership.js";
import { marked } from "marked";
import { normalizeThemeMode, type TuiThemeMode } from "./theme.js";

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
export interface MailboxSource { providerId?: string; domain?: string; address?: string }

interface SqlClause { sql: string; params: string[] }

function recipientAddressSql(): string {
  return "(LOWER(TRIM(value)) = ? OR LOWER(value) LIKE ?)";
}

function recipientDomainSql(): string {
  return "(LOWER(TRIM(value)) LIKE ? OR LOWER(value) LIKE ?)";
}

function recipientSourceClause(src?: MailboxSource): SqlClause {
  const params: string[] = [];
  let sql = "";
  if (src?.providerId) { sql += " AND provider_id = ?"; params.push(src.providerId); }
  if (src?.address) {
    const address = src.address.toLowerCase();
    sql += ` AND (json_valid(to_addresses) AND EXISTS (SELECT 1 FROM json_each(to_addresses) WHERE ${recipientAddressSql()}))`;
    params.push(address, `%<${address}>%`);
  }
  if (src?.domain) {
    const domain = src.domain.toLowerCase();
    sql += ` AND (json_valid(to_addresses) AND EXISTS (SELECT 1 FROM json_each(to_addresses) WHERE ${recipientDomainSql()}))`;
    params.push(`%@${domain}`, `%<%@${domain}>%`);
  }
  return { sql, params };
}

function senderSourceClause(src?: MailboxSource): SqlClause {
  const params: string[] = [];
  let sql = "";
  if (src?.providerId) { sql += " AND provider_id = ?"; params.push(src.providerId); }
  if (src?.address) { sql += " AND LOWER(from_address) = ?"; params.push(src.address.toLowerCase()); }
  if (src?.domain) { sql += " AND LOWER(from_address) LIKE ?"; params.push(`%@${src.domain.toLowerCase()}`); }
  return { sql, params };
}

function appSentSourceClause(src?: MailboxSource): SqlClause {
  const params: string[] = [];
  const where: string[] = [];
  if (src?.providerId) { where.push("e.provider_id = ?"); params.push(src.providerId); }
  if (src?.address) { where.push("LOWER(e.from_address) = ?"); params.push(src.address.toLowerCase()); }
  if (src?.domain) { where.push("LOWER(e.from_address) LIKE ?"); params.push(`%@${src.domain.toLowerCase()}`); }
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
  const limit = Math.max(1, Math.trunc(opts?.limit ?? 200));
  const offset = Math.max(0, Math.trunc(opts?.offset ?? 0));
  const fetchLimit = limit + offset;
  const order = opts?.sort === "oldest" ? "ASC" : "DESC";
  let messages: TuiMessage[];

  const src = opts?.source;
  const recipientSrc = recipientSourceClause(src);

  if (mailbox === "sent") {
    const appSrc = appSentSourceClause(src);
    const senderSrc = senderSourceClause(src);
    const appSent = (d.query(
      `SELECT e.id, e.from_address, e.to_addresses, e.subject, e.sent_at AS date, e.thread_id,
              e.attachment_count AS attachments, substr(c.text_body, 1, 140) AS snippet
       FROM emails e LEFT JOIN email_content c ON c.email_id = e.id${appSrc.sql}
       ORDER BY e.sent_at ${order} LIMIT ?`,
    ).all(...appSrc.params, fetchLimit) as LiteRow[]).map((r) => liteToMessage(r, "sent"));
    const gmailSent = (d.query(
      `SELECT ${INBOUND_LITE_COLS} FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0${senderSrc.sql}
       ORDER BY received_at ${order} LIMIT ?`,
    ).all(...senderSrc.params, fetchLimit) as LiteRow[]).map((r) => liteToMessage(r, "inbound"));
    messages = [...appSent, ...gmailSent].sort((a, b) => order === "DESC" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date));
  } else {
    const rows = d.query(
      `SELECT ${INBOUND_LITE_COLS} FROM inbound_emails WHERE ${FOLDER_WHERE[mailbox]}${recipientSrc.sql} ORDER BY received_at ${order} LIMIT ?`,
    ).all(...recipientSrc.params, fetchLimit) as LiteRow[];
    messages = rows.map((r) => liteToMessage(r, "inbound"));
  }

  if (opts?.search) {
    const q = opts.search.toLowerCase();
    messages = messages.filter((m) =>
      m.subject.toLowerCase().includes(q) || m.from.toLowerCase().includes(q) || m.snippet.toLowerCase().includes(q));
  }
  return messages.slice(offset, offset + limit);
}

export interface MailboxCounts { inbox: number; unread: number; starred: number; sent: number; archived: number }

function count(d: Database, sql: string, params: string[] = []): number {
  const row = d.query(sql).get(...params) as { c: number } | null;
  return row?.c ?? 0;
}

/** Folder counts via COUNT(*) over indexed columns — never materialize rows. */
export function mailboxCounts(db?: Database): MailboxCounts;
export function mailboxCounts(opts?: { source?: MailboxSource }, db?: Database): MailboxCounts;
export function mailboxCounts(optsOrDb?: Database | { source?: MailboxSource }, maybeDb?: Database): MailboxCounts {
  const isDb = typeof (optsOrDb as { query?: unknown } | undefined)?.query === "function";
  const d = (isDb ? optsOrDb as Database : maybeDb) || getDatabase();
  const opts = isDb ? undefined : optsOrDb as { source?: MailboxSource } | undefined;
  const recipientSrc = recipientSourceClause(opts?.source);
  const senderSrc = senderSourceClause(opts?.source);
  const appSrc = appSentSourceClause(opts?.source);
  return {
    inbox: count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE ${FOLDER_WHERE.inbox}${recipientSrc.sql}`, recipientSrc.params),
    unread: count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE ${FOLDER_WHERE.unread}${recipientSrc.sql}`, recipientSrc.params),
    starred: count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE ${FOLDER_WHERE.starred}${recipientSrc.sql}`, recipientSrc.params),
    sent: count(d, `SELECT COUNT(*) AS c FROM emails e${appSrc.sql}`, appSrc.params) + count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0${senderSrc.sql}`, senderSrc.params),
    archived: count(d, `SELECT COUNT(*) AS c FROM inbound_emails WHERE ${FOLDER_WHERE.archived}${recipientSrc.sql}`, recipientSrc.params),
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

export function providerIdForSender(address: string, db?: Database): string | null {
  const d = db || getDatabase();
  const normalized = extractEmail(address);
  if (!normalized) return null;
  const matches = listAddresses(undefined, d)
    .filter((a) => (a.status ?? "active") === "active" && a.email.toLowerCase() === normalized);
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
  const all = listAddresses(opts?.source?.providerId, d).filter((a) => (a.status ?? "active") === "active");
  const pick = (addresses: typeof all) => addresses.find((a) => a.verified)?.email ?? addresses[0]?.email ?? "";
  const domain = opts?.source?.domain?.toLowerCase();
  if (domain) {
    const domainSender = pick(all.filter((a) => a.email.toLowerCase().endsWith(`@${domain}`)));
    if (domainSender) return domainSender;
    if (opts?.fallback) return opts.fallback;
  }
  return pick(all) || opts?.fallback || "";
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
  label: "All addresses",
  configured: false,
  observed: false,
};

function extractEmail(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  const bracketed = raw.match(/<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>/);
  const email = bracketed?.[1] ?? raw;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function upsertAddressChoice(
  map: Map<string, InboxAddressChoice>,
  address: string,
  patch: Partial<Pick<InboxAddressChoice, "configured" | "observed">>,
): void {
  const existing = map.get(address) ?? { id: `a:${address}`, label: address, address, configured: false, observed: false };
  map.set(address, { ...existing, ...patch });
}

/**
 * User-facing inbox choices. The normal TUI exposes only "All addresses" or a
 * concrete email address; providers/domains stay in Profiles/diagnostics.
 */
export function listInboxAddresses(db?: Database): InboxAddressChoice[] {
  const d = db || getDatabase();
  const byAddress = new Map<string, InboxAddressChoice>();

  for (const row of listAddresses(undefined, d).filter((a) => (a.status ?? "active") === "active")) {
    const address = extractEmail(row.email);
    if (address) upsertAddressChoice(byAddress, address, { configured: true });
  }

  const inboundRecipients = d.query(
    `SELECT DISTINCT LOWER(j.value) AS email
     FROM inbound_emails e, json_each(CASE WHEN json_valid(e.to_addresses) THEN e.to_addresses ELSE '[]' END) j
     WHERE e.is_sent = 0 AND j.value LIKE '%@%'`,
  ).all() as { email: string }[];
  for (const row of inboundRecipients) {
    const address = extractEmail(row.email);
    if (address) upsertAddressChoice(byAddress, address, { observed: true });
  }

  const choices = [...byAddress.values()].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return [ALL_ADDRESSES, ...choices];
}

export function addressChoiceByAddress(address: string | null | undefined, db?: Database): InboxAddressChoice {
  const normalized = extractEmail(address);
  if (!normalized) return ALL_ADDRESSES;
  return listInboxAddresses(db).find((choice) => choice.address === normalized) ?? {
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
  for (const p of listProviders(d).filter((p) => p.active)) out.push({ id: `p:${p.id}`, label: p.name, providerId: p.id });
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
    defaultMailbox: (c["default_mailbox"] as Mailbox) ?? "inbox",
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
export function listProfiles(db?: Database): ProfileInfo[] {
  const d = db || getDatabase();
  const aliases = listAliases(undefined, d);
  const keys = listSendKeys(undefined, d);
  const ownerNames = new Map((d.query("SELECT id, name FROM owners").all() as { id: string; name: string }[]).map((owner) => [owner.id, owner.name]));

  return listProviders(d).map((p) => {
    const rawDomains = listDomains(p.id, d);
    const enrichedAddresses = listEnrichedAddresses(p.id, d);
    const domain_details = rawDomains.map((domain) => {
      const ready_addresses = enrichedAddresses.filter((address) => {
        const provisioning = getAddressProvisioning(address.id, d);
        return provisioning?.domain_id === domain.id && provisioning.provisioning_status === "ready";
      }).length;
      const provisioning = getDomainProvisioning(domain.id, d);
      return {
        domain: domain.domain,
        readiness: assessDomainReadiness(domain, provisioning, { ready_addresses }),
        provisioning_status: provisioning?.provisioning_status ?? "none",
      };
    });
    const address_details = enrichedAddresses
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((address) => {
        const receive = getAddressProvisioning(address.id, d);
        const ownerIds = [address.owner?.id, address.administrator?.id].filter((id): id is string => !!id);
        const addressKeys = keys.filter((key) => ownerIds.includes(key.owner_id)).map((key) => ({
          id: key.id,
          owner: ownerNames.get(key.owner_id) ?? null,
          label: key.label,
          prefix: key.prefix,
          active: !key.revoked_at,
        }));
        return {
          email: address.email,
          verified: !!address.verified,
          status: address.status ?? "active",
          owner: address.owner?.name ?? null,
          administrator: address.administrator?.name ?? null,
          receive_status: receive?.provisioning_status ?? "none",
          daily_quota: address.daily_quota ?? null,
          sent_today: countSendsToday(address.email, d),
          aliases: aliases
            .filter((alias) => alias.target_address === address.email.toLowerCase())
            .map((alias) => alias.local_part === "*" ? `*@${alias.domain}` : `${alias.local_part}@${alias.domain}`),
          send_keys: addressKeys,
        };
      });
    const send_keys = keys
      .filter((key) => address_details.some((address) => address.send_keys.some((addressKey) => addressKey.id === key.id)))
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
