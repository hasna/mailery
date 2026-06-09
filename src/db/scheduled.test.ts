import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import {
  createScheduledEmail,
  getScheduledEmail,
  listScheduledEmails,
  listScheduledEmailSummaries,
  cancelScheduledEmail,
  getDueEmails,
  markSent,
  markFailed,
} from "./scheduled.js";

let testProviderId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  // Create a test provider
  const provider = createProvider({ name: "test", type: "resend", api_key: "re_test" }, db);
  testProviderId = provider.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createScheduledEmail", () => {
  it("creates a scheduled email", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      subject: "Test Subject",
      html: "<p>Hello</p>",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    expect(scheduled.id).toHaveLength(36);
    expect(scheduled.provider_id).toBe(testProviderId);
    expect(scheduled.from_address).toBe("sender@example.com");
    expect(scheduled.to_addresses).toEqual(["alice@example.com"]);
    expect(scheduled.subject).toBe("Test Subject");
    expect(scheduled.html).toBe("<p>Hello</p>");
    expect(scheduled.status).toBe("pending");
    expect(scheduled.scheduled_at).toBe("2030-01-01T00:00:00.000Z");
    expect(scheduled.error).toBeNull();
  });

  it("creates with cc, bcc, reply_to", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      cc_addresses: ["bob@example.com"],
      bcc_addresses: ["charlie@example.com"],
      reply_to: "reply@example.com",
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    expect(scheduled.cc_addresses).toEqual(["bob@example.com"]);
    expect(scheduled.bcc_addresses).toEqual(["charlie@example.com"]);
    expect(scheduled.reply_to).toBe("reply@example.com");
  });

  it("creates with template info", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      subject: "Hello {{name}}",
      template_name: "welcome",
      template_vars: { name: "Alice" },
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    expect(scheduled.template_name).toBe("welcome");
    expect(scheduled.template_vars).toEqual({ name: "Alice" });
  });
});

describe("getScheduledEmail", () => {
  it("retrieves by id", () => {
    const created = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    const found = getScheduledEmail(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("tolerates malformed recipient, attachment, and template JSON", () => {
    const db = getDatabase();
    const created = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      cc_addresses: ["bob@example.com"],
      bcc_addresses: ["charlie@example.com"],
      subject: "Bad JSON",
      attachments_json: [{ filename: "a.txt" }],
      template_vars: { name: "Alice" },
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });
    db.run(
      "UPDATE scheduled_emails SET to_addresses = ?, cc_addresses = ?, bcc_addresses = ?, attachments_json = ?, template_vars = ? WHERE id = ?",
      ["not-json", "{}", "not-json", "not-json", "not-json", created.id],
    );

    const found = getScheduledEmail(created.id);
    expect(found?.to_addresses).toEqual([]);
    expect(found?.cc_addresses).toEqual([]);
    expect(found?.bcc_addresses).toEqual([]);
    expect(found?.attachments_json).toEqual([]);
    expect(found?.template_vars).toEqual({});
  });

  it("returns null for unknown id", () => {
    expect(getScheduledEmail("nonexistent")).toBeNull();
  });
});

describe("listScheduledEmails", () => {
  it("returns empty array when none exist", () => {
    expect(listScheduledEmails()).toEqual([]);
  });

  it("lists all scheduled emails", () => {
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test 1",
      scheduled_at: "2030-01-02T00:00:00.000Z",
    });
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["b@example.com"],
      subject: "Test 2",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    const all = listScheduledEmails();
    expect(all.length).toBe(2);
    // Ordered by scheduled_at ASC
    expect(all[0]!.subject).toBe("Test 2");
    expect(all[1]!.subject).toBe("Test 1");
  });

  it("filters by status", () => {
    const s1 = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test 1",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["b@example.com"],
      subject: "Test 2",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    markSent(s1.id);

    const pending = listScheduledEmails({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0]!.subject).toBe("Test 2");

    const sent = listScheduledEmails({ status: "sent" });
    expect(sent.length).toBe(1);
    expect(sent[0]!.subject).toBe("Test 1");
  });

  it("paginates scheduled emails after applying status filters", () => {
    for (let i = 0; i < 5; i++) {
      createScheduledEmail({
        provider_id: testProviderId,
        from_address: "sender@example.com",
        to_addresses: [`pending-${i}@example.com`],
        subject: `Pending ${i}`,
        scheduled_at: `2030-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const sent = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["sent@example.com"],
      subject: "Sent",
      scheduled_at: "2030-01-01T12:00:00.000Z",
    });
    markSent(sent.id);

    const page = listScheduledEmails({ status: "pending", limit: 2, offset: 1 });

    expect(page).toHaveLength(2);
    expect(page.every((email) => email.status === "pending")).toBe(true);
    expect(page.map((email) => email.subject)).not.toContain("Sent");
  });
});

describe("listScheduledEmailSummaries", () => {
  it("uses a lean projection and omits bodies, attachments, and template vars", () => {
    const db = getDatabase();
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["alice@example.com"],
      subject: "Large scheduled payload",
      html: `<p>${"large html ".repeat(200)}</p>`,
      text_body: "large text ".repeat(200),
      attachments_json: [{ filename: "large.txt", content: "secret attachment".repeat(100) }],
      template_name: "welcome",
      template_vars: { secret: "large template vars".repeat(100) },
      scheduled_at: "2030-01-01T00:00:00.000Z",
    }, db);
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string) => {
            queries.push(sql);
            return target.query(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const [summary] = listScheduledEmailSummaries({ limit: 1 }, recordingDb);

    expect(summary).toBeDefined();
    expect(summary?.subject).toBe("Large scheduled payload");
    expect(summary?.template_name).toBe("welcome");
    expect("html" in summary!).toBe(false);
    expect("text_body" in summary!).toBe(false);
    expect("attachments_json" in summary!).toBe(false);
    expect("template_vars" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("secret attachment");
    expect(JSON.stringify(summary)).not.toContain("large template vars");
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\b(html|text_body|attachments_json|template_vars)\b/);
  });

  it("filters and paginates summary rows", () => {
    for (let i = 0; i < 5; i++) {
      createScheduledEmail({
        provider_id: testProviderId,
        from_address: "sender@example.com",
        to_addresses: [`pending-${i}@example.com`],
        subject: `Summary pending ${i}`,
        scheduled_at: `2030-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const sent = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["sent@example.com"],
      subject: "Summary sent",
      scheduled_at: "2030-01-01T12:00:00.000Z",
    });
    markSent(sent.id);

    const page = listScheduledEmailSummaries({ status: "pending", limit: 2, offset: 1 });

    expect(page).toHaveLength(2);
    expect(page.every((email) => email.status === "pending")).toBe(true);
    expect(page.map((email) => email.subject)).toEqual(["Summary pending 1", "Summary pending 2"]);
  });
});

