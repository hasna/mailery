import type { Database } from "./database.js";
import type { SQLQueryBindings } from "bun:sqlite";
import type { AddressRow, AddressStatus, CreateAddressInput, EmailAddress } from "../types/index.js";
import { AddressNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { cloudStoreFor, isCloudMode, type CloudResourceStore } from "./cloud-store.js";

// ============================================================================
// Cloud (self_hosted) routing
// ============================================================================
//
// When the client-flip resolves to cloud (mode=self_hosted + HASNA_MAILERY_API_URL
// + HASNA_MAILERY_API_KEY), the `addresses` resource is served by the app's cloud
// HTTP API (<API_URL>/v1/addresses) instead of the local SQLite store — the same
// cred-based gate the `domains` resource already uses. The `db` argument is
// intentionally ignored for the routing decision: the CLI passes an explicit local
// `getDatabase()` handle to every repo call, so keying on it would defeat cloud
// routing. Tests never set the cloud env, so isCloudMode() is false there and the
// local SQLite path is always used.
export const ADDRESS_RESOURCE = "addresses";

export function cloudAddresses(_db?: Database): CloudResourceStore | null {
  if (!isCloudMode()) return null;
  return cloudStoreFor(ADDRESS_RESOURCE);
}

/** Map a cloud API address entity to the local EmailAddress shape (defaults filled).
 *  The self-hosted /v1/addresses record carries {id, email, domain, display_name,
 *  status, created_at, updated_at}; provider/owner/quota are not modelled in the
 *  cloud, so they default to null (enrichment then resolves to "-" in the CLI). */
export function apiToAddress(e: Record<string, unknown>): EmailAddress {
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  const updatedAt = str(e["updated_at"]) ?? new Date().toISOString();
  const createdAt = str(e["created_at"]) ?? updatedAt;
  const status: AddressStatus = str(e["status"]) === "suspended" ? "suspended" : "active";
  const quota = e["daily_quota"];
  return {
    id: String(e["id"]),
    provider_id: str(e["provider_id"] ?? e["provider"]) ?? "",
    email: String(e["email"] ?? ""),
    display_name: str(e["display_name"]),
    verified: Boolean(e["verified"]),
    owner_id: str(e["owner_id"]),
    administrator_id: str(e["administrator_id"]),
    status,
    daily_quota: quota == null ? null : Number(quota),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function rowToAddress(row: AddressRow): EmailAddress {
  return {
    ...row,
    verified: !!row.verified,
    status: row.status ?? "active",
    daily_quota: row.daily_quota ?? null,
  };
}

export function createAddress(input: CreateAddressInput, db?: Database): EmailAddress {
  const cloud = cloudAddresses(db);
  if (cloud) {
    const created = apiToAddress(cloud.create({ email: input.email, display_name: input.display_name || null }));
    // The cloud address model does not persist provider_id; carry the caller's
    // provider through on the returned entity so the command output is correct.
    return { ...created, provider_id: input.provider_id };
  }

  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO addresses (id, provider_id, email, display_name, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [id, input.provider_id, input.email, input.display_name || null, timestamp, timestamp],
  );

  return getAddress(id, d)!;
}

export function getAddress(id: string, db?: Database): EmailAddress | null {
  const cloud = cloudAddresses(db);
  if (cloud) {
    const e = cloud.get(id);
    return e ? apiToAddress(e) : null;
  }
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM addresses WHERE id = ?").get(id) as AddressRow | null;
  if (!row) return null;
  return rowToAddress(row);
}

export function getAddressByEmail(provider_id: string, email: string, db?: Database): EmailAddress | null {
  const cloud = cloudAddresses(db);
  if (cloud) {
    // The cloud model keys addresses by email (no provider dimension). Match on
    // email so `address add` dedup, get, and remove all resolve the same record.
    const target = email.trim().toLowerCase();
    const found = cloud.list().map(apiToAddress).find((a) => a.email.trim().toLowerCase() === target);
    return found ?? null;
  }
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM addresses WHERE provider_id = ? AND email = ?").get(provider_id, email) as AddressRow | null;
  if (!row) return null;
  return rowToAddress(row);
}

export function findAddressesByEmail(email: string, db?: Database): EmailAddress[] {
  const cloud = cloudAddresses(db);
  if (cloud) {
    const target = email.trim().toLowerCase();
    return cloud
      .list()
      .map(apiToAddress)
      .filter((a) => a.email.trim().toLowerCase() === target)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  }
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM addresses WHERE email = ? COLLATE NOCASE ORDER BY created_at DESC")
    .all(email.trim()) as AddressRow[];
  return rows.map(rowToAddress);
}

export interface ListAddressOptions {
  limit?: number;
  offset?: number;
}

export interface AddressReadinessOptions extends ListAddressOptions {
  provider_id?: string;
  owner_id?: string;
  send?: boolean;
  receive?: boolean;
  include_unverified?: boolean;
}

export function listAddresses(provider_id?: string, db?: Database, opts?: ListAddressOptions): EmailAddress[] {
  const cloud = cloudAddresses(db);
  if (cloud) {
    const query: Record<string, string | number | undefined> = {};
    const lim = safeOptionalLimit(opts?.limit);
    if (lim !== null) query["limit"] = lim;
    const off = safeOffset(opts?.offset);
    if (off) query["offset"] = off;
    let addresses = cloud.list(query).map(apiToAddress);
    if (provider_id) addresses = addresses.filter((a) => a.provider_id === provider_id);
    addresses.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    if (lim !== null) addresses = addresses.slice(off, off + lim);
    return addresses;
  }

  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const pageSql = limit !== null ? " LIMIT ? OFFSET ?" : "";
  if (provider_id) {
    const rows = limit !== null
      ? d.query(`SELECT * FROM addresses WHERE provider_id = ? ORDER BY created_at DESC${pageSql}`).all(provider_id, limit, offset) as AddressRow[]
      : d.query("SELECT * FROM addresses WHERE provider_id = ? ORDER BY created_at DESC").all(provider_id) as AddressRow[];
    return rows.map(rowToAddress);
  }
  const rows = limit !== null
    ? d.query(`SELECT * FROM addresses ORDER BY created_at DESC${pageSql}`).all(limit, offset) as AddressRow[]
    : d.query("SELECT * FROM addresses ORDER BY created_at DESC").all() as AddressRow[];
  return rows.map(rowToAddress);
}

export function listAddressesByProviderIds(providerIds: Iterable<string>, db?: Database): EmailAddress[] {
  const ids = [...new Set([...providerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const cloud = cloudAddresses(db);
  if (cloud) {
    // Cloud does not model the provider dimension; filter the cloud address set
    // by provider_id (empty cloud-side) rather than falling back to local SQLite.
    const idSet = new Set(ids);
    return cloud
      .list()
      .map(apiToAddress)
      .filter((a) => idSet.has(a.provider_id));
  }
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d
    .query(`SELECT * FROM addresses WHERE provider_id IN (${placeholders}) ORDER BY provider_id ASC, created_at DESC`)
    .all(...ids) as AddressRow[];
  return rows.map(rowToAddress);
}

const ADDRESS_READY_COUNTS_CTE = `
  WITH ready_counts AS (
    SELECT domain_id, COUNT(*) AS ready_addresses
      FROM addresses
     WHERE domain_id IS NOT NULL
       AND provisioning_status = 'ready'
     GROUP BY domain_id
  )
`;

const ADDRESS_DOMAIN_JOIN = `
  LEFT JOIN domains d ON d.id = (
    SELECT d2.id
      FROM domains d2
     WHERE d2.provider_id = a.provider_id
       AND LOWER(d2.domain) = LOWER(substr(a.email, instr(a.email, '@') + 1))
     ORDER BY d2.created_at ASC
     LIMIT 1
  )
  LEFT JOIN ready_counts rc ON rc.domain_id = d.id
`;

function addressReadinessWhere(opts: AddressReadinessOptions | undefined, params: SQLQueryBindings[]): string {
  const conditions: string[] = [];
  if (opts?.provider_id) {
    conditions.push("a.provider_id = ?");
    params.push(opts.provider_id);
  }
  if (opts?.owner_id) {
    conditions.push("(a.owner_id = ? OR a.administrator_id = ?)");
    params.push(opts.owner_id, opts.owner_id);
  }

  const readyAddresses = "COALESCE(rc.ready_addresses, 0)";
  const hasLastError = "NULLIF(d.last_error, '') IS NOT NULL";
  const broken = `(d.dkim_status = 'failed' OR d.spf_status = 'failed' OR d.dmarc_status = 'failed' OR ${hasLastError})`;
  const notBroken = `(d.dkim_status != 'failed' AND d.spf_status != 'failed' AND d.dmarc_status != 'failed' AND NOT ${hasLastError})`;
  const domainSendReady = `(${notBroken} AND d.dkim_status = 'verified' AND d.spf_status = 'verified')`;
  const lifecycleReceiveReady = "(d.inbound_status = 'ready')";
  const localDomainReceiveReady = `((${broken} AND ${readyAddresses} > 0) OR (${notBroken} AND (${readyAddresses} > 0 OR d.provisioning_status IN ('ready', 'inbound_ready') OR ${lifecycleReceiveReady})))`;
  const domainReceiveReady = `(CASE WHEN d.source_of_truth IN ('postgres', 'cloud') THEN ${lifecycleReceiveReady} ELSE ${localDomainReceiveReady} END)`;
  const addressSendReady = `(COALESCE(a.status, 'active') != 'suspended' AND (a.verified = 1 OR ${domainSendReady}))`;
  const addressReceiveReady = `(a.provisioning_status = 'ready' OR ${domainReceiveReady})`;

  if (!opts?.include_unverified) conditions.push(addressSendReady);
  if (opts?.send) conditions.push(addressSendReady);
  if (opts?.receive) conditions.push(addressReceiveReady);

  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

export function listAddressesForReadiness(opts: AddressReadinessOptions = {}, db?: Database): EmailAddress[] {
  const d = db || getDatabase();
  const params: SQLQueryBindings[] = [];
  const where = addressReadinessWhere(opts, params);
  const limit = safeOptionalLimit(opts.limit);
  const offset = safeOffset(opts.offset);
  const pageSql = limit !== null ? " LIMIT ? OFFSET ?" : "";
  if (limit !== null) params.push(limit, offset);
  const rows = d
    .query(`${ADDRESS_READY_COUNTS_CTE}
      SELECT a.*
        FROM addresses a
        ${ADDRESS_DOMAIN_JOIN}
        ${where}
       ORDER BY a.created_at DESC${pageSql}`)
    .all(...params) as AddressRow[];
  return rows.map(rowToAddress);
}

export function countAddressesForReadiness(opts: Omit<AddressReadinessOptions, "limit" | "offset"> = {}, db?: Database): number {
  const d = db || getDatabase();
  const params: SQLQueryBindings[] = [];
  const where = addressReadinessWhere(opts, params);
  const row = d
    .query(`${ADDRESS_READY_COUNTS_CTE}
      SELECT COUNT(*) AS count
        FROM addresses a
        ${ADDRESS_DOMAIN_JOIN}
        ${where}`)
    .get(...params) as { count: unknown } | null;
  const count = Number(row?.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export function listAddressEmails(provider_id?: string, db?: Database): string[] {
  const d = db || getDatabase();
  if (provider_id) {
    const rows = d.query("SELECT email FROM addresses WHERE provider_id = ? ORDER BY created_at DESC").all(provider_id) as Array<{ email: string }>;
    return rows.map((row) => row.email);
  }
  const rows = d.query("SELECT email FROM addresses ORDER BY created_at DESC").all() as Array<{ email: string }>;
  return rows.map((row) => row.email);
}

export function listActiveAddressEmails(provider_id?: string, db?: Database): string[] {
  const d = db || getDatabase();
  if (provider_id) {
    const rows = d
      .query("SELECT email FROM addresses WHERE provider_id = ? AND COALESCE(status, 'active') = 'active' ORDER BY created_at DESC")
      .all(provider_id) as Array<{ email: string }>;
    return rows.map((row) => row.email);
  }
  const rows = d
    .query("SELECT email FROM addresses WHERE COALESCE(status, 'active') = 'active' ORDER BY created_at DESC")
    .all() as Array<{ email: string }>;
  return rows.map((row) => row.email);
}

export function listActiveAddressCountsByDomain(db?: Database): Map<string, number> {
  const d = db || getDatabase();
  const rows = d
    .query(
      `SELECT LOWER(substr(email, instr(email, '@') + 1)) AS domain, COUNT(*) AS count
       FROM addresses
       WHERE COALESCE(status, 'active') = 'active'
         AND instr(email, '@') > 1
       GROUP BY domain`,
    )
    .all() as Array<{ domain: string; count: unknown }>;
  return new Map(rows.map((row) => [row.domain, Number(row.count) || 0]));
}

export function listActiveAddressCountsByDomains(domains: Iterable<string>, db?: Database): Map<string, number> {
  const normalized = [...new Set([...domains].map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = normalized.map(() => "?").join(", ");
  const rows = d
    .query(
      `SELECT LOWER(substr(email, instr(email, '@') + 1)) AS domain, COUNT(*) AS count
       FROM addresses
       WHERE COALESCE(status, 'active') = 'active'
         AND instr(email, '@') > 1
         AND LOWER(substr(email, instr(email, '@') + 1)) IN (${placeholders})
       GROUP BY domain`,
    )
    .all(...normalized) as Array<{ domain: string; count: unknown }>;
  return new Map(rows.map((row) => [row.domain, Number(row.count) || 0]));
}

export function getPreferredActiveAddressEmail(
  opts?: { provider_id?: string; domain?: string },
  db?: Database,
): string | null {
  const d = db || getDatabase();
  const conditions = ["COALESCE(status, 'active') = 'active'"];
  const params: string[] = [];
  if (opts?.provider_id) {
    conditions.push("provider_id = ?");
    params.push(opts.provider_id);
  }
  if (opts?.domain) {
    conditions.push("LOWER(email) LIKE ?");
    params.push(`%@${opts.domain.toLowerCase()}`);
  }
  const row = d.query(
    `SELECT email
     FROM addresses
     WHERE ${conditions.join(" AND ")}
     ORDER BY verified DESC, created_at DESC
     LIMIT 1`,
  ).get(...params) as { email: string } | null;
  return row?.email ?? null;
}

export function listUsableSendingAddresses(db?: Database, opts?: { limit?: number }): EmailAddress[] {
  const d = db || getDatabase();
  const limit = typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : null;
  if (limit !== null) {
    const rows = d
      .query("SELECT * FROM addresses WHERE verified = 1 AND COALESCE(status, 'active') != 'suspended' ORDER BY created_at DESC LIMIT ?")
      .all(limit) as AddressRow[];
    return rows.map(rowToAddress);
  }
  const rows = d
    .query("SELECT * FROM addresses WHERE verified = 1 AND COALESCE(status, 'active') != 'suspended' ORDER BY created_at DESC")
    .all() as AddressRow[];
  return rows.map(rowToAddress);
}

export function updateAddress(
  id: string,
  input: Partial<Pick<EmailAddress, "display_name" | "verified">>,
  db?: Database,
): EmailAddress {
  const cloud = cloudAddresses(db);
  if (cloud) {
    if (!cloud.get(id)) throw new AddressNotFoundError(id);
    const patch: Record<string, unknown> = {};
    if (input.display_name !== undefined) patch["display_name"] = input.display_name || null;
    if (input.verified !== undefined) patch["verified"] = input.verified;
    return apiToAddress(cloud.update(id, patch));
  }

  const d = db || getDatabase();
  const address = getAddress(id, d);
  if (!address) throw new AddressNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: (string | number | null)[] = [now()];

  if (input.display_name !== undefined) { sets.push("display_name = ?"); params.push(input.display_name || null); }
  if (input.verified !== undefined) { sets.push("verified = ?"); params.push(input.verified ? 1 : 0); }

  params.push(id);
  d.run(`UPDATE addresses SET ${sets.join(", ")} WHERE id = ?`, params);

  return getAddress(id, d)!;
}

export function deleteAddress(id: string, db?: Database): boolean {
  const cloud = cloudAddresses(db);
  if (cloud) return cloud.del(id);
  const d = db || getDatabase();
  const result = d.run("DELETE FROM addresses WHERE id = ?", [id]);
  return result.changes > 0;
}

export function markVerified(id: string, db?: Database): EmailAddress {
  const cloud = cloudAddresses(db);
  if (cloud) {
    if (!cloud.get(id)) throw new AddressNotFoundError(id);
    return apiToAddress(cloud.update(id, { verified: true }));
  }

  const d = db || getDatabase();
  const address = getAddress(id, d);
  if (!address) throw new AddressNotFoundError(id);

  d.run("UPDATE addresses SET verified = 1, updated_at = ? WHERE id = ?", [now(), id]);
  return getAddress(id, d)!;
}
