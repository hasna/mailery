import type { PgAdapterAsync } from "./remote-storage.js";
import { getStoragePg, runStorageMigrations } from "./storage-sync.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { cappedLimit, safeLimit, safeOffset } from "./pagination.js";
import { normalizeEmailAddress } from "./inbound.js";
import type { AttachmentMeta, AttachmentPath, InboundEmail, InboundEmailSummary, ListInboundOpts } from "./inbound.js";
import { getSelfHostedRuntimeStatus } from "../lib/self-hosted-runtime.js";
import { getInboundBuckets } from "../lib/config.js";
import type { VerificationCodeCandidateOptions, VerificationCodeEmail } from "../lib/verification-code.js";

type Remote = Pick<PgAdapterAsync, "all" | "run" | "close">;
let testRemoteFactory: (() => Remote | Promise<Remote>) | null = null;

export function setSelfHostedInboundRemoteFactoryForTest(factory: (() => Remote | Promise<Remote>) | null): void {
  testRemoteFactory = factory;
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
  is_read?: number | boolean;
  read_at?: string | Date | null;
  is_archived?: number | boolean;
  is_starred?: number | boolean;
  is_sent?: number | boolean;
  received_at: string | Date;
  created_at: string | Date;
}

type InboundEmailSummaryRow = Omit<InboundEmailRow, "text_body" | "html_body" | "headers_json">;

export type SelfHostedMailbox = "inbox" | "unread" | "starred" | "sent" | "archived" | "spam" | "trash";

export interface SelfHostedMailboxCounts {
  inbox: number;
  unread: number;
  starred: number;
  sent: number;
  archived: number;
  spam: number;
  trash: number;
}

export interface SelfHostedMailboxStatus {
  counts: SelfHostedMailboxCounts;
  folders: Array<{
    id: SelfHostedMailbox;
    folder: SelfHostedMailbox;
    label: string;
    count: number;
  }>;
}

export interface SelfHostedSourceSummary {
  id: string;
  label: string;
  kind: "all" | "s3" | "provider" | "legacy" | "orphaned";
  providerId?: string;
  providerName?: string;
  providerType?: string;
  bucket?: string;
  region?: string;
  badges: string[];
  counts: SelfHostedMailboxCounts;
  total: number;
  unread: number;
  latestReceivedAt: string | null;
}

export interface SelfHostedInboxStatus {
  total: number;
  unread: number;
  latest_received_at: string | null;
  mailboxes: SelfHostedMailboxStatus;
  sources: SelfHostedSourceSummary[];
}

export interface ListSelfHostedInboundOpts extends ListInboundOpts {
  mailbox?: SelfHostedMailbox;
  sourceId?: string;
  s3Bucket?: string;
  legacy?: boolean;
}

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

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function bool(value: number | boolean | null | undefined): boolean {
  if (typeof value === "boolean") return value;
  return Number(value ?? 0) !== 0;
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
    raw_size: Number(row.raw_size ?? 0),
    is_read: bool(row.is_read),
    read_at: iso(row.read_at),
    is_archived: bool(row.is_archived),
    is_starred: bool(row.is_starred),
    is_sent: bool(row.is_sent),
    received_at: iso(row.received_at) ?? "",
    created_at: iso(row.created_at) ?? "",
  };
}

function rowToEmailSummary(row: InboundEmailSummaryRow): InboundEmailSummary {
  const full = rowToEmail({ ...row, text_body: null, html_body: null, headers_json: "{}" });
  const { text_body: _textBody, html_body: _htmlBody, headers: _headers, ...summary } = full;
  return summary;
}

function normalizeInboundLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
}

function inboundStateMessagePredicate(): string {
  return "mail_message_id = COALESCE((SELECT mail_message_id FROM inbound_emails WHERE id = ?), 'msg:inbound:' || ?)";
}

function appendMailboxFilter(mailbox: SelfHostedMailbox | undefined, conditions: string[]): void {
  switch (mailbox ?? "inbox") {
    case "inbox":
      conditions.push("is_sent = 0", "is_archived = 0", "is_spam = 0", "is_trash = 0");
      break;
    case "unread":
      conditions.push("is_sent = 0", "is_read = 0", "is_archived = 0", "is_spam = 0", "is_trash = 0");
      break;
    case "starred":
      conditions.push("is_sent = 0", "is_starred = 1", "is_archived = 0", "is_spam = 0", "is_trash = 0");
      break;
    case "archived":
      conditions.push("is_sent = 0", "is_archived = 1", "is_spam = 0", "is_trash = 0");
      break;
    case "sent":
      conditions.push("is_sent = 1");
      break;
    case "spam":
      conditions.push("is_sent = 0", "is_spam = 1");
      break;
    case "trash":
      conditions.push("is_sent = 0", "is_trash = 1");
      break;
  }
}

