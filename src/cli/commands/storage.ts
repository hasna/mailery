/**
 * `mailery storage` — repo-native sync commands for local SQLite and self-hosted PostgreSQL storage.
 */

import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import type { SyncResult } from "../../db/storage-sync.js";
import { emitJson, handleError } from "../utils.js";

function parseTables(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((table) => table.trim()).filter(Boolean);
}

function parseBatchSize(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(5000, n)) : undefined;
}

function printJson(value: unknown): void {
  emitJson(value);
}

function wantsJson(opts: { json?: boolean }): boolean {
  return opts.json === true || process.env["EMAILS_JSON_OUTPUT"] === "1";
}

function printResults(results: SyncResult[], label: string): void {
  const total = results.reduce((sum, result) => sum + result.rowsWritten, 0);
  const hasErrors = results.some((result) => result.errors.length > 0);
  for (const result of results) {
    const errors = result.errors.length > 0 ? ` (${result.errors.join("; ")})` : "";
    console.log(`  ${result.table}: ${result.rowsWritten}/${result.rowsRead} rows ${label}${errors}`);
  }
  if (hasErrors) {
    console.log(chalk.red(`Failed. ${total} rows ${label} before errors.`));
  } else {
    console.log(chalk.green(`Done. ${total} rows ${label}.`));
  }
}

function assertNoSyncErrors(results: SyncResult[]): void {
  const failures = results.filter((result) => result.errors.length > 0);
  if (failures.length === 0) return;
  throw new Error(`Storage sync failed for ${failures.map((result) => `${result.table}: ${result.errors.join("; ")}`).join(" | ")}`);
}

function assertNoBidirectionalSyncErrors(result: { pull: SyncResult[]; push: SyncResult[] }): void {
  assertNoSyncErrors(result.pull);
  assertNoSyncErrors(result.push);
}

