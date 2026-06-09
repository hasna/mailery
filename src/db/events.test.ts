import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import { createEmail } from "./emails.js";
import {
  createEvent,
  getEvent,
  listEvents,
  listEventSummaries,
  getEventsByEmail,
  upsertEvent,
  upsertEventWithResult,
} from "./events.js";

let providerId: string;
let emailId: string;

const baseOpts = {
  from: "sender@example.com",
  to: ["recipient@example.com"],
  subject: "Test",
};

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
  const e = createEmail(providerId, baseOpts);
  emailId = e.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createEvent", () => {
  it("creates an event", () => {
    const ev = createEvent({
      email_id: emailId,
      provider_id: providerId,
      provider_event_id: "evt-001",
      type: "delivered",
      recipient: "recipient@example.com",
      occurred_at: new Date().toISOString(),
    });
    expect(ev.id).toHaveLength(36);
    expect(ev.type).toBe("delivered");
    expect(ev.email_id).toBe(emailId);
    expect(ev.provider_id).toBe(providerId);
    expect(ev.provider_event_id).toBe("evt-001");
    expect(ev.recipient).toBe("recipient@example.com");
  });

  it("returns newly created events without selecting the row back", () => {
    const db = getDatabase();
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

    const ev = createEvent({
      email_id: emailId,
      provider_id: providerId,
      provider_event_id: "evt-no-reselect",
      type: "delivered",
      recipient: "recipient@example.com",
      metadata: { ok: true },
      occurred_at: "2026-01-01T00:00:00.000Z",
    }, recordingDb);

    expect(ev.provider_event_id).toBe("evt-no-reselect");
    expect(ev.metadata).toEqual({ ok: true });
    expect(runs).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("SELECT * FROM events WHERE id = ?"))).toHaveLength(0);
    expect(listEvents({ provider_id: providerId }, db).map((event) => event.provider_event_id)).toContain("evt-no-reselect");
  });

  it("creates event without email_id (null)", () => {
    const ev = createEvent({
      provider_id: providerId,
      type: "bounced",
      occurred_at: new Date().toISOString(),
    });
    expect(ev.email_id).toBeNull();
  });

  it("stores metadata", () => {
    const ev = createEvent({
      provider_id: providerId,
      type: "clicked",
      occurred_at: new Date().toISOString(),
      metadata: { url: "https://example.com" },
    });
    expect(ev.metadata).toEqual({ url: "https://example.com" });
  });
});

describe("listEvents", () => {
  it("lists all events", () => {
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    expect(listEvents().length).toBe(2);
  });

  it("tolerates malformed metadata JSON", () => {
    const event = createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString(), metadata: { ok: true } });
    getDatabase().run("UPDATE events SET metadata = ? WHERE id = ?", ["not-json", event.id]);

    const [found] = listEvents();
    expect(found?.metadata).toEqual({});
  });

  it("filters by type", () => {
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    expect(listEvents({ type: "delivered" }).length).toBe(1);
  });

  it("filters by multiple types", () => {
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "opened", occurred_at: new Date().toISOString() });
    expect(listEvents({ type: ["delivered", "bounced"] }).length).toBe(2);
  });

  it("filters by email_id", () => {
    createEvent({ email_id: emailId, provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: new Date().toISOString() });
    expect(listEvents({ email_id: emailId }).length).toBe(1);
  });

  it("filters by provider_id", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ provider_id: p2.id, type: "delivered", occurred_at: new Date().toISOString() });
    expect(listEvents({ provider_id: providerId }).length).toBe(1);
  });

  it("filters by since", () => {
    const past = new Date(Date.now() - 10000).toISOString();
    const recent = new Date().toISOString();
    createEvent({ provider_id: providerId, type: "delivered", occurred_at: past });
    createEvent({ provider_id: providerId, type: "bounced", occurred_at: recent });
    const mid = new Date(Date.now() - 5000).toISOString();
    expect(listEvents({ since: mid }).length).toBe(1);
  });

  it("supports limit", () => {
    for (let i = 0; i < 5; i++) {
      createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    }
    expect(listEvents({ limit: 3 }).length).toBe(3);
  });

  it("clamps bad limit and offset values", () => {
    for (let i = 0; i < 5; i++) {
      createEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    }

    expect(listEvents({ limit: 0 }).length).toBe(1);
    expect(listEvents({ limit: -2 }).length).toBe(1);
    expect(listEvents({ limit: Number.NaN }).length).toBe(5);
    expect(listEvents({ limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }).length).toBe(5);
  });
});

