/**
 * Data layer for the Emails UI (`emails ui`).
 *
 * Presents a unified mail view over the local store. Providers are
 * credentials/capabilities, sources are ingestion streams, mailboxes are
 * user-visible scopes, and folders are inbox/unread/sent/etc.
 */
import type { Database } from "../../db/database.js";
import { getDatabase, resolvePartialIdOrThrow, uuid } from "../../db/database.js";
import { sqlEmailAddress, sqlEmailDomain } from "../../db/email-address-sql.js";
import { parseJsonArray } from "../../db/json.js";
import { countValue } from "../../db/scalars.js";
import {
  getReceivedInboundCount,
  getLatestReceivedInboundAt,
  setInboundReadFlag, setInboundArchivedFlag, setInboundStarredFlag,
  addInboundLabelSummary, removeInboundLabelSummary,
  getInboundEmail,
} from "../../db/inbound.js";
import { getEmail } from "../../db/emails.js";
import { getEmailContent } from "../../db/email-content.js";
import { getEmailThreading, getThreadMessages, setInboundThreadId } from "../../db/threads.js";
import { getLatestActiveProviderId, listProviderSummaries, listProviderNamesByIds } from "../../db/providers.js";
import { listDomains } from "../../db/domains.js";
import { findAddressesByEmail, getPreferredActiveAddressEmail, listActiveAddressCountsByDomains } from "../../db/addresses.js";
import { listAddressProvisioningByIds, listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../../db/provisioning.js";
import { getInboundBuckets, loadConfig, saveConfig } from "../../lib/config.js";
import { assessDomainReadiness } from "../../lib/domain-readiness.js";
import { domainInboundReadinessSignals } from "../../lib/domain-inbound-evidence.js";
import { resolveEmailsMode } from "../../lib/mode.js";
import { listS3Sources } from "../../lib/s3-sync.js";
import { createSentEmailLedger, setSentEmailThreading, storeSentEmailContent } from "../../lib/sent-ledger.js";
import { buildThreadingHeaders, generateMessageId, parseReferences } from "../../lib/threading.js";
import { marked } from "marked";
import { normalizeThemeMode, type TuiThemeMode } from "./theme.js";

export type Folder = "inbox" | "unread" | "starred" | "sent" | "archived" | "spam" | "trash";
export type Mailbox = Folder;

export const FOLDERS: Folder[] = ["inbox", "unread", "starred", "sent", "archived", "spam", "trash"];
export const MAILBOXES: Mailbox[] = FOLDERS;

export function mailboxLabel(m: Mailbox): string {
  return {
    inbox: "Inbox",
    unread: "Unread",
    starred: "Starred",
    sent: "Sent",
    archived: "Archived",
    spam: "Spam",
    trash: "Trash",
  }[normalizeMailbox(m)];
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
  provider_thread_id: string | null;
  attachments: number;
  /** True if I sent it (app-sent, or imported mail labelled SENT). */
  sentByMe: boolean;
}

export interface TuiThreadMessage {
  kind: "sent" | "received";
  storage: "email" | "inbound";
  id: string;
  from: string;
  subject: string;
  at: string;
}

export interface TuiThreadBody {
  item: TuiThreadMessage;
  body: MessageBody | null;
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
  is_read?: number; is_starred?: number; label_ids_json?: string | null; thread_id?: string | null; provider_thread_id?: string | null; snippet?: string | null;
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
    labels, snippet: snippetOf(r.snippet), thread_id: r.thread_id ?? null, provider_thread_id: r.provider_thread_id ?? null,
    attachments: r.attachments ?? 0,
    sentByMe: kind === "sent" || labels.some((label) => label.trim().toLowerCase() === "sent"),
  };
}

// Lean inbound projection columns (no html_body). Reused across folder queries.
const INBOUND_LITE_COLS = `id, from_address, to_addresses, subject, received_at AS date,
  is_read, is_starred, label_ids_json, thread_id, provider_thread_id, substr(text_body, 1, 140) AS snippet,
  (CASE WHEN attachments_json IS NULL OR attachments_json = '[]' THEN 0
        ELSE (LENGTH(attachments_json) - LENGTH(REPLACE(attachments_json, '"filename"', ''))) / LENGTH('"filename"') END) AS attachments`;
const MAILBOX_UNION_COLS = "kind, id, from_address, to_addresses, subject, date, is_read, is_starred, label_ids_json, thread_id, provider_thread_id, snippet, attachments";

// The receiving folders use denormalized, indexed flags so the UI never scans
// label_ids_json on large stores.
const SPAM_LABEL_SQL = "is_spam = 1";
const TRASH_LABEL_SQL = "is_trash = 1";
const NOT_SPAM_OR_TRASH_SQL = "is_spam = 0 AND is_trash = 0";

const FOLDER_WHERE: Record<Exclude<Mailbox, "sent">, string> = {
  inbox: `is_sent = 0 AND is_archived = 0 AND ${NOT_SPAM_OR_TRASH_SQL}`,
  unread: `is_sent = 0 AND is_read = 0 AND is_archived = 0 AND ${NOT_SPAM_OR_TRASH_SQL}`,
  starred: `is_sent = 0 AND is_starred = 1 AND is_archived = 0 AND ${NOT_SPAM_OR_TRASH_SQL}`,
  archived: `is_sent = 0 AND is_archived = 1 AND ${NOT_SPAM_OR_TRASH_SQL}`,
  spam: `is_sent = 0 AND ${SPAM_LABEL_SQL}`,
  trash: `is_sent = 0 AND ${TRASH_LABEL_SQL}`,
};

/**
 * List the messages in a folder, newest first. Uses a LEAN projection
 * (no html_body, snippet via substr) over indexed columns so it stays fast on
 * very large mailboxes. The Sent folder unions app-sent mail (`emails`) with
 * Imported sent mail (`inbound_emails` where is_sent = 1).
 */
export interface MailboxSource {
  /** Source ID from listMailboxSources(), e.g. provider:<id>, s3:<bucket>, legacy, orphaned:<id>. */
  sourceId?: string;
  /** Credential/capability backing the ingestion stream. Kept as a storage filter, not a mailbox label. */
  providerId?: string;
  /** User-visible mailbox scope. */
  domain?: string;
  /** User-visible mailbox scope. */
  address?: string;
  /** S3 ingestion stream bucket. */
  s3Bucket?: string;
  /** Registered S3 source prefix. Undefined means the whole bucket is the filter boundary. */
  s3Prefix?: string;
  /** Legacy/local mail with no provider/capability provenance. */
  legacy?: boolean;
  /** Unknown source ID that should match no mail. */
  unknown?: boolean;
}

