import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "../../db/database.js";
import { createProvider, updateProvider } from "../../db/providers.js";
import { createDomain, updateDomain } from "../../db/domains.js";
import { createAddress, markVerified } from "../../db/addresses.js";
import { createEmail } from "../../db/emails.js";
import { setAddressProvisioning, setDomainProvisioning } from "../../db/provisioning.js";
import { getInboundEmail, storeInboundEmail, setInboundRead, setInboundStarred, setInboundArchived } from "../../db/inbound.js";
import { getEmailThreading } from "../../db/threads.js";
import { saveEmailAgentRun } from "../../db/email-agents.js";
import { saveTriage } from "../../db/triage.js";
import {
  listMailbox, mailboxCounts, getMessageBody, toggleStar, toggleRead, archiveMessage,
  replyDefaults, sendComposed, listSources, listInboxAddresses, getSettings, setSetting,
  defaultFromAddress, providerIdForSender, listDomainSummaries, mailboxLabel, addressChoiceByAddress,
  listLabelSummaries, toggleMessageLabel, getConversation, labelDisplayName, isMailCategoryLabel,
  groupMailboxMessages, isImportantMessage, listMailboxSources, listMailboxStatus, searchMailbox,
  providerSourceId,
} from "./data.js";
import { setConfigValue } from "../../lib/config.js";
import { registerS3Source } from "../../lib/s3-sync.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let providerId: string;
const originalHome = process.env["HOME"];
let tmpHome: string | null = null;

