import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createSendKey, listSendKeySummaries, revokeSendKey, getSendKey, canOwnerSendFrom } from "../../db/send-keys.js";
import { getOwner, getOwnerByName, listAddressesByOwner, listOwnerNamesByIds } from "../../db/owners.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliListPage } from "../utils.js";

export function registerSendKeyCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("sendkey").description("Scoped send keys — restrict an agent to sending from its own addresses");

  cmd
    .command("create <owner>")
    .description("Issue a send key for an owner (agent/human). The token is shown ONCE.")
    .option("--label <label>", "A label to identify this key")
    .action((owner: string, opts: { label?: string }) => {
      try {
        const o = getOwnerByName(owner) ?? getOwner(owner);
        if (!o) return handleError(new Error(`Owner not found: ${owner}`));
        const { token, key } = createSendKey(o.id, opts.label);
        const scope = listAddressesByOwner(o.id, "owner").concat(listAddressesByOwner(o.id, "administrator"));
        const uniq = [...new Set(scope.map((a) => a.email))];
        const text = [
          chalk.green(`✓ Send key issued for ${o.type} '${o.name}'`),
          chalk.bold(`\n  ${token}\n`),
          chalk.yellow("  Store it now — it will not be shown again."),
          chalk.dim(`  Authorized to send from: ${uniq.length ? uniq.join(", ") : "(no addresses yet)"}`),
        ].join("\n");
        output({ id: key.id, token, owner_id: o.id, label: key.label }, text);
      } catch (e) { handleError(e); }
    });

  cmd
    .command("list")
    .description("List send keys (tokens and hashes are never shown)")
    .option("--owner <owner>", "Filter by owner name or id")
    .option("--limit <n>", "Maximum send keys to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of send keys to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { owner?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        let ownerId: string | undefined;
        if (opts.owner) {
          const o = getOwnerByName(opts.owner) ?? getOwner(opts.owner);
          if (!o) return handleError(new Error(`Owner not found: ${opts.owner}`));
          ownerId = o.id;
        }
        const page = parseCliListPage(opts);
        const keys = listSendKeySummaries(ownerId, undefined, page);
        if (keys.length === 0) { output([], chalk.dim("No send keys.")); return; }
        const ownerNames = listOwnerNamesByIds(keys.map((key) => key.owner_id));
        const lines = [chalk.bold("\nSend keys:")];
        for (const k of keys) {
          const status = k.revoked_at ? chalk.red("revoked") : chalk.green("active");
          lines.push(`  ${chalk.cyan(k.id.slice(0, 8))} ${k.prefix}…  ${ownerNames.get(k.owner_id) ?? k.owner_id.slice(0, 8)}  [${status}]${k.label ? `  ${chalk.dim(k.label)}` : ""}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: keys.length,
          limit: page.limit,
          offset: page.offset,
          noun: "send key",
          detailCommand: "filter with --owner <owner>",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(keys, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("revoke <id>")
    .description("Revoke a send key by ID")
    .action((id: string) => {
      try {
        const k = getSendKey(id);
        if (!k) return handleError(new Error(`Send key not found: ${id}`));
        revokeSendKey(id);
        output(k, chalk.green(`✓ Revoked send key ${id.slice(0, 8)}`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("check <owner> <from>")
    .description("Check whether an owner is allowed to send from an address")
    .action((owner: string, from: string) => {
      try {
        const o = getOwnerByName(owner) ?? getOwner(owner);
        if (!o) return handleError(new Error(`Owner not found: ${owner}`));
        const ok = canOwnerSendFrom(o.id, from);
        output({ owner: o.name, from, authorized: ok },
          ok ? chalk.green(`✓ ${o.name} may send from ${from}`) : chalk.red(`✗ ${o.name} may NOT send from ${from}`));
      } catch (e) { handleError(e); }
    });
}
