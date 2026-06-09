import type { Command } from "commander";
import type { EmailSystemStatus } from "../../lib/agent-context.js";
import chalk from "../../lib/chalk-lite.js";
import {
  listInboundEmailSummaries, getInboundEmail, getInboundEmailSummary, deleteInboundEmail, clearInboundEmails,
  getReceivedInboundCount, getLatestReceivedInboundAt,
  getInboundAttachmentPaths,
  setInboundRead, setInboundReadSummary, setInboundArchivedSummary, setInboundStarredSummary,
  addInboundLabelSummary, removeInboundLabelSummary, getUnreadCount, normalizeEmailAddress,
} from "../../db/inbound.js";
import { updateLastSynced } from "../../db/gmail-sync-state.js";
import { createProvider, getProviderByNameAndType, listActiveProviderSummaries, listProviderNamesByIds } from "../../db/providers.js";
import { getDatabase, resolvePartialIdOrThrow } from "../../db/database.js";
import { confirmDestructiveAction, handleError } from "../utils.js";
import { findVerificationCode, listVerificationCodeCandidates } from "../../lib/verification-code.js";
import { enrichAddresses } from "../../lib/address-ownership.js";
import { resolveAlias } from "../../db/aliases.js";
import { findAddressesByEmail } from "../../db/addresses.js";
import { findDomainsByName } from "../../db/domains.js";
import { listAddressProvisioningByIds, listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../../db/provisioning.js";
import { sqlEmailAddress } from "../../db/email-address-sql.js";
import { assessDomainReadiness } from "../../lib/domain-readiness.js";

const MAX_INBOX_CLI_LIMIT = 1000;
const MAX_GMAIL_SYNC_CONCURRENCY = 64;
const MAX_ARCHIVE_MIGRATE_LIMIT = 10_000;

function resolveInboundEmailId(id: string): string {
  return resolvePartialIdOrThrow(getDatabase(), "inbound_emails", id);
}

function parsePositiveIntOption(value: string | undefined, fallback: number, max = MAX_INBOX_CLI_LIMIT): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, parsed);
}

