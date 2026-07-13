import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import { runDomainTool } from "./tools/domains-impl.js";

const API_KEY = "mcp-domain-address-test-key";

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
let apiServer: ReturnType<typeof Bun.spawn> | null = null;

function dbPath(): string {
  if (!tempHome) throw new Error("tempHome not initialized");
  return join(tempHome, ".hasna", "emails", "emails.db");
}

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

const API_SERVER = `
const API_KEY = process.env.TEST_API_KEY;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("authorization") !== "Bearer " + API_KEY) {
      return json({ error: "unauthorized" }, 401);
    }
    const now = "2026-07-13T00:00:00.000Z";
    if (req.method === "GET" && url.pathname === "/v1/domains") {
      return json({
          domains: [
            {
              id: "domain-ready-1",
              domain: "example.com",
              status: "ready",
              provider: "ses",
              verified: true,
              notes: null,
              created_at: now,
              updated_at: now,
            },
            {
              id: "domain-pending-1",
              domain: "pending.example.com",
              status: "pending",
              provider: "ses",
              verified: false,
              notes: null,
              created_at: now,
              updated_at: now,
            },
          ],
        });
    }
    if (req.method === "GET" && url.pathname === "/v1/addresses") {
      return json({
          addresses: [
            {
              id: "addr-ready-1",
              email: "ops@example.com",
              domain: "example.com",
              display_name: "Ops",
              status: "active",
              verified: true,
              daily_quota: null,
              created_at: now,
              updated_at: now,
            },
            {
              id: "addr-pending-1",
              email: "pending@example.com",
              domain: "example.com",
              display_name: null,
              status: "active",
              verified: false,
              daily_quota: null,
              created_at: now,
              updated_at: now,
            },
          ],
        });
    }
    return json({ error: "not found" }, 404);
  },
});
console.log("PORT " + server.port);
`;

async function startApi(): Promise<string> {
  apiServer = Bun.spawn(["bun", "-e", API_SERVER], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, TEST_API_KEY: API_KEY },
  });
  const reader = apiServer.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10000;
  while (!buf.includes("\n") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  reader.releaseLock();
  const port = buf.match(/PORT (\d+)/)?.[1];
  if (!port) throw new Error(`self-hosted domain/address API fixture did not report a port: ${buf}`);
  return `http://127.0.0.1:${port}`;
}

function parseResult<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

beforeEach(async () => {
  resetEnv();
  tempHome = mkdtempSync(join(tmpdir(), "emails-mcp-domain-address-self-hosted-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  closeDatabase();
  resetDatabase();
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = await startApi();
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
  resetSelfHostedConfigCache();
});

afterEach(() => {
  apiServer?.kill();
  apiServer = null;
  closeDatabase();
  resetDatabase();
  resetSelfHostedConfigCache();
  restoreEnv();
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = null;
});

describe("MCP domain/address self_hosted API-only guards", () => {
  it("routes domain and address listing tools through the API without creating local SQLite", async () => {
    expect(existsSync(dbPath())).toBe(false);

    const domainList = parseResult<{
      domains: Array<{ id: string; domain: string }>;
      mode: string;
      source: string;
    }>(await runDomainTool("list_domains", { provider_id: "ses" }));
    const domains = parseResult<{
      domains: Array<{ id: string; domain: string }>;
      mode: string;
      source: string;
    }>(await runDomainTool("list_usable_domains", { send: true }));
    const addresses = parseResult<{
      addresses: Array<{ id: string; email: string }>;
      mode: string;
      source: string;
    }>(await runDomainTool("list_addresses", {}));
    const usableFrom = parseResult<{
      addresses: Array<{ id: string; email: string; readiness: { send_ready: boolean } }>;
      mode: string;
      source: string;
    }>(await runDomainTool("list_usable_from_addresses", { send: true }));
    const verified = parseResult<{
      email: string;
      verified: boolean;
      mode: string;
      source: string;
    }>(await runDomainTool("verify_address", { address_id: "addr-ready" }));

    expect(existsSync(dbPath())).toBe(false);
    expect(domainList).toMatchObject({
      mode: "self_hosted",
      source: "self_hosted_api",
    });
    expect(domainList.domains.map((domain) => domain.domain)).toEqual(["example.com", "pending.example.com"]);
    expect(domains).toMatchObject({
      mode: "self_hosted",
      source: "self_hosted_api",
      domains: [{ id: "domain-ready-1", domain: "example.com" }],
    });
    expect(addresses).toMatchObject({
      mode: "self_hosted",
      source: "self_hosted_api",
    });
    expect(addresses.addresses.map((address) => address.email)).toEqual(["ops@example.com", "pending@example.com"]);
    expect(usableFrom).toMatchObject({
      mode: "self_hosted",
      source: "self_hosted_api",
    });
    expect(usableFrom.addresses.map((address) => address.email)).toEqual(["ops@example.com", "pending@example.com"]);
    expect(usableFrom.addresses.every((address) => address.readiness.send_ready)).toBe(true);
    expect(verified).toMatchObject({
      email: "ops@example.com",
      verified: true,
      mode: "self_hosted",
      source: "self_hosted_api",
    });
  });

  it("fails local-only domain/address MCP tools before creating local SQLite", async () => {
    for (const [name, args] of [
      ["get_dns_records", { domain: "example.com" }],
      ["verify_domain", { domain: "example.com" }],
      ["remove_domain", { domain_id: "domain-ready-1" }],
      ["get_address_owner", { address: "ops@example.com" }],
      ["set_address_owner", { address: "ops@example.com", owner: "owner" }],
      ["transfer_address_owner", { address: "ops@example.com", owner: "owner", reason: "test" }],
      ["unassign_address_owner", { address: "ops@example.com", reason: "test" }],
      ["list_address_owner_history", { address: "ops@example.com" }],
      ["suggest_address", { domain: "example.com" }],
      ["remove_address", { address_id: "addr-ready-1" }],
      ["suspend_address", { address_id: "addr-ready-1" }],
      ["activate_address", { address_id: "addr-ready-1" }],
      ["set_address_quota", { address_id: "addr-ready-1", per_day: 5 }],
    ] as const) {
      const result = await runDomainTool(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text ?? "").toContain("self_hosted API-only mode");
      expect(existsSync(dbPath())).toBe(false);
    }
  });
});
