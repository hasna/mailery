// MCP tool module: misc-ops.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const MAX_MCP_SANDBOX_LIST_LIMIT = 1000;
const MAX_MCP_VERIFY_TIMEOUT_MS = 60000;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function toolError(error: unknown): Promise<ToolResult> {
  const { formatError } = await import("../helpers.js");
  return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
}

async function assertLocalStateAllowed(toolName: string, reason: string): Promise<void> {
  const { getEmailsMode } = await import("../../lib/mode.js");
  if (getEmailsMode() !== "self_hosted") return;
  throw new Error(
    `MCP tool ${toolName} is disabled in self_hosted API-only mode because ${reason}. ` +
      "Use the self-hosted Emails API for server-owned state, or set EMAILS_MODE=local only for an explicit local store.",
  );
}

async function isSelfHostedRuntimeMode(): Promise<boolean> {
  const { resolveEmailsMode } = await import("../../lib/mode.js");
  return resolveEmailsMode().mode === "self_hosted";
}

async function assertSelfHostedApiRouteReady(toolName: string): Promise<boolean> {
  if (!(await isSelfHostedRuntimeMode())) return false;
  const { isSelfHostedMode } = await import("../../db/self-hosted-store.js");
  if (!isSelfHostedMode()) {
    throw new Error(
      `MCP tool ${toolName} is API-backed in self_hosted mode and requires EMAILS_MODE=self_hosted with ` +
        "EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY. Set EMAILS_MODE=local only for an explicit local group store.",
    );
  }
  return true;
}

async function assertGroupMemberStateAllowed(toolName: string, reason: string): Promise<void> {
  if (!(await isSelfHostedRuntimeMode())) return;
  throw new Error(
    `MCP tool ${toolName} is disabled in self_hosted API-only mode because ${reason}. ` +
      "Use the self-hosted Emails API for server-owned group member state, or set EMAILS_MODE=local only for an explicit local group-member ledger.",
  );
}