function parseNonNegativeIntOption(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

async function runAutoPull(opts: { s3?: boolean; gmail?: boolean; limit?: number }) {
  const { autoPull } = await import("../tui/autopull.js");
  return autoPull(opts);
}

interface CodeOptions {
  from?: string;
  subject?: string;
  limit?: string;
  refresh?: boolean;
  gmail?: boolean;
  watch?: boolean;
  wait?: boolean;
  timeout?: string;
  interval?: string;
  since?: string;
}

export function registerInboxCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const inboxCmd = program.command("inbox").description("Sync and browse inbound emails (Gmail, SMTP, S3)");

  async function runCodeCommand(address: string, opts: CodeOptions): Promise<void> {
    const normalized = address.trim().toLowerCase();
    const limit = parsePositiveIntOption(opts.limit, 50);
    const watching = opts.watch || opts.wait;
    const timeoutMs = Math.max(1, parseInt(opts.timeout ?? "120", 10) || 120) * 1000;
    const intervalMs = Math.max(1, parseInt(opts.interval ?? "5", 10) || 5) * 1000;
    const deadline = Date.now() + timeoutMs;

    const findLocalMatch = () => {
      const candidates = listVerificationCodeCandidates(normalized, {
        limit,
        since: opts.since,
        from: opts.from,
        subject: opts.subject,
      }, getDatabase());
      return findVerificationCode(candidates, { from: opts.from, subject: opts.subject });
    };

    while (true) {
      let match = findLocalMatch();
      if (match) {
        output({
          code: match.code,
          email_id: match.email.id,
          from: match.email.from_address,
          subject: match.email.subject,
          received_at: match.email.received_at,
          confidence: match.confidence,
        }, match.code);
        return;
      }

      if (opts.refresh !== false) {
        await runAutoPull({ s3: true, gmail: opts.gmail === true, limit: Math.max(limit, 1000) });
        match = findLocalMatch();
        if (match) {
          output({
            code: match.code,
            email_id: match.email.id,
            from: match.email.from_address,
            subject: match.email.subject,
            received_at: match.email.received_at,
            confidence: match.confidence,
          }, match.code);
          return;
        }
      }

      if (!watching || Date.now() >= deadline) {
        output({ code: null, address: normalized }, chalk.dim(`No verification code found for ${normalized}.`));
        process.exitCode = 1;
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  inboxCmd
    .command("code <address>")
    .description("Refresh inbound mail and print the latest verification code for an address")
    .option("--from <text>", "Only consider messages whose From contains this text")
    .option("--subject <text>", "Only consider messages whose subject contains this text")
    .option("--limit <n>", "Messages to inspect per mailbox state", "50")
    .option("--no-refresh", "Do not refresh inbound mail before searching")
    .option("--gmail", "Also pull Gmail while refreshing")
    .option("--watch", "Keep refreshing until a code arrives or timeout is reached")
    .option("--wait", "Alias for --watch")
    .option("--since <date>", "Only consider mail received after this ISO date")
    .option("--timeout <sec>", "Watch timeout in seconds", "120")
    .option("--interval <sec>", "Watch polling interval in seconds", "5")
    .action(runCodeCommand);

  inboxCmd
    .command("wait-code <address>")
    .description("Wait for a verification code for an inbound address")
    .option("--from <text>", "Only consider messages whose From contains this text")
    .option("--subject <text>", "Only consider messages whose subject contains this text")
    .option("--limit <n>", "Messages to inspect per mailbox state", "50")
    .option("--no-refresh", "Do not refresh inbound mail before searching")
    .option("--gmail", "Also pull Gmail while refreshing")
    .option("--since <date>", "Only consider mail received after this ISO date")
    .option("--timeout <sec>", "Wait timeout in seconds", "120")
    .option("--interval <sec>", "Polling interval in seconds", "5")
    .action((address: string, opts: CodeOptions) => runCodeCommand(address, { ...opts, wait: true }));

  program
    .command("code <address>")
    .description("Find the latest verification code for an inbound address (alias: emails inbox code)")
    .option("--from <text>", "Only consider messages whose From contains this text")
    .option("--subject <text>", "Only consider messages whose subject contains this text")
    .option("--limit <n>", "Messages to inspect per mailbox state", "50")
    .option("--no-refresh", "Do not refresh inbound mail before searching")
    .option("--gmail", "Also pull Gmail while refreshing")
    .option("--watch", "Keep refreshing until a code arrives or timeout is reached")
    .option("--wait", "Alias for --watch")
    .option("--since <date>", "Only consider mail received after this ISO date")
    .option("--timeout <sec>", "Watch timeout in seconds", "120")
    .option("--interval <sec>", "Watch polling interval in seconds", "5")
    .action(runCodeCommand);

  async function waitForLatestEmail(address: string, opts: {
    from?: string;
    subject?: string;
    limit?: string;
    refresh?: boolean;
    gmail?: boolean;
    timeout?: string;
    interval?: string;
    since?: string;
  }): Promise<void> {
    const normalized = address.trim().toLowerCase();
    const limit = parsePositiveIntOption(opts.limit, 50);
    const timeoutMs = Math.max(1, parseInt(opts.timeout ?? "120", 10) || 120) * 1000;
    const intervalMs = Math.max(1, parseInt(opts.interval ?? "5", 10) || 5) * 1000;
    const deadline = Date.now() + timeoutMs;

    const findLocalEmail = () => {
      const db = getDatabase();
      const summary = listInboundEmailSummaries({
        recipients: [normalized],
        limit: 1,
        since: opts.since,
        from: opts.from,
        subject: opts.subject,
      }, db)[0];
      return summary ? getInboundEmail(summary.id, db) : null;
    };

    while (true) {
      let email = findLocalEmail();
      if (email) {
        output(email, email.id);
        return;
      }

      if (opts.refresh !== false) {
        await runAutoPull({ s3: true, gmail: opts.gmail === true, limit: Math.max(limit, 1000) });
        email = findLocalEmail();
        if (email) {
          output(email, email.id);
          return;
        }
      }
      if (Date.now() >= deadline) {
        output({ email: null, address: normalized }, chalk.dim(`No email found for ${normalized}.`));
        process.exitCode = 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  inboxCmd
    .command("wait <address>")
    .description("Wait for the next inbound email for an address")
    .option("--from <text>", "Only consider messages whose From contains this text")
    .option("--subject <text>", "Only consider messages whose subject contains this text")
    .option("--limit <n>", "Messages to inspect", "50")
    .option("--no-refresh", "Do not refresh inbound mail before searching")
    .option("--gmail", "Also pull Gmail while refreshing")
    .option("--since <date>", "Only consider mail received after this ISO date")
    .option("--timeout <sec>", "Wait timeout in seconds", "120")
    .option("--interval <sec>", "Polling interval in seconds", "5")
    .action(waitForLatestEmail);

  inboxCmd
    .command("latest <address>")
    .description("Print the latest local inbound email for an address")
    .option("--from <text>", "Only consider messages whose From contains this text")
    .option("--subject <text>", "Only consider messages whose subject contains this text")
    .option("--limit <n>", "Messages to inspect", "50")
    .option("--refresh", "Refresh inbound mail before searching")
    .option("--gmail", "Also pull Gmail while refreshing")
    .option("--since <date>", "Only consider mail received after this ISO date")
    .action(async (address: string, opts: { from?: string; subject?: string; limit?: string; refresh?: boolean; gmail?: boolean; since?: string }) => {
      try {
        const normalized = address.trim().toLowerCase();
        if (opts.refresh) await runAutoPull({ s3: true, gmail: opts.gmail === true, limit: Math.max(1000, parsePositiveIntOption(opts.limit, 50)) });
        const db = getDatabase();
        const summary = listInboundEmailSummaries({
          recipients: [normalized],
          limit: 1,
          since: opts.since,
          from: opts.from,
          subject: opts.subject,
        }, db)[0];
        const email = summary ? getInboundEmail(summary.id, db) : null;
        if (!email) {
          output({ email: null, address: normalized }, chalk.dim(`No email found for ${normalized}.`));
          process.exitCode = 1;
          return;
        }
        output(email, formatEmailDetail(email));
      } catch (e) { handleError(e); }
    });

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
    .option("--archive-s3 [bucket]", "Archive raw MIME and metadata to S3 bucket (default: configured Gmail archive bucket)")
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
        const { syncGmailInbox, syncGmailInboxAll, syncGmailInboxHistory, listGmailConnectorProfiles } = await import("../../lib/gmail-sync.js");
        const db = getDatabase();
        const batchSize = parsePositiveIntOption(opts.limit, 50);
        const messageConcurrency = parsePositiveIntOption(opts.concurrency, 1, MAX_GMAIL_SYNC_CONCURRENCY);
        const archiveBucket = opts.archiveS3
          ? typeof opts.archiveS3 === "string"
            ? opts.archiveS3
            : (await import("../../lib/config.js")).getDefaultGmailArchiveS3Bucket()
          : undefined;

        if (opts.allProfiles) {
          const discovered = await listGmailConnectorProfiles();
          if (discovered.length === 0) {
            console.error(chalk.red("No Gmail connector profiles found."));
            process.exit(1);
          }
          // The generic "default" connector profile is an alias of a named
          // account (same mailbox) — syncing it duplicates every email. Skip it
          // when named profiles exist so we don't re-create "Gmail (default)".
          const named = discovered.filter((p) => p.toLowerCase() !== "default");
          const profiles = named.length > 0 ? named : discovered;
          if (profiles.length < discovered.length) {
            console.log(chalk.dim(`Skipping the generic "default" profile (duplicate of a named account).`));
          }

          const aggregate = { synced: 0, skipped: 0, attachments_saved: 0, errors: [] as string[], done: true };
          for (const profile of profiles) {
            const providerId = ensureGmailProviderForProfile(profile);
            const syncOptions = {
              providerId,
              profile,
              labelFilter: opts.label,
              query: opts.query,
              batchSize,
              messageConcurrency,
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
          batchSize,
          messageConcurrency,
          since: opts.since,
          archiveS3Bucket: archiveBucket,
          downloadAttachments: opts.attachments !== false,
          db,
        };

        console.log(chalk.dim(`Syncing Gmail inbox for provider ${providerId}...`));

        let result;
        if (opts.all) {
          // Paginate manually so we can print progress per page
          const aggregate = { synced: 0, skipped: 0, attachments_saved: 0, errors: [] as string[], done: true };
          let pageToken: string | undefined;
          let page = 0;
          do {
            page++;
            const pageResult = await syncGmailInbox({ ...syncOpts, pageToken });
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
    .option("--search <query>", "Filter by subject/from/to/body (local, not Gmail API)")
    .option("--to <addr-or-domain>", "Only mail addressed to this address or domain (e.g. el@elyratelier.com or elyratelier.com)")
    .option("--unread", "Only unread mail")
    .option("--read", "Only read mail")
    .option("--starred", "Only starred mail")
    .option("--archived", "Show archived mail (hidden by default)")
    .option("--label <label>", "Only mail carrying this label")
    .action((opts: { provider?: string; since?: string; limit?: string; offset?: string; search?: string; to?: string; unread?: boolean; read?: boolean; starred?: boolean; archived?: boolean; label?: string }) => {
      try {
        const db = getDatabase();
        const limit = parsePositiveIntOption(opts.limit, 20);
        const offset = parseNonNegativeIntOption(opts.offset);
        const toFilter = opts.to?.trim().toLowerCase();
        const emails = listInboundEmailSummaries({
          provider_id: opts.provider, since: opts.since, limit, offset,
          unread: opts.unread, read: opts.read, starred: opts.starred,
          archived: opts.archived, label: opts.label, search: opts.search,
          recipients: toFilter?.includes("@") ? [toFilter] : undefined,
          recipientDomains: toFilter && !toFilter.includes("@") ? [toFilter] : undefined,
        }, db);

        if (emails.length === 0) {
          output([], chalk.dim("No emails found locally. Try `emails inbox sync-status`, `emails refresh`, or `emails inbox wait <address>`."));
          return;
        }

        output(emails, formatEmailList(emails));
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("unread-count")
    .description("Show unread inbox counts")
    .option("--by-address", "Group unread counts by recipient address")
    .option("--limit <n>", "Maximum grouped addresses to show", "50")
    .option("--offset <n>", "Number of grouped addresses to skip", "0")
    .action((opts: { byAddress?: boolean; limit?: string; offset?: string }) => {
      try {
        const db = getDatabase();
        if (!opts.byAddress) {
          const count = getUnreadCount(undefined, db);
          output({ unread: count }, String(count));
          return;
        }
        const limit = parsePositiveIntOption(opts.limit, 50);
        const offset = parseNonNegativeIntOption(opts.offset);
        const recipientSql = sqlEmailAddress("r.address");
        const rows = db.query(
          `SELECT address, unread
             FROM (
               SELECT ${recipientSql} AS address, COUNT(*) AS unread
                 FROM inbound_emails e
                 JOIN inbound_recipients r ON r.inbound_email_id = e.id
                WHERE e.is_sent = 0
                  AND e.is_read = 0
                  AND e.is_archived = 0
                GROUP BY ${recipientSql}
             )
            WHERE instr(address, '@') > 1
            ORDER BY unread DESC, address ASC
            LIMIT ? OFFSET ?`,
        ).all(limit, offset) as Array<{ address: string; unread: unknown }>;
        const outputRows = rows
          .map((row) => ({ address: row.address, unread: Number(row.unread) || 0 }))
          .filter((row) => row.unread > 0);
        const formatted = outputRows.length
          ? outputRows.map((row) => `${row.address}\t${row.unread}`).join("\n")
          : chalk.dim("No unread mail.");
        output(outputRows, formatted);
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("explain <email-id>")
    .description("Explain local routing, recipient ownership, and source readiness for an inbound email")
    .action((emailId: string) => {
      try {
        const db = getDatabase();
        const fullId = resolveInboundEmailId(emailId);
        const email = getInboundEmailSummary(fullId, db);
        if (!email) handleError(new Error(`Email not found: ${emailId}`));
        const routedRecipients = email!.to_addresses.map((recipient) => {
          const normalized = normalizeEmailAddress(recipient) ?? recipient.toLowerCase();
          const domainName = normalized.includes("@") ? normalized.split("@")[1] ?? "" : "";
          return {
            recipient: normalized,
            aliasTarget: resolveAlias(normalized, db),
            exactAddresses: findAddressesByEmail(normalized, db),
            domainRows: domainName ? findDomainsByName(domainName, db) : [],
          };
        });
        const allAddresses = routedRecipients.flatMap((recipient) => recipient.exactAddresses);
        const allDomains = routedRecipients.flatMap((recipient) => recipient.domainRows);
        const enrichedAddresses = new Map(enrichAddresses(allAddresses, db).map((address) => [address.id, address]));
        const addressProvisioning = listAddressProvisioningByIds(allAddresses.map((address) => address.id), db);
        const domainProvisioning = listDomainProvisioningByIds(allDomains.map((domain) => domain.id), db);
        const readyAddressCounts = listReadyAddressCountsByDomains(allDomains.map((domain) => domain.id), db);
        const providerNames = listProviderNamesByIds([
          ...(email!.provider_id ? [email!.provider_id] : []),
          ...allAddresses.map((address) => address.provider_id),
          ...allDomains.map((domain) => domain.provider_id),
        ], db);
        const providerName = (providerId: string): string | null => providerNames.get(providerId) ?? null;
        const recipients = routedRecipients.map(({ recipient, aliasTarget, exactAddresses, domainRows }) => {
          return {
            recipient,
            alias_target: aliasTarget,
            configured_addresses: exactAddresses.map((address) => {
              const enriched = enrichedAddresses.get(address.id);
              return {
                id: address.id,
                provider_id: address.provider_id,
                provider_name: providerName(address.provider_id),
                provisioning: addressProvisioning.get(address.id) ?? null,
                owner: enriched?.owner ?? null,
                administrator: enriched?.administrator ?? null,
              };
            }),
            domains: domainRows.map((domain) => {
              const readyAddresses = readyAddressCounts.get(domain.id) ?? 0;
              const readiness = assessDomainReadiness(domain, domainProvisioning.get(domain.id) ?? null, { ready_addresses: readyAddresses });
              return {
                id: domain.id,
                provider_id: domain.provider_id,
                provider_name: providerName(domain.provider_id),
                readiness,
              };
            }),
          };
        });
        const result = {
          email_id: email!.id,
          provider_id: email!.provider_id,
          message_id: email!.message_id,
          from: email!.from_address,
          subject: email!.subject,
          received_at: email!.received_at,
          recipients,
        };
        const lines = [chalk.bold(`\nRouting for ${email!.id.slice(0, 8)}`)];
        lines.push(`  From:     ${email!.from_address}`);
        lines.push(`  Subject:  ${email!.subject || "(no subject)"}`);
        lines.push(`  Source:   ${email!.provider_id ? providerName(email!.provider_id) ?? email!.provider_id : "unknown/local"}`);
        for (const recipient of recipients) {
          lines.push(`\n  To:       ${recipient.recipient}`);
          lines.push(`  Alias:    ${recipient.alias_target ?? chalk.dim("none")}`);
          lines.push(`  Address:  ${recipient.configured_addresses.length ? recipient.configured_addresses.map((a) => `${a.id.slice(0, 8)}${a.owner ? ` owner=${a.owner.name}` : ""}`).join(", ") : chalk.dim("not configured")}`);
          lines.push(`  Domain:   ${recipient.domains.length ? recipient.domains.map((d) => `${d.id.slice(0, 8)} ${d.readiness.state}`).join(", ") : chalk.dim("not configured")}`);
        }
        lines.push("");
        output(result, lines.join("\n"));
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
    .option("--offset <n>", "Skip first N local results", "0")
    .option("--remote", "Search live Gmail via connector (not just local DB)")
    .action(async (query: string, opts: { provider?: string; limit?: string; offset?: string; remote?: boolean }) => {
      try {
        const db = getDatabase();
        const limit = parsePositiveIntOption(opts.limit, 20);
        const offset = parseNonNegativeIntOption(opts.offset);

        if (opts.remote) {
          // Live Gmail search via connectors SDK
          const { runConnectorOperation } = await import("@hasna/connectors");
          const r = await runConnectorOperation<{ messages?: { id: string; from: string; subject: string; date: string }[] } | { id: string; from: string; subject: string; date: string }[]>({
            connector: "gmail",
            operation: "messages.list",
            input: { query, max: limit },
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
        const emails = listInboundEmailSummaries({ provider_id: opts.provider, limit, offset, search: query }, db);

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
    .description("Show sync status for all inbox sources")
    .action(async () => {
      try {
        const { getEmailSystemStatus } = await import("../../lib/agent-context.js");
        const status = getEmailSystemStatus();
        output(status.inbox, formatInboxSyncStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("sync-status")
    .description("Show source-aware inbox sync status")
    .action(async () => {
      try {
        const { getEmailSystemStatus } = await import("../../lib/agent-context.js");
        const status = getEmailSystemStatus();
        output({ inbox: status.inbox, gmail: status.providers.gmail, cli_equivalents: status.cli_equivalents }, formatInboxSyncStatus(status));
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
        const { listGmailLabels } = await import("../../lib/gmail-sync.js");
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
        const fullId = resolveInboundEmailId(id);
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
    const { runConnectorOperation } = await import("@hasna/connectors");
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
    const fullId = resolveInboundEmailId(id);
    const e = getInboundEmailSummary(fullId, db);
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
        const e = setInboundReadSummary(id, !opts.unread, getDatabase());
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
        const e = setInboundArchivedSummary(id, !opts.undo, getDatabase());
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
        const e = setInboundStarredSummary(id, !opts.undo, getDatabase());
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
        const e = opts.remove ? removeInboundLabelSummary(id, label, getDatabase()) : addInboundLabelSummary(id, label, getDatabase());
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
        const { runConnectorOperation } = await import("@hasna/connectors");
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
        const fullId = resolveInboundEmailId(emailId);
        const paths = getInboundAttachmentPaths(fullId, db);
        if (!paths) {
          console.error(chalk.red(`Email not found: ${emailId}`));
          process.exit(1);
        }
        const filtered = opts.filename ? paths.filter((p) => p.filename === opts.filename) : paths;
        if (filtered.length === 0) {
          console.log(chalk.dim("No attachments found for this email."));
          return;
        }
        console.log(chalk.bold(`\nAttachments for ${fullId.slice(0, 8)}:`));
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
          limit: parsePositiveIntOption(opts.limit, 100),
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

  // ─── REAL-TIME INBOUND ────────────────────────────────────────────────────
  inboxCmd
    .command("setup-realtime <domain>")
    .description("Wire SES→SNS→SQS so inbound mail auto-syncs (no manual sync-s3)")
    .option("--rule-set <name>", "SES receipt rule set name", "emails-inbound")
    .option("--rule <name>", "SES receipt rule name (defaults to inbound-<domain>)")
    .option("--region <region>", "AWS region (defaults to config inbound_s3_region)")
    .option("--profile <profile>", "AWS profile")
    .action(async (domain: string, opts: { ruleSet: string; rule?: string; region?: string; profile?: string }) => {
      try {
        const { getInboundConfig, loadConfig, saveConfig } = await import("../../lib/config.js");
        const inbound = getInboundConfig();
        const profile = opts.profile ?? inbound.profile;
        if (profile) process.env["AWS_PROFILE"] = profile;
        const { setupRealtimeInbound } = await import("../../lib/inbound-realtime-aws.js");
        const ruleName = opts.rule ?? `inbound-${domain.replace(/\./g, "-")}`;
        console.log(chalk.dim(`Wiring real-time inbound for ${domain} (rule ${opts.ruleSet}/${ruleName})...`));
        const result = await setupRealtimeInbound({
          domain,
          ruleSetName: opts.ruleSet,
          ruleName,
          region: opts.region ?? inbound.region,
        });
        // Persist the queue URL so `inbox watch` can find it with no args.
        const config = loadConfig();
        config["inbound_realtime_queue_url"] = result.queue_url;
        config["inbound_realtime_topic_arn"] = result.topic_arn;
        saveConfig(config);
        const lines = [chalk.bold("\n✓ Real-time inbound wired:")];
        lines.push(`  SNS topic:  ${chalk.cyan(result.topic_arn)}`);
        lines.push(`  SQS queue:  ${chalk.cyan(result.queue_url)}`);
        lines.push(`  SES rule:   ${result.rule_updated ? chalk.green("updated (TopicArn attached)") : chalk.yellow("not updated — attach TopicArn manually")}`);
        lines.push(chalk.dim("\n  Now run:  emails inbox watch"));
        output(result, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("realtime-status")
    .description("Show real-time inbound queue, bucket, and sync health")
    .action(async () => {
      try {
        const { loadConfig, getInboundBuckets } = await import("../../lib/config.js");
        const config = loadConfig();
        const db = getDatabase();
        const buckets = getInboundBuckets();
        const data = {
          queue_url: config["inbound_realtime_queue_url"] ?? null,
          topic_arn: config["inbound_realtime_topic_arn"] ?? null,
          buckets,
          total_inbound_emails: getReceivedInboundCount(undefined, db),
          unread_inbound_emails: getUnreadCount(undefined, db),
          last_received_at: getLatestReceivedInboundAt(db),
          last_poll_at: config["inbound_realtime_last_poll_at"] ?? null,
          last_error: config["inbound_realtime_last_error"] ?? null,
        };
        const lines = [chalk.bold("\nReal-time inbound status:")];
        lines.push(`  Queue:       ${data.queue_url ? chalk.cyan(String(data.queue_url)) : chalk.yellow("not configured")}`);
        lines.push(`  Topic:       ${data.topic_arn ? chalk.cyan(String(data.topic_arn)) : chalk.dim("not configured")}`);
        lines.push(`  Buckets:     ${buckets.length > 0 ? chalk.green(String(buckets.length)) : chalk.yellow("0")}`);
        for (const b of buckets) {
          lines.push(`    - s3://${b.bucket} ${chalk.dim(b.region)}${b.providerId ? chalk.dim(` provider=${b.providerId.slice(0, 8)}`) : ""}`);
        }
        lines.push(`  Emails:      ${data.total_inbound_emails} total, ${data.unread_inbound_emails} unread`);
        lines.push(`  Last mail:   ${data.last_received_at ? chalk.green(String(data.last_received_at)) : chalk.dim("never")}`);
        lines.push(`  Last poll:   ${data.last_poll_at ? chalk.green(String(data.last_poll_at)) : chalk.dim("never")}`);
        if (data.last_error) lines.push(`  Last error:  ${chalk.red(String(data.last_error))}`);
        lines.push(chalk.dim("\n  Start watcher: emails inbox watch --all-buckets"));
        output(data, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("watch")
    .description("Watch the SQS queue and auto-sync inbound mail in real-time (no manual sync-s3)")
    .option("--queue-url <url>", "SQS queue URL (defaults to config inbound_realtime_queue_url)")
    .option("--bucket <name>", "S3 bucket (defaults to config inbound_s3_bucket)")
    .option("--prefix <prefix>", "S3 key prefix to sync")
    .option("--region <region>", "AWS region")
    .option("--provider <id>", "Associate emails with this provider ID")
    .option("--profile <profile>", "AWS profile")
    .option("--once", "Poll a single time then exit (for testing)")
    .option("--all-buckets", "When a notification arrives, sync every configured inbound S3 bucket")
    .action(async (opts: { queueUrl?: string; bucket?: string; prefix?: string; region?: string; provider?: string; profile?: string; once?: boolean; allBuckets?: boolean }) => {
      try {
        const { getInboundConfig, loadConfig, saveConfig } = await import("../../lib/config.js");
        const inbound = getInboundConfig();
        const config = loadConfig();
        const profile = opts.profile ?? inbound.profile;
        if (profile) process.env["AWS_PROFILE"] = profile;
        const queueUrl = opts.queueUrl ?? (config["inbound_realtime_queue_url"] as string | undefined);
        const bucket = opts.bucket ?? inbound.bucket;
        const region = opts.region ?? inbound.region;
        const prefix = opts.prefix ?? inbound.prefix;
        if (!queueUrl) { handleError(new Error("No SQS queue: run 'emails inbox setup-realtime <domain>' first or pass --queue-url")); return; }
        if (!bucket) { handleError(new Error("No S3 bucket: pass --bucket or set inbound_s3_bucket")); return; }

        const { makeSqsAdapter } = await import("../../lib/inbound-realtime-aws.js");
        const { watchInboundOnce } = await import("../../lib/inbound-realtime.js");
        const { syncS3Inbox } = await import("../../lib/s3-sync.js");
        const sqs = makeSqsAdapter({ queueUrl, region });
        const rememberPoll = (patch: Record<string, unknown> = {}) => {
          const latest = loadConfig();
          latest["inbound_realtime_last_poll_at"] = new Date().toISOString();
          for (const [key, value] of Object.entries(patch)) latest[key] = value;
          saveConfig(latest);
        };
        const sync = async () => {
          if (opts.allBuckets) {
            const r = await runAutoPull({ s3: true, gmail: false, limit: 1000 });
            if (r.pulled > 0) console.log(chalk.green(`  ✓ ${r.pulled} new email(s) delivered across configured buckets`));
            return { synced: r.pulled };
          }
          const r = await syncS3Inbox({ bucket, prefix, region, providerId: opts.provider, limit: 100 });
          if (r.synced > 0) console.log(chalk.green(`  ✓ ${r.synced} new email(s) delivered`) + chalk.dim(` (${r.skipped} already stored)`));
          return { synced: r.synced };
        };

        if (opts.once) {
          const r = await watchInboundOnce(sqs, queueUrl, sync);
          rememberPoll({ inbound_realtime_last_error: null, inbound_realtime_last_messages: r.messages });
          output(r, r.triggered ? chalk.green(`✓ Processed ${r.messages} notification(s)`) : chalk.dim("No new mail."));
          return;
        }

        console.log(chalk.green(`👀 Watching for inbound mail on ${queueUrl.split("/").pop()}`));
        console.log(chalk.dim("   Press Ctrl+C to stop\n"));
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const r = await watchInboundOnce(sqs, queueUrl, sync);
            rememberPoll({ inbound_realtime_last_error: null, inbound_realtime_last_messages: r.messages });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            rememberPoll({ inbound_realtime_last_error: message });
            console.error(chalk.yellow(`  poll error: ${message}`));
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("archive-verify")
    .description("Verify a Gmail message archive in S3")
    .option("--bucket <name>", "Archive bucket name (default: configured Gmail archive bucket)")
    .requiredOption("--profile <profile>", "Gmail connector profile")
    .requiredOption("--message-id <id>", "Gmail message ID")
    .option("--prefix <prefix>", "Archive prefix", "gmail")
    .option("--region <region>", "AWS region (default: configured Gmail archive region)")
    .option("--aws-profile <profile>", "AWS profile")
    .option("--attachment <filename...>", "Expected attachment filename(s)")
    .option("--no-raw", "Do not require the raw MIME object")
    .action(async (opts: {
      bucket?: string;
      profile: string;
      messageId: string;
      prefix: string;
      region?: string;
      awsProfile?: string;
      attachment?: string[];
      raw: boolean;
    }) => {
      try {
        if (opts.awsProfile) process.env["AWS_PROFILE"] = opts.awsProfile;
        const { getDefaultGmailArchiveS3Bucket, getDefaultGmailArchiveS3Region } = await import("../../lib/config.js");
        const { verifyGmailArchive } = await import("../../lib/gmail-archive.js");
        const result = await verifyGmailArchive({
          bucket: opts.bucket ?? getDefaultGmailArchiveS3Bucket(),
          profile: opts.profile,
          messageId: opts.messageId,
          prefix: opts.prefix,
          region: opts.region ?? getDefaultGmailArchiveS3Region(),
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
    .description("Copy a legacy Gmail-to-S3 bucket/prefix into the configured Gmail archive bucket")
    .requiredOption("--source-bucket <name>", "Legacy source bucket, e.g. hasna-mail-maximstaris")
    .option("--target-bucket <name>", "Target archive bucket (default: configured Gmail archive bucket)")
    .option("--source-prefix <prefix>", "Source key prefix", "")
    .option("--target-prefix <prefix>", "Target key prefix", "legacy/maximstaris")
    .option("--region <region>", "AWS region", "us-east-1")
    .option("--target-region <region>", "Target AWS region (default: configured Gmail archive region)")
    .option("--aws-profile <profile>", "AWS profile")
    .option("--source-aws-profile <profile>", "AWS profile for reading the source bucket")
    .option("--target-aws-profile <profile>", "AWS profile for writing the target bucket")
    .option("--limit <n>", "Maximum objects to scan in this run")
    .option("--continuation-token <token>", "Resume a previous bounded migration from this S3 continuation token")
    .option("--dry-run", "Plan copies without writing to target")
    .action(async (opts: {
      sourceBucket: string;
      targetBucket?: string;
      sourcePrefix?: string;
      targetPrefix?: string;
      region: string;
      targetRegion?: string;
      awsProfile?: string;
      sourceAwsProfile?: string;
      targetAwsProfile?: string;
      limit?: string;
      continuationToken?: string;
      dryRun?: boolean;
    }) => {
      try {
        if (opts.awsProfile) process.env["AWS_PROFILE"] = opts.awsProfile;
        const { getDefaultGmailArchiveS3Bucket, getDefaultGmailArchiveS3Region } = await import("../../lib/config.js");
        const { migrateS3Prefix } = await import("../../lib/gmail-archive.js");
        const sourceProfile = opts.sourceAwsProfile ?? opts.awsProfile;
        const targetProfile = opts.targetAwsProfile ?? opts.awsProfile;
        const targetBucket = opts.targetBucket ?? getDefaultGmailArchiveS3Bucket();
        const targetRegion = opts.targetRegion ?? getDefaultGmailArchiveS3Region();
        let sourceClient;
        let targetClient;
        if (sourceProfile || targetProfile || targetRegion !== opts.region) {
          const [{ S3Client }, { fromIni }] = await Promise.all([
            import("@aws-sdk/client-s3"),
            import("@aws-sdk/credential-provider-ini"),
          ]);
          if (sourceProfile || targetRegion !== opts.region) {
            sourceClient = new S3Client({
              region: opts.region,
              credentials: sourceProfile ? fromIni({ profile: sourceProfile }) : undefined,
            });
          }
          if (targetProfile || targetRegion !== opts.region) {
            targetClient = new S3Client({
              region: targetRegion,
              credentials: targetProfile ? fromIni({ profile: targetProfile }) : undefined,
            });
          }
        }
        const result = await migrateS3Prefix({
          sourceBucket: opts.sourceBucket,
          targetBucket,
          sourcePrefix: opts.sourcePrefix,
          targetPrefix: opts.targetPrefix,
          continuationToken: opts.continuationToken,
          region: opts.region,
          sourceClient,
          targetClient,
          limit: opts.limit ? parsePositiveIntOption(opts.limit, 1000, MAX_ARCHIVE_MIGRATE_LIMIT) : undefined,
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
        const resolvedId = resolveInboundEmailId(id);
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
  const existing = getProviderByNameAndType(providerName, "gmail", db);
  if (existing) return existing.id;
  return createProvider({ name: providerName, type: "gmail" }, db).id;
}

function resolveGmailProvider(idOrName?: string): string | null {
  const db = getDatabase();
  const providers = listActiveProviderSummaries("gmail", db);

  if (!idOrName) return providers[0]?.id ?? null;

  const match = providers.find(
    (p) => p.id === idOrName || p.id.startsWith(idOrName) || p.name === idOrName,
  );
  return match?.id ?? null;
}

function formatInboxSyncStatus(status: EmailSystemStatus): string {
  const lines: string[] = [chalk.bold("\nInbox sync status:")];
  lines.push(`  Local inbox: ${status.inbox.total} total, ${status.inbox.unread} unread`);
  lines.push(`  Latest mail: ${status.inbox.latest_received_at ? chalk.green(status.inbox.latest_received_at) : chalk.dim("never")}`);
  lines.push(`  S3 buckets:  ${status.inbox.inbound_buckets.length > 0 ? chalk.green(String(status.inbox.inbound_buckets.length)) : chalk.yellow("0")}`);
  for (const bucket of status.inbox.inbound_buckets) {
    lines.push(`    - s3://${bucket.bucket} ${chalk.dim(bucket.region)}${bucket.providerId ? chalk.dim(` provider=${bucket.providerId.slice(0, 8)}`) : ""}`);
  }
  lines.push(`  Realtime:    ${status.inbox.realtime.queue_configured ? chalk.green("configured") : chalk.yellow("not configured")}`);
  if (status.inbox.realtime.last_poll_at) lines.push(`  Last poll:   ${chalk.green(status.inbox.realtime.last_poll_at)}`);
  if (status.inbox.realtime.last_error) lines.push(`  Last error:  ${chalk.red(status.inbox.realtime.last_error)}`);
  lines.push(`  Gmail:       ${status.providers.gmail.length} provider(s)`);
  for (const provider of status.providers.gmail) {
    lines.push(`    - ${provider.name} ${chalk.dim(provider.id.slice(0, 8))}: ${provider.synced_count} synced, ${provider.unread_count} unread, last ${provider.last_synced_at ? chalk.green(provider.last_synced_at) : chalk.dim("never")}`);
  }
  lines.push(chalk.dim("\n  Pull now: emails refresh"));
  lines.push(chalk.dim("  Watch realtime: emails inbox watch --all-buckets"));
  lines.push("");
  return lines.join("\n");
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
  if (result.nextContinuationToken) {
    lines.push(chalk.dim(`  Next token: ${result.nextContinuationToken}`));
    lines.push(chalk.dim("  More objects are available; rerun with --continuation-token <token>."));
  }
  lines.push("");
  return lines.join("\n");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface AttMeta { filename: string; content_type: string; size: number }
interface AttPath { filename: string; local_path?: string; s3_url?: string }

function formatEmailDetail(
  email: { id: string; from_address: string; subject: string; received_at: string; text_body?: string | null; to_addresses: string[]; cc_addresses: string[]; is_read?: boolean; is_starred?: boolean; is_archived?: boolean; label_ids?: string[]; attachments?: AttMeta[]; attachment_paths?: AttPath[] },
): string {
  const flags = [
    email.is_read === false ? "unread" : "read",
    email.is_starred ? "starred" : null,
    email.is_archived ? "archived" : null,
    ...(email.label_ids ?? []),
  ].filter(Boolean).join(", ");
  const atts = email.attachments ?? [];
  const byName = new Map((email.attachment_paths ?? []).map((p) => [p.filename, p.local_path ?? p.s3_url]));
  const lines: string[] = [
    chalk.bold(`\n  Subject: ${email.subject}`),
    `  From:    ${chalk.cyan(email.from_address)}`,
    `  To:      ${email.to_addresses.join(", ")}`,
    email.cc_addresses.length > 0 ? `  CC:      ${email.cc_addresses.join(", ")}` : "",
    `  Date:    ${email.received_at}`,
    `  Flags:   ${flags}`,
    `  ID:      ${chalk.dim(email.id)}`,
  ];
  if (atts.length > 0) {
    lines.push(chalk.yellow(`  📎 Attachments (${atts.length}):`));
    for (const a of atts) {
      const loc = byName.get(a.filename);
      lines.push(`     ${a.filename.padEnd(44)} ${chalk.dim(`${fmtBytes(a.size)} · ${a.content_type}`)}${loc ? chalk.green("  ✓saved") : chalk.dim("  (run: emails inbox sync to download)")}`);
    }
  }
  lines.push("", email.text_body ?? chalk.dim("(no body)"), "");
  return lines.filter((l) => l !== "").join("\n");
}
