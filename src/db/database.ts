import { Database } from "bun:sqlite";
// Re-export so all db/lib modules import Database from here instead of bun:sqlite
export type { Database };
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sqlEmailAddress, sqlEmailDomain } from "./email-address-sql.js";

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

function normalizedRecipientSql(valueSql: string): string {
  const value = `CAST(${valueSql} AS TEXT)`;
  return `LOWER(TRIM(CASE
    WHEN instr(${value}, '<') > 0 AND instr(${value}, '>') > instr(${value}, '<')
      THEN substr(${value}, instr(${value}, '<') + 1, instr(${value}, '>') - instr(${value}, '<') - 1)
    ELSE ${value}
  END))`;
}

function inboundRecipientInsertSql(idSql: string, toAddressesSql: string): string {
  return `INSERT OR IGNORE INTO inbound_recipients (inbound_email_id, address, domain)
    SELECT ${idSql}, normalized.address, substr(normalized.address, instr(normalized.address, '@') + 1)
      FROM (
        SELECT ${normalizedRecipientSql("j.value")} AS address
          FROM json_each(CASE WHEN json_valid(${toAddressesSql}) THEN ${toAddressesSql} ELSE '[]' END) AS j
      ) normalized
     WHERE instr(normalized.address, '@') > 1
       AND instr(substr(normalized.address, instr(normalized.address, '@') + 1), '.') > 0
       AND normalized.address NOT LIKE '% %'
       AND normalized.address NOT LIKE '%<%'
       AND normalized.address NOT LIKE '%>%'`;
}

function inboundRecipientBackfillSql(): string {
  return `INSERT OR IGNORE INTO inbound_recipients (inbound_email_id, address, domain)
    SELECT normalized.inbound_email_id, normalized.address, substr(normalized.address, instr(normalized.address, '@') + 1)
      FROM (
        SELECT e.id AS inbound_email_id, ${normalizedRecipientSql("j.value")} AS address
          FROM inbound_emails e,
               json_each(CASE WHEN json_valid(e.to_addresses) THEN e.to_addresses ELSE '[]' END) AS j
      ) normalized
     WHERE instr(normalized.address, '@') > 1
       AND instr(substr(normalized.address, instr(normalized.address, '@') + 1), '.') > 0
       AND normalized.address NOT LIKE '% %'
       AND normalized.address NOT LIKE '%<%'
       AND normalized.address NOT LIKE '%>%'`;
}

