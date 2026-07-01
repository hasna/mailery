import type { Database } from "./database.js";
import { getDatabase, rebuildInboundLabelState, reconcileMailboxMessageState } from "./database.js";
import type { PgAdapterAsync } from "./remote-storage.js";
import { getCanonicalOpenEmailsRdsConfig, type CanonicalOpenEmailsRdsConfig } from "../lib/config.js";
import {
  HASNA_EMAILS_MODE_ENV,
  LEGACY_STORAGE_MODE_ENV,
  LEGACY_STORAGE_MODE_FALLBACK_ENV,
  MAILERY_MODE_ENV,
  resolveMaileryMode,
  type MaileryMode,
  type MaileryModeLabel,
  type MaileryModeSource,
} from "../lib/mode.js";

export const STORAGE_TABLES = [
  "providers",
  "owners",
  "domains",
  "addresses",
  "emails",
  "inbound_emails",
  "inbound_recipients",
  "inbound_labels",
  "mailboxes",
  "mailbox_sources",
  "mail_folders",
  "mail_messages",
  "mailbox_message_state",
  "events",
  "templates",
  "contacts",
  "scheduled_emails",
  "groups",
  "group_members",
  "email_content",
  "sandbox_emails",
  "sequences",
  "sequence_steps",
  "sequence_enrollments",
  "warming_schedules",
  "gmail_sync_state",
  "aliases",
  "send_keys",
  "forwarding_rules",
  "forwarding_deliveries",
  "address_ownership_events",
  "provisioning_events",
  "email_triage",
  "email_agent_settings",
  "email_agent_runs",
  "email_digests",
  "feedback",
] as const;
export const EMAILS_STORAGE_TABLES = STORAGE_TABLES;

type StorageTable = (typeof STORAGE_TABLES)[number];
type Row = Record<string, unknown>;
export const STORAGE_SYNC_BATCH_SIZE = 500;

const PRIMARY_KEYS: Record<StorageTable, string[]> = {
  providers: ["id"],
  owners: ["id"],
  domains: ["id"],
  addresses: ["id"],
  emails: ["id"],
  inbound_emails: ["id"],
  inbound_recipients: ["inbound_email_id", "address"],
  inbound_labels: ["inbound_email_id", "label"],
  mailboxes: ["id"],
  mailbox_sources: ["id"],
  mail_folders: ["id"],
  mail_messages: ["id"],
  mailbox_message_state: ["mailbox_id", "mail_message_id"],
  events: ["id"],
  templates: ["id"],
  contacts: ["id"],
  scheduled_emails: ["id"],
  groups: ["id"],
  group_members: ["group_id", "email"],
  email_content: ["email_id"],
  sandbox_emails: ["id"],
  sequences: ["id"],
  sequence_steps: ["id"],
  sequence_enrollments: ["id"],
  warming_schedules: ["id"],
  gmail_sync_state: ["provider_id"],
  aliases: ["id"],
  send_keys: ["id"],
  forwarding_rules: ["id"],
  forwarding_deliveries: ["id"],
  address_ownership_events: ["id"],
  provisioning_events: ["id"],
  email_triage: ["id"],
  email_agent_settings: ["agent_key"],
  email_agent_runs: ["id"],
  email_digests: ["id"],
  feedback: ["id"],
};

export interface SyncResult {
  table: string;
  rowsRead: number;
  rowsWritten: number;
  errors: string[];
}

export interface SyncMeta {
  table_name: string;
  last_synced_at: string | null;
  direction: "push" | "pull";
}

export interface StorageSyncOptions {
  tables?: string[];
  batchSize?: number;
  force?: boolean;
}

export interface StorageSyncHooks {
  pull?: (options?: StorageSyncOptions) => Promise<SyncResult[]>;
  push?: (options?: StorageSyncOptions) => Promise<SyncResult[]>;
}

export type StorageMode = MaileryMode;

export interface StorageEnv {
  name: string;
}

