import type { StorageSyncOptions, SyncResult } from "../db/storage-sync.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDatabase, databaseFileExists, getDatabase, getDatabasePath, isDatabaseOpen } from "../db/database.js";
import {
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  getStorageMode,
  getStoragePg,
  getStorageStatus,
  storagePull,
  storagePush,
} from "../db/storage-sync.js";
import { getInboundAttachmentStorageConfig, getInboundBuckets, setConfigValue } from "./config.js";
import { resolveMaileryMode } from "./mode.js";

export const SELF_HOSTED_RUNTIME_TABLES = [
  "providers",
  "owners",
  "domains",
  "addresses",
  "emails",
  "email_content",
  "events",
  "inbound_emails",
  "inbound_recipients",
  "inbound_labels",
  "mailboxes",
  "mailbox_sources",
  "mail_folders",
  "mail_messages",
  "mailbox_message_state",
  "templates",
  "contacts",
  "scheduled_emails",
  "groups",
  "group_members",
  "sequences",
  "sequence_steps",
  "sequence_enrollments",
  "aliases",
  "send_keys",
  "forwarding_rules",
  "forwarding_deliveries",
  "address_ownership_events",
  "provisioning_events",
] as const;

export const SELF_HOSTED_RUNTIME_PUSH_TABLES = [
  "providers",
  "owners",
  "domains",
  "addresses",
  "emails",
  "email_content",
  "events",
  "templates",
  "contacts",
  "scheduled_emails",
  "groups",
  "group_members",
  "sequences",
  "sequence_steps",
  "sequence_enrollments",
  "aliases",
  "send_keys",
  "forwarding_rules",
  "forwarding_deliveries",
  "address_ownership_events",
  "provisioning_events",
] as const;

export const SELF_HOSTED_S3_MATERIALIZATION_TABLES = [
  "providers",
  "inbound_emails",
  "inbound_recipients",
  "inbound_labels",
  "mailboxes",
  "mailbox_sources",
  "mail_folders",
  "mail_messages",
  "mailbox_message_state",
] as const;

export interface SelfHostedRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  sourceOfTruth: "postgres" | "local";
  localCache: "runtime_cache" | "explicit_sync_cache" | "local_store";
  storageMode: ReturnType<typeof getStorageMode>;
  maileryMode: ReturnType<typeof resolveMaileryMode>["mode"];
  databaseEnv: string | null;
  cachePath: string | null;
  cacheOwner: "explicit" | "mailery_runtime" | null;
}

export interface SelfHostedRuntimeResult {
  enabled: boolean;
  action: "prepare" | "flush" | "migrate-local";
  source: string;
  results: SyncResult[];
  migration?: LocalMailMigrationSummary;
}

export interface SelfHostedRuntimeOptions extends StorageSyncOptions {
  source?: string;
  cachePath?: string;
  cleanupCache?: boolean;
  allowEmpty?: boolean;
  dryRun?: boolean;
}

export interface LocalMailMigrationTableSummary {
  table: string;
  rows: number;
}

export interface LocalMailMigrationSummary {
  sourcePath: string;
  sourceExists: boolean;
  sourceOpen: boolean;
  mailRows: number;
  tables: LocalMailMigrationTableSummary[];
}

export interface SelfHostedRuntimeHooks {
  pull?: (options?: StorageSyncOptions) => Promise<SyncResult[]>;
  push?: (options?: StorageSyncOptions) => Promise<SyncResult[]>;
}

export interface SelfHostedReadinessCheck {
  name: string;
  ok: boolean;
  severity: "critical" | "warning" | "info";
  status: string;
  details?: Record<string, unknown>;
  fix_commands?: string[];
}

