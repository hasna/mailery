import type { Command } from "commander";
import chalk from "chalk";
import { createOwner, getOwner, getOwnerByName, listOwners, listAddressesByOwner } from "../../db/owners.js";
import { handleError } from "../utils.js";

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
    .action((opts: { type?: string }) => {
      const owners = listOwners(opts.type as "human" | "agent" | undefined);
      const text = owners.length
        ? owners.map((o) => `  ${o.id.slice(0, 8)}  ${chalk.cyan(o.type)}  ${o.name}${o.contact_email ? ` <${o.contact_email}>` : ""}`).join("\n")
        : "No owners registered.";
      output(owners, text);
    });

  cmd
    .command("addresses <owner>")
    .description("List addresses owned (or administered) by an owner")
    .option("--administered", "Show addresses this owner administers instead of owns")
    .action((owner: string, opts: { administered?: boolean }) => {
      const o = getOwnerByName(owner) ?? getOwner(owner);
      if (!o) return handleError(new Error(`Owner not found: ${owner}`));
      const addrs = listAddressesByOwner(o.id, opts.administered ? "administrator" : "owner");
      const text = addrs.length ? addrs.map((a) => `  ${a.email}`).join("\n") : "(none)";
      output(addrs, `${o.name} ${opts.administered ? "administers" : "owns"}:\n${text}`);
    });
}
