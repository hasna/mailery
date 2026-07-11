import type { Database } from "./database.js";
import type { CreateProviderInput, Provider, ProviderRow, ProviderSummary, ProviderType } from "../types/index.js";
import { ProviderNotFoundError } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import { selfHostedResource, selfHostedListQuery, selfHostedPage, cbool, ciso, cstr, cstrOrNull } from "./self-hosted-resource.js";

const PROVIDER_RESOURCE = "providers";
const SUPPORTED_PROVIDER_TYPES = ["resend", "ses", "sandbox"] as const;
const SUPPORTED_PROVIDER_TYPE_SQL = "'resend', 'ses', 'sandbox'";

function isSupportedProviderType(value: string): value is ProviderType {
  return (SUPPORTED_PROVIDER_TYPES as readonly string[]).includes(value);
}

function assertSupportedProviderType(value: string): asserts value is ProviderType {
  if (!isSupportedProviderType(value)) {
    throw new Error("Provider type must be 'resend', 'ses', or 'sandbox'");
  }
}

// The selfHosted `providers` resource carries only NON-SECRET metadata (id, name,
// type, region, active, timestamps) — provider credentials (api_key/secret_key/
// oauth tokens) are never distributed to or fetched by a client. Secret columns
// map to null; a flipped client uses selfHosted-side send (`/v1/send`), not local
// provider secrets. So `provider list` shows the selfHosted inventory, not secrets.
function apiToProviderSummary(e: Record<string, unknown>): ProviderSummary {
  const updatedAt = ciso(e["updated_at"]);
  const type = cstr(e["type"]);
  assertSupportedProviderType(type);
  return {
    id: cstr(e["id"]),
    name: cstr(e["name"]),
    type,
    region: cstrOrNull(e["region"]),
    active: cbool(e["active"]),
    created_at: ciso(e["created_at"], updatedAt),
    updated_at: updatedAt,
  };
}

function apiToProvider(e: Record<string, unknown>): Provider {
  return {
    ...apiToProviderSummary(e),
    api_key: null,
    access_key: null,
    secret_key: null,
    oauth_client_id: null,
    oauth_client_secret: null,
    oauth_refresh_token: null,
    oauth_access_token: null,
    oauth_token_expiry: null,
  };
}

function rowToProvider(row: ProviderRow): Provider {
  assertSupportedProviderType(row.type);
  return {
    ...row,
    active: !!row.active,
    type: row.type,
  };
}

interface ProviderSummaryRow {
  id: string;
  name: string;
  type: string;
  region: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

const PROVIDER_COLUMNS = [
  "id",
  "name",
  "type",
  "api_key",
  "region",
  "access_key",
  "secret_key",
  "oauth_client_id",
  "oauth_client_secret",
  "oauth_refresh_token",
  "oauth_access_token",
  "oauth_token_expiry",
  "active",
  "created_at",
  "updated_at",
].join(", ");

const PROVIDER_SUMMARY_COLUMNS = [
  "id",
  "name",
  "type",
  "region",
  "active",
  "created_at",
  "updated_at",
].join(", ");

function rowToProviderSummary(row: ProviderSummaryRow): ProviderSummary {
  assertSupportedProviderType(row.type);
  return {
    ...row,
    active: !!row.active,
    type: row.type,
  };
}

export function createProvider(input: CreateProviderInput, db?: Database): Provider {
  assertSupportedProviderType(input.type);
  const selfHosted = selfHostedResource(PROVIDER_RESOURCE);
  if (selfHosted) {
    return apiToProvider(selfHosted.create({
      name: input.name,
      type: input.type,
      region: input.region || null,
      active: true,
    }));
  }
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO providers (id, name, type, api_key, region, access_key, secret_key,
       oauth_client_id, oauth_client_secret, oauth_refresh_token, oauth_access_token, oauth_token_expiry,
       active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      input.name,
      input.type,
      input.api_key || null,
      input.region || null,
      input.access_key || null,
      input.secret_key || null,
      null,
      null,
      null,
      null,
      null,
      timestamp,
      timestamp,
    ],
  );

  return getProvider(id, d)!;
}

export function getProvider(id: string, db?: Database): Provider | null {
  const selfHosted = selfHostedResource(PROVIDER_RESOURCE);
  if (selfHosted) {
    const record = selfHosted.get(id);
    return record ? apiToProvider(record) : null;
  }
  const d = db || getDatabase();
  const row = d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL})`).get(id) as ProviderRow | null;
  if (!row) return null;
  return rowToProvider(row);
}

export function resolveProviderId(id: string, db?: Database): string | null {
  const selfHosted = selfHostedResource(PROVIDER_RESOURCE);
  if (selfHosted) {
    const trimmed = id.trim();
    if (!trimmed) return null;
    if (trimmed.length >= 36) return selfHosted.get(trimmed) ? trimmed : null;
    const matches = selfHosted.list({ limit: 1000 })
      .map((row) => cstr(row["id"]))
      .filter((providerId) => providerId.startsWith(trimmed));
    return matches.length === 1 ? matches[0]! : null;
  }
  const d = db || getDatabase();
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (trimmed.length >= 36) {
    const row = d.query(`SELECT id FROM providers WHERE id = ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL})`).get(trimmed) as { id: string } | null;
    return row?.id ?? null;
  }
  const rows = d.query(`SELECT id FROM providers WHERE id LIKE ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL})`).all(`${trimmed}%`) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0]!.id : null;
}

export function getProviderByNameAndType(name: string, type: ProviderType, db?: Database): Provider | null {
  const d = db || getDatabase();
  const row = d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE name = ? AND type = ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL})`).get(name, type) as ProviderRow | null;
  return row ? rowToProvider(row) : null;
}

