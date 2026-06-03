/**
 * PostgreSQL migrations for open-emails cloud sync.
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
