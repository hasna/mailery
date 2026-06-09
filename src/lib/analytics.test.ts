import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createEmail } from "../db/emails.js";
import { createEvent } from "../db/events.js";
import { getAnalytics, formatAnalytics } from "./analytics.js";

let providerId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

function seedEmail(to: string | string[], sentAt?: string) {
  const toArr = Array.isArray(to) ? to : [to];
  return createEmail(providerId, {
    from: "sender@test.com",
    to: toArr,
    subject: "Test email",
    text: "body",
  });
}

describe("getAnalytics", () => {
  it("returns empty data for no emails", () => {
    const data = getAnalytics(providerId, "30d");
    expect(data.dailyVolume).toEqual([]);
    expect(data.topRecipients).toEqual([]);
    expect(data.busiestHours).toEqual([]);
    expect(data.deliveryTrend).toEqual([]);
  });

  it("counts daily volume correctly", () => {
    seedEmail("a@test.com");
    seedEmail("b@test.com");
    seedEmail("c@test.com");

    const data = getAnalytics(providerId, "30d");
    expect(data.dailyVolume.length).toBe(1);
    expect(data.dailyVolume[0]!.count).toBe(3);
  });

  it("tracks top recipients correctly", () => {
    seedEmail("a@test.com");
    seedEmail("a@test.com");
    seedEmail("a@test.com");
    seedEmail("b@test.com");
    seedEmail("b@test.com");
    seedEmail("c@test.com");

    const data = getAnalytics(providerId, "30d");
    expect(data.topRecipients.length).toBe(3);
    expect(data.topRecipients[0]!.email).toBe("a@test.com");
    expect(data.topRecipients[0]!.count).toBe(3);
    expect(data.topRecipients[1]!.email).toBe("b@test.com");
    expect(data.topRecipients[1]!.count).toBe(2);
    expect(data.topRecipients[2]!.email).toBe("c@test.com");
    expect(data.topRecipients[2]!.count).toBe(1);
  });

  it("handles multiple recipients in one email", () => {
    seedEmail(["a@test.com", "b@test.com"]);

    const data = getAnalytics(providerId, "30d");
    expect(data.topRecipients.length).toBe(2);
    const emails = data.topRecipients.map((r) => r.email).sort();
    expect(emails).toEqual(["a@test.com", "b@test.com"]);
  });

  it("tracks busiest hours", () => {
    seedEmail("a@test.com");
    seedEmail("b@test.com");

    const data = getAnalytics(providerId, "30d");
    expect(data.busiestHours.length).toBeGreaterThan(0);
    // All emails sent at the same hour
    const totalCount = data.busiestHours.reduce((sum, h) => sum + h.count, 0);
    expect(totalCount).toBe(2);
  });

  it("builds delivery trend with events", () => {
    const email1 = seedEmail("a@test.com");
    const email2 = seedEmail("b@test.com");
    const email3 = seedEmail("c@test.com");
    const ts = new Date().toISOString();

    createEvent({ provider_id: providerId, email_id: email1.id, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, email_id: email2.id, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, email_id: email3.id, type: "bounced", occurred_at: ts });

    const data = getAnalytics(providerId, "30d");
    expect(data.deliveryTrend.length).toBe(1);
    expect(data.deliveryTrend[0]!.sent).toBe(3);
    expect(data.deliveryTrend[0]!.delivered).toBe(2);
    expect(data.deliveryTrend[0]!.bounced).toBe(1);
  });

  it("builds delivery trend without duplicate sent/day or event scans", () => {
    const db = getDatabase();
    const email1 = seedEmail("a@test.com");
    const email2 = seedEmail("b@test.com");
    const email3 = seedEmail("c@test.com");
    const ts = new Date().toISOString();

    createEvent({ provider_id: providerId, email_id: email1.id, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, email_id: email2.id, type: "delivered", occurred_at: ts });
    createEvent({ provider_id: providerId, email_id: email3.id, type: "bounced", occurred_at: ts });

    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
      },
    }) as typeof db;

    const data = getAnalytics(providerId, "30d", recordingDb);

    expect(data.deliveryTrend[0]).toMatchObject({ sent: 3, delivered: 2, bounced: 1 });
    expect(queries.filter((sql) => sql.includes("GROUP BY date(sent_at)"))).toHaveLength(1);
    const eventQueries = queries.filter((sql) => sql.includes("FROM events ev"));
    expect(eventQueries).toHaveLength(1);
    expect(eventQueries[0]).toContain("ev.type IN ('delivered', 'bounced')");
  });

  it("filters by provider", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    seedEmail("a@test.com");
    createEmail(p2.id, { from: "other@test.com", to: "x@test.com", subject: "Other", text: "body" });

    const data = getAnalytics(providerId, "30d");
    expect(data.dailyVolume[0]!.count).toBe(1);
    expect(data.topRecipients[0]!.email).toBe("a@test.com");
  });

  it("limits top recipients to 10", () => {
    for (let i = 0; i < 15; i++) {
      seedEmail(`user${i}@test.com`);
    }

    const data = getAnalytics(providerId, "30d");
    expect(data.topRecipients.length).toBe(10);
  });

  it("aggregates top recipients for large histories in SQL", () => {
    const db = getDatabase();
    const timestamp = new Date().toISOString();
    const total = 10025;
    db.run("BEGIN");
    try {
      for (let i = 0; i < total; i++) {
        const recipients = i % 2 === 0 ? ["bulk@test.com", `user${i}@test.com`] : ["bulk@test.com"];
        db.run(
          `INSERT INTO emails
             (id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, sent_at, created_at, updated_at)
           VALUES (?, ?, 'sender@test.com', ?, '[]', '[]', 'Bulk', ?, ?, ?)`,
          [`bulk-${i}`, providerId, JSON.stringify(recipients), timestamp, timestamp, timestamp],
        );
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    const data = getAnalytics(providerId, "30d", db);
    expect(data.topRecipients[0]).toEqual({ email: "bulk@test.com", count: total });
    expect(data.dailyVolume[0]?.count).toBe(total);
  });

  it("ignores malformed and non-array recipient JSON in analytics", () => {
    const db = getDatabase();
    const timestamp = new Date().toISOString();
    for (const [id, toAddresses] of [
      ["valid", JSON.stringify(["valid@test.com"])],
      ["malformed", "not-json"],
      ["object", JSON.stringify({ email: "object@test.com" })],
    ] as const) {
      db.run(
        `INSERT INTO emails
           (id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, sent_at, created_at, updated_at)
         VALUES (?, ?, 'sender@test.com', ?, '[]', '[]', 'JSON', ?, ?, ?)`,
        [id, providerId, toAddresses, timestamp, timestamp, timestamp],
      );
    }

    const data = getAnalytics(providerId, "30d", db);
    expect(data.topRecipients).toEqual([{ email: "valid@test.com", count: 1 }]);
  });

  it("falls back to 30 days for invalid period strings", () => {
    const db = getDatabase();
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    const recent = new Date().toISOString();
    for (const [id, sentAt] of [["old", old], ["recent", recent]] as const) {
      db.run(
        `INSERT INTO emails
           (id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, sent_at, created_at, updated_at)
         VALUES (?, ?, 'sender@test.com', ?, '[]', '[]', 'Period', ?, ?, ?)`,
        [id, providerId, JSON.stringify([`${id}@test.com`]), sentAt, sentAt, sentAt],
      );
    }

    expect(getAnalytics(providerId, "broken", db).dailyVolume[0]?.count).toBe(1);
    expect(getAnalytics(providerId, "-3d", db).dailyVolume[0]?.count).toBe(1);
  });

  it("works without provider filter (all providers)", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    seedEmail("a@test.com");
    createEmail(p2.id, { from: "other@test.com", to: "b@test.com", subject: "Other", text: "body" });

    const data = getAnalytics(undefined, "30d");
    expect(data.dailyVolume[0]!.count).toBe(2);
  });
});