interface SqlClause { sql: string; params: string[] }

function addressDomainParams(domain: string): [string] {
  return [domain.toLowerCase()];
}

function addressDomainSql(column: string): string {
  return `${sqlEmailDomain(column)} = ?`;
}

function normalizeSourceId(value: string | undefined): MailboxSource {
  const raw = value?.trim();
  if (!raw || raw === "all") return {};
  if (raw === "legacy") return { sourceId: "legacy", legacy: true };
  if (raw.startsWith("provider:")) return { sourceId: raw, providerId: raw.slice("provider:".length) };
  if (raw.startsWith("orphaned:")) return { sourceId: raw, providerId: raw.slice("orphaned:".length) };
  if (raw.startsWith("s3:")) {
    const bucket = decodeURIComponent(raw.slice("s3:".length));
    const configured = getInboundBuckets().find((candidate) => candidate.bucket === bucket);
    return { sourceId: raw, s3Bucket: bucket, providerId: configured?.providerId };
  }
  const s3Source = listS3Sources().find((candidate) => candidate.id === raw);
  if (s3Source) {
    return { sourceId: raw, s3Bucket: s3Source.bucket, s3Prefix: s3Source.prefix, providerId: s3Source.provider_id };
  }
  return { sourceId: raw, unknown: true };
}

export function mailboxSourceFromRef(input?: MailboxSource): MailboxSource | undefined {
  if (!input) return undefined;
  const fromId = normalizeSourceId(input.sourceId);
  const normalized: MailboxSource = {
    ...fromId,
    ...input,
    providerId: input.providerId ?? fromId.providerId,
    s3Bucket: input.s3Bucket ?? fromId.s3Bucket,
    s3Prefix: input.s3Prefix ?? fromId.s3Prefix,
    legacy: input.legacy ?? fromId.legacy,
  };
  if (!hasSourceFilter(normalized)) return undefined;
  return normalized;
}

function normalizeS3PrefixForFilter(prefix: string | null | undefined): string | undefined {
  const value = String(prefix ?? "").trim().replace(/^\/+/, "");
  return value.length > 0 ? value : undefined;
}

function s3ObjectUrlLike(bucket: string, prefix: string | null | undefined): string {
  const normalizedPrefix = normalizeS3PrefixForFilter(prefix);
  return normalizedPrefix ? `s3://${bucket}/${normalizedPrefix}%` : `s3://${bucket}/%`;
}

function inboundSourceClause(src?: MailboxSource): SqlClause {
  const normalized = mailboxSourceFromRef(src);
  const params: string[] = [];
  let sql = "";
  if (normalized?.unknown) sql += " AND 0 = 1";
  if (normalized?.providerId) { sql += " AND provider_id = ?"; params.push(normalized.providerId); }
  if (normalized?.legacy) sql += " AND provider_id IS NULL";
  if (normalized?.s3Bucket) {
    const urlPattern = s3ObjectUrlLike(normalized.s3Bucket, normalized.s3Prefix);
    const prefix = normalizeS3PrefixForFilter(normalized.s3Prefix);
    if (prefix && normalized.providerId) {
      sql += ` AND (raw_s3_url LIKE ? OR (
        (raw_s3_url IS NULL OR raw_s3_url = '')
        AND message_id IS NOT NULL
        AND message_id != ''
        AND (message_id LIKE ? OR message_id LIKE ?)
      ))`;
      params.push(urlPattern, `s3://${normalized.s3Bucket}/${prefix}%`, `${prefix}%`);
    } else if (normalized.providerId) {
      sql += ` AND (raw_s3_url LIKE ? OR (
        (raw_s3_url IS NULL OR raw_s3_url = '')
        AND message_id IS NOT NULL
        AND message_id != ''
        AND message_id NOT LIKE 's3://%'
      ))`;
      params.push(urlPattern);
    } else {
      sql += " AND raw_s3_url LIKE ?";
      params.push(urlPattern);
    }
  }
  return { sql, params };
}

