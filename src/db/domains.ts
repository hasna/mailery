import type { Database } from "./database.js";
import type { SQLQueryBindings } from "bun:sqlite";
import type {
  Domain,
  DnsStatus,
  DomainMonitoringStatus,
  DomainOwnershipStatus,
  DomainRouteStatus,
  DomainSourceOfTruth,
  DomainType,
} from "../types/index.js";
import { DomainNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { parseJsonObject } from "./json.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedStoreFor, isSelfHostedMode, type SelfHostedResourceStore } from "./self-hosted-store.js";

// ============================================================================
// Self-hosted (self_hosted) routing
// ============================================================================
//
// When the client-flip resolves to selfHosted (mode=self_hosted + HASNA_EMAILS_API_URL
// + EMAILS_SELF_HOSTED_API_KEY), the `domains` resource is served by the app's selfHosted
// HTTP API (<API_URL>/v1/domains) instead of the local SQLite store. An explicit
// `db` argument always means "use this local database" (tests / tooling), so
// selfHosted routing is skipped whenever a caller passes `db`.
const DOMAIN_RESOURCE = "domains";

// Route to the selfHosted store whenever the client is flipped to self_hosted. The
// `db` argument is intentionally ignored here: the app's CLI passes an explicit
// local `getDatabase()` handle to every repo call, so keying on it would defeat
// selfHosted routing. Tests never set the selfHosted env, so isSelfHostedMode() is false there
// and the local SQLite path is always used.
function selfHostedDomains(_db?: Database): SelfHostedResourceStore | null {
  if (!isSelfHostedMode()) return null;
  return selfHostedStoreFor(DOMAIN_RESOURCE);
}

/** Map a selfHosted API domain entity to the local rich Domain shape (defaults filled). */
function apiToDomain(e: Record<string, unknown>): Domain {
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  const verified = Boolean(e["verified"]);
  const dns: DnsStatus = verified ? "verified" : "pending";
  const updatedAt = str(e["updated_at"]) ?? new Date().toISOString();
  const createdAt = str(e["created_at"]) ?? updatedAt;
  return {
    id: String(e["id"]),
    provider_id: str(e["provider"] ?? e["provider_id"]) ?? "self_hosted",
    domain: String(e["domain"] ?? ""),
    domain_type: "self_hosted",
    source_of_truth: "postgres",
    ownership_status: verified ? "verified" : "pending",
    inbound_status: "pending",
    outbound_status: "pending",
    monitoring_status: "none",
    dkim_status: dns,
    spf_status: dns,
    dmarc_status: dns,
    dns_records: {},
    provider_metadata: {},
    verified_at: verified ? updatedAt : null,
    last_dns_check_at: null,
    last_inbound_check_at: null,
    last_outbound_check_at: null,
    last_monitored_at: null,
    restricted_at: null,
    suspended_at: null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

interface DomainRow {
  id: string;
  provider_id: string;
  domain: string;
  domain_type: string;
  source_of_truth: string;
  ownership_status: string;
  inbound_status: string;
  outbound_status: string;
  monitoring_status: string;
  dkim_status: string;
  spf_status: string;
  dmarc_status: string;
  dns_records_json: string | null;
  provider_metadata_json: string | null;
  verified_at: string | null;
  last_dns_check_at: string | null;
  last_inbound_check_at: string | null;
  last_outbound_check_at: string | null;
  last_monitored_at: string | null;
  restricted_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDomain(row: DomainRow): Domain {
  return {
    ...row,
    domain_type: row.domain_type as DomainType,
    source_of_truth: row.source_of_truth as DomainSourceOfTruth,
    ownership_status: row.ownership_status as DomainOwnershipStatus,
    inbound_status: row.inbound_status as DomainRouteStatus,
    outbound_status: row.outbound_status as DomainRouteStatus,
    monitoring_status: row.monitoring_status as DomainMonitoringStatus,
    dkim_status: row.dkim_status as DnsStatus,
    spf_status: row.spf_status as DnsStatus,
    dmarc_status: row.dmarc_status as DnsStatus,
    dns_records: parseJsonObject(row.dns_records_json),
    provider_metadata: parseJsonObject(row.provider_metadata_json),
  };
}

export function createDomain(
  provider_id: string,
  domain: string,
  db?: Database,
): Domain {
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    const created = selfHosted.create({ domain, provider: provider_id });
    return apiToDomain(created);
  }

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
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    const entity = selfHosted.get(id);
    return entity ? apiToDomain(entity) : null;
  }

  const d = db || getDatabase();
  const row = d.query("SELECT * FROM domains WHERE id = ?").get(id) as DomainRow | null;
  if (!row) return null;
  return rowToDomain(row);
}

export function getDomainByName(provider_id: string, domain: string, db?: Database): Domain | null {
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    // A self-hosted deployment is one operator-owned instance; match by domain
    // name because the local provider row is not part of the service identity.
    const name = domain.trim().toLowerCase();
    const match = selfHosted
      .list({ limit: 1000 })
      .map(apiToDomain)
      .find((dm) => dm.domain.toLowerCase() === name);
    return match ?? null;
  }

  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM domains WHERE provider_id = ? AND domain = ? COLLATE NOCASE")
    .get(provider_id, domain.trim()) as DomainRow | null;
  if (!row) return null;
  return rowToDomain(row);
}

export function findDomainsByName(domain: string, db?: Database): Domain[] {
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    const name = domain.trim().toLowerCase();
    return selfHosted
      .list({ limit: 1000 })
      .map(apiToDomain)
      .filter((dm) => dm.domain.toLowerCase() === name)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  }

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
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    const lim = safeOptionalLimit(opts?.limit);
    const off = safeOffset(opts?.offset);
    // Fetch a bounded superset (never a server-side offset) so the client-side
    // provider filter + local windowing return a correct page. Sending a server
    // offset AND slicing locally double-windows the page (offset>0 => empty).
    const query: Record<string, string | number | undefined> = {};
    if (lim !== null) query["limit"] = Math.max(1000, lim + off);
    let domains = selfHosted.list(query).map(apiToDomain);
    if (provider_id) domains = domains.filter((dm) => dm.provider_id === provider_id);
    domains.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return lim === null ? domains : domains.slice(off, off + lim);
  }

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
  const lifecycleReceiveReady = "(d.inbound_status = 'ready')";
  const localReceiveReady = `((${broken} AND ${readyAddresses} > 0) OR (${notBroken} AND (${readyAddresses} > 0 OR d.provisioning_status IN ('ready', 'inbound_ready') OR ${lifecycleReceiveReady})))`;
  const receiveReady = `(CASE WHEN d.source_of_truth = 'postgres' THEN ${lifecycleReceiveReady} ELSE ${localReceiveReady} END)`;

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
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    const current = selfHosted.get(id);
    if (!current) throw new DomainNotFoundError(id);
    const verified =
      input.verified_at != null ||
      (input.dkim_status === "verified" && input.spf_status === "verified" && input.dmarc_status === "verified");
    const updated = verified ? selfHosted.update(id, { verified: true }) : current;
    return apiToDomain(updated);
  }

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

