import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "../db/database.js";
import { storeInboundEmail, listInboundEmails } from "../db/inbound.js";
import { getGmailSyncState, updateLastSynced } from "../db/gmail-sync-state.js";

// ─── Mock @hasna/connectors ───────────────────────────────────────────────────

const mockRun = mock(async (operationArgs: { operation: string }) => ({
  connector: "gmail",
  operation: operationArgs.operation,
  success: true,
  stdout: "[]",
  stderr: "",
  exitCode: 0,
  data: [],
}));

mock.module("@hasna/connectors", () => ({ runConnectorOperation: mockRun }));

const { syncGmailInbox, syncGmailInboxAll } = await import("../lib/gmail-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DATE = "Fri, 20 Mar 2026 10:00:00 +0000";

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const pid = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail', 'gmail', 1)`, [pid]);
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
      received_at: new Date().toISOString(),
    }, db);
  }
}

function setMock(listOutput: string, readOutput?: string) {
  mockRun.mockImplementation(async (operationArgs: { operation: string }) => {
    if (operationArgs.operation === "messages.read" || operationArgs.operation === "messages.get") {
      const data = JSON.parse(readOutput ?? JSON.stringify({ id: "t1", from: "a@x.com", to: "me@x.com", subject: "S1", date: DATE, body: "Hello MCP", size: 100 }));
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    if (operationArgs.operation === "messages.list") {
      const data = JSON.parse(listOutput);
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
  });
}

beforeEach(() => mockRun.mockReset());
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

// ─── sync_inbox tool logic ────────────────────────────────────────────────────

describe("sync_inbox tool logic", () => {
  it("returns synced/skipped/errors/done shape", async () => {
    const { db, pid } = setupDb();
    setMock('[{"id":"t1","from":"a@x.com","subject":"S1","date":"' + DATE + '"}]');
    const r = await syncGmailInbox({ providerId: pid, db });
    expect(typeof r.synced).toBe("number");
    expect(typeof r.skipped).toBe("number");
    expect(Array.isArray(r.errors)).toBe(true);
    expect(typeof r.done).toBe("boolean");
    expect(typeof r.attachments_saved).toBe("number");
  });

  it("synced=1 after one message", async () => {
    const { db, pid } = setupDb();
    setMock('[{"id":"t1","from":"a@x.com","subject":"S1","date":"' + DATE + '"}]');
    const r = await syncGmailInbox({ providerId: pid, db });
    expect(r.synced).toBe(1);
    expect(r.errors).toHaveLength(0);
  });

  it("errors when list fails", async () => {
    const { db, pid } = setupDb();
    mockRun.mockImplementation(async (operationArgs: { operation: string }) => ({
      connector: "gmail",
      operation: operationArgs.operation,
      success: false,
      stdout: "",
      stderr: "auth fail",
      exitCode: 1,
    }));
    const r = await syncGmailInbox({ providerId: pid, db });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain("Failed to list messages");
  });

  it("updateLastSynced sets last_synced_at", async () => {
    const { db, pid } = setupDb();
    setMock('[{"id":"t1","from":"a@x.com","subject":"S1","date":"' + DATE + '"}]');
    await syncGmailInbox({ providerId: pid, db });
    updateLastSynced(pid, undefined, db);
    const state = getGmailSyncState(pid, db);
    expect(state?.last_synced_at).toBeTruthy();
  });

  it("syncGmailInboxAll returns done=true", async () => {
    const { db, pid } = setupDb();
    setMock('[{"id":"t1","from":"a@x.com","subject":"S1","date":"' + DATE + '"}]');
    const r = await syncGmailInboxAll({ providerId: pid, db });
    expect(r.done).toBe(true);
    expect(r.synced).toBe(1);
  });
});

// ─── search_inbound tool logic ────────────────────────────────────────────────

describe("search_inbound tool logic", () => {
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

  it("searches before applying the result limit", () => {
    const { db, pid } = setupDb();
    storeInboundEmail({
      provider_id: pid, message_id: "recent", in_reply_to_email_id: null,
      from_address: "recent@example.com", to_addresses: ["me@example.com"], cc_addresses: [],
      subject: "recent unrelated", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: pid, message_id: "older", in_reply_to_email_id: null,
      from_address: "older@example.com", to_addresses: ["target@example.com"], cc_addresses: [],
      subject: "older match", text_body: "needle body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const results = listInboundEmails({ provider_id: pid, limit: 1, search: "needle" }, db);

    expect(results.map((email) => email.subject)).toEqual(["older match"]);
  });

  it("filters sender and subject before applying the result limit", () => {
    const { db, pid } = setupDb();
    storeInboundEmail({
      provider_id: pid, message_id: "recent-noise", in_reply_to_email_id: null,
      from_address: "updates@example.com", to_addresses: ["me@example.com"], cc_addresses: [],
      subject: "recent unrelated", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: pid, message_id: "older-target", in_reply_to_email_id: null,
      from_address: "security@example.com", to_addresses: ["me@example.com"], cc_addresses: [],
      subject: "target login alert", text_body: "body", html_body: null,
      attachments: [], attachment_paths: [], headers: {}, raw_size: 80,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const results = listInboundEmails({
      provider_id: pid,
      recipients: ["me@example.com"],
      from: "security",
      subject: "target",
      limit: 1,
    }, db);

    expect(results.map((email) => email.subject)).toEqual(["target login alert"]);
  });
});

// ─── get_inbox_sync_status tool logic ────────────────────────────────────────

describe("get_inbox_sync_status tool logic", () => {
  it("null before any sync", () => {
    const { pid } = setupDb();
    const db = getDatabase();
    expect(getGmailSyncState(pid, db)?.last_synced_at ?? null).toBeNull();
  });

  it("reflects updateLastSynced", () => {
    const { db, pid } = setupDb();
    updateLastSynced(pid, "last-id", db);
    const state = getGmailSyncState(pid, db);
    expect(state!.last_synced_at).toBeTruthy();
    expect(state!.last_message_id).toBe("last-id");
  });
});
