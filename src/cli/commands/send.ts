import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { resolveMailDataSource, type MailSendAttachment } from "../../lib/mail-data-source.js";
import { getEmail } from "../../db/emails.js";
import { getLatestActiveProviderId, getProvider } from "../../db/providers.js";
import { getTemplate, renderTemplate } from "../../db/templates.js";
import { getSuppressedEmailSet, incrementSendCounts } from "../../db/contacts.js";
import { createScheduledEmail } from "../../db/scheduled.js";
import { getGroupByName, listMembers } from "../../db/groups.js";
import { getDatabase, type Database } from "../../db/database.js";
import { log } from "../../lib/logger.js";
import { createSentEmailLedger, setSentEmailThreading, storeSentEmailContent } from "../../lib/sent-ledger.js";
import { handleError, resolveId } from "../utils.js";

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB (Resend/SES limit)
const MAX_ATTACHMENT_COUNT = 10;
const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".html": "text/html",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".zip": "application/zip",
  ".csv": "text/csv",
  ".json": "application/json",
};

// Read + base64-encode attachment files, enforcing the count/size caps. Shared by the
// local provider path and the self_hosted seam path so both validate identically.
function readSendAttachments(paths: string[] | undefined): MailSendAttachment[] {
  if (!paths || paths.length === 0) return [];
  if (paths.length > MAX_ATTACHMENT_COUNT) {
    handleError(new Error(`Too many attachments: ${paths.length} (max ${MAX_ATTACHMENT_COUNT})`));
  }
  const attachments: MailSendAttachment[] = [];
  for (const path of paths) {
    const stat = statSync(path);
    if (stat.size > MAX_ATTACHMENT_SIZE) {
      handleError(new Error(`Attachment "${basename(path)}" is too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 25MB)`));
    }
    const content = readFileSync(path);
    const ext = extname(path).toLowerCase();
    attachments.push({
      filename: basename(path),
      content: content.toString("base64"),
      content_type: ATTACHMENT_MIME_TYPES[ext] ?? "application/octet-stream",
    });
  }
  return attachments;
}

