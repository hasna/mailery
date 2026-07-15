// Shared mail domain types + PURE helpers.
//
// Extracted from src/cli/tui/data.ts (and AttachmentPath from src/db/inbound.ts)
// so the self-hosted mail data source, the CLI/MCP inbox layer, and the TUI can
// share one pure, storage-independent vocabulary. NOTHING here touches a
// database, the filesystem, config, S3, or the network — it is safe to import
// from anywhere.

import { marked } from "marked";

// ── folders / mailboxes ───────────────────────────────────────────────────────

export type Folder = "inbox" | "unread" | "starred" | "sent" | "archived" | "spam" | "trash";
export type Mailbox = Folder;

export const FOLDERS: Folder[] = ["inbox", "unread", "starred", "sent", "archived", "spam", "trash"];
export const MAILBOXES: Mailbox[] = FOLDERS;

export function normalizeMailbox(value: unknown): Mailbox {
  return MAILBOXES.includes(value as Mailbox) ? (value as Mailbox) : "inbox";
}

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

// ── small numeric/date coercers (pure) ────────────────────────────────────────

export function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : fallback;
}

export function nonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

export function normalizeIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid date: ${value}`);
  return new Date(time).toISOString();
}

export function snippetOf(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

// ── message DTOs ──────────────────────────────────────────────────────────────

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

/** Attachment path metadata as persisted with a message (from src/db/inbound.ts). */
export interface AttachmentPath {
  /** Stable 0-based identity for newly persisted attachment paths. */
  index?: number;
  filename: string;
  content_type: string;
  size: number;
  /** Local file path, e.g. ~/.hasna/emails/attachments/<email_id>/filename */
  local_path?: string;
  /** S3 URL if uploaded, e.g. s3://bucket/emails/<email_id>/filename */
  s3_url?: string;
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

// ── mailbox sources & counts ──────────────────────────────────────────────────

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

export interface MailboxListOptions {
  limit?: number;
  offset?: number;
  since?: string;
  search?: string;
  label?: string;
  source?: MailboxSource;
  sort?: "newest" | "oldest";
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

export function emptyMailboxCounts(): MailboxCounts {
  return { inbox: 0, unread: 0, starred: 0, sent: 0, archived: 0, spam: 0, trash: 0 };
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
   * Include each source's latest-received timestamp. In self_hosted mode this costs
   * an extra HTTP round-trip PER source, so the status path (which only shows the
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

// ── message body ──────────────────────────────────────────────────────────────

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

/** Merge attachment metadata with downloaded-path info (local/s3 location). */
export function mergeAttachments(
  meta: { filename: string; content_type: string; size: number }[],
  paths: { index?: number; filename: string; local_path?: string; s3_url?: string }[],
): AttachmentInfo[] {
  return meta.map((attachment, index) => {
    const indexed = paths.filter((path) => path.index === index);
    let path: (typeof paths)[number] | undefined;
    if (indexed.length > 0) {
      if (indexed.length === 1 && indexed[0]!.filename === attachment.filename) path = indexed[0];
    } else {
      const legacy = paths.filter((candidate) =>
        candidate.index === undefined && candidate.filename === attachment.filename);
      if (legacy.length === 1) path = legacy[0];
    }
    return {
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
      location: path?.local_path ?? path?.s3_url,
    };
  });
}

export function htmlToPlainText(value: string | null | undefined): string {
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

export function normalizeSummary(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 360) : null;
}

export function fallbackMessageSummary(subject: string, text: string | null | undefined, html: string | null | undefined): string {
  const topic = (subject || "(no subject)").replace(/\s+/g, " ").trim();
  const plain = ((text ?? "").trim() || htmlToPlainText(html)).replace(/\s+/g, " ").trim();
  const excerpt = plain && plain.toLowerCase() !== topic.toLowerCase()
    ? plain.slice(0, 180).replace(/\s+\S*$/, "").trim()
    : "";
  if (excerpt) return `About ${topic}: ${excerpt}.`;
  return `About ${topic}.`;
}

// ── labels ────────────────────────────────────────────────────────────────────

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

export function normalizeLabel(label: string): string {
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

// ── grouping ──────────────────────────────────────────────────────────────────

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

// ── compose / reply ────────────────────────────────────────────────────────────

export interface ConversationBodyOptions {
  limit?: number;
}

export interface ComposeInput {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  replyToAddress?: string;
  subject: string;
  body: string;
  /** Explicit HTML body; otherwise markdown rendering follows `markdown`. */
  html?: string;
  attachments?: Array<{ filename: string; content: string; content_type: string }>;
  idempotencyKey?: string;
  providerId?: string;
  markdown?: boolean;
  replyTo?: TuiMessage;
}

/** Pre-fill values for replying to a message. */
export function replyDefaults(msg: TuiMessage): { from: string; to: string; subject: string } {
  const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
  const to = msg.sentByMe ? msg.to : msg.from;
  const from = msg.sentByMe ? msg.from : (msg.to.split(",")[0]?.trim() ?? "");
  return { from, to, subject };
}

/** Render markdown body to a simple, email-safe HTML document. */
export function renderMarkdown(md: string): string {
  // marked is synchronous in default mode; wrap output in a minimal HTML shell.
  const inner = marked.parse(md, { async: false, gfm: true, breaks: true }) as string;
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">${inner}</body></html>`;
}