function appSourceClause(src?: MailboxSource): SqlClause {
  const normalized = mailboxSourceFromRef(src);
  const params: string[] = [];
  const where: string[] = [];
  if (normalized?.unknown) where.push("0 = 1");
  if (normalized?.s3Bucket) where.push("0 = 1");
  if (normalized?.providerId) { where.push("e.provider_id = ?"); params.push(normalized.providerId); }
  if (normalized?.legacy) where.push("e.provider_id IS NULL");
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

function recipientSourceClause(src?: MailboxSource): SqlClause {
  const params: string[] = [];
  const normalized = mailboxSourceFromRef(src);
  const sourceOnly = inboundSourceClause(normalized);
  let sql = sourceOnly.sql;
  params.push(...sourceOnly.params);
  if (normalized?.address) {
    const address = normalized.address.toLowerCase();
    sql += ` AND inbound_emails.id IN (
      SELECT recipient.inbound_email_id
        FROM inbound_recipients recipient
       WHERE recipient.address = ?
    )`;
    params.push(address);
  }
  if (normalized?.domain) {
    sql += ` AND inbound_emails.id IN (
      SELECT recipient.inbound_email_id
        FROM inbound_recipients recipient
       WHERE recipient.domain = ?
    )`;
    params.push(normalized.domain.toLowerCase());
  }
  return { sql, params };
}

function senderSourceClause(src?: MailboxSource): SqlClause {
  const params: string[] = [];
  const normalized = mailboxSourceFromRef(src);
  const sourceOnly = inboundSourceClause(normalized);
  let sql = sourceOnly.sql;
  params.push(...sourceOnly.params);
  if (normalized?.address) { sql += ` AND ${sqlEmailAddress("from_address")} = ?`; params.push(normalized.address.toLowerCase()); }
  if (normalized?.domain) { sql += ` AND ${addressDomainSql("from_address")}`; params.push(...addressDomainParams(normalized.domain)); }
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

function labelClause(label: string | undefined): SqlClause {
  const aliases = labelNameAliases(label ?? "");
  if (aliases.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND EXISTS (
      SELECT 1
        FROM inbound_labels label
       WHERE label.inbound_email_id = inbound_emails.id
         AND label.label IN (${aliases.map(() => "?").join(", ")})
    )`,
    params: aliases,
  };
}

function appSentSourceClause(src?: MailboxSource, search?: string, includeAppSent = true): SqlClause {
  const normalized = mailboxSourceFromRef(src);
  const params: string[] = [];
  const where: string[] = [];
  if (!includeAppSent) where.push("0 = 1");
  if (normalized?.s3Bucket) where.push("0 = 1");
  if (normalized?.providerId) { where.push("e.provider_id = ?"); params.push(normalized.providerId); }
  if (normalized?.legacy) where.push("e.provider_id IS NULL");
  if (normalized?.address) { where.push(`${sqlEmailAddress("e.from_address")} = ?`); params.push(normalized.address.toLowerCase()); }
  if (normalized?.domain) { where.push(addressDomainSql("e.from_address")); params.push(...addressDomainParams(normalized.domain)); }
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
  label?: string;
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
    const appSrc = appSentSourceClause(src, opts?.search, !opts?.label);
    const senderSrc = senderSourceClause(src);
    const sentSearch = searchClause(opts?.search, ["subject", "from_address", "to_addresses", "text_body"]);
    const sentLabel = labelClause(opts?.label);
    const branchLimit = limit + offset;
    const rows = d.query(
      `WITH app_sent AS (
         SELECT 'sent' AS kind, e.id, e.from_address, e.to_addresses, e.subject, e.sent_at AS date,
                1 AS is_read, 0 AS is_starred, '[]' AS label_ids_json, e.thread_id, NULL AS provider_thread_id,
                substr(c.text_body, 1, 140) AS snippet, e.attachment_count AS attachments
         FROM emails e LEFT JOIN email_content c ON c.email_id = e.id${appSrc.sql}
         ORDER BY e.sent_at ${order}
         LIMIT ?
       ),
       synced_sent AS (
         SELECT 'inbound' AS kind, id, from_address, to_addresses, subject, received_at AS date,
                is_read, is_starred, label_ids_json, thread_id, provider_thread_id, substr(text_body, 1, 140) AS snippet,
                (CASE WHEN attachments_json IS NULL OR attachments_json = '[]' THEN 0
                      ELSE (LENGTH(attachments_json) - LENGTH(REPLACE(attachments_json, '"filename"', ''))) / LENGTH('"filename"') END) AS attachments
         FROM inbound_emails WHERE is_sent = 1${senderSrc.sql}${sentSearch.sql}${sentLabel.sql}
         ORDER BY received_at ${order}
         LIMIT ?
       )
       SELECT ${MAILBOX_UNION_COLS} FROM (
         SELECT ${MAILBOX_UNION_COLS} FROM app_sent
         UNION ALL
         SELECT ${MAILBOX_UNION_COLS} FROM synced_sent
       ) ORDER BY date ${order} LIMIT ? OFFSET ?`,
    ).all(...appSrc.params, branchLimit, ...senderSrc.params, ...sentSearch.params, ...sentLabel.params, branchLimit, limit, offset) as MailboxUnionRow[];
    messages = rows.map((r) => liteToMessage(r, r.kind));
  } else {
    const inboundLabel = labelClause(opts?.label);
    const rows = d.query(
      `SELECT ${INBOUND_LITE_COLS} FROM inbound_emails WHERE ${FOLDER_WHERE[selectedMailbox]}${recipientSrc.sql}${inboundSearch.sql}${inboundLabel.sql} ORDER BY received_at ${order} LIMIT ? OFFSET ?`,
    ).all(...recipientSrc.params, ...inboundSearch.params, ...inboundLabel.params, limit, offset) as LiteRow[];
    messages = rows.map((r) => liteToMessage(r, "inbound"));
  }

  return messages;
}

export interface MailboxCounts {
  inbox: number;
  unread: number;
  starred: number;
  sent: number;
  archived: number;
  spam: number;
  trash: number;
}

function hasSourceFilter(source: MailboxSource | undefined): boolean {
  return !!(source?.sourceId || source?.providerId || source?.domain || source?.address || source?.s3Bucket || source?.s3Prefix || source?.legacy || source?.unknown);
}

function unscopedMailboxCounts(db: Database): MailboxCounts {
  const row = db.query(
    `SELECT
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.inbox}) AS inbox,
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.unread}) AS unread,
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.starred}) AS starred,
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.archived}) AS archived,
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.spam}) AS spam,
       (SELECT COUNT(*) FROM inbound_emails WHERE ${FOLDER_WHERE.trash}) AS trash,
       (SELECT COUNT(*) FROM emails) +
       (SELECT COUNT(*) FROM inbound_emails WHERE is_sent = 1) AS sent`,
  ).get() as Partial<Record<keyof MailboxCounts, unknown>> | null;
  return {
    inbox: countValue(row?.inbox),
    unread: countValue(row?.unread),
    starred: countValue(row?.starred),
    sent: countValue(row?.sent),
    archived: countValue(row?.archived),
    spam: countValue(row?.spam),
    trash: countValue(row?.trash),
  };
}

/** Folder counts without materializing mailbox rows. */
export function mailboxCounts(db?: Database): MailboxCounts;
export function mailboxCounts(opts?: { source?: MailboxSource }, db?: Database): MailboxCounts;
export function mailboxCounts(optsOrDb?: Database | { source?: MailboxSource }, maybeDb?: Database): MailboxCounts {
  const isDb = typeof (optsOrDb as { query?: unknown } | undefined)?.query === "function";
  const d = (isDb ? optsOrDb as Database : maybeDb) || getDatabase();
  const opts = isDb ? undefined : optsOrDb as { source?: MailboxSource } | undefined;
  const source = mailboxSourceFromRef(opts?.source);
  if (!hasSourceFilter(source)) return unscopedMailboxCounts(d);

  const recipientSrc = recipientSourceClause(source);
  const senderSrc = senderSourceClause(source);
  const appSrc = appSentSourceClause(source);
  const row = d.query(
    `SELECT
       COALESCE(inbound.inbox, 0) AS inbox,
       COALESCE(inbound.unread, 0) AS unread,
       COALESCE(inbound.starred, 0) AS starred,
       COALESCE(inbound.archived, 0) AS archived,
       COALESCE(inbound.spam, 0) AS spam,
       COALESCE(inbound.trash, 0) AS trash,
       (SELECT COUNT(*) FROM emails e${appSrc.sql}) +
       (SELECT COUNT(*) FROM inbound_emails WHERE is_sent = 1${senderSrc.sql}) AS sent
     FROM (
       SELECT
         SUM(CASE WHEN ${FOLDER_WHERE.inbox} THEN 1 ELSE 0 END) AS inbox,
         SUM(CASE WHEN ${FOLDER_WHERE.unread} THEN 1 ELSE 0 END) AS unread,
         SUM(CASE WHEN ${FOLDER_WHERE.starred} THEN 1 ELSE 0 END) AS starred,
         SUM(CASE WHEN ${FOLDER_WHERE.archived} THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN ${FOLDER_WHERE.spam} THEN 1 ELSE 0 END) AS spam,
         SUM(CASE WHEN ${FOLDER_WHERE.trash} THEN 1 ELSE 0 END) AS trash
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
    spam: countValue(row?.spam),
    trash: countValue(row?.trash),
  };
}

