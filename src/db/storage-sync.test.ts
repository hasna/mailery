import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Database } from "./database.js";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import { storeInboundEmail } from "./inbound.js";
import { listProviders } from "./providers.js";
import type { PgAdapterAsync } from "./remote-storage.js";
import {
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  getStorageDatabaseEnv,
  getStorageDatabaseEnvName,
  getStorageMode,
  getStorageStatus,
  parseStorageTables,
  pullTablesFromRemote,
  pullTable,
  pushTable,
  runStorageMigrations,
  storageSync,
} from "./storage-sync.js";

type Row = Record<string, unknown>;

const STORAGE_ENV = [
  ...STORAGE_DATABASE_ENV,
  ...STORAGE_MODE_ENV,
] as const;

class FakeRemote {
  allCalls: Array<{ sql: string; params: unknown[] }> = [];
  runCalls: Array<{ sql: string; params: unknown[] }> = [];

  constructor(
    private readonly rowsByTable: Record<string, Row[]> = {},
    private readonly migrationRows: Row[] = [],
  ) {}

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    this.allCalls.push({ sql, params });
    if (sql.includes("FROM _migrations")) return this.migrationRows;
    if (sql.includes("information_schema.columns")) return [];
    const table = sql.match(/FROM "([^"]+)"/)?.[1] ?? "";
    const limit = Number(params[0] ?? this.rowsByTable[table]?.length ?? 0);
    const offset = Number(params[1] ?? 0);
    return (this.rowsByTable[table] ?? []).slice(offset, offset + limit);
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    this.runCalls.push({ sql, params });
    return { changes: 1 };
  }

  async close(): Promise<void> {}
}

class ThrowingRemote extends FakeRemote {
  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    this.runCalls.push({ sql, params });
    throw new Error("remote write failed");
  }
}

class FailingReadRemote extends FakeRemote {
  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    if (sql.includes('FROM "owners"')) {
      this.allCalls.push({ sql, params });
      throw new Error("remote read failed");
    }
    return super.all(sql, ...params);
  }
}

class StatefulRemote extends FakeRemote {
  private readonly rows = new Map<string, Row[]>();

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    this.allCalls.push({ sql, params });
    if (sql.includes("FROM _migrations")) return [];
    if (sql.includes("information_schema.columns")) return [];
    const table = sql.match(/FROM "([^"]+)"/)?.[1];
    if (!table) return [];
    const limit = Number(params[0] ?? this.rows.get(table)?.length ?? 0);
    const offset = Number(params[1] ?? 0);
    return (this.rows.get(table) ?? []).slice(offset, offset + limit);
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    this.runCalls.push({ sql, params });
    const match = sql.match(/INSERT INTO "([^"]+)" \(([^)]+)\) VALUES/i);
    if (!match) return { changes: 1 };
    const table = match[1]!;
    const columns = match[2]!
      .split(",")
      .map((column) => column.trim().replace(/^"|"$/g, ""));
    const row = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
    const primaryKey = table === "mailbox_message_state"
      ? ["mailbox_id", "mail_message_id"]
      : table === "inbound_recipients" || table === "inbound_labels"
        ? ["inbound_email_id", table === "inbound_recipients" ? "address" : "label"]
        : ["id"];
    const key = primaryKey.map((column) => String(row[column] ?? "")).join("\0");
    const tableRows = this.rows.get(table) ?? [];
    const existingIndex = tableRows.findIndex((candidate) => (
      primaryKey.map((column) => String(candidate[column] ?? "")).join("\0") === key
    ));
    if (existingIndex >= 0) tableRows[existingIndex] = { ...tableRows[existingIndex], ...row };
    else tableRows.push(row);
    this.rows.set(table, tableRows);
    return { changes: 1 };
  }

  setRows(table: string, rows: Row[]): void {
    this.rows.set(table, rows.map((row) => ({ ...row })));
  }
}

function providerRow(id: string, name: string): Row {
  return {
    id,
    name,
    type: "resend",
    api_key: null,
    region: null,
    access_key: null,
    secret_key: null,
    active: 1,
    created_at: `2026-01-01T00:00:0${id}.000Z`,
    updated_at: `2026-01-01T00:00:0${id}.000Z`,
  };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  for (const key of STORAGE_ENV) delete process.env[key];
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  for (const key of STORAGE_ENV) delete process.env[key];
});

