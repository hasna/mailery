import { describe, expect, it } from "bun:test";
import { MailCache, countsCacheKey, messagePageCacheKey } from "./mail-cache.js";

interface Clock {
  now: () => number;
  set: (value: number) => void;
  advance: (ms: number) => void;
}

function clock(start = 0): Clock {
  let t = start;
  return { now: () => t, set: (value) => { t = value; }, advance: (ms) => { t += ms; } };
}

function page(...ids: string[]) {
  return { data: ids.map((id) => ({ id })), nextCursor: null };
}

describe("mail-cache keys", () => {
  it("keys pages by the full request shape (group|q|cursor|mailbox)", () => {
    expect(messagePageCacheKey({ group: "inbox", q: "hi", cursor: "c1", mailbox: "mbx" })).toBe("inbox|hi|c1|mbx");
    expect(messagePageCacheKey({ group: "inbox" })).toBe("inbox|||");
    expect(messagePageCacheKey({})).toBe("|||");
    expect(countsCacheKey({ mailbox: "mbx" })).toBe("mbx");
    expect(countsCacheKey({})).toBe("");
    // Two requests differing only in one dimension must not collide.
    expect(messagePageCacheKey({ group: "inbox" })).not.toBe(messagePageCacheKey({ group: "sent" }));
  });
});

describe("mail-cache eviction", () => {
  it("evicts the least-recently-used page over the page cap", () => {
    const cache = new MailCache({ maxPages: 2, maxMessages: 1000, maxBytes: 1024 * 1024 });
    cache.setPage("a", page("m1"));
    cache.setPage("b", page("m2"));
    // Touch "a" so "b" becomes the least-recently-used.
    expect(cache.getPage("a")).toBeDefined();
    cache.setPage("c", page("m3"));

    expect(cache.stats().pages).toBe(2);
    expect(cache.getPage("a")).toBeDefined();
    expect(cache.getPage("b")).toBeUndefined();
    expect(cache.getPage("c")).toBeDefined();
  });

  it("evicts pages over the message cap", () => {
    const cache = new MailCache({ maxPages: 100, maxMessages: 5, maxBytes: 1024 * 1024 });
    cache.setPage("a", page("m1", "m2", "m3"));
    cache.setPage("b", page("m4", "m5", "m6")); // total 6 > 5 -> evict "a"

    expect(cache.getPage("a")).toBeUndefined();
    expect(cache.getPage("b")).toBeDefined();
    expect(cache.stats().messages).toBe(3);
  });

  it("evicts over the global byte cap (any namespace, LRU order)", () => {
    const cache = new MailCache({ maxPages: 100, maxMessages: 1000, maxBytes: 400 });
    const big = { blob: "x".repeat(200) };
    cache.setBody("m1", big);
    cache.setBody("m2", big);
    cache.setBody("m3", big); // exceeds 400 bytes -> evict oldest ("m1")

    expect(cache.getBody("m1")).toBeUndefined();
    expect(cache.getBody("m3")).toBeDefined();
    expect(cache.stats().bytes).toBeLessThanOrEqual(400);
  });
});

describe("mail-cache TTL", () => {
  it("serves fresh within TTL and treats stale as expired for get()", () => {
    const c = clock(0);
    const cache = new MailCache({ listTtlMs: 1000, now: c.now });
    cache.setPage("a", page("m1"));

    c.set(500);
    expect(cache.getPage("a")).toBeDefined(); // fresh

    c.set(2000);
    expect(cache.getPage("a")).toBeUndefined(); // stale -> miss for fresh-only get
  });

  it("peek returns stale value with fresh=false for stale-while-revalidate", () => {
    const c = clock(0);
    const cache = new MailCache({ listTtlMs: 1000, now: c.now });
    cache.setPage("a", page("m1"));

    c.set(1500);
    const peeked = cache.peekPage<{ data: unknown[] }>("a");
    expect(peeked).toBeDefined();
    expect(peeked?.fresh).toBe(false);
    expect(peeked?.value.data.length).toBe(1);
    // Stale entries survive until LRU-evicted, so they remain peekable.
    expect(cache.peekPage("a")).toBeDefined();
  });

  it("gives bodies a longer TTL than lists", () => {
    const c = clock(0);
    const cache = new MailCache({ listTtlMs: 1000, bodyTtlMs: 60_000, now: c.now });
    cache.setPage("a", page("m1"));
    cache.setBody("m1", { text: "hi" });

    c.set(5000);
    expect(cache.getPage("a")).toBeUndefined(); // list expired
    expect(cache.getBody("m1")).toBeDefined(); // body still fresh
  });
});