function seed(subject: string, opts: { read?: boolean; star?: boolean; archived?: boolean; to?: string[]; labels?: string[] } = {}) {
  const e = storeInboundEmail({
    provider_id: null, message_id: `<${subject}@x>`, from_address: "alice@ext.com",
    to_addresses: opts.to ?? ["me@x.com"], cc_addresses: [], subject, text_body: `body of ${subject}`,
    html_body: null, attachments: [], label_ids: opts.labels ?? [], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
  });
  if (opts.read) setInboundRead(e.id, true);
  if (opts.star) setInboundStarred(e.id, true);
  if (opts.archived) setInboundArchived(e.id, true);
  return e;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "emails-tui-data-"));
  process.env["HOME"] = tmpHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
});
afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

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

  it("keeps sent mail in Sent even when it also has archived state", () => {
    const db = getDatabase();
    const sent = storeInboundEmail({
      provider_id: providerId,
      message_id: "<sent-archived@x>",
      from_address: "me@example.com",
      to_addresses: ["client@example.com"],
      cc_addresses: [],
      subject: "sent archived",
      text_body: "body",
      html_body: null,
      attachments: [],
      label_ids: ["SENT"],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T10:00:00.000Z",
    }, db);
    setInboundArchived(sent.id, true, db);

    expect(listMailbox("sent", undefined, db).map((message) => message.subject)).toContain("sent archived");
    expect(listMailbox("archived", undefined, db).map((message) => message.subject)).not.toContain("sent archived");
    expect(mailboxCounts(db).sent).toBe(1);
    expect(mailboxCounts(db).archived).toBe(0);
  });

  it("computes unscoped counts with indexed scalar probes", () => {
    seed("a");
    seed("b", { read: true });
    seed("s", { star: true });
    seed("z", { archived: true });
    const db = getDatabase();
    createEmail(providerId, { from: "me@x.com", to: "you@y.com", subject: "app-sent", text: "body" }, "app-sent", db);
    storeInboundEmail({
      provider_id: providerId, message_id: "<imported-sent@x>", from_address: "me@x.com", to_addresses: ["you@y.com"],
      cc_addresses: [], subject: "imported sent", text_body: "body", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);

    const calls: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const statement = target.query(sql);
          return new Proxy(statement, {
            get(stmt, statementProp, statementReceiver) {
              if (statementProp !== "get") return Reflect.get(stmt, statementProp, statementReceiver);
              return (...args: unknown[]) => {
                calls.push(sql);
                return statement.get(...args as never[]);
              };
            },
          });
        };
      },
    });

    const c = mailboxCounts(recordingDb as never);

    expect(c).toEqual({ inbox: 3, unread: 2, starred: 1, sent: 2, archived: 1, spam: 0, trash: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("SELECT COUNT(*) FROM inbound_emails WHERE is_sent = 0 AND is_archived = 0 AND is_spam = 0 AND is_trash = 0");
    expect(calls[0]).not.toContain("json_each");
    expect(calls[0]).not.toContain("SUM(CASE");
    const plan = db.query(`EXPLAIN QUERY PLAN ${calls[0]}`).all() as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join(" ");
    expect(details).toContain("idx_inbound_sent_arch_spam_trash_recv");
    expect(details).toContain("idx_inbound_sent_read_arch_spam_trash_recv");
    expect(details).toContain("idx_inbound_sent_star_arch_spam_trash_recv");
    expect(details).toContain("idx_inbound_sent_spam_recv");
    expect(details).toContain("idx_inbound_sent_trash_recv");
    expect(details).not.toContain("SCAN inbound_emails");
  });

  it("computes source counts with one aggregate statement and the recipient index", () => {
    seed("a");
    seed("b", { read: true });
    seed("s", { star: true });
    seed("z", { archived: true });
    seed("other", { to: ["other@x.com"] });
    const db = getDatabase();
    createEmail(providerId, { from: "me@x.com", to: "you@y.com", subject: "app-sent", text: "body" }, "app-sent", db);
    storeInboundEmail({
      provider_id: providerId, message_id: "<imported-sent@x>", from_address: "me@x.com", to_addresses: ["you@y.com"],
      cc_addresses: [], subject: "imported sent", text_body: "body", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);

    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const statement = target.query(sql);
          return new Proxy(statement, {
            get(stmt, statementProp, statementReceiver) {
              if (statementProp !== "get") return Reflect.get(stmt, statementProp, statementReceiver);
              return (...args: unknown[]) => {
                calls.push({ sql, args });
                return statement.get(...args as never[]);
              };
            },
          });
        };
      },
    });

    const c = mailboxCounts({ source: { address: "me@x.com" } }, recordingDb as never);

    expect(c).toEqual({ inbox: 3, unread: 2, starred: 1, sent: 2, archived: 1, spam: 0, trash: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("FROM inbound_recipients");
    expect(calls[0]!.args).toEqual(["me@x.com", "me@x.com", "me@x.com"]);
  });

  it("routes spam and trash labels out of the regular folders", () => {
    seed("plain");
    seed("spammy");
    seed("trashed");
    seed("archived-spam", { archived: true });
    const spam = listMailbox("inbox").find((m) => m.subject === "spammy")!;
    const trash = listMailbox("inbox").find((m) => m.subject === "trashed")!;
    const archivedSpam = listMailbox("archived").find((m) => m.subject === "archived-spam")!;

    toggleMessageLabel(spam, "spam");
    toggleMessageLabel(trash, "trash");
    toggleMessageLabel(archivedSpam, "SPAM");

    expect(listMailbox("inbox").map((m) => m.subject).sort()).toEqual(["plain"]);
    expect(listMailbox("spam").map((m) => m.subject).sort()).toEqual(["archived-spam", "spammy"]);
    expect(listMailbox("archived").map((m) => m.subject)).not.toContain("archived-spam");
    expect(listMailbox("trash").map((m) => m.subject)).toEqual(["trashed"]);
    expect(mailboxCounts()).toMatchObject({ inbox: 1, archived: 0, spam: 2, trash: 1 });
  });

  it("summarizes common and popular labels", () => {
    seed("needs label");
    const msg = listMailbox("inbox")[0]!;

    expect(toggleMessageLabel(msg, "Urgent")).toContain("urgent");
    const summaries = listLabelSummaries();
    expect(summaries.find((label) => label.name === "urgent")).toMatchObject({ count: 1, popular: true });
    expect(summaries.find((label) => label.name === "follow-up")).toMatchObject({ count: 0, popular: false });
    expect(listLabelSummaries({ search: "urg" }).map((label) => label.name)).toEqual(["urgent"]);
    const labelPlan = getDatabase().query("EXPLAIN QUERY PLAN SELECT label, COUNT(*) AS count FROM inbound_labels WHERE TRIM(label) != '' GROUP BY label").all() as Array<{ detail: string }>;
    expect(labelPlan.map((row) => row.detail).join(" ")).not.toContain("inbound_emails");

    const updated = listMailbox("inbox")[0]!;
    expect(toggleMessageLabel(updated, "urgent")).not.toContain("urgent");
  });

  it("filters mailboxes by labels and displays mail categories without the Category prefix", () => {
    const urgent = seed("urgent work");
    seed("category update", { labels: ["CATEGORY_UPDATES"] });
    seed("plain note");

    toggleMessageLabel(listMailbox("inbox").find((item) => item.id === urgent.id)!, "Urgent");

    expect(listMailbox("inbox", { label: "urgent" }).map((m) => m.subject)).toEqual(["urgent work"]);
    expect(listMailbox("inbox", { label: "category-updates" }).map((m) => m.subject)).toEqual(["category update"]);
    expect(listMailbox("inbox", { label: "category_updates" }).map((m) => m.subject)).toEqual(["category update"]);
    expect(labelDisplayName("category_updates")).toBe("Updates");
    expect(isMailCategoryLabel("category-updates")).toBe(true);
    expect(isMailCategoryLabel("urgent")).toBe(false);
  });

  it("filters by search", () => {
    seed("invoice report");
    seed("lunch plans");
    expect(listMailbox("inbox", { search: "invoice" }).map((m) => m.subject)).toEqual(["invoice report"]);
  });

  it("searches inbound message body text before applying the page limit", () => {
    seed("subject-only");
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<body-search@x>",
      from_address: "alice@ext.com",
      to_addresses: ["me@x.com"],
      cc_addresses: [],
      subject: "plain subject",
      text_body: "body-only-token from aws mail",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-05T12:00:00.000Z",
    });

    expect(listMailbox("inbox", { search: "body-only-token" }).map((m) => m.subject)).toEqual(["plain subject"]);
  });

  it("builds conversations from provider thread ids when RFC thread ids are absent", () => {
    const db = getDatabase();
    storeInboundEmail({
      provider_id: providerId, message_id: "<imported-sent-thread@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "imported sent thread", text_body: "sent body", html_body: null, attachments: [],
      label_ids: ["SENT"], provider_thread_id: "imported-thread-1", headers: {}, raw_size: 1, received_at: "2026-01-01T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId, message_id: "<imported-reply-thread@x>", from_address: "client@y.com", to_addresses: ["me@x.com"],
      cc_addresses: [], subject: "imported reply thread", text_body: "reply body", html_body: null, attachments: [],
      provider_thread_id: "imported-thread-1", headers: {}, raw_size: 1, received_at: "2026-01-01T11:00:00.000Z",
    }, db);

    const msg = listMailbox("inbox").find((item) => item.subject === "imported reply thread")!;
    expect(msg.provider_thread_id).toBe("imported-thread-1");
    expect(getConversation(msg).map((item) => `${item.kind}:${item.subject}`)).toEqual([
      "sent:imported sent thread",
      "received:imported reply thread",
    ]);
  });

  it("searches before applying the page limit", () => {
    seed("recent lunch plans");
    seed("older invoice report");
    const db = getDatabase();
    db.run("UPDATE inbound_emails SET received_at = ? WHERE subject = ?", ["2026-01-03T10:00:00.000Z", "recent lunch plans"]);
    db.run("UPDATE inbound_emails SET received_at = ? WHERE subject = ?", ["2026-01-01T10:00:00.000Z", "older invoice report"]);

    expect(listMailbox("inbox", { search: "invoice", limit: 1 }).map((m) => m.subject)).toEqual(["older invoice report"]);
  });

  it("searches recipient addresses before applying the page limit", () => {
    seed("recent recipient", { to: ["recent@example.com"] });
    seed("older recipient", { to: ['"Target" <target@example.com>'] });
    const db = getDatabase();
    db.run("UPDATE inbound_emails SET received_at = ? WHERE subject = ?", ["2026-01-03T10:00:00.000Z", "recent recipient"]);
    db.run("UPDATE inbound_emails SET received_at = ? WHERE subject = ?", ["2026-01-01T10:00:00.000Z", "older recipient"]);

    expect(listMailbox("inbox", { search: "target@example.com", limit: 1 }).map((m) => m.subject)).toEqual(["older recipient"]);
  });

  it("sorts and paginates mailbox results", () => {
    seed("oldest", { to: ["me@x.com"] });
    const db = getDatabase();
    db.run("UPDATE inbound_emails SET received_at = ? WHERE subject = ?", ["2026-01-01T10:00:00.000Z", "oldest"]);
    seed("middle");
    db.run("UPDATE inbound_emails SET received_at = ? WHERE subject = ?", ["2026-01-02T10:00:00.000Z", "middle"]);
    seed("newest");
    db.run("UPDATE inbound_emails SET received_at = ? WHERE subject = ?", ["2026-01-03T10:00:00.000Z", "newest"]);

    expect(listMailbox("inbox", { limit: 2 }).map((m) => m.subject)).toEqual(["newest", "middle"]);
    expect(listMailbox("inbox", { limit: 1, offset: 1 }).map((m) => m.subject)).toEqual(["middle"]);
    expect(listMailbox("inbox", { sort: "oldest" }).map((m) => m.subject)).toEqual(["oldest", "middle", "newest"]);
  });

  it("normalizes bad mailbox and pagination inputs at runtime", () => {
    seed("first");
    seed("second");

    expect(mailboxLabel("bad-folder" as never)).toBe("Inbox");
    expect(listMailbox("bad-folder" as never).map((m) => m.subject).sort()).toEqual(["first", "second"]);
    expect(listMailbox("inbox", { limit: Number.NaN, offset: Number.NaN }).length).toBe(2);
    expect(listMailbox("inbox", { limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }).length).toBe(2);
    expect(listMailbox("inbox", { limit: 0 }).length).toBe(1);
  });

  it("uses bounded SQL pagination for inbox pages", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      query: (sql: string) => ({
        all: (...args: unknown[]) => {
          calls.push({ sql, args });
          return [];
        },
      }),
    };

    listMailbox("inbox", { limit: 5, offset: 20 }, db as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("LIMIT ? OFFSET ?");
    expect(calls[0]!.args.slice(-2)).toEqual([5, 20]);
  });

  it("uses the recipient index instead of JSON scans for address-scoped inbox pages", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      query: (sql: string) => ({
        all: (...args: unknown[]) => {
          calls.push({ sql, args });
          return [];
        },
      }),
    };

    listMailbox("inbox", { source: { address: "ops@example.com" }, limit: 5 }, db as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("inbound_recipients");
    expect(calls[0]!.sql).not.toContain("json_each(to_addresses)");
    expect(calls[0]!.args).toContain("ops@example.com");
  });
});