export interface MailboxFolderStatus {
  id: Mailbox;
  folder: Mailbox;
  label: string;
  count: number;
}

export interface MailboxStatusSummary {
  counts: MailboxCounts;
  folders: MailboxFolderStatus[];
}

export interface MailboxStatusOptions {
  source?: MailboxSource;
}

export function listMailboxStatus(opts?: MailboxStatusOptions, db?: Database): MailboxStatusSummary {
  const d = db || getDatabase();
  const counts = mailboxCounts({ source: opts?.source }, d);
  return {
    counts,
    folders: MAILBOXES.map((folder) => ({
      id: folder,
      folder,
      label: mailboxLabel(folder),
      count: counts[folder],
    })),
  };
}

export function searchMailbox(query: string, opts?: Omit<MailboxListOptions, "search"> & { mailbox?: Mailbox }, db?: Database): TuiMessage[] {
  return listMailbox(opts?.mailbox ?? "inbox", { ...opts, search: query }, db);
}

export type MailboxSourceKind = "all" | "s3" | "provider" | "legacy" | "orphaned";

export interface MailboxSourceSummary {
  id: string;
  label: string;
  kind: MailboxSourceKind;
  providerId?: string;
  providerName?: string;
  providerType?: string;
  bucket?: string;
  s3Prefix?: string;
  region?: string;
  badges: string[];
  counts: MailboxCounts;
  total: number;
  unread: number;
  latestReceivedAt: string | null;
}

export interface ListMailboxSourcesOptions {
  limit?: number;
  search?: string;
  /**
   * Include each source's latest-received timestamp. In self_hosted mode this costs an
   * extra HTTP round-trip PER source, so the status path (which only shows the
   * aggregate latest) passes `false` to avoid the N+1 timeout. Defaults to true.
   */
  includeLatest?: boolean;
}

export function providerSourceId(providerId: string): string {
  return `provider:${providerId}`;
}

export function orphanedSourceId(providerId: string): string {
  return `orphaned:${providerId}`;
}

export function s3SourceId(bucket: string): string {
  return `s3:${encodeURIComponent(bucket)}`;
}

function countColumn(row: { count?: unknown } | null): number {
  return countValue(row?.count);
}

function sourceMessageCount(source: MailboxSource | undefined, db: Database): number {
  const normalized = mailboxSourceFromRef(source);
  const inbound = inboundSourceClause(normalized);
  const app = appSourceClause(normalized);
  const inboundRow = db
    .query(`SELECT COUNT(*) AS count FROM inbound_emails WHERE 1 = 1${inbound.sql}`)
    .get(...inbound.params) as { count: unknown } | null;
  const appRow = db
    .query(`SELECT COUNT(*) AS count FROM emails e${app.sql}`)
    .get(...app.params) as { count: unknown } | null;
  return countColumn(inboundRow) + countColumn(appRow);
}

function latestReceivedAtForSource(source: MailboxSource | undefined, db: Database): string | null {
  const normalized = mailboxSourceFromRef(source);
  const inbound = inboundSourceClause(normalized);
  const row = db
    .query(`SELECT MAX(received_at) AS latest FROM inbound_emails WHERE is_sent = 0${inbound.sql}`)
    .get(...inbound.params) as { latest: string | null } | null;
  return row?.latest ?? null;
}

function sourceSummary(input: Omit<MailboxSourceSummary, "counts" | "total" | "unread" | "latestReceivedAt">, source: MailboxSource | undefined, db: Database): MailboxSourceSummary {
  const counts = mailboxCounts({ source }, db);
  return {
    ...input,
    counts,
    total: sourceMessageCount(source, db),
    unread: counts.unread,
    latestReceivedAt: latestReceivedAtForSource(source, db),
  };
}

function providerIdsWithStoredMail(db: Database): Set<string> {
  const rows = db.query(
    `SELECT provider_id FROM inbound_emails WHERE provider_id IS NOT NULL
     UNION
     SELECT provider_id FROM emails WHERE provider_id IS NOT NULL`,
  ).all() as Array<{ provider_id: string }>;
  return new Set(rows.map((row) => row.provider_id));
}

function orphanedProviderIds(db: Database): string[] {
  const rows = db.query(
    `SELECT DISTINCT mail.provider_id
       FROM (
         SELECT provider_id FROM inbound_emails WHERE provider_id IS NOT NULL
         UNION
         SELECT provider_id FROM emails WHERE provider_id IS NOT NULL
       ) mail
       LEFT JOIN providers p ON p.id = mail.provider_id
      WHERE p.id IS NULL
      ORDER BY mail.provider_id`,
  ).all() as Array<{ provider_id: string }>;
  return rows.map((row) => row.provider_id);
}

