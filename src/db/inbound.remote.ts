// Inbound (received + imported-sent) mail repository — self-hosted-ONLY.
//
// Every read/write routes to the operator's `/v1/messages` API. There is no
// local SQLite island. The `/v1` message row is snake_case and unifies inbound
// and outbound mail:
//   from_address <-> from_addr, to_addresses <-> to_addrs, cc_addresses <-> cc_addrs,
//   text_body <-> body_text, html_body <-> body_html, label_ids <-> labels,
//   is_sent <-> (direction === "outbound"). There is NO thread_id column
//   (threads are server-derived by normalized subject), and no provider/owner
//   dimension on a message — those local-only fields map to null/default.
//
// Filters/sorts/counts with no direct query surface fetch a bounded page window
// and are applied in JS. Owner-scoped queries and local attachment-path writes
// have no `/v1` equivalent and are stubbed per the self-hosted contract (rule 6).

import { cappedLimit, safeLimit, safeOffset, safeOptionalLimit } from "./pagination.js";
import { now, uuid } from "./runtime.js";
import {
  selfHostedResource,
  carray,
  cbool,
  cnum,
  cobj,
  cstr,
  cstrArray,
  cstrOrNull,
  ciso,
} from "./self-hosted-resource.js";
import type { AttachmentPath } from "../lib/mail-types.js";
export type { AttachmentPath } from "../lib/mail-types.js";

const MESSAGE_RESOURCE = "messages";

// Bounded scan window for filters/counts/reply-resolution that have no direct
// server query. Large enough for a real mailbox without an unbounded walk.
const INBOUND_SCAN_PAGE = 500;
const INBOUND_SCAN_CAP = 10000;

export interface AttachmentMeta {
  filename: string;
  content_type: string;
  size: number;
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

// ── /v1 message row helpers ────────────────────────────────────────────────

function messagesStore() {
  return selfHostedResource(MESSAGE_RESOURCE);
}

function scanMessages(query: Record<string, string | number | boolean | undefined> = {}): Record<string, unknown>[] {
  const store = messagesStore();
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < INBOUND_SCAN_CAP; offset += INBOUND_SCAN_PAGE) {
    const page = store.list({ ...query, limit: INBOUND_SCAN_PAGE, offset });
    rows.push(...page);
    if (page.length < INBOUND_SCAN_PAGE) break;
  }
  return rows;
}

function v1Labels(row: Record<string, unknown>): string[] {
  return cstrArray(row["labels"]);
}

function v1IsOutbound(row: Record<string, unknown>): boolean {
  return cstr(row["direction"]).toLowerCase() === "outbound";
}

function v1HasLabel(row: Record<string, unknown>, name: string): boolean {
  return v1Labels(row).some((l) => l.trim().toLowerCase() === name);
}

/** Sort/compare key: received_at, falling back to created_at (empty if neither). */
function v1MsgDate(row: Record<string, unknown>): string {
  return cstrOrNull(row["received_at"]) ?? cstrOrNull(row["created_at"]) ?? "";
}

function v1Attachments(row: Record<string, unknown>): AttachmentMeta[] {
  const metadata = carray(row["attachments"]).map((attachment, index) => {
    const o = cobj(attachment);
    return {
      filename: cstr(o["filename"]) || `attachment-${index + 1}`,
      content_type: cstr(o["content_type"]) || "application/octet-stream",
      size: cnum(o["size"]),
    };
  });
  if (metadata.length > 0) return metadata;
  // List rows carry only attachment_count (the metadata array moved to the
  // single-message read): preserve COUNT semantics with placeholder entries;
  // real filenames arrive when the caller fetches the full message.
  const count = cnum(row["attachment_count"]);
  return Array.from({ length: Number.isFinite(count) && count > 0 ? count : 0 }, (_, index) => ({
    filename: `attachment-${index + 1}`,
    content_type: "application/octet-stream",
    size: 0,
  }));
}

function bareId(value: string): string {
  return value.replace(/[<>]/g, "").trim();
}

