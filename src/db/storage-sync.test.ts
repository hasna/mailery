import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Database } from "./database.js";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
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
      mode: "hybrid",
      service: "emails",
      canonical: {
        cluster: "hasna-xyz-infra-apps-prod-postgres",
        database: "emails",
        runtimePath: "hasna/xyz/opensource/emails/prod/rds",
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
    expect(getStorageMode()).toBe("hybrid");

    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";
    expect(getStorageMode()).toBe("remote");
  });

  it("parses and validates storage table filters", () => {
    expect(parseStorageTables(["providers", "domains"])).toEqual(["providers", "domains"]);
    expect(parseStorageTables(["inbound_recipients", "inbound_labels", "email_agent_settings", "email_agent_runs", "email_digests"])).toEqual([
      "inbound_recipients",
      "inbound_labels",
      "email_agent_settings",
      "email_agent_runs",
      "email_digests",
    ]);
    expect(() => parseStorageTables(["providers", "missing"])).toThrow("Unknown emails sync table(s): missing");
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
});
