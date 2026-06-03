import type { Command } from "commander";
import chalk from "chalk";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { S3Client } from "@aws-sdk/client-s3";
import { runConnectorOperation } from "@hasna/connectors";
import { syncGmailInbox, syncGmailInboxAll, syncGmailInboxHistory, listGmailConnectorProfiles, listGmailLabels } from "../../lib/gmail-sync.js";
import {
  listInboundEmails, getInboundEmail, deleteInboundEmail, clearInboundEmails, getInboundCount,
  setInboundRead, setInboundArchived, setInboundStarred,
  addInboundLabel, removeInboundLabel, getUnreadCount,
} from "../../db/inbound.js";
import { getGmailSyncState, updateLastSynced } from "../../db/gmail-sync-state.js";
import { createProvider, listProviders } from "../../db/providers.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { confirmDestructiveAction, handleError } from "../utils.js";

const DEFAULT_GMAIL_ARCHIVE_BUCKET = "hasna-xyz-prod-emails";

export function registerInboxCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const inboxCmd = program.command("inbox").description("Sync and browse inbound emails (Gmail, SMTP, S3)");

  // ─── SYNC ─────────────────────────────────────────────────────────────────
  inboxCmd
    .command("sync")
    .description("Sync Gmail inbox messages into local SQLite")
    .option("--provider <id>", "Provider ID or name (defaults to first active Gmail provider)")
    .option("--profile <name>", "Connector Gmail profile to use")
    .option("--all-profiles", "Discover connector Gmail profiles and sync each one")
    .option("--label <label>", "Gmail label to sync (e.g. INBOX, SENT, label ID)", "INBOX")
    .option("--query <query>", "Gmail search query (e.g. 'is:unread from:boss@example.com')")
    .option("--limit <n>", "Max messages per sync run", "50")
    .option("--concurrency <n>", "Messages to process concurrently per listed page", process.env.EMAILS_GMAIL_SYNC_CONCURRENCY ?? "1")
    .option("--since <date>", "Only sync messages after this date (ISO 8601 or YYYY-MM-DD)")
    .option("--all", "Sync all pages until done (use for initial backfill)")
    .option("--history", "Use stored Gmail history cursor for incremental sync")
    .option("--archive-s3 [bucket]", `Archive raw MIME and metadata to S3 bucket (default: ${DEFAULT_GMAIL_ARCHIVE_BUCKET})`)
    .option("--no-attachments", "Skip attachment download")
    .action(async (opts: {
      provider?: string;
      profile?: string;
      allProfiles?: boolean;
      label?: string;
      query?: string;
      limit?: string;
      concurrency?: string;
      since?: string;
      all?: boolean;
      history?: boolean;
      archiveS3?: boolean | string;
      attachments: boolean;
    }) => {
      try {
        const db = getDatabase();
        const archiveBucket = opts.archiveS3
          ? (typeof opts.archiveS3 === "string" ? opts.archiveS3 : DEFAULT_GMAIL_ARCHIVE_BUCKET)
          : undefined;

        if (opts.allProfiles) {
          const profiles = await listGmailConnectorProfiles();
          if (profiles.length === 0) {
            console.error(chalk.red("No Gmail connector profiles found."));
            process.exit(1);
          }

          const aggregate = { synced: 0, skipped: 0, attachments_saved: 0, errors: [] as string[], done: true };
          for (const profile of profiles) {
            const providerId = ensureGmailProviderForProfile(profile);
            const syncOptions = {
              providerId,
              profile,
              labelFilter: opts.label,
              query: opts.query,
              batchSize: parseInt(opts.limit ?? "50", 10),
              messageConcurrency: parseInt(opts.concurrency ?? "1", 10),
              since: opts.since,
              archiveS3Bucket: archiveBucket,
              downloadAttachments: opts.attachments !== false,
              db,
            };
            const page = opts.all
              ? await syncGmailInboxAll(syncOptions)
              : opts.history
                ? await syncGmailInboxHistory(syncOptions)
              : await syncGmailInbox(syncOptions);
            updateLastSynced(providerId, undefined, db);
            aggregate.synced += page.synced;
            aggregate.skipped += page.skipped;
            aggregate.attachments_saved += page.attachments_saved;
            aggregate.errors.push(...page.errors);
            aggregate.done = aggregate.done && page.done;
          }

          output(aggregate, formatSyncResult(aggregate, false));
          return;
        }

        // Resolve provider
        const providerId = resolveGmailProvider(opts.provider);
        if (!providerId) {
          console.error(chalk.red("No Gmail provider found. Add one with: emails provider add-gmail"));
          process.exit(1);
        }

        const syncOpts = {
          providerId,
          labelFilter: opts.label,
          profile: opts.profile,
          query: opts.query,
          batchSize: parseInt(opts.limit ?? "50", 10),
          messageConcurrency: parseInt(opts.concurrency ?? "1", 10),
          since: opts.since,
          archiveS3Bucket: archiveBucket,
          downloadAttachments: opts.attachments !== false,
          db,
        };

        console.log(chalk.dim(`Syncing Gmail inbox for provider ${providerId}...`));

        let result;
        if (opts.all) {
          // Paginate manually so we can print progress per page
          const { syncGmailInbox: syncPage } = await import("../../lib/gmail-sync.js");
          const aggregate = { synced: 0, skipped: 0, attachments_saved: 0, errors: [] as string[], done: true };
          let pageToken: string | undefined;
          let page = 0;
          do {
            page++;
            const pageResult = await syncPage({ ...syncOpts, pageToken });
            aggregate.synced += pageResult.synced;
            aggregate.skipped += pageResult.skipped;
            aggregate.attachments_saved += pageResult.attachments_saved ?? 0;
            aggregate.errors.push(...pageResult.errors);
            pageToken = pageResult.nextPageToken;
            aggregate.done = pageResult.done;
            process.stdout.write(
              chalk.dim(`  Page ${page}: synced ${pageResult.synced}, skipped ${pageResult.skipped}`) +
              (pageResult.attachments_saved ? chalk.dim(`, ${pageResult.attachments_saved} attachments`) : "") +
              (pageResult.done ? "" : chalk.dim(" — continuing...")) + "\n",
            );
            if (aggregate.errors.length >= 20) { aggregate.errors.push("Too many errors — aborting"); break; }
          } while (!aggregate.done);
          result = aggregate;
        } else if (opts.history) {
          result = await syncGmailInboxHistory(syncOpts);
        } else {
          result = await syncGmailInbox(syncOpts);
        }

        // Update sync state
        updateLastSynced(providerId, undefined, db);

        output(result, formatSyncResult(result, opts.all));

        if (result.errors.length > 0) {
          console.log(chalk.yellow("\nErrors:"));
          for (const e of result.errors) console.log(chalk.yellow(`  ${e}`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ─── LIST ─────────────────────────────────────────────────────────────────
  inboxCmd
    .command("list")
    .description("List synced inbound emails from local SQLite")
    .option("--provider <id>", "Filter by provider ID")
    .option("--since <date>", "Only show emails after this date")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .option("--search <query>", "Filter by subject/from (local, not Gmail API)")
    .option("--unread", "Only unread mail")
    .option("--read", "Only read mail")
    .option("--starred", "Only starred mail")
    .option("--archived", "Show archived mail (hidden by default)")
    .option("--label <label>", "Only mail carrying this label")
    .action((opts: { provider?: string; since?: string; limit?: string; offset?: string; search?: string; unread?: boolean; read?: boolean; starred?: boolean; archived?: boolean; label?: string }) => {
      try {
        const db = getDatabase();
        const limit = parseInt(opts.limit ?? "20", 10);
        const offset = parseInt(opts.offset ?? "0", 10);
        let emails = listInboundEmails({
          provider_id: opts.provider, since: opts.since, limit, offset,
          unread: opts.unread, read: opts.read, starred: opts.starred,
          archived: opts.archived, label: opts.label,
        }, db);

        if (opts.search) {
          const q = opts.search.toLowerCase();
          emails = emails.filter(
            (e) => e.subject.toLowerCase().includes(q) || e.from_address.toLowerCase().includes(q),
          );
        }

        if (emails.length === 0) {
          console.log(chalk.dim("No emails found. Run `emails inbox sync` to pull from Gmail."));
          return;
        }

        output(emails, formatEmailList(emails));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── SEARCH ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("search <query>")
    .description("Search synced emails locally (add --remote to search live Gmail)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Max results", "20")
    .option("--remote", "Search live Gmail via connector (not just local DB)")
    .action(async (query: string, opts: { provider?: string; limit?: string; remote?: boolean }) => {
      try {
        const db = getDatabase();
        const limit = parseInt(opts.limit ?? "20", 10);

        if (opts.remote) {
          // Live Gmail search via connectors SDK
          const r = await runConnectorOperation<{ messages?: { id: string; from: string; subject: string; date: string }[] } | { id: string; from: string; subject: string; date: string }[]>({
            connector: "gmail",
            operation: "messages.list",
            input: { query, max: opts.limit ?? "20" },
          });
          if (!r.success) {
            console.error(chalk.red(`Gmail search failed: ${r.stderr}`));
            process.exit(1);
          }
          const raw = r.data;
          const results = (Array.isArray(raw) ? raw : raw?.messages ?? []) as { id: string; from: string; subject: string; date: string }[];
          output(results, formatRemoteResults(results, query));
          return;
        }

        // Local DB search
        const q = query.toLowerCase();
        const emails = listInboundEmails({ provider_id: opts.provider, limit: limit * 4 }, db).filter(
          (e) =>
            e.subject.toLowerCase().includes(q) ||
            e.from_address.toLowerCase().includes(q) ||
            (e.text_body ?? "").toLowerCase().includes(q),
        ).slice(0, limit);

        if (emails.length === 0) {
          console.log(chalk.dim(`No results for "${query}". Try --remote to search live Gmail.`));
          return;
        }

        output(emails, formatEmailList(emails, `Search: "${query}"`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── STATUS ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("status")
    .description("Show sync status per Gmail provider")
    .action(() => {
      try {
        const db = getDatabase();
        const providers = listProviders(db).filter((p) => p.type === "gmail");

        if (providers.length === 0) {
          console.log(chalk.dim("No Gmail providers configured. Add one with: emails provider add-gmail"));
          return;
        }

        console.log(chalk.bold("\nGmail Sync Status:"));
        for (const p of providers) {
          const state = getGmailSyncState(p.id, db);
          const count = getInboundCount(p.id, db);
          const unread = getUnreadCount(p.id, db);
          console.log(`\n  ${chalk.cyan(p.name)} ${chalk.dim(`[${p.id.slice(0, 8)}]`)}`);
          console.log(`    Synced emails:  ${count} ${unread > 0 ? chalk.cyan(`(${unread} unread)`) : ""}`);
          console.log(`    Last synced:    ${state?.last_synced_at ? chalk.green(state.last_synced_at) : chalk.dim("never")}`);
          if (state?.last_message_id) console.log(`    Last message:   ${state.last_message_id}`);
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  // ─── LABELS ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("labels")
    .description("List available Gmail labels for the connected account")
    .option("--provider <id>", "Provider ID (defaults to first active Gmail provider)")
    .action(async (opts: { provider?: string }) => {
      try {
        const providerId = resolveGmailProvider(opts.provider);
        if (!providerId) {
          console.error(chalk.red("No Gmail provider found. Add one with: emails provider add-gmail"));
          process.exit(1);
        }
        const labels = await listGmailLabels(providerId);
        if (labels.length === 0) {
          console.log(chalk.dim("No labels found. Is this Gmail provider authenticated?"));
          return;
        }
        console.log(chalk.bold("\nGmail Labels:"));
        for (const l of labels) {
          console.log(`  ${chalk.cyan(l.id.padEnd(28))} ${l.name}`);
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  // ─── READ ─────────────────────────────────────────────────────────────────
  inboxCmd
    .command("read <id>")
    .description("Read a synced email from local DB (marks it read)")
    .option("--keep-unread", "Do not mark the email as read")
    .action((id: string, opts: { keepUnread?: boolean }) => {
      try {
        const db = getDatabase();
        const fullId = resolvePartialId(db, "inbound_emails", id) ?? id;
        let email = getInboundEmail(fullId, db);
        if (!email) {
          console.error(chalk.red(`Email not found: ${id}`));
          process.exit(1);
        }
        // Opening an email marks it read (Gmail parity), unless --keep-unread.
        if (!opts.keepUnread && !email.is_read) email = setInboundRead(email.id, true, db);
        output(email, formatEmailDetail(email));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── READ-STATE / ARCHIVE / STAR / LABELS ─────────────────────────────────
  // Local state is authoritative and works for any inbound mail (SES-S3, SMTP,
  // Gmail). When the email belongs to a Gmail provider, the change is also
  // mirrored to Gmail (best-effort).

  async function gmailMirror(emailId: string, connectorArgs: string[]): Promise<boolean> {
    const db = getDatabase();
    const row = db.query(
      `SELECT i.message_id AS message_id, p.type AS provider_type
         FROM inbound_emails i LEFT JOIN providers p ON p.id = i.provider_id
        WHERE i.id = ?`,
    ).get(emailId) as { message_id: string | null; provider_type: string | null } | null;
    if (!row || row.provider_type !== "gmail" || !row.message_id) return false;
    const r = await runConnectorOperation({
      connector: "gmail",
      operation: connectorArgs.join("."),
      input: { args: [row.message_id] },
    });
    if (!r.success) throw new Error(r.stderr || r.stdout);
    return true;
  }

  function requireLocal(id: string): string {
    const db = getDatabase();
    const fullId = resolvePartialId(db, "inbound_emails", id) ?? id;
    const e = getInboundEmail(fullId, db);
    if (!e) { console.error(chalk.red(`Email not found: ${id}`)); process.exit(1); }
    return e.id;
  }

  inboxCmd
    .command("mark-read <emailId>")
    .description("Mark an inbound email as read (mirrors to Gmail when applicable)")
    .option("--unread", "Mark as unread instead")
    .action(async (emailId: string, opts: { unread?: boolean }) => {
      try {
        const id = requireLocal(emailId);
        const e = setInboundRead(id, !opts.unread, getDatabase());
        await gmailMirror(id, ["messages", opts.unread ? "mark-unread" : "mark-read"]).catch(() => false);
        output(e, chalk.green(`✓ Marked ${opts.unread ? "unread" : "read"}: ${e.subject.slice(0, 40)}`));
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("archive <emailId>")
    .description("Archive an inbound email (mirrors to Gmail when applicable)")
    .option("--undo", "Unarchive (restore to inbox) instead")
    .action(async (emailId: string, opts: { undo?: boolean }) => {
      try {
        const id = requireLocal(emailId);
        const e = setInboundArchived(id, !opts.undo, getDatabase());
        if (!opts.undo) await gmailMirror(id, ["messages", "archive"]).catch(() => false);
        output(e, chalk.green(`✓ ${opts.undo ? "Unarchived" : "Archived"}: ${e.subject.slice(0, 40)}`));
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("star <emailId>")
    .description("Star an inbound email (mirrors to Gmail when applicable)")
    .option("--undo", "Unstar instead")
    .action(async (emailId: string, opts: { undo?: boolean }) => {
      try {
        const id = requireLocal(emailId);
        const e = setInboundStarred(id, !opts.undo, getDatabase());
        if (!opts.undo) await gmailMirror(id, ["messages", "star"]).catch(() => false);
        output(e, chalk[opts.undo ? "green" : "yellow"](`${opts.undo ? "✓ Unstarred" : "★ Starred"}: ${e.subject.slice(0, 40)}`));
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("label <emailId> <label>")
    .description("Add (or with --remove, remove) a label on an inbound email")
    .option("--remove", "Remove the label instead of adding")
    .action((emailId: string, label: string, opts: { remove?: boolean }) => {
      try {
        const id = requireLocal(emailId);
        const e = opts.remove ? removeInboundLabel(id, label, getDatabase()) : addInboundLabel(id, label, getDatabase());
        output(e, chalk.green(`✓ ${opts.remove ? "Removed" : "Added"} label "${label}": ${e.label_ids.join(", ") || "(none)"}`));
      } catch (e) { handleError(e); }
    });

  // ─── REPLY ────────────────────────────────────────────────────────────────
  inboxCmd
    .command("reply <emailId>")
    .description("Reply to a synced inbound email via Gmail")
    .requiredOption("--body <text>", "Reply body text")
    .option("--html", "Send as HTML email")
    .action(async (emailId: string, opts: { body: string; html?: boolean }) => {
      try {
        const db = getDatabase();
        const email = db.query("SELECT message_id, subject FROM inbound_emails WHERE id = ?").get(emailId) as { message_id: string; subject: string } | null;
        if (!email?.message_id) {
          console.error(chalk.red("Email not found or has no Gmail message ID."));
          process.exit(1);
        }
        console.log(chalk.dim(`Replying to: ${email.subject}`));
        const r = await runConnectorOperation({
          connector: "gmail",
          operation: "messages.reply",
          input: { args: [email.message_id], body: opts.body, ...(opts.html ? { html: true } : {}) },
        });
        if (!r.success) { console.error(chalk.red(`Reply failed: ${r.stderr}`)); process.exit(1); }
        console.log(chalk.green("✓ Reply sent"));
        output({}, "");
      } catch (e) { handleError(e); }
    });

  // ─── ATTACHMENT ───────────────────────────────────────────────────────────
  inboxCmd
    .command("attachment <emailId>")
    .description("Show downloaded attachment paths for a synced email")
    .option("--filename <name>", "Filter by filename")
    .action((emailId: string, opts: { filename?: string }) => {
      try {
        const db = getDatabase();
        const row = db.query("SELECT attachment_paths FROM inbound_emails WHERE id = ?").get(emailId) as { attachment_paths: string } | null;
        if (!row) {
          console.error(chalk.red(`Email not found: ${emailId}`));
          process.exit(1);
        }
        type AttPath = { filename: string; content_type: string; size: number; local_path?: string; s3_url?: string };
        const paths = JSON.parse(row.attachment_paths ?? "[]") as AttPath[];
        const filtered = opts.filename ? paths.filter((p) => p.filename === opts.filename) : paths;
        if (filtered.length === 0) {
          console.log(chalk.dim("No attachments found for this email."));
          return;
        }
        console.log(chalk.bold(`\nAttachments for ${emailId.slice(0, 8)}:`));
        for (const p of filtered) {
          const loc = p.local_path ? chalk.cyan(p.local_path) : p.s3_url ? chalk.blue(p.s3_url) : chalk.dim("(not downloaded)");
          console.log(`  ${p.filename.padEnd(40)} ${chalk.dim(p.content_type)}  ${loc}`);
        }
        console.log();
        output(filtered, "");
      } catch (e) {
        handleError(e);
      }
    });

  // ─── DELETE ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("delete <id>")
    .description("Delete a synced email from local DB (does not affect Gmail)")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        await confirmDestructiveAction(`Delete local inbox email ${id}?`, opts.yes);
        const db = getDatabase();
        const deleted = deleteInboundEmail(id, db);
        if (deleted) {
          console.log(chalk.green(`✓ Deleted email ${id.slice(0, 8)}`));
        } else {
          console.error(chalk.red(`Email not found: ${id}`));
          process.exit(1);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ─── CLEAR ────────────────────────────────────────────────────────────────
  inboxCmd
    .command("clear")
    .description("Clear all synced emails from local DB (does not affect Gmail)")
    .option("--provider <id>", "Only clear emails for this provider")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { provider?: string; yes?: boolean }) => {
      try {
        const target = opts.provider ? `for provider ${opts.provider}` : "for all providers";
        await confirmDestructiveAction(`Clear local inbox emails ${target}?`, opts.yes);
        const db = getDatabase();
        const deleted = clearInboundEmails(opts.provider, db);
        console.log(chalk.green(`✓ Cleared ${deleted} email(s)`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── SYNC S3 ──────────────────────────────────────────────────────────────
  inboxCmd
    .command("sync-s3")
    .description("Sync inbound emails from S3 bucket (stored by SES receipt rules). Defaults --bucket/--region to config inbound_s3_bucket/region.")
    .option("--bucket <name>", "S3 bucket name (defaults to config inbound_s3_bucket)")
    .option("--prefix <prefix>", "S3 key prefix to scan (e.g. inbound/example.com/)")
    .option("--region <region>", "AWS region (defaults to config inbound_s3_region or us-east-1)")
    .option("--provider <id>", "Associate emails with this provider ID")
    .option("--limit <n>", "Max emails per run", "100")
    .option("--profile <profile>", "AWS profile")
    .action(async (opts: { bucket?: string; prefix?: string; region?: string; provider?: string; limit: string; profile?: string }) => {
      try {
        const { getInboundConfig } = await import("../../lib/config.js");
        const inbound = getInboundConfig();
        const profile = opts.profile ?? inbound.profile;
        if (profile) process.env["AWS_PROFILE"] = profile;
        const bucket = opts.bucket ?? inbound.bucket;
        const region = opts.region ?? inbound.region;
        const prefix = opts.prefix ?? inbound.prefix;
        if (!bucket) { handleError(new Error("No S3 bucket: pass --bucket or set 'emails config set inbound_s3_bucket <name>'")); return; }
        const { syncS3Inbox } = await import("../../lib/s3-sync.js");
        console.log(chalk.dim(`Syncing emails from s3://${bucket}/${prefix ?? ""}...`));
        const result = await syncS3Inbox({
          bucket,
          prefix,
          region,
          providerId: opts.provider,
          limit: parseInt(opts.limit, 10),
        });
        const lines = [chalk.bold("\nS3 sync complete:")];
        lines.push(`  Synced:      ${chalk.green(String(result.synced))}`);
        lines.push(`  Skipped:     ${chalk.dim(String(result.skipped))} (already stored)`);
        if ((result.attachments_saved ?? 0) > 0) lines.push(`  Attachments: ${chalk.cyan(String(result.attachments_saved))}`);
        if (result.errors.length > 0) lines.push(`  Errors:      ${chalk.red(String(result.errors.length))}`);
        if (result.last_key) lines.push(chalk.dim(`  Last key:    ${result.last_key}`));
        lines.push("");
        output(result, lines.join("\n"));
        if (result.errors.length > 0) {
          for (const e of result.errors) console.log(chalk.yellow(`  ${e}`));
        }
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("archive-verify")
    .description("Verify a Gmail message archive in S3")
    .requiredOption("--bucket <name>", "Archive bucket name", DEFAULT_GMAIL_ARCHIVE_BUCKET)
    .requiredOption("--profile <profile>", "Gmail connector profile")
    .requiredOption("--message-id <id>", "Gmail message ID")
    .option("--prefix <prefix>", "Archive prefix", "gmail")
    .option("--region <region>", "AWS region", "us-west-2")
    .option("--aws-profile <profile>", "AWS profile")
    .option("--attachment <filename...>", "Expected attachment filename(s)")
    .option("--no-raw", "Do not require the raw MIME object")
    .action(async (opts: {
      bucket: string;
      profile: string;
      messageId: string;
      prefix: string;
      region: string;
      awsProfile?: string;
      attachment?: string[];
      raw: boolean;
    }) => {
      try {
        if (opts.awsProfile) process.env["AWS_PROFILE"] = opts.awsProfile;
        const { verifyGmailArchive } = await import("../../lib/gmail-archive.js");
        const result = await verifyGmailArchive({
          bucket: opts.bucket,
          profile: opts.profile,
          messageId: opts.messageId,
          prefix: opts.prefix,
          region: opts.region,
          expectedAttachments: opts.attachment ?? [],
          requireRaw: opts.raw !== false,
        });
        output(result, formatArchiveVerifyResult(result));
        if (!result.ok) process.exitCode = 1;
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("archive-migrate")
    .description(`Copy a legacy Gmail-to-S3 bucket/prefix into ${DEFAULT_GMAIL_ARCHIVE_BUCKET}`)
    .requiredOption("--source-bucket <name>", "Legacy source bucket, e.g. hasna-mail-maximstaris")
    .option("--target-bucket <name>", "Target archive bucket", DEFAULT_GMAIL_ARCHIVE_BUCKET)
    .option("--source-prefix <prefix>", "Source key prefix", "")
    .option("--target-prefix <prefix>", "Target key prefix", "legacy/maximstaris")
    .option("--region <region>", "AWS region", "us-east-1")
    .option("--target-region <region>", "Target AWS region", "us-west-2")
    .option("--aws-profile <profile>", "AWS profile")
    .option("--source-aws-profile <profile>", "AWS profile for reading the source bucket")
    .option("--target-aws-profile <profile>", "AWS profile for writing the target bucket")
    .option("--limit <n>", "Maximum objects to scan in this run")
    .option("--dry-run", "Plan copies without writing to target")
    .action(async (opts: {
      sourceBucket: string;
      targetBucket: string;
      sourcePrefix?: string;
      targetPrefix?: string;
      region: string;
      targetRegion?: string;
      awsProfile?: string;
      sourceAwsProfile?: string;
      targetAwsProfile?: string;
      limit?: string;
      dryRun?: boolean;
    }) => {
      try {
        if (opts.awsProfile) process.env["AWS_PROFILE"] = opts.awsProfile;
        const { migrateS3Prefix } = await import("../../lib/gmail-archive.js");
        const sourceProfile = opts.sourceAwsProfile ?? opts.awsProfile;
        const targetProfile = opts.targetAwsProfile ?? opts.awsProfile;
        const sourceClient = sourceProfile
          ? new S3Client({ region: opts.region, credentials: fromIni({ profile: sourceProfile }) })
          : undefined;
        const targetClient = targetProfile
          ? new S3Client({ region: opts.targetRegion ?? opts.region, credentials: fromIni({ profile: targetProfile }) })
          : undefined;
        const result = await migrateS3Prefix({
          sourceBucket: opts.sourceBucket,
          targetBucket: opts.targetBucket,
          sourcePrefix: opts.sourcePrefix,
          targetPrefix: opts.targetPrefix,
          region: opts.region,
          sourceClient,
          targetClient,
          limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
          dryRun: opts.dryRun,
        });
        output(result, formatArchiveMigrationResult(result));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── LISTEN (SMTP) ────────────────────────────────────────────────────────
  inboxCmd
    .command("listen")
    .description("Start a local SMTP listener to receive inbound emails (dev/testing)")
    .option("--port <port>", "SMTP port to listen on", "2525")
    .option("--provider <id>", "Associate received emails with this provider ID")
    .action(async (opts: { port?: string; provider?: string }) => {
      try {
        const port = parseInt(opts.port ?? "2525", 10);
        const { resolveId } = await import("../utils.js");
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const { createSmtpServer } = await import("../../lib/inbound.js");
        console.log(chalk.green(`✓ SMTP listener started on port ${port}`));
        if (providerId) console.log(chalk.dim(`  Provider: ${providerId}`));
        console.log(chalk.dim("  Press Ctrl+C to stop\n"));
        createSmtpServer(port, providerId);
        process.stdin.resume();
      } catch (e) { handleError(e); }
    });

  // ─── OPEN HTML ────────────────────────────────────────────────────────────
  inboxCmd
    .command("open <id>")
    .description("Open HTML body of a synced email in the browser")
    .action(async (id: string) => {
      try {
        const db = getDatabase();
        const { resolvePartialId } = await import("../../db/database.js");
        const resolvedId = resolvePartialId(db, "inbound_emails", id);
        if (!resolvedId) { console.error(chalk.red(`Email not found: ${id}`)); process.exit(1); }
        const email = db.query("SELECT html_body, text_body FROM inbound_emails WHERE id = ?").get(resolvedId) as { html_body: string | null; text_body: string | null } | null;
        if (!email) { console.error(chalk.red(`Email not found: ${id}`)); process.exit(1); }
        const body = email.html_body ?? email.text_body;
        if (!body) { console.error(chalk.red("This email has no body content.")); process.exit(1); }
        const { writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join: pathJoin } = await import("node:path");
        const { execSync } = await import("node:child_process");
        const tmpFile = pathJoin(tmpdir(), `inbox-${resolvedId.slice(0, 8)}.html`);
        writeFileSync(tmpFile, body);
        execSync(`open "${tmpFile}" 2>/dev/null || xdg-open "${tmpFile}" 2>/dev/null || echo "File saved: ${tmpFile}"`);
        console.log(chalk.green(`✓ Opened: ${tmpFile}`));
      } catch (e) { handleError(e); }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureGmailProviderForProfile(profile: string): string {
  const db = getDatabase();
  const providerName = `Gmail (${profile})`;
  const existing = listProviders(db).find((p) => p.type === "gmail" && p.name === providerName);
  if (existing) return existing.id;
  return createProvider({ name: providerName, type: "gmail" }, db).id;
}

function resolveGmailProvider(idOrName?: string): string | null {
  const db = getDatabase();
  const providers = listProviders(db).filter((p) => p.type === "gmail" && p.active);

  if (!idOrName) return providers[0]?.id ?? null;

  const match = providers.find(
    (p) => p.id === idOrName || p.id.startsWith(idOrName) || p.name === idOrName,
  );
  return match?.id ?? null;
}

function formatSyncResult(
  result: { synced: number; skipped: number; attachments_saved?: number; errors: string[]; done: boolean },
  all?: boolean,
): string {
  const lines: string[] = [chalk.bold("\nSync complete:")];
  lines.push(`  Synced:      ${chalk.green(String(result.synced))}`);
  lines.push(`  Skipped:     ${result.skipped > 0 ? chalk.dim(String(result.skipped)) : "0"} (already in DB)`);
  if ((result.attachments_saved ?? 0) > 0) lines.push(`  Attachments: ${chalk.cyan(String(result.attachments_saved))} files saved`);
  if (result.errors.length > 0) lines.push(`  Errors:      ${chalk.red(String(result.errors.length))}`);
  if (!result.done && !all) lines.push(chalk.dim("  More pages available. Use --all to sync everything."));
  lines.push("");
  return lines.join("\n");
}

function formatEmailList(
  emails: { id: string; from_address: string; subject: string; received_at: string; text_body?: string | null; is_read?: boolean; is_starred?: boolean; label_ids?: string[] }[],
  title = "Inbound Emails",
): string {
  const lines: string[] = [chalk.bold(`\n${title} (${emails.length}):`)];
  for (const e of emails) {
    const date = new Date(e.received_at).toLocaleDateString();
    const star = e.is_starred ? chalk.yellow("★") : " ";
    const unread = e.is_read === false ? chalk.cyan("●") : " ";
    const subj = e.is_read === false ? chalk.bold(e.subject.slice(0, 50).padEnd(50)) : e.subject.slice(0, 50).padEnd(50);
    const labels = e.label_ids && e.label_ids.length ? chalk.magenta(` {${e.label_ids.join(",")}}`) : "";
    lines.push(
      `  ${star}${unread} ${chalk.dim(e.id.slice(0, 8))}  ${chalk.cyan(e.from_address.slice(0, 28).padEnd(28))}  ${subj}  ${chalk.dim(date)}${labels}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatRemoteResults(
  results: { id: string; from: string; subject: string; date: string }[],
  query: string,
): string {
  const lines: string[] = [chalk.bold(`\nGmail search: "${query}" (${results.length} results):`)];
  for (const r of results) {
    lines.push(
      `  ${chalk.dim(r.id.slice(0, 16))}  ${chalk.cyan(r.from.slice(0, 28).padEnd(28))}  ${r.subject.slice(0, 50)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatArchiveVerifyResult(result: { ok: boolean; checked: string[]; missing: string[]; bucket: string; profile: string; messageId: string }): string {
  const lines = [chalk.bold("\nArchive verification:")];
  lines.push(`  Bucket:  ${chalk.cyan(result.bucket)}`);
  lines.push(`  Profile: ${chalk.cyan(result.profile)}`);
  lines.push(`  Message: ${chalk.cyan(result.messageId)}`);
  lines.push(`  Status:  ${result.ok ? chalk.green("ok") : chalk.red("missing objects")}`);
  lines.push(`  Checked: ${String(result.checked.length)}`);
  if (result.missing.length > 0) {
    lines.push("  Missing:");
    for (const key of result.missing) lines.push(`    ${chalk.red(key)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatArchiveMigrationResult(result: { scanned: number; copied: number; dryRun: boolean; objects: Array<{ source: string; target: string }>; nextContinuationToken?: string }): string {
  const lines = [chalk.bold("\nArchive migration:")];
  lines.push(`  Mode:    ${result.dryRun ? chalk.yellow("dry run") : chalk.green("copy")}`);
  lines.push(`  Scanned: ${String(result.scanned)}`);
  lines.push(`  Copied:  ${String(result.copied)}`);
  for (const obj of result.objects.slice(0, 10)) lines.push(`  ${chalk.dim(obj.source)} -> ${chalk.cyan(obj.target)}`);
  if (result.objects.length > 10) lines.push(chalk.dim(`  ... ${result.objects.length - 10} more`));
  if (result.nextContinuationToken) lines.push(chalk.dim("  More objects are available; rerun with a larger limit or continuation support."));
  lines.push("");
  return lines.join("\n");
}

function formatEmailDetail(
  email: { id: string; from_address: string; subject: string; received_at: string; text_body?: string | null; to_addresses: string[]; cc_addresses: string[]; is_read?: boolean; is_starred?: boolean; is_archived?: boolean; label_ids?: string[] },
): string {
  const flags = [
    email.is_read === false ? "unread" : "read",
    email.is_starred ? "starred" : null,
    email.is_archived ? "archived" : null,
    ...(email.label_ids ?? []),
  ].filter(Boolean).join(", ");
  const lines: string[] = [
    chalk.bold(`\n  Subject: ${email.subject}`),
    `  From:    ${chalk.cyan(email.from_address)}`,
    `  To:      ${email.to_addresses.join(", ")}`,
    email.cc_addresses.length > 0 ? `  CC:      ${email.cc_addresses.join(", ")}` : "",
    `  Date:    ${email.received_at}`,
    `  Flags:   ${flags}`,
    `  ID:      ${chalk.dim(email.id)}`,
    "",
    email.text_body ?? chalk.dim("(no body)"),
    "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