function apiToInboundEmail(row: Record<string, unknown>): InboundEmail {
  const isRead = cbool(row["is_read"]);
  const outbound = v1IsOutbound(row);
  const attachments = v1Attachments(row);
  const receivedAt = cstrOrNull(row["received_at"]) ?? ciso(row["created_at"]);
  return {
    id: cstr(row["id"]),
    provider_id: cstrOrNull(row["provider_id"]),
    message_id: cstrOrNull(row["message_id"]),
    in_reply_to_email_id: null,
    provider_thread_id: null,
    thread_id: null,
    provider_history_id: null,
    provider_internal_date: null,
    label_ids: v1Labels(row),
    raw_s3_url: null,
    metadata_s3_url: null,
    from_address: cstr(row["from_addr"]),
    to_addresses: cstrArray(row["to_addrs"]),
    cc_addresses: cstrArray(row["cc_addrs"]),
    subject: cstr(row["subject"]),
    text_body: cstrOrNull(row["body_text"]),
    html_body: cstrOrNull(row["body_html"]),
    attachments,
    attachment_paths: attachments.map((a) => ({ filename: a.filename, content_type: a.content_type, size: a.size })),
    headers: cobj(row["headers"]) as Record<string, string>,
    raw_size: cnum(row["raw_size"]),
    is_read: isRead,
    read_at: isRead ? receivedAt : null,
    is_archived: v1HasLabel(row, "archived"),
    is_starred: cbool(row["is_starred"]),
    is_sent: outbound,
    received_at: receivedAt,
    created_at: ciso(row["created_at"], receivedAt),
  };
}

function apiToInboundEmailSummary(row: Record<string, unknown>): InboundEmailSummary {
  const { text_body: _t, html_body: _h, headers: _hd, ...summary } = apiToInboundEmail(row);
  return summary;
}

// ── pure address helpers (storage-independent) ─────────────────────────────

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

function normalizeInboundLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
}

// ── writes ─────────────────────────────────────────────────────────────────

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
): InboundEmail {
  const labels = input.label_ids ?? [];
  // Imported sent mail carries the SENT label — persist it as an outbound
  // message so it lands in the Sent folder, not the inbox.
  const isSent = labels.some((label) => label.trim().toLowerCase() === "sent");
  const receivedAt = input.received_at || now();
  const attachmentPaths = (input as InboundEmail).attachment_paths ?? [];

  const created = messagesStore().create({
    id: uuid(),
    direction: isSent ? "outbound" : "inbound",
    from_addr: input.from_address,
    to_addrs: input.to_addresses,
    cc_addrs: input.cc_addresses,
    subject: input.subject,
    body_text: input.text_body,
    body_html: input.html_body,
    message_id: input.message_id,
    received_at: receivedAt,
    labels,
    headers: input.headers,
    attachments: input.attachments,
    created_at: now(),
  });

  const id = cstr(created["id"]) || uuid();
  return {
    id,
    provider_id: input.provider_id ?? null,
    message_id: input.message_id ?? null,
    in_reply_to_email_id: input.in_reply_to_email_id ?? null,
    provider_thread_id: input.provider_thread_id ?? null,
    thread_id: input.thread_id ?? null,
    provider_history_id: input.provider_history_id ?? null,
    provider_internal_date: input.provider_internal_date ?? null,
    label_ids: labels,
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
    is_sent: isSent,
    received_at: receivedAt,
    created_at: ciso(created["created_at"], receivedAt),
  };
}

