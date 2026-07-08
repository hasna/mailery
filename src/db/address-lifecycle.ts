/**
 * Address lifecycle — suspend / activate an address and enforce a per-address
 * daily send quota. An address that is `suspended` cannot send (and is excluded
 * from delivery); a `daily_quota` caps the number of sends per UTC day.
 */
import type { Database } from "./database.js";
import type { AddressStatus, EmailAddress } from "../types/index.js";
import { AddressNotFoundError } from "../types/index.js";
import { getDatabase, now } from "./database.js";
import { apiToAddress, cloudAddresses, findAddressesByEmail, getAddress } from "./addresses.js";
import { sqlEmailAddress } from "./email-address-sql.js";
import { canonicalSender } from "../lib/email-address.js";

function setStatus(id: string, status: AddressStatus, db?: Database): EmailAddress {
  // Cloud (self_hosted) mode: the address registry lives in the shared cloud
  // dataset, so status transitions MUST write there — writing to the local
  // island would diverge from the fleet-wide dataset (split-brain).
  const cloud = cloudAddresses(db);
  if (cloud) {
    if (!cloud.get(id)) throw new AddressNotFoundError(id);
    return apiToAddress(cloud.update(id, { status }));
  }
  const d = db || getDatabase();
  if (!getAddress(id, d)) throw new AddressNotFoundError(id);
  d.run("UPDATE addresses SET status = ?, updated_at = ? WHERE id = ?", [status, now(), id]);
  return getAddress(id, d)!;
}

export function suspendAddress(id: string, db?: Database): EmailAddress {
  return setStatus(id, "suspended", db);
}

export function activateAddress(id: string, db?: Database): EmailAddress {
  return setStatus(id, "active", db);
}

/** Set (or clear, with null) the per-address daily send quota. */
export function setAddressQuota(id: string, quota: number | null, db?: Database): EmailAddress {
  if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
    throw new Error(`Invalid daily quota: ${quota} (must be a non-negative integer or null)`);
  }
  // Cloud (self_hosted) mode: persist the quota to the shared cloud dataset so
  // it applies fleet-wide, not just on this machine's local island.
  const cloud = cloudAddresses(db);
  if (cloud) {
    if (!cloud.get(id)) throw new AddressNotFoundError(id);
    return apiToAddress(cloud.update(id, { daily_quota: quota }));
  }
  const d = db || getDatabase();
  if (!getAddress(id, d)) throw new AddressNotFoundError(id);
  d.run("UPDATE addresses SET daily_quota = ?, updated_at = ? WHERE id = ?", [quota, now(), id]);
  return getAddress(id, d)!;
}

/** Count emails sent from `email` so far during the current UTC day. */
export function countSendsToday(email: string, db?: Database): number {
  // Cloud (self_hosted) mode: the per-address daily send ledger (`emails`) is
  // not part of the cloud address model, so we return 0 rather than consulting
  // the local island — reading local counts on a flipped machine would report
  // stale/wrong usage (split-brain read).
  if (cloudAddresses(db)) return 0;
  const d = db || getDatabase();
  const normalizedEmail = canonicalSender(email) ?? email.trim().toLowerCase();
  const today = now().slice(0, 10); // YYYY-MM-DD (ISO sorts lexicographically)
  const row = d.query(
    `SELECT COUNT(*) AS c FROM emails WHERE ${sqlEmailAddress("from_address")} = ? AND sent_at LIKE ?`,
  ).get(normalizedEmail, `${today}%`) as { c: number } | null;
  return row?.c ?? 0;
}

/** Count today's sends for many addresses with one grouped query. */
export function countSendsTodayByAddress(emails: Iterable<string>, db?: Database): Map<string, number> {
  const normalized = [...new Set(
    [...emails]
      .map((email) => canonicalSender(email) ?? email.trim().toLowerCase())
      .filter(Boolean),
  )];
  const counts = new Map(normalized.map((email) => [email, 0]));
  if (normalized.length === 0) return counts;

  // Cloud (self_hosted) mode: return zeroed counts without touching the local
  // island (see countSendsToday) — the cloud address model has no per-address
  // daily send ledger to count against.
  if (cloudAddresses(db)) return counts;

  const d = db || getDatabase();
  const today = now().slice(0, 10);
  const addressSql = sqlEmailAddress("from_address");
  const placeholders = normalized.map(() => "?").join(", ");
  const rows = d.query(
    `SELECT ${addressSql} AS from_email, COUNT(*) AS c
       FROM emails
      WHERE ${addressSql} IN (${placeholders})
        AND sent_at LIKE ?
      GROUP BY ${addressSql}`,
  ).all(...normalized, `${today}%`) as Array<{ from_email: string; c: unknown }>;
  for (const row of rows) counts.set(row.from_email, Number(row.c) || 0);
  return counts;
}

export interface Sendability {
  sendable: boolean;
  reason?: string;
}

/**
 * Whether `email` is allowed to send right now. Unregistered addresses are
 * unrestricted (sendable); a registered address is blocked if suspended or if
 * it has reached its daily quota.
 */
export function getAddressSendability(email: string, db?: Database): Sendability {
  const normalizedEmail = canonicalSender(email) ?? email.trim().toLowerCase();

  // Cloud (self_hosted) mode: enforce suspension/quota against the shared cloud
  // address dataset, never the local island (which is empty on a flipped
  // machine and would wrongly allow every sender to send).
  const cloud = cloudAddresses(db);
  if (cloud) {
    const matches = findAddressesByEmail(normalizedEmail, db);
    if (matches.length === 0) return { sendable: true };
    // A suspended record (any provider) takes precedence over an active one.
    const record = matches.find((a) => a.status === "suspended") ?? matches[0]!;
    if ((record.status ?? "active") === "suspended") {
      return { sendable: false, reason: `Address ${normalizedEmail} is suspended` };
    }
    if (record.daily_quota !== null) {
      const used = countSendsToday(normalizedEmail, db);
      if (used >= record.daily_quota) {
        return { sendable: false, reason: `Address ${normalizedEmail} reached its daily quota (${used}/${record.daily_quota})` };
      }
    }
    return { sendable: true };
  }

  const d = db || getDatabase();
  // Case-insensitive: a suspended `Ceo@x` must still block a send as `ceo@x`.
  // A suspended row (any provider) takes precedence over an active one.
  const row = d.query(
    `SELECT status, daily_quota FROM addresses WHERE LOWER(email) = LOWER(?)
     ORDER BY CASE WHEN status = 'suspended' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
  ).get(normalizedEmail) as { status: AddressStatus | null; daily_quota: number | null } | null;
  if (!row) return { sendable: true };
  if ((row.status ?? "active") === "suspended") {
    return { sendable: false, reason: `Address ${normalizedEmail} is suspended` };
  }
  if (row.daily_quota !== null) {
    const used = countSendsToday(normalizedEmail, d);
    if (used >= row.daily_quota) {
      return { sendable: false, reason: `Address ${normalizedEmail} reached its daily quota (${used}/${row.daily_quota})` };
    }
  }
  return { sendable: true };
}
