import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import {
  saveTriage,
  getTriage,
  getTriageById,
  listTriaged,
  listTriagedSummaries,
  getUntriaged,
  deleteTriage,
  deleteTriageByEmail,
  getTriageStats,
  clearTriage,
} from "./triage.js";
import type { SaveTriageInput } from "./triage.js";

function seedEmail(db: ReturnType<typeof getDatabase>, id: string, subject = "Test email") {
  db.run(
    `INSERT INTO providers (id, name, type, active, created_at, updated_at)
     VALUES ('prov1', 'test', 'sandbox', 1, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO NOTHING`,
  );
  db.run(
    `INSERT INTO emails (id, provider_id, from_address, to_addresses, subject, status, sent_at, created_at, updated_at)
     VALUES (?, 'prov1', 'me@test.com', '["you@test.com"]', ?, 'sent', datetime('now'), datetime('now'), datetime('now'))`,
    [id, subject],
  );
}

function seedInbound(db: ReturnType<typeof getDatabase>, id: string, subject = "Inbound test") {
  db.run(
    `INSERT INTO inbound_emails (id, from_address, to_addresses, subject, received_at, created_at)
     VALUES (?, 'them@test.com', '["me@test.com"]', ?, datetime('now'), datetime('now'))`,
    [id, subject],
  );
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("saveTriage", () => {
  it("saves triage for a sent email", () => {
    const db = getDatabase();
    seedEmail(db, "e1");
    const result = saveTriage({ email_id: "e1", label: "action-required", priority: 1, summary: "Needs response" });
    expect(result.id).toHaveLength(36);
    expect(result.email_id).toBe("e1");
    expect(result.label).toBe("action-required");
    expect(result.priority).toBe(1);
    expect(result.summary).toBe("Needs response");
  });

  it("saves triage for an inbound email", () => {
    const db = getDatabase();
    seedInbound(db, "i1");
    const result = saveTriage({ inbound_email_id: "i1", label: "fyi", priority: 3, sentiment: "neutral" });
    expect(result.inbound_email_id).toBe("i1");
    expect(result.label).toBe("fyi");
    expect(result.sentiment).toBe("neutral");
  });

  it("upserts — replaces existing triage for same email", () => {
    const db = getDatabase();
    seedEmail(db, "e2");
    saveTriage({ email_id: "e2", label: "fyi", priority: 4 });
    const updated = saveTriage({ email_id: "e2", label: "urgent", priority: 1 });
    expect(updated.label).toBe("urgent");
    expect(updated.priority).toBe(1);
    const all = listTriaged();
    expect(all.length).toBe(1);
  });

  it("throws without email_id or inbound_email_id", () => {
    expect(() => saveTriage({ label: "fyi", priority: 3 } as SaveTriageInput)).toThrow(
      "Either email_id or inbound_email_id must be provided",
    );
  });

  it("stores confidence and model", () => {
    const db = getDatabase();
    seedEmail(db, "e3");
    const result = saveTriage({ email_id: "e3", label: "spam", priority: 5, confidence: 0.95, model: "llama-4-scout" });
    expect(result.confidence).toBe(0.95);
    expect(result.model).toBe("llama-4-scout");
  });

  it("stores draft_reply", () => {
    const db = getDatabase();
    seedEmail(db, "e4");
    const result = saveTriage({ email_id: "e4", label: "action-required", priority: 1, draft_reply: "Thanks for your email..." });
    expect(result.draft_reply).toBe("Thanks for your email...");
  });
});

describe("getTriage", () => {
  it("gets triage by sent email id", () => {
    const db = getDatabase();
    seedEmail(db, "e5");
    saveTriage({ email_id: "e5", label: "newsletter", priority: 4 });
    const result = getTriage("e5", "sent");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("newsletter");
  });

  it("gets triage by inbound email id", () => {
    const db = getDatabase();
    seedInbound(db, "i2");
    saveTriage({ inbound_email_id: "i2", label: "urgent", priority: 1 });
    const result = getTriage("i2", "inbound");
    expect(result).not.toBeNull();
    expect(result!.label).toBe("urgent");
  });

  it("returns null for untriaged email", () => {
    expect(getTriage("nonexistent")).toBeNull();
  });
});

describe("getTriageById", () => {
  it("gets triage by its own id", () => {
    const db = getDatabase();
    seedEmail(db, "e6");
    const saved = saveTriage({ email_id: "e6", label: "fyi", priority: 3 });
    const result = getTriageById(saved.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(saved.id);
  });
});

describe("listTriaged", () => {
  it("lists all triaged emails", () => {
    const db = getDatabase();
    seedEmail(db, "e7");
    seedEmail(db, "e8", "Another");
    saveTriage({ email_id: "e7", label: "fyi", priority: 3 });
    saveTriage({ email_id: "e8", label: "urgent", priority: 1 });
    const list = listTriaged();
    expect(list.length).toBe(2);
  });

  it("filters by label", () => {
    const db = getDatabase();
    seedEmail(db, "e9");
    seedEmail(db, "e10", "X");
    saveTriage({ email_id: "e9", label: "fyi", priority: 3 });
    saveTriage({ email_id: "e10", label: "urgent", priority: 1 });
    const list = listTriaged({ label: "urgent" });
    expect(list.length).toBe(1);
    expect(list[0]!.label).toBe("urgent");
  });

  it("filters by priority", () => {
    const db = getDatabase();
    seedEmail(db, "e11");
    seedEmail(db, "e12", "Y");
    saveTriage({ email_id: "e11", label: "fyi", priority: 3 });
    saveTriage({ email_id: "e12", label: "fyi", priority: 5 });
    const list = listTriaged({ priority: 5 });
    expect(list.length).toBe(1);
    expect(list[0]!.priority).toBe(5);
  });

  it("filters by sentiment", () => {
    const db = getDatabase();
    seedEmail(db, "e13");
    seedEmail(db, "e14", "Z");
    saveTriage({ email_id: "e13", label: "fyi", priority: 3, sentiment: "positive" });
    saveTriage({ email_id: "e14", label: "fyi", priority: 3, sentiment: "negative" });
    const list = listTriaged({ sentiment: "positive" });
    expect(list.length).toBe(1);
    expect(list[0]!.sentiment).toBe("positive");
  });

  it("respects limit and offset", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      seedEmail(db, `lim-${i}`, `Email ${i}`);
      saveTriage({ email_id: `lim-${i}`, label: "fyi", priority: 3 });
    }
    const page1 = listTriaged({ limit: 2, offset: 0 });
    expect(page1.length).toBe(2);
    const page2 = listTriaged({ limit: 2, offset: 2 });
    expect(page2.length).toBe(2);
  });

  it("clamps bad limit and offset values", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      seedEmail(db, `clamp-${i}`, `Clamp ${i}`);
      saveTriage({ email_id: `clamp-${i}`, label: "fyi", priority: 3 });
    }

    expect(listTriaged({ limit: 0 }).length).toBe(1);
    expect(listTriaged({ limit: -10 }).length).toBe(1);
    expect(listTriaged({ limit: Number.NaN }).length).toBe(5);
    expect(listTriaged({ limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }).length).toBe(5);
  });

  it("lists summaries without projecting draft replies", () => {
    const db = getDatabase();
    seedEmail(db, "summary-heavy", "Summary heavy");
    saveTriage({
      email_id: "summary-heavy",
      label: "action-required",
      priority: 1,
      summary: "needs review",
      draft_reply: "large draft ".repeat(1000),
    });
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

    const [summary] = listTriagedSummaries({ limit: 1 }, recordingDb);

    expect(summary).toBeDefined();
    expect(summary?.summary).toBe("needs review");
    expect("draft_reply" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("large draft");
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toContain("draft_reply");
  });
});

