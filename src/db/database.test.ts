import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, closeDatabase, resetDatabase, uuid, now, resolvePartialId, resolvePartialIdOrThrow, listPartialIdMatches, runInTransaction } from "./database.js";
import { sqlEmailAddress, sqlEmailDomain } from "./email-address-sql.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("getDatabase", () => {
  it("returns a database instance", () => {
    const db = getDatabase();
    expect(db).toBeDefined();
  });

  it("returns the same instance on repeated calls", () => {
    const db1 = getDatabase();
    const db2 = getDatabase();
    expect(db1).toBe(db2);
  });

  it("creates file-backed databases and SQLite sidecars with private permissions", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "emails-db-permissions-"));
    const path = join(root, "custom", "emails.db");
    closeDatabase();
    resetDatabase();
    process.env["EMAILS_DB_PATH"] = path;
    try {
      const db = getDatabase();
      db.run("CREATE TABLE permission_probe (id INTEGER PRIMARY KEY)");
      db.run("INSERT INTO permission_probe DEFAULT VALUES");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${path}${suffix}`;
        expect(existsSync(sidecar)).toBe(true);
        expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
      const journal = `${path}-journal`;
      if (existsSync(journal)) expect(statSync(journal).mode & 0o777).toBe(0o600);
    } finally {
      closeDatabase();
      resetDatabase();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs loose permissions on an existing file-backed database", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "emails-db-permissions-repair-"));
    const path = join(root, "emails.db");
    closeDatabase();
    resetDatabase();
    process.env["EMAILS_DB_PATH"] = path;
    try {
      getDatabase();
      closeDatabase();
      chmodSync(path, 0o644);
      resetDatabase();
      getDatabase();
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      closeDatabase();
      resetDatabase();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates required tables", () => {
    const db = getDatabase();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("providers");
    expect(names).toContain("domains");
    expect(names).toContain("addresses");
    expect(names).toContain("emails");
    expect(names).toContain("events");
    expect(names).toContain("_migrations");
  });

  it("records the latest SQLite migration in _migrations", () => {
    const db = getDatabase();
    const row = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number } | null;
    expect(row?.max_id).toBeGreaterThanOrEqual(46);
  });

  it("applies the additive rename bridge without leaving the legacy mailbox identity", () => {
    const db = getDatabase();
    const legacy = db.query("SELECT id FROM mailboxes WHERE id = ?").get("mbx:legacy-inbound@local.mailery");
    const receipts = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_receipts'").get() as { name: string } | null;
    expect(legacy).toBeNull();
    expect(receipts?.name).toBe("webhook_receipts");
  });

  it("creates hot-path composite indexes used by list and export queries", () => {
    const db = getDatabase();
    const expected = [
      "idx_inbound_sent_read_arch_recv",
      "idx_inbound_sent_star_arch_recv",
      "idx_inbound_provider_sent_arch_recv",
      "idx_inbound_provider_sent_read_arch_recv",
      "idx_inbound_provider_sent_star_arch_recv",
      "idx_emails_provider_sent",
      "idx_emails_status_sent",
      "idx_emails_provider_status_sent",
      "idx_emails_from_sent",
      "idx_events_provider_occurred",
      "idx_events_type_occurred",
      "idx_events_provider_type_occurred",
      "idx_inbound_recipients_address",
      "idx_inbound_recipients_domain",
      "idx_inbound_recipients_email",
      "idx_inbound_message_id",
      "idx_enrollments_due",
      "idx_scheduled_due",
      "idx_emails_sender_canonical_sent",
      "idx_emails_sender_domain_sent",
      "idx_inbound_sender_canonical_recv",
      "idx_inbound_sender_domain_recv",
    ];
    const placeholders = expected.map(() => "?").join(", ");
    const rows = db
      .query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`)
      .all(...expected) as { name: string }[];
    const names = new Set(rows.map((row) => row.name));
    for (const name of expected) expect(names.has(name)).toBe(true);

    const plan = (sql: string, ...params: unknown[]) => (db
      .query(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params) as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(" ");

    expect(plan(
      "SELECT id FROM inbound_emails WHERE provider_id = ? AND is_sent = 0 AND is_read = 0 AND is_archived = 0 ORDER BY received_at DESC LIMIT ?",
      "provider-1",
      50,
    )).toContain("idx_inbound_provider_sent_read_arch_recv");

    expect(plan(
      "SELECT id FROM emails WHERE provider_id = ? AND status = ? AND sent_at >= ? ORDER BY sent_at DESC LIMIT ?",
      "provider-1",
      "sent",
      "2026-01-01T00:00:00.000Z",
      50,
    )).toContain("idx_emails_provider_status_sent");

    expect(plan(
      "SELECT id FROM events WHERE provider_id = ? AND type = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?",
      "provider-1",
      "delivered",
      "2026-01-01T00:00:00.000Z",
      50,
    )).toContain("idx_events_provider_type_occurred");

    expect(plan(
      "SELECT inbound_email_id FROM inbound_recipients WHERE address = ? LIMIT ?",
      "ops@example.com",
      50,
    )).toContain("idx_inbound_recipients_address");

    expect(plan(
      "SELECT id FROM inbound_emails WHERE message_id = ? LIMIT ?",
      "inbound/example.com/msg001",
      1,
    )).toContain("idx_inbound_message_id");

    expect(plan(
      "SELECT id FROM sequence_enrollments WHERE status = 'active' AND next_send_at <= ? ORDER BY next_send_at ASC, id ASC LIMIT ?",
      "2026-01-01T00:00:00.000Z",
      100,
    )).toContain("idx_enrollments_due");

    expect(plan(
      "SELECT id FROM scheduled_emails WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC, id ASC LIMIT ?",
      "2026-01-01T00:00:00.000Z",
      100,
    )).toContain("idx_scheduled_due");

    expect(plan(
      `SELECT id FROM emails WHERE ${sqlEmailAddress("from_address")} = ? ORDER BY sent_at DESC LIMIT ?`,
      "ops@example.com",
      50,
    )).toContain("idx_emails_sender_canonical_sent");

    expect(plan(
      `SELECT COUNT(*) AS count FROM emails WHERE ${sqlEmailDomain("from_address")} = ? AND sent_at >= ? AND sent_at < ?`,
      "example.com",
      "2026-01-01T00:00:00",
      "2026-01-02T00:00:00",
    )).toContain("idx_emails_sender_domain_sent");

    expect(plan(
      `SELECT id FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0 AND ${sqlEmailAddress("from_address")} = ? ORDER BY received_at DESC LIMIT ?`,
      "ops@example.com",
      50,
    )).toContain("idx_inbound_sender_canonical_recv");

    expect(plan(
      `SELECT id FROM inbound_emails WHERE is_sent = 1 AND is_archived = 0 AND ${sqlEmailDomain("from_address")} = ? ORDER BY received_at DESC LIMIT ?`,
      "example.com",
      50,
    )).toContain("idx_inbound_sender_domain_recv");
  });

  it("maintains normalized inbound recipient rows with triggers", () => {
    const db = getDatabase();
    db.run(
      `INSERT INTO inbound_emails
        (id, message_id, from_address, to_addresses, cc_addresses, subject, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inb-trigger-1",
        "<trigger-1@example.com>",
        "sender@example.com",
        JSON.stringify(['"Ops Team" <Ops@Example.com>', "bad value", "team@example.com"]),
        "[]",
        "triggered recipients",
        "2026-06-04T11:30:09.000Z",
      ],
    );

    let rows = db
      .query("SELECT address, domain FROM inbound_recipients WHERE inbound_email_id = ? ORDER BY address")
      .all("inb-trigger-1") as Array<{ address: string; domain: string }>;
    expect(rows).toEqual([
      { address: "ops@example.com", domain: "example.com" },
      { address: "team@example.com", domain: "example.com" },
    ]);

    db.run("UPDATE inbound_emails SET to_addresses = ? WHERE id = ?", [
      JSON.stringify(["new@example.net"]),
      "inb-trigger-1",
    ]);
    rows = db
      .query("SELECT address, domain FROM inbound_recipients WHERE inbound_email_id = ?")
      .all("inb-trigger-1") as Array<{ address: string; domain: string }>;
    expect(rows).toEqual([{ address: "new@example.net", domain: "example.net" }]);

    db.run("DELETE FROM inbound_emails WHERE id = ?", ["inb-trigger-1"]);
    const remaining = db
      .query("SELECT COUNT(*) AS count FROM inbound_recipients WHERE inbound_email_id = ?")
      .get("inb-trigger-1") as { count: number };
    expect(remaining.count).toBe(0);
  });

  it("does not rerun the inbound recipient backfill on already-migrated startup", () => {
    const path = join(mkdtempSync(join(tmpdir(), "emails-db-")), "emails.db");
    closeDatabase();
    resetDatabase();
    process.env["EMAILS_DB_PATH"] = path;
    let db = getDatabase();
    db.run(
      `INSERT INTO inbound_emails
        (id, message_id, from_address, to_addresses, cc_addresses, subject, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inb-no-rebackfill",
        "<no-rebackfill@example.com>",
        "sender@example.com",
        JSON.stringify(["ops@example.com"]),
        "[]",
        "already indexed",
        "2026-06-04T11:30:09.000Z",
      ],
    );
    expect((db.query("SELECT COUNT(*) AS count FROM inbound_recipients").get() as { count: number }).count).toBe(1);
    db.exec(`
      CREATE TABLE backfill_probe (count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO backfill_probe (count) VALUES (0);
      CREATE TRIGGER probe_inbound_backfill
      BEFORE INSERT ON inbound_recipients
      BEGIN
        UPDATE backfill_probe SET count = count + 1;
      END;
    `);

    closeDatabase();
    resetDatabase();
    db = getDatabase();

    expect((db.query("SELECT count FROM backfill_probe").get() as { count: number }).count).toBe(0);
  });

  it("repairs inbound recipient rows when the recipient table is missing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "emails-db-")), "emails.db");
    closeDatabase();
    resetDatabase();
    process.env["EMAILS_DB_PATH"] = path;
    let db = getDatabase();
    db.run(
      `INSERT INTO inbound_emails
        (id, message_id, from_address, to_addresses, cc_addresses, subject, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "inb-repair-recipients",
        "<repair-recipients@example.com>",
        "sender@example.com",
        JSON.stringify(['"Ops Team" <Ops@Example.com>']),
        "[]",
        "repair recipients",
        "2026-06-04T11:30:09.000Z",
      ],
    );
    db.exec("DROP TABLE inbound_recipients");

    closeDatabase();
    resetDatabase();
    db = getDatabase();
    const rows = db
      .query("SELECT address, domain FROM inbound_recipients WHERE inbound_email_id = ?")
      .all("inb-repair-recipients") as Array<{ address: string; domain: string }>;

    expect(rows).toEqual([{ address: "ops@example.com", domain: "example.com" }]);
  });
});

describe("runInTransaction", () => {
  it("commits successful writes", () => {
    const db = getDatabase();

    runInTransaction(db, () => {
      db.run(
        `INSERT INTO contacts (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        [uuid(), "committed@example.com", now(), now()],
      );
    });

    const row = db.query("SELECT email FROM contacts WHERE email = ?").get("committed@example.com") as { email: string } | null;
    expect(row?.email).toBe("committed@example.com");
  });

  it("rolls back writes when the callback throws", () => {
    const db = getDatabase();

    expect(() => runInTransaction(db, () => {
      db.run(
        `INSERT INTO contacts (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        [uuid(), "rolled-back@example.com", now(), now()],
      );
      throw new Error("rollback");
    })).toThrow("rollback");

    const row = db.query("SELECT email FROM contacts WHERE email = ?").get("rolled-back@example.com") as { email: string } | null;
    expect(row).toBeNull();
  });
});

describe("uuid", () => {
  it("returns a 36-char UUID", () => {
    const id = uuid();
    expect(id).toHaveLength(36);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuid()));
    expect(ids.size).toBe(100);
  });
});

describe("now", () => {
  it("returns an ISO string", () => {
    const ts = now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => new Date(ts)).not.toThrow();
  });
});

describe("resolvePartialId", () => {
  it("resolves full UUID", () => {
    const db = getDatabase();
    const id = uuid();
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id, "test", "resend"]);
    const resolved = resolvePartialId(db, "providers", id);
    expect(resolved).toBe(id);
  });

  it("resolves partial prefix", () => {
    const db = getDatabase();
    const id = uuid();
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id, "test", "resend"]);
    const resolved = resolvePartialId(db, "providers", id.slice(0, 8));
    expect(resolved).toBe(id);
  });

  it("allows event IDs for event detail routes", () => {
    const db = getDatabase();
    const providerId = uuid();
    const eventId = uuid();
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [providerId, "test", "resend"]);
    db.run(
      "INSERT INTO events (id, provider_id, type, metadata, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [eventId, providerId, "opened", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );

    expect(resolvePartialId(db, "events", eventId.slice(0, 8))).toBe(eventId);
  });

  it("returns null for unknown ID", () => {
    const db = getDatabase();
    const resolved = resolvePartialId(db, "providers", "nonexistent");
    expect(resolved).toBeNull();
  });

  it("returns null for ambiguous prefix", () => {
    const db = getDatabase();
    // Insert two providers with similar IDs would be random, so instead test with explicit setup
    const resolved = resolvePartialId(db, "providers", "");
    expect(resolved).toBeNull();
  });

  it("bounds prefix lookups to the minimum rows needed to detect ambiguity", () => {
    const db = getDatabase();
    const id1 = "abc11111-1111-1111-1111-111111111111";
    const id2 = "abc22222-2222-2222-2222-222222222222";
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id1, "p1", "sandbox"]);
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id2, "p2", "sandbox"]);

    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const statement = target.query(sql);
          return {
            get: (...args: unknown[]) => {
              calls.push({ sql, args });
              return statement.get(...args as never[]);
            },
            all: (...args: unknown[]) => {
              calls.push({ sql, args });
              return statement.all(...args as never[]);
            },
          };
        };
      },
    }) as typeof db;

    expect(resolvePartialId(recordingDb, "providers", "abc")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("LIMIT ?");
    expect(calls[0]!.args).toEqual(["abc%", 2]);
  });

  it("strictly resolves unique prefixes and reports missing or ambiguous IDs", () => {
    const db = getDatabase();
    const id1 = "abc11111-1111-1111-1111-111111111111";
    const id2 = "abc22222-2222-2222-2222-222222222222";
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id1, "p1", "sandbox"]);
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id2, "p2", "sandbox"]);

    expect(resolvePartialIdOrThrow(db, "providers", "abc11111")).toBe(id1);
    expect(listPartialIdMatches(db, "providers", "abc", 1)).toHaveLength(1);
    expect(() => resolvePartialIdOrThrow(db, "providers", "missing"))
      .toThrow("Could not resolve ID 'missing' in table 'providers'.");
    expect(() => resolvePartialIdOrThrow(db, "providers", "abc"))
      .toThrow("Ambiguous ID 'abc' in table 'providers'");
    expect(() => resolvePartialIdOrThrow(db, "providers", ""))
      .toThrow("Missing ID for table 'providers'.");
  });
});

describe("closeDatabase and resetDatabase", () => {
  it("closeDatabase closes and allows reopening", () => {
    const db1 = getDatabase();
    expect(db1).toBeDefined();
    closeDatabase();
    resetDatabase();
    const db2 = getDatabase();
    expect(db2).toBeDefined();
  });
});
