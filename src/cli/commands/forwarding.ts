import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import {
  createForwardingRule,
  getForwardingRule,
  listForwardingRules,
  removeForwardingRule,
  setForwardingRuleEnabled,
} from "../../db/forwarding.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";

function formatRule(rule: ReturnType<typeof createForwardingRule>): string {
  const state = rule.enabled ? chalk.green("enabled") : chalk.dim("disabled");
  const provider = rule.provider_id ? ` provider=${rule.provider_id.slice(0, 8)}` : "";
  const from = rule.from_address ? ` from=${rule.from_address}` : "";
  return `${chalk.cyan(rule.id.slice(0, 8))} ${state} ${rule.source_address} -> ${rule.target_address} (${rule.mode}${provider}${from})`;
}

export function registerForwardingCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("forwarding").description("Manage automatic app-level inbound forwarding rules");

  cmd
    .command("add <source> <target>")
    .description("Forward inbound mail the app sees from source to target as a quoted copy")
    .option("--provider <id>", "Provider ID to send forwarded copies through")
    .option("--from <email>", "From address for forwarded copies (defaults to source)")
    .option("--disabled", "Create the rule disabled")
    .action((source: string, target: string, opts: { provider?: string; from?: string; disabled?: boolean }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : null;
        const rule = createForwardingRule({
          source_address: source,
          target_address: target,
          provider_id: providerId,
          from_address: opts.from ?? null,
          enabled: !opts.disabled,
        });
        output(rule, [
          chalk.green(`✓ forwarding rule ${rule.source_address} -> ${rule.target_address}`),
          chalk.dim("  App-level forwarding only processes mail already synced into the local inbox."),
          chalk.dim("  Run: mailery forwarding run --provider <provider>"),
        ].join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("list")
    .description("List automatic forwarding rules")
    .option("--source <email>", "Filter by source address")
    .option("--enabled", "Only enabled rules")
    .option("--disabled", "Only disabled rules")
    .option("--limit <n>", "Maximum rules to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of rules to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { source?: string; enabled?: boolean; disabled?: boolean; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const page = parseCliListPage(opts);
        const enabled = opts.enabled ? true : opts.disabled ? false : undefined;
        const rules = listForwardingRules({ source_address: opts.source, enabled, ...page });
        if (rules.length === 0) {
          output([], chalk.dim("No forwarding rules configured."));
          return;
        }
        output(rules, [
          chalk.bold("\nForwarding rules:"),
          ...rules.map(formatRule),
          "",
          formatListHint({
            shown: rules.length,
            limit: page.limit,
            offset: page.offset,
            noun: "rule",
            detailCommand: "filter with --source, --enabled, or --disabled",
            verbose: opts.verbose || isCliVerboseOutput(),
          }),
        ].join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("enable <id>")
    .description("Enable a forwarding rule")
    .action((id: string) => {
      try {
        const rule = setForwardingRuleEnabled(resolveId("forwarding_rules", id), true);
        output(rule, chalk.green(`✓ enabled ${rule.source_address} -> ${rule.target_address}`));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("disable <id>")
    .description("Disable a forwarding rule")
    .action((id: string) => {
      try {
        const rule = setForwardingRuleEnabled(resolveId("forwarding_rules", id), false);
        output(rule, chalk.yellow(`disabled ${rule.source_address} -> ${rule.target_address}`));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("remove <id>")
    .description("Remove a forwarding rule")
    .action((id: string) => {
      try {
        const resolved = resolveId("forwarding_rules", id);
        const rule = getForwardingRule(resolved);
        if (!rule) return handleError(new Error(`Forwarding rule not found: ${id}`));
        removeForwardingRule(resolved);
        output(rule, chalk.green(`✓ removed ${rule.source_address} -> ${rule.target_address}`));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("run")
    .description("Process pending app-level forwarding rules")
    .option("--provider <id>", "Provider ID to send forwarded copies through")
    .option("--from <email>", "Override From address for this run")
    .option("--limit <n>", "Maximum pending messages to process", "100")
    .option("--backfill", "Also forward matching mail received before the rule was created")
    .action(async (opts: { provider?: string; from?: string; limit?: string; backfill?: boolean }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const { processForwardingRules } = await import("../../lib/forwarding.js");
        const result = await processForwardingRules({
          providerId,
          fromAddress: opts.from,
          limit: parseInt(opts.limit ?? "100", 10) || 100,
          backfill: !!opts.backfill,
        });
        output(result, chalk.green(`forwarding: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped (${result.attempted} attempted)`));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("explain <source>")
    .description("Explain forwarding options for a source address")
    .action(async (source: string) => {
      try {
        const domain = source.split("@")[1]?.toLowerCase();
        const { inspectPublicMx, ownerLabel } = await import("../../lib/mx-ownership.js");
        const mx = domain ? await inspectPublicMx(domain) : null;
        const result = {
          source,
          domain: domain ?? null,
          mx,
          app_level_command: `mailery forwarding add ${source.toLowerCase()} <target> --provider <provider>`,
          provider_native_note: mx?.owner === "cloudflare-routing"
            ? "Cloudflare Email Routing can create native forward rules when Cloudflare owns root MX."
            : "Provider-native forwarding must be configured in the mailbox provider that owns root MX.",
        };
        const lines = [chalk.bold(`\nForwarding options for ${source}:`)];
        if (mx) lines.push(`  Root MX: ${ownerLabel(mx.owner)} (${mx.summary})`);
        lines.push(chalk.dim(`  App-level: ${result.app_level_command}`));
        lines.push(chalk.dim("  App-level forwarding only works after this app receives or syncs the source mailbox."));
        lines.push(chalk.dim(`  Native: ${result.provider_native_note}`));
        output(result, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });
}
