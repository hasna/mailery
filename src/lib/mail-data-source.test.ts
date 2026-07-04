import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailCache } from "./mail-cache.js";
import { MaileryCloudClient } from "./mailery-cloud-client.js";
import {
  ApiMailDataSource,
  SqliteMailDataSource,
  resetMailDataSource,
  resolveMailDataSource,
} from "./mail-data-source.js";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { setInboundArchivedFlag, setInboundReadFlag, setInboundStarredFlag, storeInboundEmail } from "../db/inbound.js";

// ── cloud harness: a real MaileryCloudClient over a programmable fetch ─────────

interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

interface CloudState {
  mailboxes: Array<{ id: string; tenantId?: string; name?: string | null; email: string; provider?: string; status?: string }>;
  listData: unknown[];
  listNextCursor: string | null;
  groups: Record<string, number>;
  messages: Record<string, unknown>;
  changesData: unknown[];
  changesNextCursor: string | null;
  tombstones: unknown[];
  bulkResponse: unknown;
  sendResponse: unknown;
  labelResponse: unknown;
}

function fullMessage(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    tenantId: "ten_1",
    mailboxId: "mbx_1",
    direction: "inbound",
    subject: "(no subject)",
    fromAddress: "",
    toAddresses: [],
    ccAddresses: [],
    textBody: null,
    htmlBody: null,
    summary: null,
    isRead: false,
    isStarred: false,
    isImportant: false,
    attachments: [],
    label_names: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    receivedAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function createApi(init: Partial<CloudState> = {}, opts: { clock?: () => number } = {}) {
  const state: CloudState = {
    mailboxes: init.mailboxes ?? [],
    listData: init.listData ?? [],
    listNextCursor: init.listNextCursor ?? null,
    groups: init.groups ?? { inbox: 0, unread: 0, starred: 0, sent: 0, archive: 0, spam: 0, trash: 0 },
    messages: init.messages ?? {},
    changesData: init.changesData ?? [],
    changesNextCursor: init.changesNextCursor ?? null,
    tombstones: init.tombstones ?? [],
    bulkResponse: init.bulkResponse ?? { ok: true, action: "", affected: 0, matched: 0, has_more: false, next_cursor: null },
    sendResponse: init.sendResponse ?? {},
    labelResponse: init.labelResponse ?? { ok: true, labels: [], label_names: [] },
  };
  const calls: RecordedCall[] = [];
  let fetchCount = 0;

  const fetchImpl = (async (url: string | URL | Request, req?: RequestInit) => {
    fetchCount += 1;
    const u = new URL(String(url));
    const method = (req?.method ?? "GET").toUpperCase();
    const body = req?.body ? JSON.parse(String(req.body)) as unknown : undefined;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    const path = u.pathname;

    if (path === "/api/v1/mailboxes" && method === "GET") return jsonResponse({ data: state.mailboxes });
    if (path === "/api/v1/messages/groups" && method === "GET") return jsonResponse(state.groups);
    if (path === "/api/v1/messages/changes" && method === "GET") return jsonResponse({ data: state.changesData, next_cursor: state.changesNextCursor });
    if (path === "/api/v1/messages/tombstones" && method === "GET") return jsonResponse({ data: state.tombstones });
    if (path === "/api/v1/messages/bulk" && method === "POST") return jsonResponse(state.bulkResponse);
    if (path === "/api/v1/messages/send" && method === "POST") return jsonResponse(state.sendResponse, 202);
    if (path === "/api/v1/messages" && method === "GET") return jsonResponse({ data: state.listData, next_cursor: state.listNextCursor });

    const labelDelete = path.match(/^\/api\/v1\/messages\/([^/]+)\/labels\/(.+)$/);
    if (labelDelete && method === "DELETE") return jsonResponse(state.labelResponse);
    const labelAdd = path.match(/^\/api\/v1\/messages\/([^/]+)\/labels$/);
    if (labelAdd && method === "POST") return jsonResponse(state.labelResponse);

    const byId = path.match(/^\/api\/v1\/messages\/([^/]+)$/);
    if (byId) {
      const id = decodeURIComponent(byId[1]!);
      if (method === "GET") return jsonResponse(state.messages[id] ?? fullMessage({ id }));
      if (method === "PATCH") return jsonResponse({ ...(state.messages[id] as object ?? {}), id, ...(body as object) });
      if (method === "DELETE") return jsonResponse({ ok: true, tombstone: { id, message_id: id } });
    }
    return jsonResponse({ error: { code: "not_found", message: `unrouted ${method} ${path}` } }, 404);
  }) as typeof fetch;

  const client = new MaileryCloudClient({ apiUrl: "https://mailery.example", token: "t", fetchImpl });
  const cache = new MailCache({ now: opts.clock });
  const dataSource = new ApiMailDataSource({ client, cache, now: opts.clock });
  return { dataSource, cache, client, calls, state, fetchCount: () => fetchCount };
}

describe("ApiMailDataSource reads", () => {
  it("lists a folder over GET /messages and serves the second call from cache", async () => {
    const { dataSource, calls, fetchCount } = createApi({
      listData: [fullMessage({ id: "m1", subject: "Hello", fromAddress: "a@x.com", toAddresses: ["me@x.com"], isRead: false, snippet: "hi", threadId: "thr_1", hasAttachments: true })],
    });

    const first = await dataSource.listMailbox("inbox");
    const before = fetchCount();
    const second = await dataSource.listMailbox("inbox");

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ id: "m1", kind: "inbound", from: "a@x.com", subject: "Hello", is_read: false, snippet: "hi", thread_id: "thr_1", attachments: 1 });
    expect(fetchCount()).toBe(before); // cache hit -> no new network
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/messages", query: { group: "inbox", limit: "200" } });
  });

  it("maps the archived folder to the server 'archive' group", async () => {
    const { dataSource, calls } = createApi({ listData: [] });
    await dataSource.listMailbox("archived");
    expect(calls[0]?.query["group"]).toBe("archive");
  });

  it("stale-while-revalidate: returns the stale page immediately and refreshes in the background", async () => {
    let t = 1_000;
    const api = createApi(
      { listData: [fullMessage({ id: "m1", subject: "old" })] },
      { clock: () => t },
    );

    const first = await api.dataSource.listMailbox("inbox");
    expect(first[0]?.subject).toBe("old");
    const afterFirst = api.fetchCount();

    // Age past the list TTL (default 30s) and change the server data.
    t += 60_000;
    api.state.listData = [fullMessage({ id: "m1", subject: "new" })];

    const stale = await api.dataSource.listMailbox("inbox");
    expect(stale[0]?.subject).toBe("old"); // served stale
    expect(api.fetchCount()).toBe(afterFirst + 1); // background refresh kicked

    await api.dataSource.settle();
    const fresh = await api.dataSource.listMailbox("inbox");
    expect(fresh[0]?.subject).toBe("new"); // refreshed cache
  });

  it("reads and caches group counts from /messages/groups", async () => {
    const { dataSource, fetchCount } = createApi({ groups: { inbox: 5, unread: 2, starred: 1, sent: 3, archive: 4, spam: 0, trash: 0 } });
    const counts = await dataSource.mailboxCounts();
    const before = fetchCount();
    await dataSource.mailboxCounts();

    expect(counts).toEqual({ inbox: 5, unread: 2, starred: 1, sent: 3, archived: 4, spam: 0, trash: 0 });
    expect(fetchCount()).toBe(before);
  });

  it("builds mailbox status from counts and folder labels", async () => {
    const { dataSource } = createApi({ groups: { inbox: 5, unread: 2, starred: 1, sent: 3, archive: 4, spam: 0, trash: 0 } });
    const status = await dataSource.listMailboxStatus();
    expect(status.counts.inbox).toBe(5);
    expect(status.folders.find((f) => f.id === "inbox")?.count).toBe(5);
    expect(status.folders.map((f) => f.id)).toContain("archived");
  });

  it("fetches and caches a full message body, reused by getMessage", async () => {
    const { dataSource, fetchCount } = createApi({
      messages: { m1: fullMessage({ id: "m1", subject: "Body test", fromAddress: "a@x.com", toAddresses: ["me@x.com"], textBody: "hello world", attachments: [{ id: "att1", filename: "f.pdf", contentType: "application/pdf", sizeBytes: 10, download_url: "/api/v1/attachments/att1/download" }] }) },
    });

    const body = await dataSource.getMessageBody({ id: "m1" } as never);
    const before = fetchCount();
    const message = await dataSource.getMessage("m1");

    expect(body?.text).toBe("hello world");
    expect(body?.attachments[0]).toMatchObject({ filename: "f.pdf", size: 10, location: "/api/v1/attachments/att1/download" });
    expect(message?.subject).toBe("Body test");
    expect(fetchCount()).toBe(before); // getMessage reused the cached body
  });

  it("reads a conversation via GET /messages?threadId", async () => {
    const { dataSource, calls } = createApi({
      listData: [
        fullMessage({ id: "m1", direction: "inbound", fromAddress: "a@x.com", subject: "Re: hi" }),
        fullMessage({ id: "m2", direction: "outbound", fromAddress: "me@x.com", subject: "Re: hi" }),
      ],
    });

    const thread = await dataSource.getConversation({ id: "m1", thread_id: "thr_1" } as never);

    expect(thread.map((t) => t.kind)).toEqual(["received", "sent"]);
    expect(calls[0]).toMatchObject({ path: "/api/v1/messages", query: { threadId: "thr_1", limit: "200" } });
  });

  it("returns no conversation for a message without a thread", async () => {
    const { dataSource, fetchCount } = createApi();
    const thread = await dataSource.getConversation({ id: "m1", thread_id: null } as never);
    expect(thread).toEqual([]);
    expect(fetchCount()).toBe(0);
  });

  it("maps cloud mailboxes into source summaries", async () => {
    const { dataSource } = createApi({ mailboxes: [{ id: "mbx_1", email: "agent@acme.com", name: "Agent", provider: "ses" }] });
    const sources = await dataSource.listMailboxSources();
    expect(sources[0]).toMatchObject({ id: "provider:mbx_1", label: "Agent", kind: "provider", providerId: "mbx_1", providerType: "ses" });
  });

  it("finds the latest verification code, filtering by recipient client-side", async () => {
    const { dataSource, calls } = createApi({
      listData: [
        fullMessage({ id: "other", fromAddress: "noreply@bank.com", subject: "Someone else", toAddresses: ["notme@x.com"] }),
        fullMessage({ id: "m1", fromAddress: "noreply@bank.com", subject: "Your code", toAddresses: ["Me <me@x.com>"] }),
      ],
      messages: { m1: fullMessage({ id: "m1", fromAddress: "noreply@bank.com", subject: "Your code", toAddresses: ["me@x.com"], textBody: "Your verification code is 123456" }) },
    });

    const candidates = await dataSource.verificationCandidates("me@x.com", { limit: 5 });
    const match = await dataSource.findLatest("me@x.com");

    // Only the message addressed to me@x.com is a candidate (server search never
    // matches recipient, so filtering is client-side over to_addresses).
    expect(candidates.map((c) => c.id)).toEqual(["m1"]);
    expect(candidates[0]).toMatchObject({ from_address: "noreply@bank.com", text_body: "Your verification code is 123456" });
    expect(match?.code).toBe("123456");
    expect(match?.confidence).toBe("high");
    // Recipient scoping does not rely on the server's q search param.
    expect(calls[0]?.query["q"]).toBeUndefined();
  });
});

