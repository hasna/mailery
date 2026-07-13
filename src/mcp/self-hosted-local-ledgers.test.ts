import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import { buildServer } from "./server.js";

const ENV_KEYS = [
  "HOME",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

let tempHome: string | null = null;
let proc: Subprocess | null = null;
let apiOrigin = "";

const SERVER_CODE = `
const group = { id: "group-api-1", name: "api-group", description: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
const ok = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/groups" && req.method === "GET") return ok({ items: [group] });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  },
});
console.log("PORT " + server.port);
`;

async function startApi(): Promise<void> {
  proc = Bun.spawn(["bun", "-e", SERVER_CODE], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 10_000;
  while (!output.includes("\n") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  reader.releaseLock();
  const port = output.match(/PORT (\d+)/)?.[1];
  if (!port) throw new Error(`self-hosted MCP test server did not report a port: ${output}`);
  apiOrigin = `http://127.0.0.1:${port}`;
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function localDbPath(): string {
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

beforeAll(async () => {
  await startApi();
});

afterAll(() => {
  proc?.kill();
  proc = null;
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  tempHome = mkdtempSync(join(tmpdir(), "emails-mcp-local-ledgers-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = apiOrigin;
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";
  resetSelfHostedConfigCache();
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  resetSelfHostedConfigCache();
  restoreEnv();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = null;
});

describe("MCP self_hosted local ledger guards", () => {
  it("lists groups through the self_hosted API without opening local member counts", async () => {
    const result = await callTool("list_groups", {});

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(resultText(result)) as { items?: Array<{ name: string; member_count?: number }> } | Array<{ name: string; member_count?: number }>;
    const groups = Array.isArray(payload) ? payload : payload.items ?? [];
    expect(groups).toEqual([{
      id: "group-api-1",
      name: "api-group",
      description: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }]);
    expect(groups[0]).not.toHaveProperty("member_count");
    expect(existsSync(localDbPath())).toBe(false);
  });

  it("fails local alias, warming, group-member, and sequence subledger tools before creating a local DB", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["list_aliases", {}],
      ["create_warming_schedule", { domain: "warm.example.com", target_daily_volume: 100 }],
      ["list_group_members", { group_name: "api-group" }],
      ["add_group_member", { group_name: "api-group", email: "user@example.com" }],
      ["add_sequence_step", { sequence_id: "seq-api-1", step_number: 1, delay_hours: 0, template_name: "welcome" }],
      ["enroll_contact", { sequence_id: "seq-api-1", contact_email: "user@example.com" }],
      ["list_enrollments", {}],
    ];

    for (const [name, args] of cases) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("self_hosted API-only mode");
    }
    expect(existsSync(localDbPath())).toBe(false);
  });
});
