// Self-hosted-ONLY: inbound read/star/archive/label state mutations routed to
// the /v1 `messages` resource. Exercises the REAL synchronous curl transport
// against an out-of-process /v1 stub (see src/test-support/v1-stub.ts).
//
// Migrated from the deleted local-SQLite pattern. Dropped tests covered deleted
// local behavior:
//   - all recordingDb SQL-projection assertions ("uses a narrow existence
//     check...", "updates hot UI flags without selecting full message rows",
//     "mutates labels with a narrow label projection...", the SQL halves of the
//     summary tests): they inspected local SQLite SQL that no longer exists. The
//     functional half (flags/labels mutate; summaries omit bodies/headers) is
//     retained.
//   - "keeps canonical mailbox state in sync..." and "keeps canonical spam/trash
//     flags and folders in sync...": these asserted the local mail_messages /
//     mailbox_message_state canonical tables (folder_id, is_spam, is_trash),
//     which have no /v1 equivalent on the client.
//
// The archived WRITE now moves the `archived` LABEL (which is_archived and the
// archived filter derive from) as well as sending the `archived` convenience field
// the server understands, so the round-trip holds through the generic /v1 store —
// asserted below.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  storeInboundEmail, listInboundEmails, getInboundEmail,
  setInboundRead, setInboundStarred,
  setInboundReadSummary, setInboundStarredSummary,
  setInboundReadFlag, setInboundStarredFlag,
  setInboundArchived, setInboundArchivedSummary, setInboundArchivedFlag,
  addInboundLabel, removeInboundLabel, addInboundLabelSummary, removeInboundLabelSummary,
  getUnreadCount,
} from "./inbound.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

type StoreInput = Parameters<typeof storeInboundEmail>[0];

function seed(subject: string, overrides: Partial<StoreInput> = {}) {
  return storeInboundEmail({
    provider_id: null, message_id: `<${subject}@x.com>`, from_address: "s@x.com",
    to_addresses: ["me@x.com"], cc_addresses: [], subject, text_body: "b", html_body: null,
    attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString(),
    ...overrides,
  } as StoreInput);
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

  it("updates read and star flags and reflects them in reads", () => {
    const e = seed("hot-flags");

    expect(setInboundReadFlag(e.id, true)).toBe(true);
    expect(setInboundStarredFlag(e.id, true)).toBe(true);

    expect(getInboundEmail(e.id)).toMatchObject({ is_read: true, is_starred: true });
  });

  it("returns lean summaries for state mutations without bodies", () => {
    const e = seed("wide-state", {
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
    });

    const read = setInboundReadSummary(e.id, true);
    const starred = setInboundStarredSummary(e.id, true);

    expect(read.is_read).toBe(true);
    expect(starred.is_starred).toBe(true);
    expect("text_body" in read).toBe(false);
    expect("html_body" in read).toBe(false);
    expect("headers" in read).toBe(false);
  });
});

