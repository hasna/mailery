import type { Email, EmailFilter, EmailStatus, SendEmailOptions } from "../types/index.js";
import { EmailNotFoundError } from "../types/index.js";
import { now, uuid } from "./runtime.js";
import { canonicalSender } from "../lib/email-address.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, carray, cobj, cstrArray, ciso, cnum, cstr, cstrOrNull } from "./self-hosted-resource.js";

// The outbound sent-ledger (`email list` / `log` / `search`) is backed by the
// shared `/v1/messages` store. A message row maps to the local Email shape; only
// outbound messages are surfaced as sent-log entries.
const MESSAGE_RESOURCE = "messages";

const EMAIL_STATUSES = new Set<EmailStatus>(["sent", "delivered", "bounced", "complained", "failed"]);

function apiMessageToEmail(e: Record<string, unknown>): Email {
  const createdAt = ciso(e["created_at"]);
  const sentAt = ciso(e["received_at"] ?? e["created_at"], createdAt);
  const rawStatus = cstr(e["status"]);
  const status: EmailStatus = EMAIL_STATUSES.has(rawStatus as EmailStatus) ? (rawStatus as EmailStatus) : "sent";
  const attachments = carray(e["attachments"]);
  const attachCount = cnum(e["attachment_count"], attachments.length);
  return {
    id: cstr(e["id"]),
    provider_id: cstrOrNull(e["provider_id"]) ?? "self_hosted",
    provider_message_id: cstrOrNull(e["provider_message_id"]),
    from_address: cstr(e["from_addr"] ?? e["from_address"]),
    to_addresses: cstrArray(e["to_addrs"] ?? e["to_addresses"]),
    cc_addresses: cstrArray(e["cc_addrs"] ?? e["cc_addresses"]),
    bcc_addresses: cstrArray(e["bcc_addrs"] ?? e["bcc_addresses"]),
    reply_to: cstrOrNull(e["reply_to"]),
    subject: cstr(e["subject"]),
    status,
    has_attachments: attachCount > 0,
    attachment_count: attachCount,
    tags: cobj(e["tags"]) as Record<string, string>,
    sent_at: sentAt,
    created_at: createdAt,
    updated_at: ciso(e["updated_at"], createdAt),
  };
}

/** True when a message row is an outbound (sent-ledger) entry. */
function isOutbound(e: Record<string, unknown>): boolean {
  const dir = cstr(e["direction"]).toLowerCase();
  return dir === "" || dir === "outbound" || dir === "sent";
}

export function createEmail(
  provider_id: string,
  opts: SendEmailOptions,
  provider_message_id?: string,
): Email {
  const id = uuid();
  const timestamp = now();
  const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
  const ccArr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : [];
  const bccArr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : [];
  const attachCount = opts.attachments?.length ?? 0;
  const idempotencyKey = (opts as unknown as Record<string, unknown>).idempotency_key as string | undefined;

  const created = selfHostedResource(MESSAGE_RESOURCE).create({
    id,
    provider_id,
    provider_message_id: provider_message_id || null,
    direction: "outbound",
    from_address: opts.from,
    to_addresses: toArr,
    cc_addresses: ccArr,
    bcc_addresses: bccArr,
    reply_to: opts.reply_to || null,
    subject: opts.subject,
    status: "sent",
    has_attachments: attachCount > 0,
    attachment_count: attachCount,
    tags: opts.tags || {},
    idempotency_key: idempotencyKey || null,
    sent_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return apiMessageToEmail(created);
}

export function getEmail(id: string): Email | null {
  const record = selfHostedResource(MESSAGE_RESOURCE).get(id);
  return record ? apiMessageToEmail(record) : null;
}

/**
 * Resolve a full or partial email id to a canonical id via the messages `/v1`
 * store: a full-length id is confirmed with a GET and a prefix is matched
 * against the message list.
 */
export function resolveEmailId(id: string): string | null {
  const store = selfHostedResource(MESSAGE_RESOURCE);
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (trimmed.length >= 36) return store.get(trimmed) ? trimmed : null;
  const matches = store
    .list({ limit: 1000 })
    .map((row) => cstr(row["id"]))
    .filter((mid) => mid.startsWith(trimmed));
  return matches.length === 1 ? matches[0]! : null;
}

export function listEmails(filter: EmailFilter = {}): Email[] {
  const { query, limit, offset } = selfHostedListQuery(filter);
  query["direction"] = "outbound";
  let rows = selfHostedResource(MESSAGE_RESOURCE).list(query).filter(isOutbound).map(apiMessageToEmail);
  if (filter.provider_id) rows = rows.filter((e) => e.provider_id === filter.provider_id);
  if (filter.status) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    rows = rows.filter((e) => wanted.includes(e.status));
  }
  if (filter.from_address) {
    const want = canonicalSender(filter.from_address) ?? filter.from_address.trim().toLowerCase();
    rows = rows.filter((e) => (canonicalSender(e.from_address) ?? e.from_address.toLowerCase()) === want);
  }
  if (filter.since) rows = rows.filter((e) => e.sent_at >= filter.since!);
  if (filter.until) rows = rows.filter((e) => e.sent_at <= filter.until!);
  rows.sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function searchEmails(query: string, opts?: { since?: string; limit?: number; offset?: number }): Email[] {
  const { query: q, limit, offset } = selfHostedListQuery(opts);
  q["direction"] = "outbound";
  const needle = query.toLowerCase();
  let rows = selfHostedResource(MESSAGE_RESOURCE).list(q).filter(isOutbound).map(apiMessageToEmail);
  rows = rows.filter((e) =>
    e.subject.toLowerCase().includes(needle) ||
    e.from_address.toLowerCase().includes(needle) ||
    e.to_addresses.some((t) => t.toLowerCase().includes(needle)),
  );
  if (opts?.since) rows = rows.filter((e) => e.sent_at >= opts.since!);
  rows.sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function updateEmailStatus(id: string, status: EmailStatus): Email {
  const store = selfHostedResource(MESSAGE_RESOURCE);
  if (!store.get(id)) throw new EmailNotFoundError(id);
  return apiMessageToEmail(store.update(id, { status, updated_at: now() }));
}

export function deleteEmail(id: string): boolean {
  return selfHostedResource(MESSAGE_RESOURCE).del(id);
}