describe("listEventSummaries", () => {
  it("uses a lean projection and omits metadata payloads", () => {
    const db = getDatabase();
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
    createEvent({
      provider_id: providerId,
      type: "clicked",
      recipient: "recipient@example.com",
      metadata: { url: "https://example.com/" + "large-metadata-".repeat(200) },
      occurred_at: "2026-01-01T00:00:00.000Z",
    }, db);

    const [summary] = listEventSummaries({ provider_id: providerId }, recordingDb);

    expect(summary).toMatchObject({
      provider_id: providerId,
      type: "clicked",
      recipient: "recipient@example.com",
    });
    expect("metadata" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large-metadata");
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\bmetadata\b/);
  });

  it("paginates summaries", () => {
    for (let i = 1; i <= 4; i++) {
      createEvent({
        provider_id: providerId,
        type: "delivered",
        occurred_at: `2026-01-0${i}T00:00:00.000Z`,
      });
    }

    const page = listEventSummaries({ provider_id: providerId, limit: 2, offset: 1 });
    expect(page.map((event) => event.occurred_at)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
  });
});

describe("getEvent", () => {
  it("returns full event details including metadata", () => {
    const event = createEvent({
      provider_id: providerId,
      type: "clicked",
      metadata: { url: "https://example.com/full" },
      occurred_at: "2026-01-01T00:00:00.000Z",
    });

    expect(getEvent(event.id)).toMatchObject({
      id: event.id,
      metadata: { url: "https://example.com/full" },
    });
    expect(getEvent("missing")).toBeNull();
  });
});

describe("getEventsByEmail", () => {
  it("returns events for a specific email", () => {
    createEvent({ email_id: emailId, provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    createEvent({ email_id: emailId, provider_id: providerId, type: "opened", occurred_at: new Date().toISOString() });
    const events = getEventsByEmail(emailId);
    expect(events.length).toBe(2);
    expect(events.every((e) => e.email_id === emailId)).toBe(true);
  });
});

describe("upsertEvent", () => {
  it("creates new event when provider_event_id is new", () => {
    const ev = upsertEvent({
      provider_id: providerId,
      provider_event_id: "unique-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });
    expect(ev.id).toBeDefined();
  });

  it("returns existing event for duplicate provider_event_id", () => {
    const ev1 = upsertEvent({
      provider_id: providerId,
      provider_event_id: "dup-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });
    const ev2 = upsertEvent({
      provider_id: providerId,
      provider_event_id: "dup-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });
    expect(ev1.id).toBe(ev2.id);
    expect(listEvents().length).toBe(1);
  });

  it("reports whether an upsert created a new event", () => {
    const first = upsertEventWithResult({
      provider_id: providerId,
      provider_event_id: "result-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });
    const second = upsertEventWithResult({
      provider_id: providerId,
      provider_event_id: "result-001",
      type: "delivered",
      occurred_at: new Date().toISOString(),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.event.id).toBe(second.event.id);
  });

  it("inserts new provider events without preselecting or reselecting rows", () => {
    const db = getDatabase();
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

    const result = upsertEventWithResult({
      provider_id: providerId,
      provider_event_id: "insert-fast-path",
      type: "delivered",
      occurred_at: "2026-01-01T00:00:00.000Z",
    }, recordingDb);

    expect(result.created).toBe(true);
    expect(result.event.provider_event_id).toBe("insert-fast-path");
    expect(runs.filter((sql) => sql.includes("INSERT OR IGNORE INTO events"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("provider_event_id = ?"))).toHaveLength(0);
    expect(queries.filter((sql) => sql.includes("SELECT * FROM events WHERE id = ?"))).toHaveLength(0);
  });

  it("creates separate events when no provider_event_id", () => {
    upsertEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    upsertEvent({ provider_id: providerId, type: "delivered", occurred_at: new Date().toISOString() });
    expect(listEvents().length).toBe(2);
  });
});
