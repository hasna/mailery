/**
 * Tests for inbox CLI commands — tests the underlying DB/sync logic
 * exercised by `emails inbox` subcommands.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase, closeDatabase, uuid, getDataDir } from "../../db/database.js";
import { storeInboundEmail, listInboundEmails, getInboundEmail, getInboundCount, clearInboundEmails } from "../../db/inbound.js";
import { getGmailSyncState, updateLastSynced, setGmailSyncState } from "../../db/gmail-sync-state.js";

// ─── Mock @hasna/connectors before any gmail-sync imports ─────────────────────

const DATE = "Fri, 20 Mar 2026 10:00:00 +0000";
let mockListMsgs: { id: string; subject?: string; from?: string }[] = [];

const mockRun = mock(async (_n: string, args: string[]) => {
  const a = args as string[];
  if (a.includes("list")) {
    return { success: true, stdout: JSON.stringify(mockListMsgs.map((m) => ({ id: m.id, from: m.from ?? "a@b.com", subject: m.subject ?? "S", date: DATE }))), stderr: "", exitCode: 0 };
  }
  if (a.includes("read") || a.includes("get")) {
    const id = a.find((x) => x.length > 5 && !x.startsWith("-")) ?? "x";
    const m = mockListMsgs.find((x) => x.id === id);
    return { success: true, stdout: JSON.stringify({ id, from: m?.from ?? "a@b.com", to: "me@b.com", subject: m?.subject ?? "S", date: DATE, body: "body", htmlBody: "<p>body</p>", size: 100 }), stderr: "", exitCode: 0 };
  }
  return { success: true, stdout: "[]", stderr: "", exitCode: 0 };
});

mock.module("@hasna/connectors", () => ({ runConnectorCommand: mockRun }));

const { syncGmailInbox } = await import("../../lib/gmail-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail Test', 'gmail', 1)`, [providerId]);
  return { db, providerId };
}

function seedInboundEmails(providerId: string, count: number) {
  const db = getDatabase();
  const emails = [];
  for (let i = 0; i < count; i++) {
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: `msg-${i}`,
      in_reply_to_email_id: null,
      from_address: `sender${i}@example.com`,
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: `Test Subject ${i}`,
      text_body: `Body content for email ${i}`,
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: new Date(2026, 2, 20 - i).toISOString(),
    }, db);
    emails.push(email);
  }
  return emails;
}

beforeEach(() => {
  mockListMsgs = [];
  mockRun.mockReset();
  mockRun.mockImplementation(async (_n: string, args: string[]) => {
    const a = args as string[];
    if (a.includes("messages") && a.includes("list")) {
      return { success: true, stdout: JSON.stringify(mockListMsgs.map((m) => ({ id: m.id, from: m.from ?? "a@b.com", subject: m.subject ?? "S", date: DATE }))), stderr: "", exitCode: 0 };
    }
    if (a.includes("read") || a.includes("get")) {
      const idx = Math.max(a.indexOf("read"), a.indexOf("get"));
      const id = a[idx + 1] ?? "x";
      const m = mockListMsgs.find((x) => x.id === id);
      return { success: true, stdout: JSON.stringify({ id, from: m?.from ?? "a@b.com", to: "me@b.com", subject: m?.subject ?? "S", date: DATE, body: "body", htmlBody: "<p>body</p>", size: 100 }), stderr: "", exitCode: 0 };
    }
    if (a.includes("attachments") && a.includes("list")) {
      return { success: true, stdout: JSON.stringify([{ attachmentId: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 12 }]), stderr: "", exitCode: 0 };
    }
    if (a.includes("attachments") && a.includes("download")) {
      const dirIndex = a.indexOf("--dir");
      const outputDir = dirIndex >= 0 ? a[dirIndex + 1] : undefined;
      if (outputDir) {
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, "invoice.pdf"), "pdf-data");
      }
      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    }
    return { success: true, stdout: "[]", stderr: "", exitCode: 0 };
  });
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
});

// ─── inbox list (listInboundEmails) ──────────────────────────────────────────

describe("inbox list — listInboundEmails", () => {
  it("returns all synced emails", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 3);

    const emails = listInboundEmails({ provider_id: providerId });
    expect(emails).toHaveLength(3);
  });

  it("respects limit option", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 10);

    const emails = listInboundEmails({ provider_id: providerId, limit: 3 });
    expect(emails).toHaveLength(3);
  });

  it("filters by provider_id", () => {
    const { db, providerId } = setupDb();
    seedInboundEmails(providerId, 2);

    // Create a second provider and seed it
    const otherId = uuid();
    db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Other', 'gmail', 1)`, [otherId]);
    storeInboundEmail({
      provider_id: otherId,
      message_id: "other-msg",
      in_reply_to_email_id: null,
      from_address: "other@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Other email",
      text_body: "Other body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 50,
      received_at: new Date().toISOString(),
    }, db);

    const emails = listInboundEmails({ provider_id: providerId });
    expect(emails.every(e => e.provider_id === providerId)).toBe(true);
    expect(emails).toHaveLength(2);
  });

  it("filters by since date", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 5); // emails dated Mar 20, 19, 18, 17, 16

    // Only emails from Mar 19 onward (2 emails: idx 0 = Mar 20, idx 1 = Mar 19)
    const cutoff = new Date(2026, 2, 19).toISOString();
    const emails = listInboundEmails({ provider_id: providerId, since: cutoff });
    expect(emails.length).toBeLessThanOrEqual(2);
    for (const e of emails) {
      expect(new Date(e.received_at) >= new Date(cutoff)).toBe(true);
    }
  });

  it("returns empty array when no emails", () => {
    setupDb();
    const emails = listInboundEmails();
    expect(emails).toHaveLength(0);
  });
});

// ─── inbox search (local filter) ─────────────────────────────────────────────

describe("inbox search — local filter", () => {
  it("filters by subject substring", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 5);

    const q = "subject 2".toLowerCase();
    const all = listInboundEmails({ provider_id: providerId, limit: 100 });
    const results = all.filter(e => e.subject.toLowerCase().includes(q));
    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toContain("2");
  });

  it("filters by from_address", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 5);

    const q = "sender3@example.com";
    const all = listInboundEmails({ provider_id: providerId, limit: 100 });
    const results = all.filter(e => e.from_address.toLowerCase().includes(q));
    expect(results).toHaveLength(1);
    expect(results[0]!.from_address).toBe("sender3@example.com");
  });

  it("filters by body text", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 5);

    const q = "body content for email 4";
    const all = listInboundEmails({ provider_id: providerId, limit: 100 });
    const results = all.filter(e => (e.text_body ?? "").toLowerCase().includes(q));
    expect(results).toHaveLength(1);
    expect(results[0]!.text_body).toContain("4");
  });

  it("returns empty for no match", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 3);

    const q = "zzz-no-match-zzz";
    const all = listInboundEmails({ provider_id: providerId, limit: 100 });
    const results = all.filter(e => e.subject.toLowerCase().includes(q) || e.from_address.toLowerCase().includes(q));
    expect(results).toHaveLength(0);
  });
});

// ─── inbox sync (via syncGmailInbox) ─────────────────────────────────────────

describe("inbox sync — syncGmailInbox", () => {
  it("falls back to local_path when S3 upload credentials are unavailable", async () => {
    const { db, providerId } = setupDb();
    process.env["HOME"] = "/home/hasna";
    process.env["AWS_ACCESS_KEY_ID"] = "test-key";
    process.env["AWS_SECRET_ACCESS_KEY"] = "test-secret";
    mockListMsgs = [{ id: "gmail-att-1", subject: "Attachment Test", from: "a@test.com" }];

    const result = await syncGmailInbox({ providerId, db });

    expect(result.synced).toBe(1);
    expect(result.attachments_saved).toBe(1);
    expect(result.errors).toHaveLength(1);

    const stored = listInboundEmails({ provider_id: providerId }, db);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.attachment_paths).toEqual([
      {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size: 8,
        local_path: join(getDataDir(), "attachments", stored[0]!.id, "invoice.pdf"),
      },
    ]);
  });

  it("syncs messages and they appear in listInboundEmails", async () => {
    const { db, providerId } = setupDb();
    mockListMsgs = [{ id: "cli-msg1", subject: "CLI Test 1", from: "a@test.com" }, { id: "cli-msg2", subject: "CLI Test 2", from: "b@test.com" }];
    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(2);
    const stored = listInboundEmails({ provider_id: providerId });
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.subject).sort()).toEqual(["CLI Test 1", "CLI Test 2"]);
  });

  it("getInboundCount reflects synced messages", async () => {
    const { db, providerId } = setupDb();
    mockListMsgs = [{ id: "m1" }, { id: "m2" }];
    await syncGmailInbox({ providerId, db });
    expect(getInboundCount(providerId, db)).toBe(2);
  });

  it("getInboundEmail retrieves synced message by id", async () => {
    const { db, providerId } = setupDb();
    mockListMsgs = [{ id: "m1" }];
    await syncGmailInbox({ providerId, db });
    const emails = listInboundEmails({ provider_id: providerId }, db);
    const fetched = getInboundEmail(emails[0]!.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.message_id).toBe(emails[0]!.message_id);
  });

  it("clearInboundEmails removes synced messages", async () => {
    const { db, providerId } = setupDb();
    mockListMsgs = [{ id: "m1" }, { id: "m2" }];
    await syncGmailInbox({ providerId, db });
    expect(getInboundCount(providerId, db)).toBe(2);
    clearInboundEmails(providerId, db);
    expect(getInboundCount(providerId, db)).toBe(0);
  });
});

// ─── inbox status (getGmailSyncState / updateLastSynced) ─────────────────────

describe("inbox status — sync state tracking", () => {
  it("returns null state before any sync", () => {
    const { providerId } = setupDb();
    const state = getGmailSyncState(providerId);
    expect(state).toBeNull();
  });

  it("updateLastSynced sets last_synced_at", () => {
    const { db, providerId } = setupDb();
    const before = new Date().toISOString();
    updateLastSynced(providerId, "msg-xyz", db);
    const state = getGmailSyncState(providerId, db);
    expect(state).not.toBeNull();
    expect(new Date(state!.last_synced_at!).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(state!.last_message_id).toBe("msg-xyz");
  });

  it("setGmailSyncState updates existing state", () => {
    const { db, providerId } = setupDb();
    updateLastSynced(providerId, "first-msg", db);

    setGmailSyncState(providerId, { history_id: "12345" }, db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.history_id).toBe("12345");
    expect(state!.last_message_id).toBe("first-msg"); // preserved
  });

  it("clears next_page_token on updateLastSynced", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { next_page_token: "tok123" }, db);
    updateLastSynced(providerId, undefined, db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.next_page_token).toBeNull();
  });
});
