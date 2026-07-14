// MailDataSource — the read/write seam the TUI/CLI/MCP sit behind.
//
// This client is SELF-HOSTED-ONLY. There is exactly one backend:
//   • SelfHostedMailDataSource — pointed at an operator-owned server via a
//     configurable HTTPS base URL. It holds no DB credentials and reads/writes
//     only through the authenticated versioned HTTP API.
//
// The seam speaks the client's existing domain language (TuiMessage / Folder /
// MailboxCounts / MessageBody / …) so callers stay independent of the backend.

import { getEmailsMode, type EmailsMode } from "./mode.js";
import { SelfHostedMailDataSource, resolveSelfHostedMailDataSource } from "./self-hosted-mail-data-source.js";
import type {
  AttachmentPath,
  ConversationBodyOptions,
  LabelSummary,
  ListLabelSummaryOptions,
  ListMailboxSourcesOptions,
  Mailbox,
  MailboxCounts,
  MailboxListOptions,
  MailboxSource,
  MailboxSourceSummary,
  MailboxStatusOptions,
  MailboxStatusSummary,
  MessageBody,
  TuiMessage,
  TuiThreadBody,
  TuiThreadMessage,
} from "./mail-types.js";
import type {
  VerificationCodeCandidateOptions,
  VerificationCodeEmail,
  VerificationCodeMatch,
} from "./verification-code.js";

// ── seam-level DTOs (backend-agnostic) ───────────────────────────────────────

export type MailDataSourceMode = EmailsMode;

export interface MailChangesQuery {
  /** Watermark: only messages created-or-changed at/after this ISO timestamp. */
  since?: string;
  /** Folder scope. */
  mailbox?: Mailbox;
  /** Source/mailbox scope. */
  source?: MailboxSource;
  limit?: number;
  /**
   * Continuation cursor from a prior MailChanges.cursor. When the delta feed had
   * more than one call could drain, pass this back (with the SAME `since`) to resume
   * with no gap.
   */
  cursor?: string;
}

export interface MailChanges {
  /** Created-or-changed messages since the watermark (deduped by id). */
  messages: TuiMessage[];
  /** Ids tombstoned since the watermark. */
  deletedIds: string[];
  /** Continuation cursor if the delta feed had more (else null). */
  cursor: string | null;
  /** The advanced watermark to pass as `since` on the next call. */
  watermark: string | null;
}

export interface MailBulkInput {
  action: string;
  ids?: string[];
  mailbox?: Mailbox;
  source?: MailboxSource;
  label?: string;
  cursor?: string;
}

export interface MailBulkResult {
  action: string;
  affected: number;
  matched: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/** A base64 inline attachment for bounded self-hosted send. */
export interface MailSendAttachment {
  filename: string;
  /** base64-encoded content. */
  content: string;
  content_type: string;
}

export interface MailSendInput {
  from?: string;
  /** Comma-separated recipient list. */
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /**
   * Explicit HTML body. When set it is used verbatim as the HTML part (e.g. the CLI's
   * `--html`); otherwise `body` is markdown-rendered unless `markdown === false`.
   */
  html?: string;
  markdown?: boolean;
  /** outbound provider id (compat; self-hosted resolves the sender server-side). */
  providerId?: string;
  /** sending mailbox id (else resolved from `from`). */
  mailboxId?: string;
  /** Message id to reply to (threading). */
  replyToId?: string;
  /** Reply-To header address(es), comma-separated. */
  replyTo?: string;
  /** File attachments. Self-hosted JSON send enforces its documented caps. */
  attachments?: MailSendAttachment[];
  /** ISO-8601 schedule time. Self-hosted send rejects this (no server-side scheduling). */
  scheduledAt?: string;
  /** Stable caller-provided key used to make self-hosted sends retry-safe. */
  idempotencyKey?: string;
}

export interface MailSendResult {
  id: string;
  messageId: string;
}

/** Scope for a clear (bulk delete): resolves to a mailbox/folder filter. */
export interface MailClearFilter {
  /** Compat filter; resolves to a mailbox-id scope. */
  providerId?: string;
  /** Folder scope (defaults to inbox). */
  mailbox?: Mailbox;
  /** Mailbox/source scope. */
  source?: MailboxSource;
}

export interface MailClearResult {
  cleared: number;
}

export interface MailDataSource {
  readonly mode: MailDataSourceMode;

