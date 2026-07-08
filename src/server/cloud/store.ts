// Postgres repository for the Mailery self_hosted cloud service.
//
// Amendment A1 (PURE REMOTE): every method reads/writes the cloud Postgres
// directly through the vendored storage kit's typed query client. No cache, no
// local mirror.

import { randomUUID } from "node:crypto";
import type { TypedQueryClient } from "../../generated/storage-kit/index.js";

export interface DomainRecord {
  id: string;
  domain: string;
  status: string;
  provider: string | null;
  verified: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddressRecord {
  id: string;
  email: string;
  domain: string | null;
  display_name: string | null;
  status: string;
  verified: boolean;
  daily_quota: number | null;
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
  created_at: string;
  updated_at: string;
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
}

/** Columns selected for a message row (explicit so new columns are intentional). */
const MESSAGE_COLUMNS =
  "id, direction, from_addr, to_addrs, cc_addrs, subject, body_text, body_html, status, " +
  "provider_message_id, message_id, in_reply_to, received_at, is_read, is_starred, labels, " +
  "headers, attachments, source_id, created_at, updated_at";

export interface ListOptions {
  limit?: number;
  offset?: number;
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
  return {
    ...(row as unknown as MessageRecord),
    to_addrs: toStringArray(row["to_addrs"]),
    cc_addrs: toStringArray(row["cc_addrs"]),
    labels: toStringArray(row["labels"]),
    attachments: toArray(row["attachments"]),
    headers: toObject(row["headers"]),
    is_read: Boolean(row["is_read"]),
    is_starred: Boolean(row["is_starred"]),
    received_at: toIso(row["received_at"]),
    created_at: toIso(row["created_at"]) ?? "",
    updated_at: toIso(row["updated_at"]) ?? "",
  };
}

export class MaileryCloudStore {
  constructor(private readonly client: TypedQueryClient) {}

  // ---- domains ------------------------------------------------------------
  async listDomains(opts: ListOptions = {}): Promise<DomainRecord[]> {
    return this.client.many<DomainRecord>(
      `SELECT * FROM domains ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [clampLimit(opts.limit), clampOffset(opts.offset)],
    );
  }

  async getDomain(id: string): Promise<DomainRecord | null> {
    return this.client.get<DomainRecord>(`SELECT * FROM domains WHERE id = $1`, [id]);
  }

  async getDomainByName(domain: string): Promise<DomainRecord | null> {
    return this.client.get<DomainRecord>(`SELECT * FROM domains WHERE domain = $1`, [
      domain.trim().toLowerCase(),
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
      `INSERT INTO domains (id, domain, status, provider, verified, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        input.domain.trim().toLowerCase(),
        input.status ?? "pending",
        input.provider ?? null,
        input.verified ?? false,
        input.notes ?? null,
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
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.provider ?? null,
        patch.verified ?? null,
        patch.notes ?? null,
      ],
    );
  }

  async deleteDomain(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM domains WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  // ---- addresses ----------------------------------------------------------
  async listAddresses(opts: ListOptions = {}): Promise<AddressRecord[]> {
    return this.client.many<AddressRecord>(
      `SELECT * FROM addresses ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [clampLimit(opts.limit), clampOffset(opts.offset)],
    );
  }

  async getAddress(id: string): Promise<AddressRecord | null> {
    return this.client.get<AddressRecord>(`SELECT * FROM addresses WHERE id = $1`, [id]);
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
      `INSERT INTO addresses (id, email, domain, display_name, status, verified, daily_quota)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, email, domain, input.display_name ?? null, input.status ?? "active", input.verified ?? false, input.daily_quota ?? null],
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
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.display_name ?? null,
        patch.status ?? null,
        patch.verified ?? null,
        patch.dailyQuotaSet ?? false,
        patch.dailyQuotaSet ? patch.daily_quota ?? null : null,
      ],
    );
  }

