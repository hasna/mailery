import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { storeInboundEmail, setInboundRead, setInboundStarred, setInboundArchived } from "../../db/inbound.js";
import {
  listMailbox, mailboxCounts, getMessageBody, toggleStar, toggleRead, archiveMessage,
  replyDefaults, sendComposed,
} from "./data.js";

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
import { createDomain } from "../../db/domains.js";

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
    const { createAddress } = require("../../db/addresses.js");
    createAddress({ provider_id: providerId, email: "ops@acme.com" }, db);
    const profiles = listProfiles();
    const p = profiles.find((x) => x.id === providerId)!;
    expect(p.provider).toBe("sandbox");
    expect(p.domains).toContain("acme.com");
    expect(p.addresses).toContain("ops@acme.com");
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
