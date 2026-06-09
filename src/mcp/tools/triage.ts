import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getTriage, listTriagedSummaries, getTriageStats, deleteTriage } from "../../db/triage.js";
import { formatError } from "../helpers.js";

const MAX_MCP_TRIAGE_BATCH_LIMIT = 100;
const MAX_MCP_TRIAGE_LIST_LIMIT = 1000;

export function registerTriageTools(server: McpServer): void {
  server.tool(
    "triage_email",
    "Triage a single email using Cerebras AI — classify, prioritize, summarize, analyze sentiment, draft reply",
    {
      email_id: z.string().describe("Email ID to triage"),
      type: z.enum(["sent", "inbound"]).default("inbound").describe("Email type"),
      model: z.string().optional().describe("Cerebras model override"),
      skip_draft: z.boolean().optional().describe("Skip generating draft reply"),
    },
    async ({ email_id, type, model, skip_draft }) => {
      try {
        const { triageEmail } = await import("../../lib/triage.js");
        const result = await triageEmail(email_id, type, { model, skip_draft });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "triage_batch",
    "Triage multiple untriaged emails in batch",
    {
      type: z.enum(["sent", "inbound"]).default("inbound").describe("Email type"),
      limit: z.number().int().positive().max(MAX_MCP_TRIAGE_BATCH_LIMIT).optional().default(10).describe("Max emails to triage (max 100)"),
      model: z.string().optional().describe("Cerebras model override"),
      skip_draft: z.boolean().optional().describe("Skip generating draft replies"),
    },
    async ({ type, limit, model, skip_draft }) => {
      try {
        const { triageBatch } = await import("../../lib/triage.js");
        const result = await triageBatch(type, limit, { model, skip_draft });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_triage",
    "Get triage result for an email",
    {
      email_id: z.string().describe("Email ID"),
      type: z.enum(["sent", "inbound"]).default("sent").describe("Email type"),
    },
    async ({ email_id, type }) => {
      try {
        const result = getTriage(email_id, type);
        if (!result) return { content: [{ type: "text", text: "No triage result found" }] };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "list_triaged",
    "List triaged emails with optional filters",
    {
      label: z.enum(["action-required", "fyi", "urgent", "follow-up", "spam", "newsletter", "transactional"]).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      sentiment: z.enum(["positive", "negative", "neutral"]).optional(),
      limit: z.number().int().positive().max(MAX_MCP_TRIAGE_LIST_LIMIT).optional().default(20),
      offset: z.number().int().min(0).optional().default(0),
    },
    async ({ label, priority, sentiment, limit, offset }) => {
      try {
        const results = listTriagedSummaries({ label, priority, sentiment, limit, offset });
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "triage_stats",
    "Get triage statistics — counts by label, priority, sentiment, averages",
    {},
    async () => {
      try {
        const stats = getTriageStats();
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "generate_draft_reply",
    "Generate a draft reply for an email using Cerebras AI",
    {
      email_id: z.string().describe("Email ID"),
      type: z.enum(["sent", "inbound"]).default("sent").describe("Email type"),
      model: z.string().optional().describe("Cerebras model override"),
    },
    async ({ email_id, type, model }) => {
      try {
        const { generateDraftForEmail } = await import("../../lib/triage.js");
        const draft = await generateDraftForEmail(email_id, type, { model });
        return { content: [{ type: "text", text: draft }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "delete_triage",
    "Delete a triage result",
    { triage_id: z.string().describe("Triage result ID") },
    async ({ triage_id }) => {
      try {
        const deleted = deleteTriage(triage_id);
        return { content: [{ type: "text", text: deleted ? "Deleted" : "Not found" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );
}
