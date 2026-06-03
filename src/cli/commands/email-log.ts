/**
 * Email log, search, history, and sync commands.
 * Extracted from send.ts to keep the send command focused.
 *
 * Registers: email (namespace), log, search, show, replies, conversation,
 * test, export, webhook, pull, stats, monitor, analytics
 */
import type { Command } from "commander";
import chalk from "chalk";
import { createEmail, listEmails, getEmail, searchEmails } from "../../db/emails.js";
import { getEmailContent } from "../../db/email-content.js";
import { listProviders, getProvider } from "../../db/providers.js";
import { listAddresses } from "../../db/addresses.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { getDefaultProviderId } from "../../lib/config.js";
import { colorStatus } from "../../lib/format.js";
import { handleError, resolveId } from "../utils.js";
import { listReplies, getReplyCount } from "../../db/inbound.js";

export function registerEmailLogCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ─── EMAIL NAMESPACE ─────────────────────────────────────────────────────────
  // Unified `email` command group — all sent-email operations in one place.
  // The old top-level commands (log, search, show, replies, conversation, test)
  // remain as aliases for backwards compatibility.

  const emailCmd = program.command("email").description("Sent email log, search, and history");

  emailCmd
    .command("list")
    .description("List sent emails")
    .option("--provider <id>", "Filter by provider ID")
    .option("--status <status>", "Filter by status: sent|delivered|bounced|complained|failed")
    .option("--since <date>", "Show emails since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .action((opts: { provider?: string; status?: string; since?: string; limit?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const limit = parseInt(opts.limit ?? "20", 10);
        const emails = listEmails({ provider_id: providerId, status: opts.status as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined, since: opts.since, limit });
        if (emails.length === 0) { output([], chalk.dim("No emails found.")); return; }
        const lines: string[] = [];
        lines.push(chalk.bold(`${"Date".padEnd(20)}  ${"From".padEnd(28)}  ${"To".padEnd(28)}  ${"Subject".padEnd(36)}  Status`));
        lines.push(chalk.dim("─".repeat(120)));
        for (const e of emails) {
          const date = new Date(e.sent_at).toLocaleString();
          const from = e.from_address.length > 28 ? e.from_address.slice(0, 25) + "..." : e.from_address;
          const to = (e.to_addresses[0] ?? "").length > 28 ? (e.to_addresses[0] ?? "").slice(0, 25) + "..." : (e.to_addresses[0] ?? "");
          const subj = e.subject.length > 36 ? e.subject.slice(0, 33) + "..." : e.subject;
          const statusStr = e.status === "delivered" ? chalk.green(e.status) : ["bounced","complained","failed"].includes(e.status) ? chalk.red(e.status) : chalk.blue(e.status);
          lines.push(`${date.padEnd(20)}  ${from.padEnd(28)}  ${to.padEnd(28)}  ${subj.padEnd(36)}  ${statusStr}`);
        }
        lines.push("");
        output(emails, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("search <query>")
    .description("Search sent emails by subject, from, or to")
    .option("--since <date>", "Show emails since date")
    .option("--limit <n>", "Max results", "20")
    .action((query: string, opts: { since?: string; limit?: string }) => {
      try {
        const emails = searchEmails(query, { since: opts.since, limit: parseInt(opts.limit ?? "20", 10) });
        if (emails.length === 0) { output([], chalk.dim(`No emails matching "${query}".`)); return; }
        const lines: string[] = [];
        for (const e of emails) {
          const date = new Date(e.sent_at).toLocaleString();
          const statusStr = e.status === "delivered" ? chalk.green(e.status) : ["bounced","complained","failed"].includes(e.status) ? chalk.red(e.status) : chalk.blue(e.status);
          lines.push(`  ${chalk.dim(e.id.slice(0,8))}  ${date.slice(0,16)}  ${e.from_address.slice(0,25).padEnd(25)}  ${e.subject.slice(0,40).padEnd(40)}  ${statusStr}`);
        }
        output(emails, chalk.bold(`\n${emails.length} result(s) for "${query}":\n`) + lines.join("\n") + "\n");
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("show <id>")
    .description("Show full details and body of a sent email")
    .action((id: string) => {
      // Re-use existing show logic
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "emails", id);
        if (!resolvedId) handleError(new Error(`Email not found: ${id}`));
        const emailRecord = getEmail(resolvedId!, db);
        if (!emailRecord) handleError(new Error(`Email not found: ${id}`));
        const content = getEmailContent(resolvedId!, db);
        console.log(chalk.bold(`\nEmail: ${emailRecord!.id}`));
        console.log(`  ${chalk.dim("Subject:")}  ${emailRecord!.subject}`);
        console.log(`  ${chalk.dim("From:")}     ${emailRecord!.from_address}`);
        console.log(`  ${chalk.dim("To:")}       ${emailRecord!.to_addresses.join(", ")}`);
        console.log(`  ${chalk.dim("Status:")}   ${colorStatus(emailRecord!.status)}`);
        console.log(`  ${chalk.dim("Sent:")}     ${emailRecord!.sent_at}`);
        if (content?.text_body) { console.log(chalk.bold("\n  Body:"), "\n" + content.text_body.slice(0,500)); }
        console.log();
        output(emailRecord, "");
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("replies <id>")
    .description("Show replies received for a sent email")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolveId("emails", id);
        const replies = listReplies(resolvedId, db);
        if (!replies.length) { console.log(chalk.dim("No replies.")); return; }
        console.log(chalk.bold(`\n${replies.length} repl${replies.length === 1 ? "y" : "ies"}:\n`));
        for (const r of replies) {
          console.log(`  ${chalk.dim(r.received_at.slice(0,16))}  ${chalk.cyan(r.from_address)}`);
          if (r.text_body) console.log(`  ${r.text_body.slice(0,100).replace(/\n/g," ")}...`);
          console.log();
        }
        output(replies, "");
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("thread <id>")
    .description("Show the full conversation (sent + received), grouped by thread_id")
    .action(async (id: string) => {
      try {
        const db = getDatabase();
        const { getEmailThreading, getThreadMessages } = await import("../../db/threads.js");
        const { getInboundEmail } = await import("../../db/inbound.js");

        let threadId: string | null = null;
        const sentId = resolveId("emails", id);
        const sent = sentId ? getEmail(sentId, db) : null;
        if (sent) threadId = getEmailThreading(sent.id, db)?.thread_id ?? null;
        if (!threadId) {
          const inb = getInboundEmail(resolveId("inbound_emails", id) ?? id, db);
          if (inb) threadId = inb.thread_id;
        }

        if (threadId) {
          const msgs = getThreadMessages(threadId, db);
          console.log(chalk.bold(`\nThread ${threadId.slice(0, 8)} (${msgs.length} message${msgs.length !== 1 ? "s" : ""})\n`));
          for (const m of msgs) {
            const tag = m.kind === "sent" ? chalk.green("→ sent") : chalk.cyan("← recv");
            console.log(`  ${tag}  ${m.at.slice(0, 16)}  ${chalk.dim(m.from)}`);
            console.log(`         ${m.subject}`);
          }
          console.log();
          output({ thread_id: threadId, messages: msgs }, "");
          return;
        }

        if (!sent) return handleError(new Error(`Email not found: ${id}`));
        const replies = listReplies(sent.id, db);
        console.log(chalk.bold(`\nThread (${1 + replies.length} message${replies.length !== 1 ? "s" : ""})\n`));
        console.log(chalk.bold(`  [Sent] ${sent.sent_at.slice(0, 16)}`));
        console.log(`  ${chalk.cyan(sent.from_address)} → ${sent.to_addresses.join(", ")}`);
        console.log(`  ${chalk.dim("Subject:")} ${sent.subject}  ${colorStatus(sent.status)}`);
        for (const r of replies) {
          console.log(`\n  ${chalk.bold(`[Reply] ${r.received_at.slice(0, 16)}`)}`);
          console.log(`  ${chalk.cyan(r.from_address)}: ${(r.text_body ?? "").slice(0, 150).replace(/\n/g, " ")}`);
        }
        if (!replies.length) console.log(chalk.dim("\n  No replies yet."));
        console.log();
        output({ email: sent, replies }, "");
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("send")
    .description("Send an email (alias of top-level `emails send`)")
    .option("--from <email>", "Sender")
    .option("--to <email...>", "Recipient(s)")
    .option("--subject <subject>", "Subject")
    .option("--body <text>", "Body")
    .option("--provider <id>", "Provider ID")
    .action(() => { console.log(chalk.dim("Use: emails send --from ... --to ... --subject ... --body ...")); });

  // ─── LOG ─────────────────────────────────────────────────────────────────────
  program.command("log").description("Show email send log (alias: emails email list)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--status <status>", "Filter by status: sent|delivered|bounced|complained|failed")
    .option("--since <date>", "Show emails since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .action((opts: { provider?: string; status?: string; since?: string; limit?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const limit = parseInt(opts.limit ?? "20", 10);
        const emails = listEmails({ provider_id: providerId, status: opts.status as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined, since: opts.since, limit });
        if (emails.length === 0) { output([], chalk.dim("No emails found.")); return; }
        const logLines: string[] = [];
        logLines.push(chalk.bold(`${"Date".padEnd(20)}  ${"From".padEnd(30)}  ${"To".padEnd(30)}  ${"Subject".padEnd(40)}  Status`));
        logLines.push(chalk.dim("\u2500".repeat(130)));
        for (const e of emails) {
          const date = new Date(e.sent_at).toLocaleString();
          const from = e.from_address.length > 30 ? e.from_address.slice(0, 27) + "..." : e.from_address;
          const to = (e.to_addresses[0] ?? "").length > 30 ? (e.to_addresses[0] ?? "").slice(0, 27) + "..." : (e.to_addresses[0] ?? "");
          const subj = e.subject.length > 40 ? e.subject.slice(0, 37) + "..." : e.subject;
          let statusStr: string;
          switch (e.status) {
            case "delivered": statusStr = chalk.green(e.status); break;
            case "bounced": case "complained": case "failed": statusStr = chalk.red(e.status); break;
            default: statusStr = chalk.blue(e.status);
          }
          logLines.push(`${date.padEnd(20)}  ${from.padEnd(30)}  ${to.padEnd(30)}  ${subj.padEnd(40)}  ${statusStr}`);
        }
        logLines.push("");
        output(emails, logLines.join("\n"));
      } catch (e) { handleError(e); }
    });

  // ─── SEARCH ─────────────────────────────────────────────────────────────────
  program.command("search <query>").description("Search emails by subject, from, or to")
    .option("--since <date>", "Show emails since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .action((query: string, opts: { since?: string; limit?: string }) => {
      try {
        const limit = parseInt(opts.limit ?? "20", 10);
        const emails = searchEmails(query, { since: opts.since, limit });
        if (emails.length === 0) {
          const formatted = chalk.dim(`No emails matching "${query}".`);
          output([], formatted);
          return;
        }
        const lines: string[] = [];
        lines.push(chalk.bold(`${("Date").padEnd(20)}  ${("From").padEnd(30)}  ${("To").padEnd(30)}  ${("Subject").padEnd(40)}  Status`));
        lines.push(chalk.dim("\u2500".repeat(130)));
        for (const e of emails) {
          const date = new Date(e.sent_at).toLocaleString();
          const from = e.from_address.length > 30 ? e.from_address.slice(0, 27) + "..." : e.from_address;
          const to = (e.to_addresses[0] ?? "").length > 30 ? (e.to_addresses[0] ?? "").slice(0, 27) + "..." : (e.to_addresses[0] ?? "");
          const subj = e.subject.length > 40 ? e.subject.slice(0, 37) + "..." : e.subject;
          let statusStr: string;
          switch (e.status) {
            case "delivered": statusStr = chalk.green(e.status); break;
            case "bounced": case "complained": case "failed": statusStr = chalk.red(e.status); break;
            default: statusStr = chalk.blue(e.status);
          }
          lines.push(`${date.padEnd(20)}  ${from.padEnd(30)}  ${to.padEnd(30)}  ${subj.padEnd(40)}  ${statusStr}`);
        }
        lines.push("");
        output(emails, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  // ─── SHOW EMAIL ──────────────────────────────────────────────────────────────
  program.command("show <id>").description("Show full email details including body content")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "emails", id);
        if (!resolvedId) handleError(new Error(`Email not found: ${id}`));
        const emailRecord = getEmail(resolvedId!, db);
        if (!emailRecord) handleError(new Error(`Email not found: ${id}`));
        const content = getEmailContent(resolvedId!, db);

        console.log(chalk.bold(`\nEmail: ${emailRecord!.id}`));
        console.log(`  ${chalk.dim("Subject:")}  ${emailRecord!.subject}`);
        console.log(`  ${chalk.dim("From:")}     ${emailRecord!.from_address}`);
        console.log(`  ${chalk.dim("To:")}       ${emailRecord!.to_addresses.join(", ")}`);
        if (emailRecord!.cc_addresses.length > 0) console.log(`  ${chalk.dim("CC:")}       ${emailRecord!.cc_addresses.join(", ")}`);
        if (emailRecord!.bcc_addresses.length > 0) console.log(`  ${chalk.dim("BCC:")}      ${emailRecord!.bcc_addresses.join(", ")}`);
        if (emailRecord!.reply_to) console.log(`  ${chalk.dim("Reply-To:")} ${emailRecord!.reply_to}`);
        console.log(`  ${chalk.dim("Status:")}   ${colorStatus(emailRecord!.status)}`);
        console.log(`  ${chalk.dim("Sent:")}     ${emailRecord!.sent_at}`);
        if (emailRecord!.provider_message_id) console.log(`  ${chalk.dim("Msg ID:")}   ${emailRecord!.provider_message_id}`);
        const replyCount = getReplyCount(resolvedId!, db);
        if (replyCount > 0) console.log(`  ${chalk.dim("Replies:")}  ${chalk.cyan(String(replyCount))} (use 'emails replies ${id}' to view)`);

        if (content) {
          const headers = content.headers;
          if (Object.keys(headers).length > 0) {
            console.log(chalk.bold("\n  Headers:"));
            for (const [k, v] of Object.entries(headers)) {
              console.log(`    ${chalk.dim(k + ":")} ${v}`);
            }
          }

          if (content.text_body) {
            console.log(chalk.bold("\n  Body (text):"));
            console.log(content.text_body.split("\n").map((l: string) => `    ${l}`).join("\n"));
          } else if (content.html) {
            console.log(chalk.bold("\n  Body (HTML rendered as text):"));
            const textFromHtml = content.html
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
        } else {
          console.log(chalk.dim("\n  No body content stored for this email."));
        }
        console.log();
      } catch (e) { handleError(e); }
    });

  // ─── REPLIES ─────────────────────────────────────────────────────────────────
  program.command("replies <id>").description("Show replies received for a sent email")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolveId("emails", id);
        const replies = listReplies(resolvedId, db);
        if (!replies.length) {
          console.log(chalk.dim("No replies received for this email."));
          return;
        }
        console.log(chalk.bold(`\n${replies.length} repl${replies.length === 1 ? "y" : "ies"} for email ${id.slice(0, 8)}:\n`));
        for (const r of replies) {
          console.log(`  ${chalk.dim(r.received_at.slice(0, 16))}  ${chalk.cyan(r.from_address)}`);
          console.log(`  ${chalk.dim("Subject:")} ${r.subject}`);
          if (r.text_body) console.log(`  ${chalk.dim("Preview:")} ${r.text_body.slice(0, 100).replace(/\n/g, " ")}...`);
          console.log();
        }
      } catch (e) { handleError(e); }
    });

  // ─── CONVERSATION ─────────────────────────────────────────────────────────────
  program.command("conversation <id>").description("Show full conversation thread for a sent email (email + all replies)")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolveId("emails", id);
        const emailRecord = getEmail(resolvedId, db);
        if (!emailRecord) handleError(new Error(`Email not found: ${id}`));
        const replies = listReplies(resolvedId, db);

        console.log(chalk.bold(`\n📧 Conversation thread (${1 + replies.length} message${replies.length === 1 ? "" : "s"})\n`));

        // Original sent email
        console.log(chalk.bold(`  [Sent] ${emailRecord!.sent_at.slice(0, 16)}`));
        console.log(`  ${chalk.cyan("From:")} ${emailRecord!.from_address} → ${emailRecord!.to_addresses.join(", ")}`);
        console.log(`  ${chalk.dim("Subject:")} ${emailRecord!.subject}`);
        console.log(`  ${chalk.dim("Status:")} ${colorStatus(emailRecord!.status)}`);

        // Replies in chronological order
        for (const r of replies) {
          console.log(`\n  ${chalk.bold(`[Reply] ${r.received_at.slice(0, 16)}`)}`);
          console.log(`  ${chalk.cyan("From:")} ${r.from_address}`);
          console.log(`  ${chalk.dim("Subject:")} ${r.subject}`);
          if (r.text_body) {
            const preview = r.text_body.trim().slice(0, 200).replace(/\n+/g, " ");
            console.log(`  ${chalk.dim("Body:")} ${preview}${r.text_body.length > 200 ? "..." : ""}`);
          }
        }

        if (replies.length === 0) {
          console.log(chalk.dim("\n  No replies received yet."));
        }
        console.log();
      } catch (e) { handleError(e); }
    });

  // ─── TEST ────────────────────────────────────────────────────────────────────
  program.command("test [provider-id]").description("Send a test email")
    .option("--to <email>", "Recipient email address")
    .action(async (providerId?: string, opts?: { to?: string }) => {
      try {
        const db = getDatabase();
        let resolvedProviderId: string;
        if (providerId) { resolvedProviderId = resolveId("providers", providerId); }
        else {
          const defaultId = getDefaultProviderId();
          if (defaultId) {
            const resolved = resolvePartialId(db, "providers", defaultId);
            if (resolved) { resolvedProviderId = resolved; }
            else { handleError(new Error(`Default provider not found: ${defaultId}. Update with 'emails config set default_provider <id>'`)); }
          } else {
            const providers = listProviders(db).filter((p) => p.active);
            if (providers.length === 0) handleError(new Error("No active providers. Add one with 'emails provider add'"));
            resolvedProviderId = providers[0]!.id;
          }
        }
        const provider = getProvider(resolvedProviderId!, db);
        if (!provider) handleError(new Error(`Provider not found: ${resolvedProviderId!}`));
        let toEmail = opts?.to;
        if (!toEmail) {
          const addrs = listAddresses(resolvedProviderId!, db);
          const v = addrs.find((a) => a.verified);
          if (v) { toEmail = v.email; } else if (addrs.length > 0) { toEmail = addrs[0]!.email; }
          else { handleError(new Error("No --to address specified and no addresses found for this provider")); }
        }
        const fromAddrs = listAddresses(resolvedProviderId!, db);
        let fromEmail: string;
        const vf = fromAddrs.find((a) => a.verified);
        if (vf) { fromEmail = vf.email; } else if (fromAddrs.length > 0) { fromEmail = fromAddrs[0]!.email; }
        else { handleError(new Error("No sender addresses configured for this provider. Add one with 'emails address add'")); }
        const ts = new Date().toISOString();
        const subject = `Test from open-emails \u2014 ${ts}`;
        const text = `This is a test email sent via open-emails at ${ts}. Provider: ${provider!.name} (${provider!.type})`;
        const { getAdapter } = await import("../../providers/index.js");
        const adapter = getAdapter(provider!);
        const messageId = await adapter.sendEmail({ from: fromEmail!, to: toEmail!, subject, text });
        createEmail(resolvedProviderId!, { from: fromEmail!, to: toEmail!, subject, text }, messageId, db);
        console.log(chalk.green(`✓ Test email sent to ${toEmail}`));
        if (messageId) console.log(chalk.dim(`  Message ID: ${messageId}`));
        console.log(chalk.dim(`  From: ${fromEmail!}`));
        console.log(chalk.dim(`  Provider: ${provider!.name} (${provider!.type})`));
      } catch (e) { handleError(e); }
    });

  // ─── EXPORT ──────────────────────────────────────────────────────────────────
  program
    .command("export <type>")
    .description("Export emails or events (type: emails | events)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--since <date>", "Filter from date (ISO)")
    .option("--until <date>", "Filter until date (ISO)")
    .option("--format <fmt>", "Output format: json | csv", "json")
    .option("--output <file>", "Write to file instead of stdout")
    .action((type: string, opts: { provider?: string; since?: string; until?: string; format?: string; output?: string }) => {
      try {
        if (type !== "emails" && type !== "events") {
          handleError(new Error("Export type must be 'emails' or 'events'"));
        }

        const { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } = require("../../lib/export.js");
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const fmt = opts.format ?? "json";
        let result: string;

        if (type === "emails") {
          const filters = { provider_id: providerId, since: opts.since, until: opts.until };
          result = fmt === "csv" ? exportEmailsCsv(filters) : exportEmailsJson(filters);
        } else {
          const filters = { provider_id: providerId, since: opts.since };
          result = fmt === "csv" ? exportEventsCsv(filters) : exportEventsJson(filters);
        }

        if (opts.output) {
          const { writeFileSync } = require("node:fs");
          writeFileSync(opts.output, result, "utf-8");
          console.log(chalk.green("✓ Exported " + type + " to " + opts.output));
        } else {
          console.log(result);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ─── WEBHOOK ─────────────────────────────────────────────────────────────────
  const webhookCmd = program.command("webhook").description("Webhook receiver for email events");
  webhookCmd
    .command("listen")
    .description("Start webhook listener server")
    .option("--port <port>", "Port to listen on", "9877")
    .option("--provider <id>", "Provider ID to associate events with")
    .action(async (opts: { port?: string; provider?: string }) => {
      try {
        const { createWebhookServer } = await import("../../lib/webhook.js");
        const port = parseInt(opts.port ?? "9877", 10);
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        createWebhookServer(port, providerId);
        console.log(chalk.bold(`Webhook listener started on port ${port}`));
        console.log(chalk.dim(`  POST /webhook/resend  — Resend webhook events`));
        console.log(chalk.dim(`  POST /webhook/ses     — SES SNS notifications`));
        console.log(chalk.dim(`  Press Ctrl+C to stop.\n`));
      } catch (e) { handleError(e); }
    });
}
