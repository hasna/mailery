import type { Command } from "commander";
import type { EmailSystemStatus } from "../../lib/agent-context.js";
import chalk from "../../lib/chalk-lite.js";
import { confirmDestructiveAction, handleError } from "../utils.js";
import { extractEmailLinks, formatEmailLinks, type ExtractedEmailLink } from "../../lib/email-links.js";
import { formatAttachmentSize, mergeAttachmentDetails, type AttachmentDetail } from "../../lib/attachment-actions.js";
import { resolveMailDataSource, type MailDataSource } from "../../lib/mail-data-source.js";
import { readableMessageText } from "../tui/format.js";
import type {
  Mailbox,
  MailboxSource,
  MessageBody,
  TuiMessage,
  MailboxSourceSummary,
  MailboxStatusSummary,
} from "../tui/data.js";

const MAX_INBOX_CLI_LIMIT = 1000;
const CLI_MAILBOXES = ["inbox", "unread", "starred", "sent", "archived", "spam", "trash"] as const satisfies readonly Mailbox[];

function normalizeSinceOption(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid --since date: ${value}`);
  return new Date(time).toISOString();
}

function messageOnOrAfter(message: TuiMessage, since: string | undefined): boolean {
  if (!since) return true;
  const time = Date.parse(message.date);
  return Number.isFinite(time) && time >= Date.parse(since);
}

// Resolve a possibly-short id (the 8-char id printed by `inbox list`) to a full id
// through the seam: local SQLite partial-id resolution, or a bounded self_hosted prefix match
// so the id shown by `inbox list` is usable verbatim in self_hosted read/mark/star/label.
function resolveMailId(ds: MailDataSource, id: string): Promise<string> {
  return ds.resolveId(id);
}

// unread/starred/archived collapse to their folder view; read has no folder
// equivalent and is applied client-side over the returned page.
function folderForListFlags(flags: { unread?: boolean; starred?: boolean; archived?: boolean }): Mailbox {
  if (flags.archived) return "archived";
  if (flags.starred) return "starred";
  if (flags.unread) return "unread";
  return "inbox";
}

interface SeamMailDetail {
  id: string;
  thread_id: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  received_at: string;
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
  label_ids: string[];
  text_body: string | null;
  html_body: string | null;
  summary: string;
  attachments: Array<{ filename: string; content_type: string; size: number }>;
  attachment_paths: Array<{ filename: string; local_path?: string; s3_url?: string }>;
}

function splitAddresses(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

// A read/detail projection built from the seam (TuiMessage + MessageBody) so the CLI
// renders identically in local and self_hosted mode.
function seamMessageDetail(msg: TuiMessage, body: MessageBody | null): SeamMailDetail {
  const attachments = (body?.attachments ?? []).map((att) => ({
    filename: att.filename,
    content_type: att.content_type,
    size: att.size,
  }));
  const attachmentPaths = (body?.attachments ?? [])
    .filter((att) => att.location)
    .map((att) => (att.location!.startsWith("s3://")
      ? { filename: att.filename, s3_url: att.location! }
      : { filename: att.filename, local_path: att.location! }));
  // A read message must not display the system `unread` label alongside the "read" flag
  // (the self_hosted read flow fetches the message while unread, then marks it read without
  // re-fetching its labels). Suppress it here so `Flags:` reads just "read" — parity with
  // local, which has no such label.
  const label_ids = msg.is_read
    ? msg.labels.filter((label) => label.trim().toLowerCase() !== "unread")
    : msg.labels;
  return {
    id: msg.id,
    thread_id: msg.thread_id,
    from_address: body?.from ?? msg.from,
    to_addresses: splitAddresses(body?.to ?? msg.to),
    cc_addresses: splitAddresses(body?.cc),
    subject: body?.subject ?? msg.subject,
    received_at: body?.date ?? msg.date,
    is_read: msg.is_read,
    is_starred: msg.is_starred,
    is_archived: (body?.flags ?? []).includes("archived"),
    label_ids,
    text_body: body?.text ?? null,
    html_body: body?.html ?? null,
    summary: body?.summary ?? "",
    attachments,
    attachment_paths: attachmentPaths,
  };
}

async function seamDetailById(ds: MailDataSource, id: string): Promise<SeamMailDetail | null> {
  // Single row read: the message and its body come back together (one round-trip),
  // and `id` may be a short prefix — the server resolves it.
  const result = await ds.getMessageWithBody(id);
  if (!result) return null;
  return seamMessageDetail(result.msg, result.body);
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

function normalizeCliMailbox(value: string | undefined): Mailbox {
  const normalized = (value ?? "inbox").trim().toLowerCase();
  return CLI_MAILBOXES.includes(normalized as Mailbox) ? normalized as Mailbox : "inbox";
}

function mailboxSourceFromOptions(opts: { source?: string; provider?: string; address?: string; domain?: string }): MailboxSource | undefined {
  const sourceId = opts.source?.trim();
  const providerId = opts.provider?.trim();
  const address = opts.address?.trim().toLowerCase();
  const domain = opts.domain?.trim().toLowerCase();
  if (!sourceId && !providerId && !address && !domain) return undefined;

  const source: MailboxSource = { sourceId, providerId, address, domain };
  if (sourceId === "legacy") source.legacy = true;
  else if (sourceId?.startsWith("provider:")) source.providerId = sourceId.slice("provider:".length);
  else if (sourceId?.startsWith("orphaned:")) source.providerId = sourceId.slice("orphaned:".length);
  else if (sourceId?.startsWith("s3:")) source.s3Bucket = decodeURIComponent(sourceId.slice("s3:".length));
  return source;
}

async function runAutoPull(_opts: { s3?: boolean; limit?: number }) {
  // Auto-pull was LOCAL S3 ingestion. This client is self-hosted-only: the /v1 API
  // is the source of truth and each read re-fetches it, so there is nothing to pull.
  return { pulled: 0, ok: true, configured: false, reason: "self_hosted mode" };
}

// Local S3/SES ingestion, realtime wiring, SMTP listeners and local routing
// diagnostics have no /v1 equivalent in this self-hosted-only client: production
// ingestion runs on the self-hosted API/worker. These commands are kept for
// discoverability but fail loud. Use `emails inbox list/read/mark-read/status`
// (API-backed) for the mail view.
function serverOnly(command: string): never {
  throw new Error(
    `emails inbox ${command} is not available in the self-hosted client; it runs on the self-hosted server.`,
  );
}

interface CodeOptions {
  from?: string;
  subject?: string;
  limit?: string;
  refresh?: boolean;
  watch?: boolean;
  wait?: boolean;
  timeout?: string;
  interval?: string;
  since?: string;
}

interface InboundLinksResult {
  email_id: string;
  from: string;
  subject: string;
  received_at: string;
  links: ExtractedEmailLink[];
}

export function registerInboxCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const inboxCmd = program.command("inbox").description("Sync and browse inbound emails (SES/S3, Cloudflare, Resend, SMTP)");

  async function getInboundLinks(emailId: string, opts?: { all?: boolean }): Promise<InboundLinksResult> {
    const ds = resolveMailDataSource();
    const fullId = await resolveMailId(ds, emailId);
    const msg = await ds.getMessage(fullId);
    if (!msg) handleError(new Error(`Email not found: ${emailId}`));
    const body = await ds.getMessageBody(msg);
    return {
      email_id: msg.id,
      from: body?.from ?? msg.from,
      subject: body?.subject ?? msg.subject,
      received_at: body?.date ?? msg.date,
      links: extractEmailLinks({
        text: body?.text ?? null,
        html: body?.html ?? null,
        includeNonWeb: opts?.all === true,
      }),
    };
  }

  function formatInboundLinks(result: InboundLinksResult): string {
    return [
      chalk.bold(`Links for ${result.email_id.slice(0, 8)}`),
      `From:    ${result.from}`,
      `Subject: ${result.subject || "(no subject)"}`,
      `Date:    ${result.received_at}`,
      "",
      formatEmailLinks(result.links),
    ].join("\n");
  }

  async function runCodeCommand(address: string, opts: CodeOptions): Promise<void> {
    const normalized = address.trim().toLowerCase();
    const limit = parsePositiveIntOption(opts.limit, 50);
    const watching = opts.watch || opts.wait;
    const timeoutMs = Math.max(1, parseInt(opts.timeout ?? "120", 10) || 120) * 1000;
    const intervalMs = Math.max(1, parseInt(opts.interval ?? "5", 10) || 5) * 1000;
    const deadline = Date.now() + timeoutMs;

    const ds = resolveMailDataSource();
    const findMatch = () => ds.findLatest(normalized, {
      limit,
      since: opts.since,
      from: opts.from,
      subject: opts.subject,
    });

    while (true) {
      let match = await findMatch();
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
        await runAutoPull({ s3: true, limit: Math.max(limit, 1000) });
        match = await findMatch();
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
    timeout?: string;
    interval?: string;
    since?: string;
  }): Promise<void> {
    const normalized = address.trim().toLowerCase();
    const limit = parsePositiveIntOption(opts.limit, 50);
    const timeoutMs = Math.max(1, parseInt(opts.timeout ?? "120", 10) || 120) * 1000;
    const intervalMs = Math.max(1, parseInt(opts.interval ?? "5", 10) || 5) * 1000;
    const deadline = Date.now() + timeoutMs;

    const ds = resolveMailDataSource();
    const findEmail = async (): Promise<SeamMailDetail | null> => {
      const [latest] = await ds.verificationCandidates(normalized, {
        limit: 1,
        since: opts.since,
        from: opts.from,
        subject: opts.subject,
      });
      return latest ? seamDetailById(ds, latest.id) : null;
    };

    while (true) {
      let email = await findEmail();
      if (email) {
        output(email, email.id);
        return;
      }

      if (opts.refresh !== false) {
        await runAutoPull({ s3: true, limit: Math.max(limit, 1000) });
        email = await findEmail();
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
    .option("--since <date>", "Only consider mail received after this ISO date")
    .action(async (address: string, opts: { from?: string; subject?: string; limit?: string; refresh?: boolean; since?: string }) => {
      try {
        const normalized = address.trim().toLowerCase();
        if (opts.refresh) await runAutoPull({ s3: true, limit: Math.max(1000, parsePositiveIntOption(opts.limit, 50)) });
        const ds = resolveMailDataSource();
        const [latest] = await ds.verificationCandidates(normalized, {
          limit: 1,
          since: opts.since,
          from: opts.from,
          subject: opts.subject,
        });
        const email = latest ? await seamDetailById(ds, latest.id) : null;
        if (!email) {
          output({ email: null, address: normalized }, chalk.dim(`No email found for ${normalized}.`));
          process.exitCode = 1;
          return;
        }
        output(email, formatEmailDetail(email, { mode: ds.mode }));
      } catch (e) { handleError(e); }
    });

  // ─── LIST ─────────────────────────────────────────────────────────────────
  inboxCmd
    .command("list")
    .description("List local mailbox mail")
    .option("--provider <id>", "Credential/capability ID used as a provenance filter")
    .option("--source <id>", "Filter by ingestion source ID from `emails inbox sources`")
    .option("--folder <folder>", "Folder to list: inbox, unread, starred, sent, archived, spam, trash", "inbox")
    .option("--address <address>", "Mailbox scope: exact recipient/sender address")
    .option("--domain <domain>", "Mailbox scope: recipient/sender domain")
    .option("--since <date>", "Only show emails after this date")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N emails", "0")
    .option("--search <query>", "Filter by subject/from/to/body")
    .option("--to <addr-or-domain>", "Only mail addressed to this address or domain (e.g. el@elyratelier.com or elyratelier.com)")
    .option("--unread", "Only unread mail")
    .option("--read", "Only read mail")
    .option("--starred", "Only starred mail")
    .option("--archived", "Show archived mail (hidden by default)")
    .option("--label <label>", "Only mail carrying this label")
    .action(async (opts: { provider?: string; source?: string; folder?: string; address?: string; domain?: string; since?: string; limit?: string; offset?: string; search?: string; to?: string; unread?: boolean; read?: boolean; starred?: boolean; archived?: boolean; label?: string }) => {
      try {
        const limit = parsePositiveIntOption(opts.limit, 20);
        const offset = parseNonNegativeIntOption(opts.offset);
        const toFilter = opts.to?.trim().toLowerCase();
        // An explicit non-inbox --folder wins; otherwise the flag shorthands pick it.
        const folder = opts.folder && opts.folder !== "inbox"
          ? normalizeCliMailbox(opts.folder)
          : folderForListFlags(opts);
        let source = mailboxSourceFromOptions(opts);
        if (toFilter) {
          source = source ?? {};
          if (toFilter.includes("@")) { if (!source.address) source.address = toFilter; }
          else if (!source.domain) source.domain = toFilter;
        }
        const ds = resolveMailDataSource();
        const since = normalizeSinceOption(opts.since);
        let rows = await ds.listMailbox(folder, {
          source,
          limit,
          offset,
          since,
          search: opts.search,
          label: opts.label,
        });
        // Keep a parsed-date guard in case an older data source ignores `since`.
        if (opts.read) rows = rows.filter((row) => row.is_read);
        if (since) rows = rows.filter((row) => messageOnOrAfter(row, since));
        if (rows.length === 0) {
          output([], chalk.dim("No mail found. Try `emails inbox sources`, `emails refresh`, or `emails inbox wait <address>`."));
          return;
        }
        output(rows, formatMailboxMessages(rows, `Mailbox ${folder}`));
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
    .action(async (opts: { byAddress?: boolean; limit?: string; offset?: string }) => {
      try {
        if (!opts.byAddress) {
          const counts = await resolveMailDataSource().mailboxCounts();
          output({ unread: counts.unread }, String(counts.unread));
          return;
        }
        // --by-address is a per-recipient rollup with no /v1 endpoint; it is
        // served by the self-hosted server. Fail cleanly.
        handleError(new Error("`inbox unread-count --by-address` is not available in the self-hosted client; it runs on the self-hosted server. Use `emails inbox unread-count` for the total unread count."));
        return;
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("explain <email-id>")
    .description("Explain local routing, recipient ownership, and source readiness for an inbound email")
    .action(() => {
      try { serverOnly("explain"); } catch (e) { handleError(e); }
    });

  // ─── SEARCH ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("search <query>")
    .description("Search local mailbox mail")
    .option("--provider <id>", "Credential/capability ID used as a provenance filter")
    .option("--folder <folder>", "Folder to search: inbox, unread, starred, sent, archived, spam, trash", "inbox")
    .option("--address <address>", "Mailbox scope: exact recipient/sender address")
    .option("--domain <domain>", "Mailbox scope: recipient/sender domain")
    .option("--label <label>", "Only mail carrying this label")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N local results", "0")
    .option("--source <id>", "Local ingestion source ID")
    .action(async (query: string, opts: { provider?: string; folder?: string; address?: string; domain?: string; label?: string; limit?: string; offset?: string; source?: string }) => {
      try {
        const limit = parsePositiveIntOption(opts.limit, 20);
        const offset = parseNonNegativeIntOption(opts.offset);
        const folder = normalizeCliMailbox(opts.folder);
        const ds = resolveMailDataSource();
        const rows = await ds.listMailbox(folder, {
          source: mailboxSourceFromOptions(opts),
          label: opts.label,
          search: query,
          limit,
          offset,
        });
        if (rows.length === 0) {
          console.log(chalk.dim(`No results for "${query}".`));
          return;
        }
        output(rows, formatMailboxMessages(rows, `Search ${folder}: "${query}"`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── STATUS ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("sources")
    .description("List ingestion sources with legacy/orphaned badges")
    .option("--search <query>", "Filter by source label, ID, kind, provider, bucket, or badge")
    .option("--limit <n>", "Max sources", "100")
    .action(async (opts: { search?: string; limit?: string }) => {
      try {
        const ds = resolveMailDataSource();
        const sources = await ds.listMailboxSources({
          search: opts.search,
          limit: parsePositiveIntOption(opts.limit, 100),
        });
        output(sources, formatMailboxSources(sources));
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("mailboxes")
    .description("List folder counts for a mailbox scope or ingestion source")
    .option("--source <id>", "Filter by ingestion source ID from `emails inbox sources`")
    .option("--provider <id>", "Credential/capability ID used as a provenance filter")
    .option("--address <address>", "Mailbox scope: exact recipient/sender address")
    .option("--domain <domain>", "Mailbox scope: recipient/sender domain")
    .action(async (opts: { source?: string; provider?: string; address?: string; domain?: string }) => {
      try {
        const source = mailboxSourceFromOptions(opts);
        const ds = resolveMailDataSource();
        const status = await ds.listMailboxStatus({ source });
        output({ source: source ?? null, ...status }, formatMailboxStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("status")
    .description("Show sync status for all ingestion sources")
    .action(async () => {
      try {
        const { getEmailSystemStatusForRuntime } = await import("../../lib/agent-context.js");
        const status = await getEmailSystemStatusForRuntime();
        output(status.inbox, formatInboxSyncStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("sync-status")
    .description("Show source-aware mailbox sync status")
    .action(async () => {
      try {
        const { getEmailSystemStatusForRuntime } = await import("../../lib/agent-context.js");
        const status = await getEmailSystemStatusForRuntime();
        output({ inbox: status.inbox, mailboxes: status.mailboxes, sources: status.sources, cli_equivalents: status.cli_equivalents }, formatInboxSyncStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  const sourceCmd = inboxCmd.command("source").description("Manage ingestion source lifecycle");

  sourceCmd
    .command("list")
    .alias("status")
    .description("List configured S3 ingestion sources")
    .action(() => {
      try { serverOnly("source list"); } catch (e) { handleError(e); }
    });

  sourceCmd
    .command("add-s3")
    .description("Register an SES/S3 inbound bucket/prefix as a source")
    .requiredOption("--bucket <name>", "S3 bucket name")
    .option("--prefix <prefix>", "S3 key prefix")
    .option("--region <region>", "AWS region", "us-east-1")
    .option("--provider <id>", "SES provider id for provenance")
    .option("--name <name>", "Source display name")
    .option("--status <status>", "Source status: live | import | legacy | retired", "live")
    .option("--no-live-sync", "Register source but disable live sync")
    .action(() => {
      try { serverOnly("source add-s3"); } catch (e) { handleError(e); }
    });

  sourceCmd
    .command("retire <source>")
    .description("Retire an S3 source without deleting provider rows or mail")
    .action(() => {
      try { serverOnly("source retire"); } catch (e) { handleError(e); }
    });

  // ─── READ ─────────────────────────────────────────────────────────────────
  inboxCmd
    .command("read <id>")
    .description("Read a synced email from local DB (marks it read)")
    .option("--keep-unread", "Do not mark the email as read")
    .action(async (id: string, opts: { keepUnread?: boolean }) => {
      try {
        const ds = resolveMailDataSource();
        // getMessageWithBody resolves a short id prefix server-side and returns the
        // message AND its body in ONE round-trip; a read is then a single GET
        // (+1 write only if it needs marking read) instead of the old whole-inbox
        // scan followed by two separate row fetches.
        const detailSource = await ds.getMessageWithBody(id);
        if (!detailSource) {
          console.error(chalk.red(`Email not found: ${id}`));
          process.exit(1);
        }
        const { msg, body } = detailSource;
        // Opening an email marks it read unless --keep-unread is set.
        if (!opts.keepUnread && !msg.is_read) { await ds.setRead(msg.id, true); msg.is_read = true; }
        const detail = seamMessageDetail(msg, body);
        output(detail, formatEmailDetail(detail, { mode: ds.mode }));
      } catch (e) {
        handleError(e);
      }
    });

  inboxCmd
    .command("links <email-id>")
    .description("Extract links from a synced inbound email")
    .option("--all", "Include non-web links such as mailto: and tel:")
    .action(async (emailId: string, opts: { all?: boolean }) => {
      try {
        const result = await getInboundLinks(emailId, opts);
        output(result, formatInboundLinks(result));
      } catch (e) {
        handleError(e);
      }
    });

  program
    .command("links <email-id>")
    .description("Extract links from a synced inbound email (alias: emails inbox links)")
    .option("--all", "Include non-web links such as mailto: and tel:")
    .action(async (emailId: string, opts: { all?: boolean }) => {
      try {
        const result = await getInboundLinks(emailId, opts);
        output(result, formatInboundLinks(result));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── READ-STATE / ARCHIVE / STAR / LABELS ─────────────────────────────────
  // These commands write through the mail data source seam (local SQLite or self_hosted API).

  async function requireMessage(ds: MailDataSource, id: string): Promise<TuiMessage> {
    const msg = await ds.getMessage(await resolveMailId(ds, id));
    if (!msg) { console.error(chalk.red(`Email not found: ${id}`)); process.exit(1); }
    return msg;
  }

  inboxCmd
    .command("mark-read <emailId>")
    .description("Mark an inbound email as read")
    .option("--unread", "Mark as unread instead")
    .action(async (emailId: string, opts: { unread?: boolean }) => {
      try {
        const ds = resolveMailDataSource();
        const msg = await requireMessage(ds, emailId);
        await ds.setRead(msg.id, !opts.unread);
        const updated = (await ds.getMessage(msg.id)) ?? { ...msg, is_read: !opts.unread };
        output(updated, chalk.green(`✓ Marked ${opts.unread ? "unread" : "read"}: ${updated.subject.slice(0, 40)}`));
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("archive <emailId>")
    .description("Archive an inbound email")
    .option("--undo", "Unarchive (restore to inbox) instead")
    .action(async (emailId: string, opts: { undo?: boolean }) => {
      try {
        const ds = resolveMailDataSource();
        const msg = await requireMessage(ds, emailId);
        await ds.setArchived(msg.id, !opts.undo);
        output(msg, chalk.green(`✓ ${opts.undo ? "Unarchived" : "Archived"}: ${msg.subject.slice(0, 40)}`));
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("star <emailId>")
    .description("Star an inbound email")
    .option("--undo", "Unstar instead")
    .action(async (emailId: string, opts: { undo?: boolean }) => {
      try {
        const ds = resolveMailDataSource();
        const msg = await requireMessage(ds, emailId);
        await ds.setStarred(msg.id, !opts.undo);
        const updated = (await ds.getMessage(msg.id)) ?? { ...msg, is_starred: !opts.undo };
        output(updated, chalk[opts.undo ? "green" : "yellow"](`${opts.undo ? "✓ Unstarred" : "★ Starred"}: ${updated.subject.slice(0, 40)}`));
      } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("label <emailId> <label>")
    .description("Add (or with --remove, remove) a label on an inbound email")
    .option("--remove", "Remove the label instead of adding")
    .action(async (emailId: string, label: string, opts: { remove?: boolean }) => {
      try {
        const ds = resolveMailDataSource();
        const msg = await requireMessage(ds, emailId);
        const labels = opts.remove ? await ds.removeLabel(msg.id, label) : await ds.addLabel(msg.id, label);
        output({ id: msg.id, subject: msg.subject, label_ids: labels }, chalk.green(`✓ ${opts.remove ? "Removed" : "Added"} label "${label}": ${labels.join(", ") || "(none)"}`));
      } catch (e) { handleError(e); }
    });

  // ─── ATTACHMENT ───────────────────────────────────────────────────────────
  inboxCmd
    .command("attachment <emailId>")
    .description("Show attachment metadata and downloaded paths for a synced email")
    .option("--filename <name>", "Filter by filename")
    .action(async (emailId: string, opts: { filename?: string }) => {
      try {
        const ds = resolveMailDataSource();
        const fullId = await resolveMailId(ds, emailId);
        const msg = await ds.getMessage(fullId);
        if (!msg) {
          console.error(chalk.red(`Email not found: ${emailId}`));
          process.exit(1);
        }
        const body = await ds.getMessageBody(msg);
        const paths = await ds.getAttachmentPaths(fullId);
        const details = mergeAttachmentDetails(body?.attachments ?? [], paths);
        const filtered = opts.filename ? details.filter((p) => p.filename === opts.filename) : details;
        if (filtered.length === 0) {
          output([], chalk.dim("No attachments found for this email."));
          return;
        }
        output(filtered, formatAttachmentDetailList(fullId, filtered));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── DELETE ───────────────────────────────────────────────────────────────
  inboxCmd
    .command("delete <id>")
    .description("Delete a synced email from the active inbox store")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        await confirmDestructiveAction(`Delete inbox email ${id}?`, opts.yes);
        const ds = resolveMailDataSource();
        const fullId = await resolveMailId(ds, id);
        const existing = await ds.getMessage(fullId);
        if (!existing) {
          console.error(chalk.red(`Email not found: ${id}`));
          process.exit(1);
        }
        await ds.deleteMessage(fullId);
        console.log(chalk.green(`✓ Deleted email ${fullId.slice(0, 8)}`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── CLEAR ────────────────────────────────────────────────────────────────
  inboxCmd
    .command("clear")
    .description("Clear synced emails from the active inbox store")
    .option("--provider <id>", "Only clear emails for this provider")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { provider?: string; yes?: boolean }) => {
      try {
        const ds = resolveMailDataSource();
        const target = opts.provider ? `for provider ${opts.provider}` : "for all providers";
        // Self-hosted deletes on the server: drains a bulk delete over the inbox
        // folder (scoped to the provider's mailbox when resolvable).
        await confirmDestructiveAction(`Clear inbox emails ${target}?`, opts.yes);
        const { cleared } = await ds.clear({ providerId: opts.provider });
        console.log(chalk.green(`✓ Cleared ${cleared} email(s)`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── SYNC S3 ──────────────────────────────────────────────────────────────
  inboxCmd
    .command("sync-s3")
    .description("Sync inbound emails from S3 bucket (stored by SES receipt rules). Defaults --bucket/--region to config inbound_s3_bucket/region.")
    .option("--source <id>", "Explicit S3 source id")
    .option("--bucket <name>", "S3 bucket name (defaults to config inbound_s3_bucket)")
    .option("--prefix <prefix>", "S3 key prefix to scan (e.g. inbound/example.com/)")
    .option("--region <region>", "AWS region (defaults to config inbound_s3_region or us-east-1)")
    .option("--provider <id>", "Associate emails with this provider ID")
    .option("--limit <n>", "Max emails per run", "100")
    .option("--profile <profile>", "AWS profile")
    .option("--force", "Allow syncing a retired or disabled S3 source")
    .action(() => {
      try { serverOnly("sync-s3"); } catch (e) { handleError(e); }
    });

  // ─── REAL-TIME INBOUND ────────────────────────────────────────────────────
  inboxCmd
    .command("setup-realtime <domain>")
    .description("Wire SES→SNS→SQS so inbound mail auto-syncs (no manual sync-s3)")
    .option("--rule-set <name>", "SES receipt rule set name", "emails-inbound")
    .option("--rule <name>", "SES receipt rule name (defaults to inbound-<domain>)")
    .option("--region <region>", "AWS region (defaults to config inbound_s3_region)")
    .option("--profile <profile>", "AWS profile")
    .action(() => {
      try { serverOnly("setup-realtime"); } catch (e) { handleError(e); }
    });

  inboxCmd
    .command("realtime-status")
    .description("Show real-time inbound queue, bucket, and sync health")
    .action(() => {
      try { serverOnly("realtime-status"); } catch (e) { handleError(e); }
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
    .action(() => {
      try { serverOnly("watch"); } catch (e) { handleError(e); }
    });

  // ─── LISTEN (SMTP) ────────────────────────────────────────────────────────
  inboxCmd
    .command("listen")
    .description("Start a local SMTP listener to receive inbound emails (dev/testing)")
    .option("--port <port>", "SMTP port to listen on", "2525")
    .option("--provider <id>", "Associate received emails with this provider ID")
    .action(() => {
      try { serverOnly("listen"); } catch (e) { handleError(e); }
    });

  // ─── OPEN HTML ────────────────────────────────────────────────────────────
  inboxCmd
    .command("open <id>")
    .description("Open a readable local HTML view of a synced email in the browser")
    .action(() => {
      try {
        throw new Error("emails inbox open is not available in the self-hosted client because it writes a rendered HTML file locally; it runs on the self-hosted server. Use `emails inbox read <id>` for API-backed terminal output.");
      } catch (e) { handleError(e); }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatInboxSyncStatus(status: EmailSystemStatus): string {
  const lines: string[] = [chalk.bold("\nInbox sync status:")];
  lines.push(`  Local inbox: ${status.inbox.total} total, ${status.inbox.unread} unread`);
  lines.push(`  Folders:     ${status.mailboxes.counts.inbox} inbox, ${status.mailboxes.counts.sent} sent, ${status.mailboxes.counts.archived} archived`);
  lines.push(`  Latest mail: ${status.inbox.latest_received_at ? chalk.green(status.inbox.latest_received_at) : chalk.dim("never")}`);
  lines.push(`  Sources:     ${status.sources.total} ingestion source(s), ${status.sources.legacy} legacy, ${status.sources.orphaned} orphaned`);
  for (const source of status.sources.items.filter((item) => item.kind !== "all").slice(0, 5)) {
    const badges = source.badges.length ? chalk.dim(` [${source.badges.join(", ")}]`) : "";
    lines.push(`    - ${source.label}${badges}: ${source.total} total, ${source.unread} unread`);
  }
  lines.push(`  S3 buckets:  ${status.inbox.inbound_buckets.length > 0 ? chalk.green(String(status.inbox.inbound_buckets.length)) : chalk.yellow("0")}`);
  for (const bucket of status.inbox.inbound_buckets) {
    lines.push(`    - s3://${bucket.bucket} ${chalk.dim(bucket.region)}${bucket.providerId ? chalk.dim(` provider=${bucket.providerId.slice(0, 8)}`) : ""}`);
  }
  lines.push(`  Realtime:    ${status.inbox.realtime.queue_configured ? chalk.green("configured") : chalk.yellow("not configured")}`);
  if (status.inbox.realtime.last_poll_at) lines.push(`  Last poll:   ${chalk.green(status.inbox.realtime.last_poll_at)}`);
  if (status.inbox.realtime.last_error) lines.push(`  Last error:  ${chalk.red(status.inbox.realtime.last_error)}`);
  lines.push(chalk.dim("\n  Pull now: emails refresh"));
  lines.push(chalk.dim("  Watch realtime: emails inbox watch --all-buckets"));
  lines.push("");
  return lines.join("\n");
}