export function registerSendCommands(program: Command, _output: (data: unknown, formatted: string) => void): void {
  program
    .command("send")
    .description("Send an email")
    .requiredOption("--from <email>", "Sender email address")
    .option("--to <email...>", "Recipient email address(es)")
    .option("--to-group <name>", "Send to all members of a recipient group")
    .option("--subject <subject>", "Email subject")
    .option("--body <text>", "Email body text")
    .option("--body-file <path>", "Read body from file")
    .option("--html", "Treat --body as HTML")
    .option("--cc <email...>", "CC recipients")
    .option("--bcc <email...>", "BCC recipients")
    .option("--reply-to <email>", "Reply-to address")
    .option("--attachment <path...>", "Attachment file path(s)")
    .option("--provider <id>", "Provider ID (uses first active if not specified)")
    .option("--template <name>", "Use a template by name")
    .option("--vars <json>", "Template variables as JSON string")
    .option("--force", "Send even if recipients are suppressed")
    .option("--dry-run", "Preview what would be sent without actually sending")
    .option("--schedule <datetime>", "Schedule email for later (ISO 8601 datetime)")
    .option("--unsubscribe-url <url>", "Inject List-Unsubscribe headers (RFC 8058 one-click)")
    .option("--idempotency-key <key>", "Prevent duplicate sends — returns existing email if key was used before")
    .option("--track-opens", "Inject tracking pixel to detect email opens (requires emails serve running)")
    .option("--track-clicks", "Rewrite links to track clicks (requires emails serve running)")
    .option("--tracking-url <url>", "Base URL for tracking server (default: http://localhost:3900)")
    .option("--in-reply-to <id>", "Reply to an existing sent email — sets In-Reply-To/References headers for threading")
    .action(async (opts: {
      from: string;
      to?: string[];
      toGroup?: string;
      subject?: string;
      body?: string;
      bodyFile?: string;
      html?: boolean;
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
      attachment?: string[];
      provider?: string;
      template?: string;
      vars?: string;
      force?: boolean;
      schedule?: string;
      trackOpens?: boolean;
      trackClicks?: boolean;
      trackingUrl?: string;
    }) => {
      try {
        const ds = resolveMailDataSource();
        const selfHosted = ds.mode !== "local";
        let localDatabase: Database | null = null;
        const localDb = (): Database => {
          localDatabase ??= getDatabase();
          return localDatabase;
        };

        // Resolve recipients from --to or --to-group
        let toAddresses: string[] = opts.to || [];
        if (opts.toGroup) {
          if (selfHosted) {
            handleError(new Error("--to-group is not available in self_hosted mode without a self-hosted group-members API. Pass explicit --to recipients."));
          }
          const db = localDb();
          const group = getGroupByName(opts.toGroup, db);
          if (!group) handleError(new Error(`Group not found: ${opts.toGroup}`));
          const members = listMembers(group!.id, db);
          if (members.length === 0) handleError(new Error(`Group '${opts.toGroup}' has no members`));
          toAddresses = members.map(m => m.email);
        }
        if (toAddresses.length === 0) handleError(new Error("No recipients specified. Use --to or --to-group"));

        // Check suppressed contacts
        const allRecipients = [...toAddresses, ...(opts.cc || []), ...(opts.bcc || [])];
        const suppressedEmailSet = getSuppressedEmailSet(allRecipients, selfHosted ? undefined : localDb());
        const suppressedRecipients = allRecipients.filter((email) => suppressedEmailSet.has(email));
        if (suppressedRecipients.length > 0 && !opts.force) {
          console.log(chalk.yellow(`Warning: Suppressed recipients: ${suppressedRecipients.join(", ")}`));
          console.log(chalk.dim("  Use --force to send anyway."));
        }

        // Resolve body from --body, --body-file, or stdin pipe
        let body = opts.body;
        if (opts.bodyFile) {
          body = readFileSync(opts.bodyFile, "utf-8");
        } else if (!body && !opts.template && !process.stdin.isTTY) {
          body = await new Promise<string>((resolve) => {
            let data = "";
            process.stdin.setEncoding("utf-8");
            process.stdin.on("data", (chunk: string) => data += chunk);
            process.stdin.on("end", () => resolve(data));
          });
        }

        // Resolve template
        let subject = opts.subject || "";
        let htmlBody = opts.html ? body : undefined;
        let textBody = !opts.html ? body : undefined;

        if (opts.template) {
          const tpl = getTemplate(opts.template, selfHosted ? undefined : localDb());
          if (!tpl) handleError(new Error(`Template not found: ${opts.template}`));
          const vars: Record<string, string> = opts.vars ? JSON.parse(opts.vars) : {};
          subject = renderTemplate(tpl!.subject_template, vars);
          if (tpl!.html_template) htmlBody = renderTemplate(tpl!.html_template, vars);
          if (tpl!.text_template) textBody = renderTemplate(tpl!.text_template, vars);
        }

        if (!subject) handleError(new Error("Subject is required (use --subject or --template)"));

        // ── self_hosted mode: send through the server API, not the local provider path ──────
        // Local-only concerns (provider creds/warming/tracking/scheduling/threading
        // tables, local ledger) do not apply — the server owns sending. Route the
        // composed message through the seam so self_hosted send is server-authoritative.
        if (selfHosted) {
          const attachments = readSendAttachments(opts.attachment);
          if ((opts as Record<string, unknown>).dryRun) {
            console.log(chalk.bold("\n[DRY RUN] Would send (self_hosted):"));
            console.log(`  ${chalk.dim("From:")}    ${opts.from}`);
            console.log(`  ${chalk.dim("To:")}      ${toAddresses.join(", ")}`);
            if (opts.cc?.length) console.log(`  ${chalk.dim("CC:")}      ${opts.cc.join(", ")}`);
            console.log(`  ${chalk.dim("Subject:")} ${subject}`);
            if (htmlBody) console.log(`  ${chalk.dim("Body:")}    HTML (${htmlBody.length} chars)`);
            else if (textBody) console.log(`  ${chalk.dim("Body:")}    ${textBody.slice(0, 100)}${textBody.length > 100 ? "..." : ""}`);
            if (attachments.length) console.log(chalk.dim(`  Attachments: ${attachments.length} inline file(s); self-hosted caps are 5 files, 512KiB each, 768KiB total`));
            if (opts.schedule) console.log(chalk.yellow(`  Schedule:    ${opts.schedule} — scheduling is not available in self_hosted mode (a real send would fail)`));
            console.log(chalk.yellow("\n  [NOT SENT] Use without --dry-run to send.\n"));
            return;
          }
          const result = await ds.send({
            from: opts.from,
            to: toAddresses.join(", "),
            cc: opts.cc && opts.cc.length > 0 ? opts.cc.join(", ") : undefined,
            bcc: opts.bcc && opts.bcc.length > 0 ? opts.bcc.join(", ") : undefined,
            subject,
            body: textBody ?? "",
            html: htmlBody,
            markdown: false,
            replyTo: opts.replyTo,
            replyToId: (opts as Record<string, unknown>).inReplyTo as string | undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
            scheduledAt: opts.schedule,
            idempotencyKey: (opts as Record<string, unknown>).idempotencyKey as string | undefined,
          });
          console.log(chalk.green(`✓ Email sent to ${toAddresses.join(", ")}`));
          if (result.messageId) console.log(chalk.dim(`  Message ID: ${result.messageId}`));
          return;
        }

        const db = localDb();
        let providerId: string;
        if (opts.provider) {
          providerId = resolveId("providers", opts.provider);
        } else {
          const activeProviderId = getLatestActiveProviderId(undefined, db);
          if (!activeProviderId) handleError(new Error("No active providers. Add one with 'emails provider add'"));
          providerId = activeProviderId!;
        }

        const provider = getProvider(providerId, db);
        if (!provider) handleError(new Error(`Provider not found: ${providerId}`));

        // Check domain warming limits
        const fromDomain = opts.from?.split("@")[1];
        if (fromDomain) {
          const { getWarmingSchedule } = await import("../../db/warming.js");
          const { getTodayLimit, getTodaySentCount } = await import("../../lib/warming.js");
          const warmingSchedule = getWarmingSchedule(fromDomain, db);
          if (warmingSchedule) {
            const limit = getTodayLimit(warmingSchedule);
            if (limit !== null) {
              const sent = getTodaySentCount(fromDomain, db);
              if (sent >= limit) {
                const enforceWarming = !!(opts as Record<string, unknown>).force;
                const msg = `Warming limit reached for ${fromDomain}: ${sent}/${limit} emails sent today.`;
                if (enforceWarming) {
                  log.warn(chalk.yellow(`⚠ ${msg} (--force bypasses warming)`));
                } else {
                  handleError(new Error(`${msg} Use --force to bypass or wait until tomorrow.`));
                }
              } else if (sent >= limit * 0.8) {
                log.warn(chalk.yellow(`⚠ Warming: ${sent}/${limit} emails sent today from ${fromDomain} (${Math.round(sent/limit*100)}%)`));
              }
            }
          }
        }

        // Read attachments (shared reader; validates count/size)
        const attachments = readSendAttachments(opts.attachment);

        // Handle scheduling
        if (opts.schedule) {
          const scheduled = createScheduledEmail({
            provider_id: providerId,
            from_address: opts.from,
            to_addresses: toAddresses,
            cc_addresses: opts.cc,
            bcc_addresses: opts.bcc,
            reply_to: opts.replyTo,
            subject,
            html: htmlBody,
            text_body: textBody,
            attachments_json: attachments.length > 0 ? attachments : undefined,
            template_name: opts.template,
            template_vars: opts.vars ? JSON.parse(opts.vars) : undefined,
            scheduled_at: opts.schedule,
          }, db);
          console.log(chalk.green(`✓ Email scheduled for ${opts.schedule}`));
          console.log(chalk.dim(`  Scheduled ID: ${scheduled.id.slice(0, 8)}`));
          return;
        }

        // Threading: assign our own RFC Message-ID, and (if replying) build the
        // full In-Reply-To / References ancestry chain + inherit the thread_id.
        const { generateMessageId, buildThreadingHeaders } = await import("../../lib/threading.js");
        const { getEmailThreading } = await import("../../db/threads.js");
        const ourMessageId = generateMessageId(fromDomain ?? "localhost");
        let threadId = ourMessageId.replace(/[<>]/g, "");
        let inReplyTo: string | null = null;
        let references: string[] = [];
        const threadingHeaders: Record<string, string> = { "Message-ID": ourMessageId };
        const inReplyToId = (opts as Record<string, unknown>).inReplyTo as string | undefined;
        if (inReplyToId) {
          const parent = getEmail(resolveId("emails", inReplyToId), db);
          const parentThreading = parent ? getEmailThreading(parent.id, db) : null;
          const parentMsgId = parentThreading?.message_id
            ?? (parent?.provider_message_id ? `<${parent.provider_message_id}>` : null);
          if (parentMsgId) {
            const h = buildThreadingHeaders({ message_id: parentMsgId, references: parentThreading?.references ?? [] });
            inReplyTo = h.inReplyTo;
            references = h.references;
            threadingHeaders["In-Reply-To"] = h.inReplyToHeader;
            threadingHeaders["References"] = h.referencesHeader;
            if (parentThreading?.thread_id) threadId = parentThreading.thread_id;
            log.info(chalk.dim(`  Threading reply to: ${parent?.subject}`));
          }
        }

        const sendOpts = {
          provider_id: providerId,
          from: opts.from,
          to: toAddresses,
          cc: opts.cc,
          bcc: opts.bcc,
          reply_to: opts.replyTo,
          subject,
          text: textBody,
          html: htmlBody,
          attachments: attachments.length > 0 ? attachments : undefined,
          headers: threadingHeaders,
          unsubscribe_url: (opts as Record<string, unknown>).unsubscribeUrl as string | undefined,
          idempotency_key: (opts as Record<string, unknown>).idempotencyKey as string | undefined,
          bypass_warming: !!opts.force,
        };

        // Dry run — show what would be sent without actually sending
        if ((opts as Record<string, unknown>).dryRun) {
          console.log(chalk.bold("\n[DRY RUN] Would send:"));
          console.log(`  ${chalk.dim("From:")}    ${sendOpts.from}`);
          console.log(`  ${chalk.dim("To:")}      ${(Array.isArray(sendOpts.to) ? sendOpts.to : [sendOpts.to]).join(", ")}`);
          if (sendOpts.cc) console.log(`  ${chalk.dim("CC:")}      ${(Array.isArray(sendOpts.cc) ? sendOpts.cc : [sendOpts.cc]).join(", ")}`);
          console.log(`  ${chalk.dim("Subject:")} ${sendOpts.subject}`);
          if (sendOpts.html) console.log(`  ${chalk.dim("Body:")}    HTML (${sendOpts.html.length} chars)`);
          else if (sendOpts.text) console.log(`  ${chalk.dim("Body:")}    ${sendOpts.text.slice(0, 100)}${sendOpts.text.length > 100 ? "..." : ""}`);
          if (sendOpts.attachments?.length) console.log(`  ${chalk.dim("Attachments:")} ${sendOpts.attachments.length} file(s)`);
          if (sendOpts.unsubscribe_url) console.log(`  ${chalk.dim("Unsubscribe:")} ${sendOpts.unsubscribe_url}`);
          console.log(chalk.yellow("\n  [NOT SENT] Use without --dry-run to send.\n"));
          return;
        }

        const { sendWithFailover } = await import("../../lib/send.js");
        const { messageId, providerId: actualProviderId, usedFailover } = await sendWithFailover(providerId, sendOpts, db);
        if (usedFailover) log.info(chalk.yellow(`  (Used failover provider)`));

        const email = await createSentEmailLedger(actualProviderId, sendOpts, messageId, db);
        // Persist threading (own Message-ID, thread_id, In-Reply-To, References).
        await setSentEmailThreading(email.id, { message_id: ourMessageId, thread_id: threadId, in_reply_to: inReplyTo, references }, db);

        // Store email content (with tracking injected if requested)
        let storedHtml = htmlBody;
        if ((opts.trackOpens || opts.trackClicks) && htmlBody) {
          const { prepareTrackedHtml } = await import("../../lib/tracking.js");
          // If --tracking-url was specified, temporarily use it by setting the config key
          if (opts.trackingUrl) {
            const { setConfigValue } = await import("../../lib/config.js");
            setConfigValue("tracking-base-url", opts.trackingUrl);
          }
          storedHtml = await prepareTrackedHtml(htmlBody, email.id, !!opts.trackOpens, !!opts.trackClicks);
          log.info(chalk.dim("  Tracking enabled — open emails serve to record opens/clicks"));
        }
        await storeSentEmailContent(email.id, { html: storedHtml, text: textBody }, db);

        // Track contacts
        incrementSendCounts(allRecipients, db);

        console.log(chalk.green(`✓ Email sent to ${toAddresses.join(", ")}`));
        if (messageId) console.log(chalk.dim(`  Message ID: ${messageId}`));
      } catch (e) {
        handleError(e);
      }
    });

}