export function listMailboxSources(db?: Database): MailboxSourceSummary[];
export function listMailboxSources(opts?: ListMailboxSourcesOptions, db?: Database): MailboxSourceSummary[];
export function listMailboxSources(optsOrDb?: ListMailboxSourcesOptions | Database, maybeDb?: Database): MailboxSourceSummary[] {
  const d = isDatabase(optsOrDb) ? optsOrDb : maybeDb || getDatabase();
  const opts = isDatabase(optsOrDb) ? undefined : optsOrDb;
  const inboundBuckets = getInboundBuckets();
  const s3Sources = listS3Sources();
  const sources: MailboxSourceSummary[] = [
    sourceSummary({
      id: "all",
      label: "All sources",
      kind: "all",
      badges: [],
    }, undefined, d),
  ];

  const idsWithMail = providerIdsWithStoredMail(d);
  for (const provider of listProviderSummaries(d)) {
    const hasStoredMail = idsWithMail.has(provider.id);
    if (!provider.active && !hasStoredMail) continue;
    const id = providerSourceId(provider.id);
    sources.push(sourceSummary({
      id,
      label: `Provider-tagged stream: ${provider.name}`,
      kind: "provider",
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.type,
      badges: [
        provider.active ? "active" : "inactive",
        `capability:${provider.type}`,
        ...(hasStoredMail ? [] : ["empty"]),
      ],
    }, { sourceId: id }, d));
  }

  const bucketsWithExplicitSources = new Set(s3Sources.map((source) => source.bucket));
  for (const bucket of inboundBuckets) {
    if (bucketsWithExplicitSources.has(bucket.bucket)) continue;
    const id = s3SourceId(bucket.bucket);
    sources.push(sourceSummary({
      id,
      label: `S3 ingestion: ${bucket.bucket}`,
      kind: "s3",
      providerId: bucket.providerId,
      bucket: bucket.bucket,
      region: bucket.region,
      badges: ["configured", ...(bucket.providerId ? [] : ["legacy"])],
    }, { sourceId: id, providerId: bucket.providerId }, d));
  }

  const listedS3Ids = new Set(inboundBuckets.map((bucket) => s3SourceId(bucket.bucket)));
  for (const source of s3Sources) {
    const id = source.id;
    if (listedS3Ids.has(id)) continue;
    listedS3Ids.add(id);
    sources.push(sourceSummary({
      id,
      label: `S3 ingestion: ${source.bucket}${source.prefix ? `/${source.prefix}` : ""}`,
      kind: "s3",
      providerId: source.provider_id,
      bucket: source.bucket,
      s3Prefix: source.prefix,
      region: source.region,
      badges: [source.status, source.live_sync_enabled ? "active" : "disabled"],
    }, { sourceId: id, providerId: source.provider_id, s3Bucket: source.bucket, s3Prefix: source.prefix }, d));
  }

  const legacySource = sourceSummary({
    id: "legacy",
    label: "Legacy/local mail",
    kind: "legacy",
    badges: ["legacy"],
  }, { sourceId: "legacy" }, d);
  if (legacySource.total > 0) sources.push(legacySource);

  for (const providerId of orphanedProviderIds(d)) {
    const id = orphanedSourceId(providerId);
    sources.push(sourceSummary({
      id,
      label: `Orphaned source ${providerId.slice(0, 8)}`,
      kind: "orphaned",
      providerId,
      badges: ["orphaned"],
    }, { sourceId: id }, d));
  }

  const q = opts?.search?.trim().toLowerCase();
  let filtered = q
    ? sources.filter((source) => [
        source.id,
        source.label,
        source.kind,
        source.providerId,
        source.providerName,
        source.providerType,
        source.bucket,
        source.s3Prefix,
        ...source.badges,
      ].some((value) => String(value ?? "").toLowerCase().includes(q)))
    : sources;

  filtered = filtered.sort((a, b) => {
    if (a.kind === "all") return -1;
    if (b.kind === "all") return 1;
    if (a.badges.includes("orphaned") !== b.badges.includes("orphaned")) return a.badges.includes("orphaned") ? 1 : -1;
    if (a.badges.includes("legacy") !== b.badges.includes("legacy")) return a.badges.includes("legacy") ? 1 : -1;
    return a.label.localeCompare(b.label);
  });

  return filtered.slice(0, positiveInt(opts?.limit, 100));
}

export interface MessageBody {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  text: string | null;
  html: string | null;
  summary: string;
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
  summary: string | null;
}

/** Merge attachment metadata with downloaded-path info (local/s3 location). */
function mergeAttachments(meta: { filename: string; content_type: string; size: number }[], paths: { filename: string; local_path?: string; s3_url?: string }[]): AttachmentInfo[] {
  const byName = new Map(paths.map((p) => [p.filename, p.local_path ?? p.s3_url]));
  return meta.map((a) => ({ filename: a.filename, content_type: a.content_type, size: a.size, location: byName.get(a.filename) }));
}

function htmlToPlainText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSummary(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 360) : null;
}

function fallbackMessageSummary(subject: string, text: string | null | undefined, html: string | null | undefined): string {
  const topic = (subject || "(no subject)").replace(/\s+/g, " ").trim();
  const plain = ((text ?? "").trim() || htmlToPlainText(html)).replace(/\s+/g, " ").trim();
  const excerpt = plain && plain.toLowerCase() !== topic.toLowerCase()
    ? plain.slice(0, 180).replace(/\s+\S*$/, "").trim()
    : "";
  if (excerpt) return `About ${topic}: ${excerpt}.`;
  return `About ${topic}.`;
}

export function getMessageBody(msg: TuiMessage, db?: Database): MessageBody | null {
  const d = db || getDatabase();
  if (msg.kind === "inbound") {
    const e = d.query(
      `SELECT from_address, to_addresses, cc_addresses, subject, received_at,
              text_body, html_body, is_read, is_starred, is_archived,
              label_ids_json, attachments_json, attachment_paths,
              COALESCE(
                (
                  SELECT r.summary
                    FROM email_agent_runs r
                   WHERE r.inbound_email_id = inbound_emails.id
                     AND r.status = 'ok'
                     AND TRIM(COALESCE(r.summary, '')) != ''
                   ORDER BY CASE r.agent_key
                              WHEN 'categorizer' THEN 0
                              WHEN 'labeler' THEN 1
                              WHEN 'fraud' THEN 2
                              ELSE 3
                            END,
                            r.completed_at DESC
                   LIMIT 1
                ),
                (
                  SELECT t.summary
                    FROM email_triage t
                   WHERE t.inbound_email_id = inbound_emails.id
                     AND TRIM(COALESCE(t.summary, '')) != ''
                   ORDER BY t.triaged_at DESC
                   LIMIT 1
                )
              ) AS summary
         FROM inbound_emails
        WHERE id = ?`,
    ).get(msg.id) as InboundBodyRow | null;
    if (!e) return null;
    const labels = parseJsonArray<string>(e.label_ids_json);
    const summary = normalizeSummary(e.summary) ?? fallbackMessageSummary(e.subject || "(no subject)", e.text_body, e.html_body);
    return {
      from: e.from_address,
      to: parseJsonArray<string>(e.to_addresses).join(", "),
      cc: parseJsonArray<string>(e.cc_addresses).join(", "),
      subject: e.subject || "(no subject)", date: e.received_at,
      text: e.text_body, html: e.html_body,
      summary,
      flags: [e.is_read ? "read" : "unread", e.is_starred && "starred", e.is_archived && "archived", ...labels].filter(Boolean) as string[],
      attachments: mergeAttachments(parseJsonArray(e.attachments_json), parseJsonArray(e.attachment_paths)),
    };
  }
  const e = getEmail(msg.id, d);
  if (!e) return null;
  const content = getEmailContent(e.id, d);
  const triage = d.query(
    `SELECT summary
       FROM email_triage
      WHERE email_id = ?
        AND TRIM(COALESCE(summary, '')) != ''
      ORDER BY triaged_at DESC
      LIMIT 1`,
  ).get(e.id) as { summary: string | null } | null;
  const summary = normalizeSummary(triage?.summary) ?? fallbackMessageSummary(e.subject || "(no subject)", content?.text_body, content?.html);
  return {
    from: e.from_address, to: e.to_addresses.join(", "), cc: e.cc_addresses.join(", "),
    subject: e.subject || "(no subject)", date: e.sent_at,
    text: content?.text_body ?? null, html: content?.html ?? null,
    summary,
    flags: ["sent", e.status].filter(Boolean) as string[],
    attachments: [],
  };
}