export interface SelfHostedReadinessReport {
  runtime: SelfHostedRuntimeStatus;
  storage: ReturnType<typeof getStorageStatus>;
  inbound: {
    buckets: Array<{ bucket: string; region: string; providerId?: string }>;
  };
  attachments: ReturnType<typeof getInboundAttachmentStorageConfig>;
  remote: {
    reachable: boolean;
    providerCount: number | null;
    activeSesProviders: Array<{ id: string; name: string; region: string | null; active: boolean }>;
    domains: Array<{
      provider_id: string;
      provider_name: string | null;
      domain: string;
      dkim_status: string | null;
      spf_status: string | null;
      dmarc_status: string | null;
    }>;
  };
  checks: SelfHostedReadinessCheck[];
  summary: {
    ready: boolean;
    blockers: string[];
    warnings: string[];
  };
}

let runtimeFlushTimer: ReturnType<typeof setInterval> | null = null;
let ownedRuntimeCacheDir: string | null = null;
let ownedRuntimeCachePath: string | null = null;
let previousEmailsDbPath: string | undefined;
let previousHasnaEmailsDbPath: string | undefined;
let runtimeShutdownHooksInstalled = false;
let runtimeShutdownInProgress = false;

function assertNoSyncErrors(action: string, results: SyncResult[]): void {
  const failures = results.filter((result) => result.errors.length > 0);
  if (failures.length === 0) return;
  throw new Error(`${action} failed for ${failures.map((result) => `${result.table}: ${result.errors.join("; ")}`).join(" | ")}`);
}

function check(
  name: string,
  ok: boolean,
  severity: SelfHostedReadinessCheck["severity"],
  status: string,
  extra: Omit<SelfHostedReadinessCheck, "name" | "ok" | "severity" | "status"> = {},
): SelfHostedReadinessCheck {
  return { name, ok, severity, status, ...extra };
}

