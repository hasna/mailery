import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createEmail } from "../db/emails.js";
import { createEvent } from "../db/events.js";
import { createProvider } from "../db/providers.js";
import { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from "./export.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("export schema contracts", () => {
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
});