/** Local attachment-path bookkeeping has no /v1 field (attachments live on the server). */
export function updateAttachmentPaths(_id: string, _paths: AttachmentPath[]): void {
  throw new Error(
    "updateAttachmentPaths is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

// ── replies ─────────────────────────────────────────────────────────────────

export interface ListRepliesOptions {
  limit?: number;
  offset?: number;
}

export interface ReplyPromptPart {
  from_address: string;
  subject: string;
  text_body: string | null;
}

/** Messages that reply to `emailId`, matched by In-Reply-To against its Message-ID. */
function repliesToEmail(emailId: string): Record<string, unknown>[] {
  const target = messagesStore().get(emailId);
  if (!target) return [];
  const targetMsgId = bareId(cstr(target["message_id"]));
  if (!targetMsgId) return [];
  return scanMessages()
    .filter((row) => {
      const irt = bareId(cstr(row["in_reply_to"]));
      return !!irt && irt === targetMsgId;
    })
    .sort((a, b) => v1MsgDate(a).localeCompare(v1MsgDate(b)));
}

// repliesToEmail matches on LIST rows, which carry no body (the serve moved
// bodies to the per-message read). Anything that needs body text must re-read the
// selected rows by id — after slicing, so a page of replies costs a page of
// reads, not one per candidate.
function hydrateBody(row: Record<string, unknown>): Record<string, unknown> {
  const id = cstr(row["id"]);
  if (!id) return row;
  return messagesStore().get(id) ?? row;
}

export function listReplies(emailId: string, opts?: ListRepliesOptions): InboundEmail[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  let rows = repliesToEmail(emailId);
  if (limit !== null) rows = rows.slice(offset, offset + limit);
  return rows.map(hydrateBody).map(apiToInboundEmail);
}

export function listReplySummaries(emailId: string, opts?: ListRepliesOptions): InboundEmailSummary[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  let rows = repliesToEmail(emailId);
  if (limit !== null) rows = rows.slice(offset, offset + limit);
  return rows.map(apiToInboundEmailSummary);
}

export function listReplyPromptParts(emailId: string, opts?: ListRepliesOptions): ReplyPromptPart[] {
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  let rows = repliesToEmail(emailId);
  if (limit !== null) rows = rows.slice(offset, offset + limit);
  return rows.map(hydrateBody).map((row) => ({
    from_address: cstr(row["from_addr"]),
    subject: cstr(row["subject"]),
    text_body: cstrOrNull(row["body_text"]),
  }));
}

export function getReplyCount(emailId: string): number {
  return repliesToEmail(emailId).length;
}

// ── single reads ─────────────────────────────────────────────────────────────

export function getInboundEmail(id: string): InboundEmail | null {
  const row = messagesStore().get(id);
  return row ? apiToInboundEmail(row) : null;
}

export function getInboundEmailSummary(id: string): InboundEmailSummary | null {
  const row = messagesStore().get(id);
  return row ? apiToInboundEmailSummary(row) : null;
}

export function getInboundAttachmentPaths(id: string): AttachmentPath[] | null {
  const row = messagesStore().get(id);
  if (!row) return null;
  return v1Attachments(row).map((a) => ({ filename: a.filename, content_type: a.content_type, size: a.size }));
}

export function listInboundSubjectsForRecipient(
  recipient: string,
  opts?: { since?: string; limit?: number },
): Array<{ subject: string }> {
  const normalized = normalizeEmailAddress(recipient);
  if (!normalized) return [];
  const limit = cappedLimit(opts?.limit, 100, 10000);
  const since = opts?.since ? Date.parse(opts.since) : null;
  return scanMessages()
    .filter((row) => {
      if (v1IsOutbound(row) || v1HasLabel(row, "archived")) return false;
      const toAddrs = cstrArray(row["to_addrs"]).map((a) => normalizeEmailAddress(a)).filter((a): a is string => !!a);
      if (!toAddrs.includes(normalized)) return false;
      if (since != null) {
        const t = Date.parse(v1MsgDate(row));
        if (!(Number.isFinite(t) && t >= since)) return false;
      }
      return true;
    })
    .sort((a, b) => v1MsgDate(b).localeCompare(v1MsgDate(a)))
    .slice(0, limit)
    .map((row) => ({ subject: cstr(row["subject"]) }));
}

// ── list / filter ─────────────────────────────────────────────────────────────

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

// Note: `provider_id` scoping has no self-hosted equivalent (a message carries no
// provider dimension over /v1); the filter is ignored rather than emptying views.
function inboundRowMatches(row: Record<string, unknown>, opts: ListInboundOpts | undefined): boolean {
  const outbound = v1IsOutbound(row);
  const archived = v1HasLabel(row, "archived");

  if (!opts?.includeSent) {
    if (opts?.sent) { if (!outbound) return false; }
    else if (outbound) return false;
  }
  if (opts?.archived) { if (!archived) return false; }
  else if (archived) return false;

  if (opts?.unread && cbool(row["is_read"])) return false;
  if (opts?.read && !cbool(row["is_read"])) return false;
  if (opts?.starred && !cbool(row["is_starred"])) return false;

  if (opts?.since) {
    const t = Date.parse(v1MsgDate(row));
    if (!(Number.isFinite(t) && t >= Date.parse(opts.since))) return false;
  }
  if (opts?.label) {
    const want = normalizeInboundLabel(opts.label);
    if (!v1Labels(row).some((l) => normalizeInboundLabel(l) === want)) return false;
  }
  const from = opts?.from?.trim().toLowerCase();
  if (from && !cstr(row["from_addr"]).toLowerCase().includes(from)) return false;
  const subject = opts?.subject?.trim().toLowerCase();
  if (subject && !cstr(row["subject"]).toLowerCase().includes(subject)) return false;
  const search = opts?.search?.trim().toLowerCase();
  if (search) {
    const hay = [
      cstr(row["from_addr"]),
      cstrArray(row["to_addrs"]).join(" "),
      cstr(row["subject"]),
      cstr(row["body_text"]),
      cstr(row["snippet"]),
    ].join(" ").toLowerCase();
    if (!hay.includes(search)) return false;
  }

  const reqRecip = (opts?.recipients ?? []).length > 0;
  const reqDom = (opts?.recipientDomains ?? []).length > 0;
  if (reqRecip || reqDom) {
    const recip = (opts?.recipients ?? []).map((r) => normalizeEmailAddress(r)).filter((r): r is string => !!r);
    const doms = (opts?.recipientDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (recip.length === 0 && doms.length === 0) return false;
    const toAddrs = cstrArray(row["to_addrs"]).map((a) => normalizeEmailAddress(a)).filter((a): a is string => !!a);
    const matchAddr = recip.length > 0 && toAddrs.some((a) => recip.includes(a));
    const matchDom = doms.length > 0 && toAddrs.some((a) => {
      const d = a.split("@").pop();
      return d ? doms.includes(d) : false;
    });
    if (!matchAddr && !matchDom) return false;
  }
  return true;
}

function listFilteredInbound(opts?: ListInboundOpts): Record<string, unknown>[] {
  const limit = safeLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  return scanMessages()
    .filter((row) => inboundRowMatches(row, opts))
    .sort((a, b) => v1MsgDate(b).localeCompare(v1MsgDate(a)))
    .slice(offset, offset + limit);
}

export function listInboundEmails(opts?: ListInboundOpts): InboundEmail[] {
  return listFilteredInbound(opts).map(apiToInboundEmail);
}

export function listInboundEmailSummaries(opts?: ListInboundOpts): InboundEmailSummary[] {
  return listFilteredInbound(opts).map(apiToInboundEmailSummary);
}

// Owner-scoped queries resolve owner→address/alias joins that have no single /v1
// mapping (ownership is server-side); stubbed per the self-hosted contract.
export function listInboundEmailsForOwner(_ownerId: string, _opts?: Omit<ListInboundOpts, "recipients" | "recipientDomains">): InboundEmail[] {
  throw new Error(
    "listInboundEmailsForOwner is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function listInboundEmailSummariesForOwner(_ownerId: string, _opts?: Omit<ListInboundOpts, "recipients" | "recipientDomains">): InboundEmailSummary[] {
  throw new Error(
    "listInboundEmailSummariesForOwner is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

export function inboundEmailBelongsToOwner(_id: string, _ownerId: string): boolean {
  throw new Error(
    "inboundEmailBelongsToOwner is not available in the self-hosted client; it runs on the self-hosted server.",
  );
}

// ── delete / clear ────────────────────────────────────────────────────────────

export function deleteInboundEmail(id: string): boolean {
  return messagesStore().del(id);
}

// Provider scoping cannot be expressed over /v1, so a provider-scoped clear is a
// no-op (returns 0) rather than risking an over-broad delete of the shared store.
export function clearInboundEmails(provider_id?: string): number {
  if (provider_id) return 0;
  const store = messagesStore();
  const ids = scanMessages().map((row) => cstr(row["id"])).filter(Boolean);
  let count = 0;
  for (const id of ids) {
    if (store.del(id)) count += 1;
  }
  return count;
}

// ── counts ─────────────────────────────────────────────────────────────────────

// provider_id scoping is ignored (no provider dimension over /v1); counts reflect
// the whole operator-owned store.
export function getInboundCount(_provider_id?: string): number {
  return scanMessages().length;
}

export function getReceivedInboundCount(_provider_id?: string): number {
  return scanMessages().filter((row) => !v1IsOutbound(row)).length;
}

export function getLatestInboundReceivedAt(): string | null {
  let latest: string | null = null;
  for (const row of scanMessages()) {
    const d = v1MsgDate(row);
    if (d && (latest === null || d > latest)) latest = d;
  }
  return latest;
}

export function getLatestReceivedInboundAt(): string | null {
  let latest: string | null = null;
  for (const row of scanMessages()) {
    if (v1IsOutbound(row)) continue;
    const d = v1MsgDate(row);
    if (d && (latest === null || d > latest)) latest = d;
  }
  return latest;
}

/** Count unread, non-archived received mail. */
export function getUnreadCount(_provider_id?: string): number {
  return scanMessages().filter((row) =>
    !v1IsOutbound(row) && !cbool(row["is_read"]) && !v1HasLabel(row, "archived"),
  ).length;
}

// ── read / archive / star flags ────────────────────────────────────────────────

export function setInboundRead(id: string, read: boolean): InboundEmail {
  return apiToInboundEmail(messagesStore().update(id, { is_read: read }));
}

export function setInboundReadSummary(id: string, read: boolean): InboundEmailSummary {
  return apiToInboundEmailSummary(messagesStore().update(id, { is_read: read }));
}

export function setInboundReadFlag(id: string, read: boolean): boolean {
  messagesStore().update(id, { is_read: read });
  return read;
}

// The archived STATE is derived on read from the `archived` LABEL (v1HasLabel),
// so the write must move that label — not set an out-of-band `archived` field the
// read path never consults. We PATCH the recomputed `labels` array (which the
// generic /v1 store persists and the read derives from) AND keep the `archived`
// convenience field the authoritative server understands, so the round-trip holds
// against both the generic resource store and the server's message endpoint.
function setInboundArchivedState(id: string, archived: boolean): Record<string, unknown> {
  const store = messagesStore();
  const current = store.get(id);
  if (!current) throw new Error(`Inbound email not found: ${id}`);
  const labels = v1Labels(current).filter((l) => l.trim().toLowerCase() !== "archived");
  if (archived) labels.push("archived");
  return store.update(id, { archived, labels });
}

export function setInboundArchived(id: string, archived: boolean): InboundEmail {
  return apiToInboundEmail(setInboundArchivedState(id, archived));
}

export function setInboundArchivedSummary(id: string, archived: boolean): InboundEmailSummary {
  return apiToInboundEmailSummary(setInboundArchivedState(id, archived));
}

export function setInboundArchivedFlag(id: string, archived: boolean): boolean {
  setInboundArchivedState(id, archived);
  return archived;
}

export function setInboundStarred(id: string, starred: boolean): InboundEmail {
  return apiToInboundEmail(messagesStore().update(id, { is_starred: starred }));
}

export function setInboundStarredSummary(id: string, starred: boolean): InboundEmailSummary {
  return apiToInboundEmailSummary(messagesStore().update(id, { is_starred: starred }));
}

export function setInboundStarredFlag(id: string, starred: boolean): boolean {
  messagesStore().update(id, { is_starred: starred });
  return starred;
}

// ── labels ─────────────────────────────────────────────────────────────────────

function mutateInboundLabel(id: string, label: string, remove: boolean): Record<string, unknown> {
  const store = messagesStore();
  const current = store.get(id);
  if (!current) throw new Error(`Inbound email not found: ${id}`);
  // The self-hosted server rebuilds the labels column from add_label/remove_label
  // (a raw `labels` array in a PATCH is IGNORED by updateMessageStatus), so send
  // the delta — never the recomputed array — or the write is a silent no-op.
  return store.update(id, remove ? { remove_label: label } : { add_label: label });
}

/** Add a label (no-op if already present). */
export function addInboundLabel(id: string, label: string): InboundEmail {
  return apiToInboundEmail(mutateInboundLabel(id, label, false));
}

export function addInboundLabelSummary(id: string, label: string): InboundEmailSummary {
  return apiToInboundEmailSummary(mutateInboundLabel(id, label, false));
}

/** Remove a label (no-op if absent). */
export function removeInboundLabel(id: string, label: string): InboundEmail {
  return apiToInboundEmail(mutateInboundLabel(id, label, true));
}

export function removeInboundLabelSummary(id: string, label: string): InboundEmailSummary {
  return apiToInboundEmailSummary(mutateInboundLabel(id, label, true));
}
