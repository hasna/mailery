import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase, uuid, resolvePartialId, type Database } from "../../db/database.js";
import { getInboundEmail, type InboundEmail } from "../../db/inbound.js";
import { getEmail, createEmail } from "../../db/emails.js";
import type { Email } from "../../types/index.js";
import { storeEmailContent } from "../../db/email-content.js";
import { getEmailThreading, setEmailThreading, setInboundThreadId } from "../../db/threads.js";
import { generateMessageId, buildThreadingHeaders, parseReferences } from "../../lib/threading.js";
import { sendWithFailover } from "../../lib/send.js";
import { handleError, resolveId } from "../utils.js";

/**
 * Resolve an id that may name an inbound OR a sent email. Uses resolvePartialId
 * (returns null on miss) rather than resolveId (which exits the process) so a
 * sent-email id doesn't get killed by the inbound lookup.
 */
export function resolveInboundOrSent(id: string, db: Database): { inbound: InboundEmail | null; sent: Email | null } {
  const inbound = getInboundEmail(resolvePartialId(db, "inbound_emails", id) ?? id, db);
  if (inbound) return { inbound, sent: null };
  const sent = getEmail(resolvePartialId(db, "emails", id) ?? id, db);
  return { inbound: null, sent };
}

function rePrefix(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function fwdPrefix(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

function quoteBody(from: string, at: string, body: string): string {
  return `\n\n---------- Forwarded message ----------\nFrom: ${from}\nDate: ${at}\n\n${body}`;
}

export function registerReplyCommand(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ── forward ───────────────────────────────────────────────────────────────
  program
    .command("forward <id>")
    .description("Forward an inbound or sent email to new recipients (quoted body)")
    .requiredOption("--to <email...>", "Recipient(s)")
    .requiredOption("--from <email>", "From address")
    .option("--body <text>", "Optional note prepended to the quoted message")
    .option("--provider <id>", "Provider ID")
    .action(async (id: string, opts: { to: string[]; from: string; body?: string; provider?: string }) => {
      try {
        const db = getDatabase();
        const { inbound, sent } = resolveInboundOrSent(id, db);
        if (!inbound && !sent) return handleError(new Error(`Email not found: ${id}`));

        const origFrom = inbound ? inbound.from_address : sent!.from_address;
        const origAt = inbound ? inbound.received_at : sent!.sent_at;
        const origSubject = inbound ? inbound.subject : sent!.subject;
        let origBody = "";
        if (inbound) origBody = inbound.text_body ?? "";
        else {
          const { getEmailContent } = await import("../../db/email-content.js");
          origBody = getEmailContent(sent!.id, db)?.text_body ?? "";
        }
        const subject = fwdPrefix(origSubject);
        const body = (opts.body ? opts.body : "") + quoteBody(origFrom, origAt, origBody);

        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const ourMessageId = generateMessageId(opts.from.split("@")[1] ?? "localhost");
        const sendOpts = { provider_id: providerId, from: opts.from, to: opts.to, subject, text: body, headers: { "Message-ID": ourMessageId } };
        const { messageId, providerId: actual } = await sendWithFailover(providerId ?? "", sendOpts, db);
        const email = createEmail(actual, sendOpts, messageId, db);
        setEmailThreading(email.id, { message_id: ourMessageId, thread_id: ourMessageId.replace(/[<>]/g, ""), in_reply_to: null, references: [] });
        storeEmailContent(email.id, { text: body }, db);
        output({ id: email.id, to: opts.to, subject }, chalk.green(`✓ forwarded to ${opts.to.join(", ")} — "${subject}"`));
      } catch (e) { handleError(e); }
    });

  program
    .command("reply <id>")
    .description("Reply to an inbound or sent email, in-thread (sets In-Reply-To/References, Re: subject)")
    .requiredOption("--body <text>", "Reply body")
    .option("--html", "Treat --body as HTML")
    .option("--provider <id>", "Provider ID (defaults to first active)")
    .option("--all", "Reply-all (include other recipients)")
    .option("--from <email>", "Override the From address")
    .action(async (id: string, opts: { body: string; html?: boolean; provider?: string; all?: boolean; from?: string }) => {
      try {
        const db = getDatabase();

        // Resolve the email being replied to: inbound first, then sent.
        const { inbound, sent } = resolveInboundOrSent(id, db);
        if (!inbound && !sent) return handleError(new Error(`Email not found: ${id}`));

        let from: string, to: string[], subject: string;
        let parentMsgId: string | null, parentRefs: string[], threadId: string;

        if (inbound) {
          const ourAddr = opts.from ?? inbound.to_addresses[0] ?? "";
          from = ourAddr;
          to = [inbound.from_address, ...(opts.all ? inbound.to_addresses.filter((a) => a !== ourAddr) : [])];
          subject = rePrefix(inbound.subject);
          // The inbound's RFC Message-ID lives in its headers (the message_id
          // column holds the S3 key for dedup, not the RFC id).
          parentMsgId = inbound.headers?.["message-id"] ?? inbound.headers?.["Message-ID"] ?? inbound.headers?.["Message-Id"] ?? null;
          parentRefs = parseReferences(inbound.headers?.["References"] ?? inbound.headers?.["references"]);
          threadId = inbound.thread_id ?? uuid();
          if (!inbound.thread_id) setInboundThreadId(inbound.id, threadId, db);
        } else {
          const t = getEmailThreading(sent!.id, db);
          from = opts.from ?? sent!.from_address;
          to = sent!.to_addresses;
          subject = rePrefix(sent!.subject);
          parentMsgId = t?.message_id ?? (sent!.provider_message_id ? `<${sent!.provider_message_id}>` : null);
          parentRefs = t?.references ?? [];
          threadId = t?.thread_id ?? uuid();
        }
        if (!from) return handleError(new Error("Could not determine From address; pass --from"));

        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const fromDomain = from.split("@")[1] ?? "localhost";
        const ourMessageId = generateMessageId(fromDomain);
        const headers: Record<string, string> = { "Message-ID": ourMessageId };
        let references: string[] = [];
        let inReplyTo: string | null = null;
        if (parentMsgId) {
          const h = buildThreadingHeaders({ message_id: parentMsgId, references: parentRefs });
          headers["In-Reply-To"] = h.inReplyToHeader;
          headers["References"] = h.referencesHeader;
          inReplyTo = h.inReplyTo;
          references = h.references;
        }

        const sendOpts = {
          provider_id: providerId, from, to, subject,
          ...(opts.html ? { html: opts.body } : { text: opts.body }),
          headers,
        };
        const { messageId, providerId: actual } = await sendWithFailover(providerId ?? "", sendOpts, db);
        const email = createEmail(actual, sendOpts, messageId, db);
        setEmailThreading(email.id, { message_id: ourMessageId, thread_id: threadId, in_reply_to: inReplyTo, references }, db);
        storeEmailContent(email.id, opts.html ? { html: opts.body } : { text: opts.body }, db);

        output({ id: email.id, thread_id: threadId, to, subject },
          chalk.green(`✓ replied to ${to.join(", ")} — "${subject}" (thread ${threadId.slice(0, 8)})`));
      } catch (e) { handleError(e); }
    });
}