function installStorageSubcommands(storageCmd: Command, output: (data: unknown, formatted: string) => void): void {
  storageCmd
    .command("status")
    .description("Show self-hosted storage sync status for the emails service")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const { getStorageStatus } = await import("../../db/storage-sync.js");
        const info = getStorageStatus();
        if (wantsJson(opts)) {
          printJson(info);
          return;
        }
        console.log(`Storage configured: ${info.configured ? "yes" : "no"}`);
        console.log(`Mode: ${info.mode} (${info.modeLabel})`);
        if (info.modeWarning) console.log(chalk.yellow(`Mode note: ${info.modeWarning}`));
        console.log(`Env: ${info.env.join(", ")}`);
        console.log(`Canonical RDS: ${info.canonical.cluster}/${info.canonical.database}`);
        console.log(`Runtime secret path: ${info.canonical.runtimePath}`);
        console.log(`Tables: ${info.tables.join(", ")}`);
        if (info.sync.length === 0) console.log(chalk.dim("Sync: no local sync history"));
        for (const entry of info.sync) {
          console.log(`  ${entry.table_name} ${entry.direction}: ${entry.last_synced_at ?? "never"}`);
        }
      } catch (e) { handleError(e); }
    });

  storageCmd
    .command("push")
    .description("Push local email data to self-hosted PostgreSQL storage")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--batch-size <n>", "Rows to read per table batch")
    .option("--json", "Output as JSON")
    .action(async (opts: { tables?: string; batchSize?: string; json?: boolean }) => {
      try {
        const { storagePush } = await import("../../db/storage-sync.js");
        const results = await storagePush({ tables: parseTables(opts.tables), batchSize: parseBatchSize(opts.batchSize) });
        assertNoSyncErrors(results);
        if (wantsJson(opts)) {
          printJson(results);
          return;
        }
        printResults(results, "pushed");
        output({ status: "pushed", results }, "");
      } catch (e) { handleError(e); }
    });

  storageCmd
    .command("pull")
    .description("Pull email data from self-hosted PostgreSQL storage to local SQLite")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--batch-size <n>", "Rows to read per table batch")
    .option("--json", "Output as JSON")
    .action(async (opts: { tables?: string; batchSize?: string; json?: boolean }) => {
      try {
        const { storagePull } = await import("../../db/storage-sync.js");
        const results = await storagePull({ tables: parseTables(opts.tables), batchSize: parseBatchSize(opts.batchSize) });
        assertNoSyncErrors(results);
        if (wantsJson(opts)) {
          printJson(results);
          return;
        }
        printResults(results, "pulled");
        output({ status: "pulled", results }, "");
      } catch (e) { handleError(e); }
    });

  storageCmd
    .command("sync")
    .description("Force bidirectional sync: pull then push")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--batch-size <n>", "Rows to read per table batch")
    .option("--force", "Confirm pull-then-push overwrite risk")
    .option("--json", "Output as JSON")
    .action(async (opts: { tables?: string; batchSize?: string; force?: boolean; json?: boolean }) => {
      try {
        const { storageSync } = await import("../../db/storage-sync.js");
        const result = await storageSync({ tables: parseTables(opts.tables), batchSize: parseBatchSize(opts.batchSize), force: opts.force });
        assertNoBidirectionalSyncErrors(result);
        if (wantsJson(opts)) {
          printJson(result);
          return;
        }
        printResults(result.pull, "pulled");
        printResults(result.push, "pushed");
        output({ status: "synced", result }, "");
      } catch (e) { handleError(e); }
    });

  storageCmd
    .command("migrate")
    .description("Apply PostgreSQL migrations for self-hosted emails storage")
    .option("--dry-run", "Print SQL without executing")
    .action(async (opts: { dryRun?: boolean }) => {
      try {
        if (opts.dryRun) {
          const { PG_MIGRATIONS } = await import("../../db/pg-migrations.js");
          console.log(chalk.dim("-- Dry run: SQL that would be executed --\n"));
          for (const sql of PG_MIGRATIONS) console.log(sql);
          return;
        }
        const { getStoragePg, runStorageMigrations } = await import("../../db/storage-sync.js");
        const pg = await getStoragePg();
        await runStorageMigrations(pg);
        await pg.close();
        console.log(chalk.green("All migrations applied."));
        output({ status: "migrated" }, "");
      } catch (e) { handleError(e); }
    });

  storageCmd
    .command("setup")
    .description("Show self-hosted database configuration instructions")
    .action(async () => {
      const { getStorageStatus } = await import("../../db/storage-sync.js");
      const info = getStorageStatus();
      console.log(`Canonical RDS: ${info.canonical.cluster}/${info.canonical.database}`);
      console.log(`Runtime secret path: ${info.canonical.runtimePath}`);
      console.log("\nLoad that secret into the canonical PostgreSQL connection string env var:");
      console.log(`  ${info.canonical.env}`);
      console.log(`\nFallback env for local/self-hosted compatibility: ${info.canonical.fallbackEnv}`);
      console.log(`\nMode: ${info.mode} (${info.modeLabel})`);
      console.log(`Set explicitly with: MAILERY_MODE=self_hosted`);
      console.log("\nThen run: mailery storage status");
    });

  storageCmd
    .command("feedback <message>")
    .description("Save feedback about the emails CLI locally")
    .option("--email <email>", "Your email address")
    .option("--category <cat>", "Category: bug | feature | general", "general")
    .action(async (message: string, opts: { email?: string; category?: string }) => {
      try {
        const { getDatabase } = await import("../../db/database.js");
        const db = getDatabase();
        db.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          [message, opts.email || null, opts.category || "general", "0.6.6"],
        );
        console.log(chalk.green("Feedback saved."));
      } catch (e) { handleError(e); }
    });
}

export function registerStorageCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const storageCmd = program
    .command("storage")
    .description("Sync email data with self-hosted PostgreSQL storage");
  installStorageSubcommands(storageCmd, output);
}
