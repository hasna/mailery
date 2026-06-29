import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { closeDatabase, ensureMailArchitecture, getDatabase, resetDatabase } from "./database.js";
import { createProvider, deleteProvider, getProvider } from "./providers.js";
import { createMailbox, getMailboxFolderByRole, listMailboxes } from "./mailboxes.js";
import { createMailboxSource, getMailboxSource, listMailboxSources } from "./sources.js";
import { createMailMessage, listMailboxMessageStates, upsertMailboxMessageState } from "./messages.js";
import { storeInboundEmail } from "./inbound.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

function sqliteColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

describe("mail architecture data model", () => {
  it("models one mailbox with active SES/S3 and legacy Gmail sources", () => {
    const db = getDatabase();
    const ses = createProvider({ name: "SES inbound", type: "ses", region: "us-east-1", access_key: "local-access" }, db);
    const gmail = createProvider({ name: "Imported Gmail", type: "gmail", oauth_client_id: "client-id" }, db);
    const mailbox = createMailbox({ address: "Ops@Example.com", display_name: "Ops" }, db);

    const activeSource = createMailboxSource({
      mailbox_id: mailbox.id,
      provider_id: ses.id,
      type: "ses_s3",
      name: "SES S3 inbound",
      external_mailbox: "ops@example.com",
      status: "active",
      settings: { bucket: "mailery-test-bucket", prefix: "inbound/example.com/" },
    }, db);
    const legacySource = createMailboxSource({
      mailbox_id: mailbox.id,
      provider_id: gmail.id,
      type: "gmail",
      name: "Legacy Gmail import",
      external_mailbox: "ops@example.com",
      status: "legacy",
    }, db);

    const sources = listMailboxSources(mailbox.id, db);

    expect(mailbox.address).toBe("ops@example.com");
    expect(sources.map((source) => [source.id, source.type, source.status])).toEqual([
      [activeSource.id, "ses_s3", "active"],
      [legacySource.id, "gmail", "legacy"],
    ]);
    expect(activeSource.provider_snapshot).toMatchObject({ id: ses.id, name: "SES inbound", type: "ses" });
    expect(JSON.stringify(activeSource.provider_snapshot)).not.toContain("local-access");
    expect(getMailboxFolderByRole(mailbox.id, "inbox", db)?.path).toBe("INBOX");
  });

  it("blocks hard provider deletion when source history exists and keeps provenance", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "SES provenance", type: "ses", region: "us-east-1" }, db);
    const mailbox = createMailbox({ address: "delete-guard@example.com" }, db);
    const source = createMailboxSource({
      mailbox_id: mailbox.id,
      provider_id: provider.id,
      type: "ses_s3",
      name: "SES source",
      external_mailbox: "delete-guard@example.com",
    }, db);

    expect(() => deleteProvider(provider.id, db)).toThrow("Cannot delete provider with mail/source history");
    expect(getProvider(provider.id, db)).not.toBeNull();
    expect(getMailboxSource(source.id, db)?.provider_snapshot).toMatchObject({
      id: provider.id,
      name: "SES provenance",
      type: "ses",
    });
  });

  it("backfills existing inbound rows into canonical messages and per-mailbox state", () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.exec(`
        CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE owners (id TEXT PRIMARY KEY);
        CREATE TABLE providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
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
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE inbound_emails (
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
          attachment_paths TEXT NOT NULL DEFAULT '[]',
          headers_json TEXT NOT NULL DEFAULT '{}',
          raw_size INTEGER DEFAULT 0,
          in_reply_to_email_id TEXT,
          thread_id TEXT,
          is_read INTEGER NOT NULL DEFAULT 0,
          read_at TEXT,
          is_archived INTEGER NOT NULL DEFAULT 0,
          is_starred INTEGER NOT NULL DEFAULT 0,
          is_sent INTEGER NOT NULL DEFAULT 0,
          is_spam INTEGER NOT NULL DEFAULT 0,
          is_trash INTEGER NOT NULL DEFAULT 0,
          received_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE inbound_recipients (
          inbound_email_id TEXT NOT NULL,
          address TEXT NOT NULL,
          domain TEXT NOT NULL,
          PRIMARY KEY (inbound_email_id, address)
        );
        CREATE TABLE emails (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE events (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE sandbox_emails (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE gmail_sync_state (provider_id TEXT PRIMARY KEY);
        INSERT INTO providers (id, name, type, region, active, created_at, updated_at)
        VALUES ('provider-ses', 'Backfill SES', 'ses', 'us-east-1', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO inbound_emails (
          id, provider_id, message_id, raw_s3_url, from_address, to_addresses, cc_addresses,
          subject, text_body, html_body, attachments_json, headers_json, raw_size,
          received_at, created_at
        )
        VALUES (
          'inbound-existing', 'provider-ses', 'inbound/example.com/object-1', 's3://mailery-test/inbound/object-1',
          'sender@example.net', '["A@example.com","B@example.com"]', '[]',
          'Existing content', 'text body', '<p>html body</p>', '[]', '{"x-test":"yes"}', 123,
          '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
        );
        INSERT INTO inbound_recipients (inbound_email_id, address, domain)
        VALUES ('inbound-existing', 'a@example.com', 'example.com'),
               ('inbound-existing', 'b@example.com', 'example.com');
      `);

      ensureMailArchitecture(db);

      const message = db.query("SELECT * FROM mail_messages WHERE id = ?").get("msg:inbound:inbound-existing") as {
        subject: string;
        text_body: string | null;
        html_body: string | null;
        raw_s3_url: string;
      } | null;
      const states = db
        .query("SELECT mailbox_id, source_id, source_dedupe_key FROM mailbox_message_state ORDER BY mailbox_id")
        .all() as Array<{ mailbox_id: string; source_id: string; source_dedupe_key: string }>;
      const source = db.query("SELECT type, provider_snapshot_json FROM mailbox_sources LIMIT 1").get() as {
        type: string;
        provider_snapshot_json: string;
      };
      const inbound = db.query("SELECT mail_message_id, primary_mailbox_id, text_body FROM inbound_emails WHERE id = ?").get("inbound-existing") as {
        mail_message_id: string;
        primary_mailbox_id: string;
        text_body: string;
      };

      expect(message).toMatchObject({
        subject: "Existing content",
        text_body: null,
        html_body: null,
        raw_s3_url: "s3://mailery-test/inbound/object-1",
      });
      expect(inbound.text_body).toBe("text body");
      expect(states).toEqual([
        {
          mailbox_id: "mbx:a@example.com",
          source_id: "msrc:mbx:a@example.com:provider-ses:ses_s3",
          source_dedupe_key: "inbound/example.com/object-1",
        },
        {
          mailbox_id: "mbx:b@example.com",
          source_id: "msrc:mbx:b@example.com:provider-ses:ses_s3",
          source_dedupe_key: "inbound/example.com/object-1",
        },
      ]);
      expect(source.type).toBe("ses_s3");
      expect(JSON.parse(source.provider_snapshot_json)).toMatchObject({ id: "provider-ses", name: "Backfill SES", type: "ses" });
      expect(inbound).toMatchObject({
        mail_message_id: "msg:inbound:inbound-existing",
        primary_mailbox_id: "mbx:a@example.com",
        text_body: "text body",
      });
    } finally {
      db.close();
    }
  });

  it("keeps every historical provider-null row when source message IDs collide", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE _migrations (id INTEGER PRIMARY KEY);
        CREATE TABLE owners (id TEXT PRIMARY KEY);
        CREATE TABLE providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          region TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE TABLE inbound_emails (
          id TEXT PRIMARY KEY,
          provider_id TEXT,
          message_id TEXT,
          in_reply_to_email_id TEXT,
          from_address TEXT,
          to_addresses TEXT NOT NULL DEFAULT '[]',
          cc_addresses TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          text_body TEXT,
          html_body TEXT,
          attachments_json TEXT NOT NULL DEFAULT '[]',
          headers_json TEXT NOT NULL DEFAULT '{}',
          raw_s3_url TEXT,
          metadata_s3_url TEXT,
          raw_size INTEGER NOT NULL DEFAULT 0,
          is_read INTEGER NOT NULL DEFAULT 0,
          read_at TEXT,
          is_archived INTEGER NOT NULL DEFAULT 0,
          is_starred INTEGER NOT NULL DEFAULT 0,
          is_sent INTEGER NOT NULL DEFAULT 0,
          is_spam INTEGER NOT NULL DEFAULT 0,
          is_trash INTEGER NOT NULL DEFAULT 0,
          provider_thread_id TEXT,
          thread_id TEXT,
          label_ids_json TEXT NOT NULL DEFAULT '[]',
          received_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE inbound_recipients (inbound_email_id TEXT, address TEXT, domain TEXT, PRIMARY KEY(inbound_email_id, address));
        CREATE TABLE emails (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE events (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE sandbox_emails (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE gmail_sync_state (provider_id TEXT PRIMARY KEY);
        INSERT INTO inbound_emails (
          id, provider_id, message_id, from_address, to_addresses, cc_addresses,
          subject, text_body, attachments_json, headers_json, received_at, created_at
        )
        VALUES
          ('legacy-a', NULL, 'same-provider-null-id', 'sender@example.com', '["andrei@hasna.com"]', '[]', 'First', 'body a', '[]', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('legacy-b', NULL, 'same-provider-null-id', 'sender@example.com', '["andrei@hasna.com"]', '[]', 'Second', 'body b', '[]', '{}', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
        INSERT INTO inbound_recipients (inbound_email_id, address, domain)
        VALUES ('legacy-a', 'andrei@hasna.com', 'hasna.com'),
               ('legacy-b', 'andrei@hasna.com', 'hasna.com');
      `);

      ensureMailArchitecture(db);

      const missing = db
        .query("SELECT COUNT(*) AS count FROM inbound_emails e WHERE NOT EXISTS (SELECT 1 FROM mailbox_message_state s WHERE s.mail_message_id = 'msg:inbound:' || e.id)")
        .get() as { count: number };
      const states = db
        .query("SELECT mail_message_id, source_dedupe_key FROM mailbox_message_state ORDER BY mail_message_id")
        .all() as Array<{ mail_message_id: string; source_dedupe_key: string }>;

      expect(missing.count).toBe(0);
      expect(states).toEqual([
        { mail_message_id: "msg:inbound:legacy-a", source_dedupe_key: "same-provider-null-id:inbound:legacy-a" },
        { mail_message_id: "msg:inbound:legacy-b", source_dedupe_key: "same-provider-null-id:inbound:legacy-b" },
      ]);
    } finally {
      db.close();
    }
  });

  it("backfills historical Gmail provider mail as legacy source history", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE _migrations (id INTEGER PRIMARY KEY);
        CREATE TABLE owners (id TEXT PRIMARY KEY);
        CREATE TABLE providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          region TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE TABLE inbound_emails (
          id TEXT PRIMARY KEY,
          provider_id TEXT,
          message_id TEXT,
          in_reply_to_email_id TEXT,
          from_address TEXT,
          to_addresses TEXT NOT NULL DEFAULT '[]',
          cc_addresses TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          text_body TEXT,
          html_body TEXT,
          attachments_json TEXT NOT NULL DEFAULT '[]',
          headers_json TEXT NOT NULL DEFAULT '{}',
          raw_s3_url TEXT,
          metadata_s3_url TEXT,
          raw_size INTEGER NOT NULL DEFAULT 0,
          is_read INTEGER NOT NULL DEFAULT 0,
          read_at TEXT,
          is_archived INTEGER NOT NULL DEFAULT 0,
          is_starred INTEGER NOT NULL DEFAULT 0,
          is_sent INTEGER NOT NULL DEFAULT 0,
          is_spam INTEGER NOT NULL DEFAULT 0,
          is_trash INTEGER NOT NULL DEFAULT 0,
          provider_thread_id TEXT,
          thread_id TEXT,
          label_ids_json TEXT NOT NULL DEFAULT '[]',
          received_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE inbound_recipients (inbound_email_id TEXT, address TEXT, domain TEXT, PRIMARY KEY(inbound_email_id, address));
        CREATE TABLE emails (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE events (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE sandbox_emails (id TEXT PRIMARY KEY, provider_id TEXT);
        CREATE TABLE gmail_sync_state (provider_id TEXT PRIMARY KEY);
        INSERT INTO providers (id, name, type, active, created_at, updated_at)
        VALUES ('provider-gmail', 'Imported Gmail', 'gmail', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO inbound_emails (
          id, provider_id, message_id, from_address, to_addresses, cc_addresses,
          subject, text_body, attachments_json, headers_json, received_at, created_at
        )
        VALUES (
          'gmail-existing', 'provider-gmail', 'gmail-msg-1', 'sender@example.com',
          '["andrei@hasna.com"]', '[]', 'Imported Gmail', 'body', '[]', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO inbound_recipients (inbound_email_id, address, domain)
        VALUES ('gmail-existing', 'andrei@hasna.com', 'hasna.com');
      `);

      ensureMailArchitecture(db);

      const source = db
        .query("SELECT type, status FROM mailbox_sources WHERE provider_id = 'provider-gmail'")
        .get() as { type: string; status: string } | null;

      expect(source).toEqual({ type: "gmail", status: "legacy" });
    } finally {
      db.close();
    }
  });

  it("replaces stale inbound architecture triggers on already-migrated databases", () => {
    const db = getDatabase();
    db.exec(`
      DROP TRIGGER IF EXISTS trg_mail_architecture_inbound_insert;
      CREATE TRIGGER trg_mail_architecture_inbound_insert
      AFTER INSERT ON inbound_emails
      BEGIN
        SELECT 1;
      END;
    `);

    const stale = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_mail_architecture_inbound_insert'")
      .get() as { sql: string } | null;
    expect(stale?.sql).toContain("SELECT 1");

    ensureMailArchitecture(db);

    const repaired = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_mail_architecture_inbound_insert'")
      .get() as { sql: string } | null;
    expect(repaired?.sql).toContain("provider.type = 'gmail'");
    expect(repaired?.sql).not.toBe(stale?.sql);
  });

  it("creates per-mailbox state for multi-recipient inbound mail", () => {
    const db = getDatabase();
    const provider = createProvider({ name: "SES multi", type: "ses", region: "us-east-1" }, db);

    const inbound = storeInboundEmail({
      provider_id: provider.id,
      message_id: "inbound/example.com/multi-1",
      from_address: "sender@example.net",
      to_addresses: ["A@example.com", "B@example.com"],
      cc_addresses: [],
      subject: "Two recipients",
      text_body: "same canonical content",
      html_body: null,
      attachments: [],
      headers: { "message-id": "<multi-1@example.net>" },
      raw_size: 500,
      raw_s3_url: "s3://mailery-test/inbound/multi-1",
      received_at: "2026-02-01T00:00:00.000Z",
    }, db);

    const messageCount = db
      .query("SELECT COUNT(*) AS count FROM mail_messages WHERE id = ?")
      .get(`msg:inbound:${inbound.id}`) as { count: number };
    const states = db
      .query("SELECT mailbox_id, mail_message_id, source_id, source_dedupe_key FROM mailbox_message_state ORDER BY mailbox_id")
      .all() as Array<{ mailbox_id: string; mail_message_id: string; source_id: string; source_dedupe_key: string }>;
    const linked = db
      .query("SELECT mail_message_id, primary_mailbox_id, primary_mailbox_source_id FROM inbound_emails WHERE id = ?")
      .get(inbound.id) as { mail_message_id: string; primary_mailbox_id: string; primary_mailbox_source_id: string };

    expect(messageCount.count).toBe(1);
    expect(states).toEqual([
      {
        mailbox_id: "mbx:a@example.com",
        mail_message_id: `msg:inbound:${inbound.id}`,
        source_id: `msrc:mbx:a@example.com:${provider.id}:ses_s3`,
        source_dedupe_key: "inbound/example.com/multi-1",
      },
      {
        mailbox_id: "mbx:b@example.com",
        mail_message_id: `msg:inbound:${inbound.id}`,
        source_id: `msrc:mbx:b@example.com:${provider.id}:ses_s3`,
        source_dedupe_key: "inbound/example.com/multi-1",
      },
    ]);
    expect(linked.primary_mailbox_id).toBe("mbx:a@example.com");
    expect(linked.primary_mailbox_source_id).toBe(`msrc:mbx:a@example.com:${provider.id}:ses_s3`);
    expect(listMailboxes(db).map((mailbox) => mailbox.address).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("dedupes source keys per source while allowing the same key on another source", () => {
    const db = getDatabase();
    const mailbox = createMailbox({ address: "dedupe@example.com" }, db);
    const inbox = getMailboxFolderByRole(mailbox.id, "inbox", db)!;
    const firstSource = createMailboxSource({ mailbox_id: mailbox.id, type: "manual", name: "Manual A" }, db);
    const secondSource = createMailboxSource({ mailbox_id: mailbox.id, type: "gmail", name: "Gmail B", status: "legacy" }, db);
    const firstMessage = createMailMessage({ subject: "First", received_at: "2026-03-01T00:00:00.000Z" }, db);
    const duplicateMessage = createMailMessage({ subject: "Duplicate", received_at: "2026-03-02T00:00:00.000Z" }, db);
    const otherSourceMessage = createMailMessage({ subject: "Other source", received_at: "2026-03-03T00:00:00.000Z" }, db);

    const first = upsertMailboxMessageState({
      mailbox_id: mailbox.id,
      mail_message_id: firstMessage.id,
      folder_id: inbox.id,
      source_id: firstSource.id,
      source_dedupe_key: "same-key",
      received_at: firstMessage.received_at,
    }, db);
    const duplicate = upsertMailboxMessageState({
      mailbox_id: mailbox.id,
      mail_message_id: duplicateMessage.id,
      folder_id: inbox.id,
      source_id: firstSource.id,
      source_dedupe_key: "same-key",
      received_at: duplicateMessage.received_at,
    }, db);
    const otherSource = upsertMailboxMessageState({
      mailbox_id: mailbox.id,
      mail_message_id: otherSourceMessage.id,
      folder_id: inbox.id,
      source_id: secondSource.id,
      source_dedupe_key: "same-key",
      received_at: otherSourceMessage.received_at,
    }, db);

    expect(duplicate.id).toBe(first.id);
    expect(otherSource.id).not.toBe(first.id);
    expect(listMailboxMessageStates(mailbox.id, db).map((state) => state.id).sort()).toEqual([first.id, otherSource.id].sort());
  });

  it("keeps SQLite and PostgreSQL migrations in parity for the core model", () => {
    const db = getDatabase();
    const pgSql = PG_MIGRATIONS.join("\n");
    const expectedTables = ["mailboxes", "mail_folders", "mailbox_sources", "mail_messages", "mailbox_message_state"];
    const sqliteTables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));

    for (const table of expectedTables) {
      expect(sqliteTables.has(table)).toBe(true);
      expect(pgSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    for (const column of ["mail_message_id", "primary_mailbox_id", "primary_mailbox_source_id"]) {
      expect(sqliteColumns(db, "inbound_emails")).toContain(column);
      expect(pgSql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }

    expect(sqliteColumns(db, "mailbox_sources")).toEqual(expect.arrayContaining([
      "mailbox_id",
      "provider_id",
      "type",
      "status",
      "settings_json",
      "provider_snapshot_json",
    ]));
    expect(sqliteColumns(db, "mailbox_message_state")).toEqual(expect.arrayContaining([
      "mailbox_id",
      "mail_message_id",
      "source_id",
      "source_dedupe_key",
      "folder_id",
      "is_read",
      "is_spam",
      "is_trash",
    ]));

    const sqliteIndex = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_mailbox_state_source_dedupe") as { name: string } | null;
    const sqliteTrigger = db
      .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get("trg_providers_preserve_mail_history") as { name: string } | null;
    const latestMigration = db.query("SELECT MAX(id) AS max_id FROM _migrations").get() as { max_id: number };

    expect(sqliteIndex?.name).toBe("idx_mailbox_state_source_dedupe");
    expect(sqliteTrigger?.name).toBe("trg_providers_preserve_mail_history");
    expect(latestMigration.max_id).toBeGreaterThanOrEqual(42);
    expect(pgSql).toContain("idx_mailbox_state_source_dedupe");
    expect(pgSql).toContain("mailery_after_inbound_insert_architecture");
    expect(pgSql).toContain("DROP TRIGGER IF EXISTS trg_mail_architecture_inbound_insert ON inbound_emails");
    expect(pgSql).toContain("mailery_prevent_provider_delete_with_history");
    expect(pgSql).toContain("INSERT INTO _migrations (id) VALUES (40)");
    expect(pgSql).toContain("INSERT INTO _migrations (id) VALUES (41)");
    expect(pgSql).toContain("INSERT INTO _migrations (id) VALUES (42)");
  });
});
