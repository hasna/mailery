import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { getDatabase, resetDatabase } from "./database.js";
import {
  storeInboundEmail, listInboundEmails, getInboundEmail,
  setInboundRead, setInboundArchived, setInboundStarred,
  addInboundLabel, removeInboundLabel, getUnreadCount,
} from "./inbound.js";

let db: Database;
beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  db = getDatabase();
});
afterEach(() => { delete process.env["EMAILS_DB_PATH"]; });

function seed(subject: string) {
  return storeInboundEmail({
    provider_id: null, message_id: `<${subject}@x.com>`, from_address: "s@x.com",
    to_addresses: ["me@x.com"], cc_addresses: [], subject, text_body: "b", html_body: null,
    attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
  }, db);
}

describe("inbound read-state", () => {
  it("defaults to unread, not archived, not starred", () => {
    const e = seed("a");
    expect(e.is_read).toBe(false);
    expect(e.read_at).toBeNull();
    expect(e.is_archived).toBe(false);
    expect(e.is_starred).toBe(false);
  });

  it("marks read (stamps read_at) and unread (clears it)", () => {
    const e = seed("a");
    const r = setInboundRead(e.id, true);
    expect(r.is_read).toBe(true);
    expect(r.read_at).toBeTruthy();
    expect(setInboundRead(e.id, false).read_at).toBeNull();
  });

  it("throws on unknown id", () => {
    expect(() => setInboundRead("nope", true)).toThrow(/not found/i);
  });
});

describe("inbound archive / star", () => {
  it("archived mail is hidden from the default list but visible with archived:true", () => {
    const a = seed("keep");
    const b = seed("gone");
    setInboundArchived(b.id, true);
    const def = listInboundEmails({}, db).map((e) => e.subject);
    expect(def).toContain("keep");
    expect(def).not.toContain("gone");
    const arch = listInboundEmails({ archived: true }, db).map((e) => e.subject);
    expect(arch).toEqual(["gone"]);
  });

  it("filters by starred", () => {
    const a = seed("plain");
    const b = seed("star");
    setInboundStarred(b.id, true);
    expect(listInboundEmails({ starred: true }, db).map((e) => e.subject)).toEqual(["star"]);
  });
});

describe("inbound labels", () => {
  it("adds and removes labels idempotently and filters by them", () => {
    const e = seed("a");
    addInboundLabel(e.id, "work");
    addInboundLabel(e.id, "work"); // idempotent
    addInboundLabel(e.id, "urgent");
    expect(getInboundEmail(e.id, db)!.label_ids.sort()).toEqual(["urgent", "work"]);
    expect(listInboundEmails({ label: "work" }, db)).toHaveLength(1);
    removeInboundLabel(e.id, "work");
    expect(getInboundEmail(e.id, db)!.label_ids).toEqual(["urgent"]);
    expect(listInboundEmails({ label: "work" }, db)).toHaveLength(0);
  });
});

describe("inbound filters + unread count", () => {
  it("filters unread vs read", () => {
    const a = seed("unread1");
    const b = seed("read1");
    setInboundRead(b.id, true);
    expect(listInboundEmails({ unread: true }, db).map((e) => e.subject)).toEqual(["unread1"]);
    expect(listInboundEmails({ read: true }, db).map((e) => e.subject)).toEqual(["read1"]);
  });

  it("getUnreadCount excludes read and archived", () => {
    seed("u1");
    const r = seed("r1"); setInboundRead(r.id, true);
    const ar = seed("a1"); setInboundArchived(ar.id, true);
    expect(getUnreadCount(undefined, db)).toBe(1);
  });
});
