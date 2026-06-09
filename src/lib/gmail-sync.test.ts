import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDatabase, closeDatabase, getDatabase, uuid } from "../db/database.js";
import { getGmailSyncState, setGmailSyncState } from "../db/gmail-sync-state.js";

// ─── Mock @hasna/connectors ───────────────────────────────────────────────────

const mockRun = mock(async (_args: {
  connector: string;
  operation: string;
  input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
}) => ({
  connector: "gmail",
  operation: _args.operation,
  success: true,
  stdout: "[]",
  stderr: "",
  exitCode: 0,
  data: [],
}));

mock.module("@hasna/connectors", () => ({ runConnectorOperation: mockRun }));

mock.module("@aws-sdk/client-s3", () => {
  class S3Client {
    async send() {
      return {};
    }
  }
  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class CreateBucketCommand extends PutObjectCommand {}
  class HeadBucketCommand extends PutObjectCommand {}
  class HeadObjectCommand extends PutObjectCommand {}
  class GetObjectCommand extends PutObjectCommand {}
  class ListObjectsV2Command extends PutObjectCommand {}
  class CopyObjectCommand extends PutObjectCommand {}
  class PutBucketPolicyCommand extends PutObjectCommand {}
  class PutBucketVersioningCommand extends PutObjectCommand {}
  class PutBucketEncryptionCommand extends PutObjectCommand {}
  class PutPublicAccessBlockCommand extends PutObjectCommand {}
  return {
    S3Client,
    CopyObjectCommand,
    CreateBucketCommand,
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutBucketEncryptionCommand,
    PutBucketPolicyCommand,
    PutBucketVersioningCommand,
    PutObjectCommand,
    PutPublicAccessBlockCommand,
  };
});

