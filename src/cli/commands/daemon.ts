import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "../../lib/chalk-lite.js";
import { getDataDir, getDatabase } from "../../db/database.js";
import { getProvisioningWorkSummary } from "../../db/provisioning.js";
import { handleError } from "../utils.js";

type LogComponent = "daemon" | "sync" | "inbound" | "scheduler" | "nightly";

const LOG_FILES: Record<LogComponent, string[]> = {
  daemon: ["daemon.log", "provision-daemon.log"],
  sync: ["sync.log", "nightly-sync.log"],
  inbound: ["inbound.log", "watch.log"],
  scheduler: ["scheduler.log"],
  nightly: ["nightly-sync.log"],
};

async function daemonStatus() {
  const db = getDatabase();
  const { getEmailSystemStatus } = await import("../../lib/agent-context.js");
  const now = new Date().toISOString();
  const queue = getProvisioningWorkSummary(now, db);
  const system = getEmailSystemStatus(db);
  return {
    generated_at: now,
    queue: {
      due_domains: queue.due_domains,
      due_addresses: queue.due_addresses,
      failed_domains: queue.failed_domains,
      failed_addresses: queue.failed_addresses,
    },
    realtime: system.inbox.realtime,
    start_commands: {
      provisioner_once: "emails provision daemon --provider <provider> --bucket <bucket> --once",
      provisioner_loop: "emails provision daemon --provider <provider> --bucket <bucket>",
      realtime_watch: "emails inbox watch --all-buckets",
    },
  };
}

function formatDaemonStatus(status: Awaited<ReturnType<typeof daemonStatus>>): string {
  const lines = [chalk.bold("\nDaemon status:")];
  lines.push(`  Due work:   ${status.queue.due_domains} domain(s), ${status.queue.due_addresses} address(es)`);
  lines.push(`  Failed:     ${status.queue.failed_domains} domain(s), ${status.queue.failed_addresses} address(es)`);
  lines.push(`  Realtime:   ${status.realtime.queue_configured ? chalk.green("configured") : chalk.yellow("not configured")}`);
  if (status.realtime.last_poll_at) lines.push(`  Last poll:  ${chalk.green(status.realtime.last_poll_at)}`);
  if (status.realtime.last_error) lines.push(`  Last error: ${chalk.red(status.realtime.last_error)}`);
  lines.push("");
  lines.push(chalk.dim(`  Start provisioner: ${status.start_commands.provisioner_loop}`));
  lines.push(chalk.dim(`  Start realtime:    ${status.start_commands.realtime_watch}`));
  return lines.join("\n");
}

function readTail(component: LogComponent, lines: number): { component: LogComponent; files: Array<{ path: string; exists: boolean; text: string }> } {
  const dir = getDataDir();
  return {
    component,
    files: LOG_FILES[component].map((name) => {
      const path = join(dir, name);
      if (!existsSync(path)) return { path, exists: false, text: "" };
      const text = readFileSync(path, "utf-8").split(/\r?\n/).slice(-Math.max(1, lines)).join("\n");
      return { path, exists: true, text };
    }),
  };
}

export function registerDaemonCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const daemon = program.command("daemon").description("Inspect local email daemon and background worker health");

  daemon
    .command("status")
    .description("Show provisioning/realtime daemon queue status")
    .action(async () => {
      try {
        const status = await daemonStatus();
        output(status, formatDaemonStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  daemon
    .command("restart")
    .description("Show restart guidance for configured email background workers")
    .action(async () => {
      try {
        const status = await daemonStatus();
        const result = {
          managed_process: false,
          reason: "No built-in supervisor or PID file is configured for this package.",
          start_commands: status.start_commands,
          cli_equivalent: "emails daemon status --json",
        };
        output(result, [
          chalk.yellow("No managed email daemon process is configured."),
          chalk.dim(`Start provisioner: ${status.start_commands.provisioner_loop}`),
          chalk.dim(`Start realtime:    ${status.start_commands.realtime_watch}`),
        ].join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  const logs = program.command("logs").description("Inspect local emails logs");
  logs
    .command("tail")
    .description("Tail local emails logs")
    .option("--component <name>", "daemon | sync | inbound | scheduler | nightly", "daemon")
    .option("--lines <n>", "Lines to show from each file", "80")
    .action((opts: { component: string; lines: string }) => {
      try {
        const component = opts.component as LogComponent;
        if (!LOG_FILES[component]) handleError(new Error(`Unknown log component: ${opts.component}`));
        const result = readTail(component, parseInt(opts.lines, 10) || 80);
        const existing = result.files.filter((file) => file.exists);
        const formatted = existing.length
          ? existing.map((file) => `${chalk.bold(file.path)}\n${file.text}`).join("\n\n")
          : chalk.dim(`No local ${component} log files found in ${getDataDir()}.`);
        output(result, formatted);
      } catch (e) {
        handleError(e);
      }
    });
}
