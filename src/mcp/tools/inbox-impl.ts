import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cappedLimit, safeOffset } from "../../db/pagination.js";
import { formatError } from "../helpers.js";
import { extractEmailLinks } from "../../lib/email-links.js";
import { resolveMailDataSource, type MailDataSource } from "../../lib/mail-data-source.js";
import {
  MAX_ATTACHMENT_DOWNLOAD_BYTES,
  writeAttachmentFile,
} from "../../lib/attachment-download.js";
import {
  MAILBOXES,
  mailboxSourceFromRef,
  type Mailbox,
  type MailboxSource,
  type MessageBody,
  type TuiMessage,
} from "../../cli/tui/data.js";

const DEFAULT_INBOUND_LIST_LIMIT = 50;
const DEFAULT_INBOUND_SEARCH_LIMIT = 20;
const MAX_MCP_INBOX_LIMIT = 1000;
const MAX_MCP_WAIT_TIMEOUT_SECONDS = 300;
const MAX_MCP_WAIT_INTERVAL_SECONDS = 60;

const waitTimeoutSchema = z.number().int().positive().max(MAX_MCP_WAIT_TIMEOUT_SECONDS).optional();
const waitIntervalSchema = z.number().int().positive().max(MAX_MCP_WAIT_INTERVAL_SECONDS).optional();

function inboxLimit(value: number | undefined, fallback: number): number {
  return cappedLimit(value, fallback, MAX_MCP_INBOX_LIMIT);
}

async function runAutoPull(_opts: { s3?: boolean; limit?: number }) {
  // Auto-pull was LOCAL S3 ingestion. The self-hosted client re-reads the API through
  // the seam on each poll, so there is nothing to pull.
  return { pulled: 0 };
}

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function mailboxFromInput(value: unknown): Mailbox {
  const normalized = String(value ?? "inbox").trim().toLowerCase();
  return MAILBOXES.includes(normalized as Mailbox) ? normalized as Mailbox : "inbox";
}

function mailboxSourceInput(input: { source_id?: string; provider_id?: string; address?: string; domain?: string }): MailboxSource | undefined {
  return mailboxSourceFromRef({
    sourceId: input.source_id,
    providerId: input.provider_id,
    address: input.address,
    domain: input.domain,
  });
}

function mailboxSourceCliFlags(source: MailboxSource | undefined): string {
  if (!source) return "";
  if (source.sourceId) return ` --source ${source.sourceId}`;
  if (source.providerId) return ` --provider ${source.providerId}`;
  if (source.address) return ` --address ${source.address}`;
  if (source.domain) return ` --domain ${source.domain}`;
  return "";
}

// Resolve a possibly-short id to a full id through the seam: local SQLite partial-id
// resolution, or a bounded self_hosted prefix match (so a truncated id works in self_hosted too,
// matching the CLI).
function resolveMailId(ds: MailDataSource, id: string): Promise<string> {
  return ds.resolveId(id);
}

function splitAddresses(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

// A body-free source scope for list_inbound_emails: unread/starred/archived collapse
// to their folder view; the residual (read/since) are applied as client-side filters.
function folderForListFlags(flags: { unread?: boolean; starred?: boolean; archived?: boolean }): Mailbox {
  if (flags.archived) return "archived";
  if (flags.starred) return "starred";
  if (flags.unread) return "unread";
  return "inbox";
}

// The read/detail projection shared by get_inbound_email (and returned by the mail
// mutation tools). Built from the seam's TuiMessage + MessageBody so self_hosted and local
// yield the same shape.
function messageDetail(msg: TuiMessage, body: MessageBody | null): Record<string, unknown> {
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
    labels: msg.labels,
    text_body: body?.text ?? null,
    html_body: body?.html ?? null,
    summary: body?.summary ?? "",
    attachments: body?.attachments ?? [],
  };
}