/** The full conversation (sent + received) for a message's thread, oldest first. */
export function getConversation(msg: TuiMessage, db?: Database): TuiThreadMessage[] {
  const d = db || getDatabase();
  if (msg.thread_id) {
    const messages = getThreadMessages(msg.thread_id, d);
    if (messages.length > 0) {
      return messages.map((message) => ({
        ...message,
        storage: message.kind === "sent" ? "email" : "inbound",
      }));
    }
  }
  if (msg.kind !== "inbound" || !msg.provider_thread_id) return [];
  const rows = d.query(
    `SELECT id, from_address, subject, received_at, is_sent
       FROM inbound_emails
      WHERE provider_thread_id = ?
      ORDER BY received_at ASC
      LIMIT 100`,
  ).all(msg.provider_thread_id) as Array<{ id: string; from_address: string; subject: string; received_at: string; is_sent: number }>;
  return rows.map((row) => ({
    kind: row.is_sent ? "sent" : "received",
    storage: "inbound",
    id: row.id,
    from: row.from_address,
    subject: row.subject,
    at: row.received_at,
  }));
}

export function threadItemToMessage(item: TuiThreadMessage, base: TuiMessage): TuiMessage {
  const inbound = item.storage === "inbound";
  return {
    kind: inbound ? "inbound" : "sent",
    id: item.id,
    from: item.from,
    to: "",
    subject: item.subject || "(no subject)",
    date: item.at,
    is_read: true,
    is_starred: false,
    labels: inbound && item.kind === "sent" ? ["SENT"] : [],
    snippet: "",
    thread_id: base.thread_id,
    provider_thread_id: base.provider_thread_id,
    attachments: 0,
    sentByMe: item.kind === "sent",
  };
}

export interface ConversationBodyOptions {
  limit?: number;
}

/** The full conversation with bodies, oldest first. Falls back to the selected message. */
export function getConversationBodies(msg: TuiMessage, db?: Database, opts?: ConversationBodyOptions): TuiThreadBody[] {
  const d = db || getDatabase();
  const conversation = getConversation(msg, d);
  const allItems = conversation.length > 0
    ? conversation
    : [{
      kind: msg.sentByMe ? "sent" as const : "received" as const,
      storage: msg.kind === "sent" ? "email" as const : "inbound" as const,
      id: msg.id,
      from: msg.from,
      subject: msg.subject,
      at: msg.date,
    }];
  const limit = opts?.limit ? positiveInt(opts.limit, 100) : undefined;
  const items = limit && allItems.length > limit ? allItems.slice(-limit) : allItems;
  return items.map((item) => ({
    item,
    body: getMessageBody(threadItemToMessage(item, msg), d),
  }));
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

export const COMMON_LABELS = [
  "important",
  "action-required",
  "urgent",
  "follow-up",
  "fyi",
  "newsletter",
  "transactional",
  "spam",
  "trash",
] as const;

export const MAIL_CATEGORY_LABELS = [
  { name: "category_personal", title: "Primary" },
  { name: "category_social", title: "Social" },
  { name: "category_promotions", title: "Promotions" },
  { name: "category_updates", title: "Updates" },
  { name: "category_forums", title: "Forums" },
] as const;

const MAIL_CATEGORY_KEYS = new Map(MAIL_CATEGORY_LABELS.map((category) => [labelNameKey(category.name), category]));

export interface LabelSummary {
  name: string;
  count: number;
  popular: boolean;
}

export interface ListLabelSummaryOptions {
  limit?: number;
  search?: string;
}

export function listLabelSummaries(db?: Database): LabelSummary[];
export function listLabelSummaries(opts?: ListLabelSummaryOptions, db?: Database): LabelSummary[];
export function listLabelSummaries(optsOrDb?: ListLabelSummaryOptions | Database, maybeDb?: Database): LabelSummary[] {
  const d = isDatabase(optsOrDb) ? optsOrDb : maybeDb || getDatabase();
  const opts = isDatabase(optsOrDb) ? undefined : optsOrDb;
  const counts = new Map<string, number>();
  const rows = d.query(
    `SELECT label, COUNT(*) AS count
       FROM inbound_labels
      WHERE TRIM(label) != ''
      GROUP BY label`,
  ).all() as Array<{ label: string; count: unknown }>;
  for (const row of rows) counts.set(row.label, countValue(row.count));
  for (const label of COMMON_LABELS) counts.set(label, counts.get(label) ?? 0);

  const commonRank = new Map<string, number>(COMMON_LABELS.map((label, index) => [label, index]));
  let labels = [...counts.entries()].map(([name, count]) => ({ name, count, popular: count > 0 }));
  const q = opts?.search?.trim().toLowerCase();
  if (q) labels = labels.filter((label) => label.name.includes(q));
  labels.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    const aRank = commonRank.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bRank = commonRank.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  });
  return labels.slice(0, positiveInt(opts?.limit, 50));
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
}

export function normalizedLabelName(label: string): string {
  return normalizeLabel(label);
}

export function labelNameKey(label: string): string {
  return normalizeLabel(label).replace(/-/g, "_");
}

export function labelNameAliases(label: string): string[] {
  const normalized = normalizeLabel(label);
  if (!normalized) return [];
  return [...new Set([normalized, normalized.replace(/_/g, "-"), normalized.replace(/-/g, "_")])];
}

export function isMailCategoryLabel(label: string): boolean {
  return MAIL_CATEGORY_KEYS.has(labelNameKey(label));
}

export function mailCategoryTitle(label: string): string | null {
  return MAIL_CATEGORY_KEYS.get(labelNameKey(label))?.title ?? null;
}

