import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "../db/database.js";
import { storeInboundEmail, listInboundEmails } from "../db/inbound.js";
import { resetMailDataSource } from "../lib/mail-data-source.js";
const { runInboxTool } = await import("./tools/inbox-impl.js");

// ─── Local harness (SqliteMailDataSource behind the seam) ──────────────────────

const ORIGINAL_HOME = process.env["HOME"];
const ISOLATED_ENV_KEYS = [
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
const ORIGINAL_ENV = new Map<string, string | undefined>(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
let tmpHome: string | null = null;

function resetIsolatedEnv(): void {
  for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
}

function restoreIsolatedEnv(): void {
  for (const key of ISOLATED_ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const pid = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'SES', 'ses', 1)`, [pid]);
  return { db, pid };
}

function seed(providerId: string, n: number) {
  const db = getDatabase();
  for (let i = 0; i < n; i++) {
    storeInboundEmail({
      provider_id: providerId, message_id: `mcp-msg-${i}`, in_reply_to_email_id: null,
      from_address: `from${i}@example.com`, to_addresses: ["me@example.com"], cc_addresses: [],
      subject: `MCP Subject ${i}`, text_body: `MCP body text number ${i}`, html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: new Date(2026, 5, 1, 12, 0, i).toISOString(),
    }, db);
  }
}

function seedOne(providerId: string | null, overrides: Partial<Parameters<typeof storeInboundEmail>[0]> = {}) {
  const db = getDatabase();
  return storeInboundEmail({
    provider_id: providerId,
    message_id: "mcp-action-msg",
    in_reply_to_email_id: null,
    from_address: "from@example.com",
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject: "MCP Action Subject",
    text_body: "MCP action body",
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 80,
    received_at: new Date().toISOString(),
    ...overrides,
  }, db);
}

async function toolJson(name: Parameters<typeof runInboxTool>[0], input: Record<string, unknown>) {
  const result = await runInboxTool(name, input);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  resetIsolatedEnv();
  tmpHome = mkdtempSync(join(tmpdir(), "emails-mcp-inbox-"));
  process.env["HOME"] = tmpHome;
  process.env["EMAILS_MODE"] = "local";
  resetMailDataSource();
});
afterEach(() => {
  closeDatabase();
  resetMailDataSource();
  restoreIsolatedEnv();
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

// ─── search_inbound DB filter primitives (unchanged local read logic) ──────────

describe("inbound search primitives", () => {
  it("matches subject", () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const db = getDatabase();
    const results = listInboundEmails({ provider_id: pid, limit: 100, search: "subject 2" }, db);
    expect(results).toHaveLength(1);
  });

  it("returns empty for no match", () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const db = getDatabase();
    const results = listInboundEmails({ provider_id: pid, limit: 100, search: "zzz-no-match" }, db);
    expect(results).toHaveLength(0);
  });
});

// ─── local mode: tools route through SqliteMailDataSource ──────────────────────

describe("MCP inbox tools — local via seam", () => {
  it("list_inbound_emails returns local inbox items (body-free) with truncation", async () => {
    const { pid } = setupDb();
    seed(pid, 3);
    const result = await toolJson("list_inbound_emails", { provider_id: pid, limit: 1 });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(items[0]).not.toHaveProperty("text_body");
    expect(String(items[0]!.subject)).toContain("MCP Subject");
  });

  it("search_inbound matches subject locally", async () => {
    const { pid } = setupDb();
    seed(pid, 5);
    const result = await toolJson("search_inbound", { provider_id: pid, query: "Subject 2", limit: 10 });
    const items = result.items as Array<{ subject: string }>;
    expect(items.map((item) => item.subject)).toEqual(["MCP Subject 2"]);
  });

  it("get_inbound_email returns the full detail with body", async () => {
    const { pid } = setupDb();
    const email = seedOne(pid, { subject: "Detail subject", text_body: "detail body here" });
    const detail = await toolJson("get_inbound_email", { id: email.id });
    expect(detail.id).toBe(email.id);
    expect(detail.subject).toBe("Detail subject");
    expect(detail.text_body).toBe("detail body here");
  });

  it("mark_email_read flips local read state and returns a body-free summary", async () => {
    const { pid } = setupDb();
    const email = seedOne(pid);
    const result = await toolJson("mark_email_read", { email_id: email.id });
    expect(result.id).toBe(email.id);
    expect(result.is_read).toBe(true);
    expect(result).not.toHaveProperty("text_body");
  });
});

describe("mailbox source tools", () => {
  it("lists sources, folder status, and source-filtered search without hiding legacy mail", async () => {
    const { db, pid } = setupDb();
    storeInboundEmail({
      provider_id: pid, message_id: "mcp-provider-source", in_reply_to_email_id: null,
      from_address: "sender@example.com", to_addresses: ["ops@example.com"], cc_addresses: [],
      subject: "mcp provider needle", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 1,
      received_at: "2026-01-02T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: null, message_id: "mcp-legacy-source", in_reply_to_email_id: null,
      from_address: "legacy@example.com", to_addresses: ["ops@example.com"], cc_addresses: [],
      subject: "mcp legacy needle", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 1,
      received_at: "2026-01-03T10:00:00.000Z",
    }, db);

    const sources = await toolJson("list_mailbox_sources", {});
    const sourceItems = sources.sources as Array<{ id: string; badges: string[]; total: number }>;
    expect(sourceItems.find((source) => source.id === `provider:${pid}`)).toMatchObject({ total: 1 });
    expect(sourceItems.find((source) => source.id === "legacy")?.badges).toContain("legacy");

    const legacyStatus = await toolJson("list_mailboxes", { source_id: "legacy" });
    expect((legacyStatus.counts as { inbox: number }).inbox).toBe(1);
    expect(legacyStatus.cli_equivalent).toBe("emails inbox mailboxes --source legacy --json");

    const search = await toolJson("search_mailbox", { query: "needle", source_id: `provider:${pid}` });
    expect((search.items as Array<{ subject: string }>).map((item) => item.subject)).toEqual(["mcp provider needle"]);
    expect(search.cli_equivalent).toBe(`emails inbox search needle --folder inbox --source provider:${pid} --json`);
  });
});

describe("MCP local state mutations", () => {
  it("keeps local state mutations local", async () => {
    const { pid } = setupDb();
    const email = seedOne(pid);
    const result = await toolJson("mark_email_read", { email_id: email.id });
    expect(result.is_read).toBe(true);
  });
});
