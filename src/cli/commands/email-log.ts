/**
 * Email log, search, history, and sync commands.
 * Extracted from send.ts to keep the send command focused.
 *
 * Registers: email (namespace), log, search, show, replies, conversation,
 * test, export, webhook, pull, stats, monitor, analytics
 */
import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { listEmails, getEmail, searchEmails } from "../../db/emails.js";
import { getEmailContent } from "../../db/email-content.js";
import { getLatestActiveProviderId, getProvider } from "../../db/providers.js";
import { getPreferredActiveAddressEmail } from "../../db/addresses.js";
import { getDatabase, resolvePartialId, resolvePartialIdOrThrow } from "../../db/database.js";
import { getDefaultProviderId } from "../../lib/config.js";
import { colorStatus } from "../../lib/format.js";
import { createSentEmailLedger } from "../../lib/sent-ledger.js";
import { handleError, parseCliPositiveIntOption, parseCliNonNegativeIntOption, resolveId } from "../utils.js";
import { listReplies, listReplySummaries, getReplyCount } from "../../db/inbound.js";
import type { InboundEmail, InboundEmailSummary } from "../../db/inbound.js";
import { readableMessageText } from "../tui/format.js";

const MAX_EMAIL_EXPORT_LIMIT = 10000;
const DEFAULT_REPLY_LIMIT = 20;
const MAX_REPLY_LIMIT = 200;

interface ReplyPageOpts {
  limit?: string;
  offset?: string;
}

function parseReplyPage(opts: ReplyPageOpts): { limit: number; offset: number } {
  return {
    limit: parseCliPositiveIntOption(opts.limit, DEFAULT_REPLY_LIMIT, MAX_REPLY_LIMIT),
    offset: parseCliNonNegativeIntOption(opts.offset),
  };
}

function replyPagePayload<T extends InboundEmail | InboundEmailSummary>(
  replies: T[],
  total: number,
  limit: number,
  offset: number,
): { replies: T[]; total: number; limit: number; offset: number; has_more: boolean } {
  return {
    replies,
    total,
    limit,
    offset,
    has_more: offset + replies.length < total,
  };
}