function formatMailboxMessages(messages: TuiMessage[], title = "Mailbox"): string {
  const lines: string[] = [chalk.bold(`\n${title} (${messages.length}):`)];
  for (const message of messages) {
    const date = new Date(message.date).toLocaleDateString();
    const star = message.is_starred ? chalk.yellow("★") : " ";
    const unread = !message.is_read ? chalk.cyan("●") : " ";
    const subject = !message.is_read ? chalk.bold(message.subject.slice(0, 50).padEnd(50)) : message.subject.slice(0, 50).padEnd(50);
    const actor = message.sentByMe ? message.to : message.from;
    const labels = message.labels.length ? chalk.magenta(` {${message.labels.join(",")}}`) : "";
    lines.push(
      `  ${star}${unread} ${chalk.dim(message.id.slice(0, 8))}  ${chalk.cyan(actor.slice(0, 28).padEnd(28))}  ${subject}  ${chalk.dim(date)}${labels}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatMailboxSources(sources: MailboxSourceSummary[]): string {
  const lines: string[] = [chalk.bold(`\nIngestion sources (${sources.length}):`)];
  for (const source of sources) {
    const badges = source.badges.length ? chalk.dim(` [${source.badges.join(", ")}]`) : "";
    const latest = source.latestReceivedAt ? chalk.dim(` latest ${source.latestReceivedAt}`) : chalk.dim(" latest never");
    lines.push(`  ${chalk.cyan(source.id.padEnd(28))} ${source.label}${badges}`);
    lines.push(`    ${source.total} total, ${source.unread} unread${latest}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatMailboxStatus(status: MailboxStatusSummary): string {
  const lines: string[] = [chalk.bold("\nMailbox folders:")];
  for (const folder of status.folders) {
    lines.push(`  ${folder.label.padEnd(10)} ${folder.count}`);
  }
  lines.push("");
  return lines.join("\n");
}

interface AttMeta { filename: string; content_type: string; size: number }
interface AttPath { filename: string; local_path?: string; s3_url?: string }

function formatAttachmentDetailList(emailId: string, attachments: AttachmentDetail[]): string {
  const lines = [chalk.bold(`\nAttachments for ${emailId.slice(0, 8)}:`)];
  for (const attachment of attachments) {
    const location = attachment.location
      ? attachment.location_type === "local" ? chalk.cyan(attachment.location) : chalk.blue(attachment.location)
      : chalk.dim("(not downloaded)");
    lines.push(`  ${attachment.filename.padEnd(40)} ${chalk.dim(`${formatAttachmentSize(attachment.size)} · ${attachment.content_type}`)}  ${location}`);
    if (attachment.file_url) lines.push(`  ${chalk.dim("link:")} ${attachment.file_url}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatEmailDetail(
  email: { id: string; from_address: string; subject: string; received_at: string; text_body?: string | null; html_body?: string | null; to_addresses: string[]; cc_addresses: string[]; is_read?: boolean; is_starred?: boolean; is_archived?: boolean; label_ids?: string[]; attachments?: AttMeta[]; attachment_paths?: AttPath[] },
  opts: { mode?: MailDataSource["mode"] } = {},
): string {
  const flags = [
    email.is_read === false ? "unread" : "read",
    email.is_starred ? "starred" : null,
    email.is_archived ? "archived" : null,
    ...(email.label_ids ?? []),
  ].filter(Boolean).join(", ");
  const atts = mergeAttachmentDetails(email.attachments, email.attachment_paths);
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
      const missingLocation = opts.mode === "self_hosted"
        ? "  (metadata only; no local download in self_hosted mode)"
        : "  (run: emails inbox sync to download)";
      const loc = a.location ? `  ${a.location_type === "local" ? chalk.cyan(a.location) : chalk.blue(a.location)}` : chalk.dim(missingLocation);
      lines.push(`     ${a.filename.padEnd(44)} ${chalk.dim(`${formatAttachmentSize(a.size)} · ${a.content_type}`)}${loc}`);
      if (a.file_url) lines.push(`     ${chalk.dim("link:")} ${a.file_url}`);
    }
  }
  lines.push("", readableMessageText(email.text_body, email.html_body) || chalk.dim("(no body)"), "");
  return lines.filter((l) => l !== "").join("\n");
}
