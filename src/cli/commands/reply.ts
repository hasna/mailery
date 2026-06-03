import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase, uuid } from "../../db/database.js";
import { getInboundEmail } from "../../db/inbound.js";
import { getEmail, createEmail } from "../../db/emails.js";
import { storeEmailContent } from "../../db/email-content.js";
import { getEmailThreading, setEmailThreading, setInboundThreadId } from "../../db/threads.js";
import { generateMessageId, buildThreadingHeaders, parseReferences } from "../../lib/threading.js";
import { sendWithFailover } from "../../lib/send.js";
import { handleError, resolveId } from "../utils.js";

function rePrefix(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

export function registerReplyCommand(program: Command, output: (data: unknown, formatted: string) => void): void {
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
        const inbound = getInboundEmail(resolveId("inbound_emails", id) ?? id, db);
        const sent = inbound ? null : getEmail(resolveId("emails", id) ?? id, db);
        if (!inbound && !sent) return handleError(new Error(`Email not found: ${id}`));

        let from: string, to: string[], subject: string;
        let parentMsgId: string | null, parentRefs: string[], threadId: string;

        if (inbound) {
          const ourAddr = opts.from ?? inbound.to_addresses[0] ?? "";
          from = ourAddr;
          to = [inbound.from_address, ...(opts.all ? inbound.to_addresses.filter((a) => a !== ourAddr) : [])];
          subject = rePrefix(inbound.subject);
          parentMsgId = inbound.message_id ?? null;
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