function applyFilters(opts: ListSelfHostedInboundOpts | undefined, conditions: string[], params: Array<string | number>): void {
  appendMailboxFilter(opts?.mailbox, conditions);
  if (opts?.provider_id) {
    conditions.push("provider_id = ?");
    params.push(opts.provider_id);
  }
  if (opts?.legacy) conditions.push("provider_id IS NULL");
  if (opts?.s3Bucket) {
    conditions.push("raw_s3_url LIKE ?");
    params.push(`s3://${opts.s3Bucket}/%`);
  }
  if (opts?.sourceId && !opts.provider_id && !opts.legacy && !opts.s3Bucket) {
    conditions.push("0 = 1");
  }
  if (opts?.since) {
    conditions.push("received_at >= ?");
    params.push(opts.since);
  }
  if (opts?.unread) conditions.push("is_read = 0");
  if (opts?.read) conditions.push("is_read = 1");
  if (opts?.starred) conditions.push("is_starred = 1");
  if (opts?.archived !== undefined) {
    conditions.push(opts.archived ? "is_archived = 1" : "is_archived = 0");
  }
  if (opts?.sent !== undefined) {
    conditions.push(opts.sent ? "is_sent = 1" : "is_sent = 0");
  }
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
    conditions.push("LOWER(COALESCE(from_address, '')) LIKE ?");
    params.push(`%${from}%`);
  }
  const subject = opts?.subject?.trim().toLowerCase();
  if (subject) {
    conditions.push("LOWER(COALESCE(subject, '')) LIKE ?");
    params.push(`%${subject}%`);
  }
  const search = opts?.search?.trim().toLowerCase();
  if (search) {
    const like = `%${search}%`;
    conditions.push(`(
      LOWER(COALESCE(subject, '')) LIKE ?
      OR LOWER(COALESCE(from_address, '')) LIKE ?
      OR LOWER(COALESCE(to_addresses, '')) LIKE ?
      OR LOWER(COALESCE(text_body, '')) LIKE ?
    )`);
    params.push(like, like, like, like);
  }

  const recipients = (opts?.recipients ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
  const domains = (opts?.recipientDomains ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (recipients.length > 0 || domains.length > 0) {
    const ors: string[] = [];
    if (recipients.length > 0) {
      ors.push(`recipient.address IN (${recipients.map(() => "?").join(", ")})`);
      params.push(...recipients);
    }
    if (domains.length > 0) {
      ors.push(`recipient.domain IN (${domains.map(() => "?").join(", ")})`);
      params.push(...domains);
    }
    conditions.push(`id IN (
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

function appendOwnerRecipientScope(ownerId: string, conditions: string[], params: Array<string | number>): void {
  conditions.push(`(${ownerRecipientScopeSql()})`);
  params.push(ownerId, ownerId, ownerId, ownerId, ownerId, ownerId);
}

export function isSelfHostedDirectRuntimeConfigured(): boolean {
  const status = getSelfHostedRuntimeStatus();
  return status.enabled && status.configured;
}

export function assertSelfHostedDirectRuntimeConfigured(): void {
  const status = getSelfHostedRuntimeStatus();
  if (!status.enabled) throw new Error("Self-hosted source-of-truth runtime is not enabled.");
  if (!status.configured) throw new Error("Self-hosted source-of-truth mode requires HASNA_EMAILS_DATABASE_URL or EMAILS_DATABASE_URL.");
}

async function withRemote<T>(remote: Remote | undefined, fn: (remote: Remote) => Promise<T>): Promise<T> {
  if (remote) return fn(remote);
  if (testRemoteFactory) return fn(await testRemoteFactory());
  assertSelfHostedDirectRuntimeConfigured();
  const pg = await getStoragePg();
  try {
    await runStorageMigrations(pg);
    return await fn(pg);
  } finally {
    await pg.close();
  }
}

function summaryFromEmail(email: InboundEmail): InboundEmailSummary {
  const { text_body: _textBody, html_body: _htmlBody, headers: _headers, ...summary } = email;
  return summary;
}

async function readSelfHostedInboundLabels(id: string, remote: Remote): Promise<string[]> {
  const fullId = await resolveSelfHostedInboundEmailId(id, remote);
  const rows = await remote.all("SELECT label_ids_json FROM inbound_emails WHERE id = ? LIMIT 1", fullId) as Array<{ label_ids_json?: string }>;
  if (!rows[0]) throw new Error(`Email not found: ${id}`);
  return parseJsonArray<string>(rows[0].label_ids_json);
}

async function syncSelfHostedMailboxReadState(id: string, read: boolean, readAt: string | null, remote: Remote): Promise<void> {
  await remote.run(
    `UPDATE mailbox_message_state
        SET is_read = ?,
            read_at = ?,
            updated_at = NOW()
      WHERE ${inboundStateMessagePredicate()}`,
    read ? 1 : 0,
    readAt,
    id,
    id,
  );
}

async function syncSelfHostedMailboxArchivedState(id: string, archived: boolean, remote: Remote): Promise<void> {
  await remote.run(
    `UPDATE mailbox_message_state
        SET is_archived = ?,
            folder_id = CASE
              WHEN direction IN ('sent', 'outbound') THEN 'folder:' || mailbox_id || ':sent'
              WHEN is_trash = 1 THEN 'folder:' || mailbox_id || ':trash'
              WHEN is_spam = 1 THEN 'folder:' || mailbox_id || ':spam'
              WHEN ? = 1 THEN 'folder:' || mailbox_id || ':archive'
              ELSE 'folder:' || mailbox_id || ':inbox'
            END,
            updated_at = NOW()
      WHERE ${inboundStateMessagePredicate()}`,
    archived ? 1 : 0,
    archived ? 1 : 0,
    id,
    id,
  );
}

async function syncSelfHostedMailboxStarredState(id: string, starred: boolean, remote: Remote): Promise<void> {
  await remote.run(
    `UPDATE mailbox_message_state
        SET is_starred = ?,
            updated_at = NOW()
      WHERE ${inboundStateMessagePredicate()}`,
    starred ? 1 : 0,
    id,
    id,
  );
}

async function syncSelfHostedMailboxLabelState(id: string, labels: string[], remote: Remote): Promise<void> {
  const isSpam = labels.some((label) => normalizeInboundLabel(label) === "spam");
  const isTrash = labels.some((label) => normalizeInboundLabel(label) === "trash");
  await remote.run(
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
            updated_at = NOW()
      WHERE ${inboundStateMessagePredicate()}`,
    JSON.stringify(labels),
    isSpam ? 1 : 0,
    isTrash ? 1 : 0,
    isTrash ? 1 : 0,
    isSpam ? 1 : 0,
    id,
    id,
  );
}

const SELF_HOSTED_MAILBOXES: SelfHostedMailbox[] = ["inbox", "unread", "starred", "sent", "archived", "spam", "trash"];

const MAILBOX_LABELS: Record<SelfHostedMailbox, string> = {
  inbox: "Inbox",
  unread: "Unread",
  starred: "Starred",
  sent: "Sent",
  archived: "Archived",
  spam: "Spam",
  trash: "Trash",
};

const COUNT_WHERE: Record<SelfHostedMailbox, string> = {
  inbox: "COALESCE(is_sent, 0) = 0 AND COALESCE(is_archived, 0) = 0 AND COALESCE(is_spam, 0) = 0 AND COALESCE(is_trash, 0) = 0",
  unread: "COALESCE(is_sent, 0) = 0 AND COALESCE(is_read, 0) = 0 AND COALESCE(is_archived, 0) = 0 AND COALESCE(is_spam, 0) = 0 AND COALESCE(is_trash, 0) = 0",
  starred: "COALESCE(is_sent, 0) = 0 AND COALESCE(is_starred, 0) = 1 AND COALESCE(is_archived, 0) = 0 AND COALESCE(is_spam, 0) = 0 AND COALESCE(is_trash, 0) = 0",
  sent: "COALESCE(is_sent, 0) = 1",
  archived: "COALESCE(is_sent, 0) = 0 AND COALESCE(is_archived, 0) = 1 AND COALESCE(is_spam, 0) = 0 AND COALESCE(is_trash, 0) = 0",
  spam: "COALESCE(is_sent, 0) = 0 AND COALESCE(is_spam, 0) = 1",
  trash: "COALESCE(is_sent, 0) = 0 AND COALESCE(is_trash, 0) = 1",
};

function numericCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sourceFilter(opts: Pick<ListSelfHostedInboundOpts, "provider_id" | "sourceId" | "s3Bucket" | "legacy"> | undefined): { sql: string; params: Array<string | number> } {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (opts?.provider_id) {
    conditions.push("provider_id = ?");
    params.push(opts.provider_id);
  }
  if (opts?.legacy) conditions.push("provider_id IS NULL");
  if (opts?.s3Bucket) {
    conditions.push("raw_s3_url LIKE ?");
    params.push(`s3://${opts.s3Bucket}/%`);
  }
  if (opts?.sourceId && !opts.provider_id && !opts.legacy && !opts.s3Bucket) {
    conditions.push("0 = 1");
  }
  return {
    sql: conditions.length ? ` AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

async function countInbound(remote: Remote, where: string, params: Array<string | number> = []): Promise<number> {
  const rows = await remote.all(`SELECT COUNT(*) AS count FROM inbound_emails WHERE ${where}`, ...params) as Array<{ count: unknown }>;
  return numericCount(rows[0]?.count);
}

async function latestInbound(remote: Remote, filter: { sql: string; params: Array<string | number> }): Promise<string | null> {
  const rows = await remote.all(
    `SELECT MAX(received_at) AS latest
       FROM inbound_emails
      WHERE COALESCE(is_sent, 0) = 0${filter.sql}`,
    ...filter.params,
  ) as Array<{ latest: string | Date | null }>;
  return iso(rows[0]?.latest);
}

async function countSentEmails(remote: Remote, opts: Pick<ListSelfHostedInboundOpts, "provider_id" | "sourceId" | "s3Bucket" | "legacy"> | undefined): Promise<number> {
  if (opts?.s3Bucket || (opts?.sourceId && !opts.provider_id && !opts.legacy)) return 0;
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (opts?.provider_id) {
    conditions.push("provider_id = ?");
    params.push(opts.provider_id);
  }
  if (opts?.legacy) conditions.push("provider_id IS NULL");
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = await remote.all(`SELECT COUNT(*) AS count FROM emails${where}`, ...params) as Array<{ count: unknown }>;
  return numericCount(rows[0]?.count);
}

async function getSelfHostedInboundTotal(remote: Remote, opts?: Pick<ListSelfHostedInboundOpts, "provider_id" | "sourceId" | "s3Bucket" | "legacy">): Promise<number> {
  const filter = sourceFilter(opts);
  return countInbound(remote, `1 = 1${filter.sql}`, filter.params);
}

async function selfHostedSourceSummary(
  input: Omit<SelfHostedSourceSummary, "counts" | "total" | "unread" | "latestReceivedAt">,
  source: Pick<ListSelfHostedInboundOpts, "provider_id" | "sourceId" | "s3Bucket" | "legacy"> | undefined,
  remote: Remote,
): Promise<SelfHostedSourceSummary> {
  const counts = await getSelfHostedMailboxCounts(source, remote);
  const total = await getSelfHostedInboundTotal(remote, source) + await countSentEmails(remote, source);
  const latestReceivedAt = await latestInbound(remote, sourceFilter(source));
  return {
    ...input,
    counts,
    total,
    unread: counts.unread,
    latestReceivedAt,
  };
}

function parseS3BucketFromUrl(value: string | null | undefined): string | null {
  const match = String(value ?? "").match(/^s3:\/\/([^/]+)/);
  return match?.[1] ?? null;
}

export async function listSelfHostedInboundEmailSummaries(
  opts?: ListSelfHostedInboundOpts,
  remote?: Remote,
): Promise<InboundEmailSummary[]> {
  return withRemote(remote, async (pg) => {
    const limit = safeLimit(opts?.limit);
    const offset = safeOffset(opts?.offset);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    applyFilters(opts, conditions, params);
    params.push(limit, offset);
    const rows = await pg.all(
      `SELECT ${INBOUND_SUMMARY_COLS}
         FROM inbound_emails
        WHERE ${conditions.join(" AND ")}
        ORDER BY received_at DESC
        LIMIT ? OFFSET ?`,
      ...params,
    ) as InboundEmailSummaryRow[];
    return rows.map(rowToEmailSummary);
  });
}

export async function listSelfHostedInboundEmailSummariesForOwner(
  ownerId: string,
  opts?: Omit<ListSelfHostedInboundOpts, "recipients" | "recipientDomains">,
  remote?: Remote,
): Promise<InboundEmailSummary[]> {
  return withRemote(remote, async (pg) => {
    const limit = safeLimit(opts?.limit);
    const offset = safeOffset(opts?.offset);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    applyFilters(opts, conditions, params);
    appendOwnerRecipientScope(ownerId, conditions, params);
    params.push(limit, offset);
    const rows = await pg.all(
      `SELECT ${INBOUND_SUMMARY_COLS}
         FROM inbound_emails
        WHERE ${conditions.join(" AND ")}
        ORDER BY received_at DESC
        LIMIT ? OFFSET ?`,
      ...params,
    ) as InboundEmailSummaryRow[];
    return rows.map(rowToEmailSummary);
  });
}

export async function resolveSelfHostedInboundEmailId(id: string, remote?: Remote): Promise<string> {
  return withRemote(remote, async (pg) => {
    const ref = id.trim();
    const rows = await pg.all(
      "SELECT id FROM inbound_emails WHERE id = ? OR id LIKE ? ORDER BY id ASC LIMIT 2",
      ref,
      `${ref}%`,
    ) as Array<{ id: string }>;
    if (rows.length === 1) return rows[0]!.id;
    if (rows.length > 1) throw new Error(`Ambiguous email id: ${id}`);
    throw new Error(`Email not found: ${id}`);
  });
}

export async function getSelfHostedInboundEmail(id: string, remote?: Remote): Promise<InboundEmail | null> {
  return withRemote(remote, async (pg) => {
    const fullId = await resolveSelfHostedInboundEmailId(id, pg);
    const row = await pg.all("SELECT * FROM inbound_emails WHERE id = ? LIMIT 1", fullId) as InboundEmailRow[];
    return row[0] ? rowToEmail(row[0]) : null;
  });
}

export async function selfHostedInboundEmailBelongsToOwner(id: string, ownerId: string, remote?: Remote): Promise<boolean> {
  return withRemote(remote, async (pg) => {
    const conditions = ["inbound_emails.id = ?"];
    const params: Array<string | number> = [id];
    appendOwnerRecipientScope(ownerId, conditions, params);
    const rows = await pg.all(
      `SELECT 1 AS ok
         FROM inbound_emails
        WHERE ${conditions.join(" AND ")}
        LIMIT 1`,
      ...params,
    ) as Array<{ ok?: unknown }>;
    return rows.length > 0;
  });
}

export async function getSelfHostedInboundAttachmentPaths(id: string, remote?: Remote): Promise<AttachmentPath[] | null> {
  return withRemote(remote, async (pg) => {
    const fullId = await resolveSelfHostedInboundEmailId(id, pg);
    const rows = await pg.all("SELECT attachment_paths FROM inbound_emails WHERE id = ? LIMIT 1", fullId) as Array<{ attachment_paths?: string | null }>;
    return rows[0] ? parseJsonArray<AttachmentPath>(rows[0].attachment_paths) : null;
  });
}

export async function getLatestSelfHostedInboundEmail(
  recipient: string,
  opts?: Omit<ListSelfHostedInboundOpts, "recipients" | "recipientDomains" | "limit" | "offset">,
  remote?: Remote,
): Promise<InboundEmail | null> {
  return withRemote(remote, async (pg) => {
    const summaries = await listSelfHostedInboundEmailSummaries({
      ...opts,
      recipients: [recipient.trim().toLowerCase()],
      limit: cappedLimit(1, 1, 1),
      offset: 0,
    }, pg);
    if (!summaries[0]) return null;
    return getSelfHostedInboundEmail(summaries[0].id, pg);
  });
}

function verificationCandidateFilterSql(
  address: string,
  archived: boolean,
  filters: VerificationCodeCandidateOptions,
): { conditions: string[]; params: Array<string | number> } {
  const conditions = ["recipient.address = ?", "e.is_sent = 0", "e.is_archived = ?"];
  const params: Array<string | number> = [address, archived ? 1 : 0];
  if (filters.since) {
    conditions.push("e.received_at >= ?");
    params.push(filters.since);
  }
  const from = filters.from?.trim().toLowerCase();
  if (from) {
    conditions.push("LOWER(COALESCE(e.from_address, '')) LIKE ?");
    params.push(`%${from}%`);
  }
  const subject = filters.subject?.trim().toLowerCase();
  if (subject) {
    conditions.push("LOWER(COALESCE(e.subject, '')) LIKE ?");
    params.push(`%${subject}%`);
  }
  return { conditions, params };
}

export async function listSelfHostedVerificationCodeCandidates(
  address: string,
  opts: VerificationCodeCandidateOptions = {},
  remote?: Remote,
): Promise<VerificationCodeEmail[]> {
  return withRemote(remote, async (pg) => {
    const normalized = normalizeEmailAddress(address);
    if (!normalized) return [];

    const limit = safeLimit(opts.limit);
    const active = verificationCandidateFilterSql(normalized, false, opts);
    const archived = verificationCandidateFilterSql(normalized, true, opts);
    const selected = "e.id, e.from_address, e.subject, e.text_body, e.html_body, e.received_at";
    const rows = await pg.all(
      `WITH active AS (
         SELECT ${selected}
           FROM inbound_recipients recipient
           JOIN inbound_emails e ON e.id = recipient.inbound_email_id
          WHERE ${active.conditions.join(" AND ")}
          ORDER BY e.received_at DESC
          LIMIT ?
       ),
       archived AS (
         SELECT ${selected}
           FROM inbound_recipients recipient
           JOIN inbound_emails e ON e.id = recipient.inbound_email_id
          WHERE ${archived.conditions.join(" AND ")}
          ORDER BY e.received_at DESC
          LIMIT ?
       )
       SELECT * FROM active
       UNION ALL
       SELECT * FROM archived
       ORDER BY received_at DESC`,
      ...active.params,
      limit,
      ...archived.params,
      limit,
    ) as VerificationCodeEmail[];
    return rows;
  });
}

export async function getSelfHostedMailboxCounts(
  opts?: Pick<ListSelfHostedInboundOpts, "provider_id" | "sourceId" | "s3Bucket" | "legacy">,
  remote?: Remote,
): Promise<SelfHostedMailboxCounts> {
  return withRemote(remote, async (pg) => {
    const filter = sourceFilter(opts);
    const counts = {} as SelfHostedMailboxCounts;
    for (const mailbox of SELF_HOSTED_MAILBOXES) {
      counts[mailbox] = await countInbound(pg, `${COUNT_WHERE[mailbox]}${filter.sql}`, filter.params);
    }
    counts.sent += await countSentEmails(pg, opts);
    return counts;
  });
}

export async function getSelfHostedMailboxStatus(
  opts?: Pick<ListSelfHostedInboundOpts, "provider_id" | "sourceId" | "s3Bucket" | "legacy">,
  remote?: Remote,
): Promise<SelfHostedMailboxStatus> {
  const counts = await getSelfHostedMailboxCounts(opts, remote);
  return {
    counts,
    folders: SELF_HOSTED_MAILBOXES.map((folder) => ({
      id: folder,
      folder,
      label: MAILBOX_LABELS[folder],
      count: counts[folder],
    })),
  };
}

export async function listSelfHostedSourceSummaries(
  opts?: { limit?: number; search?: string },
  remote?: Remote,
): Promise<SelfHostedSourceSummary[]> {
  return withRemote(remote, async (pg) => {
    const sources: SelfHostedSourceSummary[] = [
      await selfHostedSourceSummary({
        id: "all",
        label: "All sources",
        kind: "all",
        badges: [],
      }, undefined, pg),
    ];

    const providerRows = await pg.all(
      `SELECT p.id, p.name, p.type, COALESCE(p.active, 1) AS active,
              EXISTS (
                SELECT 1 FROM inbound_emails inbound WHERE inbound.provider_id = p.id
                UNION ALL
                SELECT 1 FROM emails sent WHERE sent.provider_id = p.id
              ) AS has_mail
         FROM providers p
        ORDER BY p.name ASC`,
    ) as Array<{ id: string; name: string; type: string; active: unknown; has_mail: unknown }>;
    for (const provider of providerRows) {
      const hasMail = Boolean(provider.has_mail);
      const active = Boolean(provider.active);
      if (!active && !hasMail) continue;
      sources.push(await selfHostedSourceSummary({
        id: `provider:${provider.id}`,
        label: provider.type === "gmail"
          ? `Legacy Gmail import: ${provider.name}`
          : `Provider-tagged stream: ${provider.name}`,
        kind: provider.type === "gmail" ? "legacy" : "provider",
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        badges: [
          ...(provider.type === "gmail" ? ["legacy"] : []),
          active ? "active" : "inactive",
          `capability:${provider.type}`,
          ...(hasMail ? [] : ["empty"]),
        ],
      }, { sourceId: `provider:${provider.id}`, provider_id: provider.id }, pg));
    }

    const configuredBuckets = new Map(getInboundBuckets().map((bucket) => [bucket.bucket, bucket]));
    const rawS3Rows = await pg.all(
      "SELECT DISTINCT raw_s3_url FROM inbound_emails WHERE raw_s3_url LIKE 's3://%' ORDER BY raw_s3_url ASC LIMIT 5000",
    ) as Array<{ raw_s3_url: string | null }>;
    for (const row of rawS3Rows) {
      const bucket = parseS3BucketFromUrl(row.raw_s3_url);
      if (bucket && !configuredBuckets.has(bucket)) configuredBuckets.set(bucket, { bucket, region: "unknown" });
    }
    for (const bucket of [...configuredBuckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))) {
      sources.push(await selfHostedSourceSummary({
        id: `s3:${encodeURIComponent(bucket.bucket)}`,
        label: `S3 ingestion: ${bucket.bucket}`,
        kind: "s3",
        providerId: bucket.providerId,
        bucket: bucket.bucket,
        region: bucket.region,
        badges: ["configured", ...(bucket.providerId ? [] : ["legacy"])],
      }, { sourceId: `s3:${encodeURIComponent(bucket.bucket)}`, provider_id: bucket.providerId, s3Bucket: bucket.bucket }, pg));
    }

    const legacy = await selfHostedSourceSummary({
      id: "legacy",
      label: "Legacy/local mail",
      kind: "legacy",
      badges: ["legacy"],
    }, { sourceId: "legacy", legacy: true }, pg);
    if (legacy.total > 0) sources.push(legacy);

    const orphanRows = await pg.all(
      `SELECT DISTINCT mail.provider_id
         FROM (
           SELECT provider_id FROM inbound_emails WHERE provider_id IS NOT NULL
           UNION
           SELECT provider_id FROM emails WHERE provider_id IS NOT NULL
         ) mail
         LEFT JOIN providers p ON p.id = mail.provider_id
        WHERE p.id IS NULL
        ORDER BY mail.provider_id`,
    ) as Array<{ provider_id: string }>;
    for (const row of orphanRows) {
      sources.push(await selfHostedSourceSummary({
        id: `orphaned:${row.provider_id}`,
        label: `Orphaned source ${row.provider_id.slice(0, 8)}`,
        kind: "orphaned",
        providerId: row.provider_id,
        badges: ["orphaned"],
      }, { sourceId: `orphaned:${row.provider_id}`, provider_id: row.provider_id }, pg));
    }

    const query = opts?.search?.trim().toLowerCase();
    const filtered = query
      ? sources.filter((source) => [
          source.id,
          source.label,
          source.kind,
          source.providerId,
          source.providerName,
          source.providerType,
          source.bucket,
          ...source.badges,
        ].some((value) => String(value ?? "").toLowerCase().includes(query)))
      : sources;

    return filtered.slice(0, safeLimit(opts?.limit));
  });
}

export async function getSelfHostedInboxStatus(remote?: Remote): Promise<SelfHostedInboxStatus> {
  return withRemote(remote, async (pg) => {
    const filter = sourceFilter(undefined);
    const total = await countInbound(pg, "COALESCE(is_sent, 0) = 0");
    const unread = await countInbound(pg, COUNT_WHERE.unread);
    const latest_received_at = await latestInbound(pg, filter);
    const mailboxes = await getSelfHostedMailboxStatus(undefined, pg);
    const sources = await listSelfHostedSourceSummaries(undefined, pg);
    return {
      total,
      unread,
      latest_received_at,
      mailboxes,
      sources,
    };
  });
}

export async function setSelfHostedInboundRead(id: string, read: boolean, remote?: Remote): Promise<InboundEmail> {
  return withRemote(remote, async (pg) => {
    const fullId = await resolveSelfHostedInboundEmailId(id, pg);
    const readAt = read ? new Date().toISOString() : null;
    await pg.run("UPDATE inbound_emails SET is_read = ?, read_at = ? WHERE id = ?", read ? 1 : 0, readAt, fullId);
    await syncSelfHostedMailboxReadState(fullId, read, readAt, pg);
    const email = await getSelfHostedInboundEmail(fullId, pg);
    if (!email) throw new Error(`Email not found: ${id}`);
    return email;
  });
}

export async function setSelfHostedInboundArchived(id: string, archived: boolean, remote?: Remote): Promise<InboundEmailSummary> {
  return withRemote(remote, async (pg) => {
    const fullId = await resolveSelfHostedInboundEmailId(id, pg);
    await pg.run("UPDATE inbound_emails SET is_archived = ? WHERE id = ?", archived ? 1 : 0, fullId);
    await syncSelfHostedMailboxArchivedState(fullId, archived, pg);
    const email = await getSelfHostedInboundEmail(fullId, pg);
    if (!email) throw new Error(`Email not found: ${id}`);
    return summaryFromEmail(email);
  });
}

export async function setSelfHostedInboundStarred(id: string, starred: boolean, remote?: Remote): Promise<InboundEmailSummary> {
  return withRemote(remote, async (pg) => {
    const fullId = await resolveSelfHostedInboundEmailId(id, pg);
    await pg.run("UPDATE inbound_emails SET is_starred = ? WHERE id = ?", starred ? 1 : 0, fullId);
    await syncSelfHostedMailboxStarredState(fullId, starred, pg);
    const email = await getSelfHostedInboundEmail(fullId, pg);
    if (!email) throw new Error(`Email not found: ${id}`);
    return summaryFromEmail(email);
  });
}

async function mutateSelfHostedInboundLabel(id: string, label: string, remove: boolean, remote?: Remote): Promise<InboundEmailSummary> {
  return withRemote(remote, async (pg) => {
    const fullId = await resolveSelfHostedInboundEmailId(id, pg);
    const labels = await readSelfHostedInboundLabels(fullId, pg);
    const normalized = normalizeInboundLabel(label);
    const sameLabel = (value: string) => normalizeInboundLabel(value) === normalized;
    const next = remove
      ? labels.filter((current) => !sameLabel(current))
      : labels.some(sameLabel)
        ? labels
        : [...labels, label];
    const isSpam = next.some((current) => normalizeInboundLabel(current) === "spam");
    const isTrash = next.some((current) => normalizeInboundLabel(current) === "trash");
    await pg.run(
      "UPDATE inbound_emails SET label_ids_json = ?, is_spam = ?, is_trash = ? WHERE id = ?",
      JSON.stringify(next),
      isSpam ? 1 : 0,
      isTrash ? 1 : 0,
      fullId,
    );
    await pg.run("DELETE FROM inbound_labels WHERE inbound_email_id = ?", fullId);
    for (const current of next.map(normalizeInboundLabel).filter(Boolean)) {
      await pg.run(
        "INSERT INTO inbound_labels (inbound_email_id, label) VALUES (?, ?) ON CONFLICT DO NOTHING",
        fullId,
        current,
      );
    }
    await syncSelfHostedMailboxLabelState(fullId, next, pg);
    const email = await getSelfHostedInboundEmail(fullId, pg);
    if (!email) throw new Error(`Email not found: ${id}`);
    return summaryFromEmail(email);
  });
}

export async function addSelfHostedInboundLabel(id: string, label: string, remote?: Remote): Promise<InboundEmailSummary> {
  return mutateSelfHostedInboundLabel(id, label, false, remote);
}

export async function removeSelfHostedInboundLabel(id: string, label: string, remote?: Remote): Promise<InboundEmailSummary> {
  return mutateSelfHostedInboundLabel(id, label, true, remote);
}

export async function deleteSelfHostedInboundEmail(id: string, remote?: Remote): Promise<boolean> {
  return withRemote(remote, async (pg) => {
    const fullId = await resolveSelfHostedInboundEmailId(id, pg);
    const result = await pg.run("DELETE FROM inbound_emails WHERE id = ?", fullId);
    return (result?.changes ?? 0) > 0;
  });
}

export async function clearSelfHostedInboundEmails(providerId?: string, remote?: Remote): Promise<number> {
  return withRemote(remote, async (pg) => {
    const countRows = providerId
      ? await pg.all("SELECT COUNT(*) AS count FROM inbound_emails WHERE provider_id = ?", providerId)
      : await pg.all("SELECT COUNT(*) AS count FROM inbound_emails");
    const count = Number((countRows[0] as { count?: unknown } | undefined)?.count ?? 0) || 0;
    if (providerId) await pg.run("DELETE FROM inbound_emails WHERE provider_id = ?", providerId);
    else await pg.run("DELETE FROM inbound_emails");
    return count;
  });
}
