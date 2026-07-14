// Schema migrations for the Emails self_hosted service (Postgres).
//
// These run through the product-owned migration ledger (checksummed,
// idempotent, drift/downgrade-guarded). They own ONLY the tables the
// self_hosted /v1 API manages in the operator-owned database.

import { defineMigration, withAcceptedMigrationChecksums, type Migration } from "../../storage-kit/index.js";
import { apiKeyMigrations } from "@hasna/contracts/auth";

/**
 * Compatibility bridge for operator databases that already have legacy local
 * Emails tables named `domains` or `addresses`.
 *
 * The released 0001 migration uses `CREATE TABLE IF NOT EXISTS`; against a
 * legacy table with the same name, creation is skipped and later indexes/reads
 * need the self-hosted base columns to exist. This migration runs before 0001
 * and is intentionally a no-op for fresh databases.
 */
const LEGACY_TABLE_COMPATIBILITY_SCHEMA = defineMigration(
  "0000_emails_legacy_selfhosted_table_compatibility",
  `
  DO $$
  BEGIN
    IF to_regclass('public.domains') IS NOT NULL THEN
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE domains ADD COLUMN IF NOT EXISTS notes TEXT;
    END IF;

    IF to_regclass('public.addresses') IS NOT NULL THEN
      ALTER TABLE addresses ADD COLUMN IF NOT EXISTS domain TEXT;
      ALTER TABLE addresses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
    END IF;
  END $$;
  `,
);