describe("emails storage sync configuration", () => {
  it("keeps migration SQL lazy until migrations run", () => {
    const source = readFileSync(`${import.meta.dir}/storage-sync.ts`, "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']\.\/pg-migrations\.js["'];/m);
    expect(source).toContain('await import("./pg-migrations.js")');
  });

  it("prefers canonical storage database env over fallback", () => {
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://canonical";
    process.env["EMAILS_DATABASE_URL"] = "postgres://fallback";

    expect(getStorageDatabaseEnv()).toEqual({
      name: "HASNA_EMAILS_DATABASE_URL",
    });
    expect(getStorageDatabaseEnvName()).toBe("HASNA_EMAILS_DATABASE_URL");
    expect(getStorageStatus()).toMatchObject({
      configured: true,
      activeEnv: "HASNA_EMAILS_DATABASE_URL",
      mode: "remote",
      sourceOfTruth: "postgres",
      localCache: "runtime-cache",
      maileryMode: "self_hosted",
      maileryModeLabel: "Self-hosted",
      service: "emails",
      canonical: {
        cluster: null,
        database: null,
        runtimePath: null,
        env: "HASNA_EMAILS_DATABASE_URL",
        fallbackEnv: "EMAILS_DATABASE_URL",
      },
    });
  });

  it("uses fallback storage database env when canonical env is absent", () => {
    process.env["EMAILS_DATABASE_URL"] = "postgres://fallback";

    expect(getStorageDatabaseEnv()).toEqual({
      name: "EMAILS_DATABASE_URL",
    });
    expect(getStorageDatabaseEnvName()).toBe("EMAILS_DATABASE_URL");
  });

  it("resolves storage mode from storage envs", () => {
    expect(getStorageMode()).toBe("local");

    process.env["EMAILS_DATABASE_URL"] = "postgres://remote";
    expect(getStorageMode()).toBe("remote");

    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";
    const status = getStorageStatus();
    expect(status.mode).toBe("remote");
    expect(status.sourceOfTruth).toBe("postgres");
    expect(status.localCache).toBe("runtime-cache");
    expect(status.maileryMode).toBe("self_hosted");
    expect(status.maileryModeWarning).toBeNull();
  });

  it("parses and validates storage table filters", () => {
    expect(parseStorageTables(["providers", "domains"])).toEqual(["providers", "domains"]);
    expect(parseStorageTables([
      "inbound_recipients",
      "inbound_labels",
      "mailboxes",
      "mailbox_sources",
      "mail_folders",
      "mail_messages",
      "mailbox_message_state",
      "email_agent_settings",
      "email_agent_runs",
      "email_digests",
    ])).toEqual([
      "inbound_recipients",
      "inbound_labels",
      "mailboxes",
      "mailbox_sources",
      "mail_folders",
      "mail_messages",
      "mailbox_message_state",
      "email_agent_settings",
      "email_agent_runs",
      "email_digests",
    ]);
    expect(() => parseStorageTables(["providers", "missing"])).toThrow("Unknown emails sync table(s): missing");
  });

  it("reconciles remote-derived labels and canonical mailbox state after storage sync", () => {
    const source = readFileSync(`${import.meta.dir}/storage-sync.ts`, "utf8");

    expect(source).toContain("rebuildInboundLabelState");
    expect(source).toContain("reconcileMailboxMessageState");
    expect(source).toContain("DELETE FROM inbound_labels label");
    expect(source).toContain("UPDATE mailbox_message_state state");
  });

  it("requires explicit force for pull-then-push sync", async () => {
    await expect(storageSync()).rejects.toThrow("can overwrite local rows");
  });

  it("does not push after pull errors during forced sync", async () => {
    let pushed = false;

    await expect(storageSync(
      { force: true },
      {
        pull: async () => [{ table: "providers", rowsRead: 0, rowsWritten: 0, errors: ["pull failed"] }],
        push: async () => {
          pushed = true;
          return [];
        },
      },
    )).rejects.toThrow("push was not run");

    expect(pushed).toBe(false);
  });

  it("rolls back local pull writes when a later table fails", async () => {
    const remote = new FailingReadRemote({
      providers: [providerRow("1", "Remote 1")],
    });

    const results = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      getDatabase(),
      { tables: ["providers", "owners"], batchSize: 2 },
    );

    expect(results[0]).toMatchObject({ table: "providers", rowsWritten: 1, errors: [] });
    expect(results[1]).toMatchObject({ table: "owners", errors: ["remote read failed"] });
    expect(listProviders()).toEqual([]);
  });

  it("rebuilds stale pulled inbound label rows from inbound_emails.label_ids_json", async () => {
    const remote = new FakeRemote({
      inbound_emails: [{
        id: "inbound-1",
        provider_id: null,
        message_id: "remote-message-1",
        in_reply_to_email_id: null,
        provider_thread_id: null,
        thread_id: null,
        provider_history_id: null,
        provider_internal_date: null,
        label_ids_json: "[]",
        raw_s3_url: null,
        metadata_s3_url: null,
        from_address: "sender@example.com",
        to_addresses: "[\"me@example.com\"]",
        cc_addresses: "[]",
        subject: "Remote pull",
        text_body: "body",
        html_body: null,
        attachments_json: "[]",
        attachment_paths: "[]",
        headers_json: "{}",
        raw_size: 1,
        is_read: 0,
        read_at: null,
        is_archived: 0,
        is_starred: 0,
        is_sent: 0,
        is_spam: 0,
        is_trash: 0,
        received_at: "2026-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        mail_message_id: "msg:inbound:inbound-1",
      }],
      inbound_labels: [{ inbound_email_id: "inbound-1", label: "spam" }],
    });

    const results = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      getDatabase(),
      { tables: ["inbound_emails", "inbound_labels"], batchSize: 2 },
    );

    expect(results.every((result) => result.errors.length === 0)).toBe(true);
    expect(getDatabase().query("SELECT * FROM inbound_labels").all()).toEqual([]);
    expect(getDatabase().query("SELECT is_spam, is_trash FROM inbound_emails WHERE id = 'inbound-1'").get()).toEqual({ is_spam: 0, is_trash: 0 });
    expect(getDatabase().query("SELECT is_spam, is_trash, folder_id FROM mailbox_message_state WHERE mail_message_id = 'msg:inbound:inbound-1'").get()).toMatchObject({
      is_spam: 0,
      is_trash: 0,
      folder_id: "folder:mbx:me@example.com:inbox",
    });
  });
});