export function registerMiscOpsTools(server: McpServer): void {
  // ─── GROUPS ─────────────────────────────────────────────────────────────────

  server.tool(
  "list_groups",
  "List all recipient groups",
  {
    limit: z.number().int().positive().max(1000).optional().describe("Maximum groups to return"),
    offset: z.number().int().min(0).optional().describe("Number of groups to skip"),
  },
  async ({ limit, offset }) => {
    try {
      const selfHosted = await assertSelfHostedApiRouteReady("list_groups");
      const { listGroups, getMemberCounts } = await import('../../db/groups.js');
      const groups = listGroups(undefined, { limit: limit ?? 100, offset: offset ?? 0 });
      const result = selfHosted
        ? groups
        : (() => {
            const counts = getMemberCounts(groups.map((group) => group.id));
            return groups.map(g => ({
              ...g,
              member_count: counts.get(g.id) ?? 0,
            }));
          })();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "create_group",
  "Create a new recipient group",
  {
    name: z.string().describe("Unique group name"),
    description: z.string().optional().describe("Group description"),
  },
  async ({ name, description }) => {
    try {
      await assertSelfHostedApiRouteReady("create_group");
      const { createGroup } = await import('../../db/groups.js');
      const group = createGroup(name, description);
      return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "delete_group",
  "Delete a recipient group",
  {
    name: z.string().describe("Group name"),
  },
  async ({ name }) => {
    try {
      await assertSelfHostedApiRouteReady("delete_group");
      const { getGroupByName, deleteGroup } = await import('../../db/groups.js');
      const group = getGroupByName(name);
      if (!group) throw new Error(`Group not found: ${name}`);
      deleteGroup(group.id);
      return { content: [{ type: "text", text: `Group deleted: ${name}` }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "add_group_member",
  "Add a member to a recipient group",
  {
    group_name: z.string().describe("Group name"),
    email: z.string().describe("Member email address"),
    name: z.string().optional().describe("Member display name"),
    vars: z.record(z.string()).optional().describe("Template variables for this member"),
  },
  async ({ group_name, email, name, vars }) => {
    try {
      await assertGroupMemberStateAllowed("add_group_member", "it writes local group member rows");
      const { getGroupByName, addMember } = await import('../../db/groups.js');
      const group = getGroupByName(group_name);
      if (!group) throw new Error(`Group not found: ${group_name}`);
      const member = addMember(group.id, email, name, vars);
      return { content: [{ type: "text", text: JSON.stringify(member, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "remove_group_member",
  "Remove a member from a recipient group",
  {
    group_name: z.string().describe("Group name"),
    email: z.string().describe("Member email address"),
  },
  async ({ group_name, email }) => {
    try {
      await assertGroupMemberStateAllowed("remove_group_member", "it writes local group member rows");
      const { getGroupByName, removeMember } = await import('../../db/groups.js');
      const group = getGroupByName(group_name);
      if (!group) throw new Error(`Group not found: ${group_name}`);
      const removed = removeMember(group.id, email);
      if (!removed) throw new Error(`Member not found: ${email}`);
      return { content: [{ type: "text", text: `Member removed: ${email} from ${group_name}` }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "list_group_members",
  "List members of a recipient group without per-member template vars",
  {
    group_name: z.string().describe("Group name"),
    limit: z.number().int().positive().max(1000).optional().describe("Maximum members to return"),
    offset: z.number().int().min(0).optional().describe("Number of members to skip"),
  },
  async ({ group_name, limit, offset }) => {
    try {
      await assertGroupMemberStateAllowed("list_group_members", "it reads local group member rows");
      const { getGroupByName, listMemberSummaries } = await import('../../db/groups.js');
      const group = getGroupByName(group_name);
      if (!group) throw new Error(`Group not found: ${group_name}`);
      const members = listMemberSummaries(group.id, undefined, { limit: limit ?? 100, offset: offset ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify(members, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "get_group_member",
  "Get one group member including template vars",
  {
    group_name: z.string().describe("Group name"),
    email: z.string().describe("Member email address"),
  },
  async ({ group_name, email }) => {
    try {
      await assertGroupMemberStateAllowed("get_group_member", "it reads local group member rows");
      const { getGroupByName, getMember } = await import('../../db/groups.js');
      const group = getGroupByName(group_name);
      if (!group) throw new Error(`Group not found: ${group_name}`);
      const member = getMember(group.id, email);
      if (!member) throw new Error(`Member not found: ${email}`);
      return { content: [{ type: "text", text: JSON.stringify(member, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── SANDBOX ─────────────────────────────────────────────────────────────────

  server.tool(
  "list_sandbox_emails",
  "List emails captured by sandbox providers (not actually sent)",
  {
    provider_id: z.string().optional().describe("Filter by sandbox provider ID"),
    limit: z.number().int().positive().max(MAX_MCP_SANDBOX_LIST_LIMIT).optional().describe("Max results (default 50, max 1000)"),
    offset: z.number().int().nonnegative().optional().describe("Pagination offset (default 0)"),
  },
  async ({ provider_id, limit, offset }) => {
    try {
      await assertLocalStateAllowed("list_sandbox_emails", "it reads local sandbox state");
      const { listSandboxEmailSummaries } = await import('../../db/sandbox.js');
      const { resolveId } = await import('../helpers.js');
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const emails = listSandboxEmailSummaries(resolvedId, limit ?? 50, offset ?? 0);
      return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "get_sandbox_email",
  "Get a specific sandbox-captured email by ID",
  {
    id: z.string().describe("Sandbox email ID (or prefix)"),
  },
  async ({ id }) => {
    try {
      await assertLocalStateAllowed("get_sandbox_email", "it reads local sandbox state");
      const { getDatabase } = await import('../../db/database.js');
      const { getSandboxEmail } = await import('../../db/sandbox.js');
      const { resolveId } = await import('../helpers.js');
      const resolvedId = resolveId("sandbox_emails", id);
      const db = getDatabase();
      const email = getSandboxEmail(resolvedId, db);
      if (!email) throw new Error(`Sandbox email not found: ${id}`);
      return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "clear_sandbox_emails",
  "Delete captured sandbox emails",
  {
    provider_id: z.string().optional().describe("Only clear emails for this provider (clears all if not specified)"),
  },
  async ({ provider_id }) => {
    try {
      await assertLocalStateAllowed("clear_sandbox_emails", "it writes local sandbox state");
      const { clearSandboxEmails } = await import('../../db/sandbox.js');
      const { resolveId } = await import('../helpers.js');
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const count = clearSandboxEmails(resolvedId);
      return { content: [{ type: "text", text: JSON.stringify({ deleted: count }, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── ANALYTICS ────────────────────────────────────────────────────────────────

  server.tool(
  "get_analytics",
  "Get email analytics — daily volume, top recipients, busiest hours, delivery trend",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    period: z.string().optional().describe("Time period, e.g. '30d', '7d' (default: 30d)"),
  },
  async ({ provider_id, period }) => {
    try {
      await assertLocalStateAllowed("get_analytics", "it reads local analytics tables");
      const { resolveId } = await import('../helpers.js');
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const { getAnalytics } = await import("../../lib/analytics.js");
      const data = getAnalytics(resolvedId, period ?? "30d");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── DOCTOR ───────────────────────────────────────────────────────────────────

  server.tool(
  "run_doctor",
  "Run email system diagnostics. By default this avoids live provider API calls; pass live=true to validate credentials remotely.",
  {
    live: z.boolean().optional().describe("Validate provider credentials with live provider API calls"),
  },
  async ({ live }) => {
    try {
      await assertLocalStateAllowed("run_doctor", "it opens local diagnostics state before checking providers and domains");
      const { runDiagnostics } = await import("../../lib/doctor.js");
      const checks = await runDiagnostics(undefined, { liveProviderChecks: live === true });
      return { content: [{ type: "text", text: JSON.stringify(checks, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── EXPORT ───────────────────────────────────────────────────────────────────

  server.tool(
  "export_emails",
  "Export emails as CSV or JSON string",
  {
    format: z.enum(["csv", "json"]).optional().describe("Output format (default: json)"),
    provider_id: z.string().optional().describe("Filter by provider ID"),
    from_address: z.string().optional().describe("Filter by sender address"),
    since: z.string().optional().describe("ISO 8601 datetime to filter from"),
    until: z.string().optional().describe("ISO 8601 datetime to filter until"),
    limit: z.number().int().positive().max(5000).optional().describe("Maximum exported rows (default: 1000)"),
    offset: z.number().int().min(0).optional().describe("Number of rows to skip"),
  },
  async ({ format, provider_id, from_address, since, until, limit, offset }) => {
    try {
      await assertLocalStateAllowed("export_emails", "it exports local sent-message state");
      const { resolveId } = await import('../helpers.js');
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const filters = { provider_id: resolvedId, from_address, since, until, limit: limit ?? 1000, offset: offset ?? 0 };
      const { exportEmailsCsv, exportEmailsJson } = await import("../../lib/export.js");
      const output = (format ?? "json") === "csv" ? exportEmailsCsv(filters) : exportEmailsJson(filters);
      return { content: [{ type: "text", text: output }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  server.tool(
  "export_events",
  "Export events as CSV or JSON string",
  {
    format: z.enum(["csv", "json"]).optional().describe("Output format (default: json)"),
    provider_id: z.string().optional().describe("Filter by provider ID"),
    since: z.string().optional().describe("ISO 8601 datetime to filter from"),
    until: z.string().optional().describe("ISO 8601 datetime to filter until"),
    limit: z.number().int().positive().max(5000).optional().describe("Maximum exported rows (default: 1000)"),
    offset: z.number().int().min(0).optional().describe("Number of rows to skip"),
  },
  async ({ format, provider_id, since, until, limit, offset }) => {
    try {
      await assertLocalStateAllowed("export_events", "it exports local delivery-event state");
      const { resolveId } = await import('../helpers.js');
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const filters = { provider_id: resolvedId, since, until, limit: limit ?? 1000, offset: offset ?? 0 };
      const { exportEventsCsv, exportEventsJson } = await import("../../lib/export.js");
      const output = (format ?? "json") === "csv" ? exportEventsCsv(filters) : exportEventsJson(filters);
      return { content: [{ type: "text", text: output }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────

  server.tool(
  "verify_email_address",
  "Verify an email address — checks format, MX records, and optionally SMTP probe",
  {
    email: z.string().describe("Email address to verify"),
    smtp_probe: z.boolean().optional().describe("Also do SMTP probe (RCPT TO check, no email sent)"),
    timeout_ms: z.number().int().positive().max(MAX_MCP_VERIFY_TIMEOUT_MS).optional().describe("DNS/SMTP timeout in milliseconds (default: 5000, max: 60000)"),
  },
  async ({ email, smtp_probe, timeout_ms }) => {
    try {
      const { verifyEmailAddress, formatVerifyResult } = await import("../../lib/email-verify.js");
      const result = await verifyEmailAddress(email, { smtpProbe: !!smtp_probe, timeoutMs: timeout_ms ?? 5000 });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) + "\n\n" + formatVerifyResult(result) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );

  // ─── BATCH SEND ───────────────────────────────────────────────────────────────

  server.tool(
  "batch_send",
  "Send emails to a list of recipients using a template. Each recipient gets personalized content.",
  {
    recipients: z.array(z.object({ email: z.string(), vars: z.record(z.string()).optional() })).describe("List of recipients with optional template variables"),
    template_name: z.string().describe("Template name to use"),
    from_address: z.string().describe("From email address"),
    provider_id: z.string().optional().describe("Provider ID (uses default if not specified)"),
    force: z.boolean().optional().describe("Send even to suppressed contacts"),
  },
  async ({ recipients, template_name, from_address, provider_id, force }) => {
    try {
      await assertLocalStateAllowed("batch_send", "it reads local templates, suppression state, provider config, and writes local send ledgers");
      const { getTemplate, renderTemplate } = await import("../../db/templates.js");
      const template = getTemplate(template_name);
      if (!template) throw new Error(`Template not found: ${template_name}`);
      const { getActiveProvider, getProvider } = await import("../../db/providers.js");
      const { getDatabase } = await import('../../db/database.js');
      const { resolveId, ProviderNotFoundError } = await import('../helpers.js');
      const db = getDatabase();
      const resolvedProviderId = provider_id ? resolveId("providers", provider_id)
        : getActiveProvider(db).id;
      const provider = getProvider(resolvedProviderId, db);
      if (!provider) throw new ProviderNotFoundError(resolvedProviderId);
      const { getSuppressedEmailSet, incrementSendCounts } = await import("../../db/contacts.js");
      const { createSentEmailLedger } = await import("../../lib/sent-ledger.js");
      let sent = 0, skipped = 0, failed = 0;
      const errors: string[] = [];
      const suppressedEmailSet = force ? new Set<string>() : getSuppressedEmailSet(recipients.map((r) => r.email), db);
      const sentEmails: string[] = [];
      const { sendWithFailover } = await import("../../lib/send.js");
      for (const r of recipients) {
        if (!force && suppressedEmailSet.has(r.email)) { skipped++; continue; }
        try {
          const vars = r.vars ?? { email: r.email };
          const subject = renderTemplate(template.subject_template, vars);
          const html = template.html_template ? renderTemplate(template.html_template, vars) : undefined;
          const text = template.text_template ? renderTemplate(template.text_template, vars) : undefined;
          const sendOpts = { from: from_address, to: r.email, subject, html, text };
          const { messageId, providerId: actualId } = await sendWithFailover(resolvedProviderId, sendOpts, db);
          await createSentEmailLedger(actualId, sendOpts, messageId, db);
          sentEmails.push(r.email);
          sent++;
        } catch (e) { failed++; errors.push(`${r.email}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      incrementSendCounts(sentEmails, db);
      return { content: [{ type: "text", text: JSON.stringify({ sent, skipped, failed, errors }, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
  );
}