export interface DomainReadinessUpdate {
  domain_type?: DomainType;
  source_of_truth?: DomainSourceOfTruth;
  ownership_status?: DomainOwnershipStatus;
  inbound_status?: DomainRouteStatus;
  outbound_status?: DomainRouteStatus;
  monitoring_status?: DomainMonitoringStatus;
  dns_records?: Record<string, unknown>;
  provider_metadata?: Record<string, unknown>;
  last_dns_check_at?: string | null;
  last_inbound_check_at?: string | null;
  last_outbound_check_at?: string | null;
  last_monitored_at?: string | null;
  restricted_at?: string | null;
  suspended_at?: string | null;
}

export function updateDomainReadiness(
  id: string,
  input: DomainReadinessUpdate,
  db?: Database,
): Domain {
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    // The selfHosted domain schema does not carry the local lifecycle/readiness
    // fields; return the current selfHosted record so callers (e.g. `domain add`)
    // still get a valid Domain back.
    const current = selfHosted.get(id);
    if (!current) throw new DomainNotFoundError(id);
    return apiToDomain(current);
  }

  const d = db || getDatabase();
  const domain = getDomain(id, d);
  if (!domain) throw new DomainNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: (string | null)[] = [now()];
  const col = (name: string, value: string | null) => { sets.push(`${name} = ?`); params.push(value); };

  if (input.domain_type !== undefined) col("domain_type", input.domain_type);
  if (input.source_of_truth !== undefined) col("source_of_truth", input.source_of_truth);
  if (input.ownership_status !== undefined) col("ownership_status", input.ownership_status);
  if (input.inbound_status !== undefined) col("inbound_status", input.inbound_status);
  if (input.outbound_status !== undefined) col("outbound_status", input.outbound_status);
  if (input.monitoring_status !== undefined) col("monitoring_status", input.monitoring_status);
  if (input.dns_records !== undefined) col("dns_records_json", JSON.stringify(input.dns_records));
  if (input.provider_metadata !== undefined) col("provider_metadata_json", JSON.stringify(input.provider_metadata));
  if (input.last_dns_check_at !== undefined) col("last_dns_check_at", input.last_dns_check_at);
  if (input.last_inbound_check_at !== undefined) col("last_inbound_check_at", input.last_inbound_check_at);
  if (input.last_outbound_check_at !== undefined) col("last_outbound_check_at", input.last_outbound_check_at);
  if (input.last_monitored_at !== undefined) col("last_monitored_at", input.last_monitored_at);
  if (input.restricted_at !== undefined) col("restricted_at", input.restricted_at);
  if (input.suspended_at !== undefined) col("suspended_at", input.suspended_at);

  params.push(id);
  d.run(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`, params);
  return getDomain(id, d)!;
}

export interface MoveDomainProviderResult {
  domain: Domain;
  from_provider_id: string;
  to_provider_id: string;
  moved_addresses: number;
}

export function moveDomainProvider(id: string, toProviderId: string, db?: Database): MoveDomainProviderResult {
  const d = db || getDatabase();
  const domain = getDomain(id, d);
  if (!domain) throw new DomainNotFoundError(id);

  if (domain.provider_id === toProviderId) {
    return {
      domain,
      from_provider_id: domain.provider_id,
      to_provider_id: toProviderId,
      moved_addresses: 0,
    };
  }

  const targetDomain = getDomainByName(toProviderId, domain.domain, d);
  if (targetDomain && targetDomain.id !== id) {
    throw new Error(`Target provider already has domain ${domain.domain} (${targetDomain.id})`);
  }

  const conflicts = d
    .query(
      `SELECT a.email
         FROM addresses a
        WHERE a.provider_id = ?
          AND LOWER(substr(a.email, instr(a.email, '@') + 1)) = LOWER(?)
          AND EXISTS (
            SELECT 1
              FROM addresses b
             WHERE b.provider_id = ?
               AND b.email = a.email COLLATE NOCASE
               AND b.id != a.id
          )
        ORDER BY a.email ASC
        LIMIT 10`,
    )
    .all(domain.provider_id, domain.domain, toProviderId) as Array<{ email: string }>;
  if (conflicts.length > 0) {
    const shown = conflicts.map((row) => row.email).join(", ");
    throw new Error(`Target provider already has matching address row(s): ${shown}`);
  }

  const timestamp = now();
  d.run("BEGIN");
  try {
    d.run("UPDATE domains SET provider_id = ?, updated_at = ? WHERE id = ?", [toProviderId, timestamp, id]);
    const moved = d.run(
      `UPDATE addresses
          SET provider_id = ?, domain_id = ?, updated_at = ?
        WHERE provider_id = ?
          AND LOWER(substr(email, instr(email, '@') + 1)) = LOWER(?)`,
      [toProviderId, id, timestamp, domain.provider_id, domain.domain],
    );
    d.run("COMMIT");
    return {
      domain: getDomain(id, d)!,
      from_provider_id: domain.provider_id,
      to_provider_id: toProviderId,
      moved_addresses: moved.changes,
    };
  } catch (error) {
    try { d.run("ROLLBACK"); } catch {}
    throw error;
  }
}

export function deleteDomain(id: string, db?: Database): boolean {
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    return selfHosted.del(id);
  }

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
  const selfHosted = selfHostedDomains(db);
  if (selfHosted) {
    const current = selfHosted.get(id);
    if (!current) throw new DomainNotFoundError(id);
    const allVerifiedSelfHosted = dkim === "verified" && spf === "verified" && dmarc === "verified";
    const updated = allVerifiedSelfHosted ? selfHosted.update(id, { verified: true }) : current;
    return apiToDomain(updated);
  }

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