describe("getUntriaged", () => {
  it("returns sent emails without triage", () => {
    const db = getDatabase();
    seedEmail(db, "u1");
    seedEmail(db, "u2", "Triaged");
    saveTriage({ email_id: "u2", label: "fyi", priority: 3 });
    const untriaged = getUntriaged("sent", 50);
    expect(untriaged.length).toBe(1);
    expect(untriaged[0]!.id).toBe("u1");
  });

  it("returns inbound emails without triage", () => {
    const db = getDatabase();
    seedInbound(db, "ui1");
    seedInbound(db, "ui2", "Triaged inbound");
    saveTriage({ inbound_email_id: "ui2", label: "urgent", priority: 1 });
    const untriaged = getUntriaged("inbound", 50);
    expect(untriaged.length).toBe(1);
    expect(untriaged[0]!.id).toBe("ui1");
  });

  it("clamps bad sent and inbound limits", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      seedEmail(db, `us-${i}`, `Untriaged sent ${i}`);
      seedInbound(db, `ui-clamp-${i}`, `Untriaged inbound ${i}`);
    }

    expect(getUntriaged("sent", 0).length).toBe(1);
    expect(getUntriaged("sent", -10).length).toBe(1);
    expect(getUntriaged("sent", Number.NaN).length).toBe(5);
    expect(getUntriaged("inbound", Number.POSITIVE_INFINITY).length).toBe(5);
  });
});

