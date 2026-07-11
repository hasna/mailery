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
          cli_equivalent: `emails provider list${limit !== undefined ? ` --limit ${limit}` : ""}${offset !== undefined ? ` --offset ${offset}` : ""} --json`,
        });
      }
      case "add_provider": {
        const providerInput = createProviderInput(input);
        const provider = createProvider(providerInput);

        if (!input["skip_validation"] && provider.type !== "sandbox") {
          try {
            const adapter = getAdapter(provider);
            await adapter.listDomains();
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
