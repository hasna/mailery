import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createProvider, listProviders, deleteProvider, getProvider, updateProvider } from "../../db/providers.js";
import { getAdapter } from "../../providers/index.js";
import { redactSecrets } from "../../lib/redaction.js";
import { formatError, resolveId, ProviderNotFoundError } from "../helpers.js";

export function registerProviderTools(server: McpServer): void {
// ─── PROVIDERS ────────────────────────────────────────────────────────────────

  server.tool(
  "list_providers",
  "List all configured email providers",
  {},
  async () => {
    try {
      const providers = listProviders();
      return { content: [{ type: "text", text: JSON.stringify(redactSecrets(providers), null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
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
    try {
      const { skip_validation, ...providerInput } = input;
      const provider = createProvider(providerInput);

      if (!skip_validation && provider.type !== "sandbox") {
        try {
          const adapter = getAdapter(provider);
          if (provider.type === "gmail") {
            await adapter.listAddresses();
          } else {
            await adapter.listDomains();
          }
        } catch (validationErr) {
          deleteProvider(provider.id);
          return {
            content: [{
              type: "text",
              text: `Error: Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`,
            }],
            isError: true,
          };
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(redactSecrets(provider), null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
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
    try {
      const resolvedId = resolveId("providers", input.id);
      const { id: _, ...updates } = input;
      const updated = updateProvider(resolvedId, updates);
      return { content: [{ type: "text", text: JSON.stringify(redactSecrets(updated), null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "authenticate_gmail_provider",
  "Trigger Gmail OAuth re-authentication flow for an existing Gmail provider. Opens a browser window. Must be run in an interactive terminal.",
  {
    provider_id: z.string().describe("Gmail provider ID (or prefix)"),
  },
  async ({ provider_id }) => {
    try {
      const id = resolveId("providers", provider_id);
      const provider = getProvider(id);
      if (!provider) throw new Error(`Provider not found: ${provider_id}`);
      if (provider.type !== "gmail") throw new Error("Only Gmail providers require OAuth authentication");
      if (!provider.oauth_client_id || !provider.oauth_client_secret) {
        throw new Error("Provider is missing oauth_client_id or oauth_client_secret");
      }

      const { startGmailOAuthFlow } = await import("../../lib/gmail-oauth.js");
      const tokens = await startGmailOAuthFlow(provider.oauth_client_id, provider.oauth_client_secret);

      const { updateProvider } = await import("../../db/providers.js");
      const updated = updateProvider(id, {
        oauth_refresh_token: tokens.refresh_token,
        oauth_access_token: tokens.access_token,
        oauth_token_expiry: tokens.expiry,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(redactSecrets({ success: true, provider: updated }), null, 2),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

  server.tool(
  "remove_provider",
  "Remove a provider by ID",
  {
    provider_id: z.string().describe("Provider ID (or prefix)"),
  },
  async ({ provider_id }) => {
    try {
      const id = resolveId("providers", provider_id);
      const provider = getProvider(id);
      if (!provider) throw new ProviderNotFoundError(id);
      deleteProvider(id);
      return { content: [{ type: "text", text: `Provider removed: ${provider.name}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
);

}
