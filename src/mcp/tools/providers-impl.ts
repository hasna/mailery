import { createProvider, deleteProvider, getProvider, listProviderSummaries, updateProvider } from "../../db/providers.js";
import { redactSecrets } from "../../lib/redaction.js";
import { getAdapter } from "../../providers/index.js";
import type { CreateProviderInput, ProviderType } from "../../types/index.js";
import { resolveId } from "../helpers.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ProviderToolName =
  | "list_providers"
  | "add_provider"
  | "update_provider"
  | "authenticate_gmail_provider"
  | "remove_provider";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function text(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

function json(data: unknown): ToolResult {
  return text(JSON.stringify(data, null, 2));
}

function optionalString(input: Record<string, unknown>, key: keyof CreateProviderInput): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function createProviderInput(input: Record<string, unknown>): CreateProviderInput {
  const name = input["name"];
  const type = input["type"];
  if (typeof name !== "string" || typeof type !== "string") {
    throw new Error("Provider name and type are required");
  }
  return {
    name,
    type: type as ProviderType,
    api_key: optionalString(input, "api_key"),
    region: optionalString(input, "region"),
    access_key: optionalString(input, "access_key"),
    secret_key: optionalString(input, "secret_key"),
    oauth_client_id: optionalString(input, "oauth_client_id"),
    oauth_client_secret: optionalString(input, "oauth_client_secret"),
    oauth_refresh_token: optionalString(input, "oauth_refresh_token"),
    oauth_access_token: optionalString(input, "oauth_access_token"),
    oauth_token_expiry: optionalString(input, "oauth_token_expiry"),
  };
}

export async function runProviderTool(name: ProviderToolName, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_providers": {
        const limit = typeof input["limit"] === "number" ? input["limit"] : undefined;
        const offset = typeof input["offset"] === "number" ? input["offset"] : undefined;
        const effectiveLimit = limit ?? 100;
        const providers = listProviderSummaries(undefined, { limit: effectiveLimit, offset: offset ?? 0 });
        return json({
          providers: redactSecrets(providers),
          limit: effectiveLimit,
          offset: offset ?? 0,
          cli_equivalent: `mailery provider list${limit !== undefined ? ` --limit ${limit}` : ""}${offset !== undefined ? ` --offset ${offset}` : ""} --json`,
        });
      }
      case "add_provider": {
        const providerInput = createProviderInput(input);
        const provider = createProvider(providerInput);

        if (!input["skip_validation"] && provider.type !== "sandbox") {
          try {
            const adapter = getAdapter(provider);
            if (provider.type === "gmail") {
              await adapter.listAddresses();
            } else {
              await adapter.listDomains();
            }
          } catch (validationErr) {
            deleteProvider(provider.id);
            return text(
              `Error: Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`,
              true,
            );
          }
        }

        return json(redactSecrets(provider));
      }
      case "update_provider": {
        const resolvedId = resolveId("providers", String(input["id"]));
        const { id: _, ...updates } = input;
        return json(redactSecrets(updateProvider(resolvedId, updates)));
      }
      case "authenticate_gmail_provider": {
        const providerRef = String(input["provider_id"]);
        const id = resolveId("providers", providerRef);
        const provider = getProvider(id);
        if (!provider) throw new Error(`Provider not found: ${providerRef}`);
        if (provider.type !== "gmail") throw new Error("Only Gmail providers require OAuth authentication");
        if (!provider.oauth_client_id || !provider.oauth_client_secret) {
          throw new Error("Provider is missing oauth_client_id or oauth_client_secret");
        }

        const { startGmailOAuthFlow } = await import("../../lib/gmail-oauth.js");
        const tokens = await startGmailOAuthFlow(provider.oauth_client_id, provider.oauth_client_secret);
        const updated = updateProvider(id, {
          oauth_refresh_token: tokens.refresh_token,
          oauth_access_token: tokens.access_token,
          oauth_token_expiry: tokens.expiry,
        });

        return json(redactSecrets({ success: true, provider: updated }));
      }
      case "remove_provider": {
        const providerRef = String(input["provider_id"]);
        const id = resolveId("providers", providerRef);
        const provider = getProvider(id);
        if (!provider) throw new Error(`Provider not found: ${id}`);
        deleteProvider(id);
        return text(`Provider removed: ${provider.name}`);
      }
    }
  } catch (error) {
    return text(`Error: ${formatError(error)}`, true);
  }
}
