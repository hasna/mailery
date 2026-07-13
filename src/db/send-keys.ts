/**
 * Scoped send keys — a credential bound to one owner (an agent or human). A key
 * authorizes sending only from addresses that owner OWNS or ADMINISTERS.
 *
 * Self-hosted-ONLY: the generic `send-keys` /v1 resource is summary-only — the
 * secret `key_hash` is NEVER stored on or fetched by a client. Minting and token
 * verification are bespoke server operations exposed at dedicated endpoints:
 *   - POST /v1/send-keys/mint   { owner_id, label } -> { token, key }
 *   - POST /v1/send-keys/verify { token, from? }    -> { valid, authorized, key }
 * The token/hash never leaves the server; the client only ever holds the one-time
 * token (returned by mint) and passes it back through verify. The token value is
 * carried in the request body over the same authenticated transport and is never
 * logged.
 */
import { now } from "./runtime.js";
import { getAddressOwnership, getOwner, type Owner } from "./owners.js";
import { findAddressesByEmail } from "./addresses.js";
import { canonicalSender } from "../lib/email-address.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, cbool, cobj, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const SEND_KEY_RESOURCE = "send-keys";
const SEND_KEY_MINT_RESOURCE = "send-keys/mint";
const SEND_KEY_VERIFY_RESOURCE = "send-keys/verify";

function apiToSendKeySummary(e: Record<string, unknown>): SendKeySummary {
  return {
    id: cstr(e["id"]),
    owner_id: cstr(e["owner_id"]),
    prefix: cstr(e["prefix"]),
    label: cstrOrNull(e["label"]),
    created_at: ciso(e["created_at"]),
    last_used_at: cstrOrNull(e["last_used_at"]),
    revoked_at: cstrOrNull(e["revoked_at"]),
  };
}

export interface SendKey {
  id: string;
  owner_id: string;
  key_hash: string;
  prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type SendKeySummary = Omit<SendKey, "key_hash">;

export interface ListSendKeyOptions {
  limit?: number;
  offset?: number;
}

/** A self-hosted send key never exposes its hash to the client. */
function summaryToKey(summary: SendKeySummary): SendKey {
  return { ...summary, key_hash: "" };
}

/**
 * Extract the canonical sender address, or "" for an ambiguous/malformed From
 * (an empty string never matches a stored address, so the send is denied).
 */
function bareEmail(from: string): string {
  return canonicalSender(from) ?? "";
}

export function createSendKey(ownerId: string, label?: string): { token: string; key: SendKey } {
  // Mint on the server: it generates the token, stores only its hash, and returns
  // the token ONCE. The client keeps the token in-hand (never logged) and a
  // hash-free key summary.
  const res = selfHostedResource(SEND_KEY_MINT_RESOURCE).create({ owner_id: ownerId, label: label ?? null });
  const token = cstr(res["token"]);
  const key = summaryToKey(apiToSendKeySummary(cobj(res["key"])));
  return { token, key };
}

export function getSendKey(id: string): SendKey | null {
  const record = selfHostedResource(SEND_KEY_RESOURCE).get(id);
  return record ? summaryToKey(apiToSendKeySummary(record)) : null;
}

/** Resolve a token to its (non-revoked) key, stamping last_used_at server-side. */
export function verifySendKey(token: string): SendKey | null {
  // The server holds the hash; it resolves the token and returns a hash-free key
  // (or valid:false for an unknown/revoked token).
  const res = selfHostedResource(SEND_KEY_VERIFY_RESOURCE).create({ token });
  if (!cbool(res["valid"]) || res["key"] == null) return null;
  return summaryToKey(apiToSendKeySummary(cobj(res["key"])));
}

export function listSendKeys(ownerId?: string, opts?: ListSendKeyOptions): SendKey[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  if (ownerId) query["owner_id"] = ownerId;
  let rows = selfHostedResource(SEND_KEY_RESOURCE).list(query).map((e) => summaryToKey(apiToSendKeySummary(e)));
  if (ownerId) rows = rows.filter((k) => k.owner_id === ownerId);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function listSendKeySummaries(ownerId?: string, opts?: ListSendKeyOptions): SendKeySummary[] {
  const { query, limit, offset } = selfHostedListQuery(opts);
  if (ownerId) query["owner_id"] = ownerId;
  let rows = selfHostedResource(SEND_KEY_RESOURCE).list(query).map(apiToSendKeySummary);
  if (ownerId) rows = rows.filter((k) => k.owner_id === ownerId);
  rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return selfHostedPage(rows, limit, offset);
}

export function listSendKeysByOwners(ownerIds: Iterable<string>): SendKey[] {
  const ids = new Set([...ownerIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return [];
  return selfHostedResource(SEND_KEY_RESOURCE)
    .list({ limit: 1000 })
    .map((e) => summaryToKey(apiToSendKeySummary(e)))
    .filter((k) => ids.has(k.owner_id))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export function listSendKeySummariesByOwners(ownerIds: Iterable<string>): SendKeySummary[] {
  const ids = new Set([...ownerIds].map((id) => id.trim()).filter(Boolean));
  if (ids.size === 0) return [];
  return selfHostedResource(SEND_KEY_RESOURCE)
    .list({ limit: 1000 })
    .map(apiToSendKeySummary)
    .filter((k) => ids.has(k.owner_id))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export function revokeSendKey(id: string): boolean {
  const store = selfHostedResource(SEND_KEY_RESOURCE);
  const record = store.get(id);
  if (!record || cstrOrNull(record["revoked_at"])) return false;
  store.update(id, { revoked_at: now() });
  return true;
}

/** Whether `ownerId` may send from `fromEmail` (owns or administers the address). */
export function canOwnerSendFrom(ownerId: string, fromEmail: string): boolean {
  const email = bareEmail(fromEmail);
  if (!email) return false;
  // Any matching address whose owner or administrator is this owner authorizes.
  for (const address of findAddressesByEmail(email)) {
    const own = getAddressOwnership(address.id);
    if (own && (own.owner_id === ownerId || own.administrator_id === ownerId)) return true;
  }
  return false;
}

/**
 * Verify a send key and confirm it is authorized to send from `fromEmail`.
 * Throws on an invalid/revoked key or an out-of-scope From. Returns the owner.
 */
export function assertSendAuthorized(token: string, fromEmail: string): Owner {
  // The server verifies the token AND performs the from-address scope check in one
  // call (default-deny: `authorized` is only true for an actual owned/administered
  // From). The client never sees the key hash.
  const res = selfHostedResource(SEND_KEY_VERIFY_RESOURCE).create({ token, from: fromEmail });
  if (!cbool(res["valid"]) || res["key"] == null) {
    throw new Error("Send key is invalid or revoked");
  }
  if (!cbool(res["authorized"])) {
    throw new Error(`Send key is not authorized to send from ${bareEmail(fromEmail)}`);
  }
  const key = apiToSendKeySummary(cobj(res["key"]));
  const owner = getOwner(key.owner_id);
  if (!owner) throw new Error("Send key owner no longer exists");
  return owner;
}
