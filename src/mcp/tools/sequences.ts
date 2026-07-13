import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DEFAULT_MCP_REPLY_LIMIT = 20;
const MAX_MCP_REPLY_LIMIT = 100;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function toolError(error: unknown): Promise<ToolResult> {
  const { formatError } = await import("../helpers.js");
  return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
}

async function isSelfHostedRuntimeMode(): Promise<boolean> {
  const { resolveEmailsMode } = await import("../../lib/mode.js");
  return resolveEmailsMode().mode === "self_hosted";
}

async function assertSelfHostedApiRouteReady(toolName: string): Promise<void> {
  if (!(await isSelfHostedRuntimeMode())) return;
  const { isSelfHostedMode } = await import("../../db/self-hosted-store.js");
  if (!isSelfHostedMode()) {
    throw new Error(
      `MCP tool ${toolName} is API-backed in self_hosted mode and requires EMAILS_MODE=self_hosted with ` +
        "EMAILS_SELF_HOSTED_URL and EMAILS_SELF_HOSTED_API_KEY. Set EMAILS_MODE=local only for an explicit local sequence store.",
    );
  }
}

async function assertSequenceSubledgerAllowed(toolName: string, reason: string): Promise<void> {
  if (!(await isSelfHostedRuntimeMode())) return;
  throw new Error(
    `MCP tool ${toolName} is disabled in self_hosted API-only mode because ${reason}. ` +
      "Use the self-hosted Emails API for server-owned sequence state, or set EMAILS_MODE=local only for an explicit local sequence ledger.",
  );
}

export function registerSequenceTools(server: McpServer): void {
// ─── SEQUENCES ────────────────────────────────────────────────────────────────

  server.tool(
  "list_sequences",
  "List all email drip sequences",
  {
    limit: z.number().int().positive().max(1000).optional().describe("Maximum sequences to return"),
    offset: z.number().int().min(0).optional().describe("Number of sequences to skip"),
  },
  async ({ limit, offset }) => {
    try {
      await assertSelfHostedApiRouteReady("list_sequences");
      const { listSequences } = await import("../../db/sequences.js");
      const sequences = listSequences(undefined, { limit: limit ?? 100, offset: offset ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify(sequences, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "create_sequence",
  "Create a new email drip sequence",
  {
    name: z.string().describe("Unique sequence name"),
    description: z.string().optional().describe("Sequence description"),
  },
  async ({ name, description }) => {
    try {
      await assertSelfHostedApiRouteReady("create_sequence");
      const { createSequence } = await import("../../db/sequences.js");
      const sequence = createSequence({ name, description });
      return { content: [{ type: "text", text: JSON.stringify(sequence, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "add_sequence_step",
  "Add a step to an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    step_number: z.number().describe("Step number (1, 2, 3...)"),
    delay_hours: z.number().describe("Delay in hours before sending this step"),
    template_name: z.string().describe("Template name to use for this step"),
    from_address: z.string().optional().describe("From address override"),
    subject_override: z.string().optional().describe("Subject override"),
  },
  async ({ sequence_id, step_number, delay_hours, template_name, from_address, subject_override }) => {
    try {
      await assertSequenceSubledgerAllowed("add_sequence_step", "it writes local sequence step rows");
      const { getSequence, addStep } = await import("../../db/sequences.js");
      const seq = getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const step = addStep({
        sequence_id: seq.id,
        step_number,
        delay_hours,
        template_name,
        from_address,
        subject_override,
      });
      return { content: [{ type: "text", text: JSON.stringify(step, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "enroll_contact",
  "Enroll a contact in an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    contact_email: z.string().describe("Contact email address"),
    provider_id: z.string().optional().describe("Provider ID to use for sending"),
  },
  async ({ sequence_id, contact_email, provider_id }) => {
    try {
      await assertSequenceSubledgerAllowed("enroll_contact", "it writes local sequence enrollment rows");
      const { getSequence, enroll } = await import("../../db/sequences.js");
      const seq = getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const enrollment = enroll({ sequence_id: seq.id, contact_email, provider_id });
      return { content: [{ type: "text", text: JSON.stringify(enrollment, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "unenroll_contact",
  "Unenroll a contact from an email sequence",
  {
    sequence_id: z.string().describe("Sequence ID or name"),
    contact_email: z.string().describe("Contact email address"),
  },
  async ({ sequence_id, contact_email }) => {
    try {
      await assertSequenceSubledgerAllowed("unenroll_contact", "it writes local sequence enrollment rows");
      const { getSequence, unenroll } = await import("../../db/sequences.js");
      const seq = getSequence(sequence_id);
      if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
      const removed = unenroll(seq.id, contact_email);
      return { content: [{ type: "text", text: removed ? "Contact unenrolled" : "Contact was not actively enrolled" }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

  server.tool(
  "list_enrollments",
  "List sequence enrollments, optionally filtered by sequence",
  {
    sequence_id: z.string().optional().describe("Sequence ID or name to filter by"),
    status: z.enum(["active", "completed", "cancelled"]).optional().describe("Filter by enrollment status"),
    limit: z.number().int().positive().max(1000).optional().describe("Maximum enrollments to return"),
    offset: z.number().int().min(0).optional().describe("Number of enrollments to skip"),
  },
  async ({ sequence_id, status, limit, offset }) => {
    try {
      await assertSequenceSubledgerAllowed("list_enrollments", "it reads local sequence enrollment rows");
      const { getSequence, listEnrollments } = await import("../../db/sequences.js");
      let resolvedSequenceId: string | undefined;
      if (sequence_id) {
        const seq = getSequence(sequence_id);
        if (!seq) throw new Error(`Sequence not found: ${sequence_id}`);
        resolvedSequenceId = seq.id;
      }
      const enrollments = listEnrollments({
        sequence_id: resolvedSequenceId,
        status,
        limit: limit ?? 100,
        offset: offset ?? 0,
      });
      return { content: [{ type: "text", text: JSON.stringify(enrollments, null, 2) }] };
    } catch (e) {
      return toolError(e);
    }
  },
);

// ─── REPLY TRACKING ───────────────────────────────────────────────────────────

  server.tool(
  "list_replies",
  "List inbound emails received as replies to a sent email",
  {
    email_id: z.string().describe("ID of the sent email to find replies for"),
    limit: z.number().int().positive().max(MAX_MCP_REPLY_LIMIT).optional().describe("Maximum replies to return (default 20, max 100)"),
    offset: z.number().int().min(0).optional().describe("Number of replies to skip"),
  },
  async ({ email_id, limit, offset }) => {
    try {
      await assertSequenceSubledgerAllowed("list_replies", "it reads local inbound reply tables and no API-backed replies implementation exists yet");
      const { getDatabase } = await import("../../db/database.js");
      const { listReplySummaries, getReplyCount } = await import("../../db/inbound.js");
      const { resolveId } = await import("../helpers.js");
      const db = getDatabase();
      const resolvedId = resolveId("emails", email_id);
      const pageLimit = limit ?? DEFAULT_MCP_REPLY_LIMIT;
      const pageOffset = offset ?? 0;
      const replies = listReplySummaries(resolvedId, db, { limit: pageLimit, offset: pageOffset });
      const count = getReplyCount(resolvedId, db);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count,
            replies,
            limit: pageLimit,
            offset: pageOffset,
            truncated: pageOffset + pageLimit < count,
          }, null, 2),
        }],
      };
    } catch (e) {
      return toolError(e);
    }
  },
);

}