describe("inbound archive / star", () => {
  it("archived mail (archived label) is hidden from the default list but visible with archived:true", async () => {
    // is_archived / the archived filter are derived from the `archived` label.
    await stub.seed({
      messages: [
        { id: "keep", direction: "inbound", from_addr: "s@x.com", to_addrs: ["me@x.com"], subject: "keep", received_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "gone", direction: "inbound", from_addr: "s@x.com", to_addrs: ["me@x.com"], subject: "gone", labels: ["archived"], received_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const def = listInboundEmails({}).map((e) => e.subject);
    expect(def).toContain("keep");
    expect(def).not.toContain("gone");
    expect(listInboundEmails({ archived: true }).map((e) => e.subject)).toEqual(["gone"]);
  });

  it("filters by starred", () => {
    seed("plain");
    const b = seed("star");
    setInboundStarred(b.id, true);
    expect(listInboundEmails({ starred: true }).map((e) => e.subject)).toEqual(["star"]);
  });

  it("archive write round-trips: is_archived flips and the archived filter follows", () => {
    const e = seed("to-archive");
    expect(e.is_archived).toBe(false);

    const archived = setInboundArchived(e.id, true);
    expect(archived.is_archived).toBe(true);
    expect(archived.label_ids).toContain("archived");
    // Hidden from the default list, visible with archived:true.
    expect(listInboundEmails({}).map((m) => m.subject)).not.toContain("to-archive");
    expect(listInboundEmails({ archived: true }).map((m) => m.subject)).toEqual(["to-archive"]);
    // Re-reading confirms the persisted state.
    expect(getInboundEmail(e.id)!.is_archived).toBe(true);

    // Unarchive removes the label and returns it to the inbox.
    const restored = setInboundArchived(e.id, false);
    expect(restored.is_archived).toBe(false);
    expect(restored.label_ids).not.toContain("archived");
    expect(listInboundEmails({}).map((m) => m.subject)).toContain("to-archive");
  });

  it("archived summary/flag variants also move the label", () => {
    const e = seed("archive-variants");
    const summary = setInboundArchivedSummary(e.id, true);
    expect(summary.is_archived).toBe(true);
    expect("text_body" in summary).toBe(false);
    expect(getInboundEmail(e.id)!.is_archived).toBe(true);

    expect(setInboundArchivedFlag(e.id, false)).toBe(false);
    expect(getInboundEmail(e.id)!.is_archived).toBe(false);
  });
});

describe("inbound labels", () => {
  it("adds and removes labels idempotently and filters by them", () => {
    const e = seed("a");
    addInboundLabel(e.id, "work");
    addInboundLabel(e.id, "work"); // idempotent
    addInboundLabel(e.id, "urgent");
    expect(getInboundEmail(e.id)!.label_ids.sort()).toEqual(["urgent", "work"]);
    expect(listInboundEmails({ label: "work" })).toHaveLength(1);
    removeInboundLabel(e.id, "work");
    expect(getInboundEmail(e.id)!.label_ids).toEqual(["urgent"]);
    expect(listInboundEmails({ label: "work" })).toHaveLength(0);
  });

  it("returns lean summaries for label mutations without bodies", () => {
    const e = seed("wide-label", {
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
    });

    const added = addInboundLabelSummary(e.id, "work");
    const removed = removeInboundLabelSummary(e.id, "work");

    expect(added.label_ids).toEqual(["work"]);
    expect(removed.label_ids).toEqual([]);
    expect("text_body" in added).toBe(false);
    expect("html_body" in added).toBe(false);
    expect("headers" in added).toBe(false);
  });
});

describe("inbound filters + unread count", () => {
  it("filters unread vs read", () => {
    seed("unread1");
    const b = seed("read1");
    setInboundRead(b.id, true);
    expect(listInboundEmails({ unread: true }).map((e) => e.subject)).toEqual(["unread1"]);
    expect(listInboundEmails({ read: true }).map((e) => e.subject)).toEqual(["read1"]);
  });

  it("getUnreadCount excludes read and archived", async () => {
    await stub.seed({
      messages: [
        { id: "u1", direction: "inbound", from_addr: "s@x.com", to_addrs: ["me@x.com"], subject: "u1", is_read: false, received_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "r1", direction: "inbound", from_addr: "s@x.com", to_addrs: ["me@x.com"], subject: "r1", is_read: true, received_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-02T00:00:00.000Z" },
        { id: "a1", direction: "inbound", from_addr: "s@x.com", to_addrs: ["me@x.com"], subject: "a1", is_read: false, labels: ["archived"], received_at: "2026-01-03T00:00:00.000Z", created_at: "2026-01-03T00:00:00.000Z" },
      ],
    });
    expect(getUnreadCount()).toBe(1);
  });

  it("getUnreadCount excludes imported SENT rows", () => {
    seed("received", { from_address: "external@example.com", to_addresses: ["me@example.com"] });
    seed("sent", { from_address: "me@example.com", to_addresses: ["external@example.com"], label_ids: ["SENT"] });

    expect(getUnreadCount()).toBe(1);
  });
});
