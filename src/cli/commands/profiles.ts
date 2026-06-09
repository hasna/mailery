import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { handleError } from "../utils.js";

/**
 * `emails profiles` — list your configured accounts ("profiles") grouped by the
 * provider (the service: gmail / ses / resend / cloudflare), with the domains
 * and sender addresses registered under each.
 */
export function registerProfilesCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  program
    .command("profiles")
    .alias("accounts")
    .description("List your email profiles (configured accounts) with their domains + addresses")
    .action(async () => {
      try {
        const { listProfiles } = await import("../tui/data.js");
        const profiles = listProfiles();
        if (profiles.length === 0) { output([], chalk.dim("No profiles configured. Add one with 'emails provider add'.")); return; }
        const byProvider = new Map<string, typeof profiles>();
        for (const p of profiles) { const a = byProvider.get(p.provider) ?? []; a.push(p); byProvider.set(p.provider, a); }
        const lines: string[] = [chalk.dim("A profile is a configured account; the provider is the service it uses.\n")];
        for (const [provider, list] of byProvider) {
          lines.push(chalk.magentaBright.bold(provider.toUpperCase()));
          for (const p of list) {
            lines.push(`  ${chalk.cyanBright(p.name)}${p.active ? "" : chalk.dim(" (inactive)")} ${chalk.dim(p.id.slice(0, 8))}`);
            if (p.domains.length) lines.push(`    ${chalk.dim("domains:")}   ${p.domains.join(", ")}`);
            if (p.addresses.length) lines.push(`    ${chalk.dim("addresses:")} ${p.addresses.join(", ")}`);
            if (!p.domains.length && !p.addresses.length) lines.push(chalk.dim("    (no domains/addresses registered)"));
          }
          lines.push("");
        }
        output(profiles, lines.join("\n"));
      } catch (e) { handleError(e); }
    });
}
