// Postgres repository for the Emails self-hosted service.
//
// Amendment A1 (PURE REMOTE): every method reads/writes the self_hosted Postgres
// directly through the product-owned storage utilities' typed query client. No cache, no
// local mirror.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { QueryResult, TypedQueryClient, PoolQueryClient } from "../../storage-kit/index.js";
import type { QueryResultRow } from "pg";
import type { SelfHostedResourceSpec, ResourceColumn } from "./resources.js";
import { DEFAULT_TENANT_ID } from "./migrations.js";

/** A live pool exposes `transaction()`; an in-memory unit-test shim does not. */
function isTransactional(client: TypedQueryClient): client is PoolQueryClient {
  return typeof (client as Partial<PoolQueryClient>).transaction === "function";
}

/**
 * Wrap a query client so EVERY operation runs inside its own short transaction
 * that first sets the `app.current_tenant` GUC (design §6 Layer 2 / adversarial
 * fixes H3, M1). This is the per-operation counterpart the Postgres Row-Level
 * Security policy (migration 0013) reads:
 *
 *   USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
 *
 * Why `set_config(..., is_local=true)` INSIDE a transaction (never a bare `SET`):
 * the value is transaction-local, so it is auto-reset on COMMIT/ROLLBACK and can
 * NEVER bleed onto the next borrower of a pooled connection (design §12 "pooled
 * SET LOCAL leakage").
 *
 * Why PER-OPERATION and not per-request (H3): `/v1/messages/send` is a deliberate
 * multi-commit, exactly-once state machine (reserve -> claim -> provider HTTP ->
 * complete). Each store call being its own transaction keeps every mutation
 * atomic AND releases the pooled connection between calls, so nothing is ever held
 * across the provider network hop (pool exhaustion / lost exactly-once on
 * rollback). It is Layer 2's belt to Layer 1's braces — the scoped store already
 * injects `tenant_id` into every query, so this adds the DB-enforced backstop.
 *
 * A non-transactional client (the hermetic in-memory test shims) is returned
 * unchanged: RLS is a Postgres construct with no meaning for an in-memory fake,
 * and the GUC round-trip would have nothing to talk to.
 */
function tenantScopedClient(client: TypedQueryClient, tenantId: string): TypedQueryClient {
  if (!isTransactional(client)) return client;
  const pool = client;
  const withTenant = <T>(fn: (tx: TypedQueryClient) => Promise<T>): Promise<T> =>
    pool.transaction(async (tx) => {
      await tx.execute(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
      return fn(tx);
    });
  return {
    query<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      return withTenant((tx) => tx.query<T>(sql, params));
    },
    many<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      return withTenant((tx) => tx.many<T>(sql, params));
    },
    get<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      return withTenant((tx) => tx.get<T>(sql, params));
    },
    one<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T> {
      return withTenant((tx) => tx.one<T>(sql, params));
    },
    execute(sql: string, params?: readonly unknown[]): Promise<void> {
      return withTenant((tx) => tx.execute(sql, params));
    },
  };
}

