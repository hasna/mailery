// MailDataSource — the read/write seam the TUI/CLI/MCP sit behind.
//
// There are exactly two fail-closed backends:
//   • SqliteMailDataSource — local SQLite, with no network/Postgres dependency.
//   • SelfHostedMailDataSource — authenticated operator-owned /v1 HTTP API.
//
// The seam speaks the client's existing domain language (TuiMessage / Folder /
// MailboxCounts / MessageBody / …) so callers stay independent of the backend.

import { getEmailsMode, type EmailsMode } from "./mode.js";
import { getDatabase, resolvePartialIdOrThrow } from "../db/database.js";
import { SelfHostedMailDataSource, resolveSelfHostedMailDataSource } from "./self-hosted-mail-data-source.js";
import {
  addInboundLabelSummary,
  clearInboundEmails,
  deleteInboundEmail,
  getInboundAttachmentPaths,
  getInboundEmailSummary,
  type InboundEmailSummary,
  listInboundEmailSummaries,
  removeInboundLabelSummary,
  setInboundArchivedFlag,
  setInboundReadFlag,
  setInboundStarredFlag,
} from "../db/inbound.local.js";
import {
  getConversation as localGetConversation,
  getConversationBodies as localGetConversationBodies,
  getMessageBody as localGetMessageBody,
  listLabelSummaries as localListLabelSummaries,
  listMailbox as localListMailbox,
  listMailboxSources as localListMailboxSources,
  listMailboxStatus as localListMailboxStatus,
  mailboxCounts as localMailboxCounts,
  sendComposed as localSendComposed,
} from "../cli/tui/data.local.js";
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
  ComposeInput,
} from "./mail-types.js";
import type {
  VerificationCodeCandidateOptions,
  VerificationCodeEmail,
  VerificationCodeMatch,
} from "./verification-code.js";
import { findVerificationCode, listVerificationCodeCandidates } from "./verification-code.local.js";
import {
  decodeAttachmentPayload,
  normalizeAttachmentByteLimit,
  type AttachmentContent,
} from "./attachment-download.js";
import { constants as fsConstants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { basename } from "node:path";

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

/** A base64 inline attachment for local/provider or bounded self-hosted send. */
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
  /** local outbound provider id; self-hosted resolves the sender server-side. */
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

/** Scope for a clear (bulk delete): local optionally scopes by provider. */
export interface MailClearFilter {
  /** Local provider filter; self-hosted resolves this to a mailbox-id scope. */
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
   * Resolve a possibly-partial id to a full id in the selected backend only.
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
  getAttachmentContent(id: string, index: number, opts?: { maxBytes?: number }): Promise<AttachmentContent>;
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

// ── local SQLite backend ────────────────────────────────────────────────────

function summaryToTuiMessage(summary: InboundEmailSummary): TuiMessage {
  const labels = summary.label_ids ?? [];
  return {
    kind: summary.is_sent ? "sent" : "inbound",
    id: summary.id,
    from: summary.from_address,
    to: (summary.to_addresses ?? []).join(", "),
    subject: summary.subject || "(no subject)",
    date: summary.received_at,
    is_read: summary.is_sent ? true : Boolean(summary.is_read),
    is_starred: Boolean(summary.is_starred),
    labels,
    snippet: "",
    thread_id: summary.thread_id ?? null,
    provider_thread_id: summary.provider_thread_id ?? null,
    attachments: summary.attachments?.length ?? 0,
    sentByMe: summary.is_sent || labels.some((label) => label.trim().toLowerCase() === "sent"),
  };
}

const LOCAL_BULK_MAX = 1000;
type LocalFlagSetter = (id: string) => void;
const LOCAL_BULK_FLAG_ACTIONS: Record<string, LocalFlagSetter> = {
  markRead: (id) => { setInboundReadFlag(id, true); },
  markUnread: (id) => { setInboundReadFlag(id, false); },
  star: (id) => { setInboundStarredFlag(id, true); },
  unstar: (id) => { setInboundStarredFlag(id, false); },
  archive: (id) => { setInboundArchivedFlag(id, true); },
  unarchive: (id) => { setInboundArchivedFlag(id, false); },
  delete: (id) => { deleteInboundEmail(id); },
};

export class SqliteMailDataSource implements MailDataSource {
  readonly mode = "local" as const;

  async resolveId(id: string): Promise<string> {
    return resolvePartialIdOrThrow(getDatabase(), "inbound_emails", id);
  }

  async listMailbox(mailbox: Mailbox, opts?: MailboxListOptions): Promise<TuiMessage[]> {
    return localListMailbox(mailbox, opts);
  }

  async mailboxCounts(opts?: { source?: MailboxSource }): Promise<MailboxCounts> {
    return localMailboxCounts(opts);
  }

  async listMailboxStatus(opts?: MailboxStatusOptions): Promise<MailboxStatusSummary> {
    return localListMailboxStatus(opts);
  }

  async listMailboxSources(opts?: ListMailboxSourcesOptions): Promise<MailboxSourceSummary[]> {
    return localListMailboxSources(opts);
  }

  async getMessage(id: string): Promise<TuiMessage | null> {
    const summary = getInboundEmailSummary(id);
    return summary ? summaryToTuiMessage(summary) : null;
  }

  async getMessageBody(msg: TuiMessage): Promise<MessageBody | null> {
    return localGetMessageBody(msg);
  }

  async getMessageWithBody(id: string): Promise<{ msg: TuiMessage; body: MessageBody } | null> {
    const msg = await this.getMessage(id);
    if (!msg) return null;
    const body = await this.getMessageBody(msg);
    return body ? { msg, body } : null;
  }

  async getConversation(msg: TuiMessage): Promise<TuiThreadMessage[]> {
    return localGetConversation(msg);
  }

  async getConversationBodies(msg: TuiMessage, opts?: ConversationBodyOptions): Promise<TuiThreadBody[]> {
    return localGetConversationBodies(msg, undefined, opts);
  }

  async getAttachmentPaths(id: string): Promise<AttachmentPath[]> {
    return getInboundAttachmentPaths(id) ?? [];
  }

  async getAttachmentContent(id: string, index: number, opts?: { maxBytes?: number }): Promise<AttachmentContent> {
    const limit = normalizeAttachmentByteLimit(opts?.maxBytes);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("attachment index must be a non-negative integer");
    const msg = await this.getMessage(id);
    if (!msg) return { state: "not_found", index };
    const body = await this.getMessageBody(msg);
    const metadata = body?.attachments[index];
    if (!metadata) return { state: "not_found", index };
    const paths = await this.getAttachmentPaths(id);
    const unavailable = () => decodeAttachmentPayload(
      { code: "attachment_content_unavailable", attachment: metadata },
      index,
      limit,
    );
    const indexed = paths.filter((entry) => entry.index === index);
    let path: string | undefined;
    if (indexed.length > 0) {
      if (indexed.length !== 1) return unavailable();
      const candidate = indexed[0]!;
      if (candidate.filename !== metadata.filename
        || candidate.content_type !== metadata.content_type
        || candidate.size !== metadata.size) {
        return unavailable();
      }
      path = candidate.local_path;
    } else {
      const legacySanitize = (filename: string) => filename.replace(/[/\\?%*:|"<>]/g, "_");
      const targetAliases = new Set([metadata.filename, legacySanitize(metadata.filename)]);
      const matchingMetadata = body!.attachments.filter((entry) => {
        const aliases = [entry.filename, legacySanitize(entry.filename)];
        return aliases.some((alias) => targetAliases.has(alias));
      });
      const legacyPaths = paths.filter((entry) => {
        if (entry.index !== undefined) return false;
        const aliases = [
          entry.filename,
          entry.local_path ? basename(entry.local_path) : undefined,
          entry.s3_url ? basename(entry.s3_url) : undefined,
        ].filter((alias): alias is string => typeof alias === "string");
        return aliases.some((alias) => targetAliases.has(alias));
      });
      if (matchingMetadata.length !== 1 || matchingMetadata[0] !== metadata || legacyPaths.length !== 1) {
        return unavailable();
      }
      const candidate = legacyPaths[0]!;
      if ((candidate.content_type && candidate.content_type !== metadata.content_type)
        || candidate.size !== metadata.size) {
        return unavailable();
      }
      path = candidate.local_path;
    }
    if (!path) {
      return unavailable();
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const file = await openFile(path, fsConstants.O_RDONLY | noFollow);
    let data: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("attachment path is not a regular file");
      if (stat.size > limit) throw new Error(`attachment exceeds byte limit ${limit}`);
      data = await file.readFile();
    } finally {
      await file.close();
    }
    return decodeAttachmentPayload({
      attachment: {
        filename: metadata.filename,
        content_type: metadata.content_type,
        // Preserve the authenticated/stored declaration so the strict decoder
        // detects a file that drifted after metadata was recorded.
        size: metadata.size,
        content_base64: data.toString("base64"),
      },
    }, index, limit);
  }

  async listLabelSummaries(opts?: ListLabelSummaryOptions): Promise<LabelSummary[]> {
    return localListLabelSummaries(opts);
  }

  async verificationCandidates(address: string, opts?: VerificationCodeCandidateOptions): Promise<VerificationCodeEmail[]> {
    return listVerificationCodeCandidates(address, opts);
  }

  async findLatest(address: string, opts?: VerificationCodeCandidateOptions & { from?: string; subject?: string }): Promise<VerificationCodeMatch<VerificationCodeEmail> | null> {
    const candidates = await this.verificationCandidates(address, opts);
    return findVerificationCode(candidates, { from: opts?.from, subject: opts?.subject });
  }

  async changesSince(opts?: MailChangesQuery): Promise<MailChanges> {
    const summaries = listInboundEmailSummaries({ since: opts?.since, limit: opts?.limit ?? 200 });
    const messages = summaries.map(summaryToTuiMessage);
    const watermark = messages.reduce<string | null>(
      (max, msg) => max === null || msg.date > max ? msg.date : max,
      opts?.since ?? null,
    );
    return { messages, deletedIds: [], cursor: null, watermark };
  }

  async setRead(id: string, read: boolean): Promise<void> { setInboundReadFlag(id, read); }
  async setArchived(id: string, archived: boolean): Promise<void> { setInboundArchivedFlag(id, archived); }
  async setStarred(id: string, starred: boolean): Promise<void> { setInboundStarredFlag(id, starred); }
  async addLabel(id: string, label: string): Promise<string[]> { return addInboundLabelSummary(id, label).label_ids; }
  async removeLabel(id: string, label: string): Promise<string[]> { return removeInboundLabelSummary(id, label).label_ids; }
  async deleteMessage(id: string): Promise<void> { deleteInboundEmail(id); }

  async bulk(input: MailBulkInput): Promise<MailBulkResult> {
    const setter = LOCAL_BULK_FLAG_ACTIONS[input.action];
    if (!setter) throw new Error(`unsupported local bulk action '${input.action}'`);
    const ids = input.ids?.length
      ? input.ids.slice(0, LOCAL_BULK_MAX)
      : (await this.listMailbox(input.mailbox ?? "inbox", { source: input.source, limit: LOCAL_BULK_MAX })).map((row) => row.id);
    let affected = 0;
    for (const id of ids) {
      try { setter(id); affected += 1; } catch { /* row disappeared between list and write */ }
    }
    return { action: input.action, affected, matched: ids.length, hasMore: false, nextCursor: null };
  }

  async send(input: MailSendInput): Promise<MailSendResult> {
    if (input.scheduledAt) {
      throw new Error("Scheduled sends must use the local schedule command; immediate mail-data-source send does not enqueue jobs.");
    }
    let replyTo: TuiMessage | undefined;
    if (input.replyToId) replyTo = (await this.getMessage(input.replyToId)) ?? undefined;
    const compose: ComposeInput = {
      from: input.from ?? "",
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      replyToAddress: input.replyTo,
      subject: input.subject,
      body: input.body,
      html: input.html,
      attachments: input.attachments,
      idempotencyKey: input.idempotencyKey,
      providerId: input.providerId,
      markdown: input.markdown,
      replyTo,
    };
    return localSendComposed(compose);
  }

  async clear(filter?: MailClearFilter): Promise<MailClearResult> {
    return { cleared: clearInboundEmails(filter?.providerId) };
  }
}

// ── resolver (memoized per process) ───────────────────────────────────────────

export interface ResolveMailDataSourceOptions {
  mode?: MailDataSourceMode;
  selfHosted?: SelfHostedMailDataSource;
}

let memoized: { mode: MailDataSourceMode; source: MailDataSource } | null = null;

/**
 * Resolve exactly one process-wide backend. Self-hosted never falls through to
 * SQLite; local never consults URL/API-key configuration.
 */
export function resolveMailDataSource(opts: ResolveMailDataSourceOptions = {}): MailDataSource {
  const override = Boolean(opts.mode || opts.selfHosted);
  const mode = opts.mode ?? getEmailsMode();
  if (!override && memoized?.mode === mode) {
    return memoized.source;
  }
  let source: MailDataSource;
  if (mode === "self_hosted") {
    const selfHosted = opts.selfHosted ?? resolveSelfHostedMailDataSource();
    if (!selfHosted) {
      throw new Error(
        "Emails self-hosted mode requires EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY " +
          "(or EMAILS_CLIENT_ENV_SECRET). No hosted endpoint is inferred.",
      );
    }
    source = selfHosted;
  } else {
    source = new SqliteMailDataSource();
  }
  if (!override) memoized = { mode, source };
  return source;
}

/** Clear the memoized data source (tests / after a mode change). */
export function resetMailDataSource(): void {
  memoized = null;
}