describe("tui data — body + mutations", () => {
  it("reads a body with flags", () => {
    const e = seed("hello", { star: true });
    const b = getMessageBody({ kind: "inbound", id: e.id } as never)!;
    expect(b.subject).toBe("hello");
    expect(b.text).toContain("body of hello");
    expect(b.summary).toContain("About hello");
    expect(b.flags).toContain("starred");
  });

  it("prefers managed agent summaries over fallback body summaries", () => {
    const e = seed("summary source");
    saveEmailAgentRun({
      agent_key: "categorizer",
      inbound_email_id: e.id,
      provider: "external",
      model: "test",
      status: "ok",
      summary: "Agent summary: this email asks for a contract review.",
    });

    const b = getMessageBody({ kind: "inbound", id: e.id } as never)!;

    expect(b.summary).toBe("Agent summary: this email asks for a contract review.");
  });

  it("uses triage summaries for sent messages", () => {
    const db = getDatabase();
    const sent = createEmail(providerId, {
      from: "me@x.com",
      to: "client@example.com",
      subject: "Sent proposal",
      text: "Attached proposal for review.",
    }, undefined, db);
    saveTriage({
      email_id: sent.id,
      label: "follow-up",
      priority: 2,
      summary: "Sent a proposal to the client and should follow up.",
    }, db);

    const b = getMessageBody({
      kind: "sent",
      id: sent.id,
      from: sent.from_address,
      to: sent.to_addresses.join(", "),
      subject: sent.subject,
      date: sent.sent_at,
      is_read: true,
      is_starred: false,
      labels: [],
      snippet: "",
      thread_id: null,
      provider_thread_id: null,
      attachments: 0,
      sentByMe: true,
    })!;

    expect(b.summary).toBe("Sent a proposal to the client and should follow up.");
  });

  it("reads inbound body with a narrow projection", () => {
    const e = seed("lean body", { star: true });
    const db = getDatabase();
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string) => {
            const statement = target.query(sql);
            return {
              get: (...args: unknown[]) => {
                calls.push({ sql, args });
                return statement.get(...args);
              },
              all: (...args: unknown[]) => {
                calls.push({ sql, args });
                return statement.all(...args);
              },
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const b = getMessageBody({ kind: "inbound", id: e.id } as never, recordingDb as never)!;

    expect(b.subject).toBe("lean body");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("SELECT from_address, to_addresses");
    expect(calls[0]!.sql).toContain("email_agent_runs");
    expect(calls[0]!.sql).not.toContain("SELECT *");
    expect(calls[0]!.sql).not.toContain("headers_json");
    expect(calls[0]!.args).toEqual([e.id]);
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

  it("toggles inbound flags without loading message bodies", () => {
    seed("lean toggles");
    const msg = listMailbox("inbox")[0]!;
    const db = getDatabase();
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
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(toggleStar(msg, recordingDb as never)).toBe(true);
    expect(toggleRead(msg, recordingDb as never)).toBe(true);
    archiveMessage(msg, true, recordingDb as never);

    expect(runs).toHaveLength(6);
    expect(queries).toHaveLength(3);
    expect(queries.every((sql) => sql.includes("SELECT 1 AS ok"))).toBe(true);
    expect(queries.join("\n")).not.toContain("SELECT *");
    expect(queries.join("\n")).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
  });

  it("groups messages by priority and mail categories", () => {
    seed("contract", { labels: ["ai:priority"] });
    seed("promo", { labels: ["category_promotions"] });
    seed("update", { labels: ["transactional"] });
    seed("plain");
    const messages = listMailbox("inbox");
    const important = messages.find((message) => message.subject === "contract")!;

    expect(isImportantMessage(important)).toBe(true);

    const priority = groupMailboxMessages(messages, "priority");
    expect(priority[0]?.title).toBe("Important and Unread");
    expect(priority[0]?.messages.map((message) => message.subject)).toContain("contract");

    const categories = groupMailboxMessages(messages, "category");
    expect(categories.find((group) => group.title === "Promotions")?.messages.map((message) => message.subject)).toContain("promo");
    expect(categories.find((group) => group.title === "Updates")?.messages.map((message) => message.subject)).toContain("update");
    expect(categories.find((group) => group.title === "Primary")?.messages.map((message) => message.subject)).toContain("contract");
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

  it("derives reply defaults for imported sent mail from sentByMe", () => {
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<imported-sent-reply-defaults@example.com>",
      from_address: "me@x.com",
      to_addresses: ["client@y.com"],
      cc_addresses: [],
      subject: "Sent from import",
      text_body: "already sent",
      html_body: null,
      attachments: [],
      label_ids: ["SENT"],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-01T10:00:00.000Z",
    });

    const msg = listMailbox("sent").find((item) => item.subject === "Sent from import")!;
    const d = replyDefaults(msg);

    expect(msg.sentByMe).toBe(true);
    expect(d.subject).toBe("Re: Sent from import");
    expect(d.from).toBe("me@x.com");
    expect(d.to).toBe("client@y.com");
  });

  it("sends a composed message via the active provider", async () => {
    const r = await sendComposed({ from: "me@x.com", to: "you@y.com", subject: "hi", body: "yo" });
    expect(r.messageId).toBeTruthy();
    expect(listMailbox("sent").map((m) => m.subject)).toContain("hi");
  });

  it("sends TUI replies with Message-ID, In-Reply-To, References, and a persisted thread id", async () => {
    const inbound = storeInboundEmail({
      provider_id: null,
      message_id: "s3-key-or-provider-id",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "Needs reply",
      text_body: "please reply",
      html_body: null,
      attachments: [],
      headers: { "Message-ID": "<parent@example.com>", References: "<root@example.com>" },
      raw_size: 1,
      received_at: "2026-01-01T10:00:00.000Z",
    });
    const parent = listMailbox("inbox").find((item) => item.id === inbound.id)!;

    const sent = await sendComposed({
      from: "ops@example.com",
      to: "sender@example.com",
      subject: "Re: Needs reply",
      body: "reply body",
      replyTo: parent,
    });

    const threading = getEmailThreading(sent.id, getDatabase());
    expect(threading?.message_id).toMatch(/^<.+@example\.com>$/);
    expect(threading?.in_reply_to).toBe("<parent@example.com>");
    expect(threading?.references).toEqual(["<root@example.com>", "<parent@example.com>"]);
    expect(threading?.thread_id).toBeTruthy();
    expect(getInboundEmail(inbound.id, getDatabase())?.thread_id).toBe(threading?.thread_id);
  });

  it("rejects an empty recipient", async () => {
    await expect(sendComposed({ from: "me@x.com", to: "  ", subject: "x", body: "y" })).rejects.toThrow(/recipient/i);
  });

  it("rejects missing explicit provider ids before sending", async () => {
    await expect(sendComposed({
      from: "me@x.com",
      to: "you@y.com",
      subject: "bad provider",
      body: "yo",
      providerId: "missing-provider",
    })).rejects.toThrow("Could not resolve ID 'missing-provider' in table 'providers'.");
    expect(listMailbox("sent").map((m) => m.subject)).not.toContain("bad provider");
  });
});

import { renderMarkdown } from "./data.js";

describe("tui data — attachments + markdown + inbox metadata", () => {
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

  it("merges provider and receive status into configured inbox choices without credentials", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "SES (primary)", type: "ses", api_key: "inbox-secret-key", active: true }, db);
    const domain = createDomain(provider.id, "primary.test", db);
    const address = createAddress({ provider_id: provider.id, email: "ops@primary.test" }, db);
    setAddressProvisioning(address.id, { domain_id: domain.id, provisioning_status: "ready", receive_strategy: "ses-s3" }, db);
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string) => {
            queries.push(sql);
            return target.query(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    const choices = listInboxAddresses({ limit: 5 }, recordingDb);
    const choice = choices.find((item) => item.address === "ops@primary.test");

    expect(choice).toMatchObject({
      address: "ops@primary.test",
      domain: "primary.test",
      provider: "SES (primary)",
      providerId: provider.id,
      receiveStatus: "ready",
      configured: true,
    });
    expect(JSON.stringify(choices)).not.toContain("inbox-secret-key");
    expect(queries.filter((sql) => sql.includes("FROM providers")).join("\n")).not.toMatch(/\b(api_key|access_key|secret_key|oauth_client_id|oauth_client_secret|oauth_refresh_token|oauth_access_token|oauth_token_expiry)\b/);
    expect(queries.filter((sql) => sql.includes("provisioning_status"))).toHaveLength(1);
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
    expect(defaultFromAddress({ source: { domain: "missing.com" } }, db)).toBe("ops@acme.com");

    // If no verified address is available for the source provider, fall back to
    // its newest active address rather than leaving compose unusable.
    expect(defaultFromAddress({ source: { providerId: other } }, db)).toBe("other@example.com");
    expect(unverified.email).toBe("fallback@acme.com");
  });
});

describe("tui data — Sent folder (imported SENT + app-sent)", () => {
  it("routes imported SENT-labelled mail to Sent (not inbox) and unions app-sent", async () => {
    const db = getDatabase();
    // an imported sent message (labelled SENT)
    storeInboundEmail({
      provider_id: null, message_id: "<sent1@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "imported sent", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);
    storeInboundEmail({
      provider_id: null, message_id: "<sent-lower@x>", from_address: "me@x.com", to_addresses: ["client2@y.com"],
      cc_addresses: [], subject: "imported lower sent", text_body: "b", html_body: null, attachments: [],
      label_ids: ["sent"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);
    // a received message
    seed("received-1");
    // an app-sent message
    await sendComposed({ from: "me@x.com", to: "z@y.com", subject: "app sent", body: "hi" });

    const sent = listMailbox("sent").map((m) => m.subject);
    expect(sent).toContain("imported sent");
    expect(sent).toContain("imported lower sent");
    expect(sent).toContain("app sent");
    expect(sent).not.toContain("received-1");

    const inbox = listMailbox("inbox").map((m) => m.subject);
    expect(inbox).toContain("received-1");
    expect(inbox).not.toContain("imported sent");   // SENT excluded from inbox
    expect(inbox).not.toContain("imported lower sent");

    const c = mailboxCounts();
    expect(c.sent).toBe(3);   // 2 imported sent + 1 app-sent
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

  it("searches sent mail by recipient address before applying the page limit", async () => {
    await sendComposed({ from: "me@x.com", to: "recent@example.com", subject: "recent sent", body: "hi", providerId });
    await sendComposed({ from: "me@x.com", to: "target@example.com", subject: "older sent", body: "hi", providerId });
    const db = getDatabase();
    db.run("UPDATE emails SET sent_at = ? WHERE subject = ?", ["2026-01-03T10:00:00.000Z", "recent sent"]);
    db.run("UPDATE emails SET sent_at = ? WHERE subject = ?", ["2026-01-01T10:00:00.000Z", "older sent"]);

    expect(listMailbox("sent", { search: "target@example.com", limit: 1 }).map((m) => m.subject)).toEqual(["older sent"]);
  });

  it("paginates merged sent mail after bounding each source branch", () => {
    const db = getDatabase();
    const newest = createEmail(providerId, { from: "me@x.com", to: "client@y.com", subject: "app newest", text: "body" }, "app-newest", db);
    const oldest = createEmail(providerId, { from: "me@x.com", to: "client@y.com", subject: "app oldest", text: "body" }, "app-oldest", db);
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-01-04T10:00:00.000Z", newest.id]);
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-01-01T10:00:00.000Z", oldest.id]);
    storeInboundEmail({
      provider_id: providerId, message_id: "<imported-newer@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "imported newer", text_body: "body", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: "2026-01-03T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId, message_id: "<imported-older@x>", from_address: "me@x.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "imported older", text_body: "body", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: "2026-01-02T10:00:00.000Z",
    }, db);

    expect(listMailbox("sent", { limit: 2, offset: 1 }).map((m) => m.subject)).toEqual(["imported newer", "imported older"]);
    expect(listMailbox("sent", { limit: 2, offset: 1, sort: "oldest" }).map((m) => m.subject)).toEqual(["imported older", "imported newer"]);
  });

  it("uses one bounded SQL page for the combined sent mailbox", () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      query: (sql: string) => ({
        all: (...args: unknown[]) => {
          calls.push({ sql, args });
          return [];
        },
      }),
    };

    listMailbox("sent", { limit: 5, offset: 20 }, db as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("WITH app_sent AS");
    expect(calls[0]!.sql).toContain("synced_sent AS");
    expect(calls[0]!.sql).toContain("UNION ALL");
    expect(calls[0]!.sql).toContain("LIMIT ? OFFSET ?");
    expect(calls[0]!.sql).not.toContain("SELECT *");
    expect(calls[0]!.args).toEqual([25, 25, 5, 20]);
  });
});

describe("tui data — mailbox scopes and ingestion sources", () => {
  it("lists All mailboxes, configured addresses, and observed recipients", () => {
    createAddress({ provider_id: providerId, email: "ops@elyratelier.com" });
    const suspended = createAddress({ provider_id: providerId, email: "paused@elyratelier.com" });
    getDatabase().run("UPDATE addresses SET status = 'suspended' WHERE id = ?", [suspended.id]);
    seed("observed", { to: ['"Signup" <signup@wobblyrobottaco.com>'] });
    storeInboundEmail({
      provider_id: providerId, message_id: "<sent-client@x>", from_address: "me@elyratelier.com", to_addresses: ["client@example.com"],
      cc_addresses: [], subject: "sent client", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    });

    const choices = listInboxAddresses();
    expect(choices[0]).toMatchObject({ id: "all", label: "All mailboxes" });
    expect(choices.some((choice) => choice.address === "ops@elyratelier.com" && choice.configured)).toBe(true);
    expect(choices.some((choice) => choice.address === "paused@elyratelier.com")).toBe(false);
    expect(choices.some((choice) => choice.address === "signup@wobblyrobottaco.com" && choice.observed)).toBe(true);
    expect(choices.some((choice) => choice.address === "client@example.com")).toBe(false);
  });

  it("refreshes observed address choices when new inbound mail changes the snapshot", () => {
    storeInboundEmail({
      provider_id: providerId, message_id: "<first-observed@x>", from_address: "alice@ext.com",
      to_addresses: ["first@example.com"], cc_addresses: [], subject: "first", text_body: "b",
      html_body: null, attachments: [], headers: {}, raw_size: 1,
      received_at: "2026-06-04T11:29:09.000Z",
    });
    expect(listInboxAddresses().some((choice) => choice.address === "first@example.com" && choice.observed)).toBe(true);

    storeInboundEmail({
      provider_id: providerId, message_id: "<second-observed@x>", from_address: "alice@ext.com",
      to_addresses: ["second@example.com"], cc_addresses: [], subject: "second", text_body: "b",
      html_body: null, attachments: [], headers: {}, raw_size: 1,
      received_at: "2026-06-04T11:30:09.000Z",
    });
    const refreshed = listInboxAddresses();
    expect(refreshed.some((choice) => choice.address === "first@example.com" && choice.observed)).toBe(true);
    expect(refreshed.some((choice) => choice.address === "second@example.com" && choice.observed)).toBe(true);
  });

  it("searches bounded inbox address choices outside the initial page", () => {
    const target = createAddress({ provider_id: providerId, email: "target@elyratelier.com" });
    getDatabase().run("UPDATE addresses SET created_at = ? WHERE id = ?", ["2025-01-01T00:00:00.000Z", target.id]);
    for (let i = 0; i < 20; i++) {
      createAddress({ provider_id: providerId, email: `newer-${i}@elyratelier.com` });
    }

    const firstPage = listInboxAddresses({ limit: 5 });
    expect(firstPage).toHaveLength(6); // All inboxes + five concrete choices.
    expect(firstPage.some((choice) => choice.address === "target@elyratelier.com")).toBe(false);

    const searched = listInboxAddresses({ limit: 5, search: "target@" });
    expect(searched.some((choice) => choice.address === "target@elyratelier.com" && choice.configured)).toBe(true);
  });

  it("bounds the default observed inbox address snapshot while keeping search global", () => {
    const db = getDatabase();
    for (let i = 0; i < 205; i++) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: `<observed-${i}@x>`,
        from_address: "alice@ext.com",
        to_addresses: [`observed-${String(i).padStart(3, "0")}@example.com`],
        cc_addresses: [],
        subject: `observed-${i}`,
        text_body: "b",
        html_body: null,
        attachments: [],
        headers: {},
        raw_size: 1,
        received_at: new Date(Date.UTC(2026, 5, 4, 11, 0, i)).toISOString(),
      }, db);
    }
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<observed-target@x>",
      from_address: "alice@ext.com",
      to_addresses: ["zz-target@example.com"],
      cc_addresses: [],
      subject: "observed-target",
      text_body: "b",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-01T00:00:00.000Z",
    }, db);

    const firstPage = listInboxAddresses();
    expect(firstPage).toHaveLength(201); // All inboxes + bounded observed snapshot.
    expect(firstPage.some((choice) => choice.address === "zz-target@example.com")).toBe(false);

    const searched = listInboxAddresses({ limit: 5, search: "zz-target" });
    expect(searched).toContainEqual(expect.objectContaining({
      address: "zz-target@example.com",
      observed: true,
    }));
  });

  it("uses the cached recent observed-address snapshot for non-search limited refreshes", () => {
    const db = getDatabase();
    for (let i = 0; i < 10; i++) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: `<limited-observed-${i}@x>`,
        from_address: "alice@ext.com",
        to_addresses: [`limited-${i}@example.com`],
        cc_addresses: [],
        subject: `limited-${i}`,
        text_body: "b",
        html_body: null,
        attachments: [],
        headers: {},
        raw_size: 1,
        received_at: new Date(Date.UTC(2026, 5, 4, 11, 0, i)).toISOString(),
      }, db);
    }
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const statement = target.query(sql);
          return new Proxy(statement, {
            get(stmt, statementProp, statementReceiver) {
              if (statementProp === "all") {
                return (...args: unknown[]) => {
                  calls.push({ sql, args });
                  return statement.all(...args as never[]);
                };
              }
              if (statementProp === "get") {
                return (...args: unknown[]) => {
                  calls.push({ sql, args });
                  return statement.get(...args as never[]);
                };
              }
              return Reflect.get(stmt, statementProp, statementReceiver);
            },
          });
        };
      },
    }) as typeof db;

    const first = listInboxAddresses({ limit: 5 }, recordingDb);
    const second = listInboxAddresses({ limit: 5 }, recordingDb);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<limited-observed-sent@x>",
      from_address: "me@example.com",
      to_addresses: ["sent-cache@example.com"],
      cc_addresses: [],
      subject: "sent cache noise",
      text_body: "b",
      html_body: null,
      attachments: [],
      label_ids: ["SENT"],
      headers: {},
      raw_size: 1,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    const third = listInboxAddresses({ limit: 5 }, recordingDb);

    expect(first).toHaveLength(6);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(third.some((choice) => choice.address === "sent-cache@example.com")).toBe(false);
    const recentQueries = calls.filter((call) => call.sql.includes("WITH recent AS"));
    expect(recentQueries).toHaveLength(1);
    expect(recentQueries[0]!.args).toEqual([50, 5]);
    expect(calls.some((call) => call.sql.includes("SELECT DISTINCT r.address"))).toBe(false);
  });

  it("expands the observed-address scan only when recent mail has too few unique recipients", () => {
    const db = getDatabase();
    for (let i = 0; i < 60; i++) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: `<busy-recipient-${i}@x>`,
        from_address: "alice@ext.com",
        to_addresses: ["busy@example.com"],
        cc_addresses: [],
        subject: `busy-${i}`,
        text_body: "b",
        html_body: null,
        attachments: [],
        headers: {},
        raw_size: 1,
        received_at: new Date(Date.UTC(2026, 5, 4, 12, 0, i)).toISOString(),
      }, db);
    }
    for (let i = 0; i < 4; i++) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: `<older-unique-${i}@x>`,
        from_address: "alice@ext.com",
        to_addresses: [`older-${i}@example.com`],
        cc_addresses: [],
        subject: `older-${i}`,
        text_body: "b",
        html_body: null,
        attachments: [],
        headers: {},
        raw_size: 1,
        received_at: new Date(Date.UTC(2026, 5, 4, 11, 0, i)).toISOString(),
      }, db);
    }
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const statement = target.query(sql);
          return new Proxy(statement, {
            get(stmt, statementProp, statementReceiver) {
              if (statementProp === "all") {
                return (...args: unknown[]) => {
                  calls.push({ sql, args });
                  return statement.all(...args as never[]);
                };
              }
              if (statementProp === "get") {
                return (...args: unknown[]) => {
                  calls.push({ sql, args });
                  return statement.get(...args as never[]);
                };
              }
              return Reflect.get(stmt, statementProp, statementReceiver);
            },
          });
        };
      },
    }) as typeof db;

    const choices = listInboxAddresses({ limit: 5 }, recordingDb);

    expect(choices.map((choice) => choice.address).filter(Boolean)).toEqual([
      "busy@example.com",
      "older-0@example.com",
      "older-1@example.com",
      "older-2@example.com",
      "older-3@example.com",
    ]);
    const recentQueries = calls.filter((call) => call.sql.includes("WITH recent AS"));
    expect(recentQueries.map((query) => query.args)).toEqual([[50, 5], [100, 5]]);
  });

  it("resolves one address choice without building the full chooser", () => {
    const db = getDatabase();
    const address = createAddress({ provider_id: providerId, email: "target-choice@example.com" });
    markVerified(address.id);
    for (let i = 0; i < 20; i++) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: `<choice-noise-${i}@x>`,
        from_address: "alice@ext.com",
        to_addresses: [`noise-${i}@example.com`],
        cc_addresses: [],
        subject: `choice-noise-${i}`,
        text_body: "b",
        html_body: null,
        attachments: [],
        headers: {},
        raw_size: 1,
        received_at: new Date(Date.UTC(2026, 5, 4, 11, 0, i)).toISOString(),
      }, db);
    }
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<target-choice-observed@x>",
      from_address: "alice@ext.com",
      to_addresses: ["target-choice@example.com"],
      cc_addresses: [],
      subject: "target choice",
      text_body: "b",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    const calls: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          calls.push(sql);
          return target.query(sql);
        };
      },
    }) as typeof db;

    const choice = addressChoiceByAddress("target-choice@example.com", recordingDb);

    expect(choice).toMatchObject({
      address: "target-choice@example.com",
      configured: true,
      observed: true,
    });
    expect(calls.some((sql) => sql.includes("WITH recent AS"))).toBe(false);
    expect(calls.some((sql) => sql.includes("ORDER BY created_at DESC, email ASC LIMIT"))).toBe(false);
    expect(calls.some((sql) => sql.includes("WHERE email = ? COLLATE NOCASE"))).toBe(true);
    expect(calls.some((sql) => sql.includes("FROM inbound_recipients"))).toBe(true);
  });

  it("lists ingestion sources without treating domains as providers-as-inboxes", () => {
    createDomain(providerId, "elyratelier.com");
    const inactive = createProvider({ name: "inactive", type: "sandbox", api_key: "inactive-secret" }).id;
    updateProvider(inactive, { active: false });
    const db = getDatabase();
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
      },
    }) as typeof db;

    const sources = listSources(recordingDb);

    expect(sources[0]).toMatchObject({ id: "all", label: "All sources" });
    expect(sources.some((s) => s.providerId === providerId)).toBe(true);
    expect(sources.some((s) => s.providerId === inactive)).toBe(false);
    expect(sources.some((s) => s.domain === "elyratelier.com")).toBe(false);
    expect(queries.filter((sql) => sql.includes("FROM providers")).join("\n"))
      .not.toMatch(/\b(api_key|access_key|secret_key|oauth_client_id|oauth_client_secret|oauth_refresh_token|oauth_access_token|oauth_token_expiry)\b/);
  });

  it("badges legacy and orphaned ingestion sources while keeping their mail visible", () => {
    const db = getDatabase();
    const legacy = storeInboundEmail({
      provider_id: null,
      message_id: "<legacy-source@example.com>",
      from_address: "legacy@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "legacy visible",
      text_body: "legacy",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-01T10:00:00.000Z",
    }, db);
    db.run("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO inbound_emails
        (id, provider_id, message_id, from_address, to_addresses, cc_addresses, subject, text_body, html_body, attachments_json, attachment_paths, headers_json, raw_size, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "orphaned-source-mail",
        "missing-provider-id",
        "<orphaned-source@example.com>",
        "orphaned@example.com",
        JSON.stringify(["ops@example.com"]),
        "[]",
        "orphaned visible",
        "orphaned",
        null,
        "[]",
        "[]",
        "{}",
        1,
        "2026-01-02T10:00:00.000Z",
        "2026-01-02T10:00:00.000Z",
      ],
    );
    db.run("PRAGMA foreign_keys = ON");

    const sources = listMailboxSources(undefined, db);
    const legacySource = sources.find((source) => source.id === "legacy");
    const orphanedSource = sources.find((source) => source.id === "orphaned:missing-provider-id");

    expect(legacySource).toMatchObject({ kind: "legacy", badges: ["legacy"], total: 1 });
    expect(orphanedSource).toMatchObject({ kind: "orphaned", badges: ["orphaned"], total: 1 });
    expect(listMailbox("inbox", undefined, db).map((message) => message.subject)).toEqual(["orphaned visible", "legacy visible"]);
    expect(listMailbox("inbox", { source: { sourceId: "legacy" } }, db).map((message) => message.id)).toEqual([legacy.id]);
    expect(listMailbox("inbox", { source: { sourceId: "orphaned:missing-provider-id" } }, db).map((message) => message.subject)).toEqual(["orphaned visible"]);
  });

  it("backfills provider-tagged S3 rows only when a configured bucket maps the provider", () => {
    const db = getDatabase();
    const otherProvider = createProvider({ name: "other-ses", type: "ses", active: true }).id;
    setConfigValue("inbound_s3_buckets", [{ bucket: "legacy-s3-bucket", region: "us-east-1", providerId }]);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "inbound/example.com/old-object",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "old s3 row",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: otherProvider,
      message_id: "inbound/example.com/other-object",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "unmapped s3 row",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T11:00:00.000Z",
    }, db);

    const sourceId = `s3:${encodeURIComponent("legacy-s3-bucket")}`;
    const s3Source = listMailboxSources({ search: "legacy-s3-bucket" }, db).find((source) => source.id === sourceId);

    expect(s3Source).toMatchObject({ kind: "s3", providerId, total: 1 });
    expect(listMailbox("inbox", { source: { sourceId } }, db).map((message) => message.subject)).toEqual(["old s3 row"]);
    expect(listMailbox("inbox", { source: { sourceId: providerSourceId(providerId) } }, db).map((message) => message.subject)).toEqual(["old s3 row"]);
    expect(listMailbox("inbox", { source: { sourceId: providerSourceId(otherProvider) } }, db).map((message) => message.subject)).toEqual(["unmapped s3 row"]);
  });

  it("lists registered S3 lifecycle sources without requiring legacy bucket config", () => {
    const db = getDatabase();
    const source = registerS3Source({
      id: "s3-registered-source",
      bucket: "registered-s3-bucket",
      prefix: "inbound/",
      region: "eu-west-1",
      providerId,
      status: "live",
      liveSyncEnabled: true,
    });
    storeInboundEmail({
      provider_id: providerId,
      message_id: "s3://registered-s3-bucket/inbound/example.com/msg001",
      raw_s3_url: "s3://registered-s3-bucket/inbound/example.com/msg001",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "registered s3 row",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T12:00:00.000Z",
    }, db);

    const listed = listMailboxSources({ search: "registered-s3-bucket" }, db);
    const summary = listed.find((item) => item.id === source.id);

    expect(summary).toMatchObject({
      kind: "s3",
      providerId,
      bucket: "registered-s3-bucket",
      s3Prefix: "inbound/",
      badges: expect.arrayContaining(["live"]),
      total: 1,
    });
	  expect(listMailbox("inbox", { source: { sourceId: source.id } }, db).map((message) => message.subject)).toEqual(["registered s3 row"]);
	});

  it("keeps registered S3 source filters scoped to their exact prefix", () => {
    const db = getDatabase();
    const sourceA = registerS3Source({
      id: "s3-shared-prefix-a",
      bucket: "shared-prefix-bucket",
      prefix: "inbound/a/",
      region: "us-east-1",
      providerId,
      status: "live",
      liveSyncEnabled: true,
    });
    const sourceB = registerS3Source({
      id: "s3-shared-prefix-b",
      bucket: "shared-prefix-bucket",
      prefix: "inbound/b/",
      region: "us-east-1",
      providerId,
      status: "live",
      liveSyncEnabled: true,
    });
    storeInboundEmail({
      provider_id: providerId,
      message_id: "s3://shared-prefix-bucket/inbound/a/msg001",
      raw_s3_url: "s3://shared-prefix-bucket/inbound/a/msg001",
      from_address: "sender-a@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "source a row",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T12:01:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "s3://shared-prefix-bucket/inbound/b/msg001",
      raw_s3_url: "s3://shared-prefix-bucket/inbound/b/msg001",
      from_address: "sender-b@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "source b row",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T12:02:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<plain-provider-row@example.com>",
      raw_s3_url: null,
      from_address: "plain@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "plain provider row",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T12:03:00.000Z",
    }, db);

    const listed = listMailboxSources({ search: "shared-prefix-bucket" }, db).filter((item) => item.kind === "s3");

    expect(listed).toHaveLength(2);
    expect(listed.find((item) => item.id === sourceA.id)).toMatchObject({ s3Prefix: "inbound/a/", total: 1, unread: 1 });
    expect(listed.find((item) => item.id === sourceB.id)).toMatchObject({ s3Prefix: "inbound/b/", total: 1, unread: 1 });
    expect(listMailbox("inbox", { source: { sourceId: sourceA.id } }, db).map((message) => message.subject)).toEqual(["source a row"]);
    expect(listMailbox("inbox", { source: { sourceId: sourceB.id } }, db).map((message) => message.subject)).toEqual(["source b row"]);
    expect(listMailboxStatus({ source: { sourceId: sourceA.id } }, db).counts.inbox).toBe(1);
    expect(searchMailbox("source", { mailbox: "inbox", source: { sourceId: sourceB.id } }, db).map((message) => message.subject)).toEqual(["source b row"]);
  });

  it("prefers exact registered S3 sources over generic bucket-only source rows", () => {
    const db = getDatabase();
    setConfigValue("inbound_s3_buckets", [{ bucket: "dedupe-s3-bucket", region: "us-east-1", providerId }]);
    const source = registerS3Source({
      id: "s3-dedupe-source",
      bucket: "dedupe-s3-bucket",
      prefix: "inbound/example.com/",
      region: "us-east-1",
      providerId,
      status: "live",
      liveSyncEnabled: true,
    });

    const listed = listMailboxSources({ search: "dedupe-s3-bucket" }, db).filter((item) => item.kind === "s3");

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: source.id, bucket: "dedupe-s3-bucket" });
  });

  it("treats unknown lifecycle source IDs as an empty source filter", () => {
    const db = getDatabase();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "<known-source@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "known source row",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T13:00:00.000Z",
    }, db);

    const source = { sourceId: "missing-source-id" };

    expect(listMailbox("inbox", { source }, db)).toEqual([]);
    expect(searchMailbox("known", { mailbox: "inbox", source }, db)).toEqual([]);
    expect(listMailboxStatus({ source }, db).counts.inbox).toBe(0);
  });

  it("uses the same source-aware folder status for TUI lists and search", () => {
    const other = createProvider({ name: "other", type: "sandbox", active: true }).id;
    const db = getDatabase();
    storeInboundEmail({ provider_id: providerId, message_id: "<status-source@x>", from_address: "a@x.com", to_addresses: ["ops@elyratelier.com"], cc_addresses: [], subject: "status needle", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-01-02T10:00:00.000Z" }, db);
    storeInboundEmail({ provider_id: other, message_id: "<status-other@x>", from_address: "a@x.com", to_addresses: ["ops@elyratelier.com"], cc_addresses: [], subject: "status other", text_body: "needle", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-01-03T10:00:00.000Z" }, db);
    const source = { sourceId: providerSourceId(providerId) };

    const status = listMailboxStatus({ source }, db);
    const listed = listMailbox("inbox", { source }, db);
    const searched = searchMailbox("needle", { mailbox: "inbox", source }, db);

    expect(status.counts.inbox).toBe(1);
    expect(status.folders.find((folder) => folder.id === "inbox")?.count).toBe(1);
    expect(listed.map((message) => message.subject)).toEqual(["status needle"]);
    expect(searched.map((message) => message.subject)).toEqual(["status needle"]);
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

  it("filters received and sent mail by exact email address", async () => {
    seed("to-ops", { to: ['"Ops Team" <ops@elyratelier.com>'] });
    seed("to-team", { to: ["team@elyratelier.com"] });
    await sendComposed({ from: "ops@elyratelier.com", to: "client@y.com", subject: "sent ops", body: "hi", providerId });
    await sendComposed({ from: "team@elyratelier.com", to: "client@y.com", subject: "sent team", body: "hi", providerId });
    storeInboundEmail({
      provider_id: providerId, message_id: "<imported-ops@x>", from_address: "ops@elyratelier.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "imported sent ops", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    });

    const inbox = listMailbox("inbox", { source: { address: "ops@elyratelier.com" } }).map((m) => m.subject);
    expect(inbox).toEqual(["to-ops"]);
    const sent = listMailbox("sent", { source: { address: "ops@elyratelier.com" } }).map((m) => m.subject);
    expect(sent).toContain("sent ops");
    expect(sent).toContain("imported sent ops");
    expect(sent).not.toContain("sent team");
    expect(mailboxCounts({ source: { address: "ops@elyratelier.com" } }).inbox).toBe(1);
    expect(mailboxCounts({ source: { address: "ops@elyratelier.com" } }).sent).toBe(2);
  });

  it("filters Sent by exact sender address through display-name From values", () => {
    const db = getDatabase();
    createEmail(providerId, {
      from: '"Ops Team" <ops@elyratelier.com>',
      to: ["client@y.com"],
      subject: "display app sent",
    }, "display-app-sent", db);
    createEmail(providerId, {
      from: "team@elyratelier.com",
      to: ["client@y.com"],
      subject: "team app sent",
    }, "team-app-sent", db);
    storeInboundEmail({
      provider_id: providerId, message_id: "<display-imported-sent@x>", from_address: '"Ops Team" <ops@elyratelier.com>',
      to_addresses: ["client@y.com"], cc_addresses: [], subject: "display imported sent", text_body: "b",
      html_body: null, attachments: [], label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);

    const sent = listMailbox("sent", { source: { address: "ops@elyratelier.com" } }).map((m) => m.subject);

    expect(sent).toContain("display app sent");
    expect(sent).toContain("display imported sent");
    expect(sent).not.toContain("team app sent");
    expect(mailboxCounts({ source: { address: "ops@elyratelier.com" } }).sent).toBe(2);
  });

  it("resolves sender provider by configured From address", () => {
    const other = createProvider({ name: "other", type: "sandbox", active: true }).id;
    createAddress({ provider_id: other, email: "ops@elyratelier.com" });
    const address = createAddress({ provider_id: providerId, email: "ops@elyratelier.com" });
    markVerified(address.id);
    expect(providerIdForSender("ops@elyratelier.com")).toBe(providerId);
    expect(providerIdForSender("missing@elyratelier.com")).toBeNull();
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

  it("summarizes domains with address and email counts", async () => {
    const domain = createDomain(providerId, "elyratelier.com");
    const address = createAddress({ provider_id: providerId, email: "ops@elyratelier.com" });
    const suspended = createAddress({ provider_id: providerId, email: "paused@elyratelier.com" });
    markVerified(address.id);
    getDatabase().run("UPDATE addresses SET status = 'suspended' WHERE id = ?", [suspended.id]);
    setAddressProvisioning(address.id, { domain_id: domain.id, provisioning_status: "ready" });
    seed("source-inbox", { to: ["ops@elyratelier.com"] });
    await sendComposed({ from: "ops@elyratelier.com", to: "client@y.com", subject: "source-sent", body: "hi", providerId });

    const summary = listDomainSummaries().find((item) => item.domain === "elyratelier.com");

    expect(summary).toMatchObject({
      provider: "sandbox",
      addresses: 1,
      inbox: 1,
      unread: 1,
      sent: 1,
      total: 2,
      readiness: "ready_to_receive",
    });
  });

  it("paginates domain summaries before loading readiness and mail counts", () => {
    const older = createDomain(providerId, "older-page.test");
    const middle = createDomain(providerId, "middle-page.test");
    const newer = createDomain(providerId, "newer-page.test");
    const db = getDatabase();
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", older.id]);
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-02T00:00:00.000Z", middle.id]);
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-03T00:00:00.000Z", newer.id]);
    createAddress({ provider_id: providerId, email: "ops@older-page.test" });
    createAddress({ provider_id: providerId, email: "ops@middle-page.test" });
    createAddress({ provider_id: providerId, email: "ops@newer-page.test" });

    const firstPage = listDomainSummaries({ limit: 2, offset: 0 }).map((item) => item.domain);
    const secondPage = listDomainSummaries({ limit: 2, offset: 2 }).map((item) => item.domain);

    expect(firstPage).toHaveLength(2);
    expect(firstPage).toContain("middle-page.test");
    expect(firstPage).toContain("newer-page.test");
    expect(firstPage).not.toContain("older-page.test");
    expect(secondPage).toEqual(["older-page.test"]);
  });

  it("summarizes only registered domains even when mail has many external domains", async () => {
    createDomain(providerId, "registeredcount.com");
    seed("registered inbound", { to: ["ops@registeredcount.com"] });
    await sendComposed({ from: "ops@registeredcount.com", to: "client@y.com", subject: "registered sent", body: "hi", providerId });

    const db = getDatabase();
    for (let i = 0; i < 60; i++) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: `<external-${i}@x>`,
        from_address: `sender-${i}@outside.test`,
        to_addresses: [`team@external-${i}.test`],
        cc_addresses: [],
        subject: `external inbound ${i}`,
        text_body: "external",
        html_body: null,
        attachments: [],
        headers: {},
        raw_size: 1,
        received_at: new Date().toISOString(),
      }, db);
      createEmail(providerId, {
        from: `sender@external-${i}.test`,
        to: ["client@y.com"],
        subject: `external sent ${i}`,
      }, undefined, db);
    }

    const summaries = listDomainSummaries();
    const summary = summaries.find((item) => item.domain === "registeredcount.com");

    expect(summary).toMatchObject({
      inbox: 1,
      unread: 1,
      sent: 1,
      total: 2,
    });
    expect(summaries.some((item) => item.domain === "external-1.test")).toBe(false);
  });

  it("does not treat a configured address as receive-ready until address provisioning is ready", () => {
    const domain = createDomain(providerId, "pendingreceive.com");
    updateDomain(domain.id, { dkim_status: "verified", spf_status: "verified", dmarc_status: "verified" });
    createAddress({ provider_id: providerId, email: "ops@pendingreceive.com" });

    const summary = listDomainSummaries().find((item) => item.domain === "pendingreceive.com");

    expect(summary).toMatchObject({
      addresses: 1,
      readiness: "ready_to_send",
    });
  });

  it("summarizes display-name recipient and sender addresses by domain", () => {
    createDomain(providerId, "displayname.com");
    const address = createAddress({ provider_id: providerId, email: "ops@displayname.com" });
    markVerified(address.id);
    seed("display inbound", { to: ['"Ops Team" <ops@displayname.com>'] });
    createEmail(providerId, {
      from: '"Ops Team" <ops@displayname.com>',
      to: ["client@example.com"],
      subject: "display app sent",
    });
    storeInboundEmail({
      provider_id: providerId, message_id: "<display-sent@x>", from_address: '"Ops Team" <ops@displayname.com>',
      to_addresses: ["client@example.com"], cc_addresses: [], subject: "display synced sent", text_body: "b",
      html_body: null, attachments: [], label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    });

    const summary = listDomainSummaries().find((item) => item.domain === "displayname.com");

    expect(summary).toMatchObject({
      addresses: 1,
      inbox: 1,
      unread: 1,
      sent: 2,
      total: 3,
    });
  });

  it("counts one inbound email once per domain when multiple recipients share that domain", () => {
    createDomain(providerId, "dupecount.com");
    createDomain(providerId, "othercount.com");
    seed("multi-recipient", { to: ["ops@dupecount.com", "team@dupecount.com", "help@othercount.com"] });

    const summaries = new Map(listDomainSummaries().map((item) => [item.domain, item]));

    expect(summaries.get("dupecount.com")).toMatchObject({
      inbox: 1,
      unread: 1,
      total: 1,
    });
    expect(summaries.get("othercount.com")).toMatchObject({
      inbox: 1,
      unread: 1,
      total: 1,
    });
  });

  it("filters Sent by sender domain for app-sent and imported SENT mail", async () => {
    const db = getDatabase();
    await sendComposed({ from: "me@elyratelier.com", to: "client@y.com", subject: "app elyra", body: "hi", providerId });
    await sendComposed({ from: "me@droolbowl.com", to: "client@y.com", subject: "app other", body: "hi", providerId });
    createEmail(providerId, {
      from: '"Me" <me@elyratelier.com>',
      to: ["client@y.com"],
      subject: "app display elyra",
    }, undefined, db);
    storeInboundEmail({
      provider_id: providerId, message_id: "<gs1@x>", from_address: "me@elyratelier.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "imported elyra", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);
    storeInboundEmail({
      provider_id: providerId, message_id: "<gs2@x>", from_address: "me@droolbowl.com", to_addresses: ["client@y.com"],
      cc_addresses: [], subject: "imported other", text_body: "b", html_body: null, attachments: [],
      label_ids: ["SENT"], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    }, db);

    const sent = listMailbox("sent", { source: { domain: "elyratelier.com" } }).map((m) => m.subject);
    expect(sent).toContain("app elyra");
    expect(sent).toContain("app display elyra");
    expect(sent).toContain("imported elyra");
    expect(sent).not.toContain("app other");
    expect(sent).not.toContain("imported other");
    expect(mailboxCounts({ source: { domain: "elyratelier.com" } }).sent).toBe(3);
  });
});

describe("tui data — settings (persisted to config)", () => {
  let savedHome: string | undefined;
  let tmpHome: string;
  beforeEach(() => { savedHome = process.env["HOME"]; tmpHome = mkdtempSync(join(tmpdir(), "emails-cfg-")); process.env["HOME"] = tmpHome; });
  afterEach(() => { if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome; rmSync(tmpHome, { recursive: true, force: true }); });

  it("defaults to the light (Catppuccin Latte) theme with provider pulls off", () => {
    const s = getSettings();
    expect(s.autoPull).toBe(false);
    expect(s.dimRead).toBe(false);
    expect(s.defaultMailbox).toBe("inbox");
    expect(s.defaultAddress).toBeNull();
    expect(s.defaultFrom).toBeNull();
    expect(s.theme).toBe("light");
  });

  it("round-trips a setting change", () => {
    setSetting("autoPull", false);
    setSetting("dimRead", true);
    setSetting("defaultMailbox", "starred");
    setSetting("defaultAddress", "ops@example.com");
    setSetting("defaultFrom", "team@example.com");
    setSetting("theme", "dark");
    const s = getSettings();
    expect(s.autoPull).toBe(false);
    expect(s.dimRead).toBe(true);
    expect(s.defaultMailbox).toBe("starred");
    expect(s.defaultAddress).toBe("ops@example.com");
    expect(s.defaultFrom).toBe("team@example.com");
    expect(s.theme).toBe("dark");
  });

  it("falls back to inbox for an invalid persisted default mailbox", () => {
    setConfigValue("default_mailbox", "broken-folder");

    expect(getSettings().defaultMailbox).toBe("inbox");
  });
});
