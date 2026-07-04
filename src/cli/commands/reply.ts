import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { getDatabase, uuid, resolvePartialId, listPartialIdMatches, resolvePartialIdOrThrow, type Database } from "../../db/database.js";
import { getInboundEmail, type InboundEmail } from "../../db/inbound.js";
import { getEmail } from "../../db/emails.js";
import { getLatestActiveProviderId } from "../../db/providers.js";
import type { Email } from "../../types/index.js";
import { getEmailThreading, setInboundThreadId } from "../../db/threads.js";
import { createSentEmailLedger, setSentEmailThreading, storeSentEmailContent } from "../../lib/sent-ledger.js";
import { generateMessageId, buildThreadingHeaders, parseReferences } from "../../lib/threading.js";
import { resolveMailDataSource } from "../../lib/mail-data-source.js";
import { handleError } from "../utils.js";

/**
 * Resolve an id that may name an inbound OR a sent email. A miss in the first
 * table falls through to the second, but ambiguous prefixes fail loudly.
 */
export function resolveInboundOrSent(id: string, db: Database): { inbound: InboundEmail | null; sent: Email | null } {
  const inboundId = resolveMaybeId(db, "inbound_emails", id);
  const inbound = inboundId ? getInboundEmail(inboundId, db) : null;
  if (inbound) return { inbound, sent: null };
  const sentId = resolveMaybeId(db, "emails", id);
  const sent = sentId ? getEmail(sentId, db) : null;
  return { inbound: null, sent };
}

function resolveMaybeId(db: Database, table: "inbound_emails" | "emails", id: string): string | null {
  const value = id.trim();
  if (!value) return null;
  const resolved = resolvePartialId(db, table, value);
  if (resolved) return resolved;
  const matches = listPartialIdMatches(db, table, value, 2);
  if (matches.length > 1) {
    throw new Error(`Ambiguous ID '${value}' in table '${table}'. Use a longer prefix or full ID.`);
  }
  return null;
}

/** Resolve the provider to send through — the given one, else the first active. */
function resolveSendProvider(optProvider: string | undefined, db: Database): string {
  if (optProvider) {
    return resolvePartialIdOrThrow(db, "providers", optProvider);
  }
  const activeProviderId = getLatestActiveProviderId(undefined, db);
  if (!activeProviderId) throw new Error("No active providers. Add one with 'mailery provider add'");
  return activeProviderId;
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
        // Cloud mode: read the source message through the seam and forward via the server
        // send API (the local provider path / local ledger does not apply).
        const ds = resolveMailDataSource();
        if (ds.mode !== "local") {
          const msg = await ds.getMessage(id);
          if (!msg) return handleError(new Error(`Email not found: ${id}`));
          const body = await ds.getMessageBody(msg);
          const origBody = body?.text ?? body?.html ?? "";
          const subject = fwdPrefix(msg.subject);
          const fwdBody = (opts.body ? opts.body : "") + quoteBody(msg.from, msg.date, origBody);
          const result = await ds.send({ from: opts.from, to: opts.to.join(", "), subject, body: fwdBody, markdown: false });
          output({ id: result.id, to: opts.to, subject }, chalk.green(`✓ forwarded to ${opts.to.join(", ")} — "${subject}"`));
          return;
        }
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

        const providerId = resolveSendProvider(opts.provider, db);
        const ourMessageId = generateMessageId(opts.from.split("@")[1] ?? "localhost");
        const sendOpts = { provider_id: providerId, from: opts.from, to: opts.to, subject, text: body, headers: { "Message-ID": ourMessageId } };
        const { sendWithFailover } = await import("../../lib/send.js");
        const { messageId, providerId: actual } = await sendWithFailover(providerId, sendOpts, db);
        const email = await createSentEmailLedger(actual, sendOpts, messageId, db);
        await setSentEmailThreading(email.id, { message_id: ourMessageId, thread_id: ourMessageId.replace(/[<>]/g, ""), in_reply_to: null, references: [] }, db);
        await storeSentEmailContent(email.id, { text: body }, db);
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
        // Cloud mode: read the parent through the seam and reply via the server send API.
        // NOTE: the server /messages/send endpoint carries no in-reply-to/references, so
        // the reply is delivered as a new message and is not thread-linked server-side.
        // We report the parent's real thread id (when present) rather than fabricating one.
        const ds = resolveMailDataSource();
        if (ds.mode !== "local") {
          const msg = await ds.getMessage(id);
          if (!msg) return handleError(new Error(`Email not found: ${id}`));
          const { replyDefaults } = await import("../tui/data.js");
          const defaults = replyDefaults(msg);
          const from = opts.from ?? defaults.from;
          if (!from) return handleError(new Error("Could not determine From address; pass --from"));
          // Base recipients from the reply target; --all folds in the other recipients,
          // excluding ourselves and de-duping (addresses, not the joined string).
          const candidates = opts.all ? [defaults.to, ...msg.to.split(",")] : [defaults.to];
          const seen = new Set<string>();
          const toArr: string[] = [];
          for (const raw of candidates.flatMap((value) => value.split(","))) {
            const addr = raw.trim();
            if (!addr) continue;
            const key = addr.toLowerCase();
            if (key === from.toLowerCase() || seen.has(key)) continue;
            seen.add(key);
            toArr.push(addr);
          }
          const result = await ds.send({
            from,
            to: toArr.join(", "),
            subject: defaults.subject,
            body: opts.html ? "" : opts.body,
            html: opts.html ? opts.body : undefined,
            markdown: false,
            replyToId: id,
          });
          const threadId = msg.thread_id ?? null;
          const suffix = threadId ? ` (thread ${threadId.slice(0, 8)})` : "";
          output({ id: result.id, thread_id: threadId, to: toArr, subject: defaults.subject },
            chalk.green(`✓ replied to ${toArr.join(", ")} — "${defaults.subject}"${suffix}`));
          return;
        }
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

        const providerId = resolveSendProvider(opts.provider, db);
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
        const { sendWithFailover } = await import("../../lib/send.js");
        const { messageId, providerId: actual } = await sendWithFailover(providerId, sendOpts, db);
        const email = await createSentEmailLedger(actual, sendOpts, messageId, db);
        await setSentEmailThreading(email.id, { message_id: ourMessageId, thread_id: threadId, in_reply_to: inReplyTo, references }, db);
        await storeSentEmailContent(email.id, opts.html ? { html: opts.body } : { text: opts.body }, db);

        output({ id: email.id, thread_id: threadId, to, subject },
          chalk.green(`✓ replied to ${to.join(", ")} — "${subject}" (thread ${threadId.slice(0, 8)})`));
      } catch (e) { handleError(e); }
    });
}
