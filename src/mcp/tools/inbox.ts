import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MAX_MCP_INBOX_LIMIT = 1000;
const MAX_MCP_WAIT_TIMEOUT_SECONDS = 300;
const MAX_MCP_WAIT_INTERVAL_SECONDS = 60;

const waitTimeoutSchema = z.number().int().positive().max(MAX_MCP_WAIT_TIMEOUT_SECONDS).optional();
const waitIntervalSchema = z.number().int().positive().max(MAX_MCP_WAIT_INTERVAL_SECONDS).optional();

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

async function runInboxTool(name: InboxToolName, input: Record<string, unknown>) {
  const { runInboxTool: run } = await import("./inbox-impl.js");
  return run(name, input);
}

function handler(name: InboxToolName) {
  return async (input: unknown) => runInboxTool(name, input as Record<string, unknown>);
}

export function registerInboxTools(server: McpServer): void {
  server.tool(
    "list_inbound_emails",
    "List received inbound emails",
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
    handler("list_inbound_emails"),
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
    handler("get_latest_inbound_email"),
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
    handler("wait_for_email"),
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
    handler("wait_for_verification_code"),
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
    handler("wait_for_code"),
  );

  server.tool(
    "get_inbound_email",
    "Get a specific inbound email by ID",
    {
      id: z.string().describe("Inbound email ID (or prefix)"),
    },
    handler("get_inbound_email"),
  );

  server.tool(
    "clear_inbound_emails",
    "Delete all inbound emails, optionally filtered by provider",
    {
      provider_id: z.string().optional().describe("Only clear emails for this provider"),
    },
    handler("clear_inbound_emails"),
  );

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
    handler("sync_inbox"),
  );

  server.tool(
    "mark_email_read",
    "Mark an inbound email as read (local state; mirrors to Gmail when applicable)",
    {
      email_id: z.string(),
      unread: z.boolean().optional().describe("Mark unread instead"),
    },
    handler("mark_email_read"),
  );

  server.tool(
    "archive_email",
    "Archive (or unarchive) an inbound email (local state; mirrors to Gmail when applicable)",
    {
      email_id: z.string(),
      unarchive: z.boolean().optional().describe("Restore to inbox instead"),
    },
    handler("archive_email"),
  );

  server.tool(
    "star_email",
    "Star (or unstar) an inbound email (local state; mirrors to Gmail when applicable)",
    {
      email_id: z.string(),
      unstar: z.boolean().optional().describe("Remove the star instead"),
    },
    handler("star_email"),
  );

  server.tool(
    "label_email",
    "Add or remove a label on an inbound email (local state)",
    {
      email_id: z.string(),
      label: z.string(),
      remove: z.boolean().optional().describe("Remove the label instead of adding"),
    },
    handler("label_email"),
  );

  server.tool(
    "reply_to_email",
    "Reply to a synced inbound Gmail email, keeping it in the same thread",
    {
      email_id: z.string().describe("Inbound email ID (from local DB)"),
      body: z.string().describe("Reply body text"),
      is_html: z.boolean().optional().describe("Send as HTML email (default: false)"),
    },
    handler("reply_to_email"),
  );

  server.tool(
    "get_attachment",
    "Get local path or S3 URL for downloaded attachments on a synced inbound email",
    {
      email_id: z.string().describe("Inbound email ID"),
      filename: z.string().optional().describe("Filter by filename (returns all if omitted)"),
    },
    handler("get_attachment"),
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
    handler("search_inbound"),
  );

  server.tool(
    "get_inbox_sync_status",
    "Get source-aware inbox sync status for S3, realtime queue, and Gmail providers.",
    {},
    handler("get_inbox_sync_status"),
  );
}
