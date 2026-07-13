import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "./server.js";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import { resetMailDataSource } from "../lib/mail-data-source.js";

const API_KEY = "emails_test_key";
const ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_CLIENT_ENV_SECRET",
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

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

let tempHome: string | null = null;
let apiServer: ReturnType<typeof Bun.serve> | null = null;
let apiOrigin = "";
let sentBodies: Array<Record<string, unknown>> = [];

function resetEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function startApi(): void {
  sentBodies = [];
  apiServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) {
        return json({ error: "unauthorized" }, 401);
      }
      if (req.method === "POST" && url.pathname === "/v1/messages/send") {
        const body = await req.json() as Record<string, unknown>;
        sentBodies.push(body);
        const now = new Date().toISOString();
        return json({
          message: {
            id: "mcp-self-hosted-send-1",
            message_id: "provider-message-1",
            direction: "outbound",
            from_addr: body.from,
            to_addrs: body.to,
            subject: body.subject,
            body_text: body.text,
            body_html: body.html,
            is_read: true,
            labels: [],
            created_at: now,
            updated_at: now,
          },
        });
      }
      return json({ error: "not found" }, 404);
    },
  });
  apiOrigin = `http://127.0.0.1:${apiServer.port}`;
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
  resetEnv();
  tempHome = mkdtempSync(join(tmpdir(), "emails-mcp-self-hosted-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
  startApi();
  process.env["EMAILS_SELF_HOSTED_URL"] = apiOrigin;
  resetSelfHostedConfigCache();
  resetMailDataSource();
});

afterEach(() => {
  apiServer?.stop(true);
  apiServer = null;
  apiOrigin = "";
  closeDatabase();
  resetDatabase();
  resetMailDataSource();
  resetSelfHostedConfigCache();
  restoreEnv();
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = null;
});

describe("MCP self_hosted guards", () => {
  it("routes send_email through the self-hosted API without creating a local DB", async () => {
    const result = await callTool("send_email", {
      from: "ops@example.com",
      to: ["user@example.com"],
      subject: "Self-hosted MCP send",
      text: "hello",
      idempotency_key: "mcp-self-hosted-send",
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(resultText(result))).toMatchObject({
      success: true,
      email_id: "mcp-self-hosted-send-1",
      message_id: "provider-message-1",
    });
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toMatchObject({
      from: "ops@example.com",
      to: ["user@example.com"],
      subject: "Self-hosted MCP send",
      text: "hello",
      idempotency_key: "mcp-self-hosted-send",
    });
    expect(existsSync(dbPath())).toBe(false);
  });

  it("fails local-state MCP tools before creating a local DB in self_hosted mode", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["batch_send", { recipients: [], template_name: "welcome", from_address: "ops@example.com" }],
      ["pull_events", {}],
      ["get_stats", {}],
      ["get_email_content", { email_id: "email-1" }],
      ["list_templates", {}],
      ["list_sandbox_emails", {}],
      ["run_doctor", {}],
      ["export_emails", {}],
      ["sync_s3_inbox", { bucket: "inbound-bucket" }],
      ["provision_address", { email: "ops@example.com", provider_id: "provider-1" }],
      ["provision_status", {}],
    ];

    for (const [name, args] of cases) {
      const result = await callTool(name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("self_hosted API-only mode");
    }
    expect(existsSync(dbPath())).toBe(false);
  });
});
