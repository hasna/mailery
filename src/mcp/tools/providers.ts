import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type ProviderToolName =
  | "list_providers"
  | "add_provider"
  | "update_provider"
  | "authenticate_gmail_provider"
  | "remove_provider";

async function runProviderTool(name: ProviderToolName, input: Record<string, unknown>) {
  const { runProviderTool: run } = await import("./providers-impl.js");
  return run(name, input);
}

export function registerProviderTools(server: McpServer): void {
// ─── PROVIDERS ────────────────────────────────────────────────────────────────

  server.tool(
  "list_providers",
  "List all configured email providers",
  {
    limit: z.number().int().positive().max(1000).optional().describe("Maximum providers to return"),
    offset: z.number().int().min(0).optional().describe("Number of providers to skip"),
  },
  async ({ limit, offset }) => {
    return runProviderTool("list_providers", { limit, offset });
  },
);

  server.tool(
  "add_provider",
  "Add a new email provider (resend, ses, or gmail)",
  {
    name: z.string().describe("Provider name"),
    type: z.enum(["resend", "ses", "gmail", "sandbox"]).describe("Provider type"),
    api_key: z.string().optional().describe("Resend API key"),
    region: z.string().optional().describe("SES region (e.g. us-east-1)"),
    access_key: z.string().optional().describe("SES access key ID"),
    secret_key: z.string().optional().describe("SES secret access key"),
    oauth_client_id: z.string().optional().describe("Gmail OAuth client ID"),
    oauth_client_secret: z.string().optional().describe("Gmail OAuth client secret"),
    oauth_refresh_token: z.string().optional().describe("Gmail OAuth refresh token"),
    oauth_access_token: z.string().optional().describe("Gmail OAuth access token"),
    oauth_token_expiry: z.string().optional().describe("Gmail OAuth token expiry (ISO 8601)"),
    skip_validation: z.boolean().optional().describe("Skip credential validation after adding (default: false)"),
  },
  async (input) => {
    return runProviderTool("add_provider", input);
  },
);

  server.tool(
  "update_provider",
  "Update an existing email provider's configuration",
  {
    id: z.string().describe("Provider ID (or prefix)"),
    name: z.string().optional().describe("New provider name"),
    api_key: z.string().optional().describe("Resend API key"),
    region: z.string().optional().describe("SES region"),
    access_key: z.string().optional().describe("SES access key ID"),
    secret_key: z.string().optional().describe("SES secret access key"),
    oauth_client_id: z.string().optional().describe("Gmail OAuth client ID"),
    oauth_client_secret: z.string().optional().describe("Gmail OAuth client secret"),
    oauth_refresh_token: z.string().optional().describe("Gmail OAuth refresh token"),
    oauth_access_token: z.string().optional().describe("Gmail OAuth access token"),
    oauth_token_expiry: z.string().optional().describe("Gmail OAuth token expiry (ISO 8601)"),
  },
  async (input) => {
    return runProviderTool("update_provider", input);
  },
);

  server.tool(
  "authenticate_gmail_provider",
  "Trigger Gmail OAuth re-authentication flow for an existing Gmail provider. Opens a browser window. Must be run in an interactive terminal.",
  {
    provider_id: z.string().describe("Gmail provider ID (or prefix)"),
  },
  async ({ provider_id }) => {
    return runProviderTool("authenticate_gmail_provider", { provider_id });
  },
);

  server.tool(
  "remove_provider",
  "Remove a provider by ID",
  {
    provider_id: z.string().describe("Provider ID (or prefix)"),
  },
  async ({ provider_id }) => {
    return runProviderTool("remove_provider", { provider_id });
  },
);

}
