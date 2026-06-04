import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createDomain } from "../../db/domains.js";
import { createAddress, markVerified } from "../../db/addresses.js";
import { storeInboundEmail, setInboundRead, setInboundStarred, setInboundArchived } from "../../db/inbound.js";
import {
  listMailbox, mailboxCounts, getMessageBody, toggleStar, toggleRead, archiveMessage,
  replyDefaults, sendComposed, listSources, getSettings, setSetting,
  defaultFromAddress,
} from "./data.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let providerId: string;
function seed(subject: string, opts: { read?: boolean; star?: boolean; archived?: boolean; to?: string[] } = {}) {
  const e = storeInboundEmail({
    provider_id: null, message_id: `<${subject}@x>`, from_address: "alice@ext.com",
    to_addresses: opts.to ?? ["me@x.com"], cc_addresses: [], subject, text_body: `body of ${subject}`,
    html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
  });
  if (opts.read) setInboundRead(e.id, true);
  if (opts.star) setInboundStarred(e.id, true);
  if (opts.archived) setInboundArchived(e.id, true);
  return e;
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
});
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("tui data — mailboxes", () => {
  it("routes messages to the right mailbox", () => {
    seed("unread-1");
    seed("read-1", { read: true });
    seed("starred-1", { star: true });
    seed("archived-1", { archived: true });

    expect(listMailbox("inbox").map((m) => m.subject).sort()).toEqual(["read-1", "starred-1", "unread-1"]); // archived hidden
    expect(listMailbox("unread").map((m) => m.subject)).toContain("unread-1");
    expect(listMailbox("unread").map((m) => m.subject)).not.toContain("read-1");
    expect(listMailbox("starred").map((m) => m.subject)).toEqual(["starred-1"]);
    expect(listMailbox("archived").map((m) => m.subject)).toEqual(["archived-1"]);
  });

  it("computes counts", () => {
    seed("a"); seed("b", { read: true }); seed("s", { star: true }); seed("z", { archived: true });
    const c = mailboxCounts();
    expect(c.unread).toBe(2);     // a + s (s is unread+starred)
    expect(c.starred).toBe(1);
    expect(c.archived).toBe(1);
    expect(c.inbox).toBe(3);      // a, b, s (archived excluded)
  });

  it("filters by search", () => {
    seed("invoice report");
    seed("lunch plans");
    expect(listMailbox("inbox", { search: "invoice" }).map((m) => m.subject)).toEqual(["invoice report"]);
  });
});

describe("tui data — body + mutations", () => {
  it("reads a body with flags", () => {
    const e = seed("hello", { star: true });
    const b = getMessageBody({ kind: "inbound", id: e.id } as never)!;
    expect(b.subject).toBe("hello");
    expect(b.text).toContain("body of hello");
    expect(b.flags).toContain("starred");
  });

  it("toggles star and read", () => {
    const e = seed("x");
    const msg = listMailbox("inbox")[0]!;
    expect(toggleStar(msg)).toBe(true);
    expect(toggleRead(msg)).toBe(true);
    archiveMessage(msg, true);
    expect(listMailbox("inbox")).toHaveLength(0);
    expect(listMailbox("archived")).toHaveLength(1);
  });
});

describe("tui data — compose / reply", () => {
  it("derives reply defaults (Re: + swap from/to)", () => {
    const e = seed("Quarterly", { to: ["ops@me.com"] });
    const msg = listMailbox("inbox")[0]!;
    const d = replyDefaults(msg);
    expect(d.subject).toBe("Re: Quarterly");
    expect(d.to).toBe("alice@ext.com");
    expect(d.from).toBe("ops@me.com");
  });

  it("sends a composed message via the active provider", async () => {
    const r = await sendComposed({ from: "me@x.com", to: "you@y.com", subject: "hi", body: "yo" });
    expect(r.messageId).toBeTruthy();
    expect(listMailbox("sent").map((m) => m.subject)).toContain("hi");
  });

  it("rejects an empty recipient", async () => {
    await expect(sendComposed({ from: "me@x.com", to: "  ", subject: "x", body: "y" })).rejects.toThrow(/recipient/i);
  });
});

import { renderMarkdown, listProfiles } from "./data.js";