export interface ListProviderOptions {
  limit?: number;
  offset?: number;
}

export function listProviders(db?: Database, opts?: ListProviderOptions): Provider[] {
  const selfHosted = selfHostedResource(PROVIDER_RESOURCE);
  if (selfHosted) {
    const { query, limit, offset } = selfHostedListQuery(opts);
    const rows = selfHosted.list(query)
      .filter((row) => isSupportedProviderType(cstr(row["type"])))
      .map(apiToProvider);
    rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return selfHostedPage(rows, limit, offset);
  }

  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = limit !== null
    ? d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as ProviderRow[]
    : d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC`).all() as ProviderRow[];
  return rows.map(rowToProvider);
}

export function listProviderSummaries(db?: Database, opts?: ListProviderOptions): ProviderSummary[] {
  const selfHosted = selfHostedResource(PROVIDER_RESOURCE);
  if (selfHosted) {
    const { query, limit, offset } = selfHostedListQuery(opts);
    const rows = selfHosted.list(query)
      .filter((row) => isSupportedProviderType(cstr(row["type"])))
      .map(apiToProviderSummary);
    rows.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return selfHostedPage(rows, limit, offset);
  }

  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = limit !== null
    ? d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as ProviderSummaryRow[]
    : d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC`).all() as ProviderSummaryRow[];
  return rows.map(rowToProviderSummary);
}

export function listProviderNamesByIds(providerIds: Iterable<string>, db?: Database): Map<string, string> {
  const ids = [...new Set([...providerIds].map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const d = db || getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = d.query(`SELECT id, name FROM providers WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string; name: string }>;
  return new Map(rows.map((row) => [row.id, row.name]));
}

export function listActiveProviders(type?: ProviderType, db?: Database): Provider[] {
  const d = db || getDatabase();
  const rows = type
    ? d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type = ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC`).all(type) as ProviderRow[]
    : d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC`).all() as ProviderRow[];
  return rows.map(rowToProvider);
}

export function listActiveProviderSummaries(type?: ProviderType, db?: Database, opts?: ListProviderOptions): ProviderSummary[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = type
    ? (limit !== null
        ? d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE active = 1 AND type = ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(type, limit, offset) as ProviderSummaryRow[]
        : d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE active = 1 AND type = ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC`).all(type) as ProviderSummaryRow[])
    : (limit !== null
        ? d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE active = 1 AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as ProviderSummaryRow[]
        : d.query(`SELECT ${PROVIDER_SUMMARY_COLUMNS} FROM providers WHERE active = 1 AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC`).all() as ProviderSummaryRow[]);
  return rows.map(rowToProviderSummary);
}

export function getLatestActiveProvider(type?: ProviderType, db?: Database): Provider | null {
  const d = db || getDatabase();
  const row = type
    ? d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type = ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC LIMIT 1`).get(type) as ProviderRow | null
    : d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC LIMIT 1`).get() as ProviderRow | null;
  return row ? rowToProvider(row) : null;
}

export function getLatestActiveProviderId(type?: ProviderType, db?: Database): string | null {
  const d = db || getDatabase();
  const row = type
    ? d.query(`SELECT id FROM providers WHERE active = 1 AND type = ? AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC LIMIT 1`).get(type) as { id: string } | null
    : d.query(`SELECT id FROM providers WHERE active = 1 AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | null;
  return row?.id ?? null;
}

export function updateProvider(
  id: string,
  input: Partial<CreateProviderInput> & { active?: boolean },
  db?: Database,
): Provider {
  const selfHosted = selfHostedResource(PROVIDER_RESOURCE);
  if (selfHosted) {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch["name"] = input.name;
    if (input.type !== undefined) {
      assertSupportedProviderType(input.type);
      patch["type"] = input.type;
    }
    if (input.region !== undefined) patch["region"] = input.region || null;
    if (input.active !== undefined) patch["active"] = input.active;
    return apiToProvider(selfHosted.update(id, patch));
  }
  const d = db || getDatabase();
  const provider = getProvider(id, d);
  if (!provider) throw new ProviderNotFoundError(id);

  const sets: string[] = ["updated_at = ?"];
  const params: (string | number | null)[] = [now()];

  if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
  if (input.type !== undefined) {
    assertSupportedProviderType(input.type);
    sets.push("type = ?");
    params.push(input.type);
  }
  if (input.api_key !== undefined) { sets.push("api_key = ?"); params.push(input.api_key || null); }
  if (input.region !== undefined) { sets.push("region = ?"); params.push(input.region || null); }
  if (input.access_key !== undefined) { sets.push("access_key = ?"); params.push(input.access_key || null); }
  if (input.secret_key !== undefined) { sets.push("secret_key = ?"); params.push(input.secret_key || null); }
  if (input.active !== undefined) { sets.push("active = ?"); params.push(input.active ? 1 : 0); }

  params.push(id);
  d.run(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`, params);

  return getProvider(id, d)!;
}

export function deleteProvider(id: string, db?: Database): boolean {
  const selfHosted = selfHostedResource(PROVIDER_RESOURCE);
  if (selfHosted) return selfHosted.del(id);
  const d = db || getDatabase();
  const result = d.run("DELETE FROM providers WHERE id = ?", [id]);
  return result.changes > 0;
}

export function getActiveProvider(db?: Database): Provider {
  const d = db || getDatabase();
  const row = d.query(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE active = 1 AND type IN (${SUPPORTED_PROVIDER_TYPE_SQL}) ORDER BY created_at LIMIT 1`).get() as ProviderRow | null;
  if (!row) throw new ProviderNotFoundError("(no active provider)");
  return rowToProvider(row);
}