export interface DomainRecord {
  id: string;
  domain: string;
  status: string;
  provider: string | null;
  verified: boolean;
  notes: string | null;
  // Provisioning lifecycle state (mirrors the local domains provisioning
  // columns). Present once migration 0010 has run; optional so older/fake rows
  // still satisfy the type.
  provisioning_status?: string;
  purchase_provider?: string | null;
  dns_provider?: string;
  send_provider?: string | null;
  cf_zone_id?: string | null;
  registrar?: string | null;
  nameservers_json?: string[];
  mail_from_domain?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Writable domain provisioning fields (a PATCH may set any subset). */
export interface DomainProvisioningPatch {
  provisioning_status?: string;
  purchase_provider?: string | null;
  dns_provider?: string;
  send_provider?: string | null;
  cf_zone_id?: string | null;
  registrar?: string | null;
  nameservers_json?: string[];
  mail_from_domain?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

export interface AddressRecord {
  id: string;
  email: string;
  domain: string | null;
  display_name: string | null;
  status: string;
  verified: boolean;
  daily_quota: number | null;
  // Ownership (migration 0011). An address is owned by a human OR agent owner and
  // administered by an agent. Optional so older/fake rows still satisfy the type.
  owner_id?: string | null;
  administrator_id?: string | null;
  // Provisioning lifecycle state (mirrors the local addresses provisioning
  // columns). Present once migration 0010 has run; optional so older/fake rows
  // still satisfy the type.
  domain_id?: string | null;
  receive_strategy?: string | null;
  forward_to?: string | null;
  routing_rule_id?: string | null;
  provisioning_status?: string;
  last_validated_at?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Writable address provisioning fields (a PATCH may set any subset). */
export interface AddressProvisioningPatch {
  domain_id?: string | null;
  receive_strategy?: string | null;
  forward_to?: string | null;
  routing_rule_id?: string | null;
  provisioning_status?: string;
  last_validated_at?: string | null;
  last_error?: string | null;
  next_check_at?: string | null;
}

/** Writable address ownership fields (a PATCH may set either; null clears). */
export interface AddressOwnershipPatch {
  owner_id?: string | null;
  administrator_id?: string | null;
}

/** Non-secret projection of a scoped send key (never carries the key hash). */
export interface SendKeyRecord {
  id: string;
  owner_id: string | null;
  prefix: string | null;
  label: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  direction: string;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  status: string;
  provider_message_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  received_at: string | null;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
  headers: Record<string, unknown>;
  attachments: unknown[];
  source_id: string | null;
  idempotency_key: string | null;
  send_payload_hash: string | null;
  send_state: string;
  send_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageListRecord extends Omit<MessageRecord, "body_text" | "body_html" | "idempotency_key" | "send_payload_hash"> {
  snippet: string | null;
}

/** Fields a caller may supply when writing a message (outbound or inbound). */
export interface MessageInput {
  from_addr: string;
  to_addrs: string[];
  cc_addrs?: string[];
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  status?: string;
  provider_message_id?: string | null;
  direction?: string;
  message_id?: string | null;
  in_reply_to?: string | null;
  received_at?: string | null;
  is_read?: boolean;
  is_starred?: boolean;
  labels?: string[];
  headers?: Record<string, unknown>;
  attachments?: unknown[];
  /** Stable upstream id; when set, writes upsert on it (idempotent re-runs). */
  source_id?: string | null;
  idempotency_key?: string | null;
  send_payload_hash?: string | null;
  send_state?: string;
  send_started_at?: string | null;
}

/** Columns selected for a message row (explicit so new columns are intentional). */
const MESSAGE_COLUMNS =
  "id, direction, from_addr, to_addrs, cc_addrs, subject, body_text, body_html, status, " +
  "provider_message_id, message_id, in_reply_to, received_at, is_read, is_starred, labels, " +
  "headers, attachments, source_id, idempotency_key, send_payload_hash, send_state, send_started_at, " +
  "created_at, updated_at";

const MESSAGE_LIST_COLUMNS =
  "id, direction, from_addr, to_addrs, cc_addrs, subject, status, " +
  "provider_message_id, message_id, in_reply_to, received_at, is_read, is_starred, labels, " +
  "headers, attachments, source_id, send_state, send_started_at, created_at, updated_at, " +
  "NULLIF(left(regexp_replace(COALESCE(body_text, ''), '\\s+', ' ', 'g'), 500), '') AS snippet";

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super("idempotency key was already used for a different send payload");
    this.name = "IdempotencyKeyConflictError";
  }
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface ListMessagesOptions extends ListOptions {
  direction?: "inbound" | "outbound";
  to?: string;
  from?: string;
  subject?: string;
  search?: string;
  since?: string;
}

export interface MessageCountsRecord {
  inbox: number;
  unread: number;
  starred: number;
  sent: number;
  archived: number;
  spam: number;
  trash: number;
  total: number;
  latest_received_at: string | null;
}

export interface StoredAttachment {
  filename: string;
  content_type: string;
  size: number;
  content_base64: string;
}

/** One subject-rolled-up conversation for the threads mail-view. */
export interface ThreadRollup {
  /** Normalized (Re:/Fwd:-stripped, lowercased) subject key that groups the thread. */
  thread_key: string;
  subject: string | null;
  message_count: number;
  unread_count: number;
  last_message_at: string | null;
  first_message_at: string | null;
  participants: string[];
}

/** One mailbox (a registered address) with its inbound folder rollup. */
export interface MailboxRollup {
  id: string;
  address: string;
  display_name: string | null;
  status: string;
  total: number;
  unread: number;
}

/** Reconstructed raw MIME for a stored message. */
export interface MessageRaw {
  raw: string;
  message_id: string | null;
}

/** Assemble a minimal RFC 5322 message from a stored row (no original bytes kept). */
function buildRawMime(rec: MessageRecord): string {
  const h = rec.headers ?? {};
  const lines: string[] = [];
  const push = (name: string, value: unknown) => {
    const v = value === null || value === undefined ? "" : String(value);
    if (v.trim()) lines.push(`${name}: ${v.replace(/[\r\n]+/g, " ")}`);
  };
  push("Date", (h["Date"] as string) ?? rec.received_at ?? rec.created_at);
  push("From", (h["From"] as string) ?? rec.from_addr);
  push("To", (h["To"] as string) ?? rec.to_addrs.join(", "));
  if (rec.cc_addrs.length) push("Cc", (h["Cc"] as string) ?? rec.cc_addrs.join(", "));
  push("Subject", (h["Subject"] as string) ?? rec.subject);
  push("Message-ID", rec.message_id ?? (h["Message-ID"] as string));
  if (rec.in_reply_to) push("In-Reply-To", rec.in_reply_to);
  const isHtml = !rec.body_text && !!rec.body_html;
  push("Content-Type", isHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
  const body = rec.body_text ?? rec.body_html ?? "";
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return 100;
  return Math.min(Math.max(1, Math.floor(limit)), 500);
}

function clampOffset(offset: number | undefined): number {
  if (!offset || Number.isNaN(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/** Normalize a possibly-string JSONB column into a string[]. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return value.trim() ? [value.trim()] : [];
    }
  }
  return [];
}

/** Normalize a possibly-string JSONB array column into a plain array. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Normalize a possibly-string JSONB object column into a plain object. */
function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Normalize a TIMESTAMPTZ column (Date or string from the driver) to ISO 8601. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/** Coerce a raw DB row into a fully-typed MessageRecord (JSONB columns parsed). */
function mapMessageRow(row: Record<string, unknown>): MessageRecord {
  const attachments = toArray(row["attachments"]).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const { content_base64: _content, ...metadata } = item as Record<string, unknown>;
    return metadata;
  });
  return {
    ...(row as unknown as MessageRecord),
    to_addrs: toStringArray(row["to_addrs"]),
    cc_addrs: toStringArray(row["cc_addrs"]),
    labels: toStringArray(row["labels"]),
    attachments,
    headers: toObject(row["headers"]),
    is_read: Boolean(row["is_read"]),
    is_starred: Boolean(row["is_starred"]),
    received_at: toIso(row["received_at"]),
    send_started_at: toIso(row["send_started_at"]),
    created_at: toIso(row["created_at"]) ?? "",
    updated_at: toIso(row["updated_at"]) ?? "",
  };
}

function mapMessageListRow(row: Record<string, unknown>): MessageListRecord {
  const full = mapMessageRow({
    ...row,
    body_text: null,
    body_html: null,
    idempotency_key: null,
    send_payload_hash: null,
  });
  const { body_text: _bodyText, body_html: _bodyHtml, idempotency_key: _key, send_payload_hash: _hash, ...safe } = full;
  const rawSnippet = typeof row["snippet"] === "string"
    ? row["snippet"]
    : typeof row["body_text"] === "string"
      ? row["body_text"]
      : "";
  const snippet = rawSnippet.replace(/\s+/g, " ").trim().slice(0, 500);
  return { ...safe, snippet: snippet || null };
}

// ---- shared, tenant-agnostic query helpers (module scope) -------------------
// Extracted from the store classes so the unscoped base and the TenantScopedStore
// share ONE implementation of encoding/SQL-shaping (no duplication drift).

/** 23-column message insert list (tenant_id is appended by the scoped variant). */
const MESSAGE_INSERT_COLS =
  "id, direction, from_addr, to_addrs, cc_addrs, subject, body_text, body_html, status, " +
  "provider_message_id, message_id, in_reply_to, received_at, is_read, is_starred, labels, " +
  "headers, attachments, source_id, idempotency_key, send_payload_hash, send_state, send_started_at";

const MESSAGE_INSERT_VALUES =
  "$1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, " +
  "$16::jsonb, $17::jsonb, $18::jsonb, $19, $20, $21, $22, $23";

/** Positional insert params (23) shared by createMessage/upsertMessage/reserveSendIntent. */
function messageInsertParams(input: MessageInput): unknown[] {
  return [
    randomUUID(),
    (input.direction ?? "outbound").trim() || "outbound",
    input.from_addr.trim(),
    JSON.stringify(input.to_addrs ?? []),
    JSON.stringify(input.cc_addrs ?? []),
    input.subject ?? null,
    input.body_text ?? null,
    input.body_html ?? null,
    input.status ?? "queued",
    input.provider_message_id ?? null,
    input.message_id ?? null,
    input.in_reply_to ?? null,
    input.received_at ?? null,
    input.is_read ?? false,
    input.is_starred ?? false,
    JSON.stringify(input.labels ?? []),
    JSON.stringify(input.headers ?? {}),
    JSON.stringify(input.attachments ?? []),
    input.source_id ?? null,
    input.idempotency_key ?? null,
    input.send_payload_hash ?? null,
    input.send_state ?? "none",
    input.send_started_at ?? null,
  ];
}

function hashSendToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Extract the bare, lowercased address from a From value (drops display name). */
function canonicalAddress(from: string): string {
  const value = from.trim();
  const angled = value.match(/<([^>]+)>/);
  const bare = (angled ? angled[1]! : value).trim().toLowerCase();
  return bare.includes("@") ? bare : "";
}

/** Coerce/encode a request value for a generic-resource column per its kind. */
function encodeColumn(col: ResourceColumn, value: unknown): unknown {
  if (value === undefined) return null;
  if (col.json) return JSON.stringify(value ?? null);
  if (col.bool) return Boolean(value);
  if (col.int) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (col.num) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return value ?? null;
}

/** Primary-key column for a spec (a server-minted `id` unless overridden). */
function keyColumn(spec: SelfHostedResourceSpec): string {
  return spec.idColumn ?? "id";
}

/**
 * Strip a spec's `redactColumns` from a returned row IN PLACE. The generic read
 * path is `SELECT *`, so a legacy/secret column the physical table happens to
 * carry (e.g. the drifted `send_keys.key_hash`) would otherwise leak into the API
 * response. A no-op for every resource that declares no redactColumns.
 */
function redactResourceRow<T extends Record<string, unknown> | null>(
  spec: SelfHostedResourceSpec,
  row: T,
): T {
  if (!row || !spec.redactColumns?.length) return row;
  for (const col of spec.redactColumns) {
    if (col in row) delete (row as Record<string, unknown>)[col];
  }
  return row;
}

/**
 * Raised when a request body references, by id, a row that belongs to a DIFFERENT
 * tenant (design adversarial fix M4). Stamping `tenant_id` on the new row does
 * NOT stop a cross-tenant FK reference, so the scoped store rejects it before the
 * insert. The service maps this to a 404 (the id "does not exist" for this
 * tenant — no cross-tenant existence is revealed).
 */
export class CrossTenantReferenceError extends Error {
  constructor(public readonly column: string) {
    super(`referenced ${column} does not belong to this tenant`);
    this.name = "CrossTenantReferenceError";
  }
}

/**
 * Unscoped root store. Holds ONLY `forTenant()` plus the transitional
 * background-worker methods (design §6 Layer 1). It deliberately exposes NO
 * tenant-scoped data CRUD: a request handler is only ever handed a
 * {@link TenantScopedStore}, so forgetting the tenant is a COMPILE error rather
 * than a silent cross-tenant leak.
 */
export class EmailsSelfHostedStore {
  constructor(private readonly client: TypedQueryClient) {}

  /**
   * Enter a tenant scope. Every data-CRUD method lives on the returned type and
   * injects `tenant_id` into every read/write (Layer 1, the primary isolation
   * guarantee — design §6). This is the ONLY way a handler reaches tenant data.
   */
  forTenant(tenantId: string): TenantScopedStore {
    if (!tenantId) throw new Error("forTenant requires a tenant id");
    // Hand the scoped store a client that sets `app.current_tenant` per operation
    // (Layer 2 RLS backstop). Layer 1 (the AND tenant_id = $tenant in every query)
    // still holds unconditionally; this makes forgetting it a DB-enforced failure.
    return new TenantScopedStore(tenantScopedClient(this.client, tenantId), tenantId);
  }

  // ---- transitional background-worker methods (design §6 x-cut #1 / §10) ----
  //
  // The SES-inbound ingest worker arrives with an event that carries NO
  // credential and therefore no tenant yet (that is finding C1, resolved in
  // P4/WI-4a by envelope-recipient routing through `inbound_domain_routes`).
  // Until then these two UNTENANTED writes rely on the transitional `tenant_id`
  // DEFAULT that migration 0012 adds (every row lands in the default tenant, no
  // crash, no data loss). They are the ONLY data methods on the unscoped base;
  // ALL credentialed /v1 traffic goes through forTenant(). These two run in the
  // DEFAULT tenant: the inbound event carries no credential, so until the C1
  // envelope-recipient routing lands (WI-4a), every inbound message keeps landing
  // in the default tenant (via the transitional tenant_id DEFAULT that 0012 added
  // and 0013 KEEPS). Setting the GUC to the default tenant is what makes these
  // writes pass the RLS policy that 0013 enables, and the ON CONFLICT target is the
  // per-tenant composite (the legacy single-column uniques are dropped in 0013).

  /** The default-tenant scoping client for the untenanted worker paths. */
  private workerClient(): TypedQueryClient {
    return tenantScopedClient(this.client, DEFAULT_TENANT_ID);
  }

  /** Worker dedup: match an existing message by stable upstream key (default tenant). */
  async findMessageIdByKey(key: string): Promise<string | null> {
    if (!key) return null;
    const row = await this.workerClient().get<{ id: string }>(
      `SELECT id FROM messages WHERE source_id = $1 OR message_id = $1 LIMIT 1`,
      [key],
    );
    return row ? row.id : null;
  }

  /** Worker idempotent inbound write keyed on source_id (default tenant). */
  async upsertMessage(input: MessageInput): Promise<{ record: MessageRecord; inserted: boolean }> {
    if (!input.source_id) throw new Error("upsertMessage requires a source_id");
    const row = await this.workerClient().one<Record<string, unknown>>(
      `INSERT INTO messages (${MESSAGE_INSERT_COLS})
       VALUES (${MESSAGE_INSERT_VALUES})
       ON CONFLICT (tenant_id, source_id) WHERE source_id IS NOT NULL DO UPDATE SET
         ${MESSAGE_UPSERT_ASSIGNMENTS}
       RETURNING ${MESSAGE_COLUMNS}, (xmax = 0) AS inserted`,
      messageInsertParams(input),
    );
    return { record: mapMessageRow(row), inserted: Boolean(row["inserted"]) };
  }
}

/** The EXCLUDED assignment list shared by both upsertMessage variants. */
const MESSAGE_UPSERT_ASSIGNMENTS =
  `direction           = EXCLUDED.direction,
   from_addr           = EXCLUDED.from_addr,
   to_addrs            = EXCLUDED.to_addrs,
   cc_addrs            = EXCLUDED.cc_addrs,
   subject             = EXCLUDED.subject,
   body_text           = EXCLUDED.body_text,
   body_html           = EXCLUDED.body_html,
   status              = EXCLUDED.status,
   provider_message_id = EXCLUDED.provider_message_id,
   message_id          = EXCLUDED.message_id,
   in_reply_to         = EXCLUDED.in_reply_to,
   received_at         = EXCLUDED.received_at,
   is_read             = EXCLUDED.is_read,
   is_starred          = EXCLUDED.is_starred,
   labels              = EXCLUDED.labels,
   headers             = EXCLUDED.headers,
   attachments         = EXCLUDED.attachments,
   updated_at          = now()`;

/**
 * A store already bound to a single `tenantId`. EVERY method injects the tenant:
 * reads gain `AND tenant_id = $tenant`, writes stamp it, and cross-tenant id
 * references (M4) are rejected while RLS is off/bypassed (see assertNotOtherTenant
 * for the Layer-1/Layer-2 handoff). This is design §6 Layer 1 — the isolation that
 * holds unconditionally (no RLS dependency). Obtain one via `store.forTenant()`,
 * which also binds a per-operation `app.current_tenant` GUC for the Layer-2 RLS
 * backstop (migration 0013).
 */
/**
 * A fully-formed message id (a bare UUID, the shape `messages.id` is generated as).
 * A value that matches is used verbatim; anything shorter is treated as a PREFIX
 * to resolve (the 8-char short id `inbox list` prints).
 */
const FULL_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantScopedStore {
  constructor(
    private readonly client: TypedQueryClient,
    private readonly tenantId: string,
  ) {}

  /**
   * Reject a body-supplied FK id that resolves to a row in ANOTHER tenant
   * (design M4). Semantics: if the referenced row does not exist ANYWHERE we
   * ALLOW it (the schema deliberately permits dangling/denormalized refs such as
   * a free-text `provider_id="ses"` slug); we reject ONLY when the id names a real
   * row owned by a different tenant — precisely the cross-tenant hole, without
   * breaking loose references.
   *
   * TWO-LAYER HANDOFF (important): this is a Layer-1 (application) control and is
   * ACTIVE whenever RLS is off or bypassed — i.e. exactly when Layer 1 is the sole
   * guarantee (pre-0013, or a misconfigured DB). Under enforced FORCE RLS (Layer 2,
   * the prod posture), the probe below runs with the caller's `app.current_tenant`
   * GUC set, so the RLS policy makes a foreign-tenant row INVISIBLE — this check
   * then cannot fire. That is not a leak: RLS supersedes M4 here. A cross-tenant FK
   * value can no longer create a cross-tenant *reference* — the new row is stamped
   * (and WITH CHECK-verified) with the CALLER's tenant, and every read that would
   * dereference the id is itself RLS-scoped, so no other-tenant data is ever
   * exposed; the id simply becomes a harmless same-tenant dangling reference. (The
   * probe cannot be made to see across tenants without a BYPASSRLS role, which we
   * deliberately do not have — see serve.ts:assertServingRoleCannotBypassRls.) The
   * observable change under RLS is only 404→201 for such a body; isolation is
   * unaffected and is proven at the DB layer in rls.integration.test.ts.
   */
  private async assertNotOtherTenant(
    table: string,
    id: unknown,
    column: string,
    idColumn = "id",
  ): Promise<void> {
    if (id === undefined || id === null || id === "") return;
    const row = await this.client.get<{ tenant_id: string }>(
      `SELECT tenant_id FROM ${table} WHERE ${idColumn} = $1`,
      [String(id)],
    );
    if (row && row.tenant_id !== this.tenantId) throw new CrossTenantReferenceError(column);
  }

  // ---- domains ------------------------------------------------------------
  async listDomains(opts: ListOptions = {}): Promise<DomainRecord[]> {
    return this.client.many<DomainRecord>(
      `SELECT * FROM domains WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [this.tenantId, clampLimit(opts.limit), clampOffset(opts.offset)],
    );
  }

  async getDomain(id: string): Promise<DomainRecord | null> {
    return this.client.get<DomainRecord>(`SELECT * FROM domains WHERE id = $1 AND tenant_id = $2`, [
      id,
      this.tenantId,
    ]);
  }

  /**
   * Look up a domain by name WITHIN the tenant (design M3 leak point): the POST
   * 409 pre-check must be tenant-scoped, or it both leaks another tenant's domain
   * and wrongly blocks per-tenant registration of the same name.
   */
  async getDomainByName(domain: string): Promise<DomainRecord | null> {
    return this.client.get<DomainRecord>(`SELECT * FROM domains WHERE domain = $1 AND tenant_id = $2`, [
      domain.trim().toLowerCase(),
      this.tenantId,
    ]);
  }

  async createDomain(input: {
    domain: string;
    status?: string;
    provider?: string | null;
    verified?: boolean;
    notes?: string | null;
  }): Promise<DomainRecord> {
    const id = randomUUID();
    return this.client.one<DomainRecord>(
      `INSERT INTO domains (id, domain, status, provider, verified, notes, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.domain.trim().toLowerCase(),
        input.status ?? "pending",
        input.provider ?? null,
        input.verified ?? false,
        input.notes ?? null,
        this.tenantId,
      ],
    );
  }

  async updateDomain(
    id: string,
    patch: { status?: string; provider?: string | null; verified?: boolean; notes?: string | null },
  ): Promise<DomainRecord | null> {
    return this.client.get<DomainRecord>(
      `UPDATE domains SET
         status   = COALESCE($2, status),
         provider = COALESCE($3, provider),
         verified = COALESCE($4, verified),
         notes    = COALESCE($5, notes),
         updated_at = now()
       WHERE id = $1 AND tenant_id = $6
       RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.provider ?? null,
        patch.verified ?? null,
        patch.notes ?? null,
        this.tenantId,
      ],
    );
  }

  async deleteDomain(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM domains WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, this.tenantId],
    );
    return rows.length > 0;
  }

  /**
   * Apply a subset of domain provisioning fields (migration 0010 columns). Only
   * keys PRESENT in `patch` are written, so a null is an explicit clear while an
   * absent key is left untouched. `nameservers_json` is a JSONB array.
   */
  async applyDomainProvisioning(id: string, patch: DomainProvisioningPatch): Promise<DomainRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [id, this.tenantId];
    const set = (name: string, value: unknown, jsonb = false) => {
      params.push(jsonb ? JSON.stringify(value ?? null) : value ?? null);
      sets.push(jsonb ? `${name} = $${params.length}::jsonb` : `${name} = $${params.length}`);
    };
    if ("provisioning_status" in patch) set("provisioning_status", patch.provisioning_status);
    if ("purchase_provider" in patch) set("purchase_provider", patch.purchase_provider);
    if ("dns_provider" in patch) set("dns_provider", patch.dns_provider);
    if ("send_provider" in patch) set("send_provider", patch.send_provider);
    if ("cf_zone_id" in patch) set("cf_zone_id", patch.cf_zone_id);
    if ("registrar" in patch) set("registrar", patch.registrar);
    if ("nameservers_json" in patch) set("nameservers_json", patch.nameservers_json ?? [], true);
    if ("mail_from_domain" in patch) set("mail_from_domain", patch.mail_from_domain);
    if ("last_error" in patch) set("last_error", patch.last_error);
    if ("next_check_at" in patch) set("next_check_at", patch.next_check_at);
    if (sets.length === 0) return this.getDomain(id);
    sets.push("updated_at = now()");
    return this.client.get<DomainRecord>(
      `UPDATE domains SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params,
    );
  }

  // ---- addresses ----------------------------------------------------------
  async listAddresses(opts: ListOptions = {}): Promise<AddressRecord[]> {
    return this.client.many<AddressRecord>(
      `SELECT * FROM addresses WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [this.tenantId, clampLimit(opts.limit), clampOffset(opts.offset)],
    );
  }

  async getAddress(id: string): Promise<AddressRecord | null> {
    return this.client.get<AddressRecord>(`SELECT * FROM addresses WHERE id = $1 AND tenant_id = $2`, [
      id,
      this.tenantId,
    ]);
  }

  async createAddress(input: {
    email: string;
    display_name?: string | null;
    status?: string;
    verified?: boolean;
    daily_quota?: number | null;
  }): Promise<AddressRecord> {
    const id = randomUUID();
    const email = input.email.trim().toLowerCase();
    const domain = email.includes("@") ? email.slice(email.indexOf("@") + 1) : null;
    return this.client.one<AddressRecord>(
      `INSERT INTO addresses (id, email, domain, display_name, status, verified, daily_quota, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, email, domain, input.display_name ?? null, input.status ?? "active", input.verified ?? false, input.daily_quota ?? null, this.tenantId],
    );
  }

  async updateAddress(
    id: string,
    // `dailyQuotaSet` distinguishes "not provided" (keep existing) from an
    // explicit clear (`daily_quota: null`, the CLI's `quota <id> none`). COALESCE
    // alone cannot clear a column to NULL, so quota uses a CASE gated on the flag.
    patch: {
      display_name?: string | null;
      status?: string;
      verified?: boolean;
      dailyQuotaSet?: boolean;
      daily_quota?: number | null;
    },
  ): Promise<AddressRecord | null> {
    return this.client.get<AddressRecord>(
      `UPDATE addresses SET
         display_name = COALESCE($2, display_name),
         status       = COALESCE($3, status),
         verified     = COALESCE($4, verified),
         daily_quota  = CASE WHEN $5 THEN $6 ELSE daily_quota END,
         updated_at   = now()
       WHERE id = $1 AND tenant_id = $7
       RETURNING *`,
      [
        id,
        patch.display_name ?? null,
        patch.status ?? null,
        patch.verified ?? null,
        patch.dailyQuotaSet ?? false,
        patch.dailyQuotaSet ? patch.daily_quota ?? null : null,
        this.tenantId,
      ],
    );
  }

  async deleteAddress(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM addresses WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, this.tenantId],
    );
    return rows.length > 0;
  }

  /**
   * Apply a subset of address provisioning fields (migration 0010 columns).
   * Only keys PRESENT in `patch` are written (null clears, absent leaves as-is).
   */
  async applyAddressProvisioning(id: string, patch: AddressProvisioningPatch): Promise<AddressRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [id, this.tenantId];
    const set = (name: string, value: unknown) => {
      params.push(value ?? null);
      sets.push(`${name} = $${params.length}`);
    };
    if ("domain_id" in patch) set("domain_id", patch.domain_id);
    if ("receive_strategy" in patch) set("receive_strategy", patch.receive_strategy);
    if ("forward_to" in patch) set("forward_to", patch.forward_to);
    if ("routing_rule_id" in patch) set("routing_rule_id", patch.routing_rule_id);
    if ("provisioning_status" in patch) set("provisioning_status", patch.provisioning_status);
    if ("last_validated_at" in patch) set("last_validated_at", patch.last_validated_at);
    if ("last_error" in patch) set("last_error", patch.last_error);
    if ("next_check_at" in patch) set("next_check_at", patch.next_check_at);
    if (sets.length === 0) return this.getAddress(id);
    sets.push("updated_at = now()");
    return this.client.get<AddressRecord>(
      `UPDATE addresses SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params,
    );
  }

  /**
   * Apply address ownership fields (migration 0011). Only keys PRESENT in
   * `patch` are written, so `null` explicitly clears (the client's unassign) while
   * an absent key is left untouched. Owner/administrator ids that reference another
   * tenant's owner are rejected (M4).
   */
  async applyAddressOwnership(id: string, patch: AddressOwnershipPatch): Promise<AddressRecord | null> {
    if ("owner_id" in patch) await this.assertNotOtherTenant("owners", patch.owner_id, "owner_id");
    if ("administrator_id" in patch) await this.assertNotOtherTenant("owners", patch.administrator_id, "administrator_id");
    const sets: string[] = [];
    const params: unknown[] = [id, this.tenantId];
    const set = (name: string, value: unknown) => {
      params.push(value ?? null);
      sets.push(`${name} = $${params.length}`);
    };
    if ("owner_id" in patch) set("owner_id", patch.owner_id);
    if ("administrator_id" in patch) set("administrator_id", patch.administrator_id);
    if (sets.length === 0) return this.getAddress(id);
    sets.push("updated_at = now()");
    return this.client.get<AddressRecord>(
      `UPDATE addresses SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params,
    );
  }

