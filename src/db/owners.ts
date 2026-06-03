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

export function createOwner(input: CreateOwnerInput, db?: Database): Owner {
  if (input.type !== "human" && input.type !== "agent") {
    throw new Error(`Invalid owner type '${input.type}' (must be 'human' or 'agent')`);
  }
  const d = db || getDatabase();
  const id = uuid();
  const ts = now();
  d.run(
    `INSERT INTO owners (id, type, name, contact_email, external_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.type, input.name, input.contact_email ?? null, input.external_id ?? null, ts, ts],
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

export function listOwners(type?: OwnerType, db?: Database): Owner[] {
  const d = db || getDatabase();
  if (type) return d.query("SELECT * FROM owners WHERE type = ? ORDER BY created_at DESC").all(type) as Owner[];
  return d.query("SELECT * FROM owners ORDER BY created_at DESC").all() as Owner[];
}

export interface AddressOwnership {
  owner_id: string;
  owner_type: OwnerType;
  administrator_id: string;
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
  const owner = getOwner(ownerId, d);
  if (!owner) throw new Error(`Owner not found: ${ownerId}`);

  // Refuse to silently take over an address already owned by someone else —
  // prevents cross-tenant hijack on (re)provision. Reassigning to the same
  // owner (e.g. updating the administrator) stays allowed.
  const current = d.query("SELECT owner_id FROM addresses WHERE id = ?").get(addressId) as { owner_id: string | null } | null;
  if (current?.owner_id && current.owner_id !== ownerId) {
    throw new Error(`Address ${addressId} is already owned by another owner; transfer is not permitted`);
  }

  let adminId: string;
  if (owner.type === "agent") {
    adminId = owner.id; // self-administered
  } else {
    if (!administratorId) {
      throw new Error("A human-owned address requires an agent administrator (pass administratorId)");
    }
    const admin = getOwner(administratorId, d);
    if (!admin) throw new Error(`Administrator not found: ${administratorId}`);
    if (admin.type !== "agent") throw new Error("The administrator must be an agent");
    adminId = admin.id;
  }

  d.run("UPDATE addresses SET owner_id = ?, administrator_id = ?, updated_at = ? WHERE id = ?",
    [ownerId, adminId, now(), addressId]);
  return { owner_id: ownerId, owner_type: owner.type, administrator_id: adminId };
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

/** List addresses an owner owns (default) or administers. */
export function listAddressesByOwner(ownerId: string, role: "owner" | "administrator" = "owner", db?: Database): EmailAddress[] {
  const d = db || getDatabase();
  const col = role === "administrator" ? "administrator_id" : "owner_id";
  const rows = d.query(`SELECT * FROM addresses WHERE ${col} = ? ORDER BY created_at DESC`).all(ownerId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...r, verified: !!(r as { verified?: number }).verified }) as unknown as EmailAddress);
}