describe("deleteTriage", () => {
  it("deletes triage by id", () => {
    const db = getDatabase();
    seedEmail(db, "d1");
    const saved = saveTriage({ email_id: "d1", label: "spam", priority: 5 });
    expect(deleteTriage(saved.id)).toBe(true);
    expect(getTriageById(saved.id)).toBeNull();
  });

  it("returns false for nonexistent id", () => {
    expect(deleteTriage("nonexistent")).toBe(false);
  });
});

describe("deleteTriageByEmail", () => {
  it("deletes triage by email id", () => {
    const db = getDatabase();
    seedEmail(db, "de1");
    saveTriage({ email_id: "de1", label: "fyi", priority: 3 });
    expect(deleteTriageByEmail("de1", "sent")).toBe(true);
    expect(getTriage("de1")).toBeNull();
  });

  it("deletes triage by inbound email id", () => {
    const db = getDatabase();
    seedInbound(db, "di1");
    saveTriage({ inbound_email_id: "di1", label: "fyi", priority: 3 });
    expect(deleteTriageByEmail("di1", "inbound")).toBe(true);
    expect(getTriage("di1", "inbound")).toBeNull();
  });
});

describe("getTriageStats", () => {
  it("returns stats with counts and averages", () => {
    const db = getDatabase();
    seedEmail(db, "s1");
    seedEmail(db, "s2", "X");
    seedEmail(db, "s3", "Y");
    saveTriage({ email_id: "s1", label: "urgent", priority: 1, sentiment: "negative", confidence: 0.9 });
    saveTriage({ email_id: "s2", label: "fyi", priority: 3, sentiment: "neutral", confidence: 0.8 });
    saveTriage({ email_id: "s3", label: "fyi", priority: 5, sentiment: "positive", confidence: 0.7 });

    const stats = getTriageStats();
    expect(stats.total).toBe(3);
    expect(stats.by_label["fyi"]).toBe(2);
    expect(stats.by_label["urgent"]).toBe(1);
    expect(stats.by_priority[1]).toBe(1);
    expect(stats.by_priority[3]).toBe(1);
    expect(stats.by_priority[5]).toBe(1);
    expect(stats.by_sentiment["positive"]).toBe(1);
    expect(stats.avg_priority).toBe(3);
    expect(stats.avg_confidence).toBeCloseTo(0.8, 1);
  });

  it("returns zeros for empty table", () => {
    const stats = getTriageStats();
    expect(stats.total).toBe(0);
    expect(stats.avg_priority).toBe(0);
  });
});

describe("clearTriage", () => {
  it("clears all triage results", () => {
    const db = getDatabase();
    seedEmail(db, "c1");
    seedEmail(db, "c2", "X");
    saveTriage({ email_id: "c1", label: "fyi", priority: 3 });
    saveTriage({ email_id: "c2", label: "urgent", priority: 1 });
    const deleted = clearTriage();
    expect(deleted).toBe(2);
    expect(listTriaged().length).toBe(0);
  });
});
