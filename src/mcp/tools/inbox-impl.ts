import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listInboundEmailSummaries, getInboundEmail, clearInboundEmails,
  getInboundAttachmentPaths,
  setInboundReadSummary, setInboundArchivedSummary, setInboundStarredSummary,
  addInboundLabelSummary, removeInboundLabelSummary,
} from "../../db/inbound.js";
import { getDatabase } from "../../db/database.js";
import { cappedLimit, safeOffset } from "../../db/pagination.js";
import { formatError, resolveId } from "../helpers.js";
import { findVerificationCode, listVerificationCodeCandidates } from "../../lib/verification-code.js";
import { extractEmailLinks } from "../../lib/email-links.js";
import {
  MAILBOXES,
  listMailboxSources,
  listMailboxStatus,
  searchMailbox,
  mailboxSourceFromRef,
  type Mailbox,
  type MailboxSource,
} from "../../cli/tui/data.js";
import { getSelfHostedRuntimeStatus } from "../../lib/self-hosted-runtime.js";
import {
  addSelfHostedInboundLabel,
  assertSelfHostedDirectRuntimeConfigured,
  clearSelfHostedInboundEmails,
  getLatestSelfHostedInboundEmail,
  getSelfHostedInboundAttachmentPaths,
  getSelfHostedInboundEmail,
  getSelfHostedInboxStatus,
  getSelfHostedMailboxStatus,
  listSelfHostedInboundEmailSummaries,
  listSelfHostedSourceSummaries,
  listSelfHostedVerificationCodeCandidates,
  removeSelfHostedInboundLabel,
  setSelfHostedInboundArchived,
  setSelfHostedInboundRead,
  setSelfHostedInboundStarred,
  type ListSelfHostedInboundOpts,
  type SelfHostedMailbox,
} from "../../db/self-hosted-inbound.js";

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

