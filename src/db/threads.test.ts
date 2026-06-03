import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase, uuid } from "./database.js";
import { createProvider } from "./providers.js";
import { setEmailThreading, getEmailThreading, getEmailByMessageId, getThreadMessages } from "./threads.js";

let providerId: string;
function insertSent(id: string, subject: string) {
  const db = getDatabase();
  db.run(`INSERT INTO emails (id, provider_id, from_address, to_addresses, subject, status, sent_at, created_at, updated_at) VALUES (?, ?, 'a@x.com', '[]', ?, 'sent', datetime('now'), datetime('now'), datetime('now'))`, [id, providerId, subject]);
}
beforeEach(() => { process.env["EMAILS_DB_PATH"] = ":memory:"; resetDatabase(); providerId = createProvider({ name: "ses", type: "ses" }).id; });
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("threads db", () => {
  it("sets and reads threading fields", () => {
    const id = uuid(); insertSent(id, "Hi");
    setEmailThreading(id, { message_id: "<root@x.com>", thread_id: "t1", in_reply_to: null, references: [] });
    const t = getEmailThreading(id)!;
    expect(t.message_id).toBe("<root@x.com>");
    expect(t.thread_id).toBe("t1");
    expect(t.references).toEqual([]);
  });
  it("finds a sent email by message id (bare or bracketed)", () => {
    const id = uuid(); insertSent(id, "Hi");
    setEmailThreading(id, { message_id: "<root@x.com>", thread_id: "t1", references: [] });
    expect(getEmailByMessageId("<root@x.com>")!.id).toBe(id);
    expect(getEmailByMessageId("root@x.com")!.id).toBe(id);
  });
  it("getThreadMessages returns sent ordered by time", () => {
    const a = uuid(), b = uuid(); insertSent(a, "1"); insertSent(b, "2");
    setEmailThreading(a, { thread_id: "t1" }); setEmailThreading(b, { thread_id: "t1" });
    expect(getThreadMessages("t1").length).toBe(2);
  });
});

import { uuid as uuid2 } from "./database.js";
describe("getEmailByMessageId — SES rewrites Message-ID to <provider_id@email.amazonses.com>", () => {
  it("matches the local-part against provider_message_id", () => {
    const { closeDatabase, resetDatabase, getDatabase } = require("./database.js");
    const { createProvider } = require("./providers.js");
    process.env["EMAILS_DB_PATH"] = ":memory:"; resetDatabase();
    const pid = createProvider({ name: "ses", type: "ses" }).id;
    const db = getDatabase();
    const id = uuid2();
    db.run(`INSERT INTO emails (id, provider_id, provider_message_id, from_address, to_addresses, subject, status, sent_at, created_at, updated_at) VALUES (?, ?, '0100abc-xyz-000000', 'a@x.com', '[]', 'S', 'sent', datetime('now'), datetime('now'), datetime('now'))`, [id, pid]);
    setEmailThreading(id, { message_id: "<ours@x.com>", thread_id: "T", references: [] });
    // SES-rewritten id as seen on the received copy
    const r = getEmailByMessageId("<0100abc-xyz-000000@email.amazonses.com>");
    expect(r?.id).toBe(id);
    expect(r?.thread_id).toBe("T");
    closeDatabase(); delete process.env["EMAILS_DB_PATH"];
  });
});
