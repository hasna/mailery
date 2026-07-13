import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import { buildServer } from "./server.js";

const ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
] as const;

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

let tempHome: string | undefined;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function dbPath(): string {
  if (!tempHome) throw new Error("tempHome not initialized");
  return join(tempHome, ".hasna", "emails", "emails.db");
}

async function callTool(name: string, args: Record<string, unknown>) {
  const server = buildServer() as unknown as {
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> }>;
  };
  return await server._registeredTools[name]!.handler(args);
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  tempHome = mkdtempSync(join(tmpdir(), "emails-mcp-self-hosted-local-state-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:3900";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
  resetSelfHostedConfigCache();
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  resetSelfHostedConfigCache();
  restoreEnv();
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe("MCP self_hosted local-state guards", () => {
  it("fails reply and prepare-inbox tools before creating a local emails DB", async () => {
    for (const [name, args] of [
      ["list_replies", { email_id: "sent-email-1" }],
      ["prepare_inbox", { email: "ops@example.com", create_missing: true, provider_id: "provider-1" }],
    ] as const) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("self_hosted API-only mode");
      expect(existsSync(dbPath())).toBe(false);
    }
  });

  it("routes next-action through runtime status without creating a local emails DB", async () => {
    const result = await callTool("get_next_action", { goal: "wait for a verification code" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("/messages/counts");
    expect(existsSync(dbPath())).toBe(false);
  });
});
