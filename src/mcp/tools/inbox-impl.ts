import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listInboundEmailSummaries, getInboundEmail, clearInboundEmails,
  getInboundAttachmentPaths,
  setInboundReadSummary, setInboundArchivedSummary, setInboundStarredSummary,
  addInboundLabelSummary, removeInboundLabelSummary,
} from "../../db/inbound.js";
import { updateLastSynced } from "../../db/gmail-sync-state.js";
import { getDatabase } from "../../db/database.js";
import { cappedLimit, safeOffset } from "../../db/pagination.js";
import { formatError, resolveId } from "../helpers.js";
import { findVerificationCode, listVerificationCodeCandidates } from "../../lib/verification-code.js";

const DEFAULT_INBOUND_LIST_LIMIT = 50;
const DEFAULT_INBOUND_SEARCH_LIMIT = 20;
const DEFAULT_GMAIL_SYNC_LIMIT = 50;
const MAX_MCP_INBOX_LIMIT = 1000;
const MAX_MCP_WAIT_TIMEOUT_SECONDS = 300;
const MAX_MCP_WAIT_INTERVAL_SECONDS = 60;

const waitTimeoutSchema = z.number().int().positive().max(MAX_MCP_WAIT_TIMEOUT_SECONDS).optional();
const waitIntervalSchema = z.number().int().positive().max(MAX_MCP_WAIT_INTERVAL_SECONDS).optional();

function inboxLimit(value: number | undefined, fallback: number): number {
  return cappedLimit(value, fallback, MAX_MCP_INBOX_LIMIT);
}

async function runAutoPull(opts: { s3?: boolean; gmail?: boolean; limit?: number }) {
  const { autoPull } = await import("../../cli/tui/autopull.js");
  return autoPull(opts);
}

