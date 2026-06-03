/**
 * Address lifecycle — suspend / activate an address and enforce a per-address
 * daily send quota. An address that is `suspended` cannot send (and is excluded
 * from delivery); a `daily_quota` caps the number of sends per UTC day.
 */
import type { Database } from "./database.js";
import type { AddressStatus, EmailAddress } from "../types/index.js";
import { AddressNotFoundError } from "../types/index.js";
import { getDatabase, now } from "./database.js";
import { getAddress } from "./addresses.js";

function setStatus(id: string, status: AddressStatus, db?: Database): EmailAddress {
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
  const d = db || getDatabase();
  if (!getAddress(id, d)) throw new AddressNotFoundError(id);
  if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
    throw new Error(`Invalid daily quota: ${quota} (must be a non-negative integer or null)`);
  }
  d.run("UPDATE addresses SET daily_quota = ?, updated_at = ? WHERE id = ?", [quota, now(), id]);
  return getAddress(id, d)!;
}

/** Count emails sent from `email` so far during the current UTC day. */
export function countSendsToday(email: string, db?: Database): number {
  const d = db || getDatabase();
  const today = now().slice(0, 10); // YYYY-MM-DD (ISO sorts lexicographically)
  const row = d.query(
    "SELECT COUNT(*) AS c FROM emails WHERE LOWER(from_address) = LOWER(?) AND sent_at LIKE ?",
  ).get(email, `${today}%`) as { c: number } | null;
  return row?.c ?? 0;
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
  const d = db || getDatabase();
  // Case-insensitive: a suspended `Ceo@x` must still block a send as `ceo@x`.
  // A suspended row (any provider) takes precedence over an active one.
  const row = d.query(
    `SELECT status, daily_quota FROM addresses WHERE LOWER(email) = LOWER(?)
     ORDER BY CASE WHEN status = 'suspended' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
  ).get(email) as { status: AddressStatus | null; daily_quota: number | null } | null;
  if (!row) return { sendable: true };
  if ((row.status ?? "active") === "suspended") {
    return { sendable: false, reason: `Address ${email} is suspended` };
  }
  if (row.daily_quota !== null) {
    const used = countSendsToday(email, d);
    if (used >= row.daily_quota) {
      return { sendable: false, reason: `Address ${email} reached its daily quota (${used}/${row.daily_quota})` };
    }
  }
  return { sendable: true };
}
