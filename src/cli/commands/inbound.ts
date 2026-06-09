import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { execSync } from "node:child_process";
import { listInboundEmailSummaries, getInboundEmail, clearInboundEmails, getReceivedInboundCount } from "../../db/inbound.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { truncate, formatDate } from "../../lib/format.js";
import { handleError, parseCliPage, resolveId } from "../utils.js";

export function registerInboundCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const inboundCmd = program.command("inbound").description("Receive and inspect inbound emails");

  inboundCmd
    .command("listen")
    .description("Start a local SMTP listener to receive inbound emails")
    .option("--port <port>", "SMTP port to listen on", "2525")
    .option("--provider <id>", "Associate received emails with this provider ID")
    .action(async (opts: { port?: string; provider?: string }) => {
      const { createSmtpServer } = await import("../../lib/inbound.js");
      const port = parseInt(opts.port ?? "2525", 10);
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      console.log(chalk.green(`✓ SMTP listener started on port ${port}`));
      if (providerId) console.log(chalk.dim(`  Provider: ${providerId}`));
      console.log(chalk.dim("  Press Ctrl+C to stop\n"));
      createSmtpServer(port, providerId);
      // Keep process alive
      process.stdin.resume();
    });

  inboundCmd
    .command("list")
    .description("List received inbound emails")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .action((opts: { provider?: string; limit?: string; offset?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const page = parseCliPage(opts, 20);
        const emails = listInboundEmailSummaries({ provider_id: providerId, limit: page.limit, offset: page.offset });
        if (emails.length === 0) {
          output([], chalk.dim("No inbound emails received yet."));
          return;
        }
        const lines: string[] = [chalk.bold("\nInbound Emails:")];
        for (const email of emails) {
          lines.push(
            `  ${chalk.cyan(email.id.slice(0, 8))}  ${chalk.dim(formatDate(email.received_at))}  ${truncate(email.from_address, 30)}  ${truncate(email.subject, 40)}`,
          );
        }
        output(emails, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  inboundCmd
    .command("show <id>")
    .description("Show full inbound email details")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "inbound_emails", id);
        if (!resolvedId) handleError(new Error(`Inbound email not found: ${id}`));
        const email = getInboundEmail(resolvedId!, db);
        if (!email) handleError(new Error(`Inbound email not found: ${id}`));
        const lines: string[] = [
          chalk.bold("\nInbound Email:"),
          `  ${chalk.dim("ID:")}       ${email!.id}`,
          `  ${chalk.dim("From:")}     ${email!.from_address}`,
          `  ${chalk.dim("To:")}       ${email!.to_addresses.join(", ")}`,
          `  ${chalk.dim("CC:")}       ${email!.cc_addresses.join(", ") || "(none)"}`,
          `  ${chalk.dim("Subject:")}  ${email!.subject}`,
          `  ${chalk.dim("Received:")} ${formatDate(email!.received_at)}`,
          `  ${chalk.dim("Size:")}     ${email!.raw_size} bytes`,
          "",
          chalk.bold("  Body (text):"),
          email!.text_body ? email!.text_body.slice(0, 500) : chalk.dim("  (none)"),
        ];
        if (email!.html_body) {
          lines.push("", chalk.bold("  Body (html):"), email!.html_body.slice(0, 200) + "...");
        }
        output(email, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  inboundCmd
    .command("open <id>")
    .description("Open HTML content of an inbound email in the browser")
    .action(async (id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "inbound_emails", id);
        if (!resolvedId) handleError(new Error(`Inbound email not found: ${id}`));
        const email = getInboundEmail(resolvedId!, db);
        if (!email) handleError(new Error(`Inbound email not found: ${id}`));
        if (!email!.html_body) handleError(new Error("This inbound email has no HTML content."));

        const { writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join: pathJoin } = await import("node:path");
        const tmpFile = pathJoin(tmpdir(), `inbound-${resolvedId!.slice(0, 8)}.html`);
        writeFileSync(tmpFile, email!.html_body!);
        execSync(`open "${tmpFile}"`);
        console.log(chalk.green(`✓ Opened in browser: ${tmpFile}`));
      } catch (e) {
        handleError(e);
      }
    });

  inboundCmd
    .command("clear")
    .description("Delete all received inbound emails")
    .option("--provider <id>", "Only clear emails for a specific provider")
    .action((opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const db = getDatabase();
        const count = clearInboundEmails(providerId, db);
        console.log(chalk.green(`✓ Cleared ${count} inbound email(s)`));
      } catch (e) {
        handleError(e);
      }
    });

  inboundCmd
    .command("count")
    .description("Show count of received inbound emails")
    .option("--provider <id>", "Filter by provider ID")
    .action((opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const db = getDatabase();
        const count = getReceivedInboundCount(providerId, db);
        output({ count }, `${count} inbound email(s) received`);
      } catch (e) {
        handleError(e);
      }
    });
}