export function registerInboxTools(server: McpServer): void {
// ─── INBOUND EMAILS ───────────────────────────────────────────────────────────
  const getLatestInboundEmailSummaryForAddress = (
    address: string,
    filters: { since?: string; from?: string; subject?: string },
  ) => {
    const db = getDatabase();
    return listInboundEmailSummaries({
      recipients: [address],
      since: filters.since,
      from: filters.from,
      subject: filters.subject,
      limit: 1,
    }, db)[0] ?? null;
  };

  server.tool(
  "list_inbound_emails",
  "List received inbound emails",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    since: z.string().optional().describe("ISO 8601 date — only return emails received after this time"),
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
      const emails = listInboundEmailSummaries({
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
      const email = getLatestInboundEmailSummaryForAddress(normalized, { since, from, subject });
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
    gmail: z.boolean().optional().describe("Also pull Gmail while refreshing (default false)"),
  },
  async ({ address, from, subject, since, timeout_seconds, interval_seconds, refresh, gmail }) => {
    try {
      const normalized = address.trim().toLowerCase();
      const deadline = Date.now() + (timeout_seconds ?? 120) * 1000;
      const intervalMs = (interval_seconds ?? 5) * 1000;
      const findLocalEmail = () => getLatestInboundEmailSummaryForAddress(normalized, { since, from, subject });
      while (true) {
        let email = findLocalEmail();
        if (email) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              email,
              cli_equivalent: `emails inbox wait ${normalized} --timeout ${timeout_seconds ?? 120} --json`,
            }, null, 2) }],
          };
        }
        if (refresh !== false) {
          await runAutoPull({ s3: true, gmail: gmail === true, limit: 1000 });
          email = findLocalEmail();
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
    gmail: z.boolean().optional().describe("Also pull Gmail while refreshing (default false)"),
  },
  async ({ address, from, subject, since, timeout_seconds, interval_seconds, refresh, gmail }) => {
    try {
      const normalized = address.trim().toLowerCase();
      const deadline = Date.now() + (timeout_seconds ?? 120) * 1000;
      const intervalMs = (interval_seconds ?? 5) * 1000;
      const findLocalMatch = () => {
        const candidates = listVerificationCodeCandidates(normalized, { since, limit: 50, from, subject });
        return findVerificationCode(candidates, { from, subject });
      };
      while (true) {
        let match = findLocalMatch();
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
          await runAutoPull({ s3: true, gmail: gmail === true, limit: 1000 });
          match = findLocalMatch();
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
    gmail: z.boolean().optional().describe("Also pull Gmail while refreshing (default false)"),
  },
  async ({ address, from, subject, since, timeout_seconds, interval_seconds, refresh, gmail }) => {
    try {
      const normalized = address.trim().toLowerCase();
      const deadline = Date.now() + (timeout_seconds ?? 120) * 1000;
      const intervalMs = (interval_seconds ?? 5) * 1000;
      const findLocalMatch = () => {
        const candidates = listVerificationCodeCandidates(normalized, { since, limit: 50, from, subject });
        return findVerificationCode(candidates, { from, subject });
      };
      while (true) {
        let match = findLocalMatch();
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
          await runAutoPull({ s3: true, gmail: gmail === true, limit: 1000 });
          match = findLocalMatch();
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
      const resolvedId = resolveId("inbound_emails", id);
      const email = getInboundEmail(resolvedId);
      if (!email) throw new Error(`Inbound email not found: ${id}`);
      return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
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
      const count = clearInboundEmails(provider_id);
      return { content: [{ type: "text", text: `Cleared ${count} inbound email(s)` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

// ─── GMAIL INBOX SYNC ─────────────────────────────────────────────────────────

  server.tool(
  "sync_inbox",
  "Sync Gmail inbox messages into local SQLite. Fetches new messages via the Gmail connector and stores them for offline access.",
  {
    provider_id: z.string().describe("Gmail provider ID to sync"),
    label: z.string().optional().describe("Gmail label to sync (default: INBOX)"),
    query: z.string().optional().describe("Gmail search query, e.g. 'is:unread from:someone@example.com'"),
    limit: z.number().int().positive().max(MAX_MCP_INBOX_LIMIT).optional().describe("Max messages per run (default 50, max 1000)"),
    since: z.string().optional().describe("Only sync messages after this ISO date"),
    all_pages: z.boolean().optional().describe("Sync all pages until done (for full backfill)"),
    history: z.boolean().optional().describe("Use stored Gmail history cursor for incremental sync"),
  },
  async ({ provider_id, label, query, limit, since, all_pages, history }) => {
    try {
      const { syncGmailInbox, syncGmailInboxAll, syncGmailInboxHistory } = await import("../../lib/gmail-sync.js");
      const db = getDatabase();
      const batchSize = inboxLimit(limit, DEFAULT_GMAIL_SYNC_LIMIT);
      const opts = {
        providerId: provider_id,
        labelFilter: label,
        query,
        batchSize,
        since,
        db,
      };
      const result = all_pages
        ? await syncGmailInboxAll(opts)
        : history
          ? await syncGmailInboxHistory(opts)
        : await syncGmailInbox(opts);

      updateLastSynced(provider_id, undefined, db);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            synced: result.synced,
            skipped: result.skipped,
            attachments_saved: result.attachments_saved,
            errors: result.errors,
            done: result.done,
            nextPageToken: result.nextPageToken,
            batch_size: batchSize,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

/**
 * Best-effort Gmail mirror of a local state change. Only attempts the connector
 * when the inbound email belongs to a Gmail-type provider; for SES-S3 (or any
 * non-Gmail) mail the local state change stands on its own. Returns true if the
 * Gmail action ran.
 */
async function gmailMessageAction(email_id: string, connectorArgs: string[]): Promise<boolean> {
  const db = getDatabase();
  const row = db.query(
    `SELECT i.message_id AS message_id, p.type AS provider_type
       FROM inbound_emails i LEFT JOIN providers p ON p.id = i.provider_id
      WHERE i.id = ?`,
  ).get(email_id) as { message_id: string | null; provider_type: string | null } | null;
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

  server.tool(
  "mark_email_read",
  "Mark an inbound email as read (local state; mirrors to Gmail when applicable)",
  { email_id: z.string(), unread: z.boolean().optional().describe("Mark unread instead") },
  async ({ email_id, unread }) => {
    try {
      const id = resolveId("inbound_emails", email_id);
      const e = setInboundReadSummary(id, !unread);
      const synced = await gmailMessageAction(id, ["messages", unread ? "mark-unread" : "mark-read"]).catch(() => false);
      return { content: [{ type: "text", text: JSON.stringify({ ...e, gmail_synced: synced }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "archive_email",
  "Archive (or unarchive) an inbound email (local state; mirrors to Gmail when applicable)",
  { email_id: z.string(), unarchive: z.boolean().optional().describe("Restore to inbox instead") },
  async ({ email_id, unarchive }) => {
    try {
      const id = resolveId("inbound_emails", email_id);
      const e = setInboundArchivedSummary(id, !unarchive);
      const synced = unarchive ? false : await gmailMessageAction(id, ["messages", "archive"]).catch(() => false);
      return { content: [{ type: "text", text: JSON.stringify({ ...e, gmail_synced: synced }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "star_email",
  "Star (or unstar) an inbound email (local state; mirrors to Gmail when applicable)",
  { email_id: z.string(), unstar: z.boolean().optional().describe("Remove the star instead") },
  async ({ email_id, unstar }) => {
    try {
      const id = resolveId("inbound_emails", email_id);
      const e = setInboundStarredSummary(id, !unstar);
      const synced = unstar ? false : await gmailMessageAction(id, ["messages", "star"]).catch(() => false);
      return { content: [{ type: "text", text: JSON.stringify({ ...e, gmail_synced: synced }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "label_email",
  "Add or remove a label on an inbound email (local state)",
  { email_id: z.string(), label: z.string(), remove: z.boolean().optional().describe("Remove the label instead of adding") },
  async ({ email_id, label, remove }) => {
    try {
      const id = resolveId("inbound_emails", email_id);
      const e = remove ? removeInboundLabelSummary(id, label) : addInboundLabelSummary(id, label);
      return { content: [{ type: "text", text: JSON.stringify(e, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
);

  server.tool(
  "reply_to_email",
  "Reply to a synced inbound Gmail email, keeping it in the same thread",
  {
    email_id: z.string().describe("Inbound email ID (from local DB)"),
    body: z.string().describe("Reply body text"),
    is_html: z.boolean().optional().describe("Send as HTML email (default: false)"),
  },
  async ({ email_id, body, is_html }) => {
    try {
      const db = getDatabase();
      const row = db.query("SELECT message_id, subject FROM inbound_emails WHERE id = ?").get(email_id) as { message_id: string; subject: string } | null;
      if (!row?.message_id) throw new Error(`Email not found or no Gmail message ID: ${email_id}`);
      const { runConnectorOperation } = await import("@hasna/connectors");
      const r = await runConnectorOperation({
        connector: "gmail",
        operation: "messages.reply",
        input: { args: [row.message_id], body, ...(is_html ? { html: true } : {}) },
      });
      if (!r.success) throw new Error(r.stderr || r.stdout);
      return { content: [{ type: "text", text: JSON.stringify({ replied_to: row.subject, status: "sent" }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
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
      const id = resolveId("inbound_emails", email_id);
      const paths = getInboundAttachmentPaths(id);
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
      const emails = listInboundEmailSummaries({
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
  "Get source-aware inbox sync status for S3, realtime queue, and Gmail providers.",
  {},
  async () => {
    try {
      const { getEmailSystemStatus } = await import("../../lib/agent-context.js");
      const status = getEmailSystemStatus();
      return { content: [{ type: "text", text: JSON.stringify({
        inbox: status.inbox,
        gmail: status.providers.gmail,
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
  | "list_inbound_emails"
  | "get_latest_inbound_email"
  | "wait_for_email"
  | "wait_for_verification_code"
  | "wait_for_code"
  | "get_inbound_email"
  | "clear_inbound_emails"
  | "sync_inbox"
  | "mark_email_read"
  | "archive_email"
  | "star_email"
  | "label_email"
  | "reply_to_email"
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
