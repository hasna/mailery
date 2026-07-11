import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { getDatabase, resetDatabase } from "./database.js";
import {
  storeInboundEmail, listInboundEmails, getInboundEmail,
  setInboundRead, setInboundArchived, setInboundStarred,
  setInboundReadSummary, setInboundArchivedSummary, setInboundStarredSummary,
  setInboundReadFlag, setInboundArchivedFlag, setInboundStarredFlag,
  addInboundLabel, removeInboundLabel, addInboundLabelSummary, removeInboundLabelSummary,
  getUnreadCount,
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

  it("uses a narrow existence check before hydrating the updated row", () => {
    const e = seed("wide-read");
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

    const updated = setInboundRead(e.id, true, recordingDb);

    expect(updated.is_read).toBe(true);
    expect(runs).toHaveLength(2);
    expect(queries[0]).toContain("SELECT 1 AS ok");
    expect(queries[0]).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
    expect(queries.filter((sql) => sql.includes("SELECT * FROM inbound_emails WHERE id = ?"))).toHaveLength(1);
  });

  it("updates hot UI flags without selecting full message rows", () => {
    const e = seed("hot-flags");
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

    expect(setInboundReadFlag(e.id, true, recordingDb)).toBe(true);
    expect(setInboundStarredFlag(e.id, true, recordingDb)).toBe(true);
    expect(setInboundArchivedFlag(e.id, true, recordingDb)).toBe(true);

    expect(runs).toHaveLength(6);
    expect(queries).toHaveLength(3);
    expect(queries.every((sql) => sql.includes("SELECT 1 AS ok"))).toBe(true);
    expect(queries.join("\n")).not.toContain("SELECT *");
    expect(queries.join("\n")).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
    expect(getInboundEmail(e.id, db)).toMatchObject({ is_read: true, is_starred: true, is_archived: true });
  });

  it("keeps canonical mailbox state in sync with local read, star, and archive changes", () => {
    const e = seed("canonical-state");

    setInboundRead(e.id, true);
    setInboundStarred(e.id, true);
    setInboundArchived(e.id, true);

    let state = db
      .query("SELECT is_read, is_starred, is_archived, folder_id FROM mailbox_message_state WHERE mail_message_id = ?")
      .get(`msg:inbound:${e.id}`) as { is_read: number; is_starred: number; is_archived: number; folder_id: string };
    expect(state).toEqual({
      is_read: 1,
      is_starred: 1,
      is_archived: 1,
      folder_id: "folder:mbx:me@x.com:archive",
    });

    setInboundRead(e.id, false);
    setInboundArchived(e.id, false);

    state = db
      .query("SELECT is_read, read_at, is_archived, folder_id FROM mailbox_message_state WHERE mail_message_id = ?")
      .get(`msg:inbound:${e.id}`) as { is_read: number; read_at: string | null; is_archived: number; folder_id: string };
    expect(state).toMatchObject({
      is_read: 0,
      read_at: null,
      is_archived: 0,
      folder_id: "folder:mbx:me@x.com:inbox",
    });
  });

  it("returns lean summaries for state mutations without hydrating bodies", () => {
    const e = storeInboundEmail({
      provider_id: null,
      message_id: "<wide-state@x.com>",
      from_address: "s@x.com",
      to_addresses: ["me@x.com"],
      cc_addresses: [],
      subject: "wide-state",
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      attachments: [],
      headers: { "x-large": "header" },
      raw_size: 1,
      received_at: new Date().toISOString(),
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

    const read = setInboundReadSummary(e.id, true, recordingDb);
    const starred = setInboundStarredSummary(e.id, true, recordingDb);
    const archived = setInboundArchivedSummary(e.id, true, recordingDb);

    expect(read.is_read).toBe(true);
    expect(starred.is_starred).toBe(true);
    expect(archived.is_archived).toBe(true);
    expect("text_body" in read).toBe(false);
    expect("html_body" in read).toBe(false);
    expect("headers" in read).toBe(false);
    expect(queries.join("\n")).not.toContain("SELECT *");
    expect(queries.join("\n")).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
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
    expect(JSON.parse((db.query("SELECT labels_json FROM mailbox_message_state WHERE mail_message_id = ?").get(`msg:inbound:${e.id}`) as { labels_json: string }).labels_json).sort()).toEqual(["urgent", "work"]);
    expect(listInboundEmails({ label: "work" }, db)).toHaveLength(1);
    removeInboundLabel(e.id, "work");
    expect(getInboundEmail(e.id, db)!.label_ids).toEqual(["urgent"]);
    expect(JSON.parse((db.query("SELECT labels_json FROM mailbox_message_state WHERE mail_message_id = ?").get(`msg:inbound:${e.id}`) as { labels_json: string }).labels_json)).toEqual(["urgent"]);
    expect(listInboundEmails({ label: "work" }, db)).toHaveLength(0);
  });

  it("keeps canonical spam/trash flags and folders in sync with reserved labels", () => {
    const e = seed("reserved-labels");
    const inboundFlags = () => db
      .query("SELECT is_spam, is_trash, is_archived FROM inbound_emails WHERE id = ?")
      .get(e.id) as { is_spam: number; is_trash: number; is_archived: number };
    setInboundArchived(e.id, true);

    addInboundLabel(e.id, "Spam");
    let state = db
      .query("SELECT labels_json, is_spam, is_trash, is_archived, folder_id FROM mailbox_message_state WHERE mail_message_id = ?")
      .get(`msg:inbound:${e.id}`) as { labels_json: string; is_spam: number; is_trash: number; is_archived: number; folder_id: string };
    expect(inboundFlags()).toEqual({ is_spam: 1, is_trash: 0, is_archived: 1 });
    expect(JSON.parse(state.labels_json)).toEqual(["Spam"]);
    expect(state).toMatchObject({
      is_spam: 1,
      is_trash: 0,
      is_archived: 1,
      folder_id: "folder:mbx:me@x.com:spam",
    });

    addInboundLabel(e.id, "Trash");
    state = db
      .query("SELECT labels_json, is_spam, is_trash, is_archived, folder_id FROM mailbox_message_state WHERE mail_message_id = ?")
      .get(`msg:inbound:${e.id}`) as { labels_json: string; is_spam: number; is_trash: number; is_archived: number; folder_id: string };
    expect(inboundFlags()).toEqual({ is_spam: 1, is_trash: 1, is_archived: 1 });
    expect(JSON.parse(state.labels_json)).toEqual(["Spam", "Trash"]);
    expect(state).toMatchObject({
      is_spam: 1,
      is_trash: 1,
      is_archived: 1,
      folder_id: "folder:mbx:me@x.com:trash",
    });

    removeInboundLabel(e.id, "trash");
    state = db
      .query("SELECT is_spam, is_trash, is_archived, folder_id FROM mailbox_message_state WHERE mail_message_id = ?")
      .get(`msg:inbound:${e.id}`) as { is_spam: number; is_trash: number; is_archived: number; folder_id: string };
    expect(inboundFlags()).toEqual({ is_spam: 1, is_trash: 0, is_archived: 1 });
    expect(state).toMatchObject({
      is_spam: 1,
      is_trash: 0,
      is_archived: 1,
      folder_id: "folder:mbx:me@x.com:spam",
    });

    removeInboundLabel(e.id, "spam");
    state = db
      .query("SELECT labels_json, is_spam, is_trash, is_archived, folder_id FROM mailbox_message_state WHERE mail_message_id = ?")
      .get(`msg:inbound:${e.id}`) as { labels_json: string; is_spam: number; is_trash: number; is_archived: number; folder_id: string };
    expect(inboundFlags()).toEqual({ is_spam: 0, is_trash: 0, is_archived: 1 });
    expect(JSON.parse(state.labels_json)).toEqual([]);
    expect(state).toMatchObject({
      is_spam: 0,
      is_trash: 0,
      is_archived: 1,
      folder_id: "folder:mbx:me@x.com:archive",
    });
  });

  it("mutates labels with a narrow label projection before hydrating", () => {
    const e = seed("labels");
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

    addInboundLabel(e.id, "work", recordingDb);

    expect(queries[0]).toContain("SELECT label_ids_json");
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
    expect(queries.filter((sql) => sql.includes("SELECT * FROM inbound_emails WHERE id = ?"))).toHaveLength(1);
  });

  it("returns lean summaries for label mutations without hydrating bodies", () => {
    const e = storeInboundEmail({
      provider_id: null,
      message_id: "<wide-label@x.com>",
      from_address: "s@x.com",
      to_addresses: ["me@x.com"],
      cc_addresses: [],
      subject: "wide-label",
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      attachments: [],
      headers: { "x-large": "header" },
      raw_size: 1,
      received_at: new Date().toISOString(),
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

    const added = addInboundLabelSummary(e.id, "work", recordingDb);
    const removed = removeInboundLabelSummary(e.id, "work", recordingDb);

    expect(added.label_ids).toEqual(["work"]);
    expect(removed.label_ids).toEqual([]);
    expect("text_body" in added).toBe(false);
    expect("html_body" in added).toBe(false);
    expect("headers" in added).toBe(false);
    expect(queries.join("\n")).not.toContain("SELECT *");
    expect(queries.join("\n")).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
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

  it("getUnreadCount excludes imported SENT rows", () => {
    const providerId = "sandbox-provider";
    db.run("INSERT INTO providers (id, name, type) VALUES (?, 'sandbox', 'sandbox')", [providerId]);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<received@x.com>",
      from_address: "external@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "received",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: new Date().toISOString(),
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<sent@x.com>",
      from_address: "me@example.com",
      to_addresses: ["external@example.com"],
      cc_addresses: [],
      subject: "sent",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      label_ids: ["SENT"],
      raw_size: 1,
      received_at: new Date().toISOString(),
    }, db);

    expect(getUnreadCount(undefined, db)).toBe(1);
    expect(getUnreadCount(providerId, db)).toBe(1);
  });
});
