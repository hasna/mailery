import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import {
  createProvider,
  getProvider,
  getProviderByNameAndType,
  listProviders,
  listProviderSummaries,
  listProviderNamesByIds,
  listActiveProviders,
  listActiveProviderSummaries,
  getLatestActiveProvider,
  getLatestActiveProviderId,
  updateProvider,
  deleteProvider,
  getActiveProvider,
} from "./providers.js";
import { ProviderNotFoundError } from "../types/index.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createProvider", () => {
  it("creates a resend provider", () => {
    const p = createProvider({ name: "Resend Prod", type: "resend", api_key: "re_abc123" });
    expect(p.id).toHaveLength(36);
    expect(p.name).toBe("Resend Prod");
    expect(p.type).toBe("resend");
    expect(p.api_key).toBe("re_abc123");
    expect(p.active).toBe(true);
  });

  it("creates an SES provider", () => {
    const p = createProvider({ name: "SES US", type: "ses", region: "us-east-1", access_key: "AKIA", secret_key: "secret" });
    expect(p.type).toBe("ses");
    expect(p.region).toBe("us-east-1");
    expect(p.access_key).toBe("AKIA");
    expect(p.secret_key).toBe("secret");
    expect(p.api_key).toBeNull();
  });

  it("stores null for optional fields when not provided", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    expect(p.api_key).toBeNull();
    expect(p.region).toBeNull();
    expect(p.access_key).toBeNull();
    expect(p.secret_key).toBeNull();
  });
});

describe("getProvider", () => {
  it("retrieves provider by id", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const found = getProvider(p.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(p.id);
  });

  it("returns null for unknown id", () => {
    expect(getProvider("nonexistent")).toBeNull();
  });
});

describe("getProviderByNameAndType", () => {
  it("finds the exact provider by name and type", () => {
    const resend = createProvider({ name: "Shared", type: "resend" });
    const ses = createProvider({ name: "Shared", type: "ses" });

    expect(getProviderByNameAndType("Shared", "ses")?.id).toBe(ses.id);
    expect(getProviderByNameAndType("Shared", "resend")?.id).toBe(resend.id);
    expect(getProviderByNameAndType("Missing", "sandbox")).toBeNull();
  });
});

describe("listProviders", () => {
  it("returns empty array when no providers", () => {
    expect(listProviders()).toEqual([]);
  });

  it("lists all providers ordered by created_at desc", () => {
    const p1 = createProvider({ name: "First", type: "resend" });
    const p2 = createProvider({ name: "Second", type: "ses" });
    const list = listProviders();
    expect(list.length).toBe(2);
    expect(list.map((p) => p.id)).toContain(p1.id);
    expect(list.map((p) => p.id)).toContain(p2.id);
  });

  it("paginates providers", () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const provider = createProvider({ name: `Provider ${i}`, type: "sandbox" });
      db.run("UPDATE providers SET created_at = ? WHERE id = ?", [`2026-01-0${i}T00:00:00.000Z`, provider.id]);
    }

    const page = listProviders(db, { limit: 2, offset: 1 });

    expect(page.map((provider) => provider.name)).toEqual(["Provider 3", "Provider 2"]);
  });
});

describe("listProviderSummaries", () => {
  it("uses a credential-free projection for provider browse rows", () => {
    const db = getDatabase();
    createProvider({
      name: "Secretful",
      type: "resend",
      api_key: "api-key-secret",
    }, db);
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string) => {
            queries.push(sql);
            return target.query(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const [summary] = listProviderSummaries(recordingDb, { limit: 1 });

    expect(summary).toBeDefined();
    expect(summary?.name).toBe("Secretful");
    expect(summary?.type).toBe("resend");
    expect("oauth_client_secret" in summary!).toBe(false);
    expect("oauth_refresh_token" in summary!).toBe(false);
    expect("oauth_access_token" in summary!).toBe(false);
    expect("api_key" in summary!).toBe(false);
    expect("secret_key" in summary!).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("SELECT *");
    expect(queries[0]).not.toMatch(/\b(api_key|access_key|secret_key|oauth_client_id|oauth_client_secret|oauth_refresh_token|oauth_access_token|oauth_token_expiry)\b/);
  });

  it("paginates provider summaries", () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const provider = createProvider({ name: `Summary Provider ${i}`, type: "sandbox" }, db);
      db.run("UPDATE providers SET created_at = ? WHERE id = ?", [`2026-01-0${i}T00:00:00.000Z`, provider.id]);
    }

    const page = listProviderSummaries(db, { limit: 2, offset: 1 });

    expect(page.map((provider) => provider.name)).toEqual(["Summary Provider 3", "Summary Provider 2"]);
  });
});

describe("listProviderNamesByIds", () => {
  it("returns names for selected provider ids only", () => {
    const first = createProvider({ name: "First", type: "resend" });
    const second = createProvider({ name: "Second", type: "ses" });
    createProvider({ name: "Other", type: "sandbox" });

    expect([...listProviderNamesByIds([first.id, second.id, first.id]).entries()].sort()).toEqual([
      [first.id, "First"],
      [second.id, "Second"],
    ].sort());
    expect(listProviderNamesByIds([]).size).toBe(0);
  });
});

