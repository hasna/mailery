// Schema migrations for the Mailery self_hosted cloud service (Postgres).
//
// These run through the vendored storage kit's MigrationLedger (checksummed,
// idempotent, drift/downgrade-guarded). They own ONLY the tables the
// self_hosted /v1 API manages; they never touch the live mailery.co SaaS
// database (a separate database on the shared cluster).

import { defineMigration, type Migration } from "../../generated/storage-kit/index.js";
import { apiKeyMigrations } from "@hasna/contracts/auth";

/** Mailery self_hosted domain schema: sending domains, addresses, message ledger. */
const CORE_SCHEMA = defineMigration(
  "0001_mailery_selfhosted_core",
  `
  CREATE TABLE IF NOT EXISTS domains (
    id          TEXT PRIMARY KEY,
    domain      TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'pending',
    provider    TEXT,
    verified    BOOLEAN NOT NULL DEFAULT FALSE,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS domains_status_idx ON domains (status);

  CREATE TABLE IF NOT EXISTS addresses (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    domain        TEXT,
    display_name  TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS addresses_domain_idx ON addresses (domain);

  CREATE TABLE IF NOT EXISTS messages (
    id                   TEXT PRIMARY KEY,
    from_addr            TEXT NOT NULL,
    to_addrs             JSONB NOT NULL DEFAULT '[]'::jsonb,
    subject              TEXT,
    body_text            TEXT,
    body_html            TEXT,
    status               TEXT NOT NULL DEFAULT 'queued',
    provider_message_id  TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS messages_from_idx ON messages (from_addr);
  CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at DESC);
  `,
);

/**
 * Inbound-message support for the shared message store.
 *
 * The original `messages` table (0001) is an outbound-only ledger. This
 * migration widens it so the SAME table can faithfully hold *inbound* mail
 * (received email) alongside sent messages, which the /v1 API needs both for
 * importing history and for future SES-inbound ingestion. Every column is
 * additive and nullable/defaulted, so existing outbound rows and readers are
 * unaffected.
 *
 * Idempotency: `source_id` is the stable identifier of the upstream record (the
 * local row id for a history import, or the provider/receipt id for live
 * ingestion). A partial UNIQUE index lets writers upsert on it, so re-running an
 * import never creates duplicates.
 */
const INBOUND_SCHEMA = defineMigration(
  "0002_mailery_messages_inbound",
  `
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction   TEXT NOT NULL DEFAULT 'outbound';
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS cc_addrs    JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_id  TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read     BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_starred  BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS labels      JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS headers     JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_id   TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS messages_source_id_uidx
    ON messages (source_id) WHERE source_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_direction_idx ON messages (direction);
  CREATE INDEX IF NOT EXISTS messages_received_idx ON messages (received_at DESC);
  CREATE INDEX IF NOT EXISTS messages_message_id_idx ON messages (message_id);
  `,
);

/**
 * Address verification support.
 *
 * The client `addresses` resource carries a `verified` flag (the send-readiness
 * gate + `mailery address verify` / markVerified flow). The original cloud
 * `addresses` table (0001) omitted it, so a client flipped to the cloud store
 * could not persist verification. This additive column closes that gap so the
 * full address CRUD — including verify — round-trips through /v1/addresses.
 */
const ADDRESS_VERIFIED_SCHEMA = defineMigration(
  "0003_mailery_addresses_verified",
  `
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
  `,
);

/**
 * Per-address daily send quota.
 *
 * `mailery address quota <id> <perDay>` (setAddressQuota) caps sends per UTC day
 * for an address. A flipped client routes this write to /v1/addresses; without a
 * cloud column the quota would silently only persist on the local island
 * (split-brain). Nullable: NULL means "no quota" (the CLI's `quota <id> none`).
 */
const ADDRESS_QUOTA_SCHEMA = defineMigration(
  "0004_mailery_addresses_daily_quota",
  `
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS daily_quota INTEGER;
  `,
);

/** All migrations, in order: api-keys table (auth), the core schema, inbound. */
export function maileryCloudMigrations(): Migration[] {
  const authMigrations = apiKeyMigrations().map((m) => defineMigration(m.id, m.sql));
  return [...authMigrations, CORE_SCHEMA, INBOUND_SCHEMA, ADDRESS_VERIFIED_SCHEMA, ADDRESS_QUOTA_SCHEMA];
}
