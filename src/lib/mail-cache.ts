// Bounded, server-authoritative read-through cache for the cloud (thin-client)
// mail data source. This is NOT a full mirror and NEVER a source of truth: it holds
// a small, LRU+TTL-bounded window of what the client is currently looking at
// (message list pages, opened bodies, group counts, mailbox/label lists) and lets
// a delta feed (listMessageChanges + tombstones, keyed off a watermark) invalidate
// exactly what changed. Writes bypass the cache and invalidate the affected reads.
//
// Hard caps keep it O(bounded) regardless of mailbox size:
//   • ≤ maxMessages cached list-messages   (default 500)
//   • ≤ maxPages    cached list pages       (default 50)
//   • ≤ maxBytes    total serialized bytes  (default 8 MiB)
// Freshness (staleness) is separate from eviction: a stale entry is still served
// stale-while-revalidate via peek*(), and only leaves the cache under LRU pressure.
//
// Local mode does not use this at all — SQLite is already the local source of truth.

export type MailCacheNamespace = "page" | "body" | "counts" | "mailboxes" | "labels";

export interface MailCacheOptions {
  /** Max total list-messages held across all cached pages. Default 500. */
  maxMessages?: number;
  /** Max cached list pages. Default 50. */
  maxPages?: number;
  /** Max total serialized bytes across every entry. Default 8 MiB. */
  maxBytes?: number;
  /** Freshness window for lists/counts/mailboxes/labels. Default 30s. */
  listTtlMs?: number;
  /** Freshness window for opened message bodies (near-immutable). Default 1h. */
  bodyTtlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface MailCacheStats {
  entries: number;
  pages: number;
  messages: number;
  bytes: number;
}

export interface MailCachePeek<V> {
  value: V;
  fresh: boolean;
  ageMs: number;
}

export interface MailCacheDelta {
  /** Message ids created-or-changed since the watermark. */
  changed?: string[];
  /** Message ids tombstoned since the watermark. */
  deleted?: string[];
}

interface CacheEntry {
  key: string;
  namespace: MailCacheNamespace;
  value: unknown;
  sizeBytes: number;
  /** Number of list-messages this entry accounts for (pages only; else 0). */
  weight: number;
  storedAt: number;
  ttlMs: number;
}

const DEFAULTS = {
  maxMessages: 500,
  maxPages: 50,
  maxBytes: 8 * 1024 * 1024,
  listTtlMs: 30_000,
  bodyTtlMs: 60 * 60_000,
} as const;

function sizeOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    // Circular/unserializable — charge a nominal cost so it can still be evicted.
    return 256;
  }
}

// Stable cache key for a list/search page. Keyed by the full request shape so two
// requests that differ only in group/q/cursor/mailbox never collide.
export function messagePageCacheKey(opts: { group?: string; q?: string; cursor?: string; mailbox?: string } = {}): string {
  return [opts.group ?? "", opts.q ?? "", opts.cursor ?? "", opts.mailbox ?? ""].join("|");
}

// Stable cache key for group counts, scoped by mailbox.
export function countsCacheKey(opts: { mailbox?: string } = {}): string {
  return opts.mailbox ?? "";
}

/**
 * A single global LRU+TTL store with namespaced entries. One store (rather than one
 * per value type) gives a single global byte budget and a single LRU ordering, while
 * the page-specific message/page caps are enforced by targeting page entries during
 * eviction. `Map` iteration order is insertion order, so recency is maintained by
 * re-inserting a key on access and evicting from the front.
 */
