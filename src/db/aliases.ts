/**
 * Per-domain aliases and catch-all routing. An alias maps a recipient
 * local-part on a domain to a target (owned) address; a catch-all maps every
 * otherwise-unmatched recipient on a domain. There is also a single GLOBAL
 * catch-all (domain `*`) that catches mail for every domain — it is `protected`
 * and can never be deleted, so no inbound is ever dropped.
 *
 * Resolution order: specific alias → domain catch-all → global catch-all.
 */
import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

/** Sentinel local-part used to represent a catch-all. */
export const CATCH_ALL = "*";
/** Sentinel domain used to represent "all domains". */
export const ALL_DOMAINS = "*";

export interface Alias {
  id: string;
  domain: string;
  local_part: string;
  target_address: string;
  protected: boolean;
  created_at: string;
  updated_at: string;
}

export interface ListAliasOptions {
  limit?: number;
  offset?: number;
}

interface AliasRow extends Omit<Alias, "protected"> { protected?: number }

function splitAddress(address: string): { local_part: string; domain: string } {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`Invalid email address (expected local@domain): ${address}`);
  }
  return { local_part: address.slice(0, at).toLowerCase(), domain: address.slice(at + 1).toLowerCase() };
}

function rowToAlias(row: AliasRow): Alias {
  return { ...row, protected: !!row.protected };
}

function upsert(domain: string, localPart: string, target: string, db: Database, isProtected = false): Alias {
  const d = db;
  const existing = d.query("SELECT * FROM aliases WHERE domain = ? AND local_part = ?").get(domain, localPart) as AliasRow | null;
  if (existing) {
    d.run("UPDATE aliases SET target_address = ?, updated_at = ? WHERE id = ?", [target, now(), existing.id]);
    return getAlias(existing.id, d)!;
  }
  const id = uuid();
  const ts = now();
  d.run(
    "INSERT INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, domain, localPart, target, isProtected ? 1 : 0, ts, ts],
  );
  return getAlias(id, d)!;
}

/** Create (or update) a specific alias: `alias@domain` → `target`. */
export function createAlias(aliasAddress: string, target: string, db?: Database): Alias {
  const d = db || getDatabase();
  const { local_part, domain } = splitAddress(aliasAddress);
  return upsert(domain, local_part, target.toLowerCase(), d);
}

/** Create (or update) a catch-all for `domain` → `target`. */
export function createCatchAll(domain: string, target: string, db?: Database): Alias {
  const d = db || getDatabase();
  return upsert(domain.toLowerCase(), CATCH_ALL, target.toLowerCase(), d);
}

/** Create (or update) the GLOBAL catch-all (all domains) → `target`. Protected. */
export function setGlobalCatchAll(target: string, db?: Database): Alias {
  const d = db || getDatabase();
  return upsert(ALL_DOMAINS, CATCH_ALL, target.toLowerCase(), d, true);
}

/**
 * Ensure the protected global catch-all exists (target defaults to empty = keep
 * everything, no rewrite). Idempotent — safe to call on every startup.
 */
export function ensureDefaultCatchAll(db?: Database): Alias {
  const d = db || getDatabase();
  const existing = d.query("SELECT * FROM aliases WHERE domain = ? AND local_part = ?").get(ALL_DOMAINS, CATCH_ALL) as AliasRow | null;
  if (existing) return rowToAlias(existing);
  return upsert(ALL_DOMAINS, CATCH_ALL, "", d, true);
}

export function getGlobalCatchAll(db?: Database): Alias | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM aliases WHERE domain = ? AND local_part = ?").get(ALL_DOMAINS, CATCH_ALL) as AliasRow | null;
  return row ? rowToAlias(row) : null;
}

export function getAlias(id: string, db?: Database): Alias | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM aliases WHERE id = ?").get(id) as AliasRow | null;
  return row ? rowToAlias(row) : null;
}

export function listAliases(domain?: string, db?: Database, opts?: ListAliasOptions): Alias[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = domain
    ? (limit !== null
        ? d.query("SELECT * FROM aliases WHERE domain = ? ORDER BY local_part LIMIT ? OFFSET ?").all(domain.toLowerCase(), limit, offset) as AliasRow[]
        : d.query("SELECT * FROM aliases WHERE domain = ? ORDER BY local_part").all(domain.toLowerCase()) as AliasRow[])
    : (limit !== null
        ? d.query("SELECT * FROM aliases ORDER BY (domain='*') DESC, domain, local_part LIMIT ? OFFSET ?").all(limit, offset) as AliasRow[]
        : d.query("SELECT * FROM aliases ORDER BY (domain='*') DESC, domain, local_part").all() as AliasRow[]);
  return rows.map(rowToAlias);
}

/** List aliases that route to any of the given target addresses. */
export function listAliasesByTargets(targets: Iterable<string>, db?: Database): Alias[] {
  const normalized = [...new Set([...targets].map((target) => target.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return [];
  const d = db || getDatabase();
  const placeholders = normalized.map(() => "?").join(", ");
  const rows = d.query(
    `SELECT * FROM aliases
     WHERE LOWER(target_address) IN (${placeholders})
     ORDER BY (domain='*') DESC, domain, local_part`,
  ).all(...normalized) as AliasRow[];
  return rows.map(rowToAlias);
}

/** Remove an alias. Refuses to delete a protected one (the global catch-all). */
export function removeAlias(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const a = getAlias(id, d);
  if (!a) return false;
  if (a.protected) throw new Error("This catch-all is protected and cannot be deleted.");
  return d.run("DELETE FROM aliases WHERE id = ?", [id]).changes > 0;
}

/**
 * Resolve a recipient address to its target via aliases:
 *   specific alias → domain catch-all → global catch-all.
 * Returns null when nothing matches (or the matched catch-all has no target).
 */
export function resolveAlias(recipient: string, db?: Database): string | null {
  const d = db || getDatabase();
  let local_part: string, domain: string;
  try { ({ local_part, domain } = splitAddress(recipient)); } catch { return null; }
  const q = (dom: string, lp: string) =>
    (d.query("SELECT target_address FROM aliases WHERE domain = ? AND local_part = ?").get(dom, lp) as { target_address: string } | null)?.target_address || null;
  return q(domain, local_part) || q(domain, CATCH_ALL) || q(ALL_DOMAINS, CATCH_ALL) || null;
}