  // ---- messages (outbound ledger + inbound mail) -------------------------
  //
  // Ordering is by original receipt time when known, else insertion time, so an
  // imported inbox reads in true chronological order rather than import order.
  async listMessages(opts: ListMessagesOptions = {}): Promise<MessageListRecord[]> {
    const where: string[] = ["tenant_id = $1"];
    const params: unknown[] = [this.tenantId];
    if (opts.direction === "inbound") where.push(`lower(COALESCE(direction, '')) <> 'outbound'`);
    if (opts.direction === "outbound") where.push(`lower(COALESCE(direction, '')) = 'outbound'`);
    if (opts.to?.trim()) {
      params.push(`%${opts.to.trim().toLowerCase()}%`);
      where.push(`lower(to_addrs::text) LIKE $${params.length}`);
    }
    if (opts.from?.trim()) {
      params.push(`%${opts.from.trim().toLowerCase()}%`);
      where.push(`lower(COALESCE(from_addr, '')) LIKE $${params.length}`);
    }
    if (opts.subject?.trim()) {
      params.push(`%${opts.subject.trim().toLowerCase()}%`);
      where.push(`lower(COALESCE(subject, '')) LIKE $${params.length}`);
    }
    if (opts.search?.trim()) {
      params.push(`%${opts.search.trim().toLowerCase()}%`);
      where.push(`lower(concat_ws(' ', COALESCE(from_addr, ''), COALESCE(to_addrs::text, ''), COALESCE(subject, ''), COALESCE(body_text, ''))) LIKE $${params.length}`);
    }
    if (opts.since?.trim()) {
      params.push(opts.since.trim());
      where.push(`COALESCE(received_at, created_at) >= $${params.length}::timestamptz`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    params.push(clampLimit(opts.limit));
    const limitIndex = params.length;
    params.push(clampOffset(opts.offset));
    const offsetIndex = params.length;
    const rows = await this.client.many<Record<string, unknown>>(
      `SELECT ${MESSAGE_LIST_COLUMNS} FROM messages ${whereSql}
       ORDER BY COALESCE(received_at, created_at) DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return rows.map(mapMessageListRow);
  }

  async messageCounts(): Promise<MessageCountsRecord> {
    const row = await this.client.get<Record<string, unknown>>(
      `WITH m AS (
         SELECT
           (lower(COALESCE(direction, '')) = 'outbound') AS is_out,
           (labels @> '["archived"]'::jsonb) AS is_arch,
           (labels @> '["spam"]'::jsonb OR lower(COALESCE(status, '')) = 'spam') AS is_spam,
           (labels @> '["trash"]'::jsonb) AS is_trash,
           is_read, is_starred, COALESCE(received_at, created_at) AS ts
         FROM messages
         WHERE tenant_id = $1
       )
       SELECT
         count(*) FILTER (WHERE is_out) AS sent,
         count(*) FILTER (WHERE NOT is_out AND NOT is_arch AND NOT is_spam AND NOT is_trash) AS inbox,
         count(*) FILTER (WHERE NOT is_out AND NOT is_arch AND NOT is_spam AND NOT is_trash AND NOT is_read) AS unread,
         count(*) FILTER (WHERE NOT is_out AND is_starred AND NOT is_arch AND NOT is_spam AND NOT is_trash) AS starred,
         count(*) FILTER (WHERE NOT is_out AND is_arch AND NOT is_spam AND NOT is_trash) AS archived,
         count(*) FILTER (WHERE NOT is_out AND is_spam) AS spam,
         count(*) FILTER (WHERE NOT is_out AND is_trash) AS trash,
         count(*) AS total,
         max(ts) FILTER (WHERE NOT is_out) AS latest_received_at
       FROM m`,
      [this.tenantId],
    );
    const number = (value: unknown): number => {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const latest = row?.["latest_received_at"];
    return {
      inbox: number(row?.["inbox"]), unread: number(row?.["unread"]), starred: number(row?.["starred"]),
      sent: number(row?.["sent"]), archived: number(row?.["archived"]), spam: number(row?.["spam"]),
      trash: number(row?.["trash"]), total: number(row?.["total"]),
      latest_received_at: latest instanceof Date ? latest.toISOString() : latest ? String(latest) : null,
    };
  }

  /**
   * Resolve a full message id OR a unique id PREFIX (the short id `inbox list`
   * prints) to a full row id, tenant-scoped. A full UUID is returned verbatim with
   * NO DB round-trip, so exact-id behavior is unchanged (a non-existent full id
   * still 404s downstream when the row is fetched). Otherwise the prefix is matched
   * against the indexed `(id)::text` expression (migration 0014, text_pattern_ops)
   * WITHIN the tenant (Layer-1 `tenant_id` filter + Layer-2 RLS via the scoped
   * client): 0 rows -> null (not found), exactly 1 -> `{ id }`, 2+ ->
   * `{ ambiguous: true }`. `LIMIT 2` is enough to distinguish unique from ambiguous.
   */
  async resolveMessageId(idOrPrefix: string): Promise<{ id: string } | { ambiguous: true } | null> {
    const value = idOrPrefix.trim();
    if (!value) return null;
    if (FULL_MESSAGE_ID_RE.test(value)) return { id: value };
    // Escape LIKE metacharacters (% _ \) so the prefix stays an anchored,
    // index-served range scan: an unescaped % / _ would otherwise broaden the
    // match within the tenant, and a leading wildcard would force a non-indexable
    // scan (adversarial review). Escaping — not a hex-charset reject — keeps
    // legacy non-UUID message ids (e.g. "legacy-import-…") resolvable by prefix.
    const likePrefix = value.replace(/[\\%_]/g, "\\$&");
    const rows = await this.client.many<{ id: string }>(
      `SELECT id FROM messages WHERE (id)::text LIKE $1 || '%' ESCAPE '\\' AND tenant_id = $2 ORDER BY id LIMIT 2`,
      [likePrefix, this.tenantId],
    );
    if (rows.length === 0) return null;
    if (rows.length > 1) return { ambiguous: true };
    return { id: rows[0]!.id };
  }

  async getMessage(id: string): Promise<MessageRecord | null> {
    const row = await this.client.get<Record<string, unknown>>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1 AND tenant_id = $2`,
      [id, this.tenantId],
    );
    return row ? mapMessageRow(row) : null;
  }

  async getMessageAttachment(id: string, index: number): Promise<StoredAttachment | null> {
    if (!Number.isInteger(index) || index < 0) return null;
    const row = await this.client.get<{ attachment: unknown }>(
      `SELECT attachments -> $2::int AS attachment FROM messages WHERE id = $1 AND tenant_id = $3`,
      [id, index, this.tenantId],
    );
    const value = row?.attachment;
    let attachment: unknown;
    try { attachment = typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return null;
    const record = attachment as Record<string, unknown>;
    if (typeof record["content_base64"] !== "string") return null;
    return {
      filename: String(record["filename"] ?? `attachment-${index + 1}`),
      content_type: String(record["content_type"] ?? "application/octet-stream"),
      size: Number(record["size"] ?? 0) || 0,
      content_base64: record["content_base64"],
    };
  }

  /**
   * Look up an existing message by a stable upstream key (source_id OR message_id)
   * WITHIN the tenant (design M3 leak point). Returns the row id, or null.
   */
  async findMessageIdByKey(key: string): Promise<string | null> {
    if (!key) return null;
    const row = await this.client.get<{ id: string }>(
      `SELECT id FROM messages WHERE (source_id = $1 OR message_id = $1) AND tenant_id = $2 LIMIT 1`,
      [key, this.tenantId],
    );
    return row ? row.id : null;
  }

  async createMessage(input: MessageInput): Promise<MessageRecord> {
    const row = await this.client.one<Record<string, unknown>>(
      `INSERT INTO messages (${MESSAGE_INSERT_COLS}, tenant_id)
       VALUES (${MESSAGE_INSERT_VALUES}, $24)
       RETURNING ${MESSAGE_COLUMNS}`,
      [...messageInsertParams(input), this.tenantId],
    );
    return mapMessageRow(row);
  }

  /**
   * Persist a unique outbound intent before any provider side effect. Conflict
   * target + fallback select are tenant-scoped (`(tenant_id, idempotency_key)`),
   * so two tenants never observe each other's send-intent replay (design M3).
   */
  async reserveSendIntent(
    input: MessageInput & { idempotency_key: string; send_payload_hash: string },
  ): Promise<{ record: MessageRecord; created: boolean }> {
    const inserted = await this.client.get<Record<string, unknown>>(
      `INSERT INTO messages (${MESSAGE_INSERT_COLS}, tenant_id)
       VALUES (${MESSAGE_INSERT_VALUES}, $24)
       ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${MESSAGE_COLUMNS}`,
      [...messageInsertParams({ ...input, direction: "outbound", status: "queued", send_state: "pending" }), this.tenantId],
    );
    if (inserted) return { record: mapMessageRow(inserted), created: true };
    const existing = await this.client.get<Record<string, unknown>>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE idempotency_key = $1 AND tenant_id = $2`,
      [input.idempotency_key, this.tenantId],
    );
    if (!existing) throw new Error("send intent conflict could not be reconciled");
    const record = mapMessageRow(existing);
    if (record.send_payload_hash !== input.send_payload_hash) throw new IdempotencyKeyConflictError();
    return { record, created: false };
  }

  async claimSendIntent(id: string): Promise<MessageRecord | null> {
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET send_state = 'sending', send_started_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND send_state = 'pending'
       RETURNING ${MESSAGE_COLUMNS}`,
      [id, this.tenantId],
    );
    return row ? mapMessageRow(row) : null;
  }

  async completeSendIntent(id: string, providerMessageId: string): Promise<MessageRecord> {
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET send_state = 'sent', status = 'sent', provider_message_id = $2, updated_at = now()
       WHERE id = $1 AND tenant_id = $3 RETURNING ${MESSAGE_COLUMNS}`,
      [id, providerMessageId, this.tenantId],
    );
    if (!row) throw new Error("send intent disappeared during completion");
    return mapMessageRow(row);
  }

  async markSendUncertain(id: string): Promise<MessageRecord | null> {
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET send_state = 'uncertain', status = 'uncertain', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND send_state <> 'sent'
       RETURNING ${MESSAGE_COLUMNS}`,
      [id, this.tenantId],
    );
    return row ? mapMessageRow(row) : null;
  }

  /**
   * Idempotent write keyed on `(tenant_id, source_id)`: inserts a new row, or
   * updates the existing row with the same source_id within this tenant (so
   * re-running an import never duplicates and never touches another tenant's row).
   */
  async upsertMessage(input: MessageInput): Promise<{ record: MessageRecord; inserted: boolean }> {
    if (!input.source_id) {
      throw new Error("upsertMessage requires a source_id");
    }
    const row = await this.client.one<Record<string, unknown>>(
      `INSERT INTO messages (${MESSAGE_INSERT_COLS}, tenant_id)
       VALUES (${MESSAGE_INSERT_VALUES}, $24)
       ON CONFLICT (tenant_id, source_id) WHERE source_id IS NOT NULL DO UPDATE SET
         ${MESSAGE_UPSERT_ASSIGNMENTS}
       RETURNING ${MESSAGE_COLUMNS}, (xmax = 0) AS inserted`,
      [...messageInsertParams(input), this.tenantId],
    );
    const inserted = Boolean(row["inserted"]);
    return { record: mapMessageRow(row), inserted };
  }

  async updateMessageStatus(
    id: string,
    patch: {
      status?: string;
      provider_message_id?: string | null;
      is_read?: boolean;
      is_starred?: boolean;
      archived?: boolean;
      add_label?: string;
      remove_label?: string;
    },
  ): Promise<MessageRecord | null> {
    const current = await this.getMessage(id);
    if (!current) return null;
    const labels = new Map(current.labels.map((label) => [label.toLowerCase(), label]));
    if (patch.archived === true) labels.set("archived", "archived");
    if (patch.archived === false) labels.delete("archived");
    if (patch.add_label?.trim()) labels.set(patch.add_label.trim().toLowerCase(), patch.add_label.trim());
    if (patch.remove_label?.trim()) labels.delete(patch.remove_label.trim().toLowerCase());
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET
         status              = COALESCE($2, status),
         provider_message_id = COALESCE($3, provider_message_id),
         is_read             = COALESCE($4, is_read),
         is_starred          = COALESCE($5, is_starred),
         labels              = $6::jsonb,
         updated_at          = now()
       WHERE id = $1 AND tenant_id = $7
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        id,
        patch.status ?? null,
        patch.provider_message_id ?? null,
        patch.is_read ?? null,
        patch.is_starred ?? null,
        JSON.stringify([...labels.values()]),
        this.tenantId,
      ],
    );
    return row ? mapMessageRow(row) : null;
  }

