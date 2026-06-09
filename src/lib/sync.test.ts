import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createEmail, getEmail } from "../db/emails.js";
import { createEvent, listEvents } from "../db/events.js";
import { createProvider } from "../db/providers.js";
import { getContact } from "../db/contacts.js";
import type { ProviderAdapter, RemoteEvent } from "../providers/interface.js";
import { syncProvider } from "./sync.js";

const pullEvents = mock(async (_since?: string): Promise<RemoteEvent[]> => []);

function fakeAdapter(): ProviderAdapter {
  return {
    listDomains: async () => [],
    getDnsRecords: async () => [],
    verifyDomain: async () => ({ dkim: "pending", spf: "pending", dmarc: "pending" }),
    addDomain: async () => {},
    listAddresses: async () => [],
    addAddress: async () => {},
    verifyAddress: async () => true,
    sendEmail: async () => "",
    pullEvents,
    getStats: async () => ({
      provider_id: "mock",
      period: "30d",
      sent: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      opened: 0,
      clicked: 0,
      delivery_rate: 0,
      bounce_rate: 0,
      open_rate: 0,
    }),
  };
}

function setupDb() {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  const provider = createProvider({ name: "Provider", type: "sandbox" }, db);
  return { db, provider };
}

beforeEach(() => {
  pullEvents.mockReset();
  pullEvents.mockImplementation(async () => []);
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("syncProvider", () => {
  it("batch-resolves remote message ids and updates linked email status without per-event hydration", async () => {
    const { db, provider } = setupDb();
    const delivered = createEmail(provider.id, {
      from: "sender@example.com",
      to: "delivered@example.com",
      subject: "Delivered",
      text: "body",
    }, "msg-delivered", db);
    const deliveredTwo = createEmail(provider.id, {
      from: "sender@example.com",
      to: "delivered-two@example.com",
      subject: "Delivered two",
      text: "body",
    }, "msg-delivered-two", db);
    const bounced = createEmail(provider.id, {
      from: "sender@example.com",
      to: "bounced@example.com",
      subject: "Bounced",
      text: "body",
    }, "msg-bounced", db);
    pullEvents.mockImplementation(async () => [
      {
        provider_event_id: "evt-delivered",
        provider_message_id: "msg-delivered",
        type: "delivered",
        recipient: "delivered@example.com",
        occurred_at: "2026-01-02T00:00:00.000Z",
      },
      {
        provider_event_id: "evt-delivered-two",
        provider_message_id: "msg-delivered-two",
        type: "delivered",
        recipient: "delivered-two@example.com",
        occurred_at: "2026-01-02T00:00:30.000Z",
      },
      {
        provider_event_id: "evt-opened",
        provider_message_id: "msg-delivered",
        type: "opened",
        recipient: "delivered@example.com",
        occurred_at: "2026-01-02T00:01:00.000Z",
      },
      {
        provider_event_id: "evt-bounced",
        provider_message_id: "msg-bounced",
        type: "bounced",
        recipient: "bounced@example.com",
        occurred_at: "2026-01-02T00:02:00.000Z",
      },
    ]);

    const queries: string[] = [];
    const runs: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
        if (prop === "run") return (sql: string, params?: unknown[]) => {
          runs.push(sql);
          return target.run(sql, params as never);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    const inserted = await syncProvider(provider.id, recordingDb, fakeAdapter());

    expect(inserted).toBe(4);
    expect(getEmail(delivered.id, db)?.status).toBe("delivered");
    expect(getEmail(deliveredTwo.id, db)?.status).toBe("delivered");
    expect(getEmail(bounced.id, db)?.status).toBe("bounced");
    expect(queries.filter((sql) => sql.includes("provider_message_id IN"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("provider_message_id = ? AND provider_id = ?"))).toHaveLength(0);
    expect(queries.filter((sql) => sql.includes("SELECT * FROM emails WHERE id = ?"))).toHaveLength(0);
    expect(runs.filter((sql) => sql.includes("UPDATE emails") && sql.includes("WHERE id = ?"))).toHaveLength(0);
    expect(runs.filter((sql) => sql.includes("UPDATE emails") && sql.includes("WHERE id IN"))).toHaveLength(2);
  });

  it("returns only newly inserted events and skips duplicate side effects", async () => {
    const { db, provider } = setupDb();
    const email = createEmail(provider.id, {
      from: "sender@example.com",
      to: "user@example.com",
      subject: "Hello",
      text: "body",
    }, "msg-duplicate", db);
    createEvent({
      email_id: email.id,
      provider_id: provider.id,
      provider_event_id: "evt-duplicate",
      type: "bounced",
      recipient: "user@example.com",
      occurred_at: "2026-01-01T00:00:00.000Z",
    }, db);
    pullEvents.mockImplementation(async () => [
      {
        provider_event_id: "evt-duplicate",
        provider_message_id: "msg-duplicate",
        type: "bounced",
        recipient: "user@example.com",
        occurred_at: "2026-01-01T00:00:00.000Z",
      },
      {
        provider_event_id: "evt-new",
        provider_message_id: "msg-duplicate",
        type: "delivered",
        recipient: "user@example.com",
        occurred_at: "2026-01-02T00:00:00.000Z",
      },
    ]);

    const queries: string[] = [];
    const runs: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
        if (prop === "run") return (sql: string, params?: unknown[]) => {
          runs.push(sql);
          return target.run(sql, params as never);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    const inserted = await syncProvider(provider.id, recordingDb, fakeAdapter());
    const events = listEvents({ provider_id: provider.id }, db);

    expect(inserted).toBe(1);
    expect(events.map((event) => event.provider_event_id).sort()).toEqual(["evt-duplicate", "evt-new"]);
    expect(getEmail(email.id, db)?.status).toBe("delivered");
    expect(getContact("user@example.com", db)?.bounce_count ?? 0).toBe(0);
    expect(queries.filter((sql) => sql.includes("provider_event_id IN"))).toHaveLength(1);
    expect(runs.filter((sql) => sql.includes("INSERT OR IGNORE INTO events"))).toHaveLength(1);
  });

  it("deduplicates repeated provider event ids within the same pulled batch", async () => {
    const { db, provider } = setupDb();
    pullEvents.mockImplementation(async () => [
      {
        provider_event_id: "evt-repeat",
        type: "bounced",
        recipient: "repeat@example.com",
        occurred_at: "2026-01-02T00:00:00.000Z",
      },
      {
        provider_event_id: "evt-repeat",
        type: "bounced",
        recipient: "repeat@example.com",
        occurred_at: "2026-01-02T00:01:00.000Z",
      },
    ]);

    const runs: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "run") return (sql: string, params?: unknown[]) => {
          runs.push(sql);
          return target.run(sql, params as never);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    const inserted = await syncProvider(provider.id, recordingDb, fakeAdapter());
    const events = listEvents({ provider_id: provider.id }, db);
    const contact = getContact("repeat@example.com", db);

    expect(inserted).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.provider_event_id).toBe("evt-repeat");
    expect(contact?.bounce_count).toBe(1);
    expect(runs.filter((sql) => sql.includes("INSERT OR IGNORE INTO events"))).toHaveLength(1);
  });

  it("batch-applies bounce and complaint contact side effects for new events only", async () => {
    const { db, provider } = setupDb();
    pullEvents.mockImplementation(async () => [
      {
        provider_event_id: "evt-bounce-1",
        type: "bounced",
        recipient: "repeat@example.com",
        occurred_at: "2026-01-02T00:00:00.000Z",
      },
      {
        provider_event_id: "evt-bounce-2",
        type: "bounced",
        recipient: "repeat@example.com",
        occurred_at: "2026-01-02T00:01:00.000Z",
      },
      {
        provider_event_id: "evt-bounce-3",
        type: "bounced",
        recipient: "repeat@example.com",
        occurred_at: "2026-01-02T00:02:00.000Z",
      },
      {
        provider_event_id: "evt-complaint-1",
        type: "complained",
        recipient: "repeat@example.com",
        occurred_at: "2026-01-02T00:03:00.000Z",
      },
    ]);

    const inserted = await syncProvider(provider.id, db, fakeAdapter());
    const contact = getContact("repeat@example.com", db);

    expect(inserted).toBe(4);
    expect(contact?.bounce_count).toBe(3);
    expect(contact?.complaint_count).toBe(1);
    expect(contact?.suppressed).toBe(true);
  });

  it("rolls back inserted events when a later sync side effect fails", async () => {
    const { db, provider } = setupDb();
    pullEvents.mockImplementation(async () => [
      {
        provider_event_id: "evt-rollback",
        type: "bounced",
        recipient: "rollback@example.com",
        occurred_at: "2026-01-02T00:00:00.000Z",
      },
    ]);

    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "run") return (sql: string, params?: unknown[]) => {
          if (sql.includes("UPDATE contacts")) {
            throw new Error("forced contact failure");
          }
          return target.run(sql, params as never);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    await expect(syncProvider(provider.id, failingDb, fakeAdapter())).rejects.toThrow("forced contact failure");

    expect(listEvents({ provider_id: provider.id }, db)).toHaveLength(0);
    expect(getContact("rollback@example.com", db)).toBeNull();
  });
});
