import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { listSandboxEmailSummaries, getSandboxEmail, clearSandboxEmails, getSandboxCount } from "../../db/sandbox.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { confirmDestructiveAction, handleError, parseCliPage, resolveId } from "../utils.js";
import { readableMessageText, renderReadableEmailDocument } from "../tui/format.js";
import { openLocalTarget } from "../../lib/local-actions.js";
import { getEmailsMode } from "../../lib/mode.js";

function failIfSelfHostedLocalSandbox(command: string): void {
  if (getEmailsMode() !== "self_hosted") return;
  throw new Error(
    `\`${command}\` is local-mode-only and unavailable in self_hosted API-only mode. ` +
      "Use API-backed `emails inbox ...` commands where applicable, or set EMAILS_MODE=local intentionally to read a local sandbox store.",
  );
}

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
        failIfSelfHostedLocalSandbox("emails sandbox list");
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
        failIfSelfHostedLocalSandbox("emails sandbox show");
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

        const body = readableMessageText(email!.text_body, email!.html);
        if (body) {
          console.log(chalk.bold("\n  Body:"));
          console.log(body.split("\n").map((l: string) => `    ${l}`).join("\n"));
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
        if (getEmailsMode() === "self_hosted") {
          throw new Error("`emails sandbox open` is unavailable in self_hosted mode because it writes a rendered HTML file locally. Use API-backed self_hosted inbox commands or run with EMAILS_MODE=local against an explicit local store.");
        }
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "sandbox_emails", id);
        if (!resolvedId) handleError(new Error(`Sandbox email not found: ${id}`));
        const email = getSandboxEmail(resolvedId!, db);
        if (!email) handleError(new Error(`Sandbox email not found: ${id}`));
        if (!email!.html && !email!.text_body) handleError(new Error("This sandbox email has no body content."));

        const { writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join: pathJoin } = await import("node:path");
        const tmpFile = pathJoin(tmpdir(), `emails-sandbox-${resolvedId!.slice(0, 8)}.html`);
        writeFileSync(tmpFile, renderReadableEmailDocument({
          subject: email!.subject,
          from: email!.from_address,
          to: email!.to_addresses,
          date: email!.created_at,
          text: email!.text_body,
          html: email!.html,
        }), "utf8");
        const opened = openLocalTarget(tmpFile);
        const result = { path: tmpFile, file_url: opened.target?.file_url, opened: opened.ok, method: opened.method, error: opened.error };
        const formatted = opened.ok
          ? chalk.green(`Opened readable sandbox email view: ${tmpFile}`)
          : `${chalk.yellow(`Saved readable sandbox email view: ${tmpFile}`)}\n${chalk.dim(opened.error ?? "Open command unavailable.")}`;
        output(result, formatted);
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
        failIfSelfHostedLocalSandbox("emails sandbox clear");
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
        failIfSelfHostedLocalSandbox("emails sandbox count");
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const db = getDatabase();
        const count = getSandboxCount(providerId, db);
        output({ count }, `${count} sandbox email(s) captured`);
      } catch (e) {
        handleError(e);
      }
    });
}
