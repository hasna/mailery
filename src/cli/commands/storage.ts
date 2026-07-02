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

function formatStorageStatus(info: Awaited<ReturnType<typeof import("../../db/storage-sync.js").getStorageStatus>>): string[] {
  const lines = [
    `Storage configured: ${info.configured ? "yes" : "no"}`,
    `Storage mode: ${info.mode}`,
    `Source of truth: ${info.sourceOfTruth}`,
    `Local cache: ${info.localCache}`,
    `Mailery mode: ${info.maileryMode} (${info.maileryModeLabel})`,
  ];
  if (info.maileryModeWarning) lines.push(chalk.yellow(`Mode note: ${info.maileryModeWarning}`));
  lines.push(`Database env: ${info.env.join(", ")}`);
  lines.push(`Storage mode env: ${info.modeEnv.join(", ")}`);
  lines.push(`Tables: ${info.tables.join(", ")}`);
  if (info.sync.length === 0) lines.push(chalk.dim("Sync: no local sync history"));
  for (const entry of info.sync) {
    lines.push(`  ${entry.table_name} ${entry.direction}: ${entry.last_synced_at ?? "never"}`);
  }
  return lines;
}

function printStorageStatus(info: Awaited<ReturnType<typeof import("../../db/storage-sync.js").getStorageStatus>>): void {
  for (const line of formatStorageStatus(info)) console.log(line);
}

function buildSetupInstructions(info: Awaited<ReturnType<typeof import("../../db/storage-sync.js").getStorageStatus>>): Record<string, unknown> {
  return {
    mode: "self_hosted",
    database: {
      env: info.canonical.env,
      fallbackEnv: info.canonical.fallbackEnv,
      activeEnv: info.activeEnv,
      configured: info.configured,
    },
    runtime: {
      maileryModeEnv: "MAILERY_MODE",
      storageModeEnv: "HASNA_EMAILS_STORAGE_MODE",
      storageMode: "remote",
    },
    commands: [
      `export ${info.canonical.env}='<postgresql-connection-url>'`,
      "export MAILERY_MODE=self_hosted",
      "export HASNA_EMAILS_STORAGE_MODE=remote",
      "mailery self-hosted migrate",
      "mailery self-hosted check --json",
      "mailery self-hosted migrate-local --json",
    ],
    notes: [
      "PostgreSQL is the source of truth in self_hosted mode.",
      "Raw inbound messages and attachments should be configured to use S3.",
      "The CLI never prints database URLs or provider credentials in setup/status/check output.",
    ],
  };
}

function printSetupInstructions(info: Awaited<ReturnType<typeof import("../../db/storage-sync.js").getStorageStatus>>): void {
  const setup = buildSetupInstructions(info) as { commands: string[] };
  console.log("Self-hosted Mailery uses your PostgreSQL connection string as the source of truth.");
  console.log("\nSet the canonical database URL env var:");
  console.log(`  export ${info.canonical.env}='<postgresql-connection-url>'`);
  console.log(`\nFallback env for compatibility: ${info.canonical.fallbackEnv}`);
  console.log("\nSet self-hosted runtime mode:");
  console.log("  export MAILERY_MODE=self_hosted");
  console.log("  export HASNA_EMAILS_STORAGE_MODE=remote");
  console.log("\nOptional local-first sync mode instead of source-of-truth mode:");
  console.log("  export HASNA_EMAILS_STORAGE_MODE=hybrid");
  console.log("\nThen run: mailery self-hosted status");
  console.log(`Check readiness: ${setup.commands.find((command) => command.startsWith("mailery self-hosted check"))}`);
}