describe("ApiMailDataSource writes bypass + invalidate the cache", () => {
  it("setRead patches the flag and invalidates cached lists", async () => {
    const api = createApi({ listData: [fullMessage({ id: "m1", isRead: false })] });
    await api.dataSource.listMailbox("inbox");
    const beforeWrite = api.fetchCount();

    await api.dataSource.setRead("m1", true);
    const patch = api.calls.at(-1)!;
    expect(patch).toMatchObject({ method: "PATCH", path: "/api/v1/messages/m1", body: { isRead: true } });

    await api.dataSource.listMailbox("inbox");
    expect(api.fetchCount()).toBeGreaterThan(beforeWrite + 1); // write invalidated -> refetched
  });

  it("setStarred uses the isStarred patch", async () => {
    const api = createApi();
    await api.dataSource.setStarred("m1", true);
    expect(api.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/api/v1/messages/m1", body: { isStarred: true } });
  });

  it("addLabel / removeLabel return the updated label names", async () => {
    const api = createApi({ labelResponse: { ok: true, labels: [{ id: "l1", name: "Billing", color: "#abc", kind: "custom" }], label_names: ["Billing"] } });
    const added = await api.dataSource.addLabel("m1", "Billing");
    const removed = await api.dataSource.removeLabel("m1", "Billing");
    expect(added).toEqual(["Billing"]);
    expect(removed).toEqual(["Billing"]);
    expect(api.calls[0]).toMatchObject({ method: "POST", path: "/api/v1/messages/m1/labels", body: { label: "Billing" } });
    expect(api.calls[1]).toMatchObject({ method: "DELETE", path: "/api/v1/messages/m1/labels/Billing" });
  });

  it("deleteMessage hits DELETE /messages/:id", async () => {
    const api = createApi();
    await api.dataSource.deleteMessage("m1");
    expect(api.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/v1/messages/m1" });
  });

  it("bulk maps mailbox -> folder and returns normalized counts", async () => {
    const api = createApi({ bulkResponse: { ok: true, action: "markRead", affected: 7, matched: 7, has_more: false, next_cursor: null } });
    const result = await api.dataSource.bulk({ action: "markRead", mailbox: "archived" });
    expect(result).toEqual({ action: "markRead", affected: 7, matched: 7, hasMore: false, nextCursor: null });
    expect(api.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/messages/bulk", body: { action: "markRead", folder: "archive" } });
  });

  it("send resolves a mailbox from the from-address and returns the provider message id", async () => {
    const api = createApi({
      mailboxes: [{ id: "mbx_1", email: "agent@acme.com" }],
      sendResponse: { id: "cloud_msg_sent", provider_message_id: "ses-1", mode: "live", attachments: [] },
    });

    const result = await api.dataSource.send({ from: "agent@acme.com", to: "dest@ext.com, other@ext.com", subject: "Hi", body: "Body" });

    expect(result).toEqual({ id: "cloud_msg_sent", messageId: "ses-1" });
    const send = api.calls.at(-1)!;
    expect(send).toMatchObject({ method: "POST", path: "/api/v1/messages/send" });
    expect(send.body).toMatchObject({ mailboxId: "mbx_1", to: ["dest@ext.com", "other@ext.com"], subject: "Hi", text: "Body" });
  });
});

describe("ApiMailDataSource delta sync", () => {
  it("reads changes since the watermark + tombstones, dedupes, invalidates, and advances the watermark with no gap", async () => {
    const t = Date.parse("2026-07-03T12:00:00.000Z");
    const api = createApi(
      {
        changesData: [
          fullMessage({ id: "m2", subject: "changed" }),
          fullMessage({ id: "m2", subject: "changed again" }), // duplicate id in the feed
        ],
        tombstones: [{ id: "m3", message_id: "m3" }],
      },
      { clock: () => t },
    );

    // Prime the cache with a page + a body that the delta must invalidate.
    api.cache.setPage("inbox|||", { data: [{ id: "m1" }], nextCursor: null });
    api.cache.setBody("m2", { text: "stale body" });
    api.cache.advanceWatermark("2026-07-01T00:00:00.000Z");

    const changes = await api.dataSource.changesSince();

    // Correct endpoints + the watermark carried into both queries.
    const changesCall = api.calls.find((c) => c.path === "/api/v1/messages/changes");
    const tombCall = api.calls.find((c) => c.path === "/api/v1/messages/tombstones");
    expect(changesCall?.query["updatedSince"]).toBe("2026-07-01T00:00:00.000Z");
    expect(tombCall?.query["since"]).toBe("2026-07-01T00:00:00.000Z");

    // Deduped changed set + tombstones.
    expect(changes.messages.map((m) => m.id)).toEqual(["m2"]);
    expect(changes.deletedIds).toEqual(["m3"]);

    // Cache invalidation: the primed page and the changed body are gone.
    expect(api.cache.getPage("inbox|||")).toBeUndefined();
    expect(api.cache.getBody("m2")).toBeUndefined();

    // Watermark advanced to the sync start (client clock, minus a 5s skew overlap),
    // never regressing -> no gap.
    expect(changes.watermark).toBe("2026-07-03T11:59:55.000Z");
    expect(api.cache.watermark).toBe("2026-07-03T11:59:55.000Z");
  });

  it("falls back to an explicit since and continues from where it left off", async () => {
    const api = createApi({ changesData: [], tombstones: [] });
    const changes = await api.dataSource.changesSince({ since: "2026-06-15T00:00:00.000Z" });
    const changesCall = api.calls.find((c) => c.path === "/api/v1/messages/changes");
    expect(changesCall?.query["updatedSince"]).toBe("2026-06-15T00:00:00.000Z");
    expect(changes.messages).toEqual([]);
    expect(changes.deletedIds).toEqual([]);
  });

  it("cold start (no watermark) establishes a baseline without pulling the mailbox", async () => {
    const t = Date.parse("2026-07-03T12:00:00.000Z");
    const api = createApi({}, { clock: () => t });
    const changes = await api.dataSource.changesSince();
    // No changes/tombstones fetched — just a baseline watermark.
    expect(api.calls.find((c) => c.path === "/api/v1/messages/changes")).toBeUndefined();
    expect(changes.messages).toEqual([]);
    expect(changes.watermark).not.toBeNull();
  });

  it("does not advance the watermark while the feed still has more (no lost newest rows)", async () => {
    const t = Date.parse("2026-07-03T12:00:00.000Z");
    // Server always reports more pages -> feed never drains within the safety cap.
    const api = createApi(
      { changesData: [fullMessage({ id: "m2", subject: "changed" })], changesNextCursor: "more", tombstones: [] },
      { clock: () => t },
    );
    api.cache.advanceWatermark("2026-07-01T00:00:00.000Z");

    const changes = await api.dataSource.changesSince();

    // Watermark stays put; a resume cursor is handed back for the next call.
    expect(api.cache.watermark).toBe("2026-07-01T00:00:00.000Z");
    expect(changes.cursor).toBe("more");
  });
});

// ── local mode: SqliteMailDataSource over an in-memory SQLite ─────────────────

describe("SqliteMailDataSource (local, in-memory sqlite)", () => {
  const originalHome = process.env["HOME"];
  let tmpHome: string | null = null;

  function seed(subject: string, opts: { read?: boolean; star?: boolean; archived?: boolean; body?: string; from?: string; to?: string[] } = {}) {
    const email = storeInboundEmail({
      provider_id: null,
      message_id: `<${subject}@x>`,
      from_address: opts.from ?? "alice@ext.com",
      to_addresses: opts.to ?? ["me@x.com"],
      cc_addresses: [],
      subject,
      text_body: opts.body ?? `body of ${subject}`,
      html_body: null,
      attachments: [],
      label_ids: [],
      headers: {},
      raw_size: 1,
      received_at: new Date().toISOString(),
    });
    if (opts.read) setInboundReadFlag(email.id, true);
    if (opts.star) setInboundStarredFlag(email.id, true);
    if (opts.archived) setInboundArchivedFlag(email.id, true);
    return email;
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mailery-mds-"));
    process.env["HOME"] = tmpHome;
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  });

  it("lists a folder and computes counts", async () => {
    const ds = new SqliteMailDataSource();
    seed("one");
    seed("two", { read: true });
    seed("archived-one", { archived: true });

    const inbox = await ds.listMailbox("inbox");
    const counts = await ds.mailboxCounts();

    expect(inbox.map((m) => m.subject).sort()).toEqual(["one", "two"]);
    expect(counts.inbox).toBe(2);
    expect(counts.archived).toBe(1);
  });

  it("reads a message and its body", async () => {
    const ds = new SqliteMailDataSource();
    const email = seed("hello", { body: "the body text" });

    const message = await ds.getMessage(email.id);
    const body = await ds.getMessageBody(message!);

    expect(message).toMatchObject({ id: email.id, subject: "hello", kind: "inbound" });
    expect(body?.text).toContain("the body text");
  });

  it("toggles read / starred / archived flags", async () => {
    const ds = new SqliteMailDataSource();
    const email = seed("flags");

    await ds.setRead(email.id, true);
    expect((await ds.listMailbox("unread")).some((m) => m.id === email.id)).toBe(false);

    await ds.setStarred(email.id, true);
    expect((await ds.listMailbox("starred")).some((m) => m.id === email.id)).toBe(true);

    await ds.setArchived(email.id, true);
    expect((await ds.listMailbox("archived")).some((m) => m.id === email.id)).toBe(true);
  });

  it("adds and removes labels", async () => {
    const ds = new SqliteMailDataSource();
    const email = seed("labelled");

    const added = await ds.addLabel(email.id, "billing");
    expect(added).toContain("billing");
    const removed = await ds.removeLabel(email.id, "billing");
    expect(removed).not.toContain("billing");
  });

  it("deletes a message", async () => {
    const ds = new SqliteMailDataSource();
    const email = seed("doomed");
    await ds.deleteMessage(email.id);
    expect(await ds.getMessage(email.id)).toBeNull();
  });

  it("bulk-marks a folder read", async () => {
    const ds = new SqliteMailDataSource();
    seed("a");
    seed("b");
    seed("c");

    const result = await ds.bulk({ action: "markRead", mailbox: "inbox" });

    expect(result.matched).toBe(3);
    expect(result.affected).toBe(3);
    expect(await ds.mailboxCounts().then((c) => c.unread)).toBe(0);
  });

  it("returns recent messages via changesSince", async () => {
    const ds = new SqliteMailDataSource();
    seed("recent");
    const changes = await ds.changesSince();
    expect(changes.messages.some((m) => m.subject === "recent")).toBe(true);
    expect(changes.deletedIds).toEqual([]);
    expect(changes.watermark).not.toBeNull();
  });

  it("finds a verification code from candidates", async () => {
    const ds = new SqliteMailDataSource();
    seed("Your code", { from: "noreply@bank.com", body: "Your verification code is 654321" });

    const candidates = await ds.verificationCandidates("me@x.com");
    const match = await ds.findLatest("me@x.com");

    expect(candidates.length).toBeGreaterThan(0);
    expect(match?.code).toBe("654321");
  });
});

describe("resolveMailDataSource", () => {
  afterEach(() => resetMailDataSource());

  it("returns a SqliteMailDataSource for local mode and memoizes it", () => {
    const a = resolveMailDataSource({ mode: "local" });
    expect(a).toBeInstanceOf(SqliteMailDataSource);
    const b = resolveMailDataSource();
    // Default resolution (env is local in the test harness) reuses the memo.
    expect(b.mode).toBe("local");
  });

  it("returns an ApiMailDataSource for cloud mode with an injected client", () => {
    const client = new MaileryCloudClient({ apiUrl: "https://self-hosted.example", token: "t" });
    const source = resolveMailDataSource({ mode: "cloud", client });
    expect(source).toBeInstanceOf(ApiMailDataSource);
    expect(source.mode).toBe("cloud");
  });
});