describe("tui data — attachments + markdown + profiles", () => {
  it("surfaces attachment count + details", () => {
    const db = getDatabase();
    db.run(`INSERT INTO inbound_emails (id, message_id, from_address, to_addresses, cc_addresses, subject, text_body, attachments_json, attachment_paths, headers_json, raw_size, received_at) VALUES ('att1','<a@x>','s@x.com','["me@x.com"]','[]','has files','body','[{"filename":"report.pdf","content_type":"application/pdf","size":2048},{"filename":"pic.png","content_type":"image/png","size":512}]','[{"filename":"report.pdf","s3_url":"s3://b/report.pdf"}]','{}',1,'2026-06-03T10:00:00.000Z')`);
    const m = listMailbox("inbox").find((x) => x.id === "att1")!;
    expect(m.attachments).toBe(2);
    const body = getMessageBody(m)!;
    expect(body.attachments).toHaveLength(2);
    expect(body.attachments[0]!.filename).toBe("report.pdf");
    expect(body.attachments[0]!.location).toBe("s3://b/report.pdf"); // merged from paths
    expect(body.attachments[1]!.location).toBeUndefined();
  });

  it("renders markdown to HTML", () => {
    const html = renderMarkdown("# Hi\n\n- one\n- two\n\n**bold**");
    expect(html).toContain("<h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("sends a markdown message as HTML by default", async () => {
    const r = await sendComposed({ from: "me@x.com", to: "you@y.com", subject: "md", body: "**hello** world" });
    const { getEmailContent } = await import("../../db/email-content.js");
    const content = getEmailContent(r.id, getDatabase());
    expect(content?.html).toContain("<strong>hello</strong>");
    expect(content?.text_body).toBe("**hello** world");
  });

  it("lists profiles with provider type + domains + addresses", () => {
    const db = getDatabase();
    createDomain(providerId, "acme.com", db);
    createAddress({ provider_id: providerId, email: "ops@acme.com" }, db);
    const profiles = listProfiles();
    const p = profiles.find((x) => x.id === providerId)!;
    expect(p.provider).toBe("sandbox");
    expect(p.domains).toContain("acme.com");
    expect(p.addresses).toContain("ops@acme.com");
  });

  it("defaults compose From to the best configured sender for the active source", () => {
    const db = getDatabase();
    const other = createProvider({ name: "other", type: "sandbox", active: true }, db).id;
    createAddress({ provider_id: other, email: "other@example.com" }, db);
    const unverified = createAddress({ provider_id: providerId, email: "fallback@acme.com" }, db);
    const verified = createAddress({ provider_id: providerId, email: "ops@acme.com" }, db);
    markVerified(verified.id, db);

    expect(defaultFromAddress({ source: { providerId } }, db)).toBe("ops@acme.com");
    expect(defaultFromAddress({ source: { domain: "acme.com" } }, db)).toBe("ops@acme.com");
    expect(defaultFromAddress({ source: { domain: "missing.com" }, fallback: "selected@inbox.com" }, db)).toBe("selected@inbox.com");

    // If no verified address is available for the source provider, fall back to
    // its newest active address rather than leaving compose unusable.
    expect(defaultFromAddress({ source: { providerId: other } }, db)).toBe("other@example.com");
    expect(unverified.email).toBe("fallback@acme.com");
  });
});

describe("tui data — Sent folder (Gmail SENT + app-sent)", () => {
  it("routes Gmail SENT-labelled mail to Sent (not inbox) and unions app-sent", async () => {
    const db = getDatabase();
    // a Gmail-synced sent message (labelled SENT)
    storeInboundEmail({
      provider_id: null, message_id: "<sent1@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "gmail sent", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);
    // a received message
    seed("received-1");
    // an app-sent message
    await sendComposed({ from: "me@x.com", to: "z@y.com", subject: "app sent", body: "hi" });

    const sent = listMailbox("sent").map((m) => m.subject);
    expect(sent).toContain("gmail sent");
    expect(sent).toContain("app sent");
    expect(sent).not.toContain("received-1");

    const inbox = listMailbox("inbox").map((m) => m.subject);
    expect(inbox).toContain("received-1");
    expect(inbox).not.toContain("gmail sent");   // SENT excluded from inbox

    const c = mailboxCounts();
    expect(c.sent).toBe(2);   // 1 gmail-sent + 1 app-sent
  });

  it("marks sentByMe + shows the recipient for sent mail", () => {
    const db = getDatabase();
    storeInboundEmail({
      provider_id: null, message_id: "<s2@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "to a client", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);
    const m = listMailbox("sent").find((x) => x.subject === "to a client")!;
    expect(m.sentByMe).toBe(true);
    expect(m.to).toBe("client@y.com");
  });
});

describe("tui data — inbox sources (per-inbox switching)", () => {
  it("lists All + each active provider + each registered domain", () => {
    createDomain(providerId, "elyratelier.com");
    const sources = listSources();
    expect(sources[0]).toMatchObject({ id: "all", label: "All Mail" });
    expect(sources.some((s) => s.providerId === providerId)).toBe(true);
    expect(sources.some((s) => s.domain === "elyratelier.com")).toBe(true);
  });

  it("filters a mailbox by provider", () => {
    const other = createProvider({ name: "other", type: "sandbox", active: true }).id;
    const db = getDatabase();
    storeInboundEmail({ provider_id: providerId, message_id: "<p1@x>", from_address: "a@x.com", to_addresses: ["me@x.com"], cc_addresses: [], subject: "from-provider-1", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() }, db);
    storeInboundEmail({ provider_id: other, message_id: "<p2@x>", from_address: "a@x.com", to_addresses: ["me@x.com"], cc_addresses: [], subject: "from-provider-2", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() }, db);
    const only = listMailbox("inbox", { source: { providerId } }).map((m) => m.subject);
    expect(only).toContain("from-provider-1");
    expect(only).not.toContain("from-provider-2");
  });

  it("filters a mailbox by recipient domain", () => {
    seed("to-elyra", { to: ["el@elyratelier.com"] });
    seed("to-other", { to: ["x@droolbowl.com"] });
    const only = listMailbox("inbox", { source: { domain: "elyratelier.com" } }).map((m) => m.subject);
    expect(only).toEqual(["to-elyra"]);
  });

  it("computes counts for the active source", async () => {
    const other = createProvider({ name: "other", type: "sandbox", active: true }).id;
    const db = getDatabase();
    storeInboundEmail({ provider_id: providerId, message_id: "<c1@x>", from_address: "a@x.com", to_addresses: ["ops@elyratelier.com"], cc_addresses: [], subject: "source-inbox", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() }, db);
    storeInboundEmail({ provider_id: other, message_id: "<c2@x>", from_address: "a@x.com", to_addresses: ["ops@droolbowl.com"], cc_addresses: [], subject: "other-inbox", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() }, db);
    await sendComposed({ from: "sender@elyratelier.com", to: "client@y.com", subject: "source-sent", body: "hi", providerId });
    await sendComposed({ from: "sender@droolbowl.com", to: "client@y.com", subject: "other-sent", body: "hi", providerId: other });

    expect(mailboxCounts({ source: { providerId } }).inbox).toBe(1);
    expect(mailboxCounts({ source: { providerId } }).sent).toBe(1);
    expect(mailboxCounts({ source: { domain: "elyratelier.com" } }).inbox).toBe(1);
    expect(mailboxCounts({ source: { domain: "elyratelier.com" } }).sent).toBe(1);
  });

  it("filters Sent by sender domain for app-sent and Gmail SENT mail", async () => {
    const db = getDatabase();
    await sendComposed({ from: "me@elyratelier.com", to: "client@y.com", subject: "app elyra", body: "hi", providerId });
    await sendComposed({ from: "me@droolbowl.com", to: "client@y.com", subject: "app other", body: "hi", providerId });
    storeInboundEmail({
      provider_id: providerId, message_id: "<gs1@x>", from_address: "me@elyratelier.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "gmail elyra", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);
    storeInboundEmail({
      provider_id: providerId, message_id: "<gs2@x>", from_address: "me@droolbowl.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "gmail other", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);

    const sent = listMailbox("sent", { source: { domain: "elyratelier.com" } }).map((m) => m.subject);
    expect(sent).toContain("app elyra");
    expect(sent).toContain("gmail elyra");
    expect(sent).not.toContain("app other");
    expect(sent).not.toContain("gmail other");
    expect(mailboxCounts({ source: { domain: "elyratelier.com" } }).sent).toBe(2);
  });
});

describe("tui data — settings (persisted to config)", () => {
  let savedHome: string | undefined;
  let tmpHome: string;
  beforeEach(() => { savedHome = process.env["HOME"]; tmpHome = mkdtempSync(join(tmpdir(), "emails-cfg-")); process.env["HOME"] = tmpHome; });
  afterEach(() => { if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome; rmSync(tmpHome, { recursive: true, force: true }); });

  it("defaults to auto-pull on + high contrast (dimRead off)", () => {
    const s = getSettings();
    expect(s.autoPull).toBe(true);
    expect(s.gmailAutoPull).toBe(true);
    expect(s.dimRead).toBe(false);
    expect(s.defaultMailbox).toBe("inbox");
    expect(s.theme).toBe("auto");
  });

  it("round-trips a setting change", () => {
    setSetting("autoPull", false);
    setSetting("dimRead", true);
    setSetting("defaultMailbox", "starred");
    setSetting("theme", "dark");
    const s = getSettings();
    expect(s.autoPull).toBe(false);
    expect(s.dimRead).toBe(true);
    expect(s.defaultMailbox).toBe("starred");
    expect(s.theme).toBe("dark");
  });
});
