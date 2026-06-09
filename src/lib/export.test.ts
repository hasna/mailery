import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createEmail } from "../db/emails.js";
import { createEvent } from "../db/events.js";
import { createProvider } from "../db/providers.js";
import {
  EXPORT_DEFAULT_LIMIT,
  EXPORT_MAX_LIMIT,
  exportEmailsCsv,
  exportEmailsJson,
  exportEventsCsv,
  exportEventsJson,
} from "./export.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("export schema contracts", () => {
  it("defaults direct email exports to a bounded page", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "one", type: "sandbox" }, db);
    for (let i = 0; i < EXPORT_DEFAULT_LIMIT + 1; i++) {
      createEmail(provider.id, {
        from: "a@example.com",
        to: `user-${i}@example.com`,
        subject: `Default email export ${i}`,
        text: "hello",
      }, `default-email-${i}`, db);
    }

    const json = JSON.parse(exportEmailsJson({ provider_id: provider.id }, db)) as Array<{ id: string }>;
    const csv = exportEmailsCsv({ provider_id: provider.id }, db);

    expect(json).toHaveLength(EXPORT_DEFAULT_LIMIT);
    expect(csv.split("\n")).toHaveLength(EXPORT_DEFAULT_LIMIT + 1);
  });

  it("caps direct email export limits and normalizes bad offsets", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "one", type: "sandbox" }, db);
    for (let i = 0; i < 3; i++) {
      createEmail(provider.id, {
        from: "a@example.com",
        to: `capped-${i}@example.com`,
        subject: `Capped email export ${i}`,
        text: "hello",
      }, `capped-email-${i}`, db);
    }

    const json = JSON.parse(exportEmailsJson({
      provider_id: provider.id,
      limit: EXPORT_MAX_LIMIT + 1,
      offset: -100,
    }, db)) as Array<{ subject: string }>;

    expect(json).toHaveLength(3);
    expect(json[0]?.subject).toBe("Capped email export 2");
  });

  it("keeps email CSV headers stable and honors provider/since filters", () => {
    const db = getDatabase();
    const p1 = createProvider({ name: "one", type: "sandbox" }, db);
    const p2 = createProvider({ name: "two", type: "sandbox" }, db);
    const old = createEmail(p1.id, { from: "a@example.com", to: "old@example.com", subject: "Old", text: "old" }, "old-msg", db);
    const current = createEmail(p1.id, { from: "a@example.com", to: "new@example.com", subject: "New", text: "new" }, "new-msg", db);
    createEmail(p2.id, { from: "b@example.com", to: "other@example.com", subject: "Other", text: "other" }, "other-msg", db);
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", old.id]);
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-02-01T00:00:00.000Z", current.id]);

    const csv = exportEmailsCsv({ provider_id: p1.id, since: "2026-01-15T00:00:00.000Z" }, db);
    expect(csv.split("\n")[0]).toBe("id,from,to,subject,status,sent_at");
    expect(csv).toContain(current.id);
    expect(csv).toContain("new@example.com");
    expect(csv).not.toContain(old.id);
    expect(csv).not.toContain("other@example.com");

    const json = JSON.parse(exportEmailsJson({ provider_id: p1.id, since: "2026-01-15T00:00:00.000Z" }, db)) as Array<{ id: string }>;
    expect(json.map((email) => email.id)).toEqual([current.id]);
  });

  it("paginates email exports and escapes CSV cells", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "one", type: "sandbox" }, db);
    const oldest = createEmail(provider.id, { from: "a@example.com", to: ["old@example.com"], subject: "Old", text: "old" }, "old-msg", db);
    const middle = createEmail(provider.id, { from: "a@example.com", to: ["middle@example.com", "audit@example.com"], subject: "Middle, quoted", text: "middle" }, "mid-msg", db);
    const newest = createEmail(provider.id, { from: "a@example.com", to: ["new@example.com"], subject: "New", text: "new" }, "new-msg", db);
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", oldest.id]);
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-02-01T00:00:00.000Z", middle.id]);
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-03-01T00:00:00.000Z", newest.id]);

    const json = JSON.parse(exportEmailsJson({ provider_id: provider.id, limit: 1, offset: 1 }, db)) as Array<{ id: string }>;
    expect(json.map((email) => email.id)).toEqual([middle.id]);

    const csv = exportEmailsCsv({ provider_id: provider.id, limit: 1, offset: 1 }, db);
    expect(csv).toContain('"[""middle@example.com"",""audit@example.com""]"');
    expect(csv).toContain('"Middle, quoted"');
    expect(csv).not.toContain(newest.id);
  });

  it("filters email exports by canonical sender through display-name From values", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "one", type: "sandbox" }, db);
    const kept = createEmail(provider.id, { from: '"Ops Team" <ops@example.com>', to: ["kept@example.com"], subject: "Kept", text: "kept" }, "kept-msg", db);
    createEmail(provider.id, { from: "other@example.com", to: ["other@example.com"], subject: "Other", text: "other" }, "other-msg", db);

    const json = JSON.parse(exportEmailsJson({ from_address: "ops@example.com" }, db)) as Array<{ id: string }>;
    expect(json.map((email) => email.id)).toEqual([kept.id]);

    const csv = exportEmailsCsv({ from_address: "Ops Team <ops@example.com>" }, db);
    expect(csv).toContain(kept.id);
    expect(csv).not.toContain("Other");
  });

  it("defaults direct event exports to a bounded page", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "one", type: "sandbox" }, db);
    const email = createEmail(provider.id, { from: "a@example.com", to: "user@example.com", subject: "Hello", text: "hello" }, "msg", db);
    for (let i = 0; i < EXPORT_DEFAULT_LIMIT + 1; i++) {
      createEvent({
        email_id: email.id,
        provider_id: provider.id,
        type: "delivered",
        recipient: `user-${i}@example.com`,
        occurred_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }, db);
    }

    const json = JSON.parse(exportEventsJson({ provider_id: provider.id }, db)) as Array<{ id: string }>;
    const csv = exportEventsCsv({ provider_id: provider.id }, db);

    expect(json).toHaveLength(EXPORT_DEFAULT_LIMIT);
    expect(csv.split("\n")).toHaveLength(EXPORT_DEFAULT_LIMIT + 1);
  });

  it("caps direct event export limits and normalizes bad offsets", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "one", type: "sandbox" }, db);
    const email = createEmail(provider.id, { from: "a@example.com", to: "user@example.com", subject: "Hello", text: "hello" }, "msg", db);
    for (let i = 0; i < 3; i++) {
      createEvent({
        email_id: email.id,
        provider_id: provider.id,
        type: "delivered",
        recipient: `capped-${i}@example.com`,
        occurred_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }, db);
    }

    const json = JSON.parse(exportEventsJson({
      provider_id: provider.id,
      limit: EXPORT_MAX_LIMIT + 1,
      offset: -100,
    }, db)) as Array<{ recipient: string }>;

    expect(json).toHaveLength(3);
    expect(json[0]?.recipient).toBe("capped-2@example.com");
  });

  it("keeps event CSV headers stable and honors provider/type/since filters", () => {
    const db = getDatabase();
    const p1 = createProvider({ name: "one", type: "sandbox" }, db);
    const p2 = createProvider({ name: "two", type: "sandbox" }, db);
    const email = createEmail(p1.id, { from: "a@example.com", to: "user@example.com", subject: "Hello", text: "hello" }, "msg", db);
    const kept = createEvent({
      email_id: email.id,
      provider_id: p1.id,
      type: "delivered",
      recipient: "user@example.com",
      occurred_at: "2026-02-01T00:00:00.000Z",
    }, db);
    createEvent({
      email_id: email.id,
      provider_id: p1.id,
      type: "opened",
      recipient: "user@example.com",
      occurred_at: "2026-02-02T00:00:00.000Z",
    }, db);
    createEvent({
      provider_id: p2.id,
      type: "delivered",
      recipient: "other@example.com",
      occurred_at: "2026-02-03T00:00:00.000Z",
    }, db);

    const csv = exportEventsCsv({ provider_id: p1.id, type: "delivered", since: "2026-01-15T00:00:00.000Z" }, db);
    expect(csv.split("\n")[0]).toBe("id,email_id,type,recipient,occurred_at");
    expect(csv).toContain(kept.id);
    expect(csv).toContain("user@example.com");
    expect(csv).not.toContain("opened");
    expect(csv).not.toContain("other@example.com");

    const json = JSON.parse(exportEventsJson({ provider_id: p1.id, type: "delivered", since: "2026-01-15T00:00:00.000Z" }, db)) as Array<{ id: string }>;
    expect(json.map((event) => event.id)).toEqual([kept.id]);
  });

  it("paginates event exports and honors until filters", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "one", type: "sandbox" }, db);
    const email = createEmail(provider.id, { from: "a@example.com", to: "user@example.com", subject: "Hello", text: "hello" }, "msg", db);
    const oldest = createEvent({
      email_id: email.id,
      provider_id: provider.id,
      type: "delivered",
      recipient: "old@example.com",
      occurred_at: "2026-01-01T00:00:00.000Z",
    }, db);
    const middle = createEvent({
      email_id: email.id,
      provider_id: provider.id,
      type: "delivered",
      recipient: "middle@example.com",
      occurred_at: "2026-02-01T00:00:00.000Z",
    }, db);
    const newest = createEvent({
      email_id: email.id,
      provider_id: provider.id,
      type: "delivered",
      recipient: "new@example.com",
      occurred_at: "2026-03-01T00:00:00.000Z",
    }, db);

    const json = JSON.parse(exportEventsJson({
      provider_id: provider.id,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-15T00:00:00.000Z",
      limit: 1,
    }, db)) as Array<{ id: string }>;
    expect(json.map((event) => event.id)).toEqual([middle.id]);

    const csv = exportEventsCsv({ provider_id: provider.id, until: "2026-02-15T00:00:00.000Z", limit: 1, offset: 1 }, db);
    expect(csv).toContain(oldest.id);
    expect(csv).not.toContain(middle.id);
    expect(csv).not.toContain(newest.id);
  });
});
