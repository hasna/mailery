import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { listContacts, suppressContact, unsuppressContact } from "../../db/contacts.js";
import { handleError, parseCliPage } from "../utils.js";

export function registerContactCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // `contact` is the canonical command; `contacts` kept as alias for backwards compat
  for (const name of ["contact", "contacts"]) {
    const cmd = program.command(name).description("Manage email contacts");

    cmd
      .command("list")
      .description("List contacts")
      .option("--suppressed", "Show only suppressed contacts")
      .option("--limit <n>", "Maximum contacts to show", "50")
      .option("--offset <n>", "Number of contacts to skip", "0")
      .action((opts: { suppressed?: boolean; limit?: string; offset?: string }) => {
        try {
          const page = parseCliPage(opts);
          const contacts = listContacts({
            ...(opts.suppressed !== undefined ? { suppressed: opts.suppressed } : {}),
            ...page,
          });
          if (contacts.length === 0) {
            output([], chalk.dim("No contacts tracked yet."));
            return;
          }
          const lines: string[] = [chalk.bold("\nContacts:")];
          for (const c of contacts) {
            const status = c.suppressed ? chalk.red("suppressed") : chalk.green("active");
            const name = c.name ? ` (${c.name})` : "";
            lines.push(`  ${c.email}${name}  sent:${c.send_count} bounce:${c.bounce_count} complaint:${c.complaint_count}  [${status}]`);
          }
          lines.push("");
          output(contacts, lines.join("\n"));
        } catch (e) { handleError(e); }
      });

    cmd
      .command("suppress <email>")
      .description("Suppress a contact (prevent sending)")
      .action((email: string) => {
        try {
          suppressContact(email);
          console.log(chalk.green(`✓ Suppressed: ${email}`));
        } catch (e) { handleError(e); }
      });

    cmd
      .command("unsuppress <email>")
      .description("Unsuppress a contact (allow sending again)")
      .action((email: string) => {
        try {
          unsuppressContact(email);
          console.log(chalk.green(`✓ Unsuppressed: ${email}`));
        } catch (e) { handleError(e); }
      });
  }
}
