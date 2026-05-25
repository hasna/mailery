import type { Command } from "commander";
import chalk from "chalk";
import { runConnectorOperation } from "@hasna/connectors";
import { syncGmailInbox, syncGmailInboxAll, listGmailConnectorProfiles, listGmailLabels } from "../../lib/gmail-sync.js";
import { listInboundEmails, getInboundEmail, deleteInboundEmail, clearInboundEmails, getInboundCount } from "../../db/inbound.js";
import { getGmailSyncState, updateLastSynced } from "../../db/gmail-sync-state.js";
import { createProvider, listProviders } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { confirmDestructiveAction, handleError } from "../utils.js";

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
    .option("--since <date>", "Only sync messages after this date (ISO 8601 or YYYY-MM-DD)")
    .option("--all", "Sync all pages until done (use for initial backfill)")
    .option("--archive-s3 [bucket]", "Archive raw MIME and metadata to S3 bucket (default: prod-emails)")
    .option("--no-attachments", "Skip attachment download")
    .action(async (opts: {
      provider?: string;
      profile?: string;
      allProfiles?: boolean;
      label?: string;
      query?: string;
      limit?: string;
      since?: string;
      all?: boolean;
      archiveS3?: boolean | string;
      attachments: boolean;
    }) => {
      try {
        const db = getDatabase();
        const archiveBucket = opts.archiveS3
          ? (typeof opts.archiveS3 === "string" ? opts.archiveS3 : "prod-emails")
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
              since: opts.since,
              archiveS3Bucket: archiveBucket,
              downloadAttachments: opts.attachments !== false,
              db,
            };
            const page = opts.all
              ? await syncGmailInboxAll(syncOptions)
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
    .action((opts: { provider?: string; since?: string; limit?: string; offset?: string; search?: string }) => {
      try {
        const db = getDatabase();
        const limit = parseInt(opts.limit ?? "20", 10);
        const offset = parseInt(opts.offset ?? "0", 10);
        let emails = listInboundEmails({ provider_id: opts.provider, since: opts.since, limit, offset }, db);

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
          console.log(`\n  ${chalk.cyan(p.name)} ${chalk.dim(`[${p.id.slice(0, 8)}]`)}`);
          console.log(`    Synced emails:  ${count}`);
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
    .description("Read a synced email from local DB")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const email = getInboundEmail(id, db);
        if (!email) {
          console.error(chalk.red(`Email not found: ${id}`));
          process.exit(1);
        }
        output(email, formatEmailDetail(email));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── GMAIL ACTIONS ────────────────────────────────────────────────────────

  async function gmailAction(emailId: string, connectorArgs: string[], label: string) {
    const db = getDatabase();
    const row = db.query("SELECT message_id FROM inbound_emails WHERE id = ?").get(emailId) as { message_id: string } | null;
    if (!row?.message_id) throw new Error(`No Gmail message ID for email ${emailId}`);
    const r = await runConnectorOperation({
      connector: "gmail",
      operation: connectorArgs.join("."),
      input: { args: [row.message_id] },
    });
    if (!r.success) throw new Error(r.stderr || r.stdout);
    console.log(chalk.green(`✓ ${label}: ${emailId.slice(0, 8)}`));
  }

  inboxCmd
    .command("mark-read <emailId>")
    .description("Mark a Gmail message as read")
    .action(async (emailId: string) => {
      try { await gmailAction(emailId, ["messages", "mark-read"], "Marked as read"); }
      catch (e) { handleError(e); }
    });

  inboxCmd
    .command("archive <emailId>")
    .description("Archive a Gmail message (remove from INBOX)")
    .action(async (emailId: string) => {
      try { await gmailAction(emailId, ["messages", "archive"], "Archived"); }
      catch (e) { handleError(e); }
    });

  inboxCmd
    .command("star <emailId>")
    .description("Star a Gmail message")
    .action(async (emailId: string) => {
      try { await gmailAction(emailId, ["messages", "star"], "Starred"); }
      catch (e) { handleError(e); }
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
    .description("Sync inbound emails from S3 bucket (stored by SES receipt rules)")
    .requiredOption("--bucket <name>", "S3 bucket name")
    .option("--prefix <prefix>", "S3 key prefix to scan (e.g. inbound/example.com/)")
    .option("--region <region>", "AWS region", "us-east-1")
    .option("--provider <id>", "Associate emails with this provider ID")
    .option("--limit <n>", "Max emails per run", "100")
    .option("--profile <profile>", "AWS profile")
    .action(async (opts: { bucket: string; prefix?: string; region: string; provider?: string; limit: string; profile?: string }) => {
      try {
        if (opts.profile) process.env["AWS_PROFILE"] = opts.profile;
        const { syncS3Inbox } = await import("../../lib/s3-sync.js");
        console.log(chalk.dim(`Syncing emails from s3://${opts.bucket}/${opts.prefix ?? ""}...`));
        const result = await syncS3Inbox({
          bucket: opts.bucket,
          prefix: opts.prefix,
          region: opts.region,
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
  emails: { id: string; from_address: string; subject: string; received_at: string; text_body?: string | null }[],
  title = "Inbound Emails",
): string {
  const lines: string[] = [chalk.bold(`\n${title} (${emails.length}):`)];
  for (const e of emails) {
    const date = new Date(e.received_at).toLocaleDateString();
    lines.push(
      `  ${chalk.dim(e.id.slice(0, 8))}  ${chalk.cyan(e.from_address.slice(0, 28).padEnd(28))}  ${e.subject.slice(0, 50).padEnd(50)}  ${chalk.dim(date)}`,
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

function formatEmailDetail(
  email: { id: string; from_address: string; subject: string; received_at: string; text_body?: string | null; to_addresses: string[]; cc_addresses: string[] },
): string {
  const lines: string[] = [
    chalk.bold(`\n  Subject: ${email.subject}`),
    `  From:    ${chalk.cyan(email.from_address)}`,
    `  To:      ${email.to_addresses.join(", ")}`,
    email.cc_addresses.length > 0 ? `  CC:      ${email.cc_addresses.join(", ")}` : "",
    `  Date:    ${email.received_at}`,
    `  ID:      ${chalk.dim(email.id)}`,
    "",
    email.text_body ?? chalk.dim("(no body)"),
    "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
