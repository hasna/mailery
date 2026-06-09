import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase, uuid, now } from "./database.js";
import { createProvider } from "./providers.js";
import { createAddress, getAddress } from "./addresses.js";
import {
  suspendAddress, activateAddress, setAddressQuota,
  getAddressSendability, countSendsToday, countSendsTodayByAddress,
} from "./address-lifecycle.js";

let providerId: string;
beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "ses", type: "ses" }).id;
});
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

function seedSend(from: string, at: string): void {
  const d = getDatabase();
  d.run(
    `INSERT INTO emails (id, provider_id, from_address, subject, status, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'sent', ?, ?, ?)`,
    [uuid(), providerId, from, "hi", at, at, at],
  );
}

describe("address lifecycle — suspend / activate", () => {
  it("new addresses default to active", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(getAddress(a.id)!.status).toBe("active");
  });

  it("suspends and reactivates an address", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(suspendAddress(a.id).status).toBe("suspended");
    expect(getAddress(a.id)!.status).toBe("suspended");
    expect(activateAddress(a.id).status).toBe("active");
  });

  it("throws on unknown address", () => {
    expect(() => suspendAddress("nope")).toThrow();
  });
});

describe("address lifecycle — quota", () => {
  it("stores and clears a daily quota", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(setAddressQuota(a.id, 50).daily_quota).toBe(50);
    expect(setAddressQuota(a.id, null).daily_quota).toBeNull();
  });

  it("rejects a negative quota", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(() => setAddressQuota(a.id, -1)).toThrow();
  });
});

describe("address lifecycle — sendability", () => {
  it("active, no quota → sendable", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    expect(getAddressSendability("a@x.com").sendable).toBe(true);
  });

  it("unknown address → sendable (no registered restriction)", () => {
    expect(getAddressSendability("ghost@x.com").sendable).toBe(true);
  });

  it("suspended → not sendable", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    suspendAddress(a.id);
    const s = getAddressSendability("a@x.com");
    expect(s.sendable).toBe(false);
    expect(s.reason).toMatch(/suspend/i);
  });

  it("over daily quota → not sendable; under → sendable", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    setAddressQuota(a.id, 2);
    const today = now();
    seedSend("a@x.com", today);
    expect(getAddressSendability("a@x.com").sendable).toBe(true); // 1 < 2
    seedSend("a@x.com", today);
    const s = getAddressSendability("a@x.com");
    expect(s.sendable).toBe(false); // 2 >= 2
    expect(s.reason).toMatch(/quota/i);
  });

  it("counts display-name sent rows toward daily quota", () => {
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    setAddressQuota(a.id, 1);
    seedSend('"A Team" <a@x.com>', now());

    expect(countSendsToday("a@x.com")).toBe(1);
    expect(countSendsToday('"A Team" <a@x.com>')).toBe(1);
    const s = getAddressSendability('"A Team" <a@x.com>');
    expect(s.sendable).toBe(false);
    expect(s.reason).toMatch(/quota/i);
  });

  it("counts today's sends for many addresses with one grouped query", () => {
    seedSend('"A Team" <a@x.com>', now());
    seedSend("b@x.com", now());
    seedSend("b@x.com", now());
    seedSend("c@x.com", "2020-01-01T10:00:00.000Z");

    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      const counts = countSendsTodayByAddress(["a@x.com", "b@x.com", "c@x.com"], db);
      expect(counts.get("a@x.com")).toBe(1);
      expect(counts.get("b@x.com")).toBe(2);
      expect(counts.get("c@x.com")).toBe(0);
    } finally {
      db.query = originalQuery;
    }

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("GROUP BY");
    expect(queries[0]).toContain("sent_at LIKE");
  });

  it("countSendsToday ignores yesterday's sends", () => {
    seedSend("a@x.com", "2020-01-01T10:00:00.000Z");
    expect(countSendsToday("a@x.com")).toBe(0);
  });
});

describe("address lifecycle — case-insensitive enforcement", () => {
  it("a suspended Mixed-Case address blocks a lowercase send", () => {
    const a = createAddress({ provider_id: providerId, email: "Ceo@x.com" });
    suspendAddress(a.id);
    expect(getAddressSendability("ceo@x.com").sendable).toBe(false);
    expect(getAddressSendability("CEO@X.COM").sendable).toBe(false);
  });
});