describe("formatAnalytics", () => {
  it("formats empty data without errors", () => {
    const data = {
      dailyVolume: [],
      topRecipients: [],
      busiestHours: [],
      deliveryTrend: [],
    };
    const out = formatAnalytics(data);
    expect(out).toContain("Daily Send Volume");
    expect(out).toContain("Top Recipients");
    expect(out).toContain("Busiest Hours");
    expect(out).toContain("Delivery Trend");
    expect(out).toContain("No data");
  });

  it("formats data with values", () => {
    const data = {
      dailyVolume: [{ date: "2025-01-15", count: 10 }],
      topRecipients: [{ email: "user@test.com", count: 5 }],
      busiestHours: [{ hour: 14, count: 8 }],
      deliveryTrend: [{ date: "2025-01-15", sent: 10, delivered: 9, bounced: 1 }],
    };
    const out = formatAnalytics(data);
    expect(out).toContain("2025-01-15");
    expect(out).toContain("user@test.com");
    expect(out).toContain("5 emails");
    expect(out).toContain("14:00");
    expect(out).toContain("sent:10");
    expect(out).toContain("delivered:9");
    expect(out).toContain("bounced:1");
    expect(out).toContain("90.0%");
  });

  it("shows last 14 days of volume only", () => {
    const days = [];
    for (let i = 0; i < 20; i++) {
      days.push({ date: `2025-01-${String(i + 1).padStart(2, "0")}`, count: i + 1 });
    }
    const data = {
      dailyVolume: days,
      topRecipients: [],
      busiestHours: [],
      deliveryTrend: [],
    };
    const out = formatAnalytics(data);
    // Should contain last 14 days (7-20) but not day 1-6
    expect(out).toContain("2025-01-20");
    expect(out).toContain("2025-01-07");
    expect(out).not.toContain("2025-01-06");
  });

  it("shows last 7 days of delivery trend only", () => {
    const trend = [];
    for (let i = 0; i < 10; i++) {
      trend.push({ date: `2025-01-${String(i + 1).padStart(2, "0")}`, sent: 10, delivered: 9, bounced: 1 });
    }
    const data = {
      dailyVolume: [],
      topRecipients: [],
      busiestHours: [],
      deliveryTrend: trend,
    };
    const out = formatAnalytics(data);
    expect(out).toContain("2025-01-10");
    expect(out).toContain("2025-01-04");
    expect(out).not.toContain("2025-01-03");
  });
});
