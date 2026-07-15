import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MAX_MCP_INBOX_LIMIT = 1000;
const MAX_MCP_WAIT_TIMEOUT_SECONDS = 300;
const MAX_MCP_WAIT_INTERVAL_SECONDS = 60;

const waitTimeoutSchema = z.number().int().positive().max(MAX_MCP_WAIT_TIMEOUT_SECONDS).optional();
const waitIntervalSchema = z.number().int().positive().max(MAX_MCP_WAIT_INTERVAL_SECONDS).optional();

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

async function runInboxTool(name: InboxToolName, input: Record<string, unknown>) {
  const { runInboxTool: run } = await import("./inbox-impl.js");
  return run(name, input);
}

function handler(name: InboxToolName) {
  return async (input: unknown) => runInboxTool(name, input as Record<string, unknown>);
}

export function registerInboxTools(server: McpServer): void {
  server.tool(
    "list_mailboxes",
    "List folder counts for a mailbox scope, optionally filtered by ingestion source.",
    {
      source_id: z.string().optional().describe("Ingestion source ID from list_mailbox_sources, e.g. provider:<id>, s3:<bucket>, legacy, or orphaned:<id>"),
      provider_id: z.string().optional().describe("Credential/capability ID used as a provenance filter"),
      address: z.string().optional().describe("Mailbox scope: exact recipient/sender address"),
      domain: z.string().optional().describe("Mailbox scope: recipient/sender domain"),
    },
    handler("list_mailboxes"),
  );

  server.tool(
    "list_mailbox_sources",
    "List ingestion streams with counts and legacy/orphaned badges.",
    {
      search: z.string().optional().describe("Filter sources by label, ID, kind, provider, bucket, or badge"),
      limit: z.number().int().positive().max(MAX_MCP_INBOX_LIMIT).optional().describe("Max sources (default 100, max 1000)"),
    },
    handler("list_mailbox_sources"),
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
    handler("search_mailbox"),
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
    "extract_inbound_email_links",
    "Extract links from a specific inbound email by ID. Read-only.",
    {
      id: z.string().describe("Inbound email ID (or prefix)"),
      include_non_web: z.boolean().optional().describe("Include mailto: and tel: links"),
    },
    handler("extract_inbound_email_links"),
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
    "mark_email_read",
    "Mark an inbound email as read (local state)",
    {
      email_id: z.string(),
      unread: z.boolean().optional().describe("Mark unread instead"),
    },
    handler("mark_email_read"),
  );

  server.tool(
    "archive_email",
    "Archive (or unarchive) an inbound email (local state)",
    {
      email_id: z.string(),
      unarchive: z.boolean().optional().describe("Restore to inbox instead"),
    },
    handler("archive_email"),
  );

  server.tool(
    "star_email",
    "Star (or unstar) an inbound email (local state)",
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
    "get_attachment",
    "List attachment metadata and any existing local/S3 location. This does not download content.",
    {
      email_id: z.string().describe("Inbound email ID"),
      filename: z.string().optional().describe("Filter by filename (returns all if omitted)"),
    },
    handler("get_attachment"),
  );

  server.tool(
    "download_attachment",
    "Deliberately download one attachment from an exact inbound email ID to a safe local file. Writes one collision-proof mode-0600 file and never returns attachment bytes.",
    {
      email_id: z.string().describe("Exact full inbound email ID (prefixes are rejected for downloads)"),
      index: z.number().int().nonnegative().describe("Zero-based attachment index"),
      output_dir: z.string().min(1).describe("Existing or creatable local output directory"),
      max_bytes: z.number().int().positive().max(25 * 1024 * 1024).optional().describe("Maximum decoded bytes (hard cap 25MiB)"),
    },
    handler("download_attachment"),
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
    "Get source-aware mailbox sync status for S3 ingestion and realtime queue.",
    {},
    handler("get_inbox_sync_status"),
  );
}
