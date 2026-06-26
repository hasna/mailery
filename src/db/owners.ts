/**
 * Tenancy / ownership — addresses are owned by a human OR an agent.
 *
 * Rule: a human-owned address must be ADMINISTERED by an agent (owner=human,
 * administrator=agent). An agent-owned address is self-administered
 * (administrator = the agent). This lets an address belong to a human while
 * being operated by an agent on their behalf.
 */

import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";
import type { EmailAddress } from "../types/index.js";
import { cappedLimit, safeOffset, safeOptionalLimit } from "./pagination.js";

export type OwnerType = "human" | "agent";

export interface Owner {
  id: string;
  type: OwnerType;
  name: string;
  contact_email: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateOwnerInput {
  type: OwnerType;
  name: string;
  contact_email?: string;
  external_id?: string;
}

export interface ListOwnerOptions {
  limit?: number;
  offset?: number;
}

export interface ListAddressesByOwnerOptions {
  limit?: number;
  offset?: number;
}

let lastOwnershipEventMs = 0;

function ownershipEventTimestamp(): string {
  const current = Date.now();
  lastOwnershipEventMs = current <= lastOwnershipEventMs ? lastOwnershipEventMs + 1 : current;
  return new Date(lastOwnershipEventMs).toISOString();
}

export function createOwner(input: CreateOwnerInput, db?: Database): Owner {
  if (input.type !== "human" && input.type !== "agent") {
    throw new Error(`Invalid owner type '${input.type}' (must be 'human' or 'agent')`);
  }
  const d = db || getDatabase();
  const externalId = input.external_id?.trim();
  if (externalId && getOwnerByExternalId(externalId, d)) {
    throw new Error(`Owner external_id already exists: ${externalId}`);
  }
  const id = uuid();
  const ts = now();
  d.run(
    `INSERT INTO owners (id, type, name, contact_email, external_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.type, input.name, input.contact_email ?? null, externalId ?? null, ts, ts],
  );
  return getOwner(id, d)!;
}

export function getOwner(id: string, db?: Database): Owner | null {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM owners WHERE id = ?").get(id) as Owner | null) ?? null;
}

export function getOwnerByName(name: string, db?: Database): Owner | null {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM owners WHERE name = ? ORDER BY created_at ASC").get(name) as Owner | null) ?? null;
}

export function getOwnerByExternalId(externalId: string, db?: Database): Owner | null {
  const normalized = externalId.trim();
  if (!normalized) return null;
  const d = db || getDatabase();
  return (d.query("SELECT * FROM owners WHERE external_id = ? ORDER BY created_at ASC").get(normalized) as Owner | null) ?? null;
}

export function getOwnerByContactEmail(email: string, db?: Database): Owner | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const d = db || getDatabase();
  return (d
    .query("SELECT * FROM owners WHERE LOWER(contact_email) = ? ORDER BY created_at ASC")
    .get(normalized) as Owner | null) ?? null;
}

export function listOwners(type?: OwnerType, db?: Database, opts?: ListOwnerOptions): Owner[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  if (type) {
    return (limit !== null
      ? d.query("SELECT * FROM owners WHERE type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(type, limit, offset)
      : d.query("SELECT * FROM owners WHERE type = ? ORDER BY created_at DESC").all(type)) as Owner[];
  }
  return (limit !== null
    ? d.query("SELECT * FROM owners ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset)
    : d.query("SELECT * FROM owners ORDER BY created_at DESC").all()) as Owner[];
}

export interface AddressOwnership {
  owner_id: string;
  owner_type: OwnerType;
  administrator_id: string;
}

export type AddressOwnershipAction = "assign" | "transfer" | "unassign";

export interface AddressOwnershipEvent {
  id: string;
  address_id: string;
  action: AddressOwnershipAction;
  previous_owner_id: string | null;
  previous_administrator_id: string | null;
  owner_id: string | null;
  administrator_id: string | null;
  actor: string | null;
  reason: string | null;
  created_at: string;
}

interface CurrentAddressOwnership {
  owner_id: string | null;
  administrator_id: string | null;
}

interface OwnershipChangeOptions {
  actor?: string;
  reason?: string;
}

function getCurrentAddressOwnership(addressId: string, db: Database): CurrentAddressOwnership {
  const current = db.query("SELECT owner_id, administrator_id FROM addresses WHERE id = ?").get(addressId) as CurrentAddressOwnership | null;
  if (!current) throw new Error(`Address not found: ${addressId}`);
  return current;
}

function validateAddressOwnership(
  ownerId: string,
  administratorId: string | undefined,
  db: Database,
): AddressOwnership {
  const owner = getOwner(ownerId, db);
  if (!owner) throw new Error(`Owner not found: ${ownerId}`);

  let adminId: string;
  if (owner.type === "agent") {
    adminId = owner.id;
  } else {
    if (!administratorId) {
      throw new Error("A human-owned address requires an agent administrator (pass administratorId)");
    }
    const admin = getOwner(administratorId, db);
    if (!admin) throw new Error(`Administrator not found: ${administratorId}`);
    if (admin.type !== "agent") throw new Error("The administrator must be an agent");
    adminId = admin.id;
  }

  return { owner_id: owner.id, owner_type: owner.type, administrator_id: adminId };
}

function recordAddressOwnershipEvent(
  db: Database,
  addressId: string,
  action: AddressOwnershipAction,
  previous: CurrentAddressOwnership,
  next: { owner_id: string | null; administrator_id: string | null },
  options: OwnershipChangeOptions = {},
): AddressOwnershipEvent {
  const id = uuid();
  const ts = ownershipEventTimestamp();
  db.run(
    `INSERT INTO address_ownership_events
      (id, address_id, action, previous_owner_id, previous_administrator_id, owner_id, administrator_id, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      addressId,
      action,
      previous.owner_id,
      previous.administrator_id,
      next.owner_id,
      next.administrator_id,
      options.actor?.trim() || null,
      options.reason?.trim() || null,
      ts,
    ],
  );
  return getAddressOwnershipEvent(id, db)!;
}

export function getAddressOwnershipEvent(id: string, db?: Database): AddressOwnershipEvent | null {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM address_ownership_events WHERE id = ?").get(id) as AddressOwnershipEvent | null) ?? null;
}

export function listAddressOwnershipEvents(addressId: string, limit = 20, db?: Database): AddressOwnershipEvent[] {
  const d = db || getDatabase();
  const safeLimit = cappedLimit(limit, 20, 100);
  return d.query("SELECT * FROM address_ownership_events WHERE address_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(addressId, safeLimit) as AddressOwnershipEvent[];
}

/**
 * Assign ownership of an address.
 *  - agent owner → self-administered (administrator = owner; administratorId ignored)
 *  - human owner → administratorId is REQUIRED and must reference an agent owner
 */
export function assignAddressOwner(
  addressId: string,
  ownerId: string,
  administratorId?: string,
  db?: Database,
): AddressOwnership {
  const d = db || getDatabase();
  const ownership = validateAddressOwnership(ownerId, administratorId, d);

  // Refuse to silently take over an address already owned by someone else —
  // prevents cross-tenant hijack on (re)provision. Reassigning to the same
  // owner (e.g. updating the administrator) stays allowed.
  const current = getCurrentAddressOwnership(addressId, d);
  if (current.owner_id && current.owner_id !== ownership.owner_id) {
    throw new Error(`Address ${addressId} is already owned by another owner; transfer is not permitted`);
  }

  d.run("UPDATE addresses SET owner_id = ?, administrator_id = ?, updated_at = ? WHERE id = ?",
    [ownership.owner_id, ownership.administrator_id, now(), addressId]);
  if (current.owner_id !== ownership.owner_id || current.administrator_id !== ownership.administrator_id) {
    recordAddressOwnershipEvent(d, addressId, "assign", current, ownership);
  }
  return ownership;
}

export function transferAddressOwner(
  addressId: string,
  ownerId: string,
  administratorId: string | undefined,
  options: OwnershipChangeOptions,
  db?: Database,
): AddressOwnership {
  const d = db || getDatabase();
  const reason = options.reason?.trim();
  if (!reason) throw new Error("Address ownership transfer requires a reason");

  const current = getCurrentAddressOwnership(addressId, d);
  const ownership = validateAddressOwnership(ownerId, administratorId, d);

  d.run("UPDATE addresses SET owner_id = ?, administrator_id = ?, updated_at = ? WHERE id = ?",
    [ownership.owner_id, ownership.administrator_id, now(), addressId]);
  if (current.owner_id !== ownership.owner_id || current.administrator_id !== ownership.administrator_id) {
    recordAddressOwnershipEvent(d, addressId, "transfer", current, ownership, options);
  }
  return ownership;
}

export function unassignAddressOwner(
  addressId: string,
  options: OwnershipChangeOptions,
  db?: Database,
): null {
  const d = db || getDatabase();
  const reason = options.reason?.trim();
  if (!reason) throw new Error("Address ownership unassign requires a reason");

  const current = getCurrentAddressOwnership(addressId, d);
  d.run("UPDATE addresses SET owner_id = NULL, administrator_id = NULL, updated_at = ? WHERE id = ?", [now(), addressId]);
  if (current.owner_id || current.administrator_id) {
    recordAddressOwnershipEvent(d, addressId, "unassign", current, { owner_id: null, administrator_id: null }, options);
  }
  return null;
}

export function getAddressOwnership(addressId: string, db?: Database): AddressOwnership | null {
  const d = db || getDatabase();
  const row = d.query(
    `SELECT a.owner_id, a.administrator_id, o.type as owner_type
     FROM addresses a LEFT JOIN owners o ON o.id = a.owner_id
     WHERE a.id = ?`,
  ).get(addressId) as { owner_id: string | null; administrator_id: string | null; owner_type: OwnerType | null } | null;
  if (!row || !row.owner_id) return null;
  return { owner_id: row.owner_id, owner_type: row.owner_type ?? "agent", administrator_id: row.administrator_id ?? row.owner_id };
}

function addressOwnershipRow(row: Record<string, unknown>): EmailAddress {
  return {
    ...row,
    verified: !!(row as { verified?: number }).verified,
    status: (row.status as EmailAddress["status"] | undefined) ?? "active",
    daily_quota: (row.daily_quota as number | null | undefined) ?? null,
  } as unknown as EmailAddress;
}

/** List addresses an owner owns (default) or administers. */
export function listAddressesByOwner(
  ownerId: string,
  role: "owner" | "administrator" = "owner",
  db?: Database,
  opts?: ListAddressesByOwnerOptions,
): EmailAddress[] {
  const d = db || getDatabase();
  const col = role === "administrator" ? "administrator_id" : "owner_id";
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = (limit !== null
    ? d.query(`SELECT * FROM addresses WHERE ${col} = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(ownerId, limit, offset)
    : d.query(`SELECT * FROM addresses WHERE ${col} = ? ORDER BY created_at DESC`).all(ownerId)) as Array<Record<string, unknown>>;
  return rows.map(addressOwnershipRow);
}

/** List addresses an owner administers but does not also own. */
export function listAdministeredAddressesNotOwnedBy(ownerId: string, db?: Database, opts?: ListAddressesByOwnerOptions): EmailAddress[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = (limit !== null
    ? d.query(
      `SELECT *
       FROM addresses
       WHERE administrator_id = ?
         AND (owner_id IS NULL OR owner_id != ?)
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(ownerId, ownerId, limit, offset)
    : d.query(
      `SELECT *
       FROM addresses
       WHERE administrator_id = ?
         AND (owner_id IS NULL OR owner_id != ?)
       ORDER BY created_at DESC`,
    )
    .all(ownerId, ownerId)) as Array<Record<string, unknown>>;
  return rows.map(addressOwnershipRow);
}

/** List only address strings an owner owns or administers without hydrating address rows. */
export function listAddressEmailsByOwner(ownerId: string, role: "owner" | "administrator" = "owner", db?: Database): string[] {
  const d = db || getDatabase();
  const col = role === "administrator" ? "administrator_id" : "owner_id";
  const rows = d.query(`SELECT email FROM addresses WHERE ${col} = ? ORDER BY created_at DESC`).all(ownerId) as Array<{ email: string }>;
  return rows.map((row) => row.email);
}

export function listOwnerNamesByIds(ownerIds: Iterable<string>, db?: Database): Map<string, string> {
  const ids = [...new Set([...ownerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d.query(`SELECT id, name FROM owners WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string; name: string }>;
  return new Map(rows.map((row) => [row.id, row.name]));
}

export function listOwnersByIds(ownerIds: Iterable<string>, db?: Database): Map<string, Owner> {
  const ids = [...new Set([...ownerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d.query(`SELECT * FROM owners WHERE id IN (${placeholders})`).all(...ids) as Owner[];
  return new Map(rows.map((row) => [row.id, row]));
}