export class MailCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly opts: Required<Omit<MailCacheOptions, "now">>;
  private readonly now: () => number;
  private totalBytes = 0;
  private totalMessages = 0;
  private pageCount = 0;
  /** High-water mark (ISO timestamp) of the newest updated_at the cache has observed. */
  private watermarkTs: string | null = null;
  /**
   * Monotonic invalidation epoch. Bumped by every write/delta invalidation so a
   * background stale-while-revalidate fetch that started before the invalidation can
   * detect it landed late and refuse to resurrect superseded data.
   */
  private epochCounter = 0;

  constructor(options: MailCacheOptions = {}) {
    this.opts = {
      maxMessages: options.maxMessages ?? DEFAULTS.maxMessages,
      maxPages: options.maxPages ?? DEFAULTS.maxPages,
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
      listTtlMs: options.listTtlMs ?? DEFAULTS.listTtlMs,
      bodyTtlMs: options.bodyTtlMs ?? DEFAULTS.bodyTtlMs,
    };
    this.now = options.now ?? Date.now;
  }

  private compositeKey(namespace: MailCacheNamespace, key: string): string {
    return `${namespace}:${key}`;
  }

  private ttlFor(namespace: MailCacheNamespace): number {
    return namespace === "body" ? this.opts.bodyTtlMs : this.opts.listTtlMs;
  }

  private removeEntry(entry: CacheEntry): void {
    if (!this.entries.delete(entry.key)) return;
    this.totalBytes -= entry.sizeBytes;
    this.totalMessages -= entry.weight;
    if (entry.namespace === "page") this.pageCount -= 1;
  }

  private evictOldest(predicate?: (entry: CacheEntry) => boolean): boolean {
    for (const entry of this.entries.values()) {
      if (predicate && !predicate(entry)) continue;
      this.removeEntry(entry);
      return true;
    }
    return false;
  }

  private enforceCaps(): void {
    // Page-count and message caps can only be relieved by evicting page entries.
    while (this.pageCount > this.opts.maxPages) {
      if (!this.evictOldest((e) => e.namespace === "page")) break;
    }
    while (this.totalMessages > this.opts.maxMessages) {
      if (!this.evictOldest((e) => e.namespace === "page")) break;
    }
    // The byte budget is global — evict the least-recently-used entry of any kind.
    while (this.totalBytes > this.opts.maxBytes) {
      if (!this.evictOldest()) break;
    }
  }

  private setEntry(namespace: MailCacheNamespace, key: string, value: unknown, weight: number): void {
    const composite = this.compositeKey(namespace, key);
    const existing = this.entries.get(composite);
    if (existing) this.removeEntry(existing);
    const entry: CacheEntry = {
      key: composite,
      namespace,
      value,
      sizeBytes: sizeOf(value),
      weight,
      storedAt: this.now(),
      ttlMs: this.ttlFor(namespace),
    };
    this.entries.set(composite, entry);
    this.totalBytes += entry.sizeBytes;
    this.totalMessages += entry.weight;
    if (namespace === "page") this.pageCount += 1;
    this.enforceCaps();
  }

  // Read an entry stale-while-revalidate: returns the value even when stale, plus a
  // `fresh` flag so the caller can trigger a background refresh. Bumps LRU recency.
  private peekEntry<V>(namespace: MailCacheNamespace, key: string): MailCachePeek<V> | undefined {
    const composite = this.compositeKey(namespace, key);
    const entry = this.entries.get(composite);
    if (!entry) return undefined;
    // Re-insert to move to the most-recently-used position.
    this.entries.delete(composite);
    this.entries.set(composite, entry);
    const ageMs = this.now() - entry.storedAt;
    return { value: entry.value as V, fresh: ageMs <= entry.ttlMs, ageMs };
  }

  // Fresh-only read: returns the value only if within its TTL, else undefined.
  private getEntry<V>(namespace: MailCacheNamespace, key: string): V | undefined {
    const peeked = this.peekEntry<V>(namespace, key);
    return peeked && peeked.fresh ? peeked.value : undefined;
  }

  private deleteEntry(namespace: MailCacheNamespace, key: string): void {
    const entry = this.entries.get(this.compositeKey(namespace, key));
    if (entry) this.removeEntry(entry);
  }

  private clearNamespace(namespace: MailCacheNamespace): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.namespace === namespace) this.removeEntry(entry);
    }
  }

  // ── message list pages ─────────────────────────────────────────────────────
  getPage<P extends { data: unknown[] }>(key: string): P | undefined {
    return this.getEntry<P>("page", key);
  }
  peekPage<P extends { data: unknown[] }>(key: string): MailCachePeek<P> | undefined {
    return this.peekEntry<P>("page", key);
  }
  setPage<P extends { data: unknown[] }>(key: string, page: P): void {
    this.setEntry("page", key, page, page.data.length);
  }

  // ── opened message bodies (near-immutable, long TTL) ────────────────────────
  getBody<B>(id: string): B | undefined {
    return this.getEntry<B>("body", id);
  }
  peekBody<B>(id: string): MailCachePeek<B> | undefined {
    return this.peekEntry<B>("body", id);
  }
  setBody<B>(id: string, body: B): void {
    this.setEntry("body", id, body, 0);
  }
  deleteBody(id: string): void {
    this.deleteEntry("body", id);
  }

  // ── group counts ───────────────────────────────────────────────────────────
  getCounts<C>(key: string): C | undefined {
    return this.getEntry<C>("counts", key);
  }
  peekCounts<C>(key: string): MailCachePeek<C> | undefined {
    return this.peekEntry<C>("counts", key);
  }
  setCounts<C>(key: string, counts: C): void {
    this.setEntry("counts", key, counts, 0);
  }

  // ── mailbox + label lists ──────────────────────────────────────────────────
  getMailboxes<M>(): M | undefined {
    return this.getEntry<M>("mailboxes", "");
  }
  peekMailboxes<M>(): MailCachePeek<M> | undefined {
    return this.peekEntry<M>("mailboxes", "");
  }
  setMailboxes<M>(value: M): void {
    this.setEntry("mailboxes", "", value, 0);
  }
  getLabels<L>(): L | undefined {
    return this.getEntry<L>("labels", "");
  }
  peekLabels<L>(): MailCachePeek<L> | undefined {
    return this.peekEntry<L>("labels", "");
  }
  setLabels<L>(value: L): void {
    this.setEntry("labels", "", value, 0);
  }

  // ── invalidation epoch (coherence guard) ───────────────────────────────────
  get epoch(): number {
    return this.epochCounter;
  }

  // ── watermark for delta refresh ────────────────────────────────────────────
  get watermark(): string | null {
    return this.watermarkTs;
  }
  // Advance the watermark monotonically to the newest updated_at observed.
  advanceWatermark(ts: string | null | undefined): void {
    if (!ts) return;
    if (this.watermarkTs === null || ts > this.watermarkTs) this.watermarkTs = ts;
  }

  // ── invalidation ───────────────────────────────────────────────────────────
  /**
   * Apply a delta read: drop the bodies of every changed/deleted message (their
   * flags/labels/content may have moved), and — if anything changed — drop all list
   * pages, group counts, and label summaries (any of them could now be stale). Mailbox
   * lists are left intact (a message change never adds/removes a mailbox). This keeps
   * the cache server-authoritative: it never serves a body or list the server has
   * superseded, and it re-reads lazily via stale-while-revalidate.
   */
  applyDelta(delta: MailCacheDelta): void {
    const changed = delta.changed ?? [];
    const deleted = delta.deleted ?? [];
    for (const id of changed) this.deleteBody(id);
    for (const id of deleted) this.deleteBody(id);
    if (changed.length > 0 || deleted.length > 0) {
      this.epochCounter += 1;
      this.clearNamespace("page");
      this.clearNamespace("counts");
      this.clearNamespace("labels");
    }
  }

  /**
   * Local write bypass+invalidate. After a mutation (setRead/star/label/delete/bulk/
   * send) the cache drops the affected bodies plus all list pages, counts, and labels
   * so the next read reflects the write. Ids are optional (bulk/send may not know them).
   */
  invalidateWrite(ids: string[] = []): void {
    this.epochCounter += 1;
    for (const id of ids) this.deleteBody(id);
    this.clearNamespace("page");
    this.clearNamespace("counts");
    this.clearNamespace("labels");
  }

  clear(): void {
    this.epochCounter += 1;
    this.entries.clear();
    this.totalBytes = 0;
    this.totalMessages = 0;
    this.pageCount = 0;
  }

  stats(): MailCacheStats {
    return {
      entries: this.entries.size,
      pages: this.pageCount,
      messages: this.totalMessages,
      bytes: this.totalBytes,
    };
  }
}
