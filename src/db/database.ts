import { SqliteAdapter as Database } from "@hasna/cloud";
// Re-export so all db/lib modules import Database from here instead of bun:sqlite
export type { Database };
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function isInMemoryDb(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

export function getDataDir(): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  const newDir = join(home, ".hasna", "emails");
  const oldDir = join(home, ".emails");

  // Auto-migrate old dir to new location
  if (existsSync(oldDir) && !existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true });
    for (const file of readdirSync(oldDir)) {
      const oldPath = join(oldDir, file);
      if (statSync(oldPath).isFile()) {
        copyFileSync(oldPath, join(newDir, file));
      }
    }
  }

  mkdirSync(newDir, { recursive: true });
  return newDir;
}

function getDbPath(): string {
  // 1. Environment variable override (new)
  if (process.env["HASNA_EMAILS_DB_PATH"]) {
    return process.env["HASNA_EMAILS_DB_PATH"];
  }
  // 2. Environment variable override (backward compat, used for tests)
  if (process.env["EMAILS_DB_PATH"]) {
    return process.env["EMAILS_DB_PATH"];
  }
  // 3. Default: ~/.hasna/emails/emails.db
  return join(getDataDir(), "emails.db");
}

function ensureDir(filePath: string): void {
  if (isInMemoryDb(filePath)) return;
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const MIGRATIONS = [
  // Migration 1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('resend', 'ses')),
    api_key TEXT,
    region TEXT,
    access_key TEXT,
    secret_key TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Note: type CHECK constraint only covers resend/ses for migration 1, gmail added in migration 2

  CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    dkim_status TEXT NOT NULL DEFAULT 'pending' CHECK(dkim_status IN ('pending','verified','failed')),
    spf_status TEXT NOT NULL DEFAULT 'pending' CHECK(spf_status IN ('pending','verified','failed')),
    dmarc_status TEXT NOT NULL DEFAULT 'pending' CHECK(dmarc_status IN ('pending','verified','failed')),
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider_id, domain)
  );

  CREATE TABLE IF NOT EXISTS addresses (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider_id, email)
  );

  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    provider_message_id TEXT,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','delivered','bounced','complained','failed')),
    has_attachments INTEGER NOT NULL DEFAULT 0,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '{}',
    sent_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    provider_event_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('delivered','bounced','complained','opened','clicked','unsubscribed')),
    recipient TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_domains_provider ON domains(provider_id);
  CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
  CREATE INDEX IF NOT EXISTS idx_addresses_provider ON addresses(provider_id);
  CREATE INDEX IF NOT EXISTS idx_addresses_email ON addresses(email);
  CREATE INDEX IF NOT EXISTS idx_emails_provider ON emails(provider_id);
  CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
  CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address);
  CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_id);
  CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_provider_event ON events(provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO _migrations (id) VALUES (1);
  `,

  // Migration 2: Add OAuth fields for Gmail provider + allow gmail type
  `
  ALTER TABLE providers ADD COLUMN oauth_client_id TEXT;
  ALTER TABLE providers ADD COLUMN oauth_client_secret TEXT;
  ALTER TABLE providers ADD COLUMN oauth_refresh_token TEXT;
  ALTER TABLE providers ADD COLUMN oauth_access_token TEXT;
  ALTER TABLE providers ADD COLUMN oauth_token_expiry TEXT;
  INSERT OR IGNORE INTO _migrations (id) VALUES (2);
  `,

  // Migration 3: Templates table
  `
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    subject_template TEXT NOT NULL,
    html_template TEXT,
    text_template TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name);
  INSERT OR IGNORE INTO _migrations (id) VALUES (3);
  `,

  // Migration 4: Contacts table
  `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    send_count INTEGER NOT NULL DEFAULT 0,
    bounce_count INTEGER NOT NULL DEFAULT 0,
    complaint_count INTEGER NOT NULL DEFAULT 0,
    last_sent_at TEXT,
    suppressed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
  CREATE INDEX IF NOT EXISTS idx_contacts_suppressed ON contacts(suppressed);
  INSERT OR IGNORE INTO _migrations (id) VALUES (4);
  `,

  // Migration 5: Scheduled emails table
  `
  CREATE TABLE IF NOT EXISTS scheduled_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    html TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    template_name TEXT,
    template_vars TEXT,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_emails(status);
  CREATE INDEX IF NOT EXISTS idx_scheduled_at ON scheduled_emails(scheduled_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (5);
  `,

  // Migration 6: Groups and group_members tables
  `
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    vars TEXT NOT NULL DEFAULT '{}',
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (6);
  `,

  // Migration 7: Email content table
  `
  CREATE TABLE IF NOT EXISTS email_content (
    email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    html TEXT,
    text_body TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}'
  );
  INSERT OR IGNORE INTO _migrations (id) VALUES (7);
  `,

  // Migration 8: Recreate providers table to expand type CHECK constraint to include gmail and sandbox
  `
  CREATE TABLE IF NOT EXISTS providers_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('resend', 'ses', 'gmail', 'sandbox')),
    api_key TEXT,
    region TEXT,
    access_key TEXT,
    secret_key TEXT,
    oauth_client_id TEXT,
    oauth_client_secret TEXT,
    oauth_refresh_token TEXT,
    oauth_access_token TEXT,
    oauth_token_expiry TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO providers_new SELECT id, name, type, api_key, region, access_key, secret_key,
    oauth_client_id, oauth_client_secret, oauth_refresh_token, oauth_access_token, oauth_token_expiry,
    active, created_at, updated_at FROM providers;
  DROP TABLE providers;
  ALTER TABLE providers_new RENAME TO providers;
  INSERT OR IGNORE INTO _migrations (id) VALUES (8);
  `,

  // Migration 9: Sandbox emails table
  `
  CREATE TABLE IF NOT EXISTS sandbox_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    html TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_provider ON sandbox_emails(provider_id);
  CREATE INDEX IF NOT EXISTS idx_sandbox_created ON sandbox_emails(created_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (9);
  `,

  // Migration 10: Add idempotency_key to emails table for dedup on retry
  `
  ALTER TABLE emails ADD COLUMN idempotency_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_idempotency ON emails(idempotency_key) WHERE idempotency_key IS NOT NULL;
  INSERT OR IGNORE INTO _migrations (id) VALUES (10);
  `,

  // Migration 11: Inbound emails table
  `
  CREATE TABLE IF NOT EXISTS inbound_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    message_id TEXT,
    provider_thread_id TEXT,
    provider_history_id TEXT,
    provider_internal_date TEXT,
    label_ids_json TEXT NOT NULL DEFAULT '[]',
    raw_s3_url TEXT,
    metadata_s3_url TEXT,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    text_body TEXT,
    html_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '{}',
    raw_size INTEGER DEFAULT 0,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_from ON inbound_emails(from_address);
  CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_emails(received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider ON inbound_emails(provider_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (11);
  `,

  // Migration 12: Sequences, sequence_steps, sequence_enrollments tables
  `
  CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sequences_name ON sequences(name);

  CREATE TABLE IF NOT EXISTS sequence_steps (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    delay_hours INTEGER NOT NULL DEFAULT 24,
    template_name TEXT NOT NULL,
    from_address TEXT,
    subject_override TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sequence_id, step_number)
  );
  CREATE INDEX IF NOT EXISTS idx_steps_sequence ON sequence_steps(sequence_id);

  CREATE TABLE IF NOT EXISTS sequence_enrollments (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    contact_email TEXT NOT NULL,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
    enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_send_at TEXT,
    completed_at TEXT,
    UNIQUE(sequence_id, contact_email)
  );
  CREATE INDEX IF NOT EXISTS idx_enrollments_sequence ON sequence_enrollments(sequence_id);
  CREATE INDEX IF NOT EXISTS idx_enrollments_email ON sequence_enrollments(contact_email);
  CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON sequence_enrollments(next_send_at);
  CREATE INDEX IF NOT EXISTS idx_enrollments_status ON sequence_enrollments(status);
  INSERT OR IGNORE INTO _migrations (id) VALUES (12);
  `,

  // Migration 13: Warming schedules table
  `
  CREATE TABLE IF NOT EXISTS warming_schedules (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    target_daily_volume INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_warming_domain ON warming_schedules(domain);
  CREATE INDEX IF NOT EXISTS idx_warming_status ON warming_schedules(status);
  INSERT OR IGNORE INTO _migrations (id) VALUES (13);
  `,

  // Migration 14: Reply tracking — link inbound emails back to sent emails
  `
  ALTER TABLE inbound_emails ADD COLUMN in_reply_to_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_inbound_reply_to ON inbound_emails(in_reply_to_email_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (14);
  `,

  // Migration 15: Gmail sync state + dedup index on inbound_emails(provider_id, message_id)
  `
  CREATE TABLE IF NOT EXISTS gmail_sync_state (
    provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    last_synced_at TEXT,
    last_message_id TEXT,
    history_id TEXT,
    next_page_token TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_provider_message ON inbound_emails(provider_id, message_id)
    WHERE provider_id IS NOT NULL AND message_id IS NOT NULL;
  INSERT OR IGNORE INTO _migrations (id) VALUES (15);
  `,

  // Migration 16: AI triage table — stores classification, priority, summary, sentiment, draft replies
  `
  CREATE TABLE IF NOT EXISTS email_triage (
    id TEXT PRIMARY KEY,
    email_id TEXT REFERENCES emails(id) ON DELETE CASCADE,
    inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK(label IN ('action-required','fyi','urgent','follow-up','spam','newsletter','transactional')),
    priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
    summary TEXT,
    sentiment TEXT CHECK(sentiment IN ('positive','negative','neutral')),
    draft_reply TEXT,
    confidence REAL DEFAULT 0.0,
    model TEXT,
    triaged_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_triage_email ON email_triage(email_id);
  CREATE INDEX IF NOT EXISTS idx_triage_inbound ON email_triage(inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_triage_label ON email_triage(label);
  CREATE INDEX IF NOT EXISTS idx_triage_priority ON email_triage(priority);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_email_unique ON email_triage(email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_inbound_unique ON email_triage(inbound_email_id) WHERE inbound_email_id IS NOT NULL;
  INSERT OR IGNORE INTO _migrations (id) VALUES (16);
  `,

  // Migration 17: attachment_paths — store local/S3 paths for downloaded attachments
  `
  ALTER TABLE inbound_emails ADD COLUMN attachment_paths TEXT NOT NULL DEFAULT '[]';
  INSERT OR IGNORE INTO _migrations (id) VALUES (17);
  `,

  // Migration 18: Gmail archive metadata and S3 object references
  `
  ALTER TABLE inbound_emails ADD COLUMN provider_thread_id TEXT;
  ALTER TABLE inbound_emails ADD COLUMN provider_history_id TEXT;
  ALTER TABLE inbound_emails ADD COLUMN provider_internal_date TEXT;
  ALTER TABLE inbound_emails ADD COLUMN label_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE inbound_emails ADD COLUMN raw_s3_url TEXT;
  ALTER TABLE inbound_emails ADD COLUMN metadata_s3_url TEXT;
  CREATE INDEX IF NOT EXISTS idx_inbound_thread ON inbound_emails(provider_thread_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_history ON inbound_emails(provider_history_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (18);
  `,

  // Migration 19: automated provisioning — domain/address lifecycle fields +
  // append-only provisioning_events audit. DNS is always Cloudflare.
  `
  ALTER TABLE domains ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE domains ADD COLUMN purchase_provider TEXT;
  ALTER TABLE domains ADD COLUMN dns_provider TEXT NOT NULL DEFAULT 'cloudflare';
  ALTER TABLE domains ADD COLUMN send_provider TEXT;
  ALTER TABLE domains ADD COLUMN cf_zone_id TEXT;
  ALTER TABLE domains ADD COLUMN registrar TEXT;
  ALTER TABLE domains ADD COLUMN nameservers_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE domains ADD COLUMN mail_from_domain TEXT;
  ALTER TABLE domains ADD COLUMN last_error TEXT;
  ALTER TABLE domains ADD COLUMN next_check_at TEXT;

  ALTER TABLE addresses ADD COLUMN domain_id TEXT;
  ALTER TABLE addresses ADD COLUMN receive_strategy TEXT;
  ALTER TABLE addresses ADD COLUMN forward_to TEXT;
  ALTER TABLE addresses ADD COLUMN routing_rule_id TEXT;
  ALTER TABLE addresses ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE addresses ADD COLUMN last_validated_at TEXT;
  ALTER TABLE addresses ADD COLUMN last_error TEXT;
  ALTER TABLE addresses ADD COLUMN next_check_at TEXT;

  CREATE TABLE IF NOT EXISTS provisioning_events (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('domain','address')),
    entity_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_provevents_entity ON provisioning_events(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_domains_provstatus ON domains(provisioning_status);
  CREATE INDEX IF NOT EXISTS idx_addresses_provstatus ON addresses(provisioning_status);
  CREATE INDEX IF NOT EXISTS idx_addresses_domain ON addresses(domain_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (19);
  `,

  // Migration 20: tenancy — owners (human|agent) + address ownership/administration.
  `
  CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('human','agent')),
    name TEXT NOT NULL,
    contact_email TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_owners_type ON owners(type);
  CREATE INDEX IF NOT EXISTS idx_owners_name ON owners(name);
  ALTER TABLE addresses ADD COLUMN owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL;
  ALTER TABLE addresses ADD COLUMN administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_addresses_owner ON addresses(owner_id);
  CREATE INDEX IF NOT EXISTS idx_addresses_admin ON addresses(administrator_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (20);
  `,

  // Migration 21: threading — RFC Message-ID, thread_id, In-Reply-To, References.
  `
  ALTER TABLE emails ADD COLUMN message_id TEXT;
  ALTER TABLE emails ADD COLUMN thread_id TEXT;
  ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
  ALTER TABLE emails ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE inbound_emails ADD COLUMN thread_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
  CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_threadid ON inbound_emails(thread_id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (21);
  `,

  // Migration 22: address lifecycle — status + per-address daily send quota.
  `
  ALTER TABLE addresses ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE addresses ADD COLUMN daily_quota INTEGER;
  CREATE INDEX IF NOT EXISTS idx_addresses_status ON addresses(status);
  INSERT OR IGNORE INTO _migrations (id) VALUES (22);
  `,

  // Migration 23: local read-state / archive / star for inbound mail (parity
  // with Gmail flags, but server-independent — works for SES-S3 mail too).
  `
  ALTER TABLE inbound_emails ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN read_at TEXT;
  ALTER TABLE inbound_emails ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_inbound_is_read ON inbound_emails(is_read);
  CREATE INDEX IF NOT EXISTS idx_inbound_is_archived ON inbound_emails(is_archived);
  INSERT OR IGNORE INTO _migrations (id) VALUES (23);
  `,

  // Migration 24: per-domain aliases + catch-all. An alias maps a recipient
  // local-part to a target address; a catch-all (local_part = '*') maps every
  // unmatched recipient on a domain. Unique per (domain, local_part).
  `
  CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    local_part TEXT NOT NULL,
    target_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(domain, local_part)
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_domain ON aliases(domain);
  INSERT OR IGNORE INTO _migrations (id) VALUES (24);
  `,

  // Migration 25: scoped send keys — an API/MCP credential bound to one owner.
  // A key authorizes sending only from addresses that owner owns or administers.
  `
  CREATE TABLE IF NOT EXISTS send_keys (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_send_keys_owner ON send_keys(owner_id);
  CREATE INDEX IF NOT EXISTS idx_send_keys_hash ON send_keys(key_hash);
  INSERT OR IGNORE INTO _migrations (id) VALUES (25);
  `,
];

let _db: Database | null = null;

export function getDatabase(dbPath?: string): Database {
  if (_db) return _db;

  const path = dbPath || getDbPath();
  ensureDir(path);

  _db = new Database(path);

  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 5000");
  _db.run("PRAGMA foreign_keys = ON");

  runMigrations(_db);

  return _db;
}

function runMigrations(db: Database): void {
  try {
    const result = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
    const currentLevel = result?.max_id ?? 0;

    for (let i = currentLevel; i < MIGRATIONS.length; i++) {
      try {
        db.exec(MIGRATIONS[i]!);
      } catch {
        // Migration partially failed — ensureSchema will fix gaps
      }
    }
  } catch {
    for (const migration of MIGRATIONS) {
      try {
        db.exec(migration);
      } catch {
        // Partial failure handled by ensureSchema
      }
    }
  }

  ensureSchema(db);
}

function ensureSchema(db: Database): void {
  // Ensure OAuth columns exist (idempotent — ALTER TABLE fails gracefully if column already exists)
  const ensureColumn = (sql: string) => {
    try { db.exec(sql); } catch {}
  };
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_client_id TEXT");
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_client_secret TEXT");
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_refresh_token TEXT");
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_access_token TEXT");
  ensureColumn("ALTER TABLE providers ADD COLUMN oauth_token_expiry TEXT");

  // Migration 19 (idempotent guarantee): provisioning fields for automated
  // domain/address provisioning. ALTER ADD COLUMN has no IF NOT EXISTS, so these
  // run individually and tolerate "duplicate column" on already-migrated DBs.
  ensureColumn("ALTER TABLE domains ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'none'");
  ensureColumn("ALTER TABLE domains ADD COLUMN purchase_provider TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN dns_provider TEXT NOT NULL DEFAULT 'cloudflare'");
  ensureColumn("ALTER TABLE domains ADD COLUMN send_provider TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN cf_zone_id TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN registrar TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN nameservers_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("ALTER TABLE domains ADD COLUMN mail_from_domain TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN last_error TEXT");
  ensureColumn("ALTER TABLE domains ADD COLUMN next_check_at TEXT");

  ensureColumn("ALTER TABLE addresses ADD COLUMN domain_id TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN receive_strategy TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN forward_to TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN routing_rule_id TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'none'");
  ensureColumn("ALTER TABLE addresses ADD COLUMN last_validated_at TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN last_error TEXT");
  ensureColumn("ALTER TABLE addresses ADD COLUMN next_check_at TEXT");

  const ensureProvTable = (sql: string) => { try { db.exec(sql); } catch {} };
  ensureProvTable(`CREATE TABLE IF NOT EXISTS provisioning_events (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_provevents_entity ON provisioning_events(entity_type, entity_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_domains_provstatus ON domains(provisioning_status)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_provstatus ON addresses(provisioning_status)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_domain ON addresses(domain_id)");

  // Migration 20 idempotent guarantee: owners + address ownership.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    contact_email TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_owners_type ON owners(type)");
  ensureColumn("ALTER TABLE addresses ADD COLUMN owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL");
  ensureColumn("ALTER TABLE addresses ADD COLUMN administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_owner ON addresses(owner_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_admin ON addresses(administrator_id)");

  // Migration 21 idempotent guarantee: threading columns.
  ensureColumn("ALTER TABLE emails ADD COLUMN message_id TEXT");
  ensureColumn("ALTER TABLE emails ADD COLUMN thread_id TEXT");
  ensureColumn("ALTER TABLE emails ADD COLUMN in_reply_to TEXT");
  ensureColumn("ALTER TABLE emails ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN thread_id TEXT");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_threadid ON inbound_emails(thread_id)");

  // Migration 22 idempotent guarantee: address lifecycle columns.
  ensureColumn("ALTER TABLE addresses ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  ensureColumn("ALTER TABLE addresses ADD COLUMN daily_quota INTEGER");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addresses_status ON addresses(status)");

  // Migration 23 idempotent guarantee: inbound local read-state / archive / star.
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN read_at TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_is_read ON inbound_emails(is_read)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_is_archived ON inbound_emails(is_archived)");

  // Migration 24 idempotent guarantee: aliases / catch-all.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    local_part TEXT NOT NULL,
    target_address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(domain, local_part)
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_aliases_domain ON aliases(domain)");

  // Migration 25 idempotent guarantee: scoped send keys.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS send_keys (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_send_keys_owner ON send_keys(owner_id)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_send_keys_hash ON send_keys(key_hash)");

  const ensureIndex = (sql: string) => {
    try { db.exec(sql); } catch {}
  };

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_provider ON domains(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_addresses_provider ON addresses(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_addresses_email ON addresses(email)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_emails_provider ON emails(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at)");
  ensureIndex("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_provider_event ON events(provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL");

  // Ensure templates table exists
  const ensureTable = (sql: string) => {
    try { db.exec(sql); } catch {}
  };
  ensureTable(`CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    subject_template TEXT NOT NULL,
    html_template TEXT,
    text_template TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name)");

  // Ensure contacts table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    send_count INTEGER NOT NULL DEFAULT 0,
    bounce_count INTEGER NOT NULL DEFAULT 0,
    complaint_count INTEGER NOT NULL DEFAULT 0,
    last_sent_at TEXT,
    suppressed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_contacts_suppressed ON contacts(suppressed)");

  // Ensure scheduled_emails table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS scheduled_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    html TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    template_name TEXT,
    template_vars TEXT,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_emails(status)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_scheduled_at ON scheduled_emails(scheduled_at)");

  // Ensure groups table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name)");

  // Ensure group_members table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    vars TEXT NOT NULL DEFAULT '{}',
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, email)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)");

  // Ensure email_content table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS email_content (
    email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    html TEXT,
    text_body TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}'
  )`);

  // Ensure sandbox_emails table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS sandbox_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL,
    html TEXT,
    text_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_sandbox_provider ON sandbox_emails(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_sandbox_created ON sandbox_emails(created_at)");

  // Ensure inbound_emails table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS inbound_emails (
    id TEXT PRIMARY KEY,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    message_id TEXT,
    provider_thread_id TEXT,
    provider_history_id TEXT,
    provider_internal_date TEXT,
    label_ids_json TEXT NOT NULL DEFAULT '[]',
    raw_s3_url TEXT,
    metadata_s3_url TEXT,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    text_body TEXT,
    html_body TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    headers_json TEXT NOT NULL DEFAULT '{}',
    raw_size INTEGER DEFAULT 0,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_from ON inbound_emails(from_address)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_emails(received_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_provider ON inbound_emails(provider_id)");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN in_reply_to_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_reply_to ON inbound_emails(in_reply_to_email_id)");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN provider_thread_id TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN provider_history_id TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN provider_internal_date TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN label_ids_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN raw_s3_url TEXT");
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN metadata_s3_url TEXT");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_thread ON inbound_emails(provider_thread_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_history ON inbound_emails(provider_history_id)");

  // Ensure sequences tables exist
  ensureTable(`CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_sequences_name ON sequences(name)");

  ensureTable(`CREATE TABLE IF NOT EXISTS sequence_steps (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    delay_hours INTEGER NOT NULL DEFAULT 24,
    template_name TEXT NOT NULL,
    from_address TEXT,
    subject_override TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sequence_id, step_number)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_steps_sequence ON sequence_steps(sequence_id)");

  ensureTable(`CREATE TABLE IF NOT EXISTS sequence_enrollments (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    contact_email TEXT NOT NULL,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
    enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_send_at TEXT,
    completed_at TEXT,
    UNIQUE(sequence_id, contact_email)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_sequence ON sequence_enrollments(sequence_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_email ON sequence_enrollments(contact_email)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON sequence_enrollments(next_send_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_status ON sequence_enrollments(status)");

  // Ensure warming_schedules table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS warming_schedules (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    target_daily_volume INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_warming_domain ON warming_schedules(domain)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_warming_status ON warming_schedules(status)");

  // Gmail sync state
  ensureTable(`CREATE TABLE IF NOT EXISTS gmail_sync_state (
    provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    last_synced_at TEXT,
    last_message_id TEXT,
    history_id TEXT,
    next_page_token TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Dedup index on inbound_emails for Gmail sync
  ensureIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_provider_message ON inbound_emails(provider_id, message_id)
    WHERE provider_id IS NOT NULL AND message_id IS NOT NULL`);
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN attachment_paths TEXT NOT NULL DEFAULT '[]'");

  // Ensure email_triage table exists
  ensureTable(`CREATE TABLE IF NOT EXISTS email_triage (
    id TEXT PRIMARY KEY,
    email_id TEXT REFERENCES emails(id) ON DELETE CASCADE,
    inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE CASCADE,
    label TEXT NOT NULL CHECK(label IN ('action-required','fyi','urgent','follow-up','spam','newsletter','transactional')),
    priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
    summary TEXT,
    sentiment TEXT CHECK(sentiment IN ('positive','negative','neutral')),
    draft_reply TEXT,
    confidence REAL DEFAULT 0.0,
    model TEXT,
    triaged_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_triage_email ON email_triage(email_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_triage_inbound ON email_triage(inbound_email_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_triage_label ON email_triage(label)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_triage_priority ON email_triage(priority)");
  ensureIndex("CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_email_unique ON email_triage(email_id) WHERE email_id IS NOT NULL");
  ensureIndex("CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_inbound_unique ON email_triage(inbound_email_id) WHERE inbound_email_id IS NOT NULL");

  ensureTable(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function resetDatabase(): void {
  _db = null;
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}

// The `table` name is interpolated into SQL, so it must never be caller-derived.
// All call sites pass a literal; this allowlist makes that a hard guarantee.
const RESOLVABLE_TABLES = new Set([
  "providers", "domains", "addresses", "emails", "inbound_emails", "sandbox_emails",
  "templates", "contacts", "groups", "scheduled_emails", "sequences", "owners",
  "aliases", "send_keys",
]);

export function resolvePartialId(db: Database, table: string, partialId: string): string | null {
  if (!RESOLVABLE_TABLES.has(table)) {
    throw new Error(`resolvePartialId: refusing unknown table '${table}'`);
  }
  if (partialId.length >= 36) {
    const row = db.query(`SELECT id FROM ${table} WHERE id = ?`).get(partialId) as { id: string } | null;
    return row?.id ?? null;
  }

  const rows = db.query(`SELECT id FROM ${table} WHERE id LIKE ?`).all(`${partialId}%`) as { id: string }[];
  if (rows.length === 1) {
    return rows[0]!.id;
  }
  return null;
}