function formatReplySummaries(replies: InboundEmailSummary[], total: number, limit: number, offset: number, label: string): string {
  if (!replies.length) return chalk.dim(`No replies${total > 0 ? " in this page" : ""}.`);
  const lines: string[] = [];
  lines.push(chalk.bold(`\n${replies.length} of ${total} repl${total === 1 ? "y" : "ies"}${label ? ` for ${label}` : ""}`));
  if (offset > 0 || offset + replies.length < total) {
    lines.push(chalk.dim(`Showing offset ${offset}, limit ${limit}${offset + replies.length < total ? " (more available)" : ""}.`));
  }
  lines.push("");
  for (const r of replies) {
    lines.push(`  ${chalk.dim(r.received_at.slice(0, 16))}  ${chalk.cyan(r.from_address)}`);
    lines.push(`  ${chalk.dim("Subject:")} ${r.subject || "(no subject)"}`);
    lines.push("");
  }
  return lines.join("\n");
}

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
    .option("--from <email>", "Filter by sender address")
    .option("--since <date>", "Show emails since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .action((opts: { provider?: string; status?: string; from?: string; since?: string; limit?: string; offset?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const limit = parseCliPositiveIntOption(opts.limit, 20);
        const offset = parseCliNonNegativeIntOption(opts.offset);
        const emails = listEmails({ provider_id: providerId, status: opts.status as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined, from_address: opts.from, since: opts.since, limit, offset });
        if (emails.length === 0) { output([], chalk.dim("No sent emails found.")); return; }
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
    .description("Search sent email by subject, from, or to")
    .option("--since <date>", "Show emails since date")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N results", "0")
    .action((query: string, opts: { since?: string; limit?: string; offset?: string }) => {
      try {
        const emails = searchEmails(query, {
          since: opts.since,
          limit: parseCliPositiveIntOption(opts.limit, 20),
          offset: parseCliNonNegativeIntOption(opts.offset),
        });
        if (emails.length === 0) { output([], chalk.dim(`No sent emails matching "${query}".`)); return; }
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
        if (content?.text_body || content?.html) {
          console.log(chalk.bold("\n  Body:"));
          console.log(readableMessageText(content.text_body, content.html));
        }
        console.log();
        output(emailRecord, "");
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("replies <id>")
    .description("Show replies received for a sent email")
    .option("--limit <n>", "Max replies", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N replies", "0")
    .action((id: string, opts: ReplyPageOpts) => {
      try {
        const db = getDatabase();
        const resolvedId = resolveId("emails", id);
        const { limit, offset } = parseReplyPage(opts);
        const total = getReplyCount(resolvedId, db);
        const replies = listReplySummaries(resolvedId, db, { limit, offset });
        output(
          replyPagePayload(replies, total, limit, offset),
          formatReplySummaries(replies, total, limit, offset, ""),
        );
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("thread <id>")
    .description("Show the full conversation (sent + received), grouped by thread_id")
    .option("--limit <n>", "Max reply bodies for fallback conversations", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N fallback replies", "0")
    .action(async (id: string, opts: ReplyPageOpts) => {
      try {
        const db = getDatabase();
        const { getEmailThreading, getThreadMessages } = await import("../../db/threads.js");
        const { getInboundEmail } = await import("../../db/inbound.js");
        const { limit, offset } = parseReplyPage(opts);

        let threadId: string | null = null;
        const sentId = resolvePartialId(db, "emails", id);
        const sent = sentId ? getEmail(sentId, db) : null;
        if (sent) threadId = getEmailThreading(sent.id, db)?.thread_id ?? null;
        if (!threadId) {
          const inboundId = resolvePartialId(db, "inbound_emails", id);
          const inb = inboundId ? getInboundEmail(inboundId, db) : null;
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
        const total = getReplyCount(sent.id, db);
        const replies = listReplies(sent.id, db, { limit, offset });
        const messageCount = 1 + total;
        console.log(chalk.bold(`\nThread (${messageCount} message${messageCount !== 1 ? "s" : ""})\n`));
        if (offset > 0 || offset + replies.length < total) {
          console.log(chalk.dim(`  Showing ${replies.length} of ${total} replies (offset ${offset}, limit ${limit}).\n`));
        }
        console.log(chalk.bold(`  [Sent] ${sent.sent_at.slice(0, 16)}`));
        console.log(`  ${chalk.cyan(sent.from_address)} → ${sent.to_addresses.join(", ")}`);
        console.log(`  ${chalk.dim("Subject:")} ${sent.subject}  ${colorStatus(sent.status)}`);
        for (const r of replies) {
          console.log(`\n  ${chalk.bold(`[Reply] ${r.received_at.slice(0, 16)}`)}`);
          console.log(`  ${chalk.cyan(r.from_address)}: ${(r.text_body ?? "").slice(0, 150).replace(/\n/g, " ")}`);
        }
        if (!replies.length) console.log(chalk.dim("\n  No replies yet."));
        console.log();
        output({ email: sent, ...replyPagePayload(replies, total, limit, offset) }, "");
      } catch (e) { handleError(e); }
    });

  emailCmd
    .command("send")
    .description("Send an email (alias of top-level `mailery send`)")
    .option("--from <email>", "Sender")
    .option("--to <email...>", "Recipient(s)")
    .option("--subject <subject>", "Subject")
    .option("--body <text>", "Body")
    .option("--provider <id>", "Provider ID")
    .action(() => { console.log(chalk.dim("Use: mailery send --from ... --to ... --subject ... --body ...")); });

  // ─── LOG ─────────────────────────────────────────────────────────────────────
  program.command("log").description("Show email send log (alias: mailery email list)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--status <status>", "Filter by status: sent|delivered|bounced|complained|failed")
    .option("--from <email>", "Filter by sender address")
    .option("--since <date>", "Show emails since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .action((opts: { provider?: string; status?: string; from?: string; since?: string; limit?: string; offset?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const limit = parseCliPositiveIntOption(opts.limit, 20);
        const offset = parseCliNonNegativeIntOption(opts.offset);
        const emails = listEmails({ provider_id: providerId, status: opts.status as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined, from_address: opts.from, since: opts.since, limit, offset });
        if (emails.length === 0) { output([], chalk.dim("No sent emails found.")); return; }
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
  program.command("search <query>").description("Search email by subject, from, or to")
    .option("--since <date>", "Show mailery since date (ISO 8601)")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N results", "0")
    .action((query: string, opts: { since?: string; limit?: string; offset?: string }) => {
      try {
        const limit = parseCliPositiveIntOption(opts.limit, 20);
        const emails = searchEmails(query, { since: opts.since, limit, offset: parseCliNonNegativeIntOption(opts.offset) });
        if (emails.length === 0) {
          const formatted = chalk.dim(`No sent emails matching "${query}".`);
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
        if (replyCount > 0) console.log(`  ${chalk.dim("Replies:")}  ${chalk.cyan(String(replyCount))} (use 'mailery replies ${id}' to view)`);

        if (content) {
          const headers = content.headers;
          if (Object.keys(headers).length > 0) {
            console.log(chalk.bold("\n  Headers:"));
            for (const [k, v] of Object.entries(headers)) {
              console.log(`    ${chalk.dim(k + ":")} ${v}`);
            }
          }

          if (content.text_body || content.html) {
            console.log(chalk.bold("\n  Body:"));
            console.log(readableMessageText(content.text_body, content.html).split("\n").map((l: string) => `    ${l}`).join("\n"));
          }
        } else {
          console.log(chalk.dim("\n  No body content stored for this email."));
        }
        console.log();
      } catch (e) { handleError(e); }
    });

  // ─── REPLIES ─────────────────────────────────────────────────────────────────
  program.command("replies <id>").description("Show replies received for a sent email")
    .option("--limit <n>", "Max replies", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N replies", "0")
    .action((id: string, opts: ReplyPageOpts) => {
      try {
        const db = getDatabase();
        const resolvedId = resolveId("emails", id);
        const { limit, offset } = parseReplyPage(opts);
        const total = getReplyCount(resolvedId, db);
        const replies = listReplySummaries(resolvedId, db, { limit, offset });
        output(
          replyPagePayload(replies, total, limit, offset),
          formatReplySummaries(replies, total, limit, offset, `email ${id.slice(0, 8)}`),
        );
      } catch (e) { handleError(e); }
    });

  // ─── CONVERSATION ─────────────────────────────────────────────────────────────
  program.command("conversation <id>").description("Show full conversation thread for a sent email (email + all replies)")
    .option("--limit <n>", "Max reply bodies", String(DEFAULT_REPLY_LIMIT))
    .option("--offset <n>", "Skip first N replies", "0")
    .action((id: string, opts: ReplyPageOpts) => {
      try {
        const db = getDatabase();
        const resolvedId = resolveId("emails", id);
        const emailRecord = getEmail(resolvedId, db);
        if (!emailRecord) handleError(new Error(`Email not found: ${id}`));
        const { limit, offset } = parseReplyPage(opts);
        const total = getReplyCount(resolvedId, db);
        const replies = listReplies(resolvedId, db, { limit, offset });
        const messageCount = 1 + total;

        console.log(chalk.bold(`\nConversation thread (${messageCount} message${messageCount === 1 ? "" : "s"})\n`));
        if (offset > 0 || offset + replies.length < total) {
          console.log(chalk.dim(`  Showing ${replies.length} of ${total} replies (offset ${offset}, limit ${limit}).\n`));
        }

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
        output({ email: emailRecord, ...replyPagePayload(replies, total, limit, offset) }, "");
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
            resolvedProviderId = resolvePartialIdOrThrow(db, "providers", defaultId);
          } else {
            const activeProviderId = getLatestActiveProviderId(undefined, db);
            if (!activeProviderId) handleError(new Error("No active providers. Add one with 'mailery provider add'"));
            resolvedProviderId = activeProviderId!;
          }
        }
        const provider = getProvider(resolvedProviderId!, db);
        if (!provider) handleError(new Error(`Provider not found: ${resolvedProviderId!}`));
        const preferredAddress = getPreferredActiveAddressEmail({ provider_id: resolvedProviderId! }, db);
        let toEmail = opts?.to;
        if (!toEmail) {
          if (preferredAddress) toEmail = preferredAddress;
          else handleError(new Error("No --to address specified and no addresses found for this provider"));
        }
        let fromEmail: string;
        if (preferredAddress) { fromEmail = preferredAddress; }
        else { handleError(new Error("No sender addresses configured for this provider. Add one with 'mailery address add'")); }
        const ts = new Date().toISOString();
        const subject = `Test from mailery \u2014 ${ts}`;
        const text = `This is a test email sent via Mailery at ${ts}. Provider: ${provider!.name} (${provider!.type})`;
        const sendOpts = { from: fromEmail!, to: toEmail!, subject, text };
        const { sendWithFailover } = await import("../../lib/send.js");
        const { messageId, providerId: actualProviderId, selfHostedSendAttemptId } = await sendWithFailover(resolvedProviderId!, sendOpts, db);
        await createSentEmailLedger(actualProviderId, sendOpts, messageId, db, selfHostedSendAttemptId);
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
    .option("--from <email>", "Filter exported mailery by sender address")
    .option("--since <date>", "Filter from date (ISO)")
    .option("--until <date>", "Filter until date (ISO)")
    .option("--limit <n>", "Maximum rows to export")
    .option("--offset <n>", "Number of rows to skip")
    .option("--format <fmt>", "Output format: json | csv", "json")
    .option("--output <file>", "Write to file instead of stdout")
    .action((type: string, opts: { provider?: string; from?: string; since?: string; until?: string; limit?: string; offset?: string; format?: string; output?: string }) => {
      try {
        if (type !== "emails" && type !== "events") {
          handleError(new Error("Export type must be 'emails' or 'events'"));
        }

        const { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } = require("../../lib/export.js");
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const fmt = opts.format ?? "json";
        const hasPage = opts.limit !== undefined || opts.offset !== undefined;
        const limit = hasPage ? parseCliPositiveIntOption(opts.limit, 50, MAX_EMAIL_EXPORT_LIMIT) : undefined;
        const offset = hasPage ? parseCliNonNegativeIntOption(opts.offset, 0) : undefined;
        const page = hasPage ? { limit, offset } : {};
        let result: string;

        if (type === "emails") {
          const filters = { provider_id: providerId, from_address: opts.from, since: opts.since, until: opts.until, ...page };
          result = fmt === "csv" ? exportEmailsCsv(filters) : exportEmailsJson(filters);
        } else {
          const filters = { provider_id: providerId, since: opts.since, until: opts.until, ...page };
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
