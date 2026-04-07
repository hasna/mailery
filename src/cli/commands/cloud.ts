/**
 * `emails cloud` — cloud sync commands for pushing/pulling email data to/from RDS.
 *
 * Wraps @hasna/cloud CLI operations scoped to the emails service.
 * Requires cloud to be configured: cloud setup --host ... --username ...
 */

import type { Command } from "commander";
import chalk from "chalk";
import { spawnSync } from "node:child_process";
import { handleError } from "../utils.js";

function stripCloudWarnings(text: string): string {
  return text.split("\n")
    .filter((l) =>
      l.trim() &&
      !l.includes("Warning") &&
      !l.includes("deprecat") &&
      !l.includes("sslmode") &&
      !l.includes("To prepare for this change:") &&
      !l.includes("See https://www.postgresql.org/docs/current/libpq-ssl.html") &&
      !l.includes("pg-connection-string") &&
      !l.includes("libpq semantics") &&
      !l.includes("weaker security guarantees") &&
      !l.trimStart().startsWith("at ")
    )
    .join("\n");
}

function runCloud(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("cloud", args, {
    encoding: "utf-8",
    env: { ...process.env, NODE_OPTIONS: "--no-warnings" },
  });
  return {
    stdout: stripCloudWarnings(result.stdout ?? ""),
    stderr: stripCloudWarnings(result.stderr ?? ""),
    status: result.status ?? 1,
  };
}

export function registerCloudCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cloudCmd = program
    .command("cloud")
    .description("Sync email data to/from cloud (RDS PostgreSQL). Requires: cloud setup");

  // ─── STATUS ───────────────────────────────────────────────────────────────

  cloudCmd
    .command("status")
    .description("Show cloud sync status for the emails service")
    .action(() => {
      try {
        const r = runCloud(["sync", "status"]);
        if (r.status !== 0) {
          console.error(chalk.red("Cloud sync status failed:"));
          console.error(chalk.dim(r.stderr || r.stdout));
          console.error(chalk.dim("Run: cloud setup --host <rds-host> --username <user>"));
          process.exit(1);
        }
        // Filter to emails service line
        const lines = r.stdout.split("\n");
        const emailLine = lines.find((l) => l.includes("emails"));
        const header = lines.slice(0, 3).join("\n");
        console.log(header);
        if (emailLine) console.log(emailLine);
        else console.log(chalk.dim("emails service not found in sync status"));
      } catch (e) { handleError(e); }
    });

  // ─── PUSH ────────────────────────────────────────────────────────────────

  cloudCmd
    .command("push")
    .description("Push local email data to cloud (RDS)")
    .option("--dry-run", "Show what would be synced without writing")
    .action((opts: { dryRun?: boolean }) => {
      try {
        console.log(chalk.dim("Pushing emails to cloud..."));
        const args = ["sync", "push", "--service", "emails"];
        if (opts.dryRun) args.push("--dry-run");
        const r = runCloud(args);
        const clean = [r.stdout, r.stderr].filter(Boolean).join("\n");
        if (r.status !== 0) {
          console.error(chalk.red("Push failed:"));
          console.error(chalk.dim(clean));
          process.exit(1);
        }
        console.log(clean || chalk.green("✓ Push complete"));
        output({ status: "pushed" }, "");
      } catch (e) { handleError(e); }
    });

  // ─── PULL ────────────────────────────────────────────────────────────────

  cloudCmd
    .command("pull")
    .description("Pull email data from cloud (RDS) to local")
    .action(() => {
      try {
        console.log(chalk.dim("Pulling emails from cloud..."));
        const r = runCloud(["sync", "pull", "--service", "emails"]);
        const clean = [r.stdout, r.stderr].filter(Boolean).join("\n");
        if (r.status !== 0) {
          console.error(chalk.red("Pull failed:"));
          console.error(chalk.dim(clean));
          process.exit(1);
        }
        console.log(clean || chalk.green("✓ Pull complete"));
        output({ status: "pulled" }, "");
      } catch (e) { handleError(e); }
    });

  // ─── MIGRATE ──────────────────────────────────────────────────────────────

  cloudCmd
    .command("migrate")
    .description("Apply PostgreSQL migrations for emails to RDS")
    .action(() => {
      try {
        console.log(chalk.dim("Running emails PG migrations..."));
        const r = runCloud(["migrate-pg", "--service", "emails"]);
        const clean = [r.stdout, r.stderr].filter(Boolean).join("\n");
        if (r.status !== 0) {
          console.error(chalk.red("Migration failed:"));
          console.error(chalk.dim(clean));
          process.exit(1);
        }
        console.log(clean || chalk.green("✓ Migrations applied"));
        output({ status: "migrated" }, "");
      } catch (e) { handleError(e); }
    });

  // ─── SETUP ───────────────────────────────────────────────────────────────

  cloudCmd
    .command("setup")
    .description("Configure RDS connection (delegates to cloud setup)")
    .option("--host <host>", "RDS hostname")
    .option("--username <user>", "RDS username")
    .option("--ssl", "Enable SSL")
    .action((opts: { host?: string; username?: string; ssl?: boolean }) => {
      try {
        const args = ["setup"];
        if (opts.host) { args.push("--host", opts.host); }
        if (opts.username) { args.push("--username", opts.username); }
        if (opts.ssl) args.push("--ssl");
        args.push("--mode", "hybrid", "--migrate");
        const r = runCloud(args);
        const clean = [r.stdout, r.stderr].filter(Boolean).join("\n");
        console.log(clean);
        if (r.status !== 0) process.exit(1);
      } catch (e) { handleError(e); }
    });

  // ─── FEEDBACK ────────────────────────────────────────────────────────────

  cloudCmd
    .command("feedback <message>")
    .description("Send feedback about the emails CLI to the cloud")
    .option("--email <email>", "Your email address")
    .option("--category <cat>", "Category: bug | feature | general", "general")
    .action(async (message: string, opts: { email?: string; category?: string }) => {
      try {
        // Store feedback in local DB
        const { getDatabase } = await import("../../db/database.js");
        const db = getDatabase();
        db.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          [message, opts.email || null, opts.category || "general", "0.5.10"],
        );
        console.log(chalk.green("✓ Feedback saved. Thank you!"));

        // Also push via cloud CLI if configured
        const r = runCloud(["feedback", "--message", message, "--service", "emails"]);
        if (r.status === 0) console.log(chalk.dim("  (also sent to cloud)"));
      } catch (e) { handleError(e); }
    });
}