  async deleteMessage(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM messages WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, this.tenantId],
    );
    return rows.length > 0;
  }

  // ---- mail-views (threads / mailboxes / raw) ----------------------------
  //
  // The self-hosted `messages` table is a single unified inbound+outbound
  // ledger, so these are read-only rollups over it (not simple CRUD). Threads
  // are grouped by a normalized (Re:/Fwd:-stripped) subject key — the server
  // keeps no thread_id column. Every rollup filters by tenant (design M3).

  /** Subject-rolled-up conversation list, newest activity first. */
  async listThreads(opts: ListOptions = {}): Promise<ThreadRollup[]> {
    const rows = await this.client.many<Record<string, unknown>>(
      `WITH t AS (
         SELECT
           NULLIF(btrim(regexp_replace(lower(COALESCE(subject, '')), '^(\\s*(re|fwd|fw)\\s*:\\s*)+', '', 'g')), '') AS thread_key,
           subject, from_addr, is_read, direction,
           COALESCE(received_at, created_at) AS ts
         FROM messages
         WHERE tenant_id = $1
       )
       SELECT
         COALESCE(thread_key, '(no subject)') AS thread_key,
         max(subject) AS subject,
         count(*) AS message_count,
         count(*) FILTER (WHERE is_read = false AND lower(COALESCE(direction, '')) <> 'outbound') AS unread_count,
         max(ts) AS last_message_at,
         min(ts) AS first_message_at,
         array_agg(DISTINCT from_addr) AS participants
       FROM t
       GROUP BY COALESCE(thread_key, '(no subject)')
       ORDER BY max(ts) DESC
       LIMIT $2 OFFSET $3`,
      [this.tenantId, clampLimit(opts.limit), clampOffset(opts.offset)],
    );
    const num = (v: unknown): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return rows.map((row) => ({
      thread_key: String(row["thread_key"] ?? ""),
      subject: row["subject"] === null || row["subject"] === undefined ? null : String(row["subject"]),
      message_count: num(row["message_count"]),
      unread_count: num(row["unread_count"]),
      last_message_at: toIso(row["last_message_at"]),
      first_message_at: toIso(row["first_message_at"]),
      participants: toStringArray(row["participants"]),
    }));
  }

  /**
   * Registered addresses as mailboxes, each with an inbound folder rollup, plus
   * the global folder counts. Both the address list AND the joined message counts
   * are tenant-scoped (design M3), so a mailbox never counts another tenant's mail.
   */
  async listMailboxes(): Promise<{ mailboxes: MailboxRollup[]; counts: MessageCountsRecord }> {
    const rows = await this.client.many<Record<string, unknown>>(
      `SELECT
         a.id AS id,
         a.email AS address,
         a.display_name AS display_name,
         a.status AS status,
         count(m.id) AS total,
         count(m.id) FILTER (WHERE m.is_read = false) AS unread
       FROM addresses a
       LEFT JOIN messages m
         ON lower(COALESCE(m.direction, '')) <> 'outbound'
        AND m.tenant_id = a.tenant_id
        AND lower(m.to_addrs::text) LIKE '%' || lower(a.email) || '%'
       WHERE a.tenant_id = $1
       GROUP BY a.id, a.email, a.display_name, a.status
       ORDER BY a.email ASC`,
      [this.tenantId],
    );
    const num = (v: unknown): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const mailboxes: MailboxRollup[] = rows.map((row) => ({
      id: String(row["id"] ?? ""),
      address: String(row["address"] ?? ""),
      display_name: row["display_name"] === null || row["display_name"] === undefined ? null : String(row["display_name"]),
      status: String(row["status"] ?? ""),
      total: num(row["total"]),
      unread: num(row["unread"]),
    }));
    const counts = await this.messageCounts();
    return { mailboxes, counts };
  }

  /** Reconstruct a minimal raw MIME representation for a stored message. */
  async getMessageRaw(id: string): Promise<MessageRaw | null> {
    const rec = await this.getMessage(id);
    if (!rec) return null;
    return { raw: buildRawMime(rec), message_id: rec.message_id };
  }

  // ---- generic resources (contacts/providers/templates/groups/…) ----------
  //
  // Table + column names come from the trusted SELF_HOSTED_RESOURCES registry (never
  // user input); all VALUES are bound parameters. Every query filters/stamps
  // `tenant_id` (Layer 1 across all 24 registry resources at one chokepoint).

  async listResource(
    spec: SelfHostedResourceSpec,
    opts: ListOptions & { filters?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [this.tenantId];
    const where: string[] = ["tenant_id = $1"];
    for (const key of spec.filters ?? []) {
      const raw = opts.filters?.[key];
      if (raw === undefined) continue;
      const col = spec.columns.find((c) => c.name === key);
      params.push(encodeColumn(col ?? { name: key }, raw));
      where.push(`${key} = $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    params.push(clampLimit(opts.limit), clampOffset(opts.offset));
    const rows = await this.client.many<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} ${whereSql} ORDER BY ${spec.orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((row) => redactResourceRow(spec, row));
  }

  async getResource(spec: SelfHostedResourceSpec, id: string): Promise<Record<string, unknown> | null> {
    const key = keyColumn(spec);
    const row = await this.client.get<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} WHERE ${key} = $1 AND tenant_id = $2`,
      [id, this.tenantId],
    );
    return redactResourceRow(spec, row);
  }

  async createResource(spec: SelfHostedResourceSpec, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // M4: a body-supplied FK id must not reference another tenant's row.
    for (const fk of spec.foreignKeys ?? []) {
      await this.assertNotOtherTenant(fk.table, body[fk.column], fk.column, fk.idColumn ?? "id");
    }
    const key = keyColumn(spec);
    const cols: string[] = [];
    const placeholders: string[] = [];
    const params: unknown[] = [];
    // A UUID-keyed resource mints its own `id`. A natural-key resource (idColumn
    // set) takes the key value from the body — it is not server-generated.
    if (spec.idColumn === undefined) {
      params.push(randomUUID());
      cols.push("id");
      placeholders.push("$1");
    }
    // tenant_id is always stamped from the caller's scope, never from the body.
    params.push(this.tenantId);
    cols.push("tenant_id");
    placeholders.push(`$${params.length}`);
    for (const col of spec.columns) {
      if (!(col.name in body)) continue;
      params.push(encodeColumn(col, body[col.name]));
      cols.push(col.name);
      placeholders.push(col.json ? `$${params.length}::jsonb` : `$${params.length}`);
    }
    const insertHead = `INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
    // UUID-keyed: a plain insert always returns exactly one row (unchanged path).
    if (spec.idColumn === undefined) {
      return redactResourceRow(spec, await this.client.one<Record<string, unknown>>(`${insertHead} RETURNING *`, params));
    }
    // Natural-key: upsert-on-conflict so create is an idempotent "ensure". DO
    // NOTHING can return zero rows, so read (not one()) and fall back to select.
    // A tenant-scoped natural key (email-agents) conflicts on (tenant_id, key).
    const conflictTarget = spec.compositeKey ? `tenant_id, ${key}` : key;
    const inserted = await this.client.get<Record<string, unknown>>(
      `${insertHead} ON CONFLICT (${conflictTarget}) DO NOTHING RETURNING *`,
      params,
    );
    if (inserted) return redactResourceRow(spec, inserted);
    const existing = await this.getResource(spec, String(body[key] ?? ""));
    if (existing) return existing;
    throw new Error(`create on ${spec.path} produced no row`);
  }

  async updateResource(
    spec: SelfHostedResourceSpec,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const key = keyColumn(spec);
    const sets: string[] = [];
    const params: unknown[] = [id, this.tenantId];
    for (const col of spec.columns) {
      if (!(col.name in body)) continue;
      if (col.name === key) continue; // never rewrite the primary key
      params.push(encodeColumn(col, body[col.name]));
      sets.push(col.json ? `${col.name} = $${params.length}::jsonb` : `${col.name} = $${params.length}`);
    }
    if (sets.length === 0) return this.getResource(spec, id);
    sets.push("updated_at = now()");
    return redactResourceRow(
      spec,
      await this.client.get<Record<string, unknown>>(
        `UPDATE ${spec.table} SET ${sets.join(", ")} WHERE ${key} = $1 AND tenant_id = $2 RETURNING *`,
        params,
      ),
    );
  }

  async deleteResource(spec: SelfHostedResourceSpec, id: string): Promise<boolean> {
    const key = keyColumn(spec);
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM ${spec.table} WHERE ${key} = $1 AND tenant_id = $2 RETURNING ${key} AS id`,
      [id, this.tenantId],
    );
    return rows.length > 0;
  }

  // ---- scoped send keys (mint / verify / authorization) -------------------
  //
  // A send key authorizes sending only from addresses its owner OWNS or
  // ADMINISTERS. The secret material is a token shown ONCE at mint time; only its
  // SHA-256 hash is persisted, in the dedicated `send_key_secrets` table that is
  // NOT a generic /v1 resource — so no resource read path can ever return a hash.
  // The `send_keys` table (a generic resource) stays summary-only. All reads are
  // tenant-scoped: a caller can only mint/verify/authorize keys in their own tenant.

  /**
   * Mint a scoped send key for an owner IN THIS TENANT. Returns the one-time token
   * (never stored) plus the non-secret summary row. Also writes the non-RLS
   * `send_key_tenants` resolution map (design §6 H2) so P4 RLS can resolve the
   * tenant from the token without reading the RLS-forced send_keys table.
   */
  async mintSendKey(input: { owner_id: string; label?: string | null }): Promise<{ token: string; key: SendKeyRecord }> {
    // M4: owner_id must not reference another tenant's owner.
    await this.assertNotOtherTenant("owners", input.owner_id, "owner_id");
    const token = `esk_${randomBytes(24).toString("base64url")}`;
    const prefix = token.slice(0, 12);
    const keyHash = hashSendToken(token);
    const id = randomUUID();
    const key = await this.client.one<SendKeyRecord>(
      `INSERT INTO send_keys (id, owner_id, prefix, label, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, owner_id, prefix, label, last_used_at, revoked_at, created_at, updated_at`,
      [id, input.owner_id, prefix, input.label ?? null, this.tenantId],
    );
    await this.client.execute(
      `INSERT INTO send_key_secrets (id, send_key_id, key_hash) VALUES ($1, $2, $3)`,
      [randomUUID(), id, keyHash],
    );
    await this.client.execute(
      `INSERT INTO send_key_tenants (send_key_id, tenant_id) VALUES ($1, $2) ON CONFLICT (send_key_id) DO NOTHING`,
      [id, this.tenantId],
    );
    return { token, key };
  }

  /**
   * Resolve a token to its (non-revoked) send key WITHIN this tenant, stamping
   * `last_used_at`. The `send_key_secrets` hash lookup is global (the token IS the
   * credential), but the resolved `send_keys` row must belong to this tenant — a
   * token minted for another tenant returns null (fail closed).
   */
  async verifySendKey(token: string): Promise<SendKeyRecord | null> {
    const value = token.trim();
    if (!value) return null;
    const keyHash = hashSendToken(value);
    const secret = await this.client.get<{ send_key_id: string }>(
      `SELECT send_key_id FROM send_key_secrets WHERE key_hash = $1`,
      [keyHash],
    );
    if (!secret) return null;
    const key = await this.client.get<SendKeyRecord>(
      `SELECT id, owner_id, prefix, label, last_used_at, revoked_at, created_at, updated_at
       FROM send_keys WHERE id = $1 AND tenant_id = $2`,
      [secret.send_key_id, this.tenantId],
    );
    if (!key || key.revoked_at) return null;
    const stamped = await this.client.get<SendKeyRecord>(
      `UPDATE send_keys SET last_used_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, owner_id, prefix, label, last_used_at, revoked_at, created_at, updated_at`,
      [key.id, this.tenantId],
    );
    return stamped ?? key;
  }

  /** Whether `ownerId` may send from `fromEmail` (owns or administers a tenant address). */
  async isOwnerAuthorizedFrom(ownerId: string, fromEmail: string): Promise<boolean> {
    if (!ownerId) return false;
    const email = canonicalAddress(fromEmail);
    if (!email) return false;
    const row = await this.client.get<{ one: number }>(
      `SELECT 1 AS one FROM addresses
       WHERE lower(email) = $1 AND (owner_id = $2 OR administrator_id = $2) AND tenant_id = $3
       LIMIT 1`,
      [email, ownerId, this.tenantId],
    );
    return row !== null;
  }
}
