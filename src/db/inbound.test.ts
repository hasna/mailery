import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { getDatabase, resetDatabase, uuid } from "./database.js";
import {
  storeInboundEmail,
  getInboundEmail,
  getInboundEmailSummary,
  getInboundAttachmentPaths,
  listInboundSubjectsForRecipient,
  listInboundEmails,
  listInboundEmailSummaries,
  listReplySummaries,
  deleteInboundEmail,
  clearInboundEmails,
  getInboundCount,
  getReceivedInboundCount,
  getLatestInboundReceivedAt,
  getLatestReceivedInboundAt,
  addInboundLabel,
  removeInboundLabel,
  listReplies,
  listReplyPromptParts,
  getReplyCount,
} from "./inbound.js";

function makeDb(): Database {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  return db;
}

function createProvider(db: Database, name = "test-provider"): string {
  const id = uuid();
  db.run(
    `INSERT INTO providers (id, name, type) VALUES (?, ?, 'sandbox')`,
    [id, name],
  );
  return id;
}

const sampleInput = {
  provider_id: null,
  message_id: "<test123@example.com>",
  from_address: "sender@example.com",
  to_addresses: ["receiver@example.com"],
  cc_addresses: [],
  subject: "Test subject",
  text_body: "Hello, world!",
  html_body: "<p>Hello, world!</p>",
  attachments: [],
  headers: { "content-type": "text/plain" },
  raw_size: 200,
  received_at: new Date().toISOString(),
};

