import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { testAuthDeps, selfScopedStore } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

/** Minimal in-memory query client that answers only the SQL our tests exercise. */
function fakeClient(): { client: TypedQueryClient; calls: string[] } {
  const calls: string[] = [];
  const domains: Record<string, unknown>[] = [];
  const client: TypedQueryClient = {
    async query(sql, params) {
      calls.push(sql.trim().split("\n")[0]!.trim());
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      if (/SELECT \* FROM domains\b/i.test(sql)) return domains as unknown as T[];
      return [] as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      if (sql.includes("INSERT INTO domains")) {
        const rec = {
          id: String((params ?? [])[0] ?? "generated-id"),
          domain: String((params ?? [])[1] ?? ""),
          status: String((params ?? [])[2] ?? "pending"),
          provider: (params ?? [])[3] ?? null,
          verified: Boolean((params ?? [])[4]),
          notes: (params ?? [])[5] ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        domains.push(rec);
        return rec as unknown as T;
      }
      if (sql.includes("SELECT 1")) return { ok: 1 } as unknown as T;
      return null;
    },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      calls.push(sql.trim().split("\n")[0]!.trim());
      const rec = {
        id: "generated-id",
        domain: String((params ?? [])[1] ?? ""),
        status: "pending",
        provider: null,
        verified: false,
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      domains.push(rec);
      return rec as unknown as T;
    },
    async execute(sql: string) {
      calls.push(sql.trim().split("\n")[0]!.trim());
    },
  };
  return { client, calls };
}

function deps(): SelfHostedServiceDeps {
  const { client } = fakeClient();
  return {
    client,
    store: selfScopedStore(client),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
  };
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["x-api-key"] = opts.token;
  return new Request(`http://svc${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("Emails self-hosted service", () => {
  test("GET /health returns 200 with status/version/mode", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/health"));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("9.9.9");
    expect(body.mode).toBe("self_hosted");
  });

  test("operational probes never expose database error details", async () => {
    const d = deps();
    d.client.get = async () => { throw new Error("postgres password=super-secret"); };
    d.client.many = async () => { throw new Error("postgres password=super-secret"); };

    const health = await handleSelfHostedRequest(d, req("GET", "/health"));
    const ready = await handleSelfHostedRequest(d, req("GET", "/ready"));
    expect(await health!.text()).not.toContain("super-secret");
    expect(await ready!.text()).not.toContain("super-secret");
  });

  test("GET /ready requires exact migration ids and checksums", async () => {
    const cases = [
      {
        name: "pending",
        rows: emailsSelfHostedMigrations().slice(0, -1).map(({ id, checksum }) => ({ id, checksum })),
        issue: "pendingMigrations",
      },
      {
        name: "checksum drift",
        rows: emailsSelfHostedMigrations().map(({ id, checksum }, index) => ({ id, checksum: index === 0 ? "sha256:drift" : checksum })),
        issue: "checksum mismatch",
      },
      {
        name: "unknown newer migration",
        rows: [...emailsSelfHostedMigrations().map(({ id, checksum }) => ({ id, checksum })), { id: "9999_future", checksum: "sha256:future" }],
        issue: "unknown migration",
      },
    ];
    for (const scenario of cases) {
      const d = deps();
      d.client.many = async (sql) => sql.includes("schema_migrations") ? scenario.rows as never[] : [];
      const res = await handleSelfHostedRequest(d, req("GET", "/ready"));
      expect(res?.status).toBe(503);
      const body = await res!.json();
      expect(JSON.stringify(body)).toContain(scenario.issue);
    }

    const d = deps();
    d.client.many = async (sql) => sql.includes("schema_migrations")
      ? emailsSelfHostedMigrations().map(({ id, checksum }) => ({ id, checksum })) as never[]
      : [];
    const res = await handleSelfHostedRequest(d, req("GET", "/ready"));
    expect(res?.status).toBe(200);
  });

  test("GET /ready accepts the published 0006b compatibility checksum", async () => {
    const d = deps();
    d.client.many = async (sql) => sql.includes("schema_migrations")
      ? emailsSelfHostedMigrations().map(({ id, checksum }) => ({
        id,
        checksum: id === "0006b_emails_legacy_messages_backfill_prep"
          ? "sha256:0418239e617335b948364101dfa9d55d401322c377c9999804429b6cc789de23"
          : checksum,
      })) as never[]
      : [];

    const res = await handleSelfHostedRequest(d, req("GET", "/ready"));

    expect(res?.status).toBe(200);
  });

  test("GET /version returns the version+mode shape", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/version"));
    const body = await res!.json();
    expect(body).toMatchObject({ status: "ok", version: "9.9.9", mode: "self_hosted", name: "emails" });
  });

  test("unknown non-v1 path falls through (null)", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/dashboard"));
    expect(res).toBeNull();
  });

  test("/v1 without a key is rejected 401", async () => {
    const res = await handleSelfHostedRequest(deps(), req("GET", "/v1/domains"));
    expect(res?.status).toBe(401);
    expect((await res!.json()).reason).toBe("missing_token");
  });

  test("/v1 with a bad-signature key is rejected 401", async () => {
    const forged = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: "a-different-signing-secret-16b+" }).token;
    const res = await handleSelfHostedRequest(deps(), req("GET", "/v1/domains", { token: forged }));
    expect(res?.status).toBe(401);
  });

  test("read-scoped key can GET but not POST (403 insufficient scope)", async () => {
    const d = deps();
    const readToken = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const listRes = await handleSelfHostedRequest(d, req("GET", "/v1/domains", { token: readToken }));
    expect(listRes?.status).toBe(200);
    const writeRes = await handleSelfHostedRequest(d, req("POST", "/v1/domains", { token: readToken, body: { domain: "x.com" } }));
    expect(writeRes?.status).toBe(403);
  });

  test("wrong-app key is rejected", async () => {
    const otherApp = mintApiKey({ app: "todos", scopes: ["todos:read"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(deps(), req("GET", "/v1/domains", { token: otherApp }));
    expect(res?.status).toBe(401);
  });

  test("write-scoped key creates a domain (201) and it appears in the list", async () => {
    const d = deps();
    const writeToken = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/domains", { token: writeToken, body: { domain: "Example.COM" } }));
    expect(create?.status).toBe(201);
    const created = (await create!.json()).domain;
    expect(created.domain).toBe("example.com");
    const list = await handleSelfHostedRequest(d, req("GET", "/v1/domains", { token: writeToken }));
    expect((await list!.json()).domains.length).toBe(1);
  });

  test("message counts are exposed through the authenticated self-hosted API", async () => {
    const d = deps();
    d.store.messageCounts = async () => ({
      inbox: 4,
      sent: 2,
      unread: 3,
      starred: 1,
      archived: 0,
      spam: 0,
      trash: 0,
      total: 6,
      latest_received_at: "2026-07-10T10:00:00.000Z",
    });
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(d, req("GET", "/v1/messages/counts", { token }));

    expect(res?.status).toBe(200);
    expect((await res!.json()).counts).toMatchObject({ inbox: 4, sent: 2, unread: 3, total: 6 });
  });

  test("message list forwards direction, recipient, search, and since filters to the store", async () => {
    const d = deps();
    let filters: unknown;
    d.store.listMessages = async (opts) => {
      filters = opts;
      return [];
    };
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(
      d,
      req("GET", "/v1/messages?direction=outbound&to=person%40example.com&from=sender&subject=invoice&search=needle&since=2026-07-12T00%3A00%3A00%2B03%3A00&limit=7&offset=2", { token }),
    );

    expect(res?.status).toBe(200);
    expect(filters).toEqual({
      direction: "outbound",
      to: "person@example.com",
      from: "sender",
      subject: "invoice",
      search: "needle",
      since: "2026-07-11T21:00:00.000Z",
      limit: 7,
      offset: 2,
    });
  });

  test("message list rejects invalid since filters", async () => {
    const res = await handleSelfHostedRequest(
      deps(),
      req("GET", "/v1/messages?since=not-a-date", {
        token: mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token,
      }),
    );

    expect(res?.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "since must be a valid ISO date" });
  });

  test("redacts internal failures from 500 responses", async () => {
    const d = deps();
    d.store.listDomains = async () => { throw new Error("database host and provider secret"); };
    const token = mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await handleSelfHostedRequest(d, req("GET", "/v1/domains", { token }));
      expect(res?.status).toBe(500);
      expect(await res!.json()).toEqual({ error: "internal error" });
    } finally {
      console.error = originalError;
    }
  });

  test("rejects oversized JSON bodies before parsing", async () => {
    const token = mintApiKey({ app: "emails", scopes: ["emails:write"], signingSecret: SIGNING_SECRET }).token;
    const body = JSON.stringify({ domain: `example-${"x".repeat(1024 * 1024)}.com` });
    const request = new Request("http://svc/v1/domains", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": token, "content-length": String(body.length) },
      body,
    });
    const res = await handleSelfHostedRequest(deps(), request);
    expect(res?.status).toBe(413);
    expect(await res!.json()).toEqual({ error: "request body too large" });
  });

  test("POST with missing required field returns 400", async () => {
    const writeToken = mintApiKey({ app: "emails", scopes: ["emails:write"], signingSecret: SIGNING_SECRET }).token;
    const res = await handleSelfHostedRequest(deps(), req("POST", "/v1/domains", { token: writeToken, body: {} }));
    expect(res?.status).toBe(400);
  });
});
