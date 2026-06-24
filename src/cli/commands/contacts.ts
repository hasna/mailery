import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { listContacts, suppressContact, unsuppressContact } from "../../db/contacts.js";
import { tableRow, truncate } from "../../lib/format.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliListPage } from "../utils.js";

export function registerContactCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // `contact` is the canonical command; `contacts` kept as alias for backwards compat
  for (const name of ["contact", "contacts"]) {
    const cmd = program.command(name).description("Manage email contacts");

    cmd
      .command("list")
      .description("List contacts")
      .option("--suppressed", "Show only suppressed contacts")
      .option("--limit <n>", "Maximum contacts to show (default 20 compact, 50 verbose/json)")
      .option("--offset <n>", "Number of contacts to skip", "0")
      .option("--verbose", "Show expanded contact rows")
      .action((opts: { suppressed?: boolean; limit?: string; offset?: string; verbose?: boolean }) => {
        try {
          const page = parseCliListPage(opts);
          const contacts = listContacts({
            ...(opts.suppressed !== undefined ? { suppressed: opts.suppressed } : {}),
            ...page,
          });
          if (contacts.length === 0) {
            output([], chalk.dim("No contacts tracked yet."));
            return;
          }
          const verbose = opts.verbose || isCliVerboseOutput();
          const lines: string[] = [chalk.bold("\nContacts:")];
          if (verbose) {
            for (const c of contacts) {
              const status = c.suppressed ? chalk.red("suppressed") : chalk.green("active");
              const name = c.name ? ` (${c.name})` : "";
              lines.push(`  ${c.email}${name}  sent:${c.send_count} bounce:${c.bounce_count} complaint:${c.complaint_count}  [${status}]`);
            }
          } else {
            lines.push(tableRow(
              [chalk.bold("Email"), 36],
              [chalk.bold("Sent"), 6],
              [chalk.bold("Bounce"), 7],
              [chalk.bold("Compl"), 6],
              [chalk.bold("State"), 10],
            ));
            for (const c of contacts) {
              lines.push(tableRow(
                [truncate(c.email, 36), 36],
                [String(c.send_count), 6],
                [String(c.bounce_count), 7],
                [String(c.complaint_count), 6],
                [c.suppressed ? chalk.red("suppressed") : chalk.green("active"), 10],
              ));
            }
          }
          lines.push("");
          lines.push(formatListHint({
            shown: contacts.length,
            limit: page.limit,
            offset: page.offset,
            noun: "contact",
            detailCommand: "filter with --suppressed or adjust --limit/--offset",
            verbose,
          }));
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
