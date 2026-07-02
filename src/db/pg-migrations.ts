/**
 * PostgreSQL migrations for Mailery self-hosted storage sync.
 *
 * Equivalent of the SQLite migrations in database.ts, translated for PostgreSQL.
 * Each element is a standalone SQL string that must be executed in order.
 */
export const PG_MIGRATIONS: string[] = [
  // Migration 1: Initial schema (consolidated with Gmail/sandbox provider types)
  `
  CREATE TABLE IF NOT EXISTS providers (
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
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    dkim_status TEXT NOT NULL DEFAULT 'pending' CHECK(dkim_status IN ('pending','verified','failed')),
    spf_status TEXT NOT NULL DEFAULT 'pending' CHECK(spf_status IN ('pending','verified','failed')),
    dmarc_status TEXT NOT NULL DEFAULT 'pending' CHECK(dmarc_status IN ('pending','verified','failed')),
    verified_at TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider_id, domain)
  );

  CREATE TABLE IF NOT EXISTS addresses (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT,
    sent_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    provider_event_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('delivered','bounced','complained','opened','clicked','unsubscribed')),
    recipient TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_domains_provider ON domains(provider_id);
  CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
  CREATE INDEX IF NOT EXISTS idx_addresses_provider ON addresses(provider_id);
  CREATE INDEX IF NOT EXISTS idx_addresses_email ON addresses(email);
  CREATE INDEX IF NOT EXISTS idx_emails_provider ON emails(provider_id);
  CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
  CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_idempotency ON emails(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_events_email ON events(email_id);
  CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_provider_event ON events(provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  INSERT INTO _migrations (id) VALUES (1) ON CONFLICT DO NOTHING;
  `,

  // Migration 2: OAuth fields (already on main table)
  `INSERT INTO _migrations (id) VALUES (2) ON CONFLICT DO NOTHING;`,

  // Migration 3: Templates table
  `
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    subject_template TEXT NOT NULL,
    html_template TEXT,
    text_template TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name);
  INSERT INTO _migrations (id) VALUES (3) ON CONFLICT DO NOTHING;
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
    suppressed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
  CREATE INDEX IF NOT EXISTS idx_contacts_suppressed ON contacts(suppressed);
  INSERT INTO _migrations (id) VALUES (4) ON CONFLICT DO NOTHING;
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
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_emails(status);
  CREATE INDEX IF NOT EXISTS idx_scheduled_at ON scheduled_emails(scheduled_at);
  INSERT INTO _migrations (id) VALUES (5) ON CONFLICT DO NOTHING;
  `,

  // Migration 6: Groups and group_members tables
  `
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    vars TEXT NOT NULL DEFAULT '{}',
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
  INSERT INTO _migrations (id) VALUES (6) ON CONFLICT DO NOTHING;
  `,

  // Migration 7: Email content table
  `
  CREATE TABLE IF NOT EXISTS email_content (
    email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    html TEXT,
    text_body TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}'
  );
  INSERT INTO _migrations (id) VALUES (7) ON CONFLICT DO NOTHING;
  `,

  // Migration 8: Provider type expansion (already in consolidated schema)
  `INSERT INTO _migrations (id) VALUES (8) ON CONFLICT DO NOTHING;`,

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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_provider ON sandbox_emails(provider_id);
  CREATE INDEX IF NOT EXISTS idx_sandbox_created ON sandbox_emails(created_at);
  INSERT INTO _migrations (id) VALUES (9) ON CONFLICT DO NOTHING;
  `,

  // Migration 10: Idempotency key (already on main table)
  `INSERT INTO _migrations (id) VALUES (10) ON CONFLICT DO NOTHING;`,

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
    in_reply_to_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_from ON inbound_emails(from_address);
  CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound_emails(received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_provider ON inbound_emails(provider_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_reply_to ON inbound_emails(in_reply_to_email_id);
  INSERT INTO _migrations (id) VALUES (11) ON CONFLICT DO NOTHING;
  `,

  // Migration 12: Sequences, sequence_steps, sequence_enrollments
  `
  CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_send_at TEXT,
    completed_at TEXT,
    UNIQUE(sequence_id, contact_email)
  );
  CREATE INDEX IF NOT EXISTS idx_enrollments_sequence ON sequence_enrollments(sequence_id);
  CREATE INDEX IF NOT EXISTS idx_enrollments_email ON sequence_enrollments(contact_email);
  CREATE INDEX IF NOT EXISTS idx_enrollments_next_send ON sequence_enrollments(next_send_at);
  CREATE INDEX IF NOT EXISTS idx_enrollments_status ON sequence_enrollments(status);
  INSERT INTO _migrations (id) VALUES (12) ON CONFLICT DO NOTHING;
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_warming_domain ON warming_schedules(domain);
  CREATE INDEX IF NOT EXISTS idx_warming_status ON warming_schedules(status);
  INSERT INTO _migrations (id) VALUES (13) ON CONFLICT DO NOTHING;
  `,

  // Migration 14: Reply tracking (already on inbound_emails table)
  `INSERT INTO _migrations (id) VALUES (14) ON CONFLICT DO NOTHING;`,

  // Migration 15: Gmail sync state + dedup index
  `
  CREATE TABLE IF NOT EXISTS gmail_sync_state (
    provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    last_synced_at TEXT,
    last_message_id TEXT,
    history_id TEXT,
    next_page_token TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_provider_message ON inbound_emails(provider_id, message_id)
    WHERE provider_id IS NOT NULL AND message_id IS NOT NULL;
  INSERT INTO _migrations (id) VALUES (15) ON CONFLICT DO NOTHING;
  `,

  // Migration 16: AI triage table
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
    confidence DOUBLE PRECISION DEFAULT 0.0,
    model TEXT,
    triaged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_triage_email ON email_triage(email_id);
  CREATE INDEX IF NOT EXISTS idx_triage_inbound ON email_triage(inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_triage_label ON email_triage(label);
  CREATE INDEX IF NOT EXISTS idx_triage_priority ON email_triage(priority);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_email_unique ON email_triage(email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_inbound_unique ON email_triage(inbound_email_id) WHERE inbound_email_id IS NOT NULL;
  INSERT INTO _migrations (id) VALUES (16) ON CONFLICT DO NOTHING;
  `,

  // Migration 17: attachment_paths — store local/S3 paths for downloaded attachments
  `
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS attachment_paths TEXT NOT NULL DEFAULT '[]';
  INSERT INTO _migrations (id) VALUES (17) ON CONFLICT DO NOTHING;
  `,

  // Migration 18: Gmail archive metadata and S3 object references
  `
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS provider_history_id TEXT;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS provider_internal_date TEXT;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS label_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS raw_s3_url TEXT;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS metadata_s3_url TEXT;
  CREATE INDEX IF NOT EXISTS idx_inbound_thread ON inbound_emails(provider_thread_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_history ON inbound_emails(provider_history_id);
  INSERT INTO _migrations (id) VALUES (18) ON CONFLICT DO NOTHING;
  `,

  // Migration 19: automated provisioning — domain/address lifecycle + audit.
  `
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS provisioning_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS purchase_provider TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS dns_provider TEXT NOT NULL DEFAULT 'cloudflare';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS send_provider TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS cf_zone_id TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS registrar TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS nameservers_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS mail_from_domain TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS last_error TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS next_check_at TEXT;

  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS domain_id TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS receive_strategy TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS forward_to TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS routing_rule_id TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS provisioning_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS last_validated_at TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS last_error TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS next_check_at TEXT;

  CREATE TABLE IF NOT EXISTS provisioning_events (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_provevents_entity ON provisioning_events(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_domains_provstatus ON domains(provisioning_status);
  CREATE INDEX IF NOT EXISTS idx_addresses_provstatus ON addresses(provisioning_status);
  CREATE INDEX IF NOT EXISTS idx_addresses_domain ON addresses(domain_id);
  INSERT INTO _migrations (id) VALUES (19) ON CONFLICT DO NOTHING;
  `,

  // Migration 20: tenancy — owners (human|agent) + address ownership/administration.
  `
  CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    contact_email TEXT,
    external_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_owners_type ON owners(type);
  CREATE INDEX IF NOT EXISTS idx_owners_name ON owners(name);
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS owner_id TEXT;
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS administrator_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_addresses_owner ON addresses(owner_id);
  CREATE INDEX IF NOT EXISTS idx_addresses_admin ON addresses(administrator_id);
  INSERT INTO _migrations (id) VALUES (20) ON CONFLICT DO NOTHING;
  `,

  // Migration 21: threading.
  `
  ALTER TABLE emails ADD COLUMN IF NOT EXISTS message_id TEXT;
  ALTER TABLE emails ADD COLUMN IF NOT EXISTS thread_id TEXT;
  ALTER TABLE emails ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
  ALTER TABLE emails ADD COLUMN IF NOT EXISTS references_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS thread_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
  CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_threadid ON inbound_emails(thread_id);
  INSERT INTO _migrations (id) VALUES (21) ON CONFLICT DO NOTHING;
  `,
  // Migration 22: address lifecycle.
  `
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE addresses ADD COLUMN IF NOT EXISTS daily_quota INTEGER;
  CREATE INDEX IF NOT EXISTS idx_addresses_status ON addresses(status);
  INSERT INTO _migrations (id) VALUES (22) ON CONFLICT DO NOTHING;
  `,

  // Migration 23: inbound local read-state / archive / star.
  `
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_read INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS read_at TEXT;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_starred INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_inbound_is_read ON inbound_emails(is_read);
  CREATE INDEX IF NOT EXISTS idx_inbound_is_archived ON inbound_emails(is_archived);
  INSERT INTO _migrations (id) VALUES (23) ON CONFLICT DO NOTHING;
  `,

  // Migration 24: per-domain aliases + catch-all.
  `
  CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    local_part TEXT NOT NULL,
    target_address TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(domain, local_part)
  );
  CREATE INDEX IF NOT EXISTS idx_aliases_domain ON aliases(domain);
  INSERT INTO _migrations (id) VALUES (24) ON CONFLICT DO NOTHING;
  `,

  // Migration 25: scoped send keys.
  `
  CREATE TABLE IF NOT EXISTS send_keys (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_send_keys_owner ON send_keys(owner_id);
  CREATE INDEX IF NOT EXISTS idx_send_keys_hash ON send_keys(key_hash);
  INSERT INTO _migrations (id) VALUES (25) ON CONFLICT DO NOTHING;
  `,

  // Migration 26: composite mailbox-list indexes (see SQLite migration 26).
  `
  CREATE INDEX IF NOT EXISTS idx_inbound_arch_recv ON inbound_emails(is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_read_arch_recv ON inbound_emails(is_read, is_archived, received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_star_arch_recv ON inbound_emails(is_starred, is_archived, received_at);
  INSERT INTO _migrations (id) VALUES (26) ON CONFLICT DO NOTHING;
  `,

  // Migration 27: aliases.protected.
  `
  ALTER TABLE aliases ADD COLUMN IF NOT EXISTS protected INTEGER NOT NULL DEFAULT 0;
  INSERT INTO _migrations (id) VALUES (27) ON CONFLICT DO NOTHING;
  `,

  // Migration 28: denormalized is_sent flag on inbound_emails (see SQLite).
  `
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_sent INTEGER NOT NULL DEFAULT 0;
  UPDATE inbound_emails SET is_sent = 1 WHERE LOWER(label_ids_json) LIKE '%"sent"%';
  CREATE INDEX IF NOT EXISTS idx_inbound_sent_arch_recv ON inbound_emails(is_sent, is_archived, received_at);
  INSERT INTO _migrations (id) VALUES (28) ON CONFLICT DO NOTHING;
  `,

  // Migration 29: address ownership audit log.
  `
  CREATE TABLE IF NOT EXISTS address_ownership_events (
    id TEXT PRIMARY KEY,
    address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    previous_owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    previous_administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    administrator_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    actor TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_addrownevents_address ON address_ownership_events(address_id, created_at);
  INSERT INTO _migrations (id) VALUES (29) ON CONFLICT DO NOTHING;
  `,

  // Migration 30: hot-path composite indexes for bounded list views.
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
  INSERT INTO _migrations (id) VALUES (30) ON CONFLICT DO NOTHING;
  `,

  // Migration 31: denormalized recipient index for inbound mail.
  `
  CREATE TABLE IF NOT EXISTS inbound_recipients (
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    domain TEXT NOT NULL,
    PRIMARY KEY (inbound_email_id, address)
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_address ON inbound_recipients(address, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_domain ON inbound_recipients(domain, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_recipients_email ON inbound_recipients(inbound_email_id);
  INSERT INTO _migrations (id) VALUES (31) ON CONFLICT DO NOTHING;
  `,

  // Migration 32: standalone inbound message-id index for S3 object dedupe.
  `
  CREATE INDEX IF NOT EXISTS idx_inbound_message_id ON inbound_emails(message_id)
    WHERE message_id IS NOT NULL;
  INSERT INTO _migrations (id) VALUES (32) ON CONFLICT DO NOTHING;
  `,

  // Migration 33: scheduler due-enrollment composite index.
  `
  CREATE INDEX IF NOT EXISTS idx_enrollments_due ON sequence_enrollments(status, next_send_at, id);
  INSERT INTO _migrations (id) VALUES (33) ON CONFLICT DO NOTHING;
  `,

  // Migration 34: scheduler due-email composite index.
  `
  CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_emails(status, scheduled_at, id);
  INSERT INTO _migrations (id) VALUES (34) ON CONFLICT DO NOTHING;
  `,

  // Migration 35: expression indexes for display-name sender filters.
  `
  CREATE INDEX IF NOT EXISTS idx_emails_sender_canonical_sent ON emails((
    lower(btrim(CASE
      WHEN btrim(from_address) ~ '<[^<>]+>' THEN regexp_replace(btrim(from_address), '^.*<([^<>]+)>.*$', '\\1')
      ELSE rtrim(btrim(from_address), ' >')
    END))
  ), sent_at);
  CREATE INDEX IF NOT EXISTS idx_emails_sender_domain_sent ON emails((
    split_part(lower(btrim(CASE
      WHEN btrim(from_address) ~ '<[^<>]+>' THEN regexp_replace(btrim(from_address), '^.*<([^<>]+)>.*$', '\\1')
      ELSE rtrim(btrim(from_address), ' >')
    END)), '@', 2)
  ), sent_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sender_canonical_recv ON inbound_emails(is_sent, is_archived, (
    lower(btrim(CASE
      WHEN btrim(from_address) ~ '<[^<>]+>' THEN regexp_replace(btrim(from_address), '^.*<([^<>]+)>.*$', '\\1')
      ELSE rtrim(btrim(from_address), ' >')
    END))
  ), received_at);
  CREATE INDEX IF NOT EXISTS idx_inbound_sender_domain_recv ON inbound_emails(is_sent, is_archived, (
    split_part(lower(btrim(CASE
      WHEN btrim(from_address) ~ '<[^<>]+>' THEN regexp_replace(btrim(from_address), '^.*<([^<>]+)>.*$', '\\1')
      ELSE rtrim(btrim(from_address), ' >')
    END)), '@', 2)
  ), received_at);
  INSERT INTO _migrations (id) VALUES (35) ON CONFLICT DO NOTHING;
  `,

  // Migration 36: app-level inbound forwarding rules and delivery ledger.
  `
  CREATE TABLE IF NOT EXISTS forwarding_rules (
    id TEXT PRIMARY KEY,
    source_address TEXT NOT NULL,
    target_address TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'app-copy' CHECK(mode IN ('app-copy')),
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    from_address TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_address, target_address, mode)
  );
  CREATE INDEX IF NOT EXISTS idx_forwarding_rules_source ON forwarding_rules(source_address, enabled);
  CREATE TABLE IF NOT EXISTS forwarding_deliveries (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES forwarding_rules(id) ON DELETE CASCADE,
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    sent_email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('sent','failed')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(rule_id, inbound_email_id)
  );
  CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_rule ON forwarding_deliveries(rule_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_forwarding_deliveries_inbound ON forwarding_deliveries(inbound_email_id);
  INSERT INTO _migrations (id) VALUES (36) ON CONFLICT DO NOTHING;
  `,

  // Migration 37: normalized labels plus hot spam/trash flags for Mailery UI.
  `
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_spam INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS is_trash INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS inbound_labels (
    inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    PRIMARY KEY (inbound_email_id, label)
  );
  CREATE INDEX IF NOT EXISTS idx_inbound_labels_label ON inbound_labels(label, inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_labels_email ON inbound_labels(inbound_email_id);
  CREATE OR REPLACE FUNCTION mailery_jsonb_array_text(input text)
  RETURNS SETOF text
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RETURN QUERY SELECT jsonb_array_elements_text(input::jsonb);
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  $$;
  INSERT INTO inbound_labels (inbound_email_id, label)
  SELECT e.id, left(regexp_replace(lower(trim(value)), '\\s+', '-', 'g'), 64)
    FROM inbound_emails e,
         mailery_jsonb_array_text(e.label_ids_json) AS value
   WHERE e.label_ids_json IS NOT NULL
     AND trim(value) != ''
  ON CONFLICT DO NOTHING;
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
  INSERT INTO _migrations (id) VALUES (37) ON CONFLICT DO NOTHING;
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_key, inbound_email_id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_agent_status ON email_agent_runs(agent_key, status, completed_at);
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_inbound ON email_agent_runs(inbound_email_id);
  CREATE INDEX IF NOT EXISTS idx_email_agent_runs_completed ON email_agent_runs(completed_at);
  INSERT INTO _migrations (id) VALUES (38) ON CONFLICT DO NOTHING;
  `,

  // Migration 39: persisted inbound digest snapshots for dashboard/TUI/CLI.
  `
  CREATE TABLE IF NOT EXISTS email_digests (
    id TEXT PRIMARY KEY,
    period TEXT NOT NULL CHECK(period IN ('today','yesterday','last7','month')),
    since TIMESTAMPTZ NOT NULL,
    until TIMESTAMPTZ NOT NULL,
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
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_email_digests_period_completed ON email_digests(period, status, completed_at);
  CREATE INDEX IF NOT EXISTS idx_email_digests_window ON email_digests(period, since, until);
  INSERT INTO _migrations (id) VALUES (39) ON CONFLICT DO NOTHING;
  `,

  // Migration 40: Provider/Source/Mailbox/Folder architecture.
  `
  CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    display_name TEXT,
    owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS mail_folders (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'custom' CHECK(role IN ('inbox','sent','archive','spam','trash','custom')),
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    provider_folder_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(mailbox_id, path)
  );

  CREATE TABLE IF NOT EXISTS mailbox_sources (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK(type IN ('ses','ses_s3','gmail','resend','sandbox','legacy_inbound','manual')),
    name TEXT NOT NULL,
    external_account_id TEXT,
    external_mailbox TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','legacy')),
    settings_json TEXT NOT NULL DEFAULT '{}',
    provider_snapshot_json TEXT NOT NULL DEFAULT '{}',
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(mailbox_id, provider_id, type, external_mailbox)
  );

  CREATE TABLE IF NOT EXISTS mail_messages (
    id TEXT PRIMARY KEY,
    rfc_message_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    from_address TEXT,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    bcc_addresses TEXT NOT NULL DEFAULT '[]',
    text_body TEXT,
    html_body TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    raw_s3_url TEXT,
    metadata_s3_url TEXT,
    raw_size INTEGER NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS mailbox_message_state (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    mail_message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    folder_id TEXT REFERENCES mail_folders(id) ON DELETE SET NULL,
    source_id TEXT REFERENCES mailbox_sources(id) ON DELETE SET NULL,
    source_dedupe_key TEXT,
    direction TEXT NOT NULL DEFAULT 'inbound' CHECK(direction IN ('inbound','outbound','sent')),
    provider_message_id TEXT,
    provider_thread_id TEXT,
    thread_id TEXT,
    labels_json TEXT NOT NULL DEFAULT '[]',
    is_read INTEGER NOT NULL DEFAULT 0,
    read_at TIMESTAMPTZ,
    is_archived INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_spam INTEGER NOT NULL DEFAULT 0,
    is_trash INTEGER NOT NULL DEFAULT 0,
    received_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(mailbox_id, mail_message_id)
  );

  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS mail_message_id TEXT REFERENCES mail_messages(id) ON DELETE SET NULL;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS primary_mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL;
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS primary_mailbox_source_id TEXT REFERENCES mailbox_sources(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes(address);
  CREATE INDEX IF NOT EXISTS idx_mailboxes_owner ON mailboxes(owner_id);
  CREATE INDEX IF NOT EXISTS idx_mail_folders_mailbox_role ON mail_folders(mailbox_id, role);
  CREATE INDEX IF NOT EXISTS idx_mailbox_sources_mailbox ON mailbox_sources(mailbox_id, status);
  CREATE INDEX IF NOT EXISTS idx_mailbox_sources_provider ON mailbox_sources(provider_id);
  CREATE INDEX IF NOT EXISTS idx_mail_messages_rfc_message_id ON mail_messages(rfc_message_id) WHERE rfc_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_mail_messages_received ON mail_messages(received_at);
  CREATE INDEX IF NOT EXISTS idx_mailbox_state_mailbox_folder_received ON mailbox_message_state(mailbox_id, folder_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_mailbox_state_message ON mailbox_message_state(mail_message_id);
  CREATE INDEX IF NOT EXISTS idx_mailbox_state_source ON mailbox_message_state(source_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_state_source_dedupe ON mailbox_message_state(source_id, source_dedupe_key)
    WHERE source_id IS NOT NULL AND source_dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_inbound_mail_message ON inbound_emails(mail_message_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_primary_mailbox ON inbound_emails(primary_mailbox_id);
  CREATE INDEX IF NOT EXISTS idx_inbound_primary_source ON inbound_emails(primary_mailbox_source_id);

  WITH raw_recipients AS (
    SELECT inbound.id AS inbound_email_id,
           lower(btrim(CASE
             WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
             ELSE btrim(value)
           END)) AS address
      FROM inbound_emails inbound,
           mailery_jsonb_array_text(inbound.to_addresses) AS value
  ),
  valid_recipients AS (
    SELECT inbound_email_id, address, 'mbx:' || address AS mailbox_id
      FROM raw_recipients
     WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
    UNION ALL
    SELECT inbound.id,
           'legacy-inbound@local.mailery',
           'mbx:legacy-inbound@local.mailery'
      FROM inbound_emails inbound
     WHERE NOT EXISTS (
       SELECT 1 FROM raw_recipients raw
        WHERE raw.inbound_email_id = inbound.id
          AND raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
     )
  )
  INSERT INTO mailboxes (id, address, display_name, status, created_at, updated_at)
  SELECT mailbox_id, address, address, 'active', MIN(inbound.created_at), NOW()
    FROM valid_recipients recipients
    JOIN inbound_emails inbound ON inbound.id = recipients.inbound_email_id
   GROUP BY mailbox_id, address
  ON CONFLICT DO NOTHING;

  INSERT INTO mail_folders (id, mailbox_id, role, name, path, sort_order, created_at, updated_at)
  SELECT 'folder:' || id || ':inbox', id, 'inbox', 'Inbox', 'INBOX', 10, NOW(), NOW() FROM mailboxes
  ON CONFLICT DO NOTHING;
  INSERT INTO mail_folders (id, mailbox_id, role, name, path, sort_order, created_at, updated_at)
  SELECT 'folder:' || id || ':sent', id, 'sent', 'Sent', 'SENT', 20, NOW(), NOW() FROM mailboxes
  ON CONFLICT DO NOTHING;
  INSERT INTO mail_folders (id, mailbox_id, role, name, path, sort_order, created_at, updated_at)
  SELECT 'folder:' || id || ':archive', id, 'archive', 'Archive', 'ARCHIVE', 30, NOW(), NOW() FROM mailboxes
  ON CONFLICT DO NOTHING;
  INSERT INTO mail_folders (id, mailbox_id, role, name, path, sort_order, created_at, updated_at)
  SELECT 'folder:' || id || ':spam', id, 'spam', 'Spam', 'SPAM', 40, NOW(), NOW() FROM mailboxes
  ON CONFLICT DO NOTHING;
  INSERT INTO mail_folders (id, mailbox_id, role, name, path, sort_order, created_at, updated_at)
  SELECT 'folder:' || id || ':trash', id, 'trash', 'Trash', 'TRASH', 50, NOW(), NOW() FROM mailboxes
  ON CONFLICT DO NOTHING;

  -- Do not duplicate historical bodies into mail_messages. Existing inbound
  -- bodies remain preserved in inbound_emails and can be joined by the
  -- deterministic msg:inbound:<id> link; new inserts populate canonical bodies.
  INSERT INTO mail_messages (
    id, rfc_message_id, subject, from_address, to_addresses, cc_addresses, bcc_addresses,
    text_body, html_body, headers_json, attachments_json, raw_s3_url, metadata_s3_url,
    raw_size, received_at, created_at, updated_at
  )
  SELECT 'msg:inbound:' || id,
         message_id,
         subject,
         from_address,
         to_addresses,
         cc_addresses,
         '[]',
         NULL,
         NULL,
         headers_json,
         attachments_json,
         raw_s3_url,
         metadata_s3_url,
         COALESCE(raw_size, 0),
         received_at,
         created_at,
         NOW()
    FROM inbound_emails
  ON CONFLICT DO NOTHING;

  WITH raw_recipients AS (
    SELECT inbound.id AS inbound_email_id,
           lower(btrim(CASE
             WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
             ELSE btrim(value)
           END)) AS address
      FROM inbound_emails inbound,
           mailery_jsonb_array_text(inbound.to_addresses) AS value
  ),
  valid_recipients AS (
    SELECT inbound_email_id, address, 'mbx:' || address AS mailbox_id
      FROM raw_recipients
     WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
    UNION ALL
    SELECT inbound.id,
           'legacy-inbound@local.mailery',
           'mbx:legacy-inbound@local.mailery'
      FROM inbound_emails inbound
     WHERE NOT EXISTS (
       SELECT 1 FROM raw_recipients raw
        WHERE raw.inbound_email_id = inbound.id
          AND raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
     )
  ),
  source_rows AS (
    SELECT DISTINCT
           recipients.mailbox_id,
           CASE WHEN provider.id IS NULL THEN NULL ELSE inbound.provider_id END AS provider_id,
           CASE
             WHEN provider.type = 'gmail' THEN 'gmail'
             WHEN provider.type = 'ses' AND (inbound.raw_s3_url IS NOT NULL OR inbound.metadata_s3_url IS NOT NULL OR COALESCE(inbound.message_id, '') LIKE 'inbound/%') THEN 'ses_s3'
             WHEN provider.type = 'ses' THEN 'ses'
             WHEN provider.type = 'resend' THEN 'resend'
             WHEN provider.type = 'sandbox' THEN 'sandbox'
             ELSE 'legacy_inbound'
           END AS source_type,
           provider.name AS provider_name,
           provider.type AS provider_type,
           provider.region AS provider_region,
           provider.active AS provider_active,
           provider.created_at AS provider_created_at,
           provider.updated_at AS provider_updated_at
      FROM valid_recipients recipients
      JOIN inbound_emails inbound ON inbound.id = recipients.inbound_email_id
      LEFT JOIN providers provider ON provider.id = inbound.provider_id
  )
  INSERT INTO mailbox_sources (
    id, mailbox_id, provider_id, type, name, external_mailbox, status,
    settings_json, provider_snapshot_json, created_at, updated_at
  )
  SELECT 'msrc:' || mailbox_id || ':' || COALESCE(provider_id, 'none') || ':' || source_type,
         mailbox_id,
         provider_id,
         source_type,
         COALESCE(provider_name || ' ' || source_type, 'Legacy inbound'),
         substring(mailbox_id from 5),
         CASE WHEN source_type IN ('legacy_inbound', 'gmail') THEN 'legacy' ELSE 'active' END,
         '{}',
         CASE WHEN provider_id IS NULL THEN '{}' ELSE jsonb_build_object(
           'id', provider_id,
           'name', provider_name,
           'type', provider_type,
           'region', provider_region,
           'active', provider_active,
           'created_at', provider_created_at,
           'updated_at', provider_updated_at
         )::text END,
         NOW(),
         NOW()
    FROM source_rows
  ON CONFLICT DO NOTHING;

  WITH raw_recipients AS (
    SELECT inbound.id AS inbound_email_id,
           lower(btrim(CASE
             WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
             ELSE btrim(value)
           END)) AS address
      FROM inbound_emails inbound,
           mailery_jsonb_array_text(inbound.to_addresses) AS value
  ),
  valid_recipients AS (
    SELECT inbound_email_id, address, 'mbx:' || address AS mailbox_id
      FROM raw_recipients
     WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
    UNION ALL
    SELECT inbound.id,
           'legacy-inbound@local.mailery',
           'mbx:legacy-inbound@local.mailery'
      FROM inbound_emails inbound
     WHERE NOT EXISTS (
       SELECT 1 FROM raw_recipients raw
        WHERE raw.inbound_email_id = inbound.id
          AND raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
     )
  ),
  state_rows AS (
    SELECT state_base.*,
           COUNT(*) OVER (
             PARTITION BY state_base.mailbox_id,
                          COALESCE(state_base.source_provider_id, 'none'),
                          state_base.source_type,
                          state_base.dedupe_base
           ) AS source_dedupe_count
      FROM (
        SELECT inbound.*,
               recipients.address,
               recipients.mailbox_id,
               CASE WHEN provider.id IS NULL THEN NULL ELSE inbound.provider_id END AS source_provider_id,
               COALESCE(NULLIF(inbound.message_id, ''), inbound.id) AS dedupe_base,
               CASE
                 WHEN provider.type = 'gmail' THEN 'gmail'
                 WHEN provider.type = 'ses' AND (inbound.raw_s3_url IS NOT NULL OR inbound.metadata_s3_url IS NOT NULL OR COALESCE(inbound.message_id, '') LIKE 'inbound/%') THEN 'ses_s3'
                 WHEN provider.type = 'ses' THEN 'ses'
                 WHEN provider.type = 'resend' THEN 'resend'
                 WHEN provider.type = 'sandbox' THEN 'sandbox'
                 ELSE 'legacy_inbound'
               END AS source_type,
               CASE
                 WHEN COALESCE(inbound.is_sent, 0) = 1 THEN 'sent'
                 WHEN COALESCE(inbound.is_trash, 0) = 1 THEN 'trash'
                 WHEN COALESCE(inbound.is_spam, 0) = 1 THEN 'spam'
                 WHEN COALESCE(inbound.is_archived, 0) = 1 THEN 'archive'
                 ELSE 'inbox'
               END AS folder_role
          FROM valid_recipients recipients
          JOIN inbound_emails inbound ON inbound.id = recipients.inbound_email_id
          LEFT JOIN providers provider ON provider.id = inbound.provider_id
      ) state_base
  )
  INSERT INTO mailbox_message_state (
    id, mailbox_id, mail_message_id, folder_id, source_id, source_dedupe_key,
    direction, provider_message_id, provider_thread_id, thread_id, labels_json,
    is_read, read_at, is_archived, is_starred, is_spam, is_trash, received_at,
    created_at, updated_at
  )
  SELECT 'state:' || id || ':' || address,
         mailbox_id,
         'msg:inbound:' || id,
         'folder:' || mailbox_id || ':' || folder_role,
         'msrc:' || mailbox_id || ':' || COALESCE(source_provider_id, 'none') || ':' || source_type,
         CASE
           WHEN source_dedupe_count > 1 THEN dedupe_base || ':inbound:' || id
           ELSE dedupe_base
         END,
         CASE WHEN COALESCE(is_sent, 0) = 1 THEN 'sent' ELSE 'inbound' END,
         message_id,
         provider_thread_id,
         thread_id,
         label_ids_json,
         COALESCE(is_read, 0),
         NULLIF(read_at, '')::TIMESTAMPTZ,
         COALESCE(is_archived, 0),
         COALESCE(is_starred, 0),
         COALESCE(is_spam, 0),
         COALESCE(is_trash, 0),
         received_at,
         created_at,
         NOW()
    FROM state_rows
  ON CONFLICT DO NOTHING;

  UPDATE inbound_emails
     SET mail_message_id = COALESCE(mail_message_id, 'msg:inbound:' || id);

  UPDATE inbound_emails
     SET primary_mailbox_id = COALESCE(primary_mailbox_id, (
           SELECT state.mailbox_id
             FROM mailbox_message_state state
            WHERE state.mail_message_id = 'msg:inbound:' || inbound_emails.id
            ORDER BY state.mailbox_id
            LIMIT 1
         )),
         primary_mailbox_source_id = COALESCE(primary_mailbox_source_id, (
           SELECT state.source_id
             FROM mailbox_message_state state
            WHERE state.mail_message_id = 'msg:inbound:' || inbound_emails.id
            ORDER BY state.mailbox_id
             LIMIT 1
         ));

  CREATE OR REPLACE FUNCTION mailery_after_inbound_insert_architecture()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    INSERT INTO mail_messages (
      id, rfc_message_id, subject, from_address, to_addresses, cc_addresses, bcc_addresses,
      text_body, html_body, headers_json, attachments_json, raw_s3_url, metadata_s3_url,
      raw_size, received_at, created_at, updated_at
    )
    VALUES (
      'msg:inbound:' || NEW.id,
      NEW.message_id,
      NEW.subject,
      NEW.from_address,
      NEW.to_addresses,
      NEW.cc_addresses,
      '[]',
      NEW.text_body,
      NEW.html_body,
      NEW.headers_json,
      NEW.attachments_json,
      NEW.raw_s3_url,
      NEW.metadata_s3_url,
      COALESCE(NEW.raw_size, 0),
      NEW.received_at,
      NEW.created_at,
      NOW()
    )
    ON CONFLICT DO NOTHING;

    UPDATE inbound_emails
       SET mail_message_id = COALESCE(mail_message_id, 'msg:inbound:' || NEW.id)
     WHERE id = NEW.id;

    WITH raw_recipients AS (
      SELECT lower(btrim(CASE
               WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
               ELSE btrim(value)
             END)) AS address
        FROM mailery_jsonb_array_text(NEW.to_addresses) AS value
    ),
    valid_recipients AS (
      SELECT address, 'mbx:' || address AS mailbox_id
        FROM raw_recipients
       WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
      UNION ALL
      SELECT 'legacy-inbound@local.mailery',
             'mbx:legacy-inbound@local.mailery'
       WHERE NOT EXISTS (
         SELECT 1 FROM raw_recipients raw
          WHERE raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
       )
    )
    INSERT INTO mailboxes (id, address, display_name, status, created_at, updated_at)
    SELECT mailbox_id, address, address, 'active', NEW.created_at, NOW()
      FROM valid_recipients
    ON CONFLICT DO NOTHING;

    WITH raw_recipients AS (
      SELECT lower(btrim(CASE
               WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
               ELSE btrim(value)
             END)) AS address
        FROM mailery_jsonb_array_text(NEW.to_addresses) AS value
    ),
    valid_recipients AS (
      SELECT address, 'mbx:' || address AS mailbox_id
        FROM raw_recipients
       WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
      UNION ALL
      SELECT 'legacy-inbound@local.mailery',
             'mbx:legacy-inbound@local.mailery'
       WHERE NOT EXISTS (
         SELECT 1 FROM raw_recipients raw
          WHERE raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
       )
    )
    INSERT INTO mail_folders (id, mailbox_id, role, name, path, sort_order, created_at, updated_at)
    SELECT 'folder:' || mailbox_id || ':inbox', mailbox_id, 'inbox', 'Inbox', 'INBOX', 10, NOW(), NOW()
      FROM valid_recipients
    UNION ALL
    SELECT 'folder:' || mailbox_id || ':sent', mailbox_id, 'sent', 'Sent', 'SENT', 20, NOW(), NOW()
      FROM valid_recipients
    UNION ALL
    SELECT 'folder:' || mailbox_id || ':archive', mailbox_id, 'archive', 'Archive', 'ARCHIVE', 30, NOW(), NOW()
      FROM valid_recipients
    UNION ALL
    SELECT 'folder:' || mailbox_id || ':spam', mailbox_id, 'spam', 'Spam', 'SPAM', 40, NOW(), NOW()
      FROM valid_recipients
    UNION ALL
    SELECT 'folder:' || mailbox_id || ':trash', mailbox_id, 'trash', 'Trash', 'TRASH', 50, NOW(), NOW()
      FROM valid_recipients
    ON CONFLICT DO NOTHING;

    WITH raw_recipients AS (
      SELECT lower(btrim(CASE
               WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
               ELSE btrim(value)
             END)) AS address
        FROM mailery_jsonb_array_text(NEW.to_addresses) AS value
    ),
    valid_recipients AS (
      SELECT address, 'mbx:' || address AS mailbox_id
        FROM raw_recipients
       WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
      UNION ALL
      SELECT 'legacy-inbound@local.mailery',
             'mbx:legacy-inbound@local.mailery'
       WHERE NOT EXISTS (
         SELECT 1 FROM raw_recipients raw
          WHERE raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
       )
    ),
    source_rows AS (
      SELECT recipients.address,
             recipients.mailbox_id,
             CASE WHEN provider.id IS NULL THEN NULL ELSE NEW.provider_id END AS provider_id,
             CASE
               WHEN provider.type = 'gmail' THEN 'gmail'
               WHEN provider.type = 'ses' AND (NEW.raw_s3_url IS NOT NULL OR NEW.metadata_s3_url IS NOT NULL OR COALESCE(NEW.message_id, '') LIKE 'inbound/%') THEN 'ses_s3'
               WHEN provider.type = 'ses' THEN 'ses'
               WHEN provider.type = 'resend' THEN 'resend'
               WHEN provider.type = 'sandbox' THEN 'sandbox'
               ELSE 'legacy_inbound'
             END AS source_type,
             provider.name AS provider_name,
             provider.type AS provider_type,
             provider.region AS provider_region,
             provider.active AS provider_active,
             provider.created_at AS provider_created_at,
             provider.updated_at AS provider_updated_at
        FROM valid_recipients recipients
        LEFT JOIN providers provider ON provider.id = NEW.provider_id
    )
    INSERT INTO mailbox_sources (
      id, mailbox_id, provider_id, type, name, external_mailbox, status,
      settings_json, provider_snapshot_json, created_at, updated_at
    )
    SELECT 'msrc:' || mailbox_id || ':' || COALESCE(provider_id, 'none') || ':' || source_type,
           mailbox_id,
           provider_id,
           source_type,
           COALESCE(provider_name || ' ' || source_type, 'Legacy inbound'),
           address,
           CASE WHEN source_type IN ('legacy_inbound', 'gmail') THEN 'legacy' ELSE 'active' END,
           '{}',
           CASE WHEN provider_id IS NULL THEN '{}' ELSE jsonb_build_object(
             'id', provider_id,
             'name', provider_name,
             'type', provider_type,
             'region', provider_region,
             'active', provider_active,
             'created_at', provider_created_at,
             'updated_at', provider_updated_at
           )::text END,
           NOW(),
           NOW()
      FROM source_rows
    ON CONFLICT DO NOTHING;

    WITH raw_recipients AS (
      SELECT lower(btrim(CASE
               WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
               ELSE btrim(value)
             END)) AS address
        FROM mailery_jsonb_array_text(NEW.to_addresses) AS value
    ),
    valid_recipients AS (
      SELECT address, 'mbx:' || address AS mailbox_id
        FROM raw_recipients
       WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
      UNION ALL
      SELECT 'legacy-inbound@local.mailery',
             'mbx:legacy-inbound@local.mailery'
       WHERE NOT EXISTS (
         SELECT 1 FROM raw_recipients raw
          WHERE raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
       )
    ),
    state_rows AS (
      SELECT recipients.address,
             recipients.mailbox_id,
             CASE WHEN provider.id IS NULL THEN NULL ELSE NEW.provider_id END AS provider_id,
             COALESCE(NULLIF(NEW.message_id, ''), NEW.id) AS dedupe_base,
             CASE
               WHEN provider.type = 'gmail' THEN 'gmail'
               WHEN provider.type = 'ses' AND (NEW.raw_s3_url IS NOT NULL OR NEW.metadata_s3_url IS NOT NULL OR COALESCE(NEW.message_id, '') LIKE 'inbound/%') THEN 'ses_s3'
               WHEN provider.type = 'ses' THEN 'ses'
               WHEN provider.type = 'resend' THEN 'resend'
               WHEN provider.type = 'sandbox' THEN 'sandbox'
               ELSE 'legacy_inbound'
             END AS source_type,
             CASE
               WHEN COALESCE(NEW.is_sent, 0) = 1 THEN 'sent'
               WHEN COALESCE(NEW.is_trash, 0) = 1 THEN 'trash'
               WHEN COALESCE(NEW.is_spam, 0) = 1 THEN 'spam'
               WHEN COALESCE(NEW.is_archived, 0) = 1 THEN 'archive'
               ELSE 'inbox'
             END AS folder_role
        FROM valid_recipients recipients
        LEFT JOIN providers provider ON provider.id = NEW.provider_id
    )
    INSERT INTO mailbox_message_state (
      id, mailbox_id, mail_message_id, folder_id, source_id, source_dedupe_key,
      direction, provider_message_id, provider_thread_id, thread_id, labels_json,
      is_read, read_at, is_archived, is_starred, is_spam, is_trash, received_at,
      created_at, updated_at
    )
    SELECT 'state:' || NEW.id || ':' || address,
           mailbox_id,
           'msg:inbound:' || NEW.id,
           'folder:' || mailbox_id || ':' || folder_role,
           'msrc:' || mailbox_id || ':' || COALESCE(provider_id, 'none') || ':' || source_type,
           CASE
             WHEN EXISTS (
               SELECT 1
                 FROM mailbox_message_state existing_state
                WHERE existing_state.source_id = 'msrc:' || mailbox_id || ':' || COALESCE(provider_id, 'none') || ':' || source_type
                  AND existing_state.source_dedupe_key = dedupe_base
                LIMIT 1
             ) THEN dedupe_base || ':inbound:' || NEW.id
             ELSE dedupe_base
           END,
           CASE WHEN COALESCE(NEW.is_sent, 0) = 1 THEN 'sent' ELSE 'inbound' END,
           NEW.message_id,
           NEW.provider_thread_id,
           NEW.thread_id,
           NEW.label_ids_json,
           COALESCE(NEW.is_read, 0),
           NULLIF(NEW.read_at, '')::TIMESTAMPTZ,
           COALESCE(NEW.is_archived, 0),
           COALESCE(NEW.is_starred, 0),
           COALESCE(NEW.is_spam, 0),
           COALESCE(NEW.is_trash, 0),
           NEW.received_at,
           NEW.created_at,
           NOW()
      FROM state_rows
    ON CONFLICT DO NOTHING;

    UPDATE inbound_emails
       SET primary_mailbox_id = COALESCE(primary_mailbox_id, (
             SELECT state.mailbox_id
               FROM mailbox_message_state state
              WHERE state.mail_message_id = 'msg:inbound:' || NEW.id
              ORDER BY state.mailbox_id
              LIMIT 1
           )),
           primary_mailbox_source_id = COALESCE(primary_mailbox_source_id, (
             SELECT state.source_id
               FROM mailbox_message_state state
              WHERE state.mail_message_id = 'msg:inbound:' || NEW.id
              ORDER BY state.mailbox_id
              LIMIT 1
           ))
     WHERE id = NEW.id;

    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS trg_mail_architecture_inbound_insert ON inbound_emails;
  CREATE TRIGGER trg_mail_architecture_inbound_insert
  AFTER INSERT ON inbound_emails
  FOR EACH ROW
  EXECUTE FUNCTION mailery_after_inbound_insert_architecture();

  CREATE OR REPLACE FUNCTION mailery_prevent_provider_delete_with_history()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM mailbox_sources WHERE provider_id = OLD.id LIMIT 1)
       OR EXISTS (SELECT 1 FROM inbound_emails WHERE provider_id = OLD.id LIMIT 1)
       OR EXISTS (SELECT 1 FROM emails WHERE provider_id = OLD.id LIMIT 1)
       OR EXISTS (SELECT 1 FROM events WHERE provider_id = OLD.id LIMIT 1)
       OR EXISTS (SELECT 1 FROM sandbox_emails WHERE provider_id = OLD.id LIMIT 1)
       OR EXISTS (SELECT 1 FROM gmail_sync_state WHERE provider_id = OLD.id LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot delete provider with mail/source history; deactivate it instead';
    END IF;
    RETURN OLD;
  END;
  $$;
  DROP TRIGGER IF EXISTS trg_providers_preserve_mail_history ON providers;
  CREATE TRIGGER trg_providers_preserve_mail_history
  BEFORE DELETE ON providers
  FOR EACH ROW
  EXECUTE FUNCTION mailery_prevent_provider_delete_with_history();

  INSERT INTO _migrations (id) VALUES (40) ON CONFLICT DO NOTHING;
  `,

  // Migration 41: Reconcile canonical mailbox state after local state mutations.
  `
  UPDATE mailbox_message_state state
     SET labels_json = inbound.label_ids_json,
         is_read = inbound.is_read,
         read_at = NULLIF(inbound.read_at, '')::TIMESTAMPTZ,
         is_archived = inbound.is_archived,
         is_starred = inbound.is_starred,
         is_spam = inbound.is_spam,
         is_trash = inbound.is_trash,
         folder_id = 'folder:' || state.mailbox_id || ':' ||
           CASE
             WHEN COALESCE(inbound.is_sent, 0) = 1 THEN 'sent'
             WHEN COALESCE(inbound.is_trash, 0) = 1 THEN 'trash'
             WHEN COALESCE(inbound.is_spam, 0) = 1 THEN 'spam'
             WHEN COALESCE(inbound.is_archived, 0) = 1 THEN 'archive'
             ELSE 'inbox'
           END,
         updated_at = NOW()
    FROM inbound_emails inbound
   WHERE state.mail_message_id = COALESCE(inbound.mail_message_id, 'msg:inbound:' || inbound.id);

  INSERT INTO _migrations (id) VALUES (41) ON CONFLICT DO NOTHING;
  `,

  // Migration 42: Re-run state reconciliation after reserved label mutations
  // learned to update canonical spam/trash flags and folder placement.
  `
  UPDATE mailbox_message_state state
     SET labels_json = inbound.label_ids_json,
         is_read = inbound.is_read,
         read_at = NULLIF(inbound.read_at, '')::TIMESTAMPTZ,
         is_archived = inbound.is_archived,
         is_starred = inbound.is_starred,
         is_spam = inbound.is_spam,
         is_trash = inbound.is_trash,
         folder_id = 'folder:' || state.mailbox_id || ':' ||
           CASE
             WHEN COALESCE(inbound.is_sent, 0) = 1 THEN 'sent'
             WHEN COALESCE(inbound.is_trash, 0) = 1 THEN 'trash'
             WHEN COALESCE(inbound.is_spam, 0) = 1 THEN 'spam'
             WHEN COALESCE(inbound.is_archived, 0) = 1 THEN 'archive'
             ELSE 'inbox'
           END,
         updated_at = NOW()
    FROM inbound_emails inbound
   WHERE state.mail_message_id = COALESCE(inbound.mail_message_id, 'msg:inbound:' || inbound.id);

  INSERT INTO _migrations (id) VALUES (42) ON CONFLICT DO NOTHING;
  `,

  // Migration 43: preserve already bucket-qualified S3 provenance in
  // canonical messages before exact S3 source filters/dedupe rely on raw_s3_url.
  `
  UPDATE inbound_emails
     SET raw_s3_url = message_id
   WHERE (raw_s3_url IS NULL OR raw_s3_url = '')
     AND message_id LIKE 's3://%';

  UPDATE mail_messages message
     SET raw_s3_url = inbound.raw_s3_url
    FROM inbound_emails inbound
   WHERE inbound.mail_message_id = message.id
     AND (message.raw_s3_url IS NULL OR message.raw_s3_url = '')
     AND inbound.raw_s3_url IS NOT NULL
     AND inbound.raw_s3_url != '';

  UPDATE mail_messages message
     SET raw_s3_url = inbound.raw_s3_url
    FROM inbound_emails inbound
   WHERE inbound.mail_message_id IS NULL
     AND 'msg:inbound:' || inbound.id = message.id
     AND (message.raw_s3_url IS NULL OR message.raw_s3_url = '')
     AND inbound.raw_s3_url IS NOT NULL
     AND inbound.raw_s3_url != '';

  INSERT INTO _migrations (id) VALUES (43) ON CONFLICT DO NOTHING;
  `,

  // Migration 44: harden source repair/delete semantics for inbound-backed
  // canonical state after S3 provider tagging and orphan-provider repairs.
  `
  CREATE OR REPLACE FUNCTION mailery_after_inbound_delete_architecture()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    canonical_id TEXT;
  BEGIN
    canonical_id := COALESCE(OLD.mail_message_id, 'msg:inbound:' || OLD.id);
    DELETE FROM mail_messages message
     WHERE message.id = canonical_id
       AND NOT EXISTS (
         SELECT 1
           FROM inbound_emails inbound
          WHERE COALESCE(inbound.mail_message_id, 'msg:inbound:' || inbound.id) = canonical_id
       );
    RETURN OLD;
  END;
  $$;

  DROP TRIGGER IF EXISTS trg_mail_architecture_inbound_delete ON inbound_emails;
  CREATE TRIGGER trg_mail_architecture_inbound_delete
  AFTER DELETE ON inbound_emails
  FOR EACH ROW
  EXECUTE FUNCTION mailery_after_inbound_delete_architecture();

  DELETE FROM mailbox_message_state state
   USING inbound_emails inbound
   WHERE state.mail_message_id = COALESCE(inbound.mail_message_id, 'msg:inbound:' || inbound.id);

  WITH raw_recipients AS (
    SELECT inbound.id AS inbound_email_id,
           lower(btrim(CASE
             WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
             ELSE btrim(value)
           END)) AS address
      FROM inbound_emails inbound,
           mailery_jsonb_array_text(inbound.to_addresses) AS value
  ),
  valid_recipients AS (
    SELECT inbound_email_id, address, 'mbx:' || address AS mailbox_id
      FROM raw_recipients
     WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
    UNION ALL
    SELECT inbound.id,
           'legacy-inbound@local.mailery',
           'mbx:legacy-inbound@local.mailery'
      FROM inbound_emails inbound
     WHERE NOT EXISTS (
       SELECT 1 FROM raw_recipients raw
        WHERE raw.inbound_email_id = inbound.id
          AND raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
     )
  ),
  source_rows AS (
    SELECT DISTINCT
           recipients.mailbox_id,
           CASE WHEN provider.id IS NULL THEN NULL ELSE inbound.provider_id END AS provider_id,
           CASE
             WHEN provider.type = 'gmail' THEN 'gmail'
             WHEN provider.type = 'ses' AND (inbound.raw_s3_url IS NOT NULL OR inbound.metadata_s3_url IS NOT NULL OR COALESCE(inbound.message_id, '') LIKE 'inbound/%') THEN 'ses_s3'
             WHEN provider.type = 'ses' THEN 'ses'
             WHEN provider.type = 'resend' THEN 'resend'
             WHEN provider.type = 'sandbox' THEN 'sandbox'
             ELSE 'legacy_inbound'
           END AS source_type,
           provider.name AS provider_name,
           provider.type AS provider_type,
           provider.region AS provider_region,
           provider.active AS provider_active,
           provider.created_at AS provider_created_at,
           provider.updated_at AS provider_updated_at
      FROM valid_recipients recipients
      JOIN inbound_emails inbound ON inbound.id = recipients.inbound_email_id
      LEFT JOIN providers provider ON provider.id = inbound.provider_id
  )
  INSERT INTO mailbox_sources (
    id, mailbox_id, provider_id, type, name, external_mailbox, status,
    settings_json, provider_snapshot_json, created_at, updated_at
  )
  SELECT 'msrc:' || mailbox_id || ':' || COALESCE(provider_id, 'none') || ':' || source_type,
         mailbox_id,
         provider_id,
         source_type,
         COALESCE(provider_name || ' ' || source_type, 'Legacy inbound'),
         substring(mailbox_id from 5),
         CASE WHEN source_type IN ('legacy_inbound', 'gmail') THEN 'legacy' ELSE 'active' END,
         '{}',
         CASE WHEN provider_id IS NULL THEN '{}' ELSE jsonb_build_object(
           'id', provider_id,
           'name', provider_name,
           'type', provider_type,
           'region', provider_region,
           'active', provider_active,
           'created_at', provider_created_at,
           'updated_at', provider_updated_at
         )::text END,
         NOW(),
         NOW()
    FROM source_rows
  ON CONFLICT DO NOTHING;

  WITH raw_recipients AS (
    SELECT inbound.id AS inbound_email_id,
           lower(btrim(CASE
             WHEN btrim(value) ~ '<[^<>]+>' THEN regexp_replace(btrim(value), '^.*<([^<>]+)>.*$', '\\1')
             ELSE btrim(value)
           END)) AS address
      FROM inbound_emails inbound,
           mailery_jsonb_array_text(inbound.to_addresses) AS value
  ),
  valid_recipients AS (
    SELECT inbound_email_id, address, 'mbx:' || address AS mailbox_id
      FROM raw_recipients
     WHERE address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
    UNION ALL
    SELECT inbound.id,
           'legacy-inbound@local.mailery',
           'mbx:legacy-inbound@local.mailery'
      FROM inbound_emails inbound
     WHERE NOT EXISTS (
       SELECT 1 FROM raw_recipients raw
        WHERE raw.inbound_email_id = inbound.id
          AND raw.address ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\\.[^[:space:]@<>]+$'
     )
  ),
  state_rows AS (
    SELECT state_base.*,
           COUNT(*) OVER (
             PARTITION BY state_base.mailbox_id,
                          COALESCE(state_base.source_provider_id, 'none'),
                          state_base.source_type,
                          state_base.dedupe_base
           ) AS source_dedupe_count
      FROM (
        SELECT inbound.*,
               recipients.address,
               recipients.mailbox_id,
               CASE WHEN provider.id IS NULL THEN NULL ELSE inbound.provider_id END AS source_provider_id,
               COALESCE(NULLIF(inbound.message_id, ''), inbound.id) AS dedupe_base,
               CASE
                 WHEN provider.type = 'gmail' THEN 'gmail'
                 WHEN provider.type = 'ses' AND (inbound.raw_s3_url IS NOT NULL OR inbound.metadata_s3_url IS NOT NULL OR COALESCE(inbound.message_id, '') LIKE 'inbound/%') THEN 'ses_s3'
                 WHEN provider.type = 'ses' THEN 'ses'
                 WHEN provider.type = 'resend' THEN 'resend'
                 WHEN provider.type = 'sandbox' THEN 'sandbox'
                 ELSE 'legacy_inbound'
               END AS source_type,
               CASE
                 WHEN COALESCE(inbound.is_sent, 0) = 1 THEN 'sent'
                 WHEN COALESCE(inbound.is_trash, 0) = 1 THEN 'trash'
                 WHEN COALESCE(inbound.is_spam, 0) = 1 THEN 'spam'
                 WHEN COALESCE(inbound.is_archived, 0) = 1 THEN 'archive'
                 ELSE 'inbox'
               END AS folder_role
          FROM valid_recipients recipients
          JOIN inbound_emails inbound ON inbound.id = recipients.inbound_email_id
          LEFT JOIN providers provider ON provider.id = inbound.provider_id
      ) state_base
  )
  INSERT INTO mailbox_message_state (
    id, mailbox_id, mail_message_id, folder_id, source_id, source_dedupe_key,
    direction, provider_message_id, provider_thread_id, thread_id, labels_json,
    is_read, read_at, is_archived, is_starred, is_spam, is_trash, received_at,
    created_at, updated_at
  )
  SELECT 'state:' || id || ':' || address,
         mailbox_id,
         COALESCE(mail_message_id, 'msg:inbound:' || id),
         'folder:' || mailbox_id || ':' || folder_role,
         'msrc:' || mailbox_id || ':' || COALESCE(source_provider_id, 'none') || ':' || source_type,
         CASE
           WHEN source_dedupe_count > 1 THEN dedupe_base || ':inbound:' || id
           ELSE dedupe_base
         END,
         CASE WHEN COALESCE(is_sent, 0) = 1 THEN 'sent' ELSE 'inbound' END,
         message_id,
         provider_thread_id,
         thread_id,
         label_ids_json,
         COALESCE(is_read, 0),
         NULLIF(read_at, '')::TIMESTAMPTZ,
         COALESCE(is_archived, 0),
         COALESCE(is_starred, 0),
         COALESCE(is_spam, 0),
         COALESCE(is_trash, 0),
         received_at,
         created_at,
         NOW()
    FROM state_rows
  ON CONFLICT DO NOTHING;

  UPDATE inbound_emails
     SET mail_message_id = COALESCE(mail_message_id, 'msg:inbound:' || id);

  UPDATE inbound_emails
     SET primary_mailbox_id = (
           SELECT state.mailbox_id
             FROM mailbox_message_state state
            WHERE state.mail_message_id = inbound_emails.mail_message_id
            ORDER BY state.mailbox_id
            LIMIT 1
         ),
         primary_mailbox_source_id = (
           SELECT state.source_id
             FROM mailbox_message_state state
            WHERE state.mail_message_id = inbound_emails.mail_message_id
            ORDER BY state.mailbox_id
            LIMIT 1
         );

  INSERT INTO _migrations (id) VALUES (44) ON CONFLICT DO NOTHING;
  `,

  // Migration 45: repair drifted Postgres databases that recorded migration 17
  // without retaining the attachment path column expected by self-hosted reads.
  `
  ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS attachment_paths TEXT NOT NULL DEFAULT '[]';
  INSERT INTO _migrations (id) VALUES (45) ON CONFLICT DO NOTHING;
  `,

  // Migration 46: per-domain readiness lifecycle and provider/DNS snapshots.
  `
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS domain_type TEXT NOT NULL DEFAULT 'self_hosted';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS source_of_truth TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS ownership_status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS inbound_status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS outbound_status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS monitoring_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS dns_records_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS provider_metadata_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS last_dns_check_at TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS last_inbound_check_at TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS last_outbound_check_at TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS last_monitored_at TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS restricted_at TEXT;
  ALTER TABLE domains ADD COLUMN IF NOT EXISTS suspended_at TEXT;
  CREATE INDEX IF NOT EXISTS idx_domains_type ON domains(domain_type);
  CREATE INDEX IF NOT EXISTS idx_domains_source_truth ON domains(source_of_truth);
  CREATE INDEX IF NOT EXISTS idx_domains_readiness ON domains(ownership_status, inbound_status, outbound_status);
  INSERT INTO _migrations (id) VALUES (46) ON CONFLICT DO NOTHING;
  `,

  // Feedback table
  `
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `,
];
