import type { Database } from "./database.js";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Domain, DnsStatus } from "../types/index.js";
import { DomainNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

interface DomainRow {
  id: string;
  provider_id: string;
  domain: string;
  dkim_status: string;
  spf_status: string;
  dmarc_status: string;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDomain(row: DomainRow): Domain {
  return {
    ...row,
    dkim_status: row.dkim_status as DnsStatus,
    spf_status: row.spf_status as DnsStatus,
    dmarc_status: row.dmarc_status as DnsStatus,
  };
}

export function createDomain(
  provider_id: string,
  domain: string,
  db?: Database,
): Domain {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO domains (id, provider_id, domain, dkim_status, spf_status, dmarc_status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'pending', 'pending', ?, ?)`,
    [id, provider_id, domain, timestamp, timestamp],
  );

  return getDomain(id, d)!;
}

export function getDomain(id: string, db?: Database): Domain | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM domains WHERE id = ?").get(id) as DomainRow | null;
  if (!row) return null;
  return rowToDomain(row);
}

export function getDomainByName(provider_id: string, domain: string, db?: Database): Domain | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM domains WHERE provider_id = ? AND domain = ? COLLATE NOCASE")
    .get(provider_id, domain.trim()) as DomainRow | null;
  if (!row) return null;
  return rowToDomain(row);
}

export function findDomainsByName(domain: string, db?: Database): Domain[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM domains WHERE domain = ? COLLATE NOCASE ORDER BY created_at DESC")
    .all(domain.trim()) as DomainRow[];
  return rows.map(rowToDomain);
}

export interface DomainProviderName {
  provider_id: string;
  domain: string;
}

export function listDomainsByProviderAndNames(pairs: Iterable<DomainProviderName>, db?: Database): Domain[] {
  const normalized = [...new Map([...pairs].map((pair) => {
    const providerId = pair.provider_id.trim();
    const domain = pair.domain.trim().toLowerCase();
    return [`${providerId}:${domain}`, { provider_id: providerId, domain }] as const;
  }).filter(([, pair]) => pair.provider_id && pair.domain)).values()];
  if (normalized.length === 0) return [];
  const d = db || getDatabase();
  const params: SQLQueryBindings[] = [];
  const clauses = normalized.map((pair) => {
    params.push(pair.provider_id, pair.domain);
    return "(provider_id = ? AND domain = ? COLLATE NOCASE)";
  });
  const rows = d
    .query(`SELECT * FROM domains WHERE ${clauses.join(" OR ")} ORDER BY created_at DESC`)
    .all(...params) as DomainRow[];
  return rows.map(rowToDomain);
}

export interface ListDomainOptions {
  limit?: number;
  offset?: number;
}

export interface UsableDomainOptions extends ListDomainOptions {
  provider_id?: string;
  send?: boolean;
  receive?: boolean;
}

export function listDomains(provider_id?: string, db?: Database, opts?: ListDomainOptions): Domain[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const pageSql = limit !== null ? " LIMIT ? OFFSET ?" : "";
  if (provider_id) {
    const rows = limit !== null
      ? d.query(`SELECT * FROM domains WHERE provider_id = ? ORDER BY created_at DESC${pageSql}`).all(provider_id, limit, offset) as DomainRow[]
      : d.query("SELECT * FROM domains WHERE provider_id = ? ORDER BY created_at DESC").all(provider_id) as DomainRow[];
    return rows.map(rowToDomain);
  }
  const rows = limit !== null
    ? d.query(`SELECT * FROM domains ORDER BY created_at DESC${pageSql}`).all(limit, offset) as DomainRow[]
    : d.query("SELECT * FROM domains ORDER BY created_at DESC").all() as DomainRow[];
  return rows.map(rowToDomain);
}

export function listDomainsByProviderIds(providerIds: Iterable<string>, db?: Database): Domain[] {
  const ids = [...new Set([...providerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d
    .query(`SELECT * FROM domains WHERE provider_id IN (${placeholders}) ORDER BY provider_id ASC, created_at DESC`)
    .all(...ids) as DomainRow[];
  return rows.map(rowToDomain);
}

const USABLE_DOMAIN_READY_COUNTS_CTE = `
  WITH ready_counts AS (
    SELECT domain_id, COUNT(*) AS ready_addresses
      FROM addresses
     WHERE domain_id IS NOT NULL
       AND provisioning_status = 'ready'
     GROUP BY domain_id
  )
`;

function usableDomainWhere(opts: UsableDomainOptions | undefined, params: SQLQueryBindings[]): string {
  const conditions: string[] = [];
  if (opts?.provider_id) {
    conditions.push("d.provider_id = ?");
    params.push(opts.provider_id);
  }

  const readyAddresses = "COALESCE(rc.ready_addresses, 0)";
  const hasLastError = "NULLIF(d.last_error, '') IS NOT NULL";
  const broken = `(d.dkim_status = 'failed' OR d.spf_status = 'failed' OR d.dmarc_status = 'failed' OR ${hasLastError})`;
  const notBroken = `(d.dkim_status != 'failed' AND d.spf_status != 'failed' AND d.dmarc_status != 'failed' AND NOT ${hasLastError})`;
  const sendReady = `(${notBroken} AND d.dkim_status = 'verified' AND d.spf_status = 'verified')`;
  const receiveReady = `((${broken} AND ${readyAddresses} > 0) OR (${notBroken} AND (${readyAddresses} > 0 OR d.provisioning_status IN ('ready', 'inbound_ready'))))`;

  if (opts?.send && opts.receive) conditions.push(`(${sendReady} AND ${receiveReady})`);
  else if (opts?.send) conditions.push(sendReady);
  else if (opts?.receive) conditions.push(receiveReady);
  else conditions.push(`(${sendReady} OR ${receiveReady})`);

  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

export function listUsableDomains(opts: UsableDomainOptions = {}, db?: Database): Domain[] {
  const d = db || getDatabase();
  const params: SQLQueryBindings[] = [];
  const where = usableDomainWhere(opts, params);
  const limit = safeOptionalLimit(opts.limit);
  const offset = safeOffset(opts.offset);
  const limitSql = limit !== null ? " LIMIT ? OFFSET ?" : "";
  if (limit !== null) params.push(limit, offset);
  const rows = d
    .query(`${USABLE_DOMAIN_READY_COUNTS_CTE}
      SELECT d.*
        FROM domains d
        LEFT JOIN ready_counts rc ON rc.domain_id = d.id
        ${where}
       ORDER BY d.created_at DESC${limitSql}`)
    .all(...params) as DomainRow[];
  return rows.map(rowToDomain);
}

export function countUsableDomains(opts: Omit<UsableDomainOptions, "limit" | "offset"> = {}, db?: Database): number {
  const d = db || getDatabase();
  const params: SQLQueryBindings[] = [];
  const where = usableDomainWhere(opts, params);
  const row = d
    .query(`${USABLE_DOMAIN_READY_COUNTS_CTE}
      SELECT COUNT(*) AS count
        FROM domains d
        LEFT JOIN ready_counts rc ON rc.domain_id = d.id
        ${where}`)
    .get(...params) as { count: unknown } | null;
  const count = Number(row?.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export function updateDomain(
  id: string,
  input: Partial<Pick<Domain, "dkim_status" | "spf_status" | "dmarc_status" | "verified_at">>,
  db?: Database,
): Domain {
  const d = db || getDatabase();
  const domain = getDomain(id, d);
  if (!domain) throw new DomainNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: (string | null)[] = [now()];

  if (input.dkim_status !== undefined) { sets.push("dkim_status = ?"); params.push(input.dkim_status); }
  if (input.spf_status !== undefined) { sets.push("spf_status = ?"); params.push(input.spf_status); }
  if (input.dmarc_status !== undefined) { sets.push("dmarc_status = ?"); params.push(input.dmarc_status); }
  if (input.verified_at !== undefined) { sets.push("verified_at = ?"); params.push(input.verified_at); }

  params.push(id);
  d.run(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`, params);

  return getDomain(id, d)!;
}

export function deleteDomain(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM domains WHERE id = ?", [id]);
  return result.changes > 0;
}

export function updateDnsStatus(
  id: string,
  dkim: DnsStatus,
  spf: DnsStatus,
  dmarc: DnsStatus,
  db?: Database,
): Domain {
  const d = db || getDatabase();
  const domain = getDomain(id, d);
  if (!domain) throw new DomainNotFoundError(id);

  const allVerified = dkim === "verified" && spf === "verified" && dmarc === "verified";
  const timestamp = now();

  d.run(
    `UPDATE domains SET dkim_status = ?, spf_status = ?, dmarc_status = ?, verified_at = ?, updated_at = ? WHERE id = ?`,
    [dkim, spf, dmarc, allVerified ? timestamp : domain.verified_at, timestamp, id],
  );

  return getDomain(id, d)!;
}