  async deleteAddress(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM addresses WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  // ---- messages (outbound ledger + inbound mail) -------------------------
  //
  // Ordering is by original receipt time when known, else insertion time, so an
  // imported inbox reads in true chronological order rather than import order.
  async listMessages(opts: ListOptions = {}): Promise<MessageRecord[]> {
    const rows = await this.client.many<Record<string, unknown>>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       ORDER BY COALESCE(received_at, created_at) DESC LIMIT $1 OFFSET $2`,
      [clampLimit(opts.limit), clampOffset(opts.offset)],
    );
    return rows.map(mapMessageRow);
  }

  async getMessage(id: string): Promise<MessageRecord | null> {
    const row = await this.client.get<Record<string, unknown>>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1`,
      [id],
    );
    return row ? mapMessageRow(row) : null;
  }

  /**
   * Look up an existing message by a stable upstream key, matching EITHER the
   * `source_id` (this ingest path's idempotency key) OR the `message_id`
   * (the S3 object key stored by the history backfill). Returns the row id, or
   * null. Used by the ingest worker to avoid re-inserting mail already present
   * from the local→cloud history import, whose rows carry the same object key
   * in `message_id` but a different `source_id`.
   */
  async findMessageIdByKey(key: string): Promise<string | null> {
    if (!key) return null;
    const row = await this.client.get<{ id: string }>(
      `SELECT id FROM messages WHERE source_id = $1 OR message_id = $1 LIMIT 1`,
      [key],
    );
    return row ? row.id : null;
  }

  /** Positional insert params shared by createMessage and upsertMessage. */
  private messageInsertParams(input: MessageInput): unknown[] {
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
    ];
  }

  private static readonly INSERT_COLS =
    "id, direction, from_addr, to_addrs, cc_addrs, subject, body_text, body_html, status, " +
    "provider_message_id, message_id, in_reply_to, received_at, is_read, is_starred, labels, " +
    "headers, attachments, source_id";

  private static readonly INSERT_VALUES =
    "$1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, " +
    "$16::jsonb, $17::jsonb, $18::jsonb, $19";

  async createMessage(input: MessageInput): Promise<MessageRecord> {
    const row = await this.client.one<Record<string, unknown>>(
      `INSERT INTO messages (${MaileryCloudStore.INSERT_COLS})
       VALUES (${MaileryCloudStore.INSERT_VALUES})
       RETURNING ${MESSAGE_COLUMNS}`,
      this.messageInsertParams(input),
    );
    return mapMessageRow(row);
  }

  /**
   * Idempotent write keyed on `source_id`: inserts a new row, or updates the
   * existing row with the same source_id (so re-running an import never
   * duplicates). Requires `source_id`. Returns whether a new row was inserted
   * (Postgres `xmax = 0` distinguishes insert from update in an upsert).
   */
  async upsertMessage(input: MessageInput): Promise<{ record: MessageRecord; inserted: boolean }> {
    if (!input.source_id) {
      throw new Error("upsertMessage requires a source_id");
    }
    const row = await this.client.one<Record<string, unknown>>(
      `INSERT INTO messages (${MaileryCloudStore.INSERT_COLS})
       VALUES (${MaileryCloudStore.INSERT_VALUES})
       ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO UPDATE SET
         direction           = EXCLUDED.direction,
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
         updated_at          = now()
       RETURNING ${MESSAGE_COLUMNS}, (xmax = 0) AS inserted`,
      this.messageInsertParams(input),
    );
    const inserted = Boolean(row["inserted"]);
    return { record: mapMessageRow(row), inserted };
  }

  async updateMessageStatus(
    id: string,
    patch: { status?: string; provider_message_id?: string | null },
  ): Promise<MessageRecord | null> {
    const row = await this.client.get<Record<string, unknown>>(
      `UPDATE messages SET
         status              = COALESCE($2, status),
         provider_message_id = COALESCE($3, provider_message_id),
         updated_at          = now()
       WHERE id = $1
       RETURNING ${MESSAGE_COLUMNS}`,
      [id, patch.status ?? null, patch.provider_message_id ?? null],
    );
    return row ? mapMessageRow(row) : null;
  }

  async deleteMessage(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `DELETE FROM messages WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
}