describe("mail-cache delta invalidation", () => {
  it("drops changed/deleted bodies and clears pages/counts/labels", () => {
    const cache = new MailCache();
    cache.setBody("m1", { text: "one" });
    cache.setBody("m2", { text: "two" });
    cache.setPage("inbox|||", page("m1", "m2"));
    cache.setCounts("", { inbox: 2 });
    cache.setLabels([{ name: "Billing", count: 1, popular: true }]);
    cache.setMailboxes([{ id: "mbx" }]);

    cache.applyDelta({ changed: ["m1"], deleted: ["m3"] });

    expect(cache.getBody("m1")).toBeUndefined(); // changed -> body dropped
    expect(cache.getBody("m2")).toBeDefined(); // untouched body survives
    expect(cache.getPage("inbox|||")).toBeUndefined(); // pages cleared
    expect(cache.getCounts("")).toBeUndefined(); // counts cleared
    expect(cache.getLabels()).toBeUndefined(); // labels cleared
    expect(cache.getMailboxes()).toBeDefined(); // mailbox list left intact
  });

  it("is a no-op when the delta is empty", () => {
    const cache = new MailCache();
    cache.setPage("inbox|||", page("m1"));
    cache.applyDelta({ changed: [], deleted: [] });
    expect(cache.getPage("inbox|||")).toBeDefined();
  });

  it("invalidateWrite drops the written body and all lists", () => {
    const cache = new MailCache();
    cache.setBody("m1", { text: "one" });
    cache.setPage("inbox|||", page("m1"));
    cache.setCounts("", { inbox: 1 });

    cache.invalidateWrite(["m1"]);

    expect(cache.getBody("m1")).toBeUndefined();
    expect(cache.getPage("inbox|||")).toBeUndefined();
    expect(cache.getCounts("")).toBeUndefined();
  });
});

describe("mail-cache epoch (coherence guard)", () => {
  it("bumps the epoch on every write/delta invalidation so late refreshes can veto themselves", () => {
    const cache = new MailCache();
    const start = cache.epoch;
    cache.invalidateWrite(["m1"]);
    expect(cache.epoch).toBe(start + 1);
    cache.applyDelta({ changed: ["m2"], deleted: [] });
    expect(cache.epoch).toBe(start + 2);
    cache.applyDelta({ changed: [], deleted: [] }); // empty delta -> no bump
    expect(cache.epoch).toBe(start + 2);
    cache.clear();
    expect(cache.epoch).toBe(start + 3);
  });
});

describe("mail-cache watermark", () => {
  it("advances monotonically and never regresses", () => {
    const cache = new MailCache();
    expect(cache.watermark).toBeNull();
    cache.advanceWatermark("2026-07-01T00:00:00.000Z");
    expect(cache.watermark).toBe("2026-07-01T00:00:00.000Z");
    cache.advanceWatermark("2026-06-01T00:00:00.000Z"); // older -> ignored
    expect(cache.watermark).toBe("2026-07-01T00:00:00.000Z");
    cache.advanceWatermark("2026-07-02T00:00:00.000Z"); // newer -> advances
    expect(cache.watermark).toBe("2026-07-02T00:00:00.000Z");
    cache.advanceWatermark(null); // ignored
    expect(cache.watermark).toBe("2026-07-02T00:00:00.000Z");
  });
});