export interface StorageStatus {
  configured: boolean;
  mode: StorageMode;
  modeLabel: MaileryModeLabel;
  modeSource: MaileryModeSource;
  modeWarning: string | null;
  env: typeof STORAGE_DATABASE_ENV;
  modeEnv: typeof STORAGE_MODE_ENV;
  activeEnv: string | null;
  canonical: CanonicalOpenEmailsRdsConfig;
  service: "emails";
  tables: readonly StorageTable[];
  sync: SyncMeta[];
}

export const EMAILS_STORAGE_ENV = "HASNA_EMAILS_DATABASE_URL";
export const EMAILS_STORAGE_FALLBACK_ENV = "EMAILS_DATABASE_URL";
export const EMAILS_STORAGE_MODE_ENV = LEGACY_STORAGE_MODE_ENV;
export const EMAILS_STORAGE_MODE_FALLBACK_ENV = LEGACY_STORAGE_MODE_FALLBACK_ENV;
export const STORAGE_DATABASE_ENV = [EMAILS_STORAGE_ENV, EMAILS_STORAGE_FALLBACK_ENV] as const;
export const STORAGE_MODE_ENV = [MAILERY_MODE_ENV, HASNA_EMAILS_MODE_ENV, EMAILS_STORAGE_MODE_ENV, EMAILS_STORAGE_MODE_FALLBACK_ENV] as const;

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getStorageDatabaseEnv(): StorageEnv | null {
  const name = getStorageDatabaseEnvName();
  return name ? { name } : null;
}

export function getStorageDatabaseEnvName(): (typeof STORAGE_DATABASE_ENV)[number] | null {
  for (const name of STORAGE_DATABASE_ENV) {
    if (readEnv(name)) return name;
  }
  return null;
}

export function getStorageDatabaseUrl(): string | null {
  const env = getStorageDatabaseEnv();
  return env ? readEnv(env.name) : null;
}

export function getStorageMode(): StorageMode {
  return resolveMaileryMode({ migrateConfig: true }).mode;
}

export function getStorageStatus(): StorageStatus {
  const activeEnv = getStorageDatabaseEnv();
  const mode = resolveMaileryMode({ migrateConfig: true });
  return {
    configured: Boolean(activeEnv),
    mode: mode.mode,
    modeLabel: mode.label,
    modeSource: mode.source,
    modeWarning: mode.warning,
    env: STORAGE_DATABASE_ENV,
    modeEnv: STORAGE_MODE_ENV,
    activeEnv: activeEnv?.name ?? null,
    canonical: getCanonicalOpenEmailsRdsConfig(),
    service: "emails",
    tables: STORAGE_TABLES,
    sync: getSyncMetaAll(),
  };
}

export async function getStoragePg(): Promise<PgAdapterAsync> {
  const url = getStorageDatabaseUrl();
  if (!url) {
    throw new Error("Missing HASNA_EMAILS_DATABASE_URL or EMAILS_DATABASE_URL");
  }
  const { PgAdapterAsync } = await import("./remote-storage.js");
  return new PgAdapterAsync(url);
}