const { syncGmailInbox, syncGmailInboxAll, syncGmailInboxHistory } = await import("./gmail-sync.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DATE = "Fri, 20 Mar 2026 10:00:00 +0000";
const ARCHIVE_ENV_NAMES = [
  "HASNA_EMAILS_ARCHIVE_S3_BUCKET",
  "HASNA_EMAILS_ARCHIVE_S3_REGION",
  "HASNA_EMAILS_ARCHIVE_S3_PREFIX",
  "EMAILS_ARCHIVE_S3_BUCKET",
  "EMAILS_ARCHIVE_S3_REGION",
  "EMAILS_ARCHIVE_S3_PREFIX",
] as const;
let originalHome: string | undefined;
let originalArchiveEnv: Partial<Record<(typeof ARCHIVE_ENV_NAMES)[number], string | undefined>> = {};
let tmpHome = "";

function makeListOutput(msgs: { id: string; from?: string; subject?: string }[]): string {
  return JSON.stringify(msgs.map((m) => ({ id: m.id, from: m.from ?? "a@b.com", subject: m.subject ?? "S", date: DATE })));
}

function makeReadOutput(m: { id: string; from?: string; to?: string; subject?: string; body?: string; htmlBody?: string }): string {
  return JSON.stringify({
    id: m.id,
    threadId: `thread-${m.id}`,
    labelIds: ["INBOX", "Label_1"],
    historyId: `history-${m.id}`,
    internalDate: "1774000800000",
    from: m.from ?? "a@b.com",
    to: m.to ?? "me@b.com",
    subject: m.subject ?? "S",
    date: DATE,
    body: m.body ?? "text body",
    htmlBody: m.htmlBody ?? "<p>html body</p>",
    size: 200,
  });
}

function setupDb() {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail', 'gmail', 1)`, [providerId]);
  return { db, providerId };
}

function setMock(
  msgs: { id: string; from?: string; subject?: string; body?: string; htmlBody?: string }[],
  readOutputs?: string[],
) {
  let readIdx = 0;
  mockRun.mockImplementation(async (operationArgs: {
    operation: string;
    input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
  }) => {
    const { operation, input } = operationArgs;
    if (operation === "messages.read" || operation === "messages.get") {
      const isHtml = input?.html === true;
      const id = String(input?.args?.[0] ?? "x");
      const msg = msgs.find((m) => m.id === id);
      if (readOutputs && !isHtml) {
        const data = JSON.parse(readOutputs[readIdx++] ?? makeReadOutput({ id }));
        return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (isHtml && msg?.htmlBody) {
        // Return HTML body for --html calls
        const data = { id, from: msg.from ?? "a@b.com", subject: msg.subject ?? "S", date: DATE, body: msg.htmlBody, size: 200 };
        return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      // Return text body
      const data = JSON.parse(makeReadOutput({ id, from: msg?.from, subject: msg?.subject, body: msg?.body, htmlBody: msg?.htmlBody }));
      return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    if (operation === "messages.list") {
      const data = JSON.parse(makeListOutput(msgs));
      return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    // attachments list/download — return empty
    return { connector: "gmail", operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
  });
}

beforeEach(() => {
  mockRun.mockReset();
  originalHome = process.env["HOME"];
  originalArchiveEnv = Object.fromEntries(ARCHIVE_ENV_NAMES.map((name) => [name, process.env[name]]));
  tmpHome = mkdtempSync(join(tmpdir(), "emails-gmail-sync-"));
  process.env["HOME"] = tmpHome;
  for (const name of ARCHIVE_ENV_NAMES) delete process.env[name];
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  for (const name of ARCHIVE_ENV_NAMES) {
    const value = originalArchiveEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

// ─── syncGmailInbox ───────────────────────────────────────────────────────────

describe("syncGmailInbox", () => {
  it("syncs two messages", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1", from: "alice@example.com", subject: "Hello" }, { id: "msg2", from: "bob@example.com", subject: "World" }]);
    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(2);
    expect(result.errors).toHaveLength(0);
    const rows = db.query("SELECT message_id FROM inbound_emails WHERE provider_id = ?").all(providerId) as { message_id: string }[];
    expect(rows.map((r) => r.message_id).sort()).toEqual(["msg1", "msg2"]);
  });

  it("deduplicates on re-run", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1" }]);
    await syncGmailInbox({ providerId, db });
    setMock([{ id: "msg1" }]);
    const r2 = await syncGmailInbox({ providerId, db });
    expect(r2.synced).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("batch-skips known page message ids without fetching details", async () => {
    const { db, providerId } = setupDb();
    const messages = [{ id: "msg1" }, { id: "msg2" }, { id: "msg3" }];
    setMock(messages);
    await syncGmailInbox({ providerId, db });

    mockRun.mockReset();
    mockRun.mockImplementation(async (operationArgs: { operation: string }) => {
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput(messages));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.read") {
        return { connector: "gmail", operation: operationArgs.operation, success: false, stdout: "", stderr: "should not read skipped messages", exitCode: 1 };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    const result = await syncGmailInbox({ providerId, db: recordingDb });

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(mockRun.mock.calls.filter((call) => call[0]?.operation === "messages.read")).toHaveLength(0);
    expect(queries.filter((sql) => sql.includes("message_id IN"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("provider_id = ? AND message_id = ?"))).toHaveLength(0);
  });

  it("claims duplicate message refs once before concurrent detail fetches", async () => {
    const { db, providerId } = setupDb();
    let reads = 0;
    mockRun.mockImplementation(async (operationArgs: {
      operation: string;
      input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
    }) => {
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput([{ id: "dup-msg" }, { id: "dup-msg" }]));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.read") {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const id = String(operationArgs.input?.args?.[0] ?? "x");
        const data = JSON.parse(makeReadOutput({ id }));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    const result = await syncGmailInbox({ providerId, db, messageConcurrency: 2 });

    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(1);
    expect(reads).toBe(1);
  });

  it("stores text and html body separately", async () => {
    const { db, providerId } = setupDb();
    // Provide both text body and HTML body — mock returns them for separate calls
    setMock([{ id: "msg1", body: "plain text", htmlBody: "<b>html</b>" }]);
    await syncGmailInbox({ providerId, db });
    const row = db.query("SELECT text_body, html_body FROM inbound_emails WHERE message_id = 'msg1'").get() as { text_body: string; html_body: string } | null;
    expect(row!.text_body).toBe("plain text");
    expect(row!.html_body).toBe("<b>html</b>");
  });

  it("does not archive to S3 unless an archive bucket is explicitly enabled", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1", body: "plain text", htmlBody: "<b>html</b>" }]);

    const result = await syncGmailInbox({ providerId, db });

    expect(result.synced).toBe(1);
    expect(mockRun.mock.calls.some((call) => call[0]?.operation === "messages.getRaw")).toBe(false);
  });

  it("uses the first full message payload for body and attachment metadata", async () => {
    const { db, providerId } = setupDb();
    mockRun.mockImplementation(async (operationArgs: {
      operation: string;
      input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
    }) => {
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput([{ id: "msg1" }]));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.read") {
        const data = {
          id: "msg1",
          threadId: "thread-msg1",
          labelIds: ["INBOX"],
          historyId: "101",
          from: "a@b.com",
          to: "me@b.com",
          subject: "Payload",
          date: DATE,
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              { mimeType: "text/plain", body: { data: Buffer.from("payload text").toString("base64url") } },
              { mimeType: "text/html", body: { data: Buffer.from("<strong>payload html</strong>").toString("base64url") } },
              { filename: "invoice.pdf", mimeType: "application/pdf", body: { attachmentId: "att1", size: 42 } },
            ],
          },
        };
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    await syncGmailInbox({ providerId, db, downloadAttachments: false });

    expect(mockRun.mock.calls.filter((call) => call[0]?.operation === "messages.read")).toHaveLength(1);
    expect(mockRun.mock.calls.some((call) => call[0]?.operation === "attachments.list")).toBe(false);
    const row = db.query("SELECT text_body, html_body, attachments_json FROM inbound_emails WHERE message_id = 'msg1'").get() as {
      text_body: string;
      html_body: string;
      attachments_json: string;
    } | null;
    expect(row!.text_body).toBe("payload text");
    expect(row!.html_body).toBe("<strong>payload html</strong>");
    expect(JSON.parse(row!.attachments_json)).toEqual([{ filename: "invoice.pdf", content_type: "application/pdf", size: 42 }]);
  });

  it("uses raw Gmail MIME as the archived sync source without extra attachment calls", async () => {
    const { db, providerId } = setupDb();
    const rawMime = [
      "From: Alice <alice@example.com>",
      "To: Me <me@example.com>",
      "Subject: Raw archived",
      "Date: Fri, 20 Mar 2026 10:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=\"b\"",
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "raw text",
      "--b",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>raw html</p>",
      "--b",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=\"invoice.pdf\"",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("pdf").toString("base64"),
      "--b--",
      "",
    ].join("\r\n");

    mockRun.mockImplementation(async (operationArgs: {
      operation: string;
      input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
    }) => {
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput([{ id: "raw-msg" }]));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.getRaw") {
        const data = {
          id: "raw-msg",
          threadId: "thread-raw-msg",
          labelIds: ["INBOX"],
          historyId: "202",
          internalDate: "1774000800000",
          raw: Buffer.from(rawMime).toString("base64url"),
        };
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    const result = await syncGmailInbox({ providerId, db, archiveS3Bucket: "bucket" });

    expect(result.synced).toBe(1);
    expect(result.attachments_saved).toBe(1);
    expect(mockRun.mock.calls.some((call) => call[0]?.operation === "messages.read")).toBe(false);
    expect(mockRun.mock.calls.some((call) => call[0]?.operation === "attachments.download")).toBe(false);
    const row = db.query("SELECT from_address, subject, text_body, html_body, attachments_json FROM inbound_emails WHERE message_id = 'raw-msg'").get() as {
      from_address: string;
      subject: string;
      text_body: string;
      html_body: string;
      attachments_json: string;
    } | null;
    expect(row!.from_address).toContain("alice@example.com");
    expect(row!.subject).toBe("Raw archived");
    expect(row!.text_body).toContain("raw text");
    expect(row!.html_body).toContain("raw html");
    expect(JSON.parse(row!.attachments_json)).toEqual([{ filename: "invoice.pdf", content_type: "application/pdf", size: 3 }]);
  });

  it("stores Gmail archive metadata from connector detail", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1", body: "plain text" }]);
    await syncGmailInbox({ providerId, db });
    const row = db
      .query("SELECT provider_thread_id, provider_history_id, provider_internal_date, label_ids_json FROM inbound_emails WHERE message_id = 'msg1'")
      .get() as {
        provider_thread_id: string;
        provider_history_id: string;
        provider_internal_date: string;
        label_ids_json: string;
      } | null;
    expect(row!.provider_thread_id).toBe("thread-msg1");
    expect(row!.provider_history_id).toBe("history-msg1");
    expect(row!.provider_internal_date).toBe("1774000800000");
    expect(JSON.parse(row!.label_ids_json)).toEqual(["INBOX", "Label_1"]);
  });

  it("returns error when list fails", async () => {
    const { db, providerId } = setupDb();
    mockRun.mockImplementation(async (operationArgs: { operation: string }) => ({
      connector: "gmail",
      operation: operationArgs.operation,
      success: false,
      stdout: "",
      stderr: "auth error",
      exitCode: 1,
    }));
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBe(0);
    expect(r.errors[0]).toContain("Failed to list messages");
  });

  it("isolates per-message errors", async () => {
    const { db, providerId } = setupDb();
    let readCount = 0;
    mockRun.mockImplementation(async (operationArgs: { operation: string }) => {
      if (operationArgs.operation === "messages.read" || operationArgs.operation === "messages.get") {
        readCount++;
        if (readCount === 1) {
          return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "", stderr: "", exitCode: 0 };
        }
        const data = JSON.parse(makeReadOutput({ id: "msg2" }));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput([{ id: "msg1" }, { id: "msg2" }]));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBeGreaterThanOrEqual(1);
  });

  it("does not store metadata-only rows when Gmail detail fetch returns no data", async () => {
    const { db, providerId } = setupDb();
    mockRun.mockImplementation(async (operationArgs: { operation: string }) => {
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput([{ id: "missing-msg" }]));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.getRaw" || operationArgs.operation === "messages.read") {
        return { connector: "gmail", operation: operationArgs.operation, success: false, stdout: "", stderr: "not found", exitCode: 1 };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    const result = await syncGmailInbox({ providerId, db, archiveS3Bucket: "bucket" });

    expect(result.synced).toBe(0);
    expect(result.errors[0]).toContain("Failed to read Gmail message detail for missing-msg");
    const count = db.query("SELECT count(*) as count FROM inbound_emails WHERE message_id = 'missing-msg'").get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("handles empty list", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    const r = await syncGmailInbox({ providerId, db });
    expect(r.synced).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it("passes batchSize to list command", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    await syncGmailInbox({ providerId, batchSize: 5, db });
    const listCall = mockRun.mock.calls.find((c) => c[0]?.operation === "messages.list");
    expect(listCall?.[0]?.input?.max).toBe(5);
  });

  it("passes query to list command", async () => {
    const { db, providerId } = setupDb();
    setMock([]);
    await syncGmailInbox({ providerId, query: "is:unread", db });
    const listCall = mockRun.mock.calls.find((c) => c[0]?.operation === "messages.list");
    expect(listCall?.[0]?.input?.query).toBe("is:unread");
  });

  it("processes message details with bounded concurrency", async () => {
    const { db, providerId } = setupDb();
    let activeReads = 0;
    let maxActiveReads = 0;
    mockRun.mockImplementation(async (operationArgs: {
      operation: string;
      input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
    }) => {
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput([{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }]));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.read" && operationArgs.input?.html !== true) {
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeReads--;
        const id = String(operationArgs.input?.args?.[0] ?? "x");
        const data = JSON.parse(makeReadOutput({ id }));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.read") {
        const id = String(operationArgs.input?.args?.[0] ?? "x");
        const data = { id, body: "<p>html</p>" };
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    const result = await syncGmailInbox({ providerId, db, messageConcurrency: 2 });

    expect(result.synced).toBe(4);
    expect(maxActiveReads).toBe(2);
  });

  it("caps message concurrency at 64 workers", async () => {
    const { db, providerId } = setupDb();
    const messages = Array.from({ length: 65 }, (_, index) => ({ id: `m${index}` }));
    let activeReads = 0;
    let maxActiveReads = 0;
    mockRun.mockImplementation(async (operationArgs: {
      operation: string;
      input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
    }) => {
      if (operationArgs.operation === "messages.list") {
        const data = JSON.parse(makeListOutput(messages));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.read") {
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeReads--;
        const id = String(operationArgs.input?.args?.[0] ?? "x");
        const data = JSON.parse(makeReadOutput({ id }));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    const result = await syncGmailInbox({ providerId, db, messageConcurrency: 128, downloadAttachments: false });

    expect(result.synced).toBe(65);
    expect(maxActiveReads).toBe(64);
  });
});

// ─── syncGmailInboxAll ────────────────────────────────────────────────────────

describe("syncGmailInboxAll", () => {
  it("syncs single page", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "m1" }, { id: "m2" }]);
    const r = await syncGmailInboxAll({ providerId, db });
    expect(r.synced).toBe(2);
    expect(r.done).toBe(true);
  });
});

describe("syncGmailInboxHistory", () => {
  it("syncs changed Gmail messages from stored history cursor and advances it", async () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { history_id: "100" }, db);
    const ops: string[] = [];
    const historyInputs: Array<Record<string, unknown> | undefined> = [];
    mockRun.mockImplementation(async (operationArgs: {
      operation: string;
      input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
    }) => {
      ops.push(operationArgs.operation);
      if (operationArgs.operation === "history.list") {
        historyInputs.push(operationArgs.input);
        const data = {
          historyId: "200",
          history: [
            { id: "150", messagesAdded: [{ message: { id: "hist-msg-1", threadId: "thread-1" } }] },
            { id: "199", labelsAdded: [{ message: { id: "hist-msg-1", threadId: "thread-1" }, labelIds: ["INBOX"] }] },
          ],
        };
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      if (operationArgs.operation === "messages.read") {
        const id = String(operationArgs.input?.args?.[0] ?? "x");
        const isHtml = operationArgs.input?.html === true;
        const data = isHtml
          ? { id, body: "<p>history html</p>" }
          : JSON.parse(makeReadOutput({ id, body: "history text", subject: "History" }));
        return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
      }
      return { connector: "gmail", operation: operationArgs.operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
    });

    const result = await syncGmailInboxHistory({ providerId, db });
    expect(result.synced).toBe(1);
    expect(ops).toContain("history.list");
    expect(ops).not.toContain("messages.list");
    expect(historyInputs[0]).toEqual({ startHistoryId: "100", maxResults: 100 });
    expect(getGmailSyncState(providerId, db)?.history_id).toBe("200");
    const stored = db.query("SELECT message_id, subject FROM inbound_emails").get() as { message_id: string; subject: string };
    expect(stored).toEqual({ message_id: "hist-msg-1", subject: "History" });
  });

  it("falls back to normal sync when no history cursor exists", async () => {
    const { db, providerId } = setupDb();
    setMock([{ id: "msg1" }]);
    const result = await syncGmailInboxHistory({ providerId, db });
    expect(result.synced).toBe(1);
    expect(getGmailSyncState(providerId, db)?.history_id).toBe("history-msg1");
  });
});
