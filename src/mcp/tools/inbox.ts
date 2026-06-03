import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listInboundEmails, getInboundEmail, clearInboundEmails,
  setInboundRead, setInboundArchived, setInboundStarred,
  addInboundLabel, removeInboundLabel,
} from "../../db/inbound.js";
import { syncGmailInbox, syncGmailInboxAll, syncGmailInboxHistory } from "../../lib/gmail-sync.js";
import { getGmailSyncState, updateLastSynced } from "../../db/gmail-sync-state.js";
import { getDatabase } from "../../db/database.js";
import { listProviders } from "../../db/providers.js";
import { formatError, resolveId } from "../helpers.js";

export function registerInboxTools(server: McpServer): void {
// ─── INBOUND EMAILS ───────────────────────────────────────────────────────────

  server.tool(
  "list_inbound_emails",
  "List received inbound emails",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    since: z.string().optional().describe("ISO 8601 date — only return emails received after this time"),
    limit: z.number().int().positive().optional().describe("Max results (default 50)"),
    offset: z.number().int().nonnegative().optional().describe("Pagination offset (default 0)"),
    unread: z.boolean().optional().describe("Only unread mail"),
    read: z.boolean().optional().describe("Only read mail"),
    starred: z.boolean().optional().describe("Only starred mail"),
    archived: z.boolean().optional().describe("Show archived mail (hidden by default)"),
    label: z.string().optional().describe("Only mail carrying this label"),
  },
  async ({ provider_id, since, limit, offset, unread, read, starred, archived, label }) => {
    try {
      const emails = listInboundEmails({ provider_id, since, limit, offset, unread, read, starred, archived, label });
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
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
    limit: z.number().optional().describe("Max messages per run (default: 50)"),
    since: z.string().optional().describe("Only sync messages after this ISO date"),
    all_pages: z.boolean().optional().describe("Sync all pages until done (for full backfill)"),
    history: z.boolean().optional().describe("Use stored Gmail history cursor for incremental sync"),
  },
  async ({ provider_id, label, query, limit, since, all_pages, history }) => {
    try {
      const db = getDatabase();
      const opts = {
        providerId: provider_id,
        labelFilter: label,
        query,
        batchSize: limit,
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
      const e = setInboundRead(id, !unread);
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
      const e = setInboundArchived(id, !unarchive);
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
      const e = setInboundStarred(id, !unstar);
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
      const e = remove ? removeInboundLabel(id, label) : addInboundLabel(id, label);
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
      const db = getDatabase();
      const row = db.query("SELECT attachment_paths FROM inbound_emails WHERE id = ?").get(email_id) as { attachment_paths: string } | null;
      if (!row) return { content: [{ type: "text", text: `Email not found: ${email_id}` }], isError: true };
      const paths = JSON.parse(row.attachment_paths ?? "[]") as Array<{ filename: string; local_path?: string; s3_url?: string; content_type: string; size: number }>;
      const filtered = filename ? paths.filter((p) => p.filename === filename) : paths;
      return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "search_inbound",
  "Search synced inbound emails in local SQLite by subject, sender, or body text",
  {
    query: z.string().describe("Search term to match against subject, from address, or body"),
    provider_id: z.string().optional().describe("Filter by provider ID"),
    limit: z.number().optional().describe("Max results (default: 20)"),
  },
  async ({ query, provider_id, limit }) => {
    try {
      const db = getDatabase();
      const maxResults = limit ?? 20;
      const q = query.toLowerCase();
      const emails = listInboundEmails({ provider_id, limit: maxResults * 4 }, db)
        .filter(
          (e) =>
            e.subject.toLowerCase().includes(q) ||
            e.from_address.toLowerCase().includes(q) ||
            (e.text_body ?? "").toLowerCase().includes(q),
        )
        .slice(0, maxResults);
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "get_inbox_sync_status",
  "Get Gmail sync status for all Gmail providers — last synced time, message counts",
  {},
  async () => {
    try {
      const db = getDatabase();
      const providers = listProviders(db).filter((p) => p.type === "gmail");
      const status = providers.map((p) => {
        const state = getGmailSyncState(p.id, db);
        const count = db.query("SELECT COUNT(*) as c FROM inbound_emails WHERE provider_id = ?").get(p.id) as { c: number } | null;
        return {
          provider_id: p.id,
          provider_name: p.name,
          synced_count: count?.c ?? 0,
          last_synced_at: state?.last_synced_at ?? null,
          last_message_id: state?.last_message_id ?? null,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

}