describe("storeInboundEmail", () => {
  it("stores and returns an inbound email", () => {
    const db = makeDb();
    const email = storeInboundEmail(sampleInput, db);
    expect(email.id).toBeTruthy();
    expect(email.from_address).toBe("sender@example.com");
    expect(email.subject).toBe("Test subject");
    expect(email.to_addresses).toEqual(["receiver@example.com"]);
    expect(email.html_body).toBe("<p>Hello, world!</p>");
    expect(email.created_at).toBeTruthy();
  });

  it("returns newly stored inbound email without selecting the row back", () => {
    const db = makeDb();
    const queries: string[] = [];
    const runs: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
        if (prop === "run") return (sql: string, ...args: unknown[]) => {
          runs.push(sql);
          return target.run(sql, ...args);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    const email = storeInboundEmail({
      ...sampleInput,
      message_id: "no-select-back",
      received_at: "2026-01-01T00:00:00.000Z",
    }, recordingDb);

    expect(email.message_id).toBe("no-select-back");
    expect(email.received_at).toBe("2026-01-01T00:00:00.000Z");
    expect(email.is_read).toBe(false);
    expect(runs.filter((sql) => sql.includes("INSERT INTO inbound_emails"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("SELECT * FROM inbound_emails WHERE id = ?"))).toHaveLength(0);
    expect(getInboundEmail(email.id, db)?.created_at).toBe(email.created_at);
  });

  it("stores email with null provider_id", () => {
    const db = makeDb();
    const email = storeInboundEmail({ ...sampleInput, provider_id: null }, db);
    expect(email.provider_id).toBeNull();
  });
});

describe("getInboundEmail", () => {
  it("retrieves a stored email by id", () => {
    const db = makeDb();
    const stored = storeInboundEmail(sampleInput, db);
    const retrieved = getInboundEmail(stored.id, db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(stored.id);
    expect(retrieved!.subject).toBe("Test subject");
  });

  it("returns null for unknown id", () => {
    const db = makeDb();
    expect(getInboundEmail("nonexistent-id", db)).toBeNull();
  });

  it("tolerates malformed attachment path JSON", () => {
    const db = makeDb();
    const stored = storeInboundEmail(sampleInput, db);
    db.run("UPDATE inbound_emails SET attachment_paths = ? WHERE id = ?", ["not-json", stored.id]);

    expect(getInboundEmail(stored.id, db)?.attachment_paths).toEqual([]);
    expect(listInboundEmails({}, db)[0]?.attachment_paths).toEqual([]);
    expect(getInboundAttachmentPaths(stored.id, db)).toEqual([]);
  });

  it("reads attachment paths with a narrow projection", () => {
    const db = makeDb();
    const stored = storeInboundEmail({
      ...sampleInput,
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
      attachments: [{ filename: "report.pdf", content_type: "application/pdf", size: 2048 }],
      attachment_paths: [{ filename: "report.pdf", content_type: "application/pdf", size: 2048, local_path: "/tmp/report.pdf" }],
    }, db);

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

    const paths = getInboundAttachmentPaths(stored.id, recordingDb);

    expect(paths).toEqual([{ filename: "report.pdf", content_type: "application/pdf", size: 2048, local_path: "/tmp/report.pdf" }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("SELECT attachment_paths");
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
  });

  it("returns null attachment paths for an unknown inbound id", () => {
    const db = makeDb();
    expect(getInboundAttachmentPaths("missing", db)).toBeNull();
  });

  it("lists recent received subjects for one recipient through the recipient index", () => {
    const db = makeDb();
    storeInboundEmail({
      ...sampleInput,
      subject: "old target",
      to_addresses: ["Receiver@Example.com"],
      text_body: "old body ".repeat(1000),
      html_body: `<p>${"old html ".repeat(1000)}</p>`,
      headers: { "x-hidden": "old" },
      received_at: "2026-01-01T00:00:00.000Z",
    }, db);
    const archived = storeInboundEmail({
      ...sampleInput,
      subject: "archived target",
      to_addresses: ["receiver@example.com"],
      received_at: "2026-01-03T00:00:00.000Z",
    }, db);
    db.run("UPDATE inbound_emails SET is_archived = 1 WHERE id = ?", [archived.id]);
    storeInboundEmail({
      ...sampleInput,
      subject: "synced sent target",
      to_addresses: ["receiver@example.com"],
      label_ids: ["SENT"],
      received_at: "2026-01-04T00:00:00.000Z",
    }, db);
    storeInboundEmail({
      ...sampleInput,
      subject: "other recipient",
      to_addresses: ["other@example.com"],
      received_at: "2026-01-05T00:00:00.000Z",
    }, db);
    storeInboundEmail({
      ...sampleInput,
      subject: "new target",
      to_addresses: ["receiver@example.com"],
      text_body: "new body ".repeat(1000),
      html_body: `<p>${"new html ".repeat(1000)}</p>`,
      headers: { "x-hidden": "new" },
      received_at: "2026-01-02T00:00:00.000Z",
    }, db);

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

    const subjects = listInboundSubjectsForRecipient(
      "receiver@example.com",
      { since: "2026-01-02T00:00:00.000Z", limit: 10 },
      recordingDb,
    );

    expect(subjects.map((row) => row.subject)).toEqual(["new target"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("FROM inbound_recipients recipient");
    expect(queries[0]).toContain("recipient.address = ?");
    expect(queries[0]).toContain("LIMIT ?");
    expect(queries[0]).not.toContain("to_addresses LIKE");
    expect(queries[0]).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
  });
});

describe("listInboundEmails", () => {
  it("lists all inbound emails", () => {
    const db = makeDb();
    storeInboundEmail(sampleInput, db);
    storeInboundEmail({ ...sampleInput, subject: "Second email" }, db);
    const list = listInboundEmails({}, db);
    expect(list.length).toBe(2);
  });

  it("filters by provider_id", () => {
    const db = makeDb();
    const provId = createProvider(db, "provider-x");
    storeInboundEmail(sampleInput, db);
    storeInboundEmail({ ...sampleInput, provider_id: provId }, db);
    const list = listInboundEmails({ provider_id: provId }, db);
    expect(list.length).toBe(1);
    expect(list[0]!.provider_id).toBe(provId);
  });

  it("respects limit option", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      storeInboundEmail({ ...sampleInput, subject: `Email ${i}` }, db);
    }
    const list = listInboundEmails({ limit: 3 }, db);
    expect(list.length).toBe(3);
  });

  it("respects offset option", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      storeInboundEmail({ ...sampleInput, subject: `Offset Email ${i}` }, db);
    }
    const page1 = listInboundEmails({ limit: 2, offset: 0 }, db).map((e) => e.id);
    const page2 = listInboundEmails({ limit: 2, offset: 2 }, db).map((e) => e.id);

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page2).not.toEqual(page1);
    expect(page2.some((id) => page1.includes(id))).toBe(false);
  });

  it("clamps negative pagination values", () => {
    const db = makeDb();
    for (let i = 0; i < 3; i++) {
      storeInboundEmail({ ...sampleInput, subject: `Clamp ${i}` }, db);
    }

    const withNegative = listInboundEmails({ limit: -5, offset: -10 }, db);
    expect(withNegative.length).toBe(1);
  });

  it("returns empty array when none exist", () => {
    const db = makeDb();
    expect(listInboundEmails({}, db)).toEqual([]);
  });

  it("filters recipient addresses and domains through display-name recipients", () => {
    const db = makeDb();
    storeInboundEmail({
      ...sampleInput,
      subject: "display recipient",
      to_addresses: ['"Target User" <target@example.com>'],
    }, db);

    expect(listInboundEmails({ recipients: ["target@example.com"] }, db).map((email) => email.subject)).toEqual(["display recipient"]);
    expect(listInboundEmails({ recipientDomains: ["example.com"] }, db).map((email) => email.subject)).toEqual(["display recipient"]);
    expect(listInboundEmails({ recipients: ["not-an-email"] }, db)).toEqual([]);
  });

  it("searches in SQL before applying the result limit", () => {
    const db = makeDb();
    storeInboundEmail({
      ...sampleInput,
      subject: "recent unrelated",
      to_addresses: ["recent@example.com"],
      text_body: "nothing to see",
      received_at: "2026-01-03T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      ...sampleInput,
      subject: "older matching",
      to_addresses: ["target@example.com"],
      text_body: "needle body",
      received_at: "2026-01-01T10:00:00.000Z",
    }, db);

    expect(listInboundEmails({ search: "needle", limit: 1 }, db).map((email) => email.subject)).toEqual(["older matching"]);
    expect(listInboundEmails({ search: "target@example.com", limit: 1 }, db).map((email) => email.subject)).toEqual(["older matching"]);
  });

  it("lists summary rows without projecting bodies or headers", () => {
    const db = makeDb();
    storeInboundEmail({
      ...sampleInput,
      subject: "summary",
      text_body: "large text body ".repeat(1000),
      html_body: `<p>${"large html body ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
    }, db);

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

    const [summary] = listInboundEmailSummaries({ limit: 1 }, recordingDb);

    expect(summary?.subject).toBe("summary");
    expect("text_body" in summary!).toBe(false);
    expect("html_body" in summary!).toBe(false);
    expect("headers" in summary!).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
  });

  it("reads one summary by id without projecting bodies or headers", () => {
    const db = makeDb();
    const email = storeInboundEmail({
      ...sampleInput,
      subject: "one summary",
      text_body: "large text body ".repeat(1000),
      html_body: `<p>${"large html body ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
    }, db);

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

    const summary = getInboundEmailSummary(email.id, recordingDb);

    expect(summary?.subject).toBe("one summary");
    expect("text_body" in summary!).toBe(false);
    expect("html_body" in summary!).toBe(false);
    expect("headers" in summary!).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
    expect(getInboundEmailSummary("missing", db)).toBeNull();
  });

  it("excludes imported SENT rows from received-mail lists by default", () => {
    const db = makeDb();
    storeInboundEmail({ ...sampleInput, subject: "received" }, db);
    const sent = storeInboundEmail({
      ...sampleInput,
      subject: "synced sent",
      from_address: "me@example.com",
      to_addresses: ["recipient@example.com"],
      label_ids: ["SENT"],
    }, db);
    const lowerSent = storeInboundEmail({
      ...sampleInput,
      subject: "synced lower sent",
      message_id: "<lower-sent@example.com>",
      from_address: "me@example.com",
      to_addresses: ["recipient@example.com"],
      label_ids: ["sent"],
    }, db);

    expect(sent.is_sent).toBe(true);
    expect(lowerSent.is_sent).toBe(true);
    expect(listInboundEmails({}, db).map((email) => email.subject)).toEqual(["received"]);
    expect(listInboundEmailSummaries({}, db).map((email) => email.subject)).toEqual(["received"]);
    expect(listInboundEmails({ sent: true }, db).map((email) => email.subject).sort()).toEqual(["synced lower sent", "synced sent"]);
    expect(listInboundEmails({ includeSent: true }, db).map((email) => email.subject).sort()).toEqual(["received", "synced lower sent", "synced sent"]);
  });
});

describe("deleteInboundEmail", () => {
  it("deletes an email by id", () => {
    const db = makeDb();
    const email = storeInboundEmail(sampleInput, db);
    const mailMessageId = `msg:inbound:${email.id}`;
    const result = deleteInboundEmail(email.id, db);
    expect(result).toBe(true);
    expect(getInboundEmail(email.id, db)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM mail_messages WHERE id = ?").get(mailMessageId)).toMatchObject({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM mailbox_message_state WHERE mail_message_id = ?").get(mailMessageId)).toMatchObject({ count: 0 });
  });

  it("returns false for unknown id", () => {
    const db = makeDb();
    expect(deleteInboundEmail("nonexistent", db)).toBe(false);
  });
});

describe("clearInboundEmails", () => {
  it("clears all inbound emails and returns count", () => {
    const db = makeDb();
    storeInboundEmail(sampleInput, db);
    storeInboundEmail(sampleInput, db);
    const count = clearInboundEmails(undefined, db);
    expect(count).toBe(2);
    expect(listInboundEmails({}, db)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS count FROM mail_messages").get()).toMatchObject({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM mailbox_message_state").get()).toMatchObject({ count: 0 });
  });

  it("clears by provider_id", () => {
    const db = makeDb();
    const provA = createProvider(db, "prov-a");
    const provB = createProvider(db, "prov-b");
    storeInboundEmail({ ...sampleInput, provider_id: provA }, db);
    storeInboundEmail({ ...sampleInput, provider_id: provB }, db);
    const count = clearInboundEmails(provA, db);
    expect(count).toBe(1);
    const remaining = listInboundEmails({}, db);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.provider_id).toBe(provB);
    expect(db.query("SELECT COUNT(*) AS count FROM mail_messages").get()).toMatchObject({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM mailbox_message_state").get()).toMatchObject({ count: 1 });
  });

  it("returns 0 when nothing to clear", () => {
    const db = makeDb();
    expect(clearInboundEmails(undefined, db)).toBe(0);
  });
});

describe("getInboundCount", () => {
  it("returns count of all inbound emails", () => {
    const db = makeDb();
    storeInboundEmail(sampleInput, db);
    storeInboundEmail(sampleInput, db);
    expect(getInboundCount(undefined, db)).toBe(2);
  });

  it("returns count filtered by provider_id", () => {
    const db = makeDb();
    const provA = createProvider(db, "prov-a");
    storeInboundEmail({ ...sampleInput, provider_id: provA }, db);
    storeInboundEmail(sampleInput, db);
    expect(getInboundCount(provA, db)).toBe(1);
  });

  it("keeps received-only counts separate from synced sent rows", () => {
    const db = makeDb();
    const provA = createProvider(db, "prov-a");
    storeInboundEmail({ ...sampleInput, provider_id: provA, message_id: "received-count", subject: "received" }, db);
    storeInboundEmail({
      ...sampleInput,
      provider_id: provA,
      message_id: "sent-count",
      subject: "synced sent",
      from_address: "me@example.com",
      to_addresses: ["client@example.com"],
      label_ids: ["SENT"],
    }, db);

    expect(getInboundCount(undefined, db)).toBe(2);
    expect(getInboundCount(provA, db)).toBe(2);
    expect(getReceivedInboundCount(undefined, db)).toBe(1);
    expect(getReceivedInboundCount(provA, db)).toBe(1);
  });
});

describe("getLatestInboundReceivedAt", () => {
  it("returns the newest inbound timestamp across archived and active mail", () => {
    const db = makeDb();
    const older = storeInboundEmail({ ...sampleInput, subject: "older", received_at: "2026-01-01T10:00:00.000Z" }, db);
    db.run("UPDATE inbound_emails SET is_archived = 1 WHERE id = ?", [older.id]);
    storeInboundEmail({ ...sampleInput, subject: "newer", received_at: "2026-01-02T10:00:00.000Z" }, db);

    expect(getLatestInboundReceivedAt(db)).toBe("2026-01-02T10:00:00.000Z");
  });

  it("returns null when there is no inbound mail", () => {
    const db = makeDb();
    expect(getLatestInboundReceivedAt(db)).toBeNull();
  });

  it("keeps the received-only newest timestamp separate from synced sent rows", () => {
    const db = makeDb();
    storeInboundEmail({
      ...sampleInput,
      subject: "received",
      received_at: "2026-01-01T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      ...sampleInput,
      subject: "newer sent",
      from_address: "me@example.com",
      to_addresses: ["client@example.com"],
      label_ids: ["SENT"],
      received_at: "2026-01-02T10:00:00.000Z",
    }, db);

    expect(getLatestInboundReceivedAt(db)).toBe("2026-01-02T10:00:00.000Z");
    expect(getLatestReceivedInboundAt(db)).toBe("2026-01-01T10:00:00.000Z");
  });

  it("returns null when there is no received mail", () => {
    const db = makeDb();
    storeInboundEmail({
      ...sampleInput,
      subject: "sent only",
      from_address: "me@example.com",
      to_addresses: ["client@example.com"],
      label_ids: ["SENT"],
      received_at: "2026-01-02T10:00:00.000Z",
    }, db);

    expect(getLatestReceivedInboundAt(db)).toBeNull();
  });
});

describe("label mutations", () => {
  it("recovers from malformed label JSON", () => {
    const db = makeDb();
    const stored = storeInboundEmail(sampleInput, db);
    db.run("UPDATE inbound_emails SET label_ids_json = ? WHERE id = ?", ["not-json", stored.id]);

    expect(addInboundLabel(stored.id, "work", db).label_ids).toEqual(["work"]);
    expect(removeInboundLabel(stored.id, "work", db).label_ids).toEqual([]);
  });

  it("matches labels case-insensitively for filters and mutations", () => {
    const db = makeDb();
    const stored = storeInboundEmail({ ...sampleInput, label_ids: ["Urgent"] }, db);

    expect(listInboundEmails({ label: "urgent" }, db).map((email) => email.id)).toEqual([stored.id]);
    expect(addInboundLabel(stored.id, "urgent", db).label_ids).toEqual(["Urgent"]);
    expect(removeInboundLabel(stored.id, "urgent", db).label_ids).toEqual([]);
  });

  it("normalizes whitespace and length consistently for label filters", () => {
    const db = makeDb();
    const longLabel = `Long ${"Label ".repeat(20)}`;
    const stored = storeInboundEmail({ ...sampleInput, label_ids: ["Needs  Review", "Tab\tLabel", longLabel] }, db);
    const labels = db.query("SELECT label FROM inbound_labels WHERE inbound_email_id = ? ORDER BY label").all(stored.id) as Array<{ label: string }>;

    expect(labels.map((row) => row.label)).toContain("needs-review");
    expect(labels.map((row) => row.label)).toContain("tab-label");
    expect(listInboundEmails({ label: "Needs Review" }, db).map((email) => email.id)).toEqual([stored.id]);
    expect(listInboundEmails({ label: "tab label" }, db).map((email) => email.id)).toEqual([stored.id]);
    expect(listInboundEmails({ label: longLabel }, db).map((email) => email.id)).toEqual([stored.id]);
  });
});

// Helper: insert a provider + email into DB, return the email ID
function insertSentEmail(db: Database, providerMsgId: string): string {
  const pId = uuid();
  db.run(`INSERT INTO providers (id, name, type) VALUES (?, 'p', 'sandbox')`, [pId]);
  const eId = uuid();
  db.run(
    `INSERT INTO emails (id, provider_id, provider_message_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, status, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, 'hello@example.com', '[]', '[]', '[]', 'Hi', 'sent', datetime('now'), datetime('now'), datetime('now'))`,
    [eId, pId, providerMsgId],
  );
  return eId;
}

// ─── Reply tracking ────────────────────────────────────────────────────────────

describe("reply tracking (in_reply_to_email_id)", () => {
  it("stores in_reply_to_email_id when provided explicitly (valid FK)", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "explicit-msg-id");
    const email = storeInboundEmail({ ...sampleInput, in_reply_to_email_id: sentId }, db);
    expect(email.in_reply_to_email_id).toBe(sentId);
  });

  it("auto-detects reply via In-Reply-To header matching provider_message_id", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "original-msg-id-123");
    const inbound = storeInboundEmail({
      ...sampleInput,
      in_reply_to_email_id: null,
      headers: { "In-Reply-To": "<original-msg-id-123>" },
    }, db);
    expect(inbound.in_reply_to_email_id).toBe(sentId);
  });

  it("auto-detects via References header", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "ref-msg-456");
    const inbound = storeInboundEmail({
      ...sampleInput,
      in_reply_to_email_id: null,
      headers: { "References": "other-id-111 <ref-msg-456> another-id-222" },
    }, db);
    expect(inbound.in_reply_to_email_id).toBe(sentId);
  });

  it("returns null in_reply_to_email_id when no matching email found", () => {
    const db = makeDb();
    const inbound = storeInboundEmail({
      ...sampleInput,
      in_reply_to_email_id: null,
      headers: { "In-Reply-To": "<nonexistent-msg-id>" },
    }, db);
    expect(inbound.in_reply_to_email_id).toBeNull();
  });
});