export function labelDisplayName(label: string): string {
  const display = mailCategoryTitle(label) ?? normalizeLabel(label).replace(/^category[_-]+/i, "");
  return display
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export type MailboxGroupMode = "none" | "priority" | "read-state" | "category";

export const MAILBOX_GROUP_MODES: MailboxGroupMode[] = ["none", "priority", "read-state", "category"];

export interface TuiMessageGroup {
  key: string;
  title: string;
  messages: TuiMessage[];
}

export function normalizeMailboxGroupMode(value: string | undefined | null): MailboxGroupMode {
  const normalized = (value ?? "none").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (normalized === "priority" || normalized === "read-state" || normalized === "category" || normalized === "none") return normalized;
  return "none";
}

export function mailboxGroupModeLabel(mode: MailboxGroupMode): string {
  return {
    none: "None",
    priority: "Priority Inbox",
    "read-state": "Read State",
    category: "Categories",
  }[mode];
}

function baseLabel(label: string): string {
  return normalizeLabel(label).replace(/_/g, "-").replace(/^ai:/, "");
}

export function isImportantLabel(label: string): boolean {
  const normalized = baseLabel(label);
  return normalized === "important"
    || normalized === "priority"
    || normalized === "urgent"
    || normalized === "action-required"
    || normalized === "follow-up"
    || normalized === "security"
    || normalized === "customer";
}

export function isImportantMessage(message: Pick<TuiMessage, "is_starred" | "labels">): boolean {
  return message.is_starred || message.labels.some(isImportantLabel);
}

function messageCategory(message: TuiMessage): string {
  const labels = message.labels.map(baseLabel);
  if (labels.some((label) => label === "category-social" || label === "social")) return "social";
  if (labels.some((label) => label === "category-promotions" || label === "promotions" || label === "promotion" || label === "marketing" || label === "newsletter")) return "promotions";
  if (labels.some((label) => label === "category-updates" || label === "updates" || label === "update" || label === "transactional" || label === "receipt" || label === "notification")) return "updates";
  if (labels.some((label) => label === "category-forums" || label === "forums" || label === "forum" || label === "mailing-list")) return "forums";
  if (labels.some((label) => label === "category-personal" || label === "primary" || label === "personal")) return "primary";
  if (isImportantMessage(message)) return "primary";
  return "other";
}

export function groupMailboxMessages(messages: TuiMessage[], mode: MailboxGroupMode): TuiMessageGroup[] {
  if (mode === "none") return [{ key: "all", title: "", messages }];
  const defs = mode === "priority"
    ? [
        { key: "important-unread", title: "Important and Unread", match: (message: TuiMessage) => isImportantMessage(message) && !message.is_read },
        { key: "starred", title: "Starred", match: (message: TuiMessage) => message.is_starred },
        { key: "everything-else", title: "Everything Else", match: () => true },
      ]
    : mode === "read-state"
      ? [
          { key: "unread", title: "Unread", match: (message: TuiMessage) => !message.is_read },
          { key: "read", title: "Read", match: (message: TuiMessage) => message.is_read },
        ]
      : [
          { key: "primary", title: "Primary", match: (message: TuiMessage) => messageCategory(message) === "primary" },
          { key: "social", title: "Social", match: (message: TuiMessage) => messageCategory(message) === "social" },
          { key: "promotions", title: "Promotions", match: (message: TuiMessage) => messageCategory(message) === "promotions" },
          { key: "updates", title: "Updates", match: (message: TuiMessage) => messageCategory(message) === "updates" },
          { key: "forums", title: "Forums", match: (message: TuiMessage) => messageCategory(message) === "forums" },
          { key: "other", title: "Other", match: () => true },
        ];
  const assigned = new Set<string>();
  return defs.map((def) => {
    const groupMessagesForDef = messages.filter((message) => {
      if (assigned.has(message.id)) return false;
      if (!def.match(message)) return false;
      assigned.add(message.id);
      return true;
    });
    return { key: def.key, title: def.title, messages: groupMessagesForDef };
  }).filter((group) => group.messages.length > 0);
}

export function toggleMessageLabel(msg: TuiMessage, label: string, db?: Database): string[] {
  if (msg.kind !== "inbound") return msg.labels;
  const normalized = normalizeLabel(label);
  if (!normalized) return msg.labels;
  const labels = new Set(msg.labels.map((item) => normalizeLabel(item)).filter(Boolean));
  const next = labels.has(normalized)
    ? removeInboundLabelSummary(msg.id, normalized, db).label_ids
    : addInboundLabelSummary(msg.id, normalized, db).label_ids;
  return next.map(normalizeLabel).filter(Boolean);
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
  const to = msg.sentByMe ? msg.to : msg.from;
  const from = msg.sentByMe ? msg.from : (msg.to.split(",")[0]?.trim() ?? "");
  return { from, to, subject };
}

export interface ComposeInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  providerId?: string;
  markdown?: boolean;
  replyTo?: TuiMessage;
}

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

  let threadId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string[] = [];
  let generatedMessageId: string | null = null;
  const headers: Record<string, string> = {};

  if (input.replyTo) {
    const parent = input.replyTo;
    let parentMsgId: string | null = null;
    let parentRefs: string[] = [];
    generatedMessageId = generateMessageId(input.from.split("@")[1] ?? "localhost");
    headers["Message-ID"] = generatedMessageId;

    if (parent.kind === "inbound") {
      const inbound = getInboundEmail(parent.id, d);
      parentMsgId = inbound?.headers?.["message-id"] ?? inbound?.headers?.["Message-ID"] ?? inbound?.headers?.["Message-Id"] ?? null;
      parentRefs = parseReferences(inbound?.headers?.["References"] ?? inbound?.headers?.["references"]);
      threadId = inbound?.thread_id ?? parent.thread_id ?? uuid();
      if (inbound && !inbound.thread_id) setInboundThreadId(inbound.id, threadId, d);
    } else {
      const sent = getEmail(parent.id, d);
      const threading = sent ? getEmailThreading(sent.id, d) : null;
      parentMsgId = threading?.message_id ?? (sent?.provider_message_id ? `<${sent.provider_message_id}>` : null);
      parentRefs = threading?.references ?? [];
      threadId = threading?.thread_id ?? parent.thread_id ?? uuid();
    }

    if (parentMsgId) {
      const parentHeaders = buildThreadingHeaders({ message_id: parentMsgId, references: parentRefs });
      headers["In-Reply-To"] = parentHeaders.inReplyToHeader;
      headers["References"] = parentHeaders.referencesHeader;
      inReplyTo = parentHeaders.inReplyTo;
      references = parentHeaders.references;
    }
  }

  const sendOpts = {
    provider_id: providerId,
    from: input.from,
    to,
    subject: input.subject,
    text: input.body,
    ...(html ? { html } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  const { sendWithFailover } = await import("../../lib/send.js");
  const { messageId, providerId: actual } = await sendWithFailover(providerId, sendOpts, d);
  const email = await createSentEmailLedger(actual, sendOpts, messageId, d);
  if (generatedMessageId) {
    await setSentEmailThreading(email.id, { message_id: generatedMessageId, thread_id: threadId, in_reply_to: inReplyTo, references }, d);
  }
  await storeSentEmailContent(email.id, { text: input.body, ...(html ? { html } : {}) }, d);
  return { id: email.id, messageId };
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
       COALESCE(SUM(CASE WHEN is_sent = 0 AND is_archived = 1 THEN 1 ELSE 0 END), 0) AS archived
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
  const mode = resolveEmailsMode();
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
        readiness: assessDomainReadiness(domain, provisioning, {
          ...domainInboundReadinessSignals(domain, mode),
          ready_addresses: readyAddressesByDomain.get(domain.id) ?? 0,
        }).state,
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

// ── inbox address choices ──────────────────────────────────────────────────────

export interface InboxAddressChoice {
  id: string;
  label: string;
  address?: string;
  domain?: string;
  providerId?: string;
  provider?: string;
  receiveStatus?: string;
  configured: boolean;
  observed: boolean;
}

export const ALL_ADDRESSES: InboxAddressChoice = {
  id: "all",
  label: "All mailboxes",
  configured: false,
  observed: false,
};

function upsertAddressChoice(
  map: Map<string, InboxAddressChoice>,
  address: string,
  patch: Partial<Pick<InboxAddressChoice, "configured" | "observed" | "providerId" | "provider" | "domain" | "receiveStatus">>,
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

interface ConfiguredInboxAddress {
  id: string;
  email: string;
  provider_id: string;
}

function listConfiguredInboxAddresses(db: Database, opts?: ListInboxAddressOptions): ConfiguredInboxAddress[] {
  if (!opts) {
    return db
      .query("SELECT id, email, provider_id FROM addresses WHERE COALESCE(status, 'active') = 'active' ORDER BY created_at DESC, email ASC")
      .all() as ConfiguredInboxAddress[];
  }
  const limit = positiveInt(opts.limit, 200);
  const q = opts.search?.trim().toLowerCase();
  const searchSql = q ? " AND LOWER(email) LIKE ?" : "";
  const params: Array<string | number> = [];
  if (q) params.push(`%${q}%`);
  params.push(limit);
  return db
    .query(`SELECT id, email, provider_id FROM addresses WHERE COALESCE(status, 'active') = 'active'${searchSql} ORDER BY created_at DESC, email ASC LIMIT ?`)
    .all(...params) as ConfiguredInboxAddress[];
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

/** User-facing mailbox choices: all mailboxes plus configured or observed addresses. */
export function listInboxAddresses(db?: Database): InboxAddressChoice[];
export function listInboxAddresses(opts?: ListInboxAddressOptions, db?: Database): InboxAddressChoice[];
export function listInboxAddresses(optsOrDb?: ListInboxAddressOptions | Database, maybeDb?: Database): InboxAddressChoice[] {
  const d = isDatabase(optsOrDb) ? optsOrDb : maybeDb || getDatabase();
  const opts = isDatabase(optsOrDb) ? undefined : optsOrDb;
  const byAddress = new Map<string, InboxAddressChoice>();
  const configured = listConfiguredInboxAddresses(d, opts);
  const providerNames = listProviderNamesByIds(configured.map((address) => address.provider_id), d);
  const provisioningByAddress = listAddressProvisioningByIds(configured.map((address) => address.id), d);

  for (const item of configured) {
    const address = extractEmail(item.email);
    if (address) {
      const provisioning = provisioningByAddress.get(item.id);
      upsertAddressChoice(byAddress, address, {
        configured: true,
        domain: address.split("@")[1],
        providerId: item.provider_id,
        provider: providerNames.get(item.provider_id) ?? item.provider_id,
        receiveStatus: provisioning?.provisioning_status ?? "none",
      });
    }
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
    .query("SELECT id, email, provider_id FROM addresses WHERE email = ? COLLATE NOCASE AND COALESCE(status, 'active') = 'active' LIMIT 1")
    .get(normalized) as ConfiguredInboxAddress | null;
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
    const provider = configured ? listProviderNamesByIds([configured.provider_id], d).get(configured.provider_id) ?? configured.provider_id : undefined;
    const provisioning = configured ? listAddressProvisioningByIds([configured.id], d).get(configured.id) : undefined;
    return {
      id: `a:${normalized}`,
      label: configured?.email ?? observed?.email ?? normalized,
      address: normalized,
      domain: normalized.split("@")[1],
      providerId: configured?.provider_id,
      provider,
      receiveStatus: provisioning?.provisioning_status ?? (configured ? "none" : undefined),
      configured: !!configured,
      observed: !!observed,
    };
  }
  return {
    id: `a:${normalized}`,
    label: normalized,
    address: normalized,
    domain: normalized.split("@")[1],
    configured: false,
    observed: true,
  };
}

// ── ingestion sources ─────────────────────────────────────────────────────────

export interface InboxSource { id: string; label: string; providerId?: string; domain?: string }

/** The selectable ingestion sources. Providers remain credentials/capabilities. */
export function listSources(db?: Database): InboxSource[] {
  const d = db || getDatabase();
  return listMailboxSources(d).map((source) => ({
    id: source.id,
    label: source.badges.length ? `${source.label} [${source.badges.join(", ")}]` : source.label,
    providerId: source.providerId,
  }));
}

// ── settings (persisted to config.json) ────────────────────────────────────────

export interface TuiSettings {
  autoPull: boolean;
  dimRead: boolean;
  defaultMailbox: Mailbox;
  defaultAddress: string | null;
  defaultFrom: string | null;
  theme: TuiThemeMode;
}

export function getSettings(): TuiSettings {
  const c = loadConfig();
  return {
    autoPull: c["tui_autopull"] === true,
    dimRead: c["tui_dim_read"] === true, // default false = high contrast
    defaultMailbox: normalizeMailbox(c["default_mailbox"]),
    defaultAddress: extractEmail(c["tui_default_address"]) ?? null,
    defaultFrom: extractEmail(c["tui_default_from"]) ?? null,
    theme: c["tui_theme"] == null ? "light" : normalizeThemeMode(c["tui_theme"]),
  };
}

export function setSetting<K extends keyof TuiSettings>(key: K, value: TuiSettings[K]): void {
  const c = loadConfig();
  const map: Record<keyof TuiSettings, string> = {
    autoPull: "tui_autopull",
    dimRead: "tui_dim_read",
    defaultMailbox: "default_mailbox",
    defaultAddress: "tui_default_address",
    defaultFrom: "tui_default_from",
    theme: "tui_theme",
  };
  c[map[key]] = value as never;
  saveConfig(c);
}