async function runAutoPull(opts: { s3?: boolean; limit?: number }) {
  const { autoPull } = await import("../../cli/tui/autopull.js");
  return autoPull(opts);
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

function selfHostedRuntimeRequested(): boolean {
  return getSelfHostedRuntimeStatus().enabled;
}

function requireSelfHostedRuntime(): void {
  assertSelfHostedDirectRuntimeConfigured();
}

function selfHostedSourceOptions(source: MailboxSource | undefined): Pick<ListSelfHostedInboundOpts, "provider_id" | "sourceId" | "s3Bucket" | "legacy"> | undefined {
  if (!source) return undefined;
  let providerId = source.providerId;
  let s3Bucket = source.s3Bucket;
  let legacy = source.legacy;
  const sourceId = source.sourceId;
  if (sourceId === "legacy") legacy = true;
  else if (sourceId?.startsWith("provider:")) providerId = sourceId.slice("provider:".length);
  else if (sourceId?.startsWith("orphaned:")) providerId = sourceId.slice("orphaned:".length);
  else if (sourceId?.startsWith("s3:")) s3Bucket = decodeURIComponent(sourceId.slice("s3:".length));
  return { provider_id: providerId, sourceId, s3Bucket, legacy };
}

export function registerInboxTools(server: McpServer): void {
  // ─── INBOUND EMAILS ─────────────────────────────────────────────────────────
  const getLatestInboundEmailForAddress = async (
    address: string,
    filters: { since?: string; from?: string; subject?: string },
  ) => {
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      return await getLatestSelfHostedInboundEmail(address, filters);
    }
    const db = getDatabase();
    return listInboundEmailSummaries({
      recipients: [address],
      since: filters.since,
      from: filters.from,
      subject: filters.subject,
      limit: 1,
    }, db)[0] ?? null;
  };

  const findVerificationMatchForAddress = async (
    address: string,
    filters: { since?: string; from?: string; subject?: string; limit?: number },
  ) => {
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      const candidates = await listSelfHostedVerificationCodeCandidates(address, filters);
      return findVerificationCode(candidates, filters);
    }
    const candidates = listVerificationCodeCandidates(address, filters);
    return findVerificationCode(candidates, filters);
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
        const source = mailboxSourceInput({ source_id, provider_id, address, domain });
        if (selfHostedRuntimeRequested()) {
          requireSelfHostedRuntime();
          return jsonText({
            source: source ?? null,
            ...await getSelfHostedMailboxStatus(selfHostedSourceOptions(source)),
            cli_equivalent: `mailery inbox mailboxes${mailboxSourceCliFlags(source)} --json`,
          });
        }
        return jsonText({
          source: source ?? null,
          ...listMailboxStatus({ source }),
          cli_equivalent: `mailery inbox mailboxes${mailboxSourceCliFlags(source)} --json`,
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
        if (selfHostedRuntimeRequested()) {
          requireSelfHostedRuntime();
          const sources = await listSelfHostedSourceSummaries({ search, limit: inboxLimit(limit, 100) });
          return jsonText({
            sources,
            cli_equivalent: "mailery inbox sources --json",
          });
        }
        const sources = listMailboxSources({ search, limit: inboxLimit(limit, 100) });
        return jsonText({
          sources,
          cli_equivalent: "mailery inbox sources --json",
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
        const pageLimit = inboxLimit(limit, DEFAULT_INBOUND_SEARCH_LIMIT);
        const pageOffset = safeOffset(offset);
        const source = mailboxSourceInput({ source_id, provider_id, address, domain });
        const selectedMailbox = mailboxFromInput(mailbox);
        if (selfHostedRuntimeRequested()) {
          requireSelfHostedRuntime();
          const rows = await listSelfHostedInboundEmailSummaries({
            ...selfHostedSourceOptions(source),
            mailbox: selectedMailbox as SelfHostedMailbox,
            label,
            search: query,
            recipients: source?.address ? [source.address] : undefined,
            recipientDomains: source?.domain ? [source.domain] : undefined,
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
            cli_equivalent: `mailery inbox search ${query} --folder ${selectedMailbox}${mailboxSourceCliFlags(source)} --json`,
          });
        }
        const rows = searchMailbox(query, {
          mailbox: selectedMailbox,
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
          cli_equivalent: `mailery inbox search ${query} --folder ${selectedMailbox}${mailboxSourceCliFlags(source)} --json`,
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
      const pageLimit = inboxLimit(limit, DEFAULT_INBOUND_LIST_LIMIT);
      const pageOffset = safeOffset(offset);
      const emails = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), listSelfHostedInboundEmailSummaries({
          provider_id,
          since,
          limit: pageLimit + 1,
          offset: pageOffset,
          unread,
          read,
          starred,
          archived,
          label,
          search,
        }))
        : listInboundEmailSummaries({
        provider_id,
        since,
        limit: pageLimit + 1,
        offset: pageOffset,
        unread,
        read,
        starred,
        archived,
        label,
        search,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items: emails.slice(0, pageLimit),
            limit: pageLimit,
            offset: pageOffset,
            truncated: emails.length > pageLimit,
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
          cli_equivalent: `mailery inbox latest ${normalized} --json`,
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
              cli_equivalent: `mailery inbox wait ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
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
                cli_equivalent: `mailery inbox wait ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
              }, null, 2) }],
            };
          }
        }
        if (Date.now() >= deadline) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              email: null,
              address: normalized,
              cli_equivalent: `mailery inbox wait ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
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
              cli_equivalent: `mailery inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
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
                cli_equivalent: `mailery inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
              }, null, 2) }],
            };
          }
        }
        if (Date.now() >= deadline) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              code: null,
              address: normalized,
              cli_equivalent: `mailery inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
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
              cli_equivalent: `mailery inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
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
                cli_equivalent: `mailery inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
              }, null, 2) }],
            };
          }
        }
        if (Date.now() >= deadline) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              code: null,
              address: normalized,
              cli_equivalent: `mailery inbox wait-code ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
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
      const email = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), getSelfHostedInboundEmail(id))
        : getInboundEmail(resolveId("inbound_emails", id));
      if (!email) throw new Error(`Inbound email not found: ${id}`);
      return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
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
      const email = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), getSelfHostedInboundEmail(id))
        : getInboundEmail(resolveId("inbound_emails", id));
      if (!email) throw new Error(`Inbound email not found: ${id}`);
      return {
        content: [{ type: "text", text: JSON.stringify({
          email_id: email.id,
          from: email.from_address,
          subject: email.subject,
          received_at: email.received_at,
          links: extractEmailLinks({
            text: email.text_body,
            html: email.html_body,
            includeNonWeb: include_non_web === true,
          }),
          cli_equivalent: `mailery inbox links ${email.id} --json${include_non_web ? " --all" : ""}`,
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
      const count = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), clearSelfHostedInboundEmails(provider_id))
        : clearInboundEmails(provider_id);
      return { content: [{ type: "text", text: `Cleared ${count} inbound email(s)` }] };
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
      const e = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), setSelfHostedInboundRead(email_id, !unread))
        : setInboundReadSummary(resolveId("inbound_emails", email_id), !unread);
      return { content: [{ type: "text", text: JSON.stringify(e, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "archive_email",
  "Archive (or unarchive) an inbound email (local state)",
  { email_id: z.string(), unarchive: z.boolean().optional().describe("Restore to inbox instead") },
  async ({ email_id, unarchive }) => {
    try {
      const e = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), setSelfHostedInboundArchived(email_id, !unarchive))
        : setInboundArchivedSummary(resolveId("inbound_emails", email_id), !unarchive);
      return { content: [{ type: "text", text: JSON.stringify(e, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "star_email",
  "Star (or unstar) an inbound email (local state)",
  { email_id: z.string(), unstar: z.boolean().optional().describe("Remove the star instead") },
  async ({ email_id, unstar }) => {
    try {
      const e = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), setSelfHostedInboundStarred(email_id, !unstar))
        : setInboundStarredSummary(resolveId("inbound_emails", email_id), !unstar);
      return { content: [{ type: "text", text: JSON.stringify(e, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "label_email",
  "Add or remove a label on an inbound email (local state)",
  { email_id: z.string(), label: z.string(), remove: z.boolean().optional().describe("Remove the label instead of adding") },
  async ({ email_id, label, remove }) => {
    try {
      const e = selfHostedRuntimeRequested()
        ? await (
          requireSelfHostedRuntime(),
          remove
            ? removeSelfHostedInboundLabel(email_id, label)
            : addSelfHostedInboundLabel(email_id, label)
        )
        : remove
          ? removeInboundLabelSummary(resolveId("inbound_emails", email_id), label)
          : addInboundLabelSummary(resolveId("inbound_emails", email_id), label);
      return { content: [{ type: "text", text: JSON.stringify(e, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "get_attachment",
  "Get local path or S3 URL for downloaded attachments on a synced inbound email",
  {
    email_id: z.string().describe("Inbound email ID"),
    filename: z.string().optional().describe("Filter by filename (returns all if omitted)"),
  },
  async ({ email_id, filename }) => {
    try {
      const paths = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), getSelfHostedInboundAttachmentPaths(email_id))
        : getInboundAttachmentPaths(resolveId("inbound_emails", email_id));
      if (!paths) return { content: [{ type: "text", text: `Email not found: ${email_id}` }], isError: true };
      const filtered = filename ? paths.filter((p) => p.filename === filename) : paths;
      return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
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
      const pageLimit = inboxLimit(limit, DEFAULT_INBOUND_SEARCH_LIMIT);
      const pageOffset = safeOffset(offset);
      const emails = selfHostedRuntimeRequested()
        ? await (requireSelfHostedRuntime(), listSelfHostedInboundEmailSummaries({
          provider_id,
          limit: pageLimit + 1,
          offset: pageOffset,
          search: query,
        }))
        : listInboundEmailSummaries({
        provider_id,
        limit: pageLimit + 1,
        offset: pageOffset,
        search: query,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items: emails.slice(0, pageLimit),
            limit: pageLimit,
            offset: pageOffset,
            truncated: emails.length > pageLimit,
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
        if (selfHostedRuntimeRequested()) {
          requireSelfHostedRuntime();
          const status = await getSelfHostedInboxStatus();
          return { content: [{ type: "text", text: JSON.stringify({
            inbox: {
              total: status.total,
              unread: status.unread,
              latest_received_at: status.latest_received_at,
            },
            mailboxes: status.mailboxes,
            sources: status.sources,
            cli_equivalent: "mailery inbox sync-status --json",
          }, null, 2) }] };
        }
        const { getEmailSystemStatus } = await import("../../lib/agent-context.js");
        const status = getEmailSystemStatus();
        return { content: [{ type: "text", text: JSON.stringify({
          inbox: status.inbox,
          mailboxes: status.mailboxes,
          sources: status.sources,
          cli_equivalent: "mailery inbox sync-status --json",
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