/** Emails self_hosted domain schema: sending domains, addresses, message ledger. */
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
 * gate + `emails address verify` / markVerified flow). The original self_hosted
 * `addresses` table (0001) omitted it, so a client flipped to the self_hosted store
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
 * `emails address quota <id> <perDay>` (setAddressQuota) caps sends per UTC day
 * for an address. A flipped client routes this write to /v1/addresses; without a
 * self_hosted column the quota would silently only persist on the local island
 * (split-brain). Nullable: NULL means "no quota" (the CLI's `quota <id> none`).
 */
const ADDRESS_QUOTA_SCHEMA = defineMigration(
  "0004_mailery_addresses_daily_quota",
  `
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS daily_quota INTEGER;
  `,
);

/**
 * Generic list-backed resources for self-hosted clients.
 *
 * Adds the self_hosted tables behind the /v1 resource CRUD used by `contact list`,
 * `provider list`, `template list`, `group list`, `sequence list`, `owner
 * list`, `sendkey list` and `scheduled list`. Without these, a flipped client
 * fails closed (HTTP 404) on those reads rather than silently reading its local
 * SQLite island. Every table carries id/created_at/updated_at plus NON-SECRET
 * columns only: provider credentials and send-key hashes are never stored here.
 */
const RESOURCE_SCHEMA = defineMigration(
  "0005_mailery_selfhosted_resources",
  `
  CREATE TABLE IF NOT EXISTS contacts (
    id               TEXT PRIMARY KEY,
    email            TEXT NOT NULL UNIQUE,
    name             TEXT,
    send_count       INTEGER NOT NULL DEFAULT 0,
    bounce_count     INTEGER NOT NULL DEFAULT 0,
    complaint_count  INTEGER NOT NULL DEFAULT 0,
    last_sent_at     TIMESTAMPTZ,
    suppressed       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS contacts_suppressed_idx ON contacts (suppressed);

  CREATE TABLE IF NOT EXISTS cloud_providers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    region      TEXT,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS templates (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    subject_template  TEXT NOT NULL DEFAULT '',
    html_template     TEXT,
    text_template     TEXT,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS contact_groups (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sequences (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS owners (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL DEFAULT 'human',
    name          TEXT NOT NULL,
    contact_email TEXT,
    external_id   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS send_keys (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT,
    prefix        TEXT,
    label         TEXT,
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS send_keys_owner_idx ON send_keys (owner_id);

  CREATE TABLE IF NOT EXISTS scheduled_emails (
    id                TEXT PRIMARY KEY,
    provider_id       TEXT,
    from_address      TEXT,
    to_addresses      JSONB NOT NULL DEFAULT '[]'::jsonb,
    cc_addresses      JSONB NOT NULL DEFAULT '[]'::jsonb,
    bcc_addresses     JSONB NOT NULL DEFAULT '[]'::jsonb,
    reply_to          TEXT,
    subject           TEXT NOT NULL DEFAULT '',
    html              TEXT,
    text_body         TEXT,
    attachments_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
    template_name     TEXT,
    template_vars     JSONB,
    scheduled_at      TIMESTAMPTZ,
    status            TEXT NOT NULL DEFAULT 'pending',
    error             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS scheduled_emails_status_idx ON scheduled_emails (status);
  CREATE INDEX IF NOT EXISTS scheduled_emails_scheduled_idx ON scheduled_emails (scheduled_at);
  `,
);

/**
 * Additive rename bridge. The first five migration ids and SQL bodies shipped
 * under the old product name and must remain checksum-stable for upgrades.
 * Fresh databases run those historical migrations and immediately cross this
 * bridge; existing databases retain every provider row while adopting the new
 * table name.
 */
const EMAILS_RENAME_BRIDGE = defineMigration(
  "0006_emails_rename_bridge",
  `
  DO $$
  BEGIN
    IF to_regclass('public.cloud_providers') IS NOT NULL
       AND to_regclass('public.self_hosted_providers') IS NULL THEN
      ALTER TABLE cloud_providers RENAME TO self_hosted_providers;
    ELSIF to_regclass('public.cloud_providers') IS NOT NULL
       AND to_regclass('public.self_hosted_providers') IS NOT NULL THEN
      INSERT INTO self_hosted_providers (id, name, type, region, active, created_at, updated_at)
      SELECT id, name, type, region, active, created_at, updated_at FROM cloud_providers
      ON CONFLICT (id) DO NOTHING;
      DROP TABLE cloud_providers;
    END IF;
  END $$;

  ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_payload_hash TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_state TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_key_uidx
    ON messages (idempotency_key) WHERE idempotency_key IS NOT NULL;
  `,
);

/**
 * Prepares legacy local-store rows for the immutable 0007 backfill.
 *
 * 0007 was deployed and applied in production, so its checksum must remain
 * stable. This prep migration runs before 0007 on fresh upgrades and sanitizes
 * malformed legacy JSON/timestamp text so the historical casts in 0007 do not
 * abort the whole migration.
 */
const LEGACY_MESSAGES_BACKFILL_PREP = withAcceptedMigrationChecksums(defineMigration(
  "0006b_emails_legacy_messages_backfill_prep",
  `
  CREATE OR REPLACE FUNCTION pg_temp.emails_safe_jsonb_text(value TEXT, fallback JSONB)
  RETURNS TEXT
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    parsed JSONB;
  BEGIN
    IF value IS NULL OR btrim(value) = '' THEN
      RETURN fallback::text;
    END IF;
    parsed := value::jsonb;
    IF jsonb_typeof(parsed) IS DISTINCT FROM jsonb_typeof(fallback) THEN
      RETURN fallback::text;
    END IF;
    RETURN parsed::text;
  EXCEPTION WHEN others THEN
    RETURN fallback::text;
  END;
  $fn$;

  CREATE OR REPLACE FUNCTION pg_temp.emails_safe_timestamptz_text(value TEXT, fallback TIMESTAMPTZ DEFAULT NULL)
  RETURNS TIMESTAMPTZ
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    parsed TIMESTAMPTZ;
  BEGIN
    IF value IS NULL OR btrim(value) = '' THEN
      RETURN fallback;
    END IF;
    parsed := value::timestamptz;
    RETURN parsed;
  EXCEPTION WHEN others THEN
    RETURN fallback;
  END;
  $fn$;

  DO $$
  BEGIN
    IF to_regclass('public.inbound_emails') IS NOT NULL THEN
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS headers_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS attachments_json TEXT NOT NULL DEFAULT '[]';

      UPDATE inbound_emails
      SET
        to_addresses = pg_temp.emails_safe_jsonb_text(to_addresses::text, '[]'::jsonb),
        cc_addresses = pg_temp.emails_safe_jsonb_text(cc_addresses::text, '[]'::jsonb),
        headers_json = pg_temp.emails_safe_jsonb_text(headers_json::text, '{}'::jsonb),
        attachments_json = pg_temp.emails_safe_jsonb_text(attachments_json::text, '[]'::jsonb),
        received_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(received_at::text),
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          now()
        ),
        created_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          pg_temp.emails_safe_timestamptz_text(received_at::text),
          now()
        );
    END IF;

    IF to_regclass('public.emails') IS NOT NULL THEN
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS bcc_addresses TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '{}';

      UPDATE emails
      SET
        to_addresses = pg_temp.emails_safe_jsonb_text(to_addresses::text, '[]'::jsonb),
        cc_addresses = pg_temp.emails_safe_jsonb_text(cc_addresses::text, '[]'::jsonb),
        bcc_addresses = pg_temp.emails_safe_jsonb_text(bcc_addresses::text, '[]'::jsonb),
        tags = pg_temp.emails_safe_jsonb_text(tags::text, '{}'::jsonb),
        sent_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(sent_at::text),
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          pg_temp.emails_safe_timestamptz_text(updated_at::text),
          now()
        ),
        created_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          pg_temp.emails_safe_timestamptz_text(sent_at::text),
          now()
        ),
        updated_at = COALESCE(
          pg_temp.emails_safe_timestamptz_text(updated_at::text),
          pg_temp.emails_safe_timestamptz_text(sent_at::text),
          pg_temp.emails_safe_timestamptz_text(created_at::text),
          now()
        );
    END IF;
  END $$;
  `,
), [
  // Published in @hasna/emails@0.6.119. Accepting it keeps databases that
  // successfully applied the text-only repair compatible while pending or
  // failed databases run the corrected TIMESTAMPTZ-safe body above.
  "sha256:0418239e617335b948364101dfa9d55d401322c377c9999804429b6cc789de23",
]);

/**
 * Legacy local-store backfill into the self-hosted message ledger.
 *
 * Some production operator databases predate the `/v1/messages` table and carry
 * the original local-store `inbound_emails` and `emails` tables. The self-hosted
 * API reads only `messages`, so without this bridge authentication works while
 * the inbox appears empty. The `source_id` values are stable, table-qualified
 * identifiers; reruns are no-ops and live S3 ingestion can still dedupe by the
 * raw object key stored in `message_id`.
 */
const LEGACY_MESSAGES_BACKFILL = defineMigration(
  "0007_emails_legacy_messages_backfill",
  `
  DO $$
  BEGIN
    IF to_regclass('public.inbound_emails') IS NOT NULL THEN
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS provider_history_id TEXT;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS raw_s3_url TEXT;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS in_reply_to_email_id TEXT;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_read INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_starred INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_spam INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_trash INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS headers_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS attachments_json TEXT NOT NULL DEFAULT '[]';

      INSERT INTO messages (
        id,
        direction,
        from_addr,
        to_addrs,
        cc_addrs,
        subject,
        body_text,
        body_html,
        status,
        provider_message_id,
        message_id,
        in_reply_to,
        received_at,
        is_read,
        is_starred,
        labels,
        headers,
        attachments,
        source_id,
        send_state,
        created_at,
        updated_at
      )
      SELECT
        'legacy-inbound:' || inbound_emails.id,
        'inbound',
        COALESCE(NULLIF(inbound_emails.from_address, ''), '(unknown sender)'),
        COALESCE(NULLIF(inbound_emails.to_addresses, '')::jsonb, '[]'::jsonb),
        COALESCE(NULLIF(inbound_emails.cc_addresses, '')::jsonb, '[]'::jsonb),
        NULLIF(inbound_emails.subject, ''),
        inbound_emails.text_body,
        inbound_emails.html_body,
        CASE
          WHEN lower(COALESCE(NULLIF(inbound_emails.is_trash::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'trash'
          WHEN lower(COALESCE(NULLIF(inbound_emails.is_spam::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'spam'
          ELSE 'received'
        END,
        inbound_emails.provider_history_id,
        COALESCE(
          CASE
            WHEN NULLIF(inbound_emails.raw_s3_url, '') LIKE 's3://%/%'
              THEN regexp_replace(inbound_emails.raw_s3_url, '^s3://[^/]+/', '')
            ELSE NULLIF(inbound_emails.raw_s3_url, '')
          END,
          NULLIF(inbound_emails.message_id, '')
        ),
        inbound_emails.in_reply_to_email_id,
        COALESCE(NULLIF(inbound_emails.received_at::text, '')::timestamptz, NULLIF(inbound_emails.created_at::text, '')::timestamptz, now()),
        lower(COALESCE(NULLIF(inbound_emails.is_read::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no'),
        lower(COALESCE(NULLIF(inbound_emails.is_starred::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no'),
        to_jsonb(array_remove(ARRAY[
          CASE WHEN lower(COALESCE(NULLIF(inbound_emails.is_archived::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'archived' END,
          CASE WHEN lower(COALESCE(NULLIF(inbound_emails.is_spam::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'spam' END,
          CASE WHEN lower(COALESCE(NULLIF(inbound_emails.is_trash::text, ''), '0')) NOT IN ('0', 'false', 'f', 'no') THEN 'trash' END
        ], NULL)),
        COALESCE(NULLIF(inbound_emails.headers_json, '')::jsonb, '{}'::jsonb),
        COALESCE(NULLIF(inbound_emails.attachments_json, '')::jsonb, '[]'::jsonb),
        'legacy:inbound_emails:' || inbound_emails.id,
        'none',
        COALESCE(NULLIF(inbound_emails.created_at::text, '')::timestamptz, NULLIF(inbound_emails.received_at::text, '')::timestamptz, now()),
        COALESCE(NULLIF(inbound_emails.created_at::text, '')::timestamptz, NULLIF(inbound_emails.received_at::text, '')::timestamptz, now())
      FROM inbound_emails
      ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING;
    END IF;

    IF to_regclass('public.emails') IS NOT NULL THEN
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS bcc_addresses TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS reply_to TEXT;
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

      INSERT INTO messages (
        id,
        direction,
        from_addr,
        to_addrs,
        cc_addrs,
        subject,
        status,
        provider_message_id,
        received_at,
        is_read,
        is_starred,
        labels,
        headers,
        attachments,
        source_id,
        idempotency_key,
        send_state,
        created_at,
        updated_at
      )
      SELECT
        'legacy-sent:' || emails.id,
        'outbound',
        COALESCE(NULLIF(emails.from_address, ''), '(unknown sender)'),
        COALESCE(NULLIF(emails.to_addresses, '')::jsonb, '[]'::jsonb),
        COALESCE(NULLIF(emails.cc_addresses, '')::jsonb, '[]'::jsonb),
        NULLIF(emails.subject, ''),
        COALESCE(NULLIF(emails.status, ''), 'sent'),
        emails.provider_message_id,
        NULL::timestamptz,
        TRUE,
        FALSE,
        '[]'::jsonb,
        jsonb_strip_nulls(jsonb_build_object(
          'bcc_addresses', COALESCE(NULLIF(emails.bcc_addresses, '')::jsonb, '[]'::jsonb),
          'reply_to', NULLIF(emails.reply_to, ''),
          'tags', COALESCE(NULLIF(emails.tags, '')::jsonb, '{}'::jsonb)
        )),
        '[]'::jsonb,
        'legacy:emails:' || emails.id,
        NULLIF(emails.idempotency_key, ''),
        CASE WHEN lower(COALESCE(emails.status, 'sent')) = 'sent' THEN 'sent' ELSE 'none' END,
        COALESCE(NULLIF(emails.created_at::text, '')::timestamptz, NULLIF(emails.sent_at::text, '')::timestamptz, now()),
        COALESCE(NULLIF(emails.updated_at::text, '')::timestamptz, NULLIF(emails.sent_at::text, '')::timestamptz, NULLIF(emails.created_at::text, '')::timestamptz, now())
      FROM emails
      ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING;
    END IF;
  END $$;
  `,
);

/**
 * Post-backfill dedupe for race/repair cases where S3 ingestion already wrote
 * a message row keyed by the same raw object key stored in `message_id` before
 * the legacy row was bridged by 0007. Keep the live-ingested row and remove the
 * synthetic legacy duplicate.
 */
const LEGACY_MESSAGES_BACKFILL_DEDUPE = defineMigration(
  "0008_emails_legacy_messages_backfill_dedupe",
  `
  DELETE FROM messages legacy
  USING messages existing
  WHERE legacy.id LIKE 'legacy-inbound:%'
    AND legacy.message_id IS NOT NULL
    AND legacy.message_id <> ''
    AND existing.id <> legacy.id
    AND existing.message_id = legacy.message_id
    AND existing.id NOT LIKE 'legacy-inbound:%';
  `,
);

/**
 * Self-hosted-only PARITY tables. The app is becoming self-hosted-ONLY, so the
 * /v1 API must expose every resource the deleted local SQLite store carried.
 * These tables back the generic /v1 resource CRUD for aliases, forwarding rules,
 * warming schedules, triage, provisioning events, mailbox sources, delivery
 * events, inbound AI agent settings/runs, and inbox digests. Every column
 * mirrors the local SQLite schema in snake_case; JSON columns are JSONB and
 * every table carries created_at/updated_at so the generic updater
 * (`SET ... updated_at = now()`) works uniformly even on the audit-style tables
 * whose local originals had only created_at.
 */
const PARITY_RESOURCE_SCHEMA = withAcceptedMigrationChecksums(defineMigration(
  "0009_emails_selfhosted_parity_tables",
  `
  -- Idempotent type reconcile for operator databases whose parity tables were
  -- created ad-hoc OUTSIDE this migration ledger with SQLite-ported types (an
  -- earlier backfill built them with INTEGER booleans + TEXT json). On those
  -- databases every CREATE TABLE IF NOT EXISTS below is a no-op, so the columns
  -- keep their legacy INTEGER type and the boolean seed/ops fail. This helper
  -- converts a legacy INTEGER boolean column to a real BOOLEAN, preserving a
  -- boolean default + NOT NULL (any stray NULL is coalesced to the default). It
  -- is a guarded no-op when the column is already boolean (a fresh DB, where the
  -- CREATE TABLE below makes it boolean) or absent, so it is safe on BOTH
  -- drifted-prod and fresh databases.
  CREATE OR REPLACE FUNCTION pg_temp.emails_reconcile_bool(tbl text, col text, default_bool boolean)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    current_type  text;
    default_token text := CASE WHEN default_bool THEN 'true' ELSE 'false' END;
    fallback_int  text := CASE WHEN default_bool THEN '1' ELSE '0' END;
  BEGIN
    SELECT data_type INTO current_type
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = tbl AND column_name = col;
    IF current_type IS NULL OR current_type = 'boolean' THEN
      RETURN;
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', tbl, col);
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE boolean USING (COALESCE(%I::int, %s)::boolean)',
      tbl, col, col, fallback_int);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT %s', tbl, col, default_token);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL', tbl, col);
  END;
  $fn$;

  -- Drop a restrictive legacy CONSTRAINT (CHECK or FOREIGN KEY) that a fresh
  -- migration does not impose. The ad-hoc legacy tables carried enum/range CHECKs
  -- (e.g. provider IN ('cerebras','groq'), forwarding mode = 'app-copy', triage /
  -- status / period / event-type enums) AND foreign keys into legacy tables the
  -- self-hosted-only server no longer uses (providers, groups, inbound_emails,
  -- emails, mailboxes, ...). The new server writes values / ids those reject
  -- (provider='external', a self_hosted_providers id, a message id, ...). A fresh
  -- migration creates NONE of them, so reconciling the drifted tables to the fresh
  -- schema means dropping them. Guarded on table existence so it is a pure no-op
  -- on a fresh DB (or where the table is created by a later migration).
  CREATE OR REPLACE FUNCTION pg_temp.emails_drop_constraint(tbl text, con text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', tbl, con);
    END IF;
  END;
  $fn$;

  -- Relax a legacy NOT NULL column that the fresh schema made nullable or does
  -- not carry at all (e.g. domains/addresses.provider_id, send_keys.key_hash,
  -- agent-run/digest started_at/completed_at). The new server never populates
  -- those columns, so a legacy NOT NULL-without-default would reject its inserts.
  -- Guarded on column existence; DROP NOT NULL is itself idempotent, so this is a
  -- pure no-op on a fresh DB (column absent, or already nullable).
  CREATE OR REPLACE FUNCTION pg_temp.emails_relax_not_null(tbl text, col text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = col
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', tbl, col);
    END IF;
  END;
  $fn$;

  -- Add a column the fresh schema carries but a legacy ad-hoc table is missing
  -- (e.g. the audit-style tables that only had created_at now need updated_at for
  -- the generic updater; legacy group_members lacked id/created_at/updated_at).
  -- Guarded on table existence (ADD COLUMN IF NOT EXISTS handles the column), so
  -- it is a pure no-op on a fresh DB or where the table is created later.
  CREATE OR REPLACE FUNCTION pg_temp.emails_add_column(tbl text, col text, definition text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I %s', tbl, col, definition);
    END IF;
  END;
  $fn$;

  -- Restore the fresh schema's DEFAULT on a legacy NOT NULL column that lost it,
  -- so a server insert that omits the column gets the same value a fresh DB would
  -- (rather than a NOT NULL violation). Two variants: a TEXT literal (quoted via
  -- %L) and a raw SQL expression (e.g. now(), 0). Guarded on column existence;
  -- no-op on a fresh DB (the default already matches).
  CREATE OR REPLACE FUNCTION pg_temp.emails_set_text_default(tbl text, col text, val text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = col
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %L', tbl, col, val);
    END IF;
  END;
  $fn$;

  CREATE OR REPLACE FUNCTION pg_temp.emails_set_expr_default(tbl text, col text, expr text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = col
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %s', tbl, col, expr);
    END IF;
  END;
  $fn$;

  CREATE TABLE IF NOT EXISTS aliases (
    id             TEXT PRIMARY KEY,
    domain         TEXT NOT NULL,
    local_part     TEXT NOT NULL,
    target_address TEXT NOT NULL DEFAULT '',
    protected      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(domain, local_part)
  );
  CREATE INDEX IF NOT EXISTS aliases_domain_idx ON aliases (domain);

  CREATE TABLE IF NOT EXISTS forwarding_rules (
    id             TEXT PRIMARY KEY,
    source_address TEXT NOT NULL,
    target_address TEXT NOT NULL,
    mode           TEXT NOT NULL DEFAULT 'app-copy',
    provider_id    TEXT,
    from_address   TEXT,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(source_address, target_address, mode)
  );
  CREATE INDEX IF NOT EXISTS forwarding_rules_source_idx ON forwarding_rules (source_address, enabled);

  CREATE TABLE IF NOT EXISTS warming_schedules (
    id                  TEXT PRIMARY KEY,
    domain              TEXT NOT NULL UNIQUE,
    provider_id         TEXT,
    target_daily_volume INTEGER NOT NULL DEFAULT 0,
    start_date          TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS warming_schedules_status_idx ON warming_schedules (status);

  CREATE TABLE IF NOT EXISTS email_triage (
    id               TEXT PRIMARY KEY,
    email_id         TEXT,
    inbound_email_id TEXT,
    label            TEXT NOT NULL,
    priority         INTEGER NOT NULL DEFAULT 3,
    summary          TEXT,
    sentiment        TEXT,
    draft_reply      TEXT,
    confidence       DOUBLE PRECISION NOT NULL DEFAULT 0,
    model            TEXT,
    triaged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS email_triage_label_idx ON email_triage (label);
  CREATE INDEX IF NOT EXISTS email_triage_email_idx ON email_triage (email_id);
  CREATE INDEX IF NOT EXISTS email_triage_inbound_idx ON email_triage (inbound_email_id);

  CREATE TABLE IF NOT EXISTS provisioning_events (
    id          TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT NOT NULL,
    detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS provisioning_events_entity_idx ON provisioning_events (entity_type, entity_id);

  CREATE TABLE IF NOT EXISTS mailbox_sources (
    id                     TEXT PRIMARY KEY,
    mailbox_id             TEXT NOT NULL,
    provider_id            TEXT,
    type                   TEXT NOT NULL,
    name                   TEXT NOT NULL DEFAULT '',
    external_account_id    TEXT,
    external_mailbox       TEXT,
    status                 TEXT NOT NULL DEFAULT 'active',
    settings_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at         TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS mailbox_sources_mailbox_idx ON mailbox_sources (mailbox_id);

  CREATE TABLE IF NOT EXISTS events (
    id                TEXT PRIMARY KEY,
    email_id          TEXT,
    provider_id       TEXT,
    provider_event_id TEXT,
    type              TEXT NOT NULL,
    recipient         TEXT,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS events_provider_occurred_idx ON events (provider_id, occurred_at);
  CREATE INDEX IF NOT EXISTS events_type_occurred_idx ON events (type, occurred_at);
  CREATE INDEX IF NOT EXISTS events_email_idx ON events (email_id);

  CREATE TABLE IF NOT EXISTS email_agent_settings (
    agent_key         TEXT PRIMARY KEY,
    enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    always_on         BOOLEAN NOT NULL DEFAULT FALSE,
    provider          TEXT NOT NULL DEFAULT 'external',
    model             TEXT,
    apply_labels      BOOLEAN NOT NULL DEFAULT TRUE,
    use_network_tools BOOLEAN NOT NULL DEFAULT TRUE,
    config_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Reconcile any legacy INTEGER boolean columns to real BOOLEAN BEFORE the
  -- boolean seed/ops below. No-op on a fresh DB (the CREATE TABLE statements
  -- above already made these boolean) and on any table that pre-existed with the
  -- correct type; only a drifted ad-hoc table is actually converted.
  SELECT pg_temp.emails_reconcile_bool('aliases',              'protected',         false);
  SELECT pg_temp.emails_reconcile_bool('forwarding_rules',     'enabled',           true);
  SELECT pg_temp.emails_reconcile_bool('email_agent_settings', 'enabled',           false);
  SELECT pg_temp.emails_reconcile_bool('email_agent_settings', 'always_on',         false);
  SELECT pg_temp.emails_reconcile_bool('email_agent_settings', 'apply_labels',      true);
  SELECT pg_temp.emails_reconcile_bool('email_agent_settings', 'use_network_tools', true);

  -- Drop the restrictive legacy CHECK constraints the ad-hoc tables carried but a
  -- fresh migration does not impose. The self-hosted-only server writes values the
  -- old enums reject (provider='external'/'local', additional triage labels,
  -- digest periods, event types, mailbox source types, statuses, and modes beyond
  -- 'app-copy'), so keeping them would fault the 0009 seed AND runtime writes.
  SELECT pg_temp.emails_drop_constraint('domains',              'domains_dkim_status_check');
  SELECT pg_temp.emails_drop_constraint('domains',              'domains_dmarc_status_check');
  SELECT pg_temp.emails_drop_constraint('domains',              'domains_spf_status_check');
  SELECT pg_temp.emails_drop_constraint('email_agent_settings', 'email_agent_settings_provider_check');
  SELECT pg_temp.emails_drop_constraint('email_agent_runs',     'email_agent_runs_provider_check');
  SELECT pg_temp.emails_drop_constraint('email_agent_runs',     'email_agent_runs_status_check');
  SELECT pg_temp.emails_drop_constraint('email_agent_runs',     'email_agent_runs_priority_check');
  SELECT pg_temp.emails_drop_constraint('email_agent_runs',     'email_agent_runs_risk_score_check');
  SELECT pg_temp.emails_drop_constraint('email_digests',        'email_digests_provider_check');
  SELECT pg_temp.emails_drop_constraint('email_digests',        'email_digests_period_check');
  SELECT pg_temp.emails_drop_constraint('email_digests',        'email_digests_status_check');
  SELECT pg_temp.emails_drop_constraint('email_triage',         'email_triage_label_check');
  SELECT pg_temp.emails_drop_constraint('email_triage',         'email_triage_priority_check');
  SELECT pg_temp.emails_drop_constraint('email_triage',         'email_triage_sentiment_check');
  SELECT pg_temp.emails_drop_constraint('events',               'events_type_check');
  SELECT pg_temp.emails_drop_constraint('forwarding_rules',     'forwarding_rules_mode_check');
  SELECT pg_temp.emails_drop_constraint('mailbox_sources',      'mailbox_sources_status_check');
  SELECT pg_temp.emails_drop_constraint('mailbox_sources',      'mailbox_sources_type_check');
  SELECT pg_temp.emails_drop_constraint('scheduled_emails',     'scheduled_emails_status_check');
  SELECT pg_temp.emails_drop_constraint('sequences',            'sequences_status_check');
  SELECT pg_temp.emails_drop_constraint('sequence_enrollments', 'sequence_enrollments_status_check');
  SELECT pg_temp.emails_drop_constraint('warming_schedules',    'warming_schedules_status_check');

  -- Drop the legacy FOREIGN KEYs into tables the self-hosted-only server no longer
  -- uses (providers, groups, inbound_emails, emails, mailboxes, ...). The server
  -- writes ids that live elsewhere (self_hosted_providers, messages, contact_groups)
  -- or are external, so these FKs reject its inserts. A fresh migration has none.
  SELECT pg_temp.emails_drop_constraint('domains',                  'domains_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('addresses',                'addresses_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('send_keys',                'send_keys_owner_id_fkey');
  SELECT pg_temp.emails_drop_constraint('scheduled_emails',         'scheduled_emails_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('forwarding_rules',         'forwarding_rules_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('warming_schedules',        'warming_schedules_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('email_triage',             'email_triage_email_id_fkey');
  SELECT pg_temp.emails_drop_constraint('email_triage',             'email_triage_inbound_email_id_fkey');
  SELECT pg_temp.emails_drop_constraint('email_agent_runs',         'email_agent_runs_inbound_email_id_fkey');
  SELECT pg_temp.emails_drop_constraint('events',                   'events_email_id_fkey');
  SELECT pg_temp.emails_drop_constraint('events',                   'events_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('mailbox_sources',          'mailbox_sources_mailbox_id_fkey');
  SELECT pg_temp.emails_drop_constraint('mailbox_sources',          'mailbox_sources_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('sandbox_emails',           'sandbox_emails_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('sequence_steps',           'sequence_steps_sequence_id_fkey');
  SELECT pg_temp.emails_drop_constraint('sequence_enrollments',     'sequence_enrollments_sequence_id_fkey');
  SELECT pg_temp.emails_drop_constraint('sequence_enrollments',     'sequence_enrollments_provider_id_fkey');
  SELECT pg_temp.emails_drop_constraint('group_members',            'group_members_group_id_fkey');
  SELECT pg_temp.emails_drop_constraint('address_ownership_events', 'address_ownership_events_address_id_fkey');
  SELECT pg_temp.emails_drop_constraint('address_ownership_events', 'address_ownership_events_owner_id_fkey');
  SELECT pg_temp.emails_drop_constraint('address_ownership_events', 'address_ownership_events_administrator_id_fkey');
  SELECT pg_temp.emails_drop_constraint('address_ownership_events', 'address_ownership_events_previous_owner_id_fkey');
  SELECT pg_temp.emails_drop_constraint('address_ownership_events', 'address_ownership_events_previous_administrator_id_fkey');

  -- Add columns the fresh schema carries but a legacy ad-hoc table is missing.
  -- The audit-style tables only had created_at (the generic updater needs
  -- updated_at); legacy group_members / sequence_enrollments lacked id/timestamps.
  SELECT pg_temp.emails_add_column('address_ownership_events', 'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('email_agent_runs',         'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('email_digests',            'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('email_triage',             'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('events',                   'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('provisioning_events',      'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('sandbox_emails',           'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('scheduled_emails',         'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('send_keys',                'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('sequence_steps',           'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('sequence_enrollments',     'created_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('sequence_enrollments',     'updated_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('group_members',            'id',         'text');
  SELECT pg_temp.emails_add_column('group_members',            'created_at', 'timestamptz NOT NULL DEFAULT now()');
  SELECT pg_temp.emails_add_column('group_members',            'updated_at', 'timestamptz NOT NULL DEFAULT now()');

  -- Relax legacy NOT NULL columns the fresh schema made nullable or dropped, so
  -- server inserts that omit them (the new server never populates these) succeed.
  SELECT pg_temp.emails_relax_not_null('domains',          'provider_id');
  SELECT pg_temp.emails_relax_not_null('addresses',        'provider_id');
  SELECT pg_temp.emails_relax_not_null('send_keys',        'key_hash');
  SELECT pg_temp.emails_relax_not_null('send_keys',        'owner_id');
  SELECT pg_temp.emails_relax_not_null('send_keys',        'prefix');
  SELECT pg_temp.emails_relax_not_null('email_agent_runs', 'started_at');
  SELECT pg_temp.emails_relax_not_null('email_agent_runs', 'completed_at');
  SELECT pg_temp.emails_relax_not_null('email_digests',    'started_at');
  SELECT pg_temp.emails_relax_not_null('email_digests',    'completed_at');
  SELECT pg_temp.emails_relax_not_null('events',           'provider_id');
  SELECT pg_temp.emails_relax_not_null('scheduled_emails', 'from_address');
  SELECT pg_temp.emails_relax_not_null('scheduled_emails', 'provider_id');
  SELECT pg_temp.emails_relax_not_null('scheduled_emails', 'scheduled_at');
  SELECT pg_temp.emails_relax_not_null('warming_schedules', 'start_date');

  -- Restore fresh-schema DEFAULTs on legacy NOT NULL columns that lost them, so a
  -- server insert omitting the column gets the value a fresh DB would.
  SELECT pg_temp.emails_set_text_default('aliases',          'target_address',      '');
  SELECT pg_temp.emails_set_text_default('mailbox_sources',  'name',                '');
  SELECT pg_temp.emails_set_text_default('owners',           'type',                'human');
  SELECT pg_temp.emails_set_text_default('sandbox_emails',   'subject',             '');
  SELECT pg_temp.emails_set_text_default('scheduled_emails', 'subject',             '');
  SELECT pg_temp.emails_set_text_default('sequence_steps',   'template_name',       '');
  SELECT pg_temp.emails_set_text_default('templates',        'subject_template',    '');
  SELECT pg_temp.emails_set_expr_default('email_digests',    'since',               'now()');
  SELECT pg_temp.emails_set_expr_default('email_digests',    'until',               'now()');
  SELECT pg_temp.emails_set_expr_default('events',           'occurred_at',         'now()');
  SELECT pg_temp.emails_set_expr_default('sequence_steps',   'step_number',         '0');
  SELECT pg_temp.emails_set_expr_default('warming_schedules', 'target_daily_volume', '0');

  -- Guarantee the ON CONFLICT (agent_key) arbiter exists even on an ad-hoc table
  -- that was created without the PRIMARY KEY. Redundant-but-harmless on a fresh
  -- DB (agent_key is already the primary key).
  CREATE UNIQUE INDEX IF NOT EXISTS email_agent_settings_agent_key_uidx
    ON email_agent_settings (agent_key);

  INSERT INTO email_agent_settings (agent_key, enabled, always_on, provider, model, apply_labels, use_network_tools, config_json)
  VALUES
    ('categorizer', FALSE, FALSE, 'external', 'external-summary', FALSE, TRUE, '{}'::jsonb),
    ('labeler',     FALSE, FALSE, 'external', 'external-summary', TRUE,  TRUE, '{}'::jsonb),
    ('fraud',       FALSE, FALSE, 'external', 'external-summary', TRUE,  TRUE, '{}'::jsonb)
  ON CONFLICT (agent_key) DO NOTHING;

  CREATE TABLE IF NOT EXISTS email_agent_runs (
    id               TEXT PRIMARY KEY,
    agent_key        TEXT NOT NULL,
    inbound_email_id TEXT NOT NULL,
    provider         TEXT NOT NULL,
    model            TEXT NOT NULL,
    status           TEXT NOT NULL,
    category         TEXT,
    labels_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
    priority         INTEGER,
    confidence       DOUBLE PRECISION,
    risk_score       INTEGER,
    summary          TEXT,
    reasoning        TEXT,
    tool_calls_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
    output_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
    error            TEXT,
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(agent_key, inbound_email_id)
  );
  CREATE INDEX IF NOT EXISTS email_agent_runs_agent_status_idx ON email_agent_runs (agent_key, status, completed_at);
  CREATE INDEX IF NOT EXISTS email_agent_runs_inbound_idx ON email_agent_runs (inbound_email_id);

  CREATE TABLE IF NOT EXISTS email_digests (
    id                       TEXT PRIMARY KEY,
    period                   TEXT NOT NULL,
    since                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    until                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    provider                 TEXT NOT NULL,
    model                    TEXT NOT NULL,
    status                   TEXT NOT NULL,
    message_count            INTEGER NOT NULL DEFAULT 0,
    summary                  TEXT,
    highlights_json          JSONB NOT NULL DEFAULT '[]'::jsonb,
    action_items_json        JSONB NOT NULL DEFAULT '[]'::jsonb,
    important_email_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    label_counts_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    error                    TEXT,
    started_at               TIMESTAMPTZ,
    completed_at             TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS email_digests_period_completed_idx ON email_digests (period, status, completed_at);
  `,
), [
  // Prior 0009 bodies, accepted so any database that already applied one on a
  // fresh schema — where the CREATE TABLE statements created every column as its
  // fresh type, making the added reconcile a pure no-op — stays compatible.
  // Databases where 0009 is still pending run the corrected reconcile-safe body
  // above. (Neither prior body applied on the drifted prod schema: the original
  // failed on the boolean seed, the round-1 body failed on the legacy CHECK.)
  //
  //   - Original body (before any drifted-schema reconcile).
  "sha256:9ed139ed978774cd0e7dd616a86328ad47d2ad3a118d980e87995a8819263450",
  //   - Round-1 body (boolean reconcile only; published in fd06a18).
  "sha256:1232715b3e81b43e7dc422f12aa458d767da2763063ce57c166ccede32bcb7b0",
]);

/**
 * Provisioning lifecycle STATE columns on domains and addresses (the local
 * store carried these on its domains/addresses tables — migration 19 there).
 * The audit trail is the separate provisioning_events table (0009). All columns
 * are additive and nullable/defaulted so existing rows and readers are
 * unaffected; nameservers are a JSONB array.
 */
const PROVISIONING_COLUMNS = defineMigration(
  "0010_emails_selfhosted_provisioning_columns",
  `
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS provisioning_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS purchase_provider TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS dns_provider TEXT NOT NULL DEFAULT 'cloudflare';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS send_provider TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS cf_zone_id TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS registrar TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS nameservers_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS mail_from_domain TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS last_error TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;

  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS domain_id TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS receive_strategy TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS forward_to TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS routing_rule_id TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS provisioning_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS last_error TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS domains_provstatus_idx ON domains (provisioning_status);
  CREATE INDEX IF NOT EXISTS addresses_provstatus_idx ON addresses (provisioning_status);
  CREATE INDEX IF NOT EXISTS addresses_domain_id_idx ON addresses (domain_id);
  `,
);

/**
 * Self-hosted-only PARITY tables, round 2. Closes the remaining gaps where the
 * self-hosted client routed a resource through the generic /v1 store that had no
 * server table yet (it 404'd at runtime): contact-group membership, sequence
 * steps + enrollments, the address-ownership audit trail, the webhook
 * idempotency ledger, and captured sandbox outbound. Also adds the
 * owner_id/administrator_id ownership columns the client PATCHes onto
 * /v1/addresses, and a SEPARATE send_key_secrets table (never a /v1 resource) so
 * the server can verify a send-key token without the generic `SELECT *` resource
 * path ever exposing the hash. Every column mirrors the client's expected fields
 * in snake_case; JSON columns are JSONB and every table carries
 * created_at/updated_at so the generic updater works uniformly.
 */
const PARITY_RESOURCE_SCHEMA_2 = defineMigration(
  "0011_emails_selfhosted_parity_tables_2",
  `
  CREATE TABLE IF NOT EXISTS group_members (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL,
    email       TEXT NOT NULL,
    name        TEXT,
    -- TEXT (not jsonb): the client sends this pre-serialized, mirroring the
    -- original local SQLite column; the JSON string is stored verbatim.
    vars        TEXT NOT NULL DEFAULT '{}',
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(group_id, email)
  );
  CREATE INDEX IF NOT EXISTS group_members_group_idx ON group_members (group_id);

  CREATE TABLE IF NOT EXISTS sequence_steps (
    id               TEXT PRIMARY KEY,
    sequence_id      TEXT NOT NULL,
    step_number      INTEGER NOT NULL DEFAULT 0,
    delay_hours      INTEGER NOT NULL DEFAULT 0,
    template_name    TEXT NOT NULL DEFAULT '',
    from_address     TEXT,
    subject_override TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS sequence_steps_sequence_idx ON sequence_steps (sequence_id, step_number);

  CREATE TABLE IF NOT EXISTS sequence_enrollments (
    id            TEXT PRIMARY KEY,
    sequence_id   TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    provider_id   TEXT,
    current_step  INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active',
    enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_send_at  TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS sequence_enrollments_sequence_idx ON sequence_enrollments (sequence_id, status);
  CREATE INDEX IF NOT EXISTS sequence_enrollments_due_idx ON sequence_enrollments (status, next_send_at);

  CREATE TABLE IF NOT EXISTS address_ownership_events (
    id                        TEXT PRIMARY KEY,
    address_id                TEXT NOT NULL,
    action                    TEXT NOT NULL,
    previous_owner_id         TEXT,
    previous_administrator_id TEXT,
    owner_id                  TEXT,
    administrator_id          TEXT,
    actor                     TEXT,
    reason                    TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS address_ownership_events_address_idx ON address_ownership_events (address_id, created_at);

  CREATE TABLE IF NOT EXISTS webhook_receipts (
    id           TEXT PRIMARY KEY,
    provider     TEXT NOT NULL,
    event_id     TEXT NOT NULL,
    resource_id  TEXT,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS webhook_receipts_lookup_idx ON webhook_receipts (provider, event_id);

  CREATE TABLE IF NOT EXISTS sandbox_emails (
    id               TEXT PRIMARY KEY,
    provider_id      TEXT NOT NULL,
    from_address     TEXT NOT NULL,
    to_addresses     JSONB NOT NULL DEFAULT '[]'::jsonb,
    cc_addresses     JSONB NOT NULL DEFAULT '[]'::jsonb,
    bcc_addresses    JSONB NOT NULL DEFAULT '[]'::jsonb,
    reply_to         TEXT,
    subject          TEXT NOT NULL DEFAULT '',
    html             TEXT,
    text_body        TEXT,
    -- TEXT (not jsonb): the client sends these pre-serialized, mirroring the
    -- original local SQLite columns; the JSON string is stored verbatim.
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json     TEXT NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS sandbox_emails_provider_idx ON sandbox_emails (provider_id, created_at);

  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS owner_id TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS administrator_id TEXT;
  CREATE INDEX IF NOT EXISTS addresses_owner_idx ON addresses (owner_id);
  CREATE INDEX IF NOT EXISTS addresses_administrator_idx ON addresses (administrator_id);

  -- Secret store for scoped send keys. Kept OUT of the generic /v1 resource
  -- registry so no resource path can ever return a key hash: the send-keys
  -- resource stays summary-only, and verification reads the hash here directly.
  CREATE TABLE IF NOT EXISTS send_key_secrets (
    id           TEXT PRIMARY KEY,
    send_key_id  TEXT NOT NULL UNIQUE,
    key_hash     TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS send_key_secrets_key_idx ON send_key_secrets (send_key_id);
  `,
);

/**
 * Fixed sentinel id of the DEFAULT tenant. Every pre-tenancy row and every
 * pre-existing credential is backfilled to this tenant by 0012, so the
 * currently-deployed single operator keeps working unchanged after tenancy
 * lands. Exported for tests + the auth/store layers that resolve it.
 */
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * 0012 — Multi-tenancy: identity tables + tenant_id on every data table +
 * backfill into the default tenant. Design ref: docs/design/multi-tenancy-auth.md
 * §3, §9 (the "0012_emails_tenancy_identity_and_backfill" migration).
 *
 * SAFETY POSTURE (this is additive, zero-downtime, and drift-aware):
 *
 *   - Idempotent. ADD COLUMN / CREATE TABLE / CREATE INDEX are all IF NOT EXISTS;
 *     constraint/PK changes are discovered from the catalog and guarded, so a 2nd
 *     run (or a run over a partially-migrated DB) is a clean no-op.
 *
 *   - Drift-aware. The PROD database is the drifted ad-hoc schema (see 0009). The
 *     old per-table UNIQUE is NOT named consistently there — e.g. domains carries
 *     `domains_provider_id_domain_key (provider_id, domain)`, not the fresh
 *     `domains_domain_key (domain)`; group_members' `(group_id, email)` is a
 *     PRIMARY KEY on prod but a plain UNIQUE on a fresh DB. So the composite-unique
 *     swaps DISCOVER the old constraint by its exact column set via pg_constraint
 *     (helper `emails_drop_unique`) rather than hard-coding names — mirroring the
 *     0009 reconcile discipline.
 *
 *   - Transitional DEFAULT. tenant_id is added with a transitional DEFAULT of the
 *     default tenant, THEN backfilled, THEN set NOT NULL. So an in-flight insert
 *     from still-running old code during the deploy window lands in the default
 *     tenant instead of erroring (the DEFAULT is dropped later, in 0013).
 *
 *   - Old-code ON CONFLICT preserved (zero-downtime). The shipped v1.0.0 store
 *     (untouched in this phase) infers ON CONFLICT on exactly three single-column
 *     uniques: messages(idempotency_key), messages(source_id), and
 *     email_agent_settings(agent_key). Dropping those before the store is updated
 *     (Phase 1) would crash the running server. So for those three we ADD the new
 *     tenant-scoped unique and RETAIN the legacy single-column one transitionally;
 *     0013 drops the legacy ones once the store uses the composite conflict target.
 *     Every OTHER old unique (no ON CONFLICT dependency) IS swapped now.
 *
 *   - RLS is NOT enabled here (that is 0013, contingent on a separate NOBYPASSRLS
 *     serving role — design §6 Layer 2). The identity tables are deliberately kept
 *     OUT of SELF_HOSTED_RESOURCES (like send_key_secrets), so the generic
 *     `SELECT *` resource layer can never reach a password_hash / token_hash.
 */
const TENANCY_IDENTITY_AND_BACKFILL = defineMigration(
  "0012_emails_tenancy_identity_and_backfill",
  `
  -- 0. extension for case-insensitive, globally-unique user emails.
  CREATE EXTENSION IF NOT EXISTS citext;

  -- ---- drift-aware reconcile helpers (session-temp; mirror 0009) -------------

  -- Add tenant_id to a data table: transitional DEFAULT -> backfill -> NOT NULL,
  -- then FK to tenants(id) + a lookup index. Guarded on table existence and every
  -- step is idempotent, so it is safe on fresh, drifted, and already-migrated DBs.
  CREATE OR REPLACE FUNCTION pg_temp.emails_add_tenant(tbl text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    fk_name  text := tbl || '_tenant_fk';
    idx_name text := tbl || '_tenant_idx';
  BEGIN
    IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid', tbl);
    EXECUTE format('UPDATE public.%I SET tenant_id = %L WHERE tenant_id IS NULL', tbl, '${DEFAULT_TENANT_ID}');
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT %L', tbl, '${DEFAULT_TENANT_ID}');
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', tbl);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = ('public.' || tbl)::regclass AND conname = fk_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)',
        tbl, fk_name);
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)', idx_name, tbl);
  END;
  $fn$;

  -- Drop any UNIQUE or PRIMARY KEY constraint on tbl whose column set is EXACTLY
  -- cols (order-insensitive), regardless of its name. This is how the old global
  -- unique is removed drift-safely: prod and fresh name it differently, and on
  -- group_members it is a PK on prod but a UNIQUE on a fresh DB. No-op when no
  -- such constraint exists (already swapped, or a drifted table that never had it).
  CREATE OR REPLACE FUNCTION pg_temp.emails_drop_unique(tbl text, cols text[])
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    target text[] := (SELECT array_agg(x ORDER BY x) FROM unnest(cols) AS x);
    rec    record;
  BEGIN
    IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;
    FOR rec IN
      SELECT c.conname
      FROM pg_constraint c
      WHERE c.conrelid = ('public.' || tbl)::regclass
        AND c.contype IN ('u', 'p')
        AND (
          SELECT array_agg(att.attname::text ORDER BY att.attname::text)
          FROM unnest(c.conkey) AS k(attnum)
          JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.attnum
        ) = target
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', tbl, rec.conname);
    END LOOP;
  END;
  $fn$;

  -- Create a tenant-scoped UNIQUE INDEX (trusted column list from this file).
  CREATE OR REPLACE FUNCTION pg_temp.emails_add_unique(tbl text, idx_name text, cols_sql text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (%s)', idx_name, tbl, cols_sql);
  END;
  $fn$;

  -- Replace a table's PRIMARY KEY with pk_cols (idempotent: no-op if already the
  -- target set). Used for email_agent_settings: (agent_key) -> (tenant_id, agent_key).
  CREATE OR REPLACE FUNCTION pg_temp.emails_set_pk(tbl text, pk_cols text[])
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    existing_name text;
    existing_cols text[];
    target        text[] := (SELECT array_agg(x ORDER BY x) FROM unnest(pk_cols) AS x);
    col           text;
  BEGIN
    IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;
    -- Every PK column must be NOT NULL before ADD PRIMARY KEY.
    FOREACH col IN ARRAY pk_cols LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET NOT NULL', tbl, col);
    END LOOP;
    SELECT c.conname,
           (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
            FROM unnest(c.conkey) AS k(attnum)
            JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.attnum)
      INTO existing_name, existing_cols
      FROM pg_constraint c
      WHERE c.conrelid = ('public.' || tbl)::regclass AND c.contype = 'p';
    IF existing_cols IS NOT DISTINCT FROM target THEN
      RETURN; -- already the desired composite PK
    END IF;
    IF existing_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', tbl, existing_name);
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I ADD PRIMARY KEY (%s)',
      tbl,
      (SELECT string_agg(quote_ident(x), ', ' ORDER BY ord)
       FROM unnest(pk_cols) WITH ORDINALITY AS u(x, ord)));
  END;
  $fn$;

  -- Collapse pre-existing DUPLICATE DATA on a soon-to-be composite-unique target
  -- BEFORE its UNIQUE INDEX is built. Backfilling every row to one default tenant
  -- turns any OLD global-unique collision into a WITHIN-tenant collision, so a DB
  -- that carries duplicate data (prod does, on a subset of the 12 targets) would
  -- fault the CREATE UNIQUE INDEX. This helper is generic over ALL targets (future
  -- dup data is handled the same way), a STRICT no-op when a group has no dups, and
  -- safe to re-run (after it runs once there are no dups left to find).
  --
  -- Survivor rule (deterministic + stable): within each (tenant_id, <natural key>)
  -- group keep the row with (a) the MOST id-based dependents, then (b) the most
  -- recent updated_at, then created_at, then (c) the lexicographically-lowest id.
  -- Reparenting only ever MOVES a loser's dependents onto the survivor (the max),
  -- so the survivor stays the max — the choice is invariant under the reparent.
  --
  -- refs describes the id-based reference graph to reparent, discovered from the
  -- schema. These are LOOSE TEXT columns (the prod FKs were dropped in 0009 and a
  -- fresh DB never declared them), so pg_constraint cannot be trusted to enumerate
  -- them; the caller passes each edge explicitly as 'child_table:child_col', or, for
  -- the POLYMORPHIC provisioning_events(entity_type, entity_id) audit rows, as
  -- 'child_table:child_col:entity_type'. Messages reference addresses by email
  -- STRING (from_addr/to_addrs), not id, so they are intentionally NOT reparented.
  CREATE TEMP TABLE IF NOT EXISTS emails_dedup_plan (
    parent      text NOT NULL,
    loser_id    text NOT NULL,
    survivor_id text NOT NULL
  );

  CREATE OR REPLACE FUNCTION pg_temp.emails_dedup(tbl text, natural_cols text[], refs text[])
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    partition_sql text := 't.tenant_id';
    dep_sql       text := '0';
    ts_order      text := '';
    spec          text;
    parts         text[];
    child_tbl     text;
    child_col     text;
    etype         text;
  BEGIN
    IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;

    -- partition key = tenant_id + the natural-key columns
    SELECT partition_sql || COALESCE(string_agg(', t.' || quote_ident(c), '' ORDER BY ord), '')
      INTO partition_sql
      FROM unnest(natural_cols) WITH ORDINALITY AS u(c, ord);

    -- dependent-count expression across the reference graph (skip absent tables/cols)
    FOREACH spec IN ARRAY refs LOOP
      parts     := string_to_array(spec, ':');
      child_tbl := parts[1];
      child_col := parts[2];
      etype     := parts[3];  -- NULL for a direct id ref; set for a polymorphic ref
      IF to_regclass('public.' || child_tbl) IS NULL THEN CONTINUE; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = ('public.' || child_tbl)::regclass
          AND attname = child_col AND attnum > 0 AND NOT attisdropped
      ) THEN CONTINUE; END IF;
      IF etype IS NULL THEN
        dep_sql := dep_sql || format(
          ' + COALESCE((SELECT count(*) FROM public.%I d WHERE d.%I = s.id), 0)',
          child_tbl, child_col);
      ELSE
        dep_sql := dep_sql || format(
          ' + COALESCE((SELECT count(*) FROM public.%I d WHERE d.entity_type = %L AND d.%I = s.id), 0)',
          child_tbl, etype, child_col);
      END IF;
    END LOOP;

    -- recency tiebreaks, only for timestamp columns that actually exist (drift-safe)
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ('public.' || tbl)::regclass
                 AND attname = 'updated_at' AND attnum > 0 AND NOT attisdropped) THEN
      ts_order := ts_order || 't.updated_at DESC NULLS LAST, ';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ('public.' || tbl)::regclass
                 AND attname = 'created_at' AND attnum > 0 AND NOT attisdropped) THEN
      ts_order := ts_order || 't.created_at DESC NULLS LAST, ';
    END IF;

    -- stage the loser -> survivor plan for this table (per-parent idempotent).
    -- _dep is materialised in an inner select so the window ORDER BY is a plain
    -- column reference; first_value over the same window yields the group survivor.
    DELETE FROM pg_temp.emails_dedup_plan WHERE parent = tbl;
    EXECUTE format($q$
      INSERT INTO pg_temp.emails_dedup_plan (parent, loser_id, survivor_id)
      SELECT %L, ranked.id, ranked.survivor
      FROM (
        SELECT t.id AS id,
               first_value(t.id) OVER w AS survivor,
               row_number()      OVER w AS rn
        FROM (SELECT s.*, (%s) AS _dep FROM public.%I s) t
        WINDOW w AS (PARTITION BY %s ORDER BY t._dep DESC, %s t.id ASC)
      ) ranked
      WHERE ranked.rn > 1 AND ranked.id IS NOT NULL AND ranked.survivor IS NOT NULL
    $q$, tbl, dep_sql, tbl, partition_sql, ts_order);

    IF NOT EXISTS (SELECT 1 FROM pg_temp.emails_dedup_plan WHERE parent = tbl) THEN
      RETURN;  -- no duplicates: strict no-op
    END IF;

    -- reparent every id-based reference from the losers onto the survivor FIRST
    FOREACH spec IN ARRAY refs LOOP
      parts     := string_to_array(spec, ':');
      child_tbl := parts[1];
      child_col := parts[2];
      etype     := parts[3];
      IF to_regclass('public.' || child_tbl) IS NULL THEN CONTINUE; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = ('public.' || child_tbl)::regclass
          AND attname = child_col AND attnum > 0 AND NOT attisdropped
      ) THEN CONTINUE; END IF;
      IF etype IS NULL THEN
        EXECUTE format($q$
          UPDATE public.%I d SET %I = p.survivor_id
          FROM pg_temp.emails_dedup_plan p
          WHERE p.parent = %L AND d.%I = p.loser_id
        $q$, child_tbl, child_col, tbl, child_col);
      ELSE
        EXECUTE format($q$
          UPDATE public.%I d SET %I = p.survivor_id
          FROM pg_temp.emails_dedup_plan p
          WHERE p.parent = %L AND d.entity_type = %L AND d.%I = p.loser_id
        $q$, child_tbl, child_col, tbl, etype, child_col);
      END IF;
    END LOOP;

    -- then delete the losers, now that nothing id-references them
    EXECUTE format($q$
      DELETE FROM public.%I t
      USING pg_temp.emails_dedup_plan p
      WHERE p.parent = %L AND t.id = p.loser_id
    $q$, tbl, tbl);

    DELETE FROM pg_temp.emails_dedup_plan WHERE parent = tbl;
  END;
  $fn$;

  -- ---- 1. identity + resolution tables (NOT tenant-scoped; §3.1) -------------
  -- These are read BEFORE a tenant is known (they resolve it), and they hold
  -- secrets (password_hash / token_hash). They are deliberately absent from
  -- SELF_HOSTED_RESOURCES, so no generic SELECT * path can ever reach them.

  CREATE TABLE IF NOT EXISTS tenants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
    name       text NOT NULL,
    status     text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS users (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email              citext NOT NULL UNIQUE,
    password_hash      text NOT NULL,
    name               text,
    status             text NOT NULL DEFAULT 'active',
    email_verified_at  timestamptz,
    failed_login_count integer NOT NULL DEFAULT 0,
    locked_until       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    status     text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, tenant_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_tenant_idx ON memberships (tenant_id);
  CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    token_hash          text NOT NULL UNIQUE,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz,
    expires_at          timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    revoked_at          timestamptz,
    user_agent          text,
    ip                  inet
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

  CREATE TABLE IF NOT EXISTS api_key_tenants (
    kid                text PRIMARY KEY,
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_by_user_id uuid REFERENCES users(id),
    created_at         timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS api_key_tenants_tenant_idx ON api_key_tenants (tenant_id);

  CREATE TABLE IF NOT EXISTS invitations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       citext NOT NULL,
    role        text NOT NULL CHECK (role IN ('owner','admin','member')),
    token_hash  text NOT NULL UNIQUE,
    invited_by  uuid REFERENCES users(id),
    expires_at  timestamptz NOT NULL,
    accepted_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  -- one open (un-accepted) invite per email per tenant
  CREATE UNIQUE INDEX IF NOT EXISTS invitations_open_uidx
    ON invitations (tenant_id, email) WHERE accepted_at IS NULL;
  CREATE INDEX IF NOT EXISTS invitations_tenant_idx ON invitations (tenant_id);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

  -- Email confirmation tokens (design Addendum A2). Signup creates the user
  -- UNVERIFIED; login is refused until a token from this table is consumed. Like
  -- every other auth table it holds only the sha256 token_hash (never the token),
  -- is single-use (used_at) and short-TTL (expires_at), and is deliberately absent
  -- from SELF_HOSTED_RESOURCES so no generic SELECT * path can reach it.
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      citext NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens (user_id);

  -- Non-RLS resolution tables: read before a tenant GUC exists (design §6 H2/C1).
  -- inbound_domain_routes = the global single-tenant receive map (one physical
  -- domain -> exactly one tenant), used for envelope-recipient inbound routing.
  CREATE TABLE IF NOT EXISTS inbound_domain_routes (
    domain     text PRIMARY KEY,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS inbound_domain_routes_tenant_idx ON inbound_domain_routes (tenant_id);

  -- send_key_tenants = credential -> tenant map (mirrors api_key_tenants), so a
  -- send-key token resolves its tenant WITHOUT reading the (future) RLS-forced
  -- send_keys table.
  CREATE TABLE IF NOT EXISTS send_key_tenants (
    send_key_id text PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS send_key_tenants_tenant_idx ON send_key_tenants (tenant_id);

  -- ---- 2. default tenant (fixed sentinel for deterministic backfill) ---------
  INSERT INTO tenants (id, slug, name, status)
  VALUES ('${DEFAULT_TENANT_ID}', 'default', 'Default Tenant', 'active')
  ON CONFLICT (id) DO NOTHING;

  -- ---- 3. tenant_id on every data table (all 27) -----------------------------
  SELECT pg_temp.emails_add_tenant('domains');
  SELECT pg_temp.emails_add_tenant('addresses');
  SELECT pg_temp.emails_add_tenant('messages');
  SELECT pg_temp.emails_add_tenant('contacts');
  SELECT pg_temp.emails_add_tenant('self_hosted_providers');
  SELECT pg_temp.emails_add_tenant('templates');
  SELECT pg_temp.emails_add_tenant('contact_groups');
  SELECT pg_temp.emails_add_tenant('sequences');
  SELECT pg_temp.emails_add_tenant('owners');
  SELECT pg_temp.emails_add_tenant('send_keys');
  SELECT pg_temp.emails_add_tenant('scheduled_emails');
  SELECT pg_temp.emails_add_tenant('aliases');
  SELECT pg_temp.emails_add_tenant('forwarding_rules');
  SELECT pg_temp.emails_add_tenant('warming_schedules');
  SELECT pg_temp.emails_add_tenant('email_triage');
  SELECT pg_temp.emails_add_tenant('provisioning_events');
  SELECT pg_temp.emails_add_tenant('mailbox_sources');
  SELECT pg_temp.emails_add_tenant('events');
  SELECT pg_temp.emails_add_tenant('email_agent_settings');
  SELECT pg_temp.emails_add_tenant('email_agent_runs');
  SELECT pg_temp.emails_add_tenant('email_digests');
  SELECT pg_temp.emails_add_tenant('group_members');
  SELECT pg_temp.emails_add_tenant('sequence_steps');
  SELECT pg_temp.emails_add_tenant('sequence_enrollments');
  SELECT pg_temp.emails_add_tenant('address_ownership_events');
  SELECT pg_temp.emails_add_tenant('webhook_receipts');
  SELECT pg_temp.emails_add_tenant('sandbox_emails');

  -- ---- 4. swap global uniques -> per-tenant composites (§3.3) ----------------
  -- Safe to drop the old unique for these (the shipped store never ON CONFLICTs on
  -- them): drop the old (discovered by column set), add the tenant-scoped unique.
  -- domains/addresses: the drifted PROD schema carries the old unique on
  -- (provider_id, <col>), NOT the fresh (<col>) — a different COLUMN SET, not just
  -- a different name — so drop BOTH variants.
  -- Each swap: drop the old global unique (discovered by column set), DEDUP any
  -- pre-existing (tenant_id, <natural key>) duplicate data (reparenting id-based
  -- references onto the deterministic survivor first), then add the tenant-scoped
  -- unique. The dedup runs BEFORE the CREATE UNIQUE INDEX and is a no-op when clean.
  --
  -- ORDER MATTERS across tables: a parent's dedup reparents CHILD *_id columns, and
  -- that reparent can itself create a within-tenant duplicate in a child that is
  -- ALSO a composite target (contact_groups -> group_members.group_id), so the
  -- child must be deduped AFTER its parent. domains is deduped before addresses (it
  -- reparents addresses.domain_id); contact_groups before group_members.
  SELECT pg_temp.emails_drop_unique('domains', ARRAY['domain']);
  SELECT pg_temp.emails_drop_unique('domains', ARRAY['provider_id','domain']);
  SELECT pg_temp.emails_dedup('domains', ARRAY['domain'],
    ARRAY['addresses:domain_id', 'provisioning_events:entity_id:domain']);
  SELECT pg_temp.emails_add_unique('domains', 'domains_tenant_domain_uidx', 'tenant_id, domain');

  SELECT pg_temp.emails_drop_unique('addresses', ARRAY['email']);
  SELECT pg_temp.emails_drop_unique('addresses', ARRAY['provider_id','email']);
  SELECT pg_temp.emails_dedup('addresses', ARRAY['email'],
    ARRAY['address_ownership_events:address_id', 'provisioning_events:entity_id:address']);
  SELECT pg_temp.emails_add_unique('addresses', 'addresses_tenant_email_uidx', 'tenant_id, email');

  SELECT pg_temp.emails_drop_unique('contacts', ARRAY['email']);
  SELECT pg_temp.emails_dedup('contacts', ARRAY['email'], ARRAY[]::text[]);
  SELECT pg_temp.emails_add_unique('contacts', 'contacts_tenant_email_uidx', 'tenant_id, email');

  SELECT pg_temp.emails_drop_unique('templates', ARRAY['name']);
  SELECT pg_temp.emails_dedup('templates', ARRAY['name'], ARRAY[]::text[]);
  SELECT pg_temp.emails_add_unique('templates', 'templates_tenant_name_uidx', 'tenant_id, name');

  SELECT pg_temp.emails_drop_unique('contact_groups', ARRAY['name']);
  SELECT pg_temp.emails_dedup('contact_groups', ARRAY['name'], ARRAY['group_members:group_id']);
  SELECT pg_temp.emails_add_unique('contact_groups', 'contact_groups_tenant_name_uidx', 'tenant_id, name');

  SELECT pg_temp.emails_drop_unique('warming_schedules', ARRAY['domain']);
  SELECT pg_temp.emails_dedup('warming_schedules', ARRAY['domain'], ARRAY[]::text[]);
  SELECT pg_temp.emails_add_unique('warming_schedules', 'warming_schedules_tenant_domain_uidx', 'tenant_id, domain');

  SELECT pg_temp.emails_drop_unique('aliases', ARRAY['domain','local_part']);
  SELECT pg_temp.emails_dedup('aliases', ARRAY['domain','local_part'], ARRAY[]::text[]);
  SELECT pg_temp.emails_add_unique('aliases', 'aliases_tenant_domain_local_part_uidx', 'tenant_id, domain, local_part');

  SELECT pg_temp.emails_drop_unique('forwarding_rules', ARRAY['source_address','target_address','mode']);
  SELECT pg_temp.emails_dedup('forwarding_rules', ARRAY['source_address','target_address','mode'], ARRAY[]::text[]);
  SELECT pg_temp.emails_add_unique('forwarding_rules', 'forwarding_rules_tenant_route_uidx', 'tenant_id, source_address, target_address, mode');

  SELECT pg_temp.emails_drop_unique('email_agent_runs', ARRAY['agent_key','inbound_email_id']);
  SELECT pg_temp.emails_dedup('email_agent_runs', ARRAY['agent_key','inbound_email_id'], ARRAY[]::text[]);
  SELECT pg_temp.emails_add_unique('email_agent_runs', 'email_agent_runs_tenant_agent_inbound_uidx', 'tenant_id, agent_key, inbound_email_id');

  SELECT pg_temp.emails_drop_unique('group_members', ARRAY['group_id','email']);
  SELECT pg_temp.emails_dedup('group_members', ARRAY['group_id','email'], ARRAY[]::text[]);
  SELECT pg_temp.emails_add_unique('group_members', 'group_members_tenant_group_email_uidx', 'tenant_id, group_id, email');

  -- messages: ADD the tenant-scoped partial uniques, but RETAIN the legacy
  -- single-column partial uniques so the untouched v1.0.0 store's
  -- ON CONFLICT (idempotency_key) / (source_id) still resolves during the deploy
  -- window. 0013 drops the legacy ones once the store uses the composite target.
  CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_source_id_uidx
    ON messages (tenant_id, source_id) WHERE source_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_idempotency_key_uidx
    ON messages (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

  -- email_agent_settings: PK (agent_key) -> (tenant_id, agent_key). The legacy
  -- agent_key-alone unique index (email_agent_settings_agent_key_uidx, from 0009)
  -- is RETAINED transitionally so the store's ON CONFLICT (agent_key) still
  -- resolves; 0013 drops it when per-tenant re-seed lands.
  SELECT pg_temp.emails_set_pk('email_agent_settings', ARRAY['tenant_id','agent_key']);

  -- webhook_receipts (§3.3 M2): no unique existed, so pre-existing rows may already
  -- duplicate (tenant_id, provider, event_id). Dedup via the same generic helper as
  -- every other target (nothing id-references a receipt, so there is no reference
  -- graph to reparent — it keeps the most-recent survivor), then add the unique.
  SELECT pg_temp.emails_dedup('webhook_receipts', ARRAY['provider','event_id'], ARRAY[]::text[]);
  SELECT pg_temp.emails_add_unique('webhook_receipts', 'webhook_receipts_tenant_provider_event_uidx', 'tenant_id, provider, event_id');

  -- ---- 5. backfill credential/resolution maps to the default tenant ----------
  -- Binds EVERY existing api key to the default tenant so the currently-deployed
  -- operator key keeps working (fail-closed 403 otherwise, design §4.3).
  DO $$
  BEGIN
    IF to_regclass('public.api_keys') IS NOT NULL THEN
      INSERT INTO api_key_tenants (kid, tenant_id)
      SELECT kid, '${DEFAULT_TENANT_ID}'::uuid FROM api_keys
      ON CONFLICT (kid) DO NOTHING;
    END IF;
    IF to_regclass('public.send_keys') IS NOT NULL THEN
      INSERT INTO send_key_tenants (send_key_id, tenant_id)
      SELECT id, '${DEFAULT_TENANT_ID}'::uuid FROM send_keys
      ON CONFLICT (send_key_id) DO NOTHING;
    END IF;
    IF to_regclass('public.domains') IS NOT NULL THEN
      INSERT INTO inbound_domain_routes (domain, tenant_id)
      SELECT domain, '${DEFAULT_TENANT_ID}'::uuid FROM domains WHERE domain IS NOT NULL
      ON CONFLICT (domain) DO NOTHING;
    END IF;
  END $$;
  `,
);

/**
 * 0013 — Row-Level Security backstop (design §6 Layer 2, §9 "0013" migration,
 * adversarial fixes H1/H2/H3/M1). This is the defense-in-depth layer BELOW the
 * typed scoped store (Layer 1, which already ships): even a handler that forgot to
 * scope a query cannot cross a tenant boundary, because Postgres itself filters
 * every row by the `app.current_tenant` GUC the scoped store sets per operation.
 *
 * ROLE MODEL (H1) — introspected against prod, NOT assumed. The serving role
 * `emails_app` is `rolsuper = false, rolbypassrls = false` AND owns every table
 * (all 57 public tables + schema `public`). A table owner bypasses RLS by default,
 * so FORCE ROW LEVEL SECURITY is REQUIRED to subject the owner to its own policies
 * — and FORCE is honored precisely BECAUSE the owner is neither a superuser nor
 * BYPASSRLS. Therefore NO new role and NO second DSN are needed: the SAME
 * `EMAILS_DATABASE_URL`/`emails_app` runs both migrate.ts (owner: can ENABLE/FORCE
 * RLS + CREATE POLICY) and serve.ts (subject to the policy). serve.ts additionally
 * asserts at boot that its role cannot bypass RLS (assertServingRoleCannotBypassRls)
 * so this can never silently regress.
 *
 * POLICY (M1) — `current_setting('app.current_tenant', true)` returns '' (not an
 * error) when the GUC is unset; `NULLIF(...,'')::uuid` turns that into NULL so the
 * predicate `tenant_id = NULL` matches NOTHING ⇒ FAIL CLOSED (a query with no
 * tenant context reads/writes zero rows). Casting '' directly would throw — the
 * NULLIF guard is load-bearing. A USING-only policy also governs INSERT/UPDATE
 * (Postgres defaults WITH CHECK to the USING expression), so a cross-tenant write
 * is rejected at the DB layer too.
 *
 * TRANSITIONAL DEFAULT RETAINED. Unlike the design's fully-sealed 0013, the
 * transitional `tenant_id DEFAULT` is KEPT here: the SES-inbound ingest worker
 * still writes untenanted (its C1 envelope-recipient routing is a separate
 * follow-up, WI-4a). The worker sets `app.current_tenant` to the DEFAULT tenant
 * (store.workerClient), so its default-tenant writes satisfy the policy; dropping
 * the default is deferred until that routing lands, so nothing breaks now.
 *
 * SAFETY: idempotent + drift-aware. ENABLE/FORCE are no-ops if already set; the
 * policy is DROP-then-CREATE; index drops are guarded (and handle the case where a
 * unique is constraint-backed rather than a bare index). Every step is guarded on
 * table existence via to_regclass, so it is a clean no-op on a 2nd run or a
 * partially-migrated DB (mirrors the 0009/0012 reconcile discipline).
 */
const TENANCY_RLS_AND_SEAL = defineMigration(
  "0013_emails_tenancy_rls_and_seal",
  `
  -- ---- reconcile helpers (session-temp; 0012's are gone by now) --------------

  -- Enable + FORCE RLS and (re)create the fail-closed tenant policy on a table.
  -- Guarded on table existence; policy is dropped-then-created so a re-run is a
  -- clean no-op. FORCE is what subjects the (non-superuser) OWNER to the policy.
  CREATE OR REPLACE FUNCTION pg_temp.emails_enable_rls(tbl text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    pol text := tbl || '_tenant_isolation';
  BEGIN
    IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (tenant_id = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      pol, tbl);
  END;
  $fn$;

  -- Drop a unique that is now superseded by its per-tenant composite. Handles
  -- BOTH a bare unique index (how these were created) and, drift-defensively, a
  -- unique backed by a table constraint. No-op when absent.
  CREATE OR REPLACE FUNCTION pg_temp.emails_drop_superseded_unique(idx text)
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
  DECLARE
    con  text;
    rel  text;
  BEGIN
    SELECT c.conname, c.conrelid::regclass::text
      INTO con, rel
      FROM pg_constraint c
      JOIN pg_class i ON i.oid = c.conindid
     WHERE i.relname = idx;
    IF con IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', rel, con);
      RETURN;
    END IF;
    EXECUTE format('DROP INDEX IF EXISTS public.%I', idx);
  END;
  $fn$;

  -- ---- 1. drop the 3 transitional single-column uniques (§9) ------------------
  -- 0012 ADDED the per-tenant composites and RETAINED these so the pre-tenancy
  -- store's single-column ON CONFLICT kept resolving during the deploy window.
  -- The updated store now upserts on the composites, so the legacy uniques are
  -- superseded and dropped here:
  --   messages_idempotency_key_uidx        -> messages_tenant_idempotency_key_uidx
  --   messages_source_id_uidx              -> messages_tenant_source_id_uidx
  --   email_agent_settings_agent_key_uidx  -> PK (tenant_id, agent_key)
  SELECT pg_temp.emails_drop_superseded_unique('messages_idempotency_key_uidx');
  SELECT pg_temp.emails_drop_superseded_unique('messages_source_id_uidx');
  SELECT pg_temp.emails_drop_superseded_unique('email_agent_settings_agent_key_uidx');

  -- ---- 2. enable + FORCE RLS with the fail-closed policy on all 27 tables -----
  SELECT pg_temp.emails_enable_rls('domains');
  SELECT pg_temp.emails_enable_rls('addresses');
  SELECT pg_temp.emails_enable_rls('messages');
  SELECT pg_temp.emails_enable_rls('contacts');
  SELECT pg_temp.emails_enable_rls('self_hosted_providers');
  SELECT pg_temp.emails_enable_rls('templates');
  SELECT pg_temp.emails_enable_rls('contact_groups');
  SELECT pg_temp.emails_enable_rls('sequences');
  SELECT pg_temp.emails_enable_rls('owners');
  SELECT pg_temp.emails_enable_rls('send_keys');
  SELECT pg_temp.emails_enable_rls('scheduled_emails');
  SELECT pg_temp.emails_enable_rls('aliases');
  SELECT pg_temp.emails_enable_rls('forwarding_rules');
  SELECT pg_temp.emails_enable_rls('warming_schedules');
  SELECT pg_temp.emails_enable_rls('email_triage');
  SELECT pg_temp.emails_enable_rls('provisioning_events');
  SELECT pg_temp.emails_enable_rls('mailbox_sources');
  SELECT pg_temp.emails_enable_rls('events');
  SELECT pg_temp.emails_enable_rls('email_agent_settings');
  SELECT pg_temp.emails_enable_rls('email_agent_runs');
  SELECT pg_temp.emails_enable_rls('email_digests');
  SELECT pg_temp.emails_enable_rls('group_members');
  SELECT pg_temp.emails_enable_rls('sequence_steps');
  SELECT pg_temp.emails_enable_rls('sequence_enrollments');
  SELECT pg_temp.emails_enable_rls('address_ownership_events');
  SELECT pg_temp.emails_enable_rls('webhook_receipts');
  SELECT pg_temp.emails_enable_rls('sandbox_emails');
  `,
);

/**
 * 0014 — index for message-id PREFIX resolution.
 *
 * `inbox list` prints an 8-char id prefix; the CLI/MCP now resolve that prefix to
 * a full id SERVER-SIDE (store.resolveMessageId) for every by-id handler
 * (read / mark-read / label / archive / star / delete / attachment / raw) via:
 *
 *   SELECT id FROM messages WHERE (id)::text LIKE $1 || '%' AND tenant_id = $2 ...
 *
 * This adds the matching `text_pattern_ops` index so that anchored prefix LIKE is
 * an index range scan rather than a full sequential scan over the whole (~160k
 * row) message table — which is what made `inbox read <shortid>` take minutes.
 *
 * `messages.id` is TEXT (see 0001), so `(id)::text` is a no-op cast kept ONLY so
 * the index expression matches the store query's expression exactly (the planner
 * needs the expressions to be identical to use the index). Idempotent
 * (IF NOT EXISTS) and guarded on table existence via to_regclass, so it is a clean
 * no-op on a re-run or a partially-migrated DB, mirroring the 0002/0009/0012
 * reconcile discipline.
 */
const MESSAGES_ID_PREFIX_INDEX = defineMigration(
  "0014_messages_id_prefix_index",
  `
  DO $$
  BEGIN
    IF to_regclass('public.messages') IS NOT NULL THEN
      CREATE INDEX IF NOT EXISTS messages_id_text_prefix_idx
        ON public.messages (((id)::text) text_pattern_ops);
    END IF;
  END $$;
  `,
);

/**
 * 0015 — global user identities + primary platform administrator.
 *
 * Users remain global (memberships bind them to tenants), and may authenticate
 * with any verified identity in `user_email_identities`.  `users.email` is kept
 * as a compatibility mirror of the primary identity while older clients are
 * upgraded.  The platform role deliberately does NOT bypass tenant RLS: a
 * super-admin still enters tenant data through an explicit membership/session.
 *
 * Bootstrap is an operator action, so the audit table is global/non-RLS and
 * contains identifiers only — never a password, session token, or API key.
 */
const USER_IDENTITIES_AND_PLATFORM_ADMIN = defineMigration(
  "0015_user_identities_and_platform_admin",
  `
  ALTER TABLE users ADD COLUMN IF NOT EXISTS global_role text NOT NULL DEFAULT 'user';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_primary_super_admin boolean NOT NULL DEFAULT false;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.users'::regclass AND conname = 'users_global_role_check'
    ) THEN
      ALTER TABLE users ADD CONSTRAINT users_global_role_check
        CHECK (global_role IN ('user', 'super_admin'));
    END IF;
  END $$;

  CREATE UNIQUE INDEX IF NOT EXISTS users_one_primary_super_admin_uidx
    ON users (is_primary_super_admin) WHERE is_primary_super_admin = true;

  CREATE TABLE IF NOT EXISTS user_email_identities (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email       citext NOT NULL UNIQUE,
    is_primary  boolean NOT NULL DEFAULT false,
    verified_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS user_email_identities_user_idx
    ON user_email_identities (user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS user_email_identities_one_primary_uidx
    ON user_email_identities (user_id) WHERE is_primary = true;

  INSERT INTO user_email_identities (user_id, email, is_primary, verified_at)
  SELECT id, email, true, email_verified_at FROM users
  ON CONFLICT (email) DO UPDATE SET
    verified_at = COALESCE(user_email_identities.verified_at, EXCLUDED.verified_at),
    updated_at = now();

  CREATE TABLE IF NOT EXISTS admin_bootstrap_audit (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action         text NOT NULL,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    email          citext NOT NULL,
    actor_kid      text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (action, tenant_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS admin_bootstrap_audit_created_idx
    ON admin_bootstrap_audit (created_at DESC);
  `,
);

/**
 * 0016 — seal inbound routing now that the worker resolves envelope recipients.
 *
 * `inbound_quarantine` is intentionally global/non-RLS: it records events for
 * which no tenant could safely be resolved.  It stores metadata only; raw MIME
 * remains in the operator's durable S3 bucket.  Tenant defaults are removed so
 * every future data write must carry an explicit resolved tenant.
 */
const INBOUND_ROUTING_AND_QUARANTINE = defineMigration(
  "0016_inbound_routing_and_quarantine",
  `
  CREATE TABLE IF NOT EXISTS inbound_quarantine (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id           text NOT NULL UNIQUE,
    bucket              text NOT NULL,
    object_key          text NOT NULL,
    envelope_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
    reason              text NOT NULL,
    detail              text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS inbound_quarantine_reason_idx
    ON inbound_quarantine (reason, created_at DESC);

  -- 0012 conservatively backfilled every legacy domain so no mail was lost
  -- during the transition. The runtime now has an explicit claim lifecycle;
  -- seal the map to the same receive-readiness predicate before removing the
  -- last transitional tenant defaults. Pending/unverified/stale routes are
  -- deliberately removed and will quarantine until re-verified and activated.
  DELETE FROM inbound_domain_routes r
   WHERE NOT EXISTS (
     SELECT 1 FROM domains d
      WHERE d.tenant_id = r.tenant_id
        AND lower(d.domain) = lower(r.domain)
        AND d.verified = true
        AND d.status IN ('active','verified','ready','inbound_ready')
   );

  DO $$
  DECLARE tbl text;
  BEGIN
    FOREACH tbl IN ARRAY ARRAY[
      'domains','addresses','messages','contacts','self_hosted_providers',
      'templates','contact_groups','sequences','owners','send_keys',
      'scheduled_emails','aliases','forwarding_rules','warming_schedules',
      'email_triage','provisioning_events','mailbox_sources','events',
      'email_agent_settings','email_agent_runs','email_digests','group_members',
      'sequence_steps','sequence_enrollments','address_ownership_events',
      'webhook_receipts','sandbox_emails'
    ] LOOP
      IF to_regclass('public.' || tbl) IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id DROP DEFAULT', tbl);
      END IF;
    END LOOP;
  END $$;
  `,
);

/** All migrations, in order: api-keys table (auth), the core schema, inbound. */
export function emailsSelfHostedMigrations(): Migration[] {
  const authMigrations = apiKeyMigrations().map((m) => defineMigration(m.id, m.sql));
  return [
    ...authMigrations,
    LEGACY_TABLE_COMPATIBILITY_SCHEMA,
    CORE_SCHEMA,
    INBOUND_SCHEMA,
    ADDRESS_VERIFIED_SCHEMA,
    ADDRESS_QUOTA_SCHEMA,
    RESOURCE_SCHEMA,
    EMAILS_RENAME_BRIDGE,
    LEGACY_MESSAGES_BACKFILL_PREP,
    LEGACY_MESSAGES_BACKFILL,
    LEGACY_MESSAGES_BACKFILL_DEDUPE,
    PARITY_RESOURCE_SCHEMA,
    PROVISIONING_COLUMNS,
    PARITY_RESOURCE_SCHEMA_2,
    TENANCY_IDENTITY_AND_BACKFILL,
    TENANCY_RLS_AND_SEAL,
    MESSAGES_ID_PREFIX_INDEX,
    USER_IDENTITIES_AND_PLATFORM_ADMIN,
    INBOUND_ROUTING_AND_QUARANTINE,
  ];
}