describe("storage table sync batching", () => {
  it("skips PostgreSQL migrations that are already recorded", async () => {
    const remote = new FakeRemote({}, Array.from({ length: 37 }, (_, index) => ({ id: index + 1 })));

    await runStorageMigrations(remote as unknown as PgAdapterAsync);

    const sql = remote.runCalls.map((call) => call.sql).join("\n");
    expect(sql).not.toContain("INSERT INTO inbound_labels");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS feedback");
  });

  it("pushes local rows in bounded batches", async () => {
    const localRows = ["1", "2", "3", "4", "5"].map((id) => providerRow(id, `Provider ${id}`));
    const dataReads: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      query: (sql: string) => ({
        get: () => sql.includes("sqlite_master") ? { name: "providers" } : null,
        all: (...args: unknown[]) => {
          dataReads.push({ sql, args });
          const limit = Number(args[0]);
          const offset = Number(args[1]);
          return localRows.slice(offset, offset + limit);
        },
      }),
    } as unknown as Database;
    const remote = new FakeRemote();

    const result = await pushTable(db, remote as unknown as PgAdapterAsync, "providers", { batchSize: 2 });

    expect(result).toMatchObject({ table: "providers", rowsRead: 5, rowsWritten: 5, errors: [] });
    expect(dataReads.map((call) => call.args)).toEqual([[2, 0], [2, 2], [2, 4]]);
    expect(dataReads.every((call) => call.sql.includes("LIMIT ? OFFSET ?"))).toBe(true);
    expect(remote.runCalls).toHaveLength(5);
  });

  it("pushes only rows matching a parameterized row filter", async () => {
    const localRows = ["1", "2", "3"].map((id) => providerRow(id, `Provider ${id}`));
    const dataReads: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      query: (sql: string) => ({
        get: () => sql.includes("sqlite_master") ? { name: "providers" } : null,
        all: (...args: unknown[]) => {
          dataReads.push({ sql, args });
          const filtered = localRows.filter((row) => row.name === args[0]);
          const limit = Number(args[1]);
          const offset = Number(args[2]);
          return filtered.slice(offset, offset + limit);
        },
      }),
    } as unknown as Database;
    const remote = new FakeRemote();

    const result = await pushTable(db, remote as unknown as PgAdapterAsync, "providers", {
      batchSize: 2,
      filter: { where: "name = ?", params: ["Provider 2"] },
    });

    expect(result).toMatchObject({ table: "providers", rowsRead: 1, rowsWritten: 1, errors: [] });
    expect(dataReads).toHaveLength(1);
    expect(dataReads[0]!.sql).toContain("WHERE name = ?");
    expect(dataReads[0]!.args).toEqual(["Provider 2", 2, 0]);
    expect(remote.runCalls).toHaveLength(1);
    expect(remote.runCalls[0]!.params[0]).toBe("2");
  });

  it("returns per-table push errors for CLI aggregation", async () => {
    const db = {
      query: (sql: string) => ({
        get: () => sql.includes("sqlite_master") ? { name: "providers" } : null,
        all: () => [providerRow("1", "Provider 1")],
      }),
    } as unknown as Database;
    const remote = new ThrowingRemote();

    const result = await pushTable(db, remote as unknown as PgAdapterAsync, "providers", { batchSize: 2 });

    expect(result.table).toBe("providers");
    expect(result.errors).toEqual(["remote write failed"]);
  });

  it("pulls remote rows in bounded batches and preserves SQLite upsert behavior", async () => {
    const remote = new FakeRemote({
      providers: ["1", "2", "3"].map((id) => providerRow(id, `Remote ${id}`)),
    });

    const result = await pullTable(remote as unknown as PgAdapterAsync, getDatabase(), "providers", { batchSize: 2 });

    expect(result).toMatchObject({ table: "providers", rowsRead: 3, rowsWritten: 3, errors: [] });
    const dataCalls = remote.allCalls.filter((call) => call.sql.includes('FROM "providers"'));
    expect(dataCalls.map((call) => call.params)).toEqual([[2, 0], [2, 2]]);
    expect(dataCalls.every((call) => call.sql.includes("LIMIT ? OFFSET ?"))).toBe(true);
    expect(listProviders().map((provider) => provider.name).sort()).toEqual(["Remote 1", "Remote 2", "Remote 3"]);
  });

  it("replace pulls delete stale local rows that are missing from the remote source of truth", async () => {
    getDatabase().run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES ('local-stale', 'Local stale', 'resend', 1, datetime('now'), datetime('now'))`,
    );
    const remote = new FakeRemote({
      providers: [providerRow("1", "Remote 1")],
    });

    const result = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      getDatabase(),
      { tables: ["providers"], batchSize: 2, replace: true },
    );

    expect(result).toEqual([{ table: "providers", rowsRead: 1, rowsWritten: 1, errors: [] }]);
    expect(listProviders().map((provider) => provider.name)).toEqual(["Remote 1"]);
  });

  it("round-trips mail rows through a disposable Postgres fixture and replaces stale cache state", async () => {
    const db = getDatabase();
    const remote = new StatefulRemote();
    db.run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES ('provider-1', 'Local source', 'ses', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    const stored = storeInboundEmail({
      provider_id: "provider-1",
      message_id: "s3://fixture-bucket/inbound/msg-1",
      in_reply_to_email_id: null,
      raw_s3_url: "s3://fixture-bucket/inbound/msg-1",
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Remote authoritative subject",
      text_body: "remote body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 128,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);

    expect(await pushTable(db, remote as unknown as PgAdapterAsync, "providers", { batchSize: 1 }))
      .toMatchObject({ table: "providers", rowsRead: 1, rowsWritten: 1, errors: [] });
    expect(await pushTable(db, remote as unknown as PgAdapterAsync, "inbound_emails", { batchSize: 1 }))
      .toMatchObject({ table: "inbound_emails", rowsRead: 1, rowsWritten: 1, errors: [] });

    db.run("UPDATE inbound_emails SET subject = 'Stale local subject', is_archived = 1 WHERE id = ?", [stored.id]);

    const results = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      db,
      { tables: ["inbound_emails"], batchSize: 1, replace: true },
    );

    expect(results).toEqual([
      { table: "inbound_emails", rowsRead: 1, rowsWritten: 1, errors: [] },
    ]);
    expect(db.query("SELECT subject, is_archived FROM inbound_emails WHERE id = ?").get(stored.id)).toEqual({
      subject: "Remote authoritative subject",
      is_archived: 0,
    });
  });

  it("treats remote tombstones as authoritative for disposable self-hosted mail caches", async () => {
    const db = getDatabase();
    const remote = new StatefulRemote();
    db.run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES ('provider-1', 'Local source', 'ses', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    const stored = storeInboundEmail({
      provider_id: "provider-1",
      message_id: "s3://fixture-bucket/inbound/tombstoned",
      in_reply_to_email_id: null,
      raw_s3_url: "s3://fixture-bucket/inbound/tombstoned",
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Tombstoned locally",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 64,
      received_at: "2026-07-01T12:00:00.000Z",
    }, db);
    remote.setRows("inbound_emails", []);
    remote.setRows("mailbox_message_state", []);

    const results = await pullTablesFromRemote(
      remote as unknown as PgAdapterAsync,
      db,
      { tables: ["inbound_emails", "mailbox_message_state"], batchSize: 1, replace: true },
    );

    expect(results).toEqual([
      { table: "inbound_emails", rowsRead: 0, rowsWritten: 0, errors: [] },
      { table: "mailbox_message_state", rowsRead: 0, rowsWritten: 0, errors: [] },
    ]);
    expect(db.query("SELECT id FROM inbound_emails WHERE id = ?").get(stored.id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM mailbox_message_state WHERE mail_message_id = ?").get(`msg:inbound:${stored.id}`)).toEqual({ count: 0 });
  });
});
