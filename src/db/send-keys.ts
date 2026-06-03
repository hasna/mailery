/**
 * Scoped send keys — a credential bound to one owner (an agent or human). A key
 * authorizes sending only from addresses that owner OWNS or ADMINISTERS, so an
 * agent issued a key cannot send as addresses belonging to other tenants.
 *
 * Tokens are shown once at creation; only their SHA-256 hash is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";
import { getOwner, getAddressOwnership, type Owner } from "./owners.js";
import { canonicalSender } from "../lib/email-address.js";

const TOKEN_PREFIX = "esk_";

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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Extract the canonical sender address, or "" for an ambiguous/malformed From
 * (an empty string never matches a stored address, so the send is denied).
 */
function bareEmail(from: string): string {
  return canonicalSender(from) ?? "";
}

export function createSendKey(ownerId: string, label?: string, db?: Database): { token: string; key: SendKey } {
  const d = db || getDatabase();
  const owner = getOwner(ownerId, d);
  if (!owner) throw new Error(`Owner not found: ${ownerId}`);
  const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
  const id = uuid();
  const prefix = token.slice(0, 12);
  d.run(
    "INSERT INTO send_keys (id, owner_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, ownerId, hashToken(token), prefix, label ?? null, now()],
  );
  return { token, key: getSendKey(id, d)! };
}

export function getSendKey(id: string, db?: Database): SendKey | null {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM send_keys WHERE id = ?").get(id) as SendKey | null) ?? null;
}

/** Resolve a token to its (non-revoked) key, stamping last_used_at. */
export function verifySendKey(token: string, db?: Database): SendKey | null {
  const d = db || getDatabase();
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = d.query("SELECT * FROM send_keys WHERE key_hash = ?").get(hashToken(token)) as SendKey | null;
  if (!row || row.revoked_at) return null;
  d.run("UPDATE send_keys SET last_used_at = ? WHERE id = ?", [now(), row.id]);
  return row;
}

export function listSendKeys(ownerId?: string, db?: Database): SendKey[] {
  const d = db || getDatabase();
  return (ownerId
    ? d.query("SELECT * FROM send_keys WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId)
    : d.query("SELECT * FROM send_keys ORDER BY created_at DESC").all()) as SendKey[];
}

export function revokeSendKey(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  return d.run("UPDATE send_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now(), id]).changes > 0;
}

/** Whether `ownerId` may send from `fromEmail` (owns or administers the address). */
export function canOwnerSendFrom(ownerId: string, fromEmail: string, db?: Database): boolean {
  const d = db || getDatabase();
  const email = bareEmail(fromEmail);
  // Resolve the address across providers; any matching address whose owner or
  // administrator is this owner authorizes the send.
  const rows = d.query("SELECT id FROM addresses WHERE LOWER(email) = ?").all(email) as Array<{ id: string }>;
  for (const r of rows) {
    const own = getAddressOwnership(r.id, d);
    if (own && (own.owner_id === ownerId || own.administrator_id === ownerId)) return true;
  }
  return false;
}

/**
 * Verify a send key and confirm it is authorized to send from `fromEmail`.
 * Throws on an invalid/revoked key or an out-of-scope From. Returns the owner.
 */
export function assertSendAuthorized(token: string, fromEmail: string, db?: Database): Owner {
  const d = db || getDatabase();
  const key = verifySendKey(token, d);
  if (!key) throw new Error("Send key is invalid or revoked");
  const owner = getOwner(key.owner_id, d);
  if (!owner) throw new Error("Send key owner no longer exists");
  if (!canOwnerSendFrom(owner.id, fromEmail, d)) {
    throw new Error(`Send key for '${owner.name}' is not authorized to send from ${bareEmail(fromEmail)}`);
  }
  return owner;
}