export async function runStorageMigrations(remote: PgAdapterAsync): Promise<void> {
  const { PG_MIGRATIONS } = await import("./pg-migrations.js");
  await remote.run("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  const [baseMigration, ...remaining] = PG_MIGRATIONS;
  if (baseMigration) await remote.run(baseMigration);
  const appliedRows = await remote.all("SELECT id FROM _migrations");
  const applied = new Set(appliedRows.map((row) => Number((row as { id?: unknown }).id)).filter(Number.isFinite));
  for (const sql of remaining) {
    const id = migrationId(sql);
    if (id !== null && applied.has(id)) continue;
    await remote.run(sql);
    if (id !== null) applied.add(id);
  }
}

function migrationId(sql: string): number | null {
  const match = sql.match(/INSERT\s+INTO\s+_migrations\s*\(\s*id\s*\)\s*VALUES\s*\(\s*(\d+)\s*\)/i);
  return match ? Number(match[1]) : null;
}

export async function storagePush(options?: StorageSyncOptions): Promise<SyncResult[]> {
  const remote = await getStoragePg();
  const db = getDatabase();
  try {
    await runStorageMigrations(remote);
    const results: SyncResult[] = [];
    for (const table of parseStorageTables(options?.tables)) results.push(await pushTable(db, remote, table, { batchSize: options?.batchSize }));
    await reconcileRemoteDerivedState(remote);
    recordSyncMeta(db, "push", results);
    return results;
  } finally {
    await remote.close();
  }
}

export async function storagePull(options?: StorageSyncOptions): Promise<SyncResult[]> {
  const remote = await getStoragePg();
  const db = getDatabase();
  try {
    await runStorageMigrations(remote);
    return await pullTablesFromRemote(remote, db, options);
  } finally {
    await remote.close();
  }
}

let localStorageTransactionCounter = 0;

function beginLocalStorageTransaction(db: Database): string {
  const savepoint = `emails_storage_sync_${++localStorageTransactionCounter}`;
  db.exec(`SAVEPOINT ${quoteIdent(savepoint)}`);
  return savepoint;
}

function releaseLocalStorageTransaction(db: Database, savepoint: string): void {
  db.exec(`RELEASE ${quoteIdent(savepoint)}`);
}

function rollbackLocalStorageTransaction(db: Database, savepoint: string): void {
  try {
    db.exec(`ROLLBACK TO ${quoteIdent(savepoint)}`);
  } finally {
    db.exec(`RELEASE ${quoteIdent(savepoint)}`);
  }
}

export async function pullTablesFromRemote(remote: PgAdapterAsync, db: Database, options?: StorageSyncOptions): Promise<SyncResult[]> {
  const savepoint = beginLocalStorageTransaction(db);
  let finished = false;
  try {
    const results: SyncResult[] = [];
    for (const table of parseStorageTables(options?.tables)) {
      results.push(await pullTable(remote, db, table, { batchSize: options?.batchSize }));
    }
    const failures = results.filter((result) => result.errors.length > 0);
    if (failures.length > 0) {
      rollbackLocalStorageTransaction(db, savepoint);
      finished = true;
      return results;
    }
    reconcileLocalDerivedState(db);
    recordSyncMeta(db, "pull", results);
    releaseLocalStorageTransaction(db, savepoint);
    finished = true;
    return results;
  } finally {
    if (!finished) rollbackLocalStorageTransaction(db, savepoint);
  }
}

function reconcileLocalDerivedState(db: Database): void {
  rebuildInboundLabelState(db);
  reconcileMailboxMessageState(db);
}

async function reconcileRemoteDerivedState(remote: PgAdapterAsync): Promise<void> {
  await remote.run(`
    DELETE FROM inbound_labels label
     WHERE NOT EXISTS (
       SELECT 1
         FROM inbound_emails inbound,
              mailery_jsonb_array_text(inbound.label_ids_json) AS value
        WHERE inbound.id = label.inbound_email_id
          AND trim(value) != ''
          AND left(regexp_replace(lower(trim(value)), '\\s+', '-', 'g'), 64) = label.label
     );

    INSERT INTO inbound_labels (inbound_email_id, label)
    SELECT inbound.id, left(regexp_replace(lower(trim(value)), '\\s+', '-', 'g'), 64)
      FROM inbound_emails inbound,
           mailery_jsonb_array_text(inbound.label_ids_json) AS value
     WHERE inbound.label_ids_json IS NOT NULL
       AND trim(value) != ''
    ON CONFLICT DO NOTHING;

    UPDATE inbound_emails
       SET is_spam = CASE WHEN EXISTS (
             SELECT 1 FROM inbound_labels
              WHERE inbound_email_id = inbound_emails.id
                AND label = 'spam'
           ) THEN 1 ELSE 0 END,
           is_trash = CASE WHEN EXISTS (
             SELECT 1 FROM inbound_labels
              WHERE inbound_email_id = inbound_emails.id
                AND label = 'trash'
           ) THEN 1 ELSE 0 END;

    UPDATE mailbox_message_state state
       SET labels_json = inbound.label_ids_json,
           is_read = inbound.is_read,
           read_at = inbound.read_at,
           is_archived = inbound.is_archived,
           is_starred = inbound.is_starred,
           is_spam = inbound.is_spam,
           is_trash = inbound.is_trash,
           folder_id = 'folder:' || state.mailbox_id || ':' ||
             CASE
               WHEN COALESCE(inbound.is_sent, 0) = 1 THEN 'sent'
               WHEN COALESCE(inbound.is_trash, 0) = 1 THEN 'trash'
               WHEN COALESCE(inbound.is_spam, 0) = 1 THEN 'spam'
               WHEN COALESCE(inbound.is_archived, 0) = 1 THEN 'archive'
               ELSE 'inbox'
             END,
           updated_at = NOW()
      FROM inbound_emails inbound
     WHERE state.mail_message_id = COALESCE(inbound.mail_message_id, 'msg:inbound:' || inbound.id);
  `);
}

export async function storageSync(options?: StorageSyncOptions, hooks: StorageSyncHooks = {}): Promise<{ pull: SyncResult[]; push: SyncResult[] }> {
  if (!options?.force) {
    throw new Error("storage sync runs pull then push and can overwrite local rows with remote values. Re-run with --force after reviewing conflicts, or run storage pull/storage push explicitly.");
  }
  const pull = await (hooks.pull ?? storagePull)(options);
  const failures = pull.filter((result) => result.errors.length > 0);
  if (failures.length > 0) {
    throw new Error(`Storage sync stopped after pull errors; push was not run. ${failures.map((result) => `${result.table}: ${result.errors.join("; ")}`).join(" | ")}`);
  }
  const push = await (hooks.push ?? storagePush)(options);
  return { pull, push };
}

export function getSyncMetaAll(): SyncMeta[] {
  const db = getDatabase();
  ensureSyncMetaTable(db);
  return db.query<SyncMeta, []>("SELECT table_name, last_synced_at, direction FROM _emails_sync_meta ORDER BY table_name, direction").all();
}

export function parseStorageTables(tables?: string[]): StorageTable[] {
  if (!tables || tables.length === 0) return [...STORAGE_TABLES];
  const allowed = new Set<string>(STORAGE_TABLES);
  const requested = tables.map((table) => table.trim()).filter(Boolean);
  const invalid = requested.filter((table) => !allowed.has(table));
  if (invalid.length > 0) throw new Error(`Unknown emails sync table(s): ${invalid.join(", ")}`);
  return requested as StorageTable[];
}

export const resolveTables = parseStorageTables;

export async function pushTable(db: Database, remote: PgAdapterAsync, table: StorageTable, options?: { batchSize?: number }): Promise<SyncResult> {
  const result: SyncResult = { table, rowsRead: 0, rowsWritten: 0, errors: [] };
  try {
    if (!sqliteTableExists(db, table)) return result;
    const remoteColumns = await getRemoteColumns(remote, table);
    const batchSize = normalizeBatchSize(options?.batchSize);
    for (let offset = 0; ; offset += batchSize) {
      const rows = db
        .query<Row, [number, number]>(`SELECT * FROM ${quoteIdent(table)} ORDER BY ${orderByPrimaryKey(table)} LIMIT ? OFFSET ?`)
        .all(batchSize, offset);
      result.rowsRead += rows.length;
      if (rows.length === 0) break;
      const columns = filterRemoteColumns(remoteColumns, Object.keys(rows[0]!));
      result.rowsWritten += await upsertPg(remote, table, columns, rows, remoteColumns);
      if (rows.length < batchSize) break;
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

export async function pullTable(remote: PgAdapterAsync, db: Database, table: StorageTable, options?: { batchSize?: number }): Promise<SyncResult> {
  const result: SyncResult = { table, rowsRead: 0, rowsWritten: 0, errors: [] };
  try {
    if (!sqliteTableExists(db, table)) return result;
    const batchSize = normalizeBatchSize(options?.batchSize);
    for (let offset = 0; ; offset += batchSize) {
      const rows = await remote.all(
        `SELECT * FROM ${quoteIdent(table)} ORDER BY ${orderByPrimaryKey(table)} LIMIT ? OFFSET ?`,
        batchSize,
        offset,
      ) as Row[];
      result.rowsRead += rows.length;
      if (rows.length === 0) break;
      const columns = filterLocalColumns(db, table, Object.keys(rows[0]!));
      result.rowsWritten += upsertSqlite(db, table, columns, rows);
      if (rows.length < batchSize) break;
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined || value === null) return STORAGE_SYNC_BATCH_SIZE;
  return Number.isFinite(value) ? Math.max(1, Math.min(5000, Math.trunc(value))) : STORAGE_SYNC_BATCH_SIZE;
}

function orderByPrimaryKey(table: StorageTable): string {
  return PRIMARY_KEYS[table].map(quoteIdent).join(", ");
}

async function getRemoteColumns(remote: PgAdapterAsync, table: string): Promise<Map<string, string>> {
  const rows = await remote.all(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
    table,
  ) as Array<{ column_name: string; data_type: string }>;
  return new Map(rows.map((row) => [row.column_name, row.data_type]));
}

function filterRemoteColumns(remoteColumns: Map<string, string>, columns: string[]): string[] {
  if (remoteColumns.size === 0) return columns;
  return columns.filter((column) => remoteColumns.has(column));
}

function filterLocalColumns(db: Database, table: string, columns: string[]): string[] {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdent(table)})`).all();
  const allowed = new Set(rows.map((row) => row.name));
  return columns.filter((column) => allowed.has(column));
}

async function upsertPg(remote: PgAdapterAsync, table: StorageTable, columns: string[], rows: Row[], remoteColumns: Map<string, string>): Promise<number> {
  if (columns.length === 0) return 0;
  const primaryKeys = PRIMARY_KEYS[table];
  const columnList = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const keyList = primaryKeys.map(quoteIdent).join(", ");
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const fallbackKey = primaryKeys[0]!;
  const setClause = updateColumns.length > 0
    ? updateColumns.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`).join(", ")
    : `${quoteIdent(fallbackKey)} = EXCLUDED.${quoteIdent(fallbackKey)}`;
  for (const row of rows) {
    await remote.run(
      `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders}) ON CONFLICT (${keyList}) DO UPDATE SET ${setClause}`,
      ...columns.map((column) => coerceForPg(row[column], remoteColumns.get(column))),
    );
  }
  return rows.length;
}

function upsertSqlite(db: Database, table: StorageTable, columns: string[], rows: Row[]): number {
  if (columns.length === 0) return 0;
  const primaryKeys = PRIMARY_KEYS[table];
  const columnList = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const keyList = primaryKeys.map(quoteIdent).join(", ");
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const fallbackKey = primaryKeys[0]!;
  const setClause = updateColumns.length > 0
    ? updateColumns.map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`).join(", ")
    : `${quoteIdent(fallbackKey)} = excluded.${quoteIdent(fallbackKey)}`;
  const statement = db.prepare(`INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders}) ON CONFLICT (${keyList}) DO UPDATE SET ${setClause}`);
  for (const row of rows) statement.run(...columns.map((column) => coerceForSqlite(row[column])));
  return rows.length;
}

function recordSyncMeta(db: Database, direction: "push" | "pull", results: SyncResult[]): void {
  ensureSyncMetaTable(db);
  const timestamp = new Date().toISOString();
  const statement = db.prepare(
    "INSERT INTO _emails_sync_meta (table_name, last_synced_at, direction) VALUES (?, ?, ?) ON CONFLICT(table_name, direction) DO UPDATE SET last_synced_at = excluded.last_synced_at",
  );
  for (const result of results) {
    if (result.errors.length > 0) continue;
    statement.run(result.table, timestamp, direction);
  }
}

function ensureSyncMetaTable(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _emails_sync_meta (table_name TEXT NOT NULL, last_synced_at TEXT, direction TEXT NOT NULL CHECK(direction IN ('push', 'pull')), PRIMARY KEY (table_name, direction))");
}

function sqliteTableExists(db: Database, table: string): boolean {
  return Boolean(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function coerceForPg(value: unknown, dataType?: string): unknown {
  if (value === undefined || value === null) return null;
  if (dataType === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function coerceForSqlite(value: unknown): string | number | bigint | boolean | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