// ─── listReplies + getReplyCount ───────────────────────────────────────────────

describe("listReplies", () => {
  it("lists inbound emails linked to a sent email", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "list-mid-1");
    storeInboundEmail({ ...sampleInput, in_reply_to_email_id: sentId }, db);
    storeInboundEmail({ ...sampleInput, in_reply_to_email_id: sentId }, db);
    expect(listReplies(sentId, db).length).toBe(2);
  });

  it("paginates replies in received order when requested", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "list-mid-paged");
    storeInboundEmail({
      ...sampleInput,
      message_id: "reply-old",
      subject: "Old reply",
      in_reply_to_email_id: sentId,
      received_at: "2026-01-01T00:00:00.000Z",
    }, db);
    storeInboundEmail({
      ...sampleInput,
      message_id: "reply-middle",
      subject: "Middle reply",
      in_reply_to_email_id: sentId,
      received_at: "2026-01-02T00:00:00.000Z",
    }, db);
    storeInboundEmail({
      ...sampleInput,
      message_id: "reply-new",
      subject: "New reply",
      in_reply_to_email_id: sentId,
      received_at: "2026-01-03T00:00:00.000Z",
    }, db);

    const page = listReplies(sentId, db, { limit: 1, offset: 1 });
    expect(page.map((reply) => reply.subject)).toEqual(["Middle reply"]);
  });

  it("returns empty array when no replies", () => {
    const db = makeDb();
    expect(listReplies("nonexistent-email-id", db)).toEqual([]);
  });

  it("lists reply summaries without projecting bodies or headers", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "summary-replies");
    storeInboundEmail({
      ...sampleInput,
      subject: "Summary reply",
      text_body: "large reply body ".repeat(1000),
      html_body: `<p>${"large reply html ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
      in_reply_to_email_id: sentId,
      received_at: "2026-01-01T00:00:00.000Z",
    }, db);
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

    const [summary] = listReplySummaries(sentId, recordingDb, { limit: 1 });

    expect(summary?.subject).toBe("Summary reply");
    expect("text_body" in summary!).toBe(false);
    expect("html_body" in summary!).toBe(false);
    expect("headers" in summary!).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
  });

  it("lists reply prompt parts without projecting html, headers, or attachments", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "prompt-replies");
    storeInboundEmail({
      ...sampleInput,
      subject: "Prompt reply",
      text_body: "short prompt body",
      html_body: `<p>${"large reply html ".repeat(1000)}</p>`,
      attachments: [{ filename: "big.zip", content_type: "application/zip", size: 50_000_000 }],
      attachment_paths: [{ filename: "big.zip", content_type: "application/zip", size: 50_000_000, local_path: "/tmp/big.zip" }],
      headers: { "x-large": "header" },
      in_reply_to_email_id: sentId,
      received_at: "2026-01-01T00:00:00.000Z",
    }, db);
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

    const [part] = listReplyPromptParts(sentId, recordingDb, { limit: 1 });

    expect(part).toEqual({
      from_address: "sender@example.com",
      subject: "Prompt reply",
      text_body: "short prompt body",
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("SELECT from_address, subject, text_body");
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\b(html_body|headers_json|attachments_json|attachment_paths)\b/);
  });
});

describe("getReplyCount", () => {
  it("counts replies for a sent email", () => {
    const db = makeDb();
    const sentId = insertSentEmail(db, "count-mid-2");
    storeInboundEmail({ ...sampleInput, in_reply_to_email_id: sentId }, db);
    expect(getReplyCount(sentId, db)).toBe(1);
  });

  it("returns 0 for email with no replies", () => {
    const db = makeDb();
    expect(getReplyCount("nonexistent", db)).toBe(0);
  });
});