// The body-free mutation/summary projection: id + flags + subject, never body/headers.
function messageSummary(msg: TuiMessage): Record<string, unknown> {
  return {
    id: msg.id,
    thread_id: msg.thread_id,
    from_address: msg.from,
    to: msg.to,
    subject: msg.subject,
    received_at: msg.date,
    is_read: msg.is_read,
    is_starred: msg.is_starred,
    labels: msg.labels,
    attachments: msg.attachments,
  };
}

async function seamMessageOrThrow(ds: MailDataSource, id: string): Promise<TuiMessage> {
  const msg = await ds.getMessage(id);
  if (!msg) throw new Error(`Inbound email not found: ${id}`);
  return msg;
}

export function registerInboxTools(server: McpServer): void {
  // ─── INBOUND EMAILS ─────────────────────────────────────────────────────────
  // The latest inbound email for an address, body-free, via the seam so self_hosted mode
  // reads the API (not the empty local store). verificationCandidates already scopes
  // to recipient (client-side in self_hosted), excludes sent, and orders newest-first.
  const getLatestInboundEmailForAddress = async (
    address: string,
    filters: { since?: string; from?: string; subject?: string },
  ): Promise<Record<string, unknown> | null> => {
    const ds = resolveMailDataSource();
    const [latest] = await ds.verificationCandidates(address, {
      limit: 1,
      since: filters.since,
      from: filters.from,
      subject: filters.subject,
    });
    if (!latest) return null;
    return {
      id: latest.id,
      from_address: latest.from_address,
      subject: latest.subject,
      received_at: latest.received_at,
    };
  };

  const findVerificationMatchForAddress = async (
    address: string,
    filters: { since?: string; from?: string; subject?: string; limit?: number },
  ) => {
    const ds = resolveMailDataSource();
    return ds.findLatest(address, filters);
  };

  server.tool(
    "list_mailboxes",
    "List folder counts for a mailbox scope, optionally filtered by ingestion source.",
    {
      source_id: z.string().optional().describe("Ingestion source ID from list_mailbox_sources, e.g. provider:<id>, s3:<bucket>, legacy, or orphaned:<id>"),
      provider_id: z.string().optional().describe("Credential/capability ID used as a provenance filter"),
      address: z.string().optional().describe("Mailbox scope: exact recipient/sender address"),
      domain: z.string().optional().describe("Mailbox scope: recipient/sender domain"),
    },
    async ({ source_id, provider_id, address, domain }) => {
      try {
        const ds = resolveMailDataSource();
        const source = mailboxSourceInput({ source_id, provider_id, address, domain });
        return jsonText({
          source: source ?? null,
          ...(await ds.listMailboxStatus({ source })),
          cli_equivalent: `emails inbox mailboxes${mailboxSourceCliFlags(source)} --json`,
        });
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "list_mailbox_sources",
    "List ingestion streams with counts and legacy/orphaned badges.",
    {
      search: z.string().optional().describe("Filter sources by label, ID, kind, provider, bucket, or badge"),
      limit: z.number().int().positive().max(MAX_MCP_INBOX_LIMIT).optional().describe("Max sources (default 100, max 1000)"),
    },
    async ({ search, limit }) => {
      try {
        const ds = resolveMailDataSource();
        const sources = await ds.listMailboxSources({ search, limit: inboxLimit(limit, 100) });
        return jsonText({
          sources,
          cli_equivalent: "emails inbox sources --json",
        });
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "search_mailbox",
    "Search a mailbox folder locally, optionally filtered by ingestion source.",
    {
      query: z.string().describe("Search term to match against subject, sender, recipient, or snippet"),
      mailbox: z.enum(["inbox", "unread", "starred", "sent", "archived", "spam", "trash"]).optional().describe("Folder to search (default inbox)"),
      source_id: z.string().optional().describe("Ingestion source ID from list_mailbox_sources"),
      provider_id: z.string().optional().describe("Credential/capability ID used as a provenance filter"),
      address: z.string().optional().describe("Mailbox scope: exact recipient/sender address"),
      domain: z.string().optional().describe("Mailbox scope: recipient/sender domain"),
      label: z.string().optional().describe("Only mail carrying this label"),
      limit: z.number().int().positive().max(MAX_MCP_INBOX_LIMIT).optional().describe("Max results (default 20, max 1000)"),
      offset: z.number().int().nonnegative().optional().describe("Pagination offset (default 0)"),
    },
    async ({ query, mailbox, source_id, provider_id, address, domain, label, limit, offset }) => {
      try {
        const ds = resolveMailDataSource();
        const pageLimit = inboxLimit(limit, DEFAULT_INBOUND_SEARCH_LIMIT);
        const pageOffset = safeOffset(offset);
        const source = mailboxSourceInput({ source_id, provider_id, address, domain });
        const selectedMailbox = mailboxFromInput(mailbox);
        const rows = await ds.listMailbox(selectedMailbox, {
          search: query,
          source,
          label,
          limit: pageLimit + 1,
          offset: pageOffset,
        });
        return jsonText({
          mailbox: selectedMailbox,
          folder: selectedMailbox,
          source: source ?? null,
          query,
          items: rows.slice(0, pageLimit),
          limit: pageLimit,
          offset: pageOffset,
          truncated: rows.length > pageLimit,
          cli_equivalent: `emails inbox search ${query} --folder ${selectedMailbox}${mailboxSourceCliFlags(source)} --json`,
        });
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
  "list_inbound_emails",
  "List received inbound emails from local storage. Use list_mailboxes/list_mailbox_sources for folder and source status.",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    since: z.string().optional().describe("ISO 8601 date - only return emails received after this time"),
    limit: z.number().int().positive().max(MAX_MCP_INBOX_LIMIT).optional().describe("Max results (default 50, max 1000)"),
    offset: z.number().int().nonnegative().optional().describe("Pagination offset (default 0)"),
    unread: z.boolean().optional().describe("Only unread mail"),
    read: z.boolean().optional().describe("Only read mail"),
    starred: z.boolean().optional().describe("Only starred mail"),
    archived: z.boolean().optional().describe("Show archived mail (hidden by default)"),
    label: z.string().optional().describe("Only mail carrying this label"),
    search: z.string().optional().describe("Local search across subject, sender, recipient, and body"),
  },
  async ({ provider_id, since, limit, offset, unread, read, starred, archived, label, search }) => {
    try {
      const ds = resolveMailDataSource();
      const pageLimit = inboxLimit(limit, DEFAULT_INBOUND_LIST_LIMIT);
      const pageOffset = safeOffset(offset);
      const folder = folderForListFlags({ unread, starred, archived });
      const source = provider_id ? mailboxSourceInput({ provider_id }) : undefined;
      let rows = await ds.listMailbox(folder, {
        source,
        label,
        search,
        limit: pageLimit + 1,
        offset: pageOffset,
      });
      // read/since have no folder equivalent; apply them client-side over the seam page.
      if (read) rows = rows.filter((row) => row.is_read);
      if (since) rows = rows.filter((row) => row.date >= since);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items: rows.slice(0, pageLimit),
            limit: pageLimit,
            offset: pageOffset,
            truncated: rows.length > pageLimit,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "get_latest_inbound_email",
  "Get the latest local inbound email for an address.",
  {
    address: z.string().describe("Recipient email address"),
    from: z.string().optional().describe("Only consider messages whose From contains this text"),
    subject: z.string().optional().describe("Only consider messages whose subject contains this text"),
    since: z.string().optional().describe("Only consider messages received after this ISO date"),
    limit: z.number().int().positive().max(MAX_MCP_INBOX_LIMIT).optional().describe("Compatibility option; latest returns one filtered message"),
  },
  async ({ address, from, subject, since }) => {
    try {
      const normalized = address.trim().toLowerCase();
      const email = await getLatestInboundEmailForAddress(normalized, { since, from, subject });
      return {
        content: [{ type: "text", text: JSON.stringify({
          email,
          cli_equivalent: `emails inbox latest ${normalized} --json`,
        }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "wait_for_email",
  "Wait for the next inbound email for an address, refreshing S3 sources by default.",
  {
    address: z.string().describe("Recipient email address"),
    from: z.string().optional().describe("Only consider messages whose From contains this text"),
    subject: z.string().optional().describe("Only consider messages whose subject contains this text"),
    since: z.string().optional().describe("Only consider messages received after this ISO date"),
    timeout_seconds: waitTimeoutSchema.describe("Wait timeout (default 120, max 300)"),
    interval_seconds: waitIntervalSchema.describe("Polling interval (default 5, max 60)"),
    refresh: z.boolean().optional().describe("Refresh inbound sources while waiting (default true)"),
  },
  async ({ address, from, subject, since, timeout_seconds, interval_seconds, refresh }) => {
    try {
      const normalized = address.trim().toLowerCase();
      const deadline = Date.now() + (timeout_seconds ?? 120) * 1000;
      const intervalMs = (interval_seconds ?? 5) * 1000;
      while (true) {
        let email = await getLatestInboundEmailForAddress(normalized, { since, from, subject });
        if (email) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              email,
              cli_equivalent: `emails inbox wait ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
            }, null, 2) }],
          };
        }
        if (refresh !== false) {
          await runAutoPull({ s3: true, limit: 1000 });
          email = await getLatestInboundEmailForAddress(normalized, { since, from, subject });
          if (email) {
            return {
              content: [{ type: "text", text: JSON.stringify({
                email,
                cli_equivalent: `emails inbox wait ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
              }, null, 2) }],
            };
          }
        }
        if (Date.now() >= deadline) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              email: null,
              address: normalized,
              cli_equivalent: `emails inbox wait ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
            }, null, 2) }],
            isError: true,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "wait_for_verification_code",
  "Wait for a verification code for an inbound address, refreshing S3 sources by default.",
  {
    address: z.string().describe("Recipient email address"),
    from: z.string().optional().describe("Only consider messages whose From contains this text"),
    subject: z.string().optional().describe("Only consider messages whose subject contains this text"),
    since: z.string().optional().describe("Only consider messages received after this ISO date"),
    timeout_seconds: waitTimeoutSchema.describe("Wait timeout (default 120, max 300)"),
    interval_seconds: waitIntervalSchema.describe("Polling interval (default 5, max 60)"),
    refresh: z.boolean().optional().describe("Refresh inbound sources while waiting (default true)"),
  },
  async ({ address, from, subject, since, timeout_seconds, interval_seconds, refresh }) => {
    try {
      const normalized = address.trim().toLowerCase();
      const deadline = Date.now() + (timeout_seconds ?? 120) * 1000;
      const intervalMs = (interval_seconds ?? 5) * 1000;
      while (true) {
        let match = await findVerificationMatchForAddress(normalized, { since, limit: 50, from, subject });
        if (match) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              code: match.code,
              email_id: match.email.id,
              from: match.email.from_address,
              subject: match.email.subject,
              received_at: match.email.received_at,
              confidence: match.confidence,
              cli_equivalent: `emails inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
            }, null, 2) }],
          };
        }
        if (refresh !== false) {
          await runAutoPull({ s3: true, limit: 1000 });
          match = await findVerificationMatchForAddress(normalized, { since, limit: 50, from, subject });
          if (match) {
            return {
              content: [{ type: "text", text: JSON.stringify({
                code: match.code,
                email_id: match.email.id,
                from: match.email.from_address,
                subject: match.email.subject,
                received_at: match.email.received_at,
                confidence: match.confidence,
                cli_equivalent: `emails inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
              }, null, 2) }],
            };
          }
        }
        if (Date.now() >= deadline) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              code: null,
              address: normalized,
              cli_equivalent: `emails inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
            }, null, 2) }],
            isError: true,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "wait_for_code",
  "Alias for wait_for_verification_code: wait for a verification code for an inbound address.",
  {
    address: z.string().describe("Recipient email address"),
    from: z.string().optional().describe("Only consider messages whose From contains this text"),
    subject: z.string().optional().describe("Only consider messages whose subject contains this text"),
    since: z.string().optional().describe("Only consider messages received after this ISO date"),
    timeout_seconds: waitTimeoutSchema.describe("Wait timeout (default 120, max 300)"),
    interval_seconds: waitIntervalSchema.describe("Polling interval (default 5, max 60)"),
    refresh: z.boolean().optional().describe("Refresh inbound sources while waiting (default true)"),
  },
  async ({ address, from, subject, since, timeout_seconds, interval_seconds, refresh }) => {
    try {
      const normalized = address.trim().toLowerCase();
      const deadline = Date.now() + (timeout_seconds ?? 120) * 1000;
      const intervalMs = (interval_seconds ?? 5) * 1000;
      while (true) {
        let match = await findVerificationMatchForAddress(normalized, { since, limit: 50, from, subject });
        if (match) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              code: match.code,
              email_id: match.email.id,
              from: match.email.from_address,
              subject: match.email.subject,
              received_at: match.email.received_at,
              confidence: match.confidence,
              cli_equivalent: `emails inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
            }, null, 2) }],
          };
        }
        if (refresh !== false) {
          await runAutoPull({ s3: true, limit: 1000 });
          match = await findVerificationMatchForAddress(normalized, { since, limit: 50, from, subject });
          if (match) {
            return {
              content: [{ type: "text", text: JSON.stringify({
                code: match.code,
                email_id: match.email.id,
                from: match.email.from_address,
                subject: match.email.subject,
                received_at: match.email.received_at,
                confidence: match.confidence,
                cli_equivalent: `emails inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
              }, null, 2) }],
            };
          }
        }
        if (Date.now() >= deadline) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              code: null,
              address: normalized,
              cli_equivalent: `emails inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
            }, null, 2) }],
            isError: true,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "get_inbound_email",
  "Get a specific inbound email by ID",
  {
    id: z.string().describe("Inbound email ID (or prefix)"),
  },
  async ({ id }) => {
    try {
      const ds = resolveMailDataSource();
      const msg = await seamMessageOrThrow(ds, await resolveMailId(ds, id));
      const body = await ds.getMessageBody(msg);
      return { content: [{ type: "text", text: JSON.stringify(messageDetail(msg, body), null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "extract_inbound_email_links",
  "Extract links from a specific inbound email by ID. Read-only.",
  {
    id: z.string().describe("Inbound email ID (or prefix)"),
    include_non_web: z.boolean().optional().describe("Include mailto: and tel: links"),
  },
  async ({ id, include_non_web }) => {
    try {
      const ds = resolveMailDataSource();
      const msg = await seamMessageOrThrow(ds, await resolveMailId(ds, id));
      const body = await ds.getMessageBody(msg);
      return {
        content: [{ type: "text", text: JSON.stringify({
          email_id: msg.id,
          from: body?.from ?? msg.from,
          subject: body?.subject ?? msg.subject,
          received_at: body?.date ?? msg.date,
          links: extractEmailLinks({
            text: body?.text ?? null,
            html: body?.html ?? null,
            includeNonWeb: include_non_web === true,
          }),
          cli_equivalent: `emails inbox links ${msg.id} --json${include_non_web ? " --all" : ""}`,
        }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "clear_inbound_emails",
  "Delete all inbound emails, optionally filtered by provider",
  {
    provider_id: z.string().optional().describe("Only clear emails for this provider"),
  },
  async ({ provider_id }) => {
    try {
      // local: wipes the inbound store (optionally by provider). self_hosted: drains a
      // server-side bulk delete over the inbox folder through the seam.
      const ds = resolveMailDataSource();
      const { cleared } = await ds.clear({ providerId: provider_id });
      return { content: [{ type: "text", text: `Cleared ${cleared} inbound email(s)` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "mark_email_read",
  "Mark an inbound email as read (local state)",
  { email_id: z.string(), unread: z.boolean().optional().describe("Mark unread instead") },
  async ({ email_id, unread }) => {
    try {
      const ds = resolveMailDataSource();
      const fullId = await resolveMailId(ds, email_id);
      await ds.setRead(fullId, !unread);
      const msg = await seamMessageOrThrow(ds, fullId);
      return { content: [{ type: "text", text: JSON.stringify(messageSummary(msg), null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "archive_email",
  "Archive (or unarchive) an inbound email (local state)",
  { email_id: z.string(), unarchive: z.boolean().optional().describe("Restore to inbox instead") },
  async ({ email_id, unarchive }) => {
    try {
      const ds = resolveMailDataSource();
      const fullId = await resolveMailId(ds, email_id);
      await ds.setArchived(fullId, !unarchive);
      const msg = await seamMessageOrThrow(ds, fullId);
      return { content: [{ type: "text", text: JSON.stringify(messageSummary(msg), null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "star_email",
  "Star (or unstar) an inbound email (local state)",
  { email_id: z.string(), unstar: z.boolean().optional().describe("Remove the star instead") },
  async ({ email_id, unstar }) => {
    try {
      const ds = resolveMailDataSource();
      const fullId = await resolveMailId(ds, email_id);
      await ds.setStarred(fullId, !unstar);
      const msg = await seamMessageOrThrow(ds, fullId);
      return { content: [{ type: "text", text: JSON.stringify(messageSummary(msg), null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "label_email",
  "Add or remove a label on an inbound email (local state)",
  { email_id: z.string(), label: z.string(), remove: z.boolean().optional().describe("Remove the label instead of adding") },
  async ({ email_id, label, remove }) => {
    try {
      const ds = resolveMailDataSource();
      const fullId = await resolveMailId(ds, email_id);
      const labels = remove ? await ds.removeLabel(fullId, label) : await ds.addLabel(fullId, label);
      const msg = await seamMessageOrThrow(ds, fullId);
      return { content: [{ type: "text", text: JSON.stringify({ ...messageSummary(msg), labels }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "get_attachment",
  "List attachment metadata and any existing local/S3 location. This does not download content.",
  {
    email_id: z.string().describe("Inbound email ID"),
    filename: z.string().optional().describe("Filter by filename (returns all if omitted)"),
  },
  async ({ email_id, filename }) => {
    try {
      const ds = resolveMailDataSource();
      const fullId = await resolveMailId(ds, email_id);
      const msg = await ds.getMessage(fullId);
      if (!msg) return { content: [{ type: "text", text: `Email not found: ${email_id}` }], isError: true };
      const paths = await ds.getAttachmentPaths(fullId);
      const filtered = filename ? paths.filter((p) => p.filename === filename) : paths;
      return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "download_attachment",
  "Deliberately download one attachment from an exact inbound email ID to a safe local file. Writes one collision-proof mode-0600 file and never returns attachment bytes.",
  {
    email_id: z.string().describe("Exact full inbound email ID (prefixes are rejected for downloads)"),
    index: z.number().int().nonnegative().describe("Zero-based attachment index"),
    output_dir: z.string().min(1).describe("Existing or creatable local output directory"),
    max_bytes: z.number().int().positive().max(MAX_ATTACHMENT_DOWNLOAD_BYTES).optional()
      .describe(`Maximum decoded bytes (hard cap ${MAX_ATTACHMENT_DOWNLOAD_BYTES})`),
  },
  async ({ email_id, index, output_dir, max_bytes }) => {
    try {
      const ds = resolveMailDataSource();
      const msg = await ds.getMessage(email_id);
      if (!msg || msg.id !== email_id) {
        return {
          content: [{ type: "text", text: "Error: attachment download requires the exact full message id" }],
          isError: true,
        };
      }
      const content = await ds.getAttachmentContent(email_id, index, { maxBytes: max_bytes });
      if (content.state === "not_found") {
        return { content: [{ type: "text", text: `Attachment index ${index} not found` }], isError: true };
      }
      if (content.state === "content_unavailable") {
        return {
          content: [{ type: "text", text: JSON.stringify({
            state: content.state,
            index: content.index,
            filename: content.filename,
            content_type: content.content_type,
            bytes: content.bytes,
          }, null, 2) }],
          isError: true,
        };
      }
      return jsonText(await writeAttachmentFile(content, output_dir));
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "search_inbound",
  "Search synced inbound emails in local SQLite by subject, sender, recipient, or body text",
  {
    query: z.string().describe("Search term to match against subject, from address, recipient address, or body"),
    provider_id: z.string().optional().describe("Filter by provider ID"),
    limit: z.number().int().positive().max(MAX_MCP_INBOX_LIMIT).optional().describe("Max results (default 20, max 1000)"),
    offset: z.number().int().nonnegative().optional().describe("Pagination offset (default 0)"),
  },
  async ({ query, provider_id, limit, offset }) => {
    try {
      const ds = resolveMailDataSource();
      const pageLimit = inboxLimit(limit, DEFAULT_INBOUND_SEARCH_LIMIT);
      const pageOffset = safeOffset(offset);
      const source = provider_id ? mailboxSourceInput({ provider_id }) : undefined;
      const rows = await ds.listMailbox("inbox", {
        source,
        search: query,
        limit: pageLimit + 1,
        offset: pageOffset,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items: rows.slice(0, pageLimit),
            limit: pageLimit,
            offset: pageOffset,
            truncated: rows.length > pageLimit,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
    "get_inbox_sync_status",
    "Get source-aware mailbox sync status for S3 ingestion and realtime queue.",
    {},
    async () => {
      try {
        const { getEmailSystemStatusForRuntime } = await import("../../lib/agent-context.js");
        const status = await getEmailSystemStatusForRuntime();
        return { content: [{ type: "text", text: JSON.stringify({
          inbox: status.inbox,
          mailboxes: status.mailboxes,
          sources: status.sources,
          cli_equivalent: "emails inbox sync-status --json",
        }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type InboxToolName =
  | "list_mailboxes"
  | "list_mailbox_sources"
  | "search_mailbox"
  | "list_inbound_emails"
  | "get_latest_inbound_email"
  | "wait_for_email"
  | "wait_for_verification_code"
  | "wait_for_code"
  | "get_inbound_email"
  | "extract_inbound_email_links"
  | "clear_inbound_emails"
  | "mark_email_read"
  | "archive_email"
  | "star_email"
  | "label_email"
  | "get_attachment"
  | "download_attachment"
  | "search_inbound"
  | "get_inbox_sync_status";

type ToolHandler = (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

let cachedInboxHandlers: Map<InboxToolName, ToolHandler> | null = null;

function getInboxHandlers(): Map<InboxToolName, ToolHandler> {
  if (cachedInboxHandlers) return cachedInboxHandlers;

  const handlers = new Map<InboxToolName, ToolHandler>();
  const server = {
    tool(toolName: string, _description: string, _schema: unknown, toolHandler: ToolHandler) {
      handlers.set(toolName as InboxToolName, toolHandler);
    },
  } as unknown as McpServer;

  registerInboxTools(server);
  cachedInboxHandlers = handlers;
  return handlers;
}

export async function runInboxTool(name: InboxToolName, input: Record<string, unknown>): Promise<ToolResult> {
  const toolHandler = getInboxHandlers().get(name);

  if (!toolHandler) {
    return { content: [{ type: "text", text: `Error: Unknown inbox tool: ${name}` }], isError: true };
  }
  return await toolHandler(input);
}