describe("listActiveProviders", () => {
  it("lists active providers with optional type filtering in newest-first order", () => {
    const old = createProvider({ name: "Old", type: "resend" });
    const inactive = createProvider({ name: "Inactive", type: "resend" });
    const sandbox = createProvider({ name: "Sandbox", type: "sandbox" });
    getDatabase().run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", old.id]);
    getDatabase().run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-02T00:00:00.000Z", inactive.id]);
    getDatabase().run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-03T00:00:00.000Z", sandbox.id]);
    updateProvider(inactive.id, { active: false });

    expect(listActiveProviders().map((provider) => provider.id)).toEqual([sandbox.id, old.id]);
    expect(listActiveProviders("resend").map((provider) => provider.id)).toEqual([old.id]);
    expect(listActiveProviders("sandbox").map((provider) => provider.id)).toEqual([sandbox.id]);
  });
});

describe("listActiveProviderSummaries", () => {
  it("lists active providers without credential columns", () => {
    const db = getDatabase();
    const old = createProvider({ name: "Old", type: "resend", api_key: "re_secret" }, db);
    const inactive = createProvider({ name: "Inactive", type: "ses", region: "us-east-1", access_key: "inactive-secret" }, db);
    const sandbox = createProvider({ name: "Sandbox", type: "sandbox" }, db);
    db.run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", old.id]);
    db.run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-02T00:00:00.000Z", inactive.id]);
    db.run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-03T00:00:00.000Z", sandbox.id]);
    updateProvider(inactive.id, { active: false }, db);
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
      },
    }) as typeof db;

    const all = listActiveProviderSummaries(undefined, recordingDb, { limit: 10 });
    const sandboxOnly = listActiveProviderSummaries("sandbox", recordingDb);

    expect(all.map((provider) => provider.id)).toEqual([sandbox.id, old.id]);
    expect(sandboxOnly.map((provider) => provider.id)).toEqual([sandbox.id]);
    expect(JSON.stringify(all)).not.toContain("secret");
    expect(all[0]).not.toHaveProperty("api_key");
    expect(all[0]).not.toHaveProperty("oauth_refresh_token");
    expect(queries.join("\n")).not.toMatch(/\b(api_key|access_key|secret_key|oauth_client_id|oauth_client_secret|oauth_refresh_token|oauth_access_token|oauth_token_expiry)\b/);
  });
});

describe("getLatestActiveProvider", () => {
  it("returns the newest active provider, optionally by type", () => {
    const old = createProvider({ name: "Old", type: "resend" });
    const inactive = createProvider({ name: "Inactive", type: "ses" });
    const latest = createProvider({ name: "Latest", type: "sandbox" });
    getDatabase().run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", old.id]);
    getDatabase().run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-02T00:00:00.000Z", inactive.id]);
    getDatabase().run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-03T00:00:00.000Z", latest.id]);
    updateProvider(inactive.id, { active: false });

    expect(getLatestActiveProvider()?.id).toBe(latest.id);
    expect(getLatestActiveProvider("resend")?.id).toBe(old.id);
    expect(getLatestActiveProvider("sandbox")?.id).toBe(latest.id);
    expect(getLatestActiveProvider("ses")).toBeNull();
  });

  it("returns only the newest active provider id without loading credentials", () => {
    const db = getDatabase();
    const old = createProvider({ name: "Old", type: "resend", api_key: "re_secret" }, db);
    const latest = createProvider({ name: "Latest", type: "sandbox" }, db);
    db.run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", old.id]);
    db.run("UPDATE providers SET created_at = ? WHERE id = ?", ["2026-01-02T00:00:00.000Z", latest.id]);
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
      },
    }) as typeof db;

    expect(getLatestActiveProviderId(undefined, recordingDb)).toBe(latest.id);
    expect(getLatestActiveProviderId("resend", recordingDb)).toBe(old.id);
    expect(getLatestActiveProviderId("sandbox", recordingDb)).toBe(latest.id);

    expect(queries).toHaveLength(3);
    expect(queries.every((sql) => sql.startsWith("SELECT id FROM providers"))).toBe(true);
    expect(queries.join("\n")).not.toMatch(/\b(api_key|access_key|secret_key|oauth_client_id|oauth_client_secret|oauth_refresh_token|oauth_access_token|oauth_token_expiry)\b/);
  });
});

describe("updateProvider", () => {
  it("updates name", () => {
    const p = createProvider({ name: "Old", type: "resend" });
    const updated = updateProvider(p.id, { name: "New" });
    expect(updated.name).toBe("New");
  });

  it("updates active status", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const updated = updateProvider(p.id, { active: false });
    expect(updated.active).toBe(false);
  });

  it("throws ProviderNotFoundError for unknown id", () => {
    expect(() => updateProvider("nonexistent", { name: "x" })).toThrow(ProviderNotFoundError);
  });
});

describe("deleteProvider", () => {
  it("deletes a provider", () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const deleted = deleteProvider(p.id);
    expect(deleted).toBe(true);
    expect(getProvider(p.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteProvider("nonexistent")).toBe(false);
  });
});

describe("getActiveProvider", () => {
  it("returns the first active provider", () => {
    const p = createProvider({ name: "Active", type: "resend" });
    const active = getActiveProvider();
    expect(active.id).toBe(p.id);
  });

  it("throws ProviderNotFoundError when no active providers", () => {
    expect(() => getActiveProvider()).toThrow(ProviderNotFoundError);
  });
});
