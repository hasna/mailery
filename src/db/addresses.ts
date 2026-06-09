import type { Database } from "./database.js";
import type { SQLQueryBindings } from "bun:sqlite";
import type { AddressRow, CreateAddressInput, EmailAddress } from "../types/index.js";
import { AddressNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

function rowToAddress(row: AddressRow): EmailAddress {
  return {
    ...row,
    verified: !!row.verified,
    status: row.status ?? "active",
    daily_quota: row.daily_quota ?? null,
  };
}

export function createAddress(input: CreateAddressInput, db?: Database): EmailAddress {
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
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM addresses WHERE id = ?").get(id) as AddressRow | null;
  if (!row) return null;
  return rowToAddress(row);
}

export function getAddressByEmail(provider_id: string, email: string, db?: Database): EmailAddress | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM addresses WHERE provider_id = ? AND email = ?").get(provider_id, email) as AddressRow | null;
  if (!row) return null;
  return rowToAddress(row);
}

export function findAddressesByEmail(email: string, db?: Database): EmailAddress[] {
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
  const domainReceiveReady = `((${broken} AND ${readyAddresses} > 0) OR (${notBroken} AND (${readyAddresses} > 0 OR d.provisioning_status IN ('ready', 'inbound_ready'))))`;
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
  const d = db || getDatabase();
  const result = d.run("DELETE FROM addresses WHERE id = ?", [id]);
  return result.changes > 0;
}

export function markVerified(id: string, db?: Database): EmailAddress {
  const d = db || getDatabase();
  const address = getAddress(id, d);
  if (!address) throw new AddressNotFoundError(id);

  d.run("UPDATE addresses SET verified = 1, updated_at = ? WHERE id = ?", [now(), id]);
  return getAddress(id, d)!;
}