describe("cancelScheduledEmail", () => {
  it("cancels a pending email", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    const result = cancelScheduledEmail(scheduled.id);
    expect(result).toBe(true);

    const updated = getScheduledEmail(scheduled.id);
    expect(updated!.status).toBe("cancelled");
  });

  it("returns false if already sent", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    markSent(scheduled.id);
    const result = cancelScheduledEmail(scheduled.id);
    expect(result).toBe(false);
  });

  it("returns false if already cancelled", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    cancelScheduledEmail(scheduled.id);
    const result = cancelScheduledEmail(scheduled.id);
    expect(result).toBe(false);
  });
});

describe("getDueEmails", () => {
  it("returns emails past their scheduled time", () => {
    // Past time
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Past",
      scheduled_at: "2000-01-01T00:00:00.000Z",
    });
    // Future time
    createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["b@example.com"],
      subject: "Future",
      scheduled_at: "2099-01-01T00:00:00.000Z",
    });

    const due = getDueEmails();
    expect(due.length).toBe(1);
    expect(due[0]!.subject).toBe("Past");
  });

  it("does not return sent or cancelled emails", () => {
    const s1 = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Sent",
      scheduled_at: "2000-01-01T00:00:00.000Z",
    });
    const s2 = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["b@example.com"],
      subject: "Cancelled",
      scheduled_at: "2000-01-01T00:00:00.000Z",
    });

    markSent(s1.id);
    cancelScheduledEmail(s2.id);

    const due = getDueEmails();
    expect(due.length).toBe(0);
  });

  it("limits due emails after ordering by scheduled time", () => {
    for (let i = 0; i < 5; i++) {
      createScheduledEmail({
        provider_id: testProviderId,
        from_address: "sender@example.com",
        to_addresses: [`due-${i}@example.com`],
        subject: `Due ${i}`,
        scheduled_at: `2000-01-0${i + 1}T00:00:00.000Z`,
      });
    }

    const due = getDueEmails({ limit: 2 });

    expect(due.map((email) => email.subject)).toEqual(["Due 0", "Due 1"]);
  });
});

describe("markSent", () => {
  it("marks email as sent", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    markSent(scheduled.id);
    const updated = getScheduledEmail(scheduled.id);
    expect(updated!.status).toBe("sent");
  });
});

describe("markFailed", () => {
  it("marks email as failed with error message", () => {
    const scheduled = createScheduledEmail({
      provider_id: testProviderId,
      from_address: "sender@example.com",
      to_addresses: ["a@example.com"],
      subject: "Test",
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    markFailed(scheduled.id, "Connection timeout");
    const updated = getScheduledEmail(scheduled.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toBe("Connection timeout");
  });
});
