import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDatabase, getDatabase, getDatabasePath, resetDatabase } from "../db/database.js";
import { storeInboundEmail } from "../db/inbound.js";
import { createProvider } from "../db/providers.js";
import { loadConfig } from "./config.js";
import {
  SELF_HOSTED_RUNTIME_TABLES,
  SELF_HOSTED_S3_MATERIALIZATION_TABLES,
  checkSelfHostedRuntimeReadiness,
  cleanupOwnedRuntimeCache,
  flushSelfHostedRuntimeCache,
  getSelfHostedRuntimeStatus,
  migrateLocalToSelfHosted,
  prepareSelfHostedRuntimeCache,
} from "./self-hosted-runtime.js";
import type { SyncResult } from "../db/storage-sync.js";

const tempDirs: string[] = [];

const ENV_KEYS = [
  "MAILERY_MODE",
  "HASNA_EMAILS_MODE",
  "HASNA_EMAILS_DATABASE_URL",
  "EMAILS_DATABASE_URL",
  "HASNA_EMAILS_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "MAILERY_SELF_HOSTED_CACHE_PATH",
] as const;

function ok(table = "providers"): SyncResult {
  return { table, rowsRead: 1, rowsWritten: 1, errors: [] };
}

beforeEach(() => {
  cleanupOwnedRuntimeCache();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  closeDatabase();
  cleanupOwnedRuntimeCache();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("self-hosted runtime cache bridge", () => {
  it("orders self-hosted mail tables by foreign-key dependency", () => {
    expect(SELF_HOSTED_RUNTIME_TABLES.indexOf("mail_messages")).toBeLessThan(SELF_HOSTED_RUNTIME_TABLES.indexOf("inbound_emails"));
    expect(SELF_HOSTED_RUNTIME_TABLES.indexOf("inbound_emails")).toBeLessThan(SELF_HOSTED_RUNTIME_TABLES.indexOf("inbound_recipients"));
    expect(SELF_HOSTED_RUNTIME_TABLES.indexOf("inbound_emails")).toBeLessThan(SELF_HOSTED_RUNTIME_TABLES.indexOf("inbound_labels"));
    expect(SELF_HOSTED_S3_MATERIALIZATION_TABLES.indexOf("mail_messages")).toBeLessThan(SELF_HOSTED_S3_MATERIALIZATION_TABLES.indexOf("inbound_emails"));
  });

  it("fails closed when remote source-of-truth mode has no database URL", async () => {
    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";

    expect(getSelfHostedRuntimeStatus()).toMatchObject({
      enabled: true,
      configured: false,
      sourceOfTruth: "postgres",
    });
    await expect(prepareSelfHostedRuntimeCache()).rejects.toThrow("Self-hosted source-of-truth mode requires");
  });

  it("treats explicit MAILERY_MODE=self_hosted without a database URL as misconfigured runtime", async () => {
    process.env["MAILERY_MODE"] = "self_hosted";

    expect(getSelfHostedRuntimeStatus()).toMatchObject({
      enabled: true,
      configured: false,
      maileryMode: "self_hosted",
    });
    await expect(prepareSelfHostedRuntimeCache()).rejects.toThrow("Self-hosted source-of-truth mode requires");
  });

  it("fails readiness when local mailbox rows are still the source of truth", async () => {
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    const db = getDatabase();
    const provider = createProvider({ name: "local-source", type: "sandbox" }, db);
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "authoritative-local-message",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Authoritative local mail",
      text_body: "This row proves local SQLite is still authoritative.",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 64,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);

    const report = await checkSelfHostedRuntimeReadiness();
    const localCheck = report.checks.find((entry) => entry.name === "local_mailbox_source_of_truth");

    expect(report.local).toMatchObject({
      authoritative: true,
      sourcePath: ":memory:",
      sourceExists: true,
    });
    expect(report.local.mailRows).toBeGreaterThan(0);
    expect(report.summary.blockers).toContain("local_mailbox_source_of_truth");
    expect(localCheck).toMatchObject({
      ok: false,
      severity: "critical",
      status: "local_mailbox_rows_are_authoritative",
      fix_commands: expect.arrayContaining(["mailery self-hosted migrate-local --json"]),
    });
  });

  it("returns partial readiness when remote database access and close fail", async () => {
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";

    const report = await checkSelfHostedRuntimeReadiness({
      getPg: async () => ({
        all: async () => {
          throw new Error("remaining connection slots are reserved");
        },
        run: async () => ({ changes: 0 }),
        close: async () => {
          throw new Error("pool close failed");
        },
      } as any),
    });
    const accessCheck = report.checks.find((entry) => entry.name === "database_access");
    const closeCheck = report.checks.find((entry) => entry.name === "database_connection_close");

    expect(report.runtime).toMatchObject({
      configured: true,
      sourceOfTruth: "postgres",
      databaseEnv: "HASNA_EMAILS_DATABASE_URL",
    });
    expect(report.local.authoritative).toBe(false);
    expect(report.remote.reachable).toBe(false);
    expect(report.summary.blockers).toContain("database_access");
    expect(report.summary.warnings).toContain("database_connection_close");
    expect(accessCheck).toMatchObject({
      ok: false,
      severity: "critical",
      status: "unreachable",
    });
    expect(accessCheck?.details?.error).toContain("remaining connection slots");
    expect(closeCheck).toMatchObject({
      ok: false,
      severity: "warning",
      status: "close_failed",
    });
  });

  it("uses an owned temporary cache when no explicit EMAILS_DB_PATH is configured", async () => {
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";

    const pulled: unknown[] = [];
    const prepared = await prepareSelfHostedRuntimeCache(
      { source: "test" },
      { pull: async (options) => { pulled.push(options); return [ok("inbound_emails")]; } },
    );

    const cachePath = process.env["EMAILS_DB_PATH"];
    expect(prepared).toMatchObject({ enabled: true, action: "prepare", source: "test" });
    expect(cachePath).toContain("mailery-self-hosted-cache-");
    expect(getSelfHostedRuntimeStatus()).toMatchObject({
      cachePath,
      cacheOwner: "mailery_runtime",
    });
    expect(pulled[0]).toMatchObject({ replace: true, tables: expect.arrayContaining(["inbound_emails", "mailbox_message_state"]) });

    const flushed = await flushSelfHostedRuntimeCache(
      { source: "test", cleanupCache: true },
      { push: async () => [ok("inbound_emails")] },
    );

    expect(flushed).toMatchObject({ enabled: true, action: "flush", source: "test" });
    expect(process.env["EMAILS_DB_PATH"]).toBeUndefined();
    expect(existsSync(dirname(cachePath!))).toBe(false);
  });

  it("prevents HASNA_EMAILS_DB_PATH from bypassing the owned runtime cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-hasna-db-path-"));
    tempDirs.push(dir);
    const persistentLocalPath = join(dir, "persistent-local.db");
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";
    process.env["HASNA_EMAILS_DB_PATH"] = persistentLocalPath;

    await prepareSelfHostedRuntimeCache(
      { source: "test" },
      { pull: async () => [ok("providers")] },
    );

    const cachePath = process.env["HASNA_EMAILS_DB_PATH"];
    expect(cachePath).toContain("mailery-self-hosted-cache-");
    expect(process.env["EMAILS_DB_PATH"]).toBe(cachePath);
    expect(getDatabasePath()).toBe(cachePath);
    expect(getSelfHostedRuntimeStatus()).toMatchObject({
      cachePath,
      cacheOwner: "mailery_runtime",
    });

    await flushSelfHostedRuntimeCache(
      { source: "test", cleanupCache: true },
      { push: async () => [ok("providers")] },
    );

    expect(process.env["HASNA_EMAILS_DB_PATH"]).toBe(persistentLocalPath);
    expect(process.env["EMAILS_DB_PATH"]).toBeUndefined();
    expect(existsSync(dirname(cachePath!))).toBe(false);
  });

  it("respects an explicit local cache path and does not delete it during cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-explicit-cache-"));
    const cachePath = join(dir, "emails.db");
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";
    process.env["EMAILS_DB_PATH"] = cachePath;

    await prepareSelfHostedRuntimeCache(
      { source: "test" },
      { pull: async () => [ok("providers")] },
    );
    await flushSelfHostedRuntimeCache(
      { source: "test", cleanupCache: true },
      { push: async () => [ok("providers")] },
    );

    expect(process.env["EMAILS_DB_PATH"]).toBe(cachePath);
  });

  it("does not push pulled inbound/mailbox cache tables during generic runtime flush", async () => {
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";
    const pushed: unknown[] = [];

    await flushSelfHostedRuntimeCache(
      { source: "test" },
      { push: async (options) => { pushed.push(options); return [ok("providers")]; } },
    );

    const tables = ((pushed[0] as { tables?: string[] } | undefined)?.tables ?? []);
    expect(tables).toEqual(expect.arrayContaining(["providers", "emails", "contacts", "scheduled_emails", "send_keys"]));
    expect(tables.includes("inbound_emails")).toBe(false);
    expect(tables.includes("mailbox_message_state")).toBe(false);
  });

  it("preserves the owned temporary cache when flush fails", async () => {
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";

    await prepareSelfHostedRuntimeCache(
      { source: "test" },
      { pull: async () => [ok("providers")] },
    );
    const cachePath = process.env["EMAILS_DB_PATH"]!;

    await expect(flushSelfHostedRuntimeCache(
      { source: "test", cleanupCache: true },
      { push: async () => [{ table: "providers", rowsRead: 1, rowsWritten: 0, errors: ["write failed"] }] },
    )).rejects.toThrow("write failed");

    expect(process.env["EMAILS_DB_PATH"]).toBe(cachePath);
    expect(existsSync(dirname(cachePath))).toBe(true);
  });

  it("fails local migration before creating a fresh empty local database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-migrate-empty-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "missing.db");
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";
    process.env["EMAILS_DB_PATH"] = dbPath;
    let pushed = false;

    await expect(migrateLocalToSelfHosted(
      {},
      { push: async () => { pushed = true; return [ok("inbound_emails")]; } },
    )).rejects.toThrow("found no local mail rows");

    expect(pushed).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("migrates a real local mail source and marks config as self-hosted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-migrate-local-"));
    tempDirs.push(dir);
    const previousHome = process.env["HOME"];
    process.env["HOME"] = join(dir, "home");
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    const db = getDatabase();
    const provider = createProvider({ name: "local-source", type: "sandbox" }, db);
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "local-source-message",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Local migration source",
      text_body: "This row should be counted before migration.",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 64,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);

    try {
      const result = await migrateLocalToSelfHosted(
        { source: "test" },
        { push: async () => [ok("inbound_emails"), ok("mail_messages")] },
      );

      expect(result).toMatchObject({
        enabled: true,
        action: "migrate-local",
        source: "test",
      });
      expect(result.migration?.mailRows).toBeGreaterThan(0);
      expect(result.results.map((entry) => entry.table)).toEqual(["inbound_emails", "mail_messages"]);
      expect(loadConfig()).toMatchObject({
        mailery_mode: "self_hosted",
        storage_mode: "remote",
        self_hosted_migrated_mail_rows: result.migration?.mailRows,
      });
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
  });

  it("dry-runs a real local migration without pushing rows or changing mode config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-migrate-dry-run-"));
    tempDirs.push(dir);
    const previousHome = process.env["HOME"];
    process.env["HOME"] = join(dir, "home");
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    const db = getDatabase();
    const provider = createProvider({ name: "local-source", type: "sandbox" }, db);
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "local-source-dry-run-message",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Local dry-run migration source",
      text_body: "This row should be counted but not pushed.",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 64,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);
    let pushed = false;

    try {
      const result = await migrateLocalToSelfHosted(
        { source: "test", dryRun: true },
        { push: async () => { pushed = true; return [ok("inbound_emails")]; } },
      );

      expect(pushed).toBe(false);
      expect(result).toMatchObject({
        enabled: true,
        action: "migrate-local",
        source: "test",
        results: [],
      });
      expect(result.migration?.mailRows).toBeGreaterThan(0);
      expect(loadConfig()).not.toHaveProperty("mailery_mode");
      expect(loadConfig()).not.toHaveProperty("storage_mode");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
  });
});