const INBOUND_RECIPIENTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS inbound_recipients (
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    domain TEXT NOT NULL,
    PRIMARY KEY (inbound_email_id, address)
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_address ON inbound_recipients(address, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_domain ON inbound_recipients(domain, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_email ON inbound_recipients(inbound_email_id);
`;

const INBOUND_RECIPIENTS_BACKFILL_SQL = `
  ${inboundRecipientBackfillSql()};
`;

const INBOUND_RECIPIENTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_inbound_recipients_insert
  AFTER INSERT ON inbound_emails
  BEGIN
    ${inboundRecipientInsertSql("NEW.id", "NEW.to_addresses")};
  END;

  CREATE TRIGGER IF NOT EXISTS trg_inbound_recipients_update_to
  AFTER UPDATE OF to_addresses ON inbound_emails
  BEGIN
    DELETE FROM inbound_recipients WHERE inbound_email_id = NEW.id;
    ${inboundRecipientInsertSql("NEW.id", "NEW.to_addresses")};
  END;

  CREATE TRIGGER IF NOT EXISTS trg_inbound_recipients_delete
  AFTER DELETE ON inbound_emails
  BEGIN
    DELETE FROM inbound_recipients WHERE inbound_email_id = OLD.id;
  END;
`;

function normalizedLabelSql(valueSql: string): string {
  let value = `LOWER(TRIM(CAST(${valueSql} AS TEXT)))`;
  for (const whitespace of ["char(9)", "char(10)", "char(11)", "char(12)", "char(13)"]) {
    value = `REPLACE(${value}, ${whitespace}, ' ')`;
  }
  for (let i = 0; i < 8; i += 1) {
    value = `REPLACE(${value}, '  ', ' ')`;
  }
  return `SUBSTR(REPLACE(${value}, ' ', '-'), 1, 64)`;
}

function inboundLabelInsertSql(idSql: string, labelIdsSql: string): string {
  return `INSERT OR IGNORE INTO inbound_labels (inbound_email_id, label)
    SELECT ${idSql}, normalized.label
      FROM (
        SELECT ${normalizedLabelSql("j.value")} AS label
          FROM json_each(CASE WHEN json_valid(${labelIdsSql}) THEN ${labelIdsSql} ELSE '[]' END) AS j
      ) normalized
     WHERE normalized.label != ''`;
}

function inboundLabelFlagUpdateSql(idSql: string): string {
  return `UPDATE inbound_emails
     SET is_spam = CASE WHEN EXISTS (
           SELECT 1 FROM inbound_labels
            WHERE inbound_email_id = ${idSql}
              AND label = 'spam'
         ) THEN 1 ELSE 0 END,
         is_trash = CASE WHEN EXISTS (
           SELECT 1 FROM inbound_labels
            WHERE inbound_email_id = ${idSql}
              AND label = 'trash'
         ) THEN 1 ELSE 0 END
   WHERE id = ${idSql}`;
}

function inboundLabelsBackfillSql(): string {
  return `INSERT OR IGNORE INTO inbound_labels (inbound_email_id, label)
    SELECT normalized.inbound_email_id, normalized.label
      FROM (
        SELECT e.id AS inbound_email_id, ${normalizedLabelSql("j.value")} AS label
          FROM inbound_emails e,
               json_each(CASE WHEN json_valid(e.label_ids_json) THEN e.label_ids_json ELSE '[]' END) AS j
      ) normalized
     WHERE normalized.label != ''`;
}

const INBOUND_LABELS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS inbound_labels (
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    PRIMARY KEY (inbound_email_id, label)
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_labels_label ON inbound_labels(label, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_labels_email ON inbound_labels(inbound_email_id);
`;

const INBOUND_LABELS_BACKFILL_SQL = `
  ${inboundLabelsBackfillSql()};
`;

const INBOUND_LABELS_FLAG_BACKFILL_SQL = `
  UPDATE inbound_emails
     SET is_spam = CASE WHEN EXISTS (
           SELECT 1 FROM inbound_labels
            WHERE inbound_email_id = inbound_emails.id
              AND label = 'spam'
         ) THEN 1 ELSE 0 END,
         is_trash = CASE WHEN EXISTS (
           SELECT 1 FROM inbound_labels
            WHERE inbound_email_id = inbound_emails.id
              AND label = 'trash'
         ) THEN 1 ELSE 0 END;
`;

const INBOUND_LABELS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_inbound_labels_insert
  AFTER INSERT ON inbound_emails
  BEGIN
    ${inboundLabelInsertSql("NEW.id", "NEW.label_ids_json")};
    ${inboundLabelFlagUpdateSql("NEW.id")};
  END;

  CREATE TRIGGER IF NOT EXISTS trg_inbound_labels_update_labels
  AFTER UPDATE OF label_ids_json ON inbound_emails
  BEGIN
    DELETE FROM inbound_labels WHERE inbound_email_id = NEW.id;
    ${inboundLabelInsertSql("NEW.id", "NEW.label_ids_json")};
    ${inboundLabelFlagUpdateSql("NEW.id")};
  END;

  CREATE TRIGGER IF NOT EXISTS trg_inbound_labels_delete
  AFTER DELETE ON inbound_emails
  BEGIN
    DELETE FROM inbound_labels WHERE inbound_email_id = OLD.id;
  END;
`;

function safeExec(db: Database, sql: string): void {
  try { db.exec(sql); } catch {}
}

function tableExists(db: Database, tableName: string): boolean {
  try {
    const row = db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) as { ok: number } | null;
    return !!row;
  } catch {
    return false;
  }
}

function migrationRecorded(db: Database, id: number): boolean {
  try {
    const row = db.query("SELECT 1 AS ok FROM _migrations WHERE id = ? LIMIT 1").get(id) as { ok: number } | null;
    return !!row;
  } catch {
    return false;
  }
}

function ensureInboundRecipients(db: Database): void {
  const tableExisted = tableExists(db, "inbound_recipients");
  safeExec(db, INBOUND_RECIPIENTS_SCHEMA_SQL);
  if (!migrationRecorded(db, 31) || !tableExisted) {
    safeExec(db, INBOUND_RECIPIENTS_BACKFILL_SQL);
  }
  safeExec(db, INBOUND_RECIPIENTS_TRIGGERS_SQL);
  if (tableExists(db, "inbound_recipients")) {
    safeExec(db, "INSERT OR IGNORE INTO _migrations (id) VALUES (31)");
  }
}

function ensureInboundLabels(db: Database): void {
  const tableExisted = tableExists(db, "inbound_labels");
  safeExec(db, "ALTER TABLE inbound_emails ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0");
  safeExec(db, "ALTER TABLE inbound_emails ADD COLUMN is_trash INTEGER NOT NULL DEFAULT 0");
  safeExec(db, INBOUND_LABELS_SCHEMA_SQL);
  if (!migrationRecorded(db, 36) || !tableExisted) {
    safeExec(db, INBOUND_LABELS_BACKFILL_SQL);
    safeExec(db, INBOUND_LABELS_FLAG_BACKFILL_SQL);
  }
  safeExec(db, INBOUND_LABELS_TRIGGERS_SQL);
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_spam_trash_recv ON inbound_emails(is_sent, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_read_arch_spam_trash_recv ON inbound_emails(is_sent, is_read, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_star_arch_spam_trash_recv ON inbound_emails(is_sent, is_starred, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_arch_spam_trash_recv ON inbound_emails(is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_spam_recv ON inbound_emails(is_spam, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_trash_recv ON inbound_emails(is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_spam_recv ON inbound_emails(is_sent, is_spam, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_sent_trash_recv ON inbound_emails(is_sent, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_read_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_read, is_archived, is_spam, is_trash, received_at)");
  safeExec(db, "CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_star_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_starred, is_archived, is_spam, is_trash, received_at)");
  if (tableExists(db, "inbound_labels")) {
    safeExec(db, "INSERT OR IGNORE INTO _migrations (id) VALUES (36)");
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
  CREATE INDEX IF NOT EXISTS idx_domains_domain_nocase ON domains(domain COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_domains_provider_domain_nocase ON domains(provider_id, domain COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_addresses_provider ON addresses(provider_id);
  CREATE INDEX IF NOT EXISTS idx_addresses_email ON addresses(email);
  CREATE INDEX IF NOT EXISTS idx_addresses_email_nocase ON addresses(email COLLATE NOCASE);
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
  CREATE INDEX IF NOT EXISTS idx_owners_external_id ON owners(external_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_external_id_unique ON owners(external_id) WHERE external_id IS NOT NULL;
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

  // Migration 26: composite indexes so the mailbox list queries
  // (WHERE is_archived/is_read/is_starred ORDER BY received_at) seek+walk an
  // index instead of sorting the whole table — critical on large inboxes.
  `
  CREATE INDEX IF NOT EXISTS idx_inbound_arch_recv ON inbound_emails(is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_read_arch_recv ON inbound_emails(is_read, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_star_arch_recv ON inbound_emails(is_starred, is_archived, received_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (26);
  `,

  // Migration 27: aliases.protected — flags an alias that can't be deleted
  // (the default global catch-all that catches mail for every domain).
  `
  ALTER TABLE aliases ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
  INSERT OR IGNORE INTO _migrations (id) VALUES (27);
  `,

  // Migration 28: denormalized is_sent flag on inbound_emails. Mail I sent shows
  // up in a Gmail sync labelled SENT; this indexed flag lets the Sent folder and
  // the receiving folders be plain indexed seeks (no JSON label scanning).
  `
  ALTER TABLE inbound_emails ADD COLUMN is_sent INTEGER NOT NULL DEFAULT 0;
  UPDATE inbound_emails
     SET is_sent = 1
   WHERE json_valid(label_ids_json)
     AND EXISTS (
       SELECT 1 FROM json_each(label_ids_json)
        WHERE LOWER(value) = 'sent'
     );
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_recv ON inbound_emails(is_sent, is_archived, received_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (28);
  `,

  // Migration 29: address ownership audit log.
  `
  CREATE TABLE IF NOT EXISTS address_ownership_events (
    id TEXT PRIMARY KEY,
    address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK(action IN ('assign','transfer','unassign')),
    previous_owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    previous_administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    actor TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_addrownevents_address ON address_ownership_events(address_id, created_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (29);
  `,

  // Migration 30: hot-path composite indexes for bounded list views.
  // These match the query shapes used by Mailery UI, MCP list/export tools, and
  // diagnostics: equality filters first, then the timestamp used for ordering.
  `
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_read_arch_recv ON inbound_emails(is_sent, is_read, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_star_arch_recv ON inbound_emails(is_sent, is_starred, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_arch_recv ON inbound_emails(provider_id, is_sent, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_read_arch_recv ON inbound_emails(provider_id, is_sent, is_read, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_star_arch_recv ON inbound_emails(provider_id, is_sent, is_starred, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_emails_provider_sent ON emails(provider_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_status_sent ON emails(status, sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_provider_status_sent ON emails(provider_id, status, sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_from_sent ON emails(from_address, sent_at);
  CREATE INDEX IF NOT EXISTS idx_events_provider_occurred ON events(provider_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_type_occurred ON events(type, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_provider_type_occurred ON events(provider_id, type, occurred_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (30);
  `,

  // Migration 31: denormalized recipient index for inbound mail. This avoids
  // json_each(to_addresses) scans on every inbox source/filter/count refresh.
  `
  ${INBOUND_RECIPIENTS_SCHEMA_SQL}
  ${INBOUND_RECIPIENTS_BACKFILL_SQL}
  ${INBOUND_RECIPIENTS_TRIGGERS_SQL}
  INSERT OR IGNORE INTO _migrations (id) VALUES (31);
  `,

  // Migration 32: standalone inbound message-id index for S3 object dedupe.
  // The Gmail dedupe index is keyed by provider_id first; S3 sync probes by
  // message_id alone, so it needs its own indexed seek to avoid full scans.
  `
  CREATE INDEX IF NOT EXISTS idx_inbound_message_id ON inbound_emails(message_id)
    WHERE message_id IS NOT NULL;
  INSERT OR IGNORE INTO _migrations (id) VALUES (32);
  `,

  // Migration 33: scheduler due-enrollment composite index.
  `
  CREATE INDEX IF NOT EXISTS idx_enrollments_due ON sequence_enrollments(status, next_send_at, id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (33);
  `,

  // Migration 34: scheduler due-email composite index.
  `
  CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_emails(status, scheduled_at, id);
  INSERT OR IGNORE INTO _migrations (id) VALUES (34);
  `,

  // Migration 35: expression indexes for display-name sender filters.
  // These match sqlEmailAddress/sqlEmailDomain so exact sender and warming
  // domain filters stay indexed even when stored From values include names.
  `
  CREATE INDEX IF NOT EXISTS idx_emails_sender_canonical_sent ON emails(${sqlEmailAddress("from_address")}, sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_sender_domain_sent ON emails(${sqlEmailDomain("from_address")}, sent_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sender_canonical_recv ON inbound_emails(is_sent, is_archived, ${sqlEmailAddress("from_address")}, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sender_domain_recv ON inbound_emails(is_sent, is_archived, ${sqlEmailDomain("from_address")}, received_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (35);
  `,

  // Migration 36: normalized labels plus hot spam/trash flags for Mailery UI.
  // Folder counts/listing must not json_each(label_ids_json) on large stores.
  `
  ALTER TABLE inbound_emails ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN is_trash INTEGER NOT NULL DEFAULT 0;
  ${INBOUND_LABELS_SCHEMA_SQL}
  ${INBOUND_LABELS_BACKFILL_SQL}
  ${INBOUND_LABELS_FLAG_BACKFILL_SQL}
  ${INBOUND_LABELS_TRIGGERS_SQL}
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_spam_trash_recv ON inbound_emails(is_sent, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_read_arch_spam_trash_recv ON inbound_emails(is_sent, is_read, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_star_arch_spam_trash_recv ON inbound_emails(is_sent, is_starred, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_arch_spam_trash_recv ON inbound_emails(is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_spam_recv ON inbound_emails(is_spam, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_trash_recv ON inbound_emails(is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_spam_recv ON inbound_emails(is_sent, is_spam, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_trash_recv ON inbound_emails(is_sent, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_read_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_read, is_archived, is_spam, is_trash, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_star_arch_spam_trash_recv ON inbound_emails(provider_id, is_sent, is_starred, is_archived, is_spam, is_trash, received_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (36);
  `,

  // Migration 37: re-normalize inbound label index after whitespace/truncation
  // normalization was made consistent with app-side label filters.
  `
  DELETE FROM inbound_labels;
  ${INBOUND_LABELS_BACKFILL_SQL}
  ${INBOUND_LABELS_FLAG_BACKFILL_SQL}
  INSERT OR IGNORE INTO _migrations (id) VALUES (37);
  `,

  // Migration 38: persistent Mailery email agents and per-email run ledger.
  `
  CREATE TABLE IF NOT EXISTS email_agent_settings (
    agent_key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'groq' CHECK(provider IN ('cerebras','groq')),
    model TEXT,
    apply_labels INTEGER NOT NULL DEFAULT 1,
    use_network_tools INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS email_agent_runs (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('cerebras','groq')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','error','skipped')),
    category TEXT,
    labels_json TEXT NOT NULL DEFAULT '[]',
    priority INTEGER CHECK(priority BETWEEN 1 AND 5),
    confidence REAL,
    risk_score INTEGER CHECK(risk_score BETWEEN 0 AND 100),
    summary TEXT,
    reasoning TEXT,
    tool_calls_json TEXT NOT NULL DEFAULT '[]',
    output_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_key, inbound_email_id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_agent_status ON email_agent_runs(agent_key, status, completed_at);
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_inbound ON email_agent_runs(inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_completed ON email_agent_runs(completed_at);
  INSERT OR IGNORE INTO _migrations (id) VALUES (38);
  `,

  // Migration 39: persisted inbound digest snapshots for dashboard/TUI/CLI.
  `
  CREATE TABLE IF NOT EXISTS email_digests (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL CHECK(period IN ('today','yesterday','last7','month')),
    since TEXT NOT NULL,
    until TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local','cerebras','groq')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','error')),
    message_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    highlights_json TEXT NOT NULL DEFAULT '[]',
    action_items_json TEXT NOT NULL DEFAULT '[]',
    important_email_ids_json TEXT NOT NULL DEFAULT '[]',
    label_counts_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_digests_period_completed ON email_digests(period, status, completed_at);
  CREATE INDEX IF NOT EXISTS idx_email_digests_window ON email_digests(period, since, until);
  INSERT OR IGNORE INTO _migrations (id) VALUES (39);
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
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_owners_external_id ON owners(external_id)");
  ensureProvTable("CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_external_id_unique ON owners(external_id) WHERE external_id IS NOT NULL");
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

  // Migration 36 idempotent guarantee: app-level inbound forwarding rules.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS forwarding_rules (
    id TEXT PRIMARY KEY,
    source_address TEXT NOT NULL,
    target_address TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'app-copy' CHECK(mode IN ('app-copy')),
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    from_address TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_address, target_address, mode)
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_forwarding_rules_source ON forwarding_rules(source_address, enabled)");
  ensureProvTable(`CREATE TABLE IF NOT EXISTS forwarding_deliveries (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES forwarding_rules(id) ON DELETE CASCADE,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    sent_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('sent','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(rule_id, inbound_email_id)
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_rule ON forwarding_deliveries(rule_id, created_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_inbound ON forwarding_deliveries(inbound_email_id)");

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

  // Migration 26 idempotent guarantee: composite mailbox-list indexes.
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_arch_recv ON inbound_emails(is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_read_arch_recv ON inbound_emails(is_read, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_star_arch_recv ON inbound_emails(is_starred, is_archived, received_at)");
  ensureColumn("ALTER TABLE aliases ADD COLUMN protected INTEGER NOT NULL DEFAULT 0");
  // The default, protected global catch-all (all domains) — never deletable, so
  // mail to any of our domains is never dropped. Empty target = keep, no rewrite.
  ensureProvTable("INSERT OR IGNORE INTO aliases (id, domain, local_part, target_address, protected, created_at, updated_at) VALUES ('global-catch-all', '*', '*', '', 1, datetime('now'), datetime('now'))");
  // Migration 28 idempotent guarantee: is_sent flag + index.
  ensureColumn("ALTER TABLE inbound_emails ADD COLUMN is_sent INTEGER NOT NULL DEFAULT 0");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_recv ON inbound_emails(is_sent, is_archived, received_at)");

  // Migration 29 idempotent guarantee: ownership audit log.
  ensureProvTable(`CREATE TABLE IF NOT EXISTS address_ownership_events (
    id TEXT PRIMARY KEY,
    address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    previous_owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    previous_administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    actor TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_addrownevents_address ON address_ownership_events(address_id, created_at)");

  // Migration 30 idempotent guarantee: composite indexes for list/export/stat hot paths.
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_sent_read_arch_recv ON inbound_emails(is_sent, is_read, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_sent_star_arch_recv ON inbound_emails(is_sent, is_starred, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_arch_recv ON inbound_emails(provider_id, is_sent, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_read_arch_recv ON inbound_emails(provider_id, is_sent, is_read, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_provider_sent_star_arch_recv ON inbound_emails(provider_id, is_sent, is_starred, is_archived, received_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_provider_sent ON emails(provider_id, sent_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_status_sent ON emails(status, sent_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_provider_status_sent ON emails(provider_id, status, sent_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_emails_from_sent ON emails(from_address, sent_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_events_provider_occurred ON events(provider_id, occurred_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_events_type_occurred ON events(type, occurred_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_events_provider_type_occurred ON events(provider_id, type, occurred_at)");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_inbound_message_id ON inbound_emails(message_id) WHERE message_id IS NOT NULL");
  ensureProvTable("CREATE INDEX IF NOT EXISTS idx_enrollments_due ON sequence_enrollments(status, next_send_at, id)");

  // Migration 35 idempotent guarantee: expression indexes for display-name
  // sender filters in sent mail and Gmail-synced sent mail.
  ensureProvTable(`CREATE INDEX IF NOT EXISTS idx_emails_sender_canonical_sent ON emails(${sqlEmailAddress("from_address")}, sent_at)`);
  ensureProvTable(`CREATE INDEX IF NOT EXISTS idx_emails_sender_domain_sent ON emails(${sqlEmailDomain("from_address")}, sent_at)`);
  ensureProvTable(`CREATE INDEX IF NOT EXISTS idx_inbound_sender_canonical_recv ON inbound_emails(is_sent, is_archived, ${sqlEmailAddress("from_address")}, received_at)`);
  ensureProvTable(`CREATE INDEX IF NOT EXISTS idx_inbound_sender_domain_recv ON inbound_emails(is_sent, is_archived, ${sqlEmailDomain("from_address")}, received_at)`);

  const ensureIndex = (sql: string) => {
    try { db.exec(sql); } catch {}
  };

  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_provider ON domains(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_domain_nocase ON domains(domain COLLATE NOCASE)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_domains_provider_domain_nocase ON domains(provider_id, domain COLLATE NOCASE)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_addresses_provider ON addresses(provider_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_addresses_email ON addresses(email)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_addresses_email_nocase ON addresses(email COLLATE NOCASE)");
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
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_emails(status, scheduled_at, id)");

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
  ensureInboundRecipients(db);
  ensureInboundLabels(db);

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
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_enrollments_due ON sequence_enrollments(status, next_send_at, id)");

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
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_inbound_message_id ON inbound_emails(message_id) WHERE message_id IS NOT NULL");
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

  ensureTable(`CREATE TABLE IF NOT EXISTS email_agent_settings (
    agent_key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    always_on INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'groq' CHECK(provider IN ('cerebras','groq')),
    model TEXT,
    apply_labels INTEGER NOT NULL DEFAULT 1,
    use_network_tools INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureTable(`CREATE TABLE IF NOT EXISTS email_agent_runs (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('cerebras','groq')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','error','skipped')),
    category TEXT,
    labels_json TEXT NOT NULL DEFAULT '[]',
    priority INTEGER CHECK(priority BETWEEN 1 AND 5),
    confidence REAL,
    risk_score INTEGER CHECK(risk_score BETWEEN 0 AND 100),
    summary TEXT,
    reasoning TEXT,
    tool_calls_json TEXT NOT NULL DEFAULT '[]',
    output_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_key, inbound_email_id)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_agent_runs_agent_status ON email_agent_runs(agent_key, status, completed_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_agent_runs_inbound ON email_agent_runs(inbound_email_id)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_agent_runs_completed ON email_agent_runs(completed_at)");

  ensureTable(`CREATE TABLE IF NOT EXISTS email_digests (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL CHECK(period IN ('today','yesterday','last7','month')),
    since TEXT NOT NULL,
    until TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local','cerebras','groq')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','error')),
    message_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    highlights_json TEXT NOT NULL DEFAULT '[]',
    action_items_json TEXT NOT NULL DEFAULT '[]',
    important_email_ids_json TEXT NOT NULL DEFAULT '[]',
    label_counts_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_digests_period_completed ON email_digests(period, status, completed_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_email_digests_window ON email_digests(period, since, until)");

  ensureTable(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  ensureTable(`CREATE TABLE IF NOT EXISTS forwarding_rules (
    id TEXT PRIMARY KEY,
    source_address TEXT NOT NULL,
    target_address TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'app-copy' CHECK(mode IN ('app-copy')),
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    from_address TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_address, target_address, mode)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_forwarding_rules_source ON forwarding_rules(source_address, enabled)");
  ensureTable(`CREATE TABLE IF NOT EXISTS forwarding_deliveries (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES forwarding_rules(id) ON DELETE CASCADE,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    sent_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('sent','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(rule_id, inbound_email_id)
  )`);
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_rule ON forwarding_deliveries(rule_id, created_at)");
  ensureIndex("CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_inbound ON forwarding_deliveries(inbound_email_id)");
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

let transactionCounter = 0;

export function runInTransaction<T>(db: Database, fn: () => T): T {
  const savepoint = `emails_tx_${++transactionCounter}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${savepoint}`);
    } finally {
      db.exec(`RELEASE ${savepoint}`);
    }
    throw error;
  }
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
  "templates", "contacts", "groups", "scheduled_emails", "sequences", "owners", "events",
  "aliases", "send_keys", "forwarding_rules", "forwarding_deliveries",
]);

export function resolvePartialId(db: Database, table: string, partialId: string): string | null {
  if (!RESOLVABLE_TABLES.has(table)) {
    throw new Error(`resolvePartialId: refusing unknown table '${table}'`);
  }
  if (partialId.length >= 36) {
    const row = db.query(`SELECT id FROM ${table} WHERE id = ?`).get(partialId) as { id: string } | null;
    return row?.id ?? null;
  }

  const rows = db.query(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT ?`).all(`${partialId}%`, 2) as { id: string }[];
  if (rows.length === 1) {
    return rows[0]!.id;
  }
  return null;
}

export function listPartialIdMatches(db: Database, table: string, partialId: string, limit = 6): string[] {
  if (!RESOLVABLE_TABLES.has(table)) {
    throw new Error(`resolvePartialId: refusing unknown table '${table}'`);
  }
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 6;
  const rows = db
    .query(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT ?`)
    .all(`${partialId}%`, safeLimit) as { id: string }[];
  return rows.map((row) => row.id);
}

export function resolvePartialIdOrThrow(db: Database, table: string, partialId: string): string {
  const value = partialId.trim();
  if (!value) throw new Error(`Missing ID for table '${table}'.`);

  const id = resolvePartialId(db, table, value);
  if (id) return id;

  const matches = listPartialIdMatches(db, table, value, 6);
  if (matches.length === 0) {
    throw new Error(`Could not resolve ID '${value}' in table '${table}'.`);
  }

  const preview = matches.slice(0, 5).join(", ");
  const count = matches.length >= 6 ? "at least 6" : String(matches.length);
  const extra = matches.length >= 6 ? " (showing first 5)" : "";
  throw new Error(
    `Ambiguous ID '${value}' in table '${table}' (${count} matches${extra}): ${preview}. Use a longer prefix or full ID.`,
  );
}
