import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createOwner, getOwner, getOwnerByName, listOwners, listAddressesByOwner } from "../../db/owners.js";
import { enrichAddresses } from "../../lib/address-ownership.js";
import { handleError, parseCliPage } from "../utils.js";

export function registerOwnerCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("owner").description("Manage address owners (human or agent)");

  cmd
    .command("register <name>")
    .description("Register an owner — a human or an agent")
    .requiredOption("--type <type>", "human | agent")
    .option("--email <email>", "Contact email (humans)")
    .option("--external-id <id>", "External user/agent id")
    .action((name: string, opts: { type: string; email?: string; externalId?: string }) => {
      try {
        const o = createOwner({ type: opts.type as "human" | "agent", name, contact_email: opts.email, external_id: opts.externalId });
        output(o, chalk.green(`✓ ${o.type} owner '${o.name}' registered (${o.id})`));
      } catch (e) { handleError(e); }
    });

  cmd
    .command("list")
    .description("List owners")
    .option("--type <type>", "Filter: human | agent")
    .option("--limit <n>", "Maximum owners to show", "50")
    .option("--offset <n>", "Number of owners to skip", "0")
    .action((opts: { type?: string; limit?: string; offset?: string }) => {
      const owners = listOwners(opts.type as "human" | "agent" | undefined, undefined, parseCliPage(opts));
      const text = owners.length
        ? owners.map((o) => `  ${o.id.slice(0, 8)}  ${chalk.cyan(o.type)}  ${o.name}${o.contact_email ? ` <${o.contact_email}>` : ""}`).join("\n")
        : "No owners registered.";
      output(owners, text);
    });

  cmd
    .command("addresses <owner>")
    .description("List addresses owned (or administered) by an owner")
    .option("--administered", "Show addresses this owner administers instead of owns")
    .option("--limit <n>", "Maximum addresses to show", "50")
    .option("--offset <n>", "Number of addresses to skip", "0")
    .action((owner: string, opts: { administered?: boolean; limit?: string; offset?: string }) => {
      const o = getOwnerByName(owner) ?? getOwner(owner);
      if (!o) return handleError(new Error(`Owner not found: ${owner}`));
      const role = opts.administered ? "administrator" : "owner";
      const addrs = enrichAddresses(listAddressesByOwner(o.id, role, undefined, parseCliPage(opts)));
      const text = addrs.length
        ? addrs.map((a) => {
          const ownerText = a.owner ? `owner=${a.owner.name}(${a.owner.type})` : "owner=none";
          const adminText = a.administrator ? `admin=${a.administrator.name}` : "admin=none";
          return `  ${a.email}  ${chalk.dim(a.provider_name ?? a.provider_id.slice(0, 8))}  ${chalk.dim(a.status)}  ${chalk.dim(ownerText)}  ${chalk.dim(adminText)}`;
        }).join("\n")
        : "(none)";
      output(addrs, `${o.name} ${role === "administrator" ? "administers" : "owns"}:\n${text}`);
    });
}