  /**
   * Resolve a possibly-partial id (the short id printed by `inbox list`) to a full id
   * usable on every read/write. Matches a unique id prefix over a bounded recent scan
   * (a full id is used verbatim).
   */
  resolveId(id: string): Promise<string>;

  // reads
  listMailbox(mailbox: Mailbox, opts?: MailboxListOptions): Promise<TuiMessage[]>;
  mailboxCounts(opts?: { source?: MailboxSource }): Promise<MailboxCounts>;
  listMailboxStatus(opts?: MailboxStatusOptions): Promise<MailboxStatusSummary>;
  listMailboxSources(opts?: ListMailboxSourcesOptions): Promise<MailboxSourceSummary[]>;
  getMessage(id: string): Promise<TuiMessage | null>;
  getMessageBody(msg: TuiMessage): Promise<MessageBody | null>;
  /**
   * Fetch a message AND its body from a SINGLE underlying row read. `read` needs
   * both, so this collapses getMessage()+getMessageBody() into one round-trip. The
   * `id` may be a short id prefix (the server resolves it). Returns null when no
   * message matches (a clean not-found).
   */
  getMessageWithBody(id: string): Promise<{ msg: TuiMessage; body: MessageBody } | null>;
  getConversation(msg: TuiMessage): Promise<TuiThreadMessage[]>;
  getConversationBodies(msg: TuiMessage, opts?: ConversationBodyOptions): Promise<TuiThreadBody[]>;
  getAttachmentPaths(id: string): Promise<AttachmentPath[]>;
  listLabelSummaries(opts?: ListLabelSummaryOptions): Promise<LabelSummary[]>;
  verificationCandidates(address: string, opts?: VerificationCodeCandidateOptions): Promise<VerificationCodeEmail[]>;
  findLatest(address: string, opts?: VerificationCodeCandidateOptions & { from?: string; subject?: string }): Promise<VerificationCodeMatch<VerificationCodeEmail> | null>;
  changesSince(opts?: MailChangesQuery): Promise<MailChanges>;

  // writes
  setRead(id: string, read: boolean): Promise<void>;
  setArchived(id: string, archived: boolean): Promise<void>;
  setStarred(id: string, starred: boolean): Promise<void>;
  addLabel(id: string, label: string): Promise<string[]>;
  removeLabel(id: string, label: string): Promise<string[]>;
  deleteMessage(id: string): Promise<void>;
  bulk(input: MailBulkInput): Promise<MailBulkResult>;
  send(input: MailSendInput): Promise<MailSendResult>;
  clear(filter?: MailClearFilter): Promise<MailClearResult>;
}

// ── resolver (memoized per process) ───────────────────────────────────────────

export interface ResolveMailDataSourceOptions {
  mode?: MailDataSourceMode;
  selfHosted?: SelfHostedMailDataSource;
}

let memoized: { mode: MailDataSourceMode; source: MailDataSource } | null = null;

/**
 * Resolve the process-wide MailDataSource. This client is self-hosted-only and
 * always uses the operator-configured Emails API; it never falls through to SQLite.
 */
export function resolveMailDataSource(opts: ResolveMailDataSourceOptions = {}): MailDataSource {
  const override = Boolean(opts.mode || opts.selfHosted);
  const mode = opts.mode ?? getEmailsMode();
  if (!override && memoized?.mode === mode) {
    return memoized.source;
  }
  const selfHosted = opts.selfHosted ?? resolveSelfHostedMailDataSource();
  if (!selfHosted) {
    throw new Error(
      "Emails self-hosted mode requires EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY " +
        "(or EMAILS_CLIENT_ENV_SECRET). No hosted endpoint is inferred.",
    );
  }
  const source: MailDataSource = selfHosted;
  if (!override) memoized = { mode, source };
  return source;
}

/** Clear the memoized data source (tests / after a mode change). */
export function resetMailDataSource(): void {
  memoized = null;
}
