import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { execSync } from "node:child_process";
import { listSandboxEmailSummaries, getSandboxEmail, clearSandboxEmails, getSandboxCount } from "../../db/sandbox.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { confirmDestructiveAction, handleError, parseCliPage, resolveId } from "../utils.js";

export function registerSandboxCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const sandboxCmd = program.command("sandbox").description("Inspect emails captured by sandbox providers");

  sandboxCmd
    .command("list")
    .description("List captured sandbox emails")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .action((opts: { provider?: string; limit?: string; offset?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const page = parseCliPage(opts, 20);
        const emails = listSandboxEmailSummaries(providerId, page.limit, page.offset);
        if (emails.length === 0) {
          output([], chalk.dim("No sandbox emails captured yet."));
          return;
        }
        const lines: string[] = [chalk.bold("\nSandbox Emails:")];
        lines.push(chalk.dim(`${"ID".padEnd(10)}  ${"Date".padEnd(22)}  ${"From".padEnd(30)}  ${"To".padEnd(30)}  Subject`));
        lines.push(chalk.dim("─".repeat(110)));
        for (const e of emails) {
          const date = new Date(e.created_at).toLocaleString();
          const from = e.from_address.length > 30 ? e.from_address.slice(0, 27) + "..." : e.from_address;
          const to = (e.to_addresses[0] ?? "").length > 30 ? (e.to_addresses[0] ?? "").slice(0, 27) + "..." : (e.to_addresses[0] ?? "");
          const subj = e.subject.length > 40 ? e.subject.slice(0, 37) + "..." : e.subject;
          lines.push(`${chalk.cyan(e.id.slice(0, 8))}  ${date.padEnd(22)}  ${from.padEnd(30)}  ${to.padEnd(30)}  ${subj}`);
        }
        lines.push("");
        output(emails, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  sandboxCmd
    .command("show <id>")
    .description("Show full sandbox email details")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "sandbox_emails", id);
        if (!resolvedId) handleError(new Error(`Sandbox email not found: ${id}`));
        const email = getSandboxEmail(resolvedId!, db);
        if (!email) handleError(new Error(`Sandbox email not found: ${id}`));

        console.log(chalk.bold(`\nSandbox Email: ${email!.id}`));
        console.log(`  ${chalk.dim("Subject:")}  ${email!.subject}`);
        console.log(`  ${chalk.dim("From:")}     ${email!.from_address}`);
        console.log(`  ${chalk.dim("To:")}       ${email!.to_addresses.join(", ")}`);
        if (email!.cc_addresses.length > 0) console.log(`  ${chalk.dim("CC:")}       ${email!.cc_addresses.join(", ")}`);
        if (email!.bcc_addresses.length > 0) console.log(`  ${chalk.dim("BCC:")}      ${email!.bcc_addresses.join(", ")}`);
        if (email!.reply_to) console.log(`  ${chalk.dim("Reply-To:")} ${email!.reply_to}`);
        console.log(`  ${chalk.dim("Captured:")} ${email!.created_at}`);
        console.log(`  ${chalk.dim("Provider:")} ${email!.provider_id.slice(0, 8)}`);

        if (email!.text_body) {
          console.log(chalk.bold("\n  Body (text):"));
          console.log(email!.text_body.split("\n").map((l: string) => `    ${l}`).join("\n"));
        } else if (email!.html) {
          console.log(chalk.bold("\n  Body (HTML rendered as text):"));
          const textFromHtml = email!.html
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .trim();
          console.log(textFromHtml.split("\n").map((l: string) => `    ${l}`).join("\n"));
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  sandboxCmd
    .command("open <id>")
    .description("Open HTML content of a sandbox email in the browser")
    .action(async (id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "sandbox_emails", id);
        if (!resolvedId) handleError(new Error(`Sandbox email not found: ${id}`));
        const email = getSandboxEmail(resolvedId!, db);
        if (!email) handleError(new Error(`Sandbox email not found: ${id}`));
        if (!email!.html) handleError(new Error("This sandbox email has no HTML content."));

        const { writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join: pathJoin } = await import("node:path");
        const tmpFile = pathJoin(tmpdir(), `sandbox-${resolvedId!.slice(0, 8)}.html`);
        writeFileSync(tmpFile, email!.html!);
        execSync(`open "${tmpFile}"`);
        console.log(chalk.green(`✓ Opened in browser: ${tmpFile}`));
      } catch (e) {
        handleError(e);
      }
    });

  sandboxCmd
    .command("clear")
    .description("Delete all captured sandbox emails")
    .option("--provider <id>", "Only clear emails for a specific provider")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { provider?: string; yes?: boolean }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const target = providerId ? `for provider ${providerId}` : "for all providers";
        await confirmDestructiveAction(`Clear sandbox emails ${target}?`, opts.yes);
        const db = getDatabase();
        const count = clearSandboxEmails(providerId, db);
        console.log(chalk.green(`✓ Cleared ${count} sandbox email(s)`));
      } catch (e) {
        handleError(e);
      }
    });

  sandboxCmd
    .command("count")
    .description("Show count of captured sandbox emails")
    .option("--provider <id>", "Filter by provider ID")
    .action((opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const db = getDatabase();
        const count = getSandboxCount(providerId, db);
        output({ count }, `${count} sandbox email(s) captured`);
      } catch (e) {
        handleError(e);
      }
    });
}
