import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { listEmails } from "../../db/emails.js";
import { getLocalStats, formatStatsTable } from "../../lib/stats.js";
import { getAnalytics, formatAnalytics } from "../../lib/analytics.js";
import { colorStatus, truncate } from "../../lib/format.js";
import { getDatabase } from "../../db/database.js";
import { handleError, resolveId, parseDuration, padRight } from "../utils.js";

export function registerSyncCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ─── PROVIDER SYNC ────────────────────────────────────────────────────────────
  // Add `provider sync` as the canonical name for pull
  const providerCmd = program.commands.find(c => c.name() === "provider");
  if (providerCmd) {
    providerCmd
      .command("sync")
      .description("Sync delivery events from all providers")
      .option("--provider <id>", "Specific provider ID")
      .action(async (opts: { provider?: string }) => {
        try {
          const { syncAll, syncProvider } = await import("../../lib/sync.js");
          if (opts.provider) {
            const id = resolveId("providers", opts.provider);
            await syncProvider(id);
            console.log(chalk.green("✓ Provider synced"));
          } else {
            await syncAll();
            console.log(chalk.green("✓ All providers synced"));
          }
        } catch (e) { handleError(e); }
      });
  }

  // ─── PULL ─────────────────────────────────────────────────────────────────────
  program
    .command("pull")
    .description("Sync events from provider(s) (alias: emails provider sync)")
    .option("--provider <id>", "Provider ID (syncs all if not specified)")
    .option("--watch", "Keep syncing on an interval")
    .option("--interval <duration>", "Watch interval (e.g. 30s, 5m, 1h)", "5m")
    .action(async (opts: { provider?: string; watch?: boolean; interval?: string }) => {
      try {
        const { syncAll, syncProvider } = await import("../../lib/sync.js");
        const runSync = async () => {
          if (opts.provider) {
            const providerId = resolveId("providers", opts.provider);
            const count = await syncProvider(providerId);
            return count;
          } else {
            const results = await syncAll();
            let total = 0;
            for (const [id, count] of Object.entries(results)) {
              if (!opts.watch) console.log(`  ${id.slice(0, 8)}: ${count} events`);
              total += count;
            }
            return total;
          }
        };

        if (opts.watch) {
          const interval = parseDuration(opts.interval || "5m");
          console.log(chalk.blue(`Watching for new events every ${opts.interval || "5m"}...`));
          while (true) {
            const total = await runSync();
            console.log(chalk.gray(`[${new Date().toLocaleTimeString()}]`) + ` Synced ${total} events`);
            await new Promise(r => setTimeout(r, interval));
          }
        } else {
          console.log(chalk.dim(opts.provider ? "Syncing events..." : "Syncing all providers..."));
          const total = await runSync();
          console.log(chalk.green(`✓ Synced ${total} events${opts.provider ? "" : " total"}`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ─── STATS ────────────────────────────────────────────────────────────────────
  program
    .command("stats")
    .description("Show email delivery statistics")
    .option("--provider <id>", "Provider ID")
    .option("--period <period>", "Period: 7d, 30d, 90d", "30d")
    .option("--inbox", "Show inbound email stats instead of outbound")
    .action((opts: { provider?: string; period?: string; inbox?: boolean }) => {
      try {
        if (opts.inbox) {
          const db = getDatabase();
          const providerFilter = opts.provider ? resolveId("providers", opts.provider) : undefined;
          const days = parseInt((opts.period ?? "30d").replace("d", ""), 10) || 30;
          const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

          const provCond = providerFilter ? "AND provider_id = ?" : "";
          const params = providerFilter ? [since, providerFilter] : [since];

          const db_ = db;
          const total = (db_.query(`SELECT COUNT(*) as c FROM inbound_emails WHERE received_at >= ? ${provCond}`).get(...params) as { c: number }).c;
          const withAttachments = (db_.query(`SELECT COUNT(*) as c FROM inbound_emails WHERE received_at >= ? AND attachments_json != '[]' ${provCond}`).get(...params) as { c: number }).c;

          const topSenders = db_.query(
            `SELECT from_address, COUNT(*) as cnt FROM inbound_emails WHERE received_at >= ? ${provCond} GROUP BY from_address ORDER BY cnt DESC LIMIT 5`
          ).all(...params) as { from_address: string; cnt: number }[];

          const inboxStats = { period: opts.period ?? "30d", total, with_attachments: withAttachments, top_senders: topSenders };

          const lines = [
            chalk.bold("\nInbound Email Stats:"),
            `  Period:           ${opts.period ?? "30d"}`,
            `  Total received:   ${chalk.green(String(total))}`,
            `  With attachments: ${chalk.cyan(String(withAttachments))}`,
          ];
          if (topSenders.length > 0) {
            lines.push("", chalk.bold("  Top senders:"));
            for (const s of topSenders) {
              lines.push(`    ${String(s.cnt).padStart(4)}  ${s.from_address}`);
            }
          }
          lines.push("");
          output(inboxStats, lines.join("\n"));
          return;
        }

        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const stats = getLocalStats(providerId, opts.period ?? "30d");
        output(stats, chalk.bold("\nEmail Stats:\n") + formatStatsTable(stats));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── MONITOR ──────────────────────────────────────────────────────────────────
  program
    .command("monitor")
    .description("Live monitor with auto-refresh")
    .option("--provider <id>", "Provider ID")
    .option("--interval <seconds>", "Refresh interval in seconds", "30")
    .action(async (opts: { provider?: string; interval?: string }) => {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const intervalSec = parseInt(opts.interval ?? "30", 10);

      const render = () => {
        process.stdout.write("\x1Bc"); // Clear screen
        const now = new Date().toLocaleTimeString();
        console.log(chalk.bold(`Email Monitor  [${now}]  (Ctrl+C to exit)\n`));

        try {
          const stats = getLocalStats(providerId, "7d");
          console.log(chalk.bold("Last 7 days:"));
          console.log(`  ${chalk.cyan("Sent")}:       ${stats.sent}`);
          console.log(`  ${chalk.green("Delivered")}: ${stats.delivered}  (${stats.delivery_rate.toFixed(1)}%)`);
          console.log(`  ${chalk.red("Bounced")}:   ${stats.bounced}  (${stats.bounce_rate.toFixed(1)}%)`);
          console.log(`  ${chalk.yellow("Opened")}:    ${stats.opened}  (${stats.open_rate.toFixed(1)}%)`);
          console.log();

          const emails = listEmails({ provider_id: providerId, limit: 5 });
          if (emails.length > 0) {
            console.log(chalk.bold("Recent emails:"));
            for (const e of emails) {
              const status = colorStatus(e.status);
              console.log(`  ${padRight(status, 12)}  ${truncate(e.subject, 40)}  \u2192 ${e.to_addresses[0] ?? ""}`);
            }
          }
        } catch (err) {
          console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        }
      };

      render();
      const timer = setInterval(render, intervalSec * 1000);

      process.on("SIGINT", () => {
        clearInterval(timer);
        console.log("\n" + chalk.dim("Monitor stopped."));
        process.exit(0);
      });
    });

  // ─── ANALYTICS ────────────────────────────────────────────────────────────────
  program
    .command("analytics")
    .description("Show email analytics (daily volume, top recipients, busiest hours, delivery trend)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--period <period>", "Time period (e.g. 30d, 7d, 90d)", "30d")
    .action((opts: { provider?: string; period: string }) => {
      try {
        let providerId = opts.provider;
        if (providerId) {
          providerId = resolveId("providers", providerId);
        }
        const data = getAnalytics(providerId, opts.period);
        output(data, formatAnalytics(data));
      } catch (e) {
        handleError(e);
      }
    });
}