function countRows(rows: unknown[]): number | null {
  const first = rows[0] as { count?: unknown } | undefined;
  const count = Number(first?.count ?? 0);
  return Number.isFinite(count) ? count : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LOCAL_MAIL_SOURCE_TABLES = [
  "inbound_emails",
  "emails",
  "email_content",
  "events",
  "mail_messages",
  "mailbox_message_state",
] as const;

function sqliteCountIfTableExists(table: string): number {
  const db = getDatabase();
  const exists = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table) as { ok?: number } | null;
  if (!exists) return 0;
  const row = db.query(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count?: unknown } | null;
  const count = Number(row?.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export function inspectLocalMailMigrationSource(): LocalMailMigrationSummary {
  const sourcePath = getDatabasePath();
  const sourceExists = isDatabaseOpen() || databaseFileExists();
  if (!sourceExists) {
    return {
      sourcePath,
      sourceExists: false,
      sourceOpen: false,
      mailRows: 0,
      tables: LOCAL_MAIL_SOURCE_TABLES.map((table) => ({ table, rows: 0 })),
    };
  }
  const tables = LOCAL_MAIL_SOURCE_TABLES.map((table) => ({ table, rows: sqliteCountIfTableExists(table) }));
  return {
    sourcePath,
    sourceExists: true,
    sourceOpen: isDatabaseOpen(),
    mailRows: tables.reduce((sum, table) => sum + table.rows, 0),
    tables,
  };
}

export function getSelfHostedRuntimeStatus(): SelfHostedRuntimeStatus {
  const storageMode = getStorageMode();
  const maileryMode = resolveMaileryMode().mode;
  const configured = Boolean(getStorageDatabaseUrl());
  const enabled = maileryMode !== "cloud" && (
    storageMode === "remote" ||
    (maileryMode === "self_hosted" && storageMode !== "hybrid")
  );
  const envCachePath = process.env["HASNA_EMAILS_DB_PATH"]?.trim()
    || process.env["EMAILS_DB_PATH"]?.trim()
    || null;
  const cacheOwner = envCachePath && envCachePath === ownedRuntimeCachePath
    ? "mailery_runtime"
    : envCachePath
      ? "explicit"
      : ownedRuntimeCachePath
        ? "mailery_runtime"
        : null;
  return {
    enabled,
    configured,
    sourceOfTruth: enabled ? "postgres" : "local",
    localCache: enabled ? "runtime_cache" : storageMode === "hybrid" ? "explicit_sync_cache" : "local_store",
    storageMode,
    maileryMode,
    databaseEnv: getStorageDatabaseEnvName(),
    cachePath: envCachePath ?? ownedRuntimeCachePath,
    cacheOwner,
  };
}

function assertConfigured(status = getSelfHostedRuntimeStatus()): void {
  if (!status.enabled) return;
  if (status.configured) return;
  throw new Error("Self-hosted source-of-truth mode requires HASNA_EMAILS_DATABASE_URL or EMAILS_DATABASE_URL.");
}

function runtimeTables(options?: SelfHostedRuntimeOptions): StorageSyncOptions {
  return {
    tables: options?.tables ?? [...SELF_HOSTED_RUNTIME_TABLES],
    batchSize: options?.batchSize,
    force: options?.force,
    replace: options?.replace,
    rowFilters: options?.rowFilters,
  };
}

function runtimePushTables(options?: SelfHostedRuntimeOptions): StorageSyncOptions {
  return {
    tables: options?.tables ?? [...SELF_HOSTED_RUNTIME_PUSH_TABLES],
    batchSize: options?.batchSize,
    force: options?.force,
    rowFilters: options?.rowFilters,
  };
}

function setRuntimeDatabasePath(path: string): void {
  process.env["EMAILS_DB_PATH"] = path;
  process.env["HASNA_EMAILS_DB_PATH"] = path;
}

function configureRuntimeCachePath(options: SelfHostedRuntimeOptions = {}): void {
  const configuredPath = options.cachePath?.trim() || process.env["MAILERY_SELF_HOSTED_CACHE_PATH"]?.trim();
  if (configuredPath) {
    mkdirSync(dirname(configuredPath), { recursive: true });
    setRuntimeDatabasePath(configuredPath);
    return;
  }

  if (process.env["EMAILS_DB_PATH"]?.trim() && !process.env["HASNA_EMAILS_DB_PATH"]?.trim()) return;

  const dir = mkdtempSync(join(tmpdir(), "mailery-self-hosted-cache-"));
  previousEmailsDbPath = process.env["EMAILS_DB_PATH"];
  previousHasnaEmailsDbPath = process.env["HASNA_EMAILS_DB_PATH"];
  ownedRuntimeCacheDir = dir;
  ownedRuntimeCachePath = join(dir, "emails.db");
  setRuntimeDatabasePath(ownedRuntimeCachePath);
}

export function cleanupOwnedRuntimeCache(): void {
  if (!ownedRuntimeCacheDir) return;
  try {
    closeDatabase();
  } catch {}

  const dir = ownedRuntimeCacheDir;
  const path = ownedRuntimeCachePath;
  ownedRuntimeCacheDir = null;
  ownedRuntimeCachePath = null;

  if (path && process.env["EMAILS_DB_PATH"] === path) {
    if (previousEmailsDbPath === undefined) delete process.env["EMAILS_DB_PATH"];
    else process.env["EMAILS_DB_PATH"] = previousEmailsDbPath;
  }
  if (path && process.env["HASNA_EMAILS_DB_PATH"] === path) {
    if (previousHasnaEmailsDbPath === undefined) delete process.env["HASNA_EMAILS_DB_PATH"];
    else process.env["HASNA_EMAILS_DB_PATH"] = previousHasnaEmailsDbPath;
  }
  previousEmailsDbPath = undefined;
  previousHasnaEmailsDbPath = undefined;
  rmSync(dir, { recursive: true, force: true });
}

export async function prepareSelfHostedRuntimeCache(
  options: SelfHostedRuntimeOptions = {},
  hooks: SelfHostedRuntimeHooks = {},
): Promise<SelfHostedRuntimeResult> {
  const status = getSelfHostedRuntimeStatus();
  const source = options.source ?? "runtime";
  if (!status.enabled) return { enabled: false, action: "prepare", source, results: [] };
  assertConfigured(status);
  configureRuntimeCachePath(options);
  const results = await (hooks.pull ?? storagePull)(runtimeTables({ ...options, replace: options.replace ?? true }));
  assertNoSyncErrors("Self-hosted runtime cache prepare", results);
  return { enabled: true, action: "prepare", source, results };
}

export async function flushSelfHostedRuntimeCache(
  options: SelfHostedRuntimeOptions = {},
  hooks: SelfHostedRuntimeHooks = {},
): Promise<SelfHostedRuntimeResult> {
  const status = getSelfHostedRuntimeStatus();
  const source = options.source ?? "runtime";
  if (!status.enabled) return { enabled: false, action: "flush", source, results: [] };
  assertConfigured(status);
  const results = await (hooks.push ?? storagePush)(runtimePushTables(options));
  assertNoSyncErrors("Self-hosted runtime cache flush", results);
  if (options.cleanupCache) cleanupOwnedRuntimeCache();
  return { enabled: true, action: "flush", source, results };
}

export async function migrateLocalToSelfHosted(
  options: SelfHostedRuntimeOptions = {},
  hooks: SelfHostedRuntimeHooks = {},
): Promise<SelfHostedRuntimeResult> {
  if (!getStorageDatabaseUrl()) {
    throw new Error("Local-to-self-hosted migration requires HASNA_EMAILS_DATABASE_URL or EMAILS_DATABASE_URL.");
  }
  const migration = inspectLocalMailMigrationSource();
  if (!options.allowEmpty && migration.mailRows === 0) {
    throw new Error("Local-to-self-hosted migration found no local mail rows to migrate. Set EMAILS_DB_PATH or HASNA_EMAILS_DB_PATH to an existing local Mailery database, or skip migrate-local for a fresh self-hosted install.");
  }
  const source = options.source ?? "migration";
  if (options.dryRun) {
    return { enabled: true, action: "migrate-local", source, results: [], migration };
  }
  const results = await (hooks.push ?? storagePush)({
    tables: options.tables,
    batchSize: options.batchSize,
  });
  assertNoSyncErrors("Local-to-self-hosted migration", results);
  setConfigValue("mailery_mode", "self_hosted");
  setConfigValue("storage_mode", "remote");
  setConfigValue("self_hosted_migrated_at", new Date().toISOString());
  setConfigValue("self_hosted_migrated_mail_rows", migration.mailRows);
  return { enabled: true, action: "migrate-local", source, results, migration };
}

export async function startSelfHostedRuntimeCache(options: SelfHostedRuntimeOptions & { flushIntervalMs?: number } = {}): Promise<SelfHostedRuntimeResult> {
  const prepared = await prepareSelfHostedRuntimeCache(options);
  if (!prepared.enabled) return prepared;

  const intervalMs = Math.max(1000, Math.trunc(options.flushIntervalMs ?? 15_000));
  if (!runtimeFlushTimer) {
    runtimeFlushTimer = setInterval(() => {
      void flushSelfHostedRuntimeCache({ ...options, source: options.source ?? "runtime-background" }).catch((error) => {
        process.stderr.write(`[mailery self-hosted] flush failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, intervalMs);
    runtimeFlushTimer.unref?.();
  }
  return prepared;
}

export async function stopSelfHostedRuntimeCache(options: SelfHostedRuntimeOptions = {}): Promise<SelfHostedRuntimeResult> {
  if (runtimeFlushTimer) {
    clearInterval(runtimeFlushTimer);
    runtimeFlushTimer = null;
  }
  return flushSelfHostedRuntimeCache({ ...options, source: options.source ?? "runtime-stop" });
}

export function installSelfHostedRuntimeShutdownHooks(options: SelfHostedRuntimeOptions = {}): void {
  if (runtimeShutdownHooksInstalled) return;
  runtimeShutdownHooksInstalled = true;
  const source = options.source ?? "runtime";
  const stop = async (signal?: NodeJS.Signals) => {
    if (runtimeShutdownInProgress) return;
    runtimeShutdownInProgress = true;
    try {
      await stopSelfHostedRuntimeCache({
        ...options,
        source: `${source}-shutdown`,
        cleanupCache: options.cleanupCache ?? true,
      });
    } catch (error) {
      process.stderr.write(`[mailery self-hosted] shutdown flush failed: ${errorMessage(error)}\n`);
    } finally {
      if (signal) {
        process.exitCode = signal === "SIGINT" ? 130 : 143;
        process.exit();
      }
    }
  };
  process.once("SIGINT", () => { void stop("SIGINT"); });
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
  process.once("beforeExit", () => { void stop(); });
}

export function describeSelfHostedRuntime(): Record<string, unknown> {
  return {
    ...getSelfHostedRuntimeStatus(),
    storage: getStorageStatus(),
  };
}

export async function checkSelfHostedRuntimeReadiness(): Promise<SelfHostedReadinessReport> {
  const runtime = getSelfHostedRuntimeStatus();
  const storage = getStorageStatus();
  const inboundBuckets = getInboundBuckets();
  const attachments = getInboundAttachmentStorageConfig();
  const checks: SelfHostedReadinessCheck[] = [
    check("runtime_mode", runtime.enabled, "critical", runtime.enabled ? "self_hosted_enabled" : "self_hosted_not_enabled", {
      details: {
        maileryMode: runtime.maileryMode,
        storageMode: runtime.storageMode,
        sourceOfTruth: runtime.sourceOfTruth,
        localCache: runtime.localCache,
      },
      fix_commands: runtime.enabled ? [] : [
        "export MAILERY_MODE=self_hosted",
        "export HASNA_EMAILS_STORAGE_MODE=remote",
      ],
    }),
    check("database_url", runtime.configured, "critical", runtime.configured ? "configured" : "missing", {
      details: {
        activeEnv: runtime.databaseEnv,
        acceptedEnv: storage.env,
      },
      fix_commands: runtime.configured ? [] : [
        "export HASNA_EMAILS_DATABASE_URL='<postgresql-connection-url>'",
        "mailery self-hosted setup",
      ],
    }),
    check("inbound_s3", inboundBuckets.length > 0, "critical", inboundBuckets.length > 0 ? "configured" : "missing", {
      details: { bucketCount: inboundBuckets.length },
      fix_commands: inboundBuckets.length > 0 ? [] : [
        "mailery config set inbound_s3_bucket <bucket>",
        "mailery config set inbound_s3_region <region>",
      ],
    }),
    check("attachment_storage", attachments.attachment_storage !== "local", attachments.attachment_storage === "none" ? "warning" : "critical", attachments.attachment_storage, {
      details: {
        storage: attachments.attachment_storage,
        bucketConfigured: Boolean(attachments.s3_bucket),
        region: attachments.s3_region ?? null,
      },
      fix_commands: attachments.attachment_storage !== "local" ? [] : [
        "mailery config set attachment_storage s3",
        "mailery config set attachment_s3_bucket <bucket>",
      ],
    }),
  ];

  const remote: SelfHostedReadinessReport["remote"] = {
    reachable: false,
    providerCount: null,
    activeSesProviders: [],
    domains: [],
  };

  if (runtime.configured) {
    let pg: Awaited<ReturnType<typeof getStoragePg>> | null = null;
    try {
      pg = await getStoragePg();
      await pg.all("SELECT 1 AS ok");
      remote.reachable = true;
      checks.push(check("database_access", true, "critical", "reachable"));

      try {
        remote.providerCount = countRows(await pg.all("SELECT COUNT(*) AS count FROM providers"));
        remote.activeSesProviders = (await pg.all(`
          SELECT id, name, region, active
            FROM providers
           WHERE type = 'ses'
             AND COALESCE(active, true) IS TRUE
           ORDER BY created_at DESC
        `) as Array<{ id?: unknown; name?: unknown; region?: unknown; active?: unknown }>)
          .map((row) => ({
            id: String(row.id ?? ""),
            name: String(row.name ?? ""),
            region: row.region == null ? null : String(row.region),
            active: row.active !== false,
          }))
          .filter((row) => row.id && row.name);
        checks.push(check("database_schema", true, "critical", "mailery_schema_available"));
      } catch (error) {
        checks.push(check("database_schema", false, "critical", "mailery_schema_missing_or_unreadable", {
          details: { error: errorMessage(error) },
          fix_commands: ["mailery self-hosted migrate"],
        }));
      }

      try {
        remote.domains = (await pg.all(`
          SELECT d.provider_id,
                 p.name AS provider_name,
                 d.domain,
                 d.dkim_status,
                 d.spf_status,
                 d.dmarc_status
            FROM domains d
            LEFT JOIN providers p ON p.id = d.provider_id
           WHERE p.type = 'ses'
           ORDER BY d.created_at DESC
           LIMIT 50
        `) as Array<Record<string, unknown>>).map((row) => ({
          provider_id: String(row.provider_id ?? ""),
          provider_name: row.provider_name == null ? null : String(row.provider_name),
          domain: String(row.domain ?? ""),
          dkim_status: row.dkim_status == null ? null : String(row.dkim_status),
          spf_status: row.spf_status == null ? null : String(row.spf_status),
          dmarc_status: row.dmarc_status == null ? null : String(row.dmarc_status),
        })).filter((row) => row.provider_id && row.domain);
      } catch {
        // database_schema already reports the actionable failure.
      }
    } catch (error) {
      checks.push(check("database_access", false, "critical", "unreachable", {
        details: { error: errorMessage(error) },
        fix_commands: [
          "mailery self-hosted setup",
          "mailery self-hosted migrate",
        ],
      }));
    } finally {
      if (pg) await pg.close();
    }
  } else {
    checks.push(check("database_access", false, "critical", "skipped_missing_database_url", {
      fix_commands: ["export HASNA_EMAILS_DATABASE_URL='<postgresql-connection-url>'"],
    }));
  }

  const hasSesProvider = remote.activeSesProviders.length > 0;
  checks.push(check("ses_provider", hasSesProvider, "critical", hasSesProvider ? "active_ses_provider_configured" : "missing_active_ses_provider", {
    details: { activeSesProviders: remote.activeSesProviders.map((provider) => ({ id: provider.id, name: provider.name, region: provider.region })) },
    fix_commands: hasSesProvider ? [] : [
      "mailery provider add --type ses --name aws-ses --region <region>",
    ],
  }));

  const sendReadyDomains = remote.domains.filter((domain) => domain.dkim_status === "verified" && domain.spf_status === "verified");
  checks.push(check("ses_domain_readiness", sendReadyDomains.length > 0, "critical", sendReadyDomains.length > 0 ? "send_ready_domain_found" : "no_send_ready_domain", {
    details: {
      checkedDomains: remote.domains.length,
      sendReadyDomains: sendReadyDomains.map((domain) => ({ domain: domain.domain, provider: domain.provider_name ?? domain.provider_id })),
    },
    fix_commands: sendReadyDomains.length > 0 ? [] : [
      "mailery domain dns <domain>",
      "mailery domain verify <domain>",
      "mailery provision domain <domain> --provider <provider>",
    ],
  }));

  const blockers = checks.filter((entry) => entry.severity === "critical" && !entry.ok).map((entry) => entry.name);
  const warnings = checks.filter((entry) => entry.severity === "warning" && !entry.ok).map((entry) => entry.name);
  return {
    runtime,
    storage,
    inbound: { buckets: inboundBuckets },
    attachments,
    remote,
    checks,
    summary: {
      ready: blockers.length === 0,
      blockers,
      warnings,
    },
  };
}