function formatReadinessReport(report: Awaited<ReturnType<typeof import("../../lib/self-hosted-runtime.js").checkSelfHostedRuntimeReadiness>>): string[] {
  const lines = [
    `Self-hosted ready: ${report.summary.ready ? "yes" : "no"}`,
    `Runtime enabled: ${report.runtime.enabled ? "yes" : "no"}`,
    `Source of truth: ${report.runtime.sourceOfTruth}`,
    `Local cache: ${report.runtime.localCache}`,
    `Local cache path: ${report.local.cachePath ?? report.local.sourcePath}`,
    `Local mailbox rows: ${report.local.mailRows}${report.local.authoritative ? " (authoritative)" : ""}`,
    `Database configured: ${report.runtime.configured ? "yes" : "no"}`,
    `Inbound S3 buckets: ${report.inbound.buckets.length}`,
    `Attachment storage: ${report.attachments.attachment_storage}`,
    `Active SES providers: ${report.remote.activeSesProviders.length}`,
    `Checked SES domains: ${report.remote.domains.length}`,
    `Remote sync metadata: ${report.remote.sync.length}`,
  ];
  if (report.summary.blockers.length > 0) {
    lines.push(chalk.red(`Blockers: ${report.summary.blockers.join(", ")}`));
  }
  if (report.summary.warnings.length > 0) {
    lines.push(chalk.yellow(`Warnings: ${report.summary.warnings.join(", ")}`));
  }
  for (const entry of report.checks) {
    const marker = entry.ok ? chalk.green("ok") : entry.severity === "warning" ? chalk.yellow("warn") : chalk.red("fail");
    lines.push(`  ${marker} ${entry.name}: ${entry.status}`);
    if (!entry.ok && entry.fix_commands?.length) {
      for (const command of entry.fix_commands) lines.push(chalk.dim(`    fix: ${command}`));
    }
  }
  return lines;
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
        printStorageStatus(info);
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
    .option("--json", "Output as JSON")
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      try {
        if (opts.dryRun) {
          const { PG_MIGRATIONS } = await import("../../db/pg-migrations.js");
          if (wantsJson(opts)) {
            printJson({ status: "dry-run", statements: PG_MIGRATIONS.length });
            return;
          }
          console.log(chalk.dim("-- Dry run: SQL that would be executed --\n"));
          for (const sql of PG_MIGRATIONS) console.log(sql);
          return;
        }
        const { getStoragePg, runStorageMigrations } = await import("../../db/storage-sync.js");
        const pg = await getStoragePg();
        await runStorageMigrations(pg);
        await pg.close();
        if (wantsJson(opts)) {
          printJson({ status: "migrated" });
          return;
        }
        console.log(chalk.green("All migrations applied."));
        output({ status: "migrated" }, "");
      } catch (e) { handleError(e); }
    });

  storageCmd
    .command("migrate-local")
    .alias("migrate-to-self-hosted")
    .description("Migrate local SQLite data into self-hosted PostgreSQL source-of-truth storage")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--batch-size <n>", "Rows to read per table batch")
    .option("--dry-run", "Inspect local migration source without writing to PostgreSQL")
    .option("--allow-empty", "Allow a zero-row local source migration")
    .option("--json", "Output as JSON")
    .action(async (opts: { tables?: string; batchSize?: string; dryRun?: boolean; allowEmpty?: boolean; json?: boolean }) => {
      try {
        const { migrateLocalToSelfHosted } = await import("../../lib/self-hosted-runtime.js");
        const result = await migrateLocalToSelfHosted({
          tables: parseTables(opts.tables),
          batchSize: parseBatchSize(opts.batchSize),
          source: "mailery-storage",
          dryRun: opts.dryRun,
          allowEmpty: opts.allowEmpty,
        });
        if (wantsJson(opts)) {
          printJson(result);
          return;
        }
        if (opts.dryRun) {
          console.log(chalk.green(`Local migration source has ${result.migration?.mailRows ?? 0} mail row(s).`));
          output({ status: "migration-dry-run", result }, "");
          return;
        }
        printResults(result.results, "migrated");
        output({ status: "migrated-local", result }, "");
      } catch (e) { handleError(e); }
    });

  storageCmd
    .command("setup")
    .description("Show self-hosted database configuration instructions")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const { getStorageStatus } = await import("../../db/storage-sync.js");
      const info = getStorageStatus();
      if (wantsJson(opts)) {
        printJson(buildSetupInstructions(info));
        return;
      }
      printSetupInstructions(info);
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

  const selfHostedCmd = program
    .command("self-hosted")
    .aliases(["self_hosted", "selfhosted"])
    .description("Manage self-hosted Mailery runtime, migrations, and source-of-truth status");

  selfHostedCmd
    .command("status")
    .description("Show self-hosted source-of-truth runtime status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const { describeSelfHostedRuntime } = await import("../../lib/self-hosted-runtime.js");
        const info = describeSelfHostedRuntime();
        if (wantsJson(opts)) {
          printJson(info);
          return;
        }
        const storage = info.storage as Awaited<ReturnType<typeof import("../../db/storage-sync.js").getStorageStatus>>;
        printStorageStatus(storage);
      } catch (e) { handleError(e); }
    });

  selfHostedCmd
    .command("setup")
    .description("Show self-hosted runtime configuration instructions")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const { getStorageStatus } = await import("../../db/storage-sync.js");
      const info = getStorageStatus();
      if (wantsJson(opts)) {
        printJson(buildSetupInstructions(info));
        return;
      }
      printSetupInstructions(info);
    });

  selfHostedCmd
    .command("check")
    .alias("doctor")
    .description("Check self-hosted database, S3, SES provider, and domain readiness")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const { checkSelfHostedRuntimeReadiness } = await import("../../lib/self-hosted-runtime.js");
        const report = await checkSelfHostedRuntimeReadiness();
        if (!report.summary.ready) process.exitCode = 1;
        if (wantsJson(opts)) {
          printJson(report);
          return;
        }
        for (const line of formatReadinessReport(report)) console.log(line);
      } catch (e) { handleError(e); }
    });

  selfHostedCmd
    .command("migrate")
    .description("Apply PostgreSQL migrations for self-hosted Mailery")
    .option("--dry-run", "Print SQL without executing")
    .option("--json", "Output as JSON")
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      try {
        if (opts.dryRun) {
          const { PG_MIGRATIONS } = await import("../../db/pg-migrations.js");
          if (wantsJson(opts)) {
            printJson({ status: "dry-run", statements: PG_MIGRATIONS.length });
            return;
          }
          console.log(chalk.dim("-- Dry run: SQL that would be executed --\n"));
          for (const sql of PG_MIGRATIONS) console.log(sql);
          return;
        }
        const { getStoragePg, runStorageMigrations } = await import("../../db/storage-sync.js");
        const pg = await getStoragePg();
        await runStorageMigrations(pg);
        await pg.close();
        if (wantsJson(opts)) {
          printJson({ status: "migrated" });
          return;
        }
        console.log(chalk.green("All migrations applied."));
        output({ status: "migrated" }, "");
      } catch (e) { handleError(e); }
    });

  selfHostedCmd
    .command("migrate-local")
    .alias("migrate-to-self-hosted")
    .description("Migrate local SQLite data into self-hosted PostgreSQL source-of-truth storage")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--batch-size <n>", "Rows to read per table batch")
    .option("--dry-run", "Inspect local migration source without writing to PostgreSQL")
    .option("--allow-empty", "Allow a zero-row local source migration")
    .option("--json", "Output as JSON")
    .action(async (opts: { tables?: string; batchSize?: string; dryRun?: boolean; allowEmpty?: boolean; json?: boolean }) => {
      try {
        const { migrateLocalToSelfHosted } = await import("../../lib/self-hosted-runtime.js");
        const result = await migrateLocalToSelfHosted({
          tables: parseTables(opts.tables),
          batchSize: parseBatchSize(opts.batchSize),
          source: "mailery-self-hosted",
          dryRun: opts.dryRun,
          allowEmpty: opts.allowEmpty,
        });
        if (wantsJson(opts)) {
          printJson(result);
          return;
        }
        if (opts.dryRun) {
          console.log(chalk.green(`Local migration source has ${result.migration?.mailRows ?? 0} mail row(s).`));
          output({ status: "migration-dry-run", result }, "");
          return;
        }
        printResults(result.results, "migrated");
        output({ status: "migrated-local", result }, "");
      } catch (e) { handleError(e); }
    });
}
