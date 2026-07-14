// Message id-PREFIX resolution integration tests (perf fix
// fix/message-id-prefix-resolution). Runs the REAL request pipeline
// (handleSelfHostedRequest) and the REAL scoped store against a real Postgres
// (EMAILS_TEST_POSTGRES_URL) with migrations 0000–0014 applied.
//
// Proves:
//   - store.resolveMessageId: full uuid verbatim, unique prefix resolves,
//     ambiguous prefix -> { ambiguous: true }, no match -> null, and it is
//     tenant-scoped (a prefix that only matches another tenant's row -> null).
//   - GET /v1/messages/{id}: exact id 200, unique prefix 200 (returns the FULL
//     id), ambiguous prefix 409 ambiguous_id, no match 404.
//   - PATCH / DELETE accept a prefix too (short ids work everywhere).
//
// Skipped entirely when EMAILS_TEST_POSTGRES_URL is not set.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger, type PoolQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore, type TenantScopedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import type { SelfHostedKeyStore } from "./keys.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod-0123456789";
const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pgClient: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

const stubKeyStore: SelfHostedKeyStore = {
  insertMinted: async () => {},
  list: async () => [],
  revoke: async () => false,
};

function makeDeps(): SelfHostedServiceDeps {
  return {
    client: pgClient!,
    store: new EmailsSelfHostedStore(pgClient!),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => `mock-${crypto.randomUUID()}` },
    migrations: emailsSelfHostedMigrations(),
    version: "test",
    authStore: new AuthStore(pgClient!),
    keyStore: stubKeyStore,
    signingSecret: SIGNING_SECRET,
    rateLimiter: new RateLimiter({
      rules: {
        login: { limit: 100000, windowMs: 1000 },
        signup: { limit: 100000, windowMs: 1000 },
        forgot: { limit: 100000, windowMs: 1000 },
        "verify-resend": { limit: 100000, windowMs: 1000 },
        reset: { limit: 100000, windowMs: 1000 },
        invite: { limit: 100000, windowMs: 1000 },
      },
    }),
    mailer: {
      from: "noreply@hasna.studio",
      verifyUrlBase: "https://app.test/verify",
      resetUrlBase: "https://app.test/reset",
      inviteUrlBase: "https://app.test/invite",
      productName: "Test Emails",
    },
    env: process.env,
  };
}

function reqOf(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["x-api-key"] = opts.token;
  return new Request(`http://svc${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function call(
  deps: SelfHostedServiceDeps,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await handleSelfHostedRequest(deps, reqOf(method, path, opts));
  return { status: res!.status, body: await res!.json().catch(() => ({})) };
}

/** Create a tenant + a signed api key bound to it. */
async function makeTenant(slug: string): Promise<{ tenantId: string; token: string }> {
  const t = await pgClient!.one<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [slug, slug],
  );
  const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET });
  await pgClient!.execute(`INSERT INTO api_key_tenants (kid, tenant_id) VALUES ($1, $2)`, [minted.kid, t.id]);
  return { tenantId: t.id, token: minted.token };
}

/**
 * Insert a message with a CONTROLLED id (so prefixes are deterministic). Runs in a
 * transaction that sets the tenant GUC, so the row satisfies the FORCE-RLS policy
 * (migration 0013) exactly like the scoped store does.
 */
async function insertMessage(tenantId: string, id: string): Promise<void> {
  await pgClient!.transaction(async (tx) => {
    await tx.execute(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    await tx.execute(
      `INSERT INTO messages (id, tenant_id, from_addr, to_addrs, direction, status, received_at)
       VALUES ($1, $2, 'sender@iso.example', '["rcpt@iso.example"]'::jsonb, 'inbound', 'received', now())`,
      [id, tenantId],
    );
  });
}

beforeAll(async () => {
  if (!pgClient) return;
  await pgClient.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await pgClient.execute("CREATE SCHEMA public");
  await new MigrationLedger(pgClient, emailsSelfHostedMigrations()).migrate();
});

afterAll(async () => {
  await pgClient?.close();
});

describe.skipIf(!pgClient)("store.resolveMessageId (migration 0014 index)", () => {
  it("full uuid returns verbatim; unique prefix resolves; ambiguous -> ambiguous; none -> null", async () => {
    const { tenantId } = await makeTenant("resolve-store");
    const store: TenantScopedStore = new EmailsSelfHostedStore(pgClient!).forTenant(tenantId);

    // Deterministic ids: two share the prefix "ambig000", one is unique.
    const unique = "11110000-1111-4111-8111-111100000000";
    const ambigA = "ambig000-aaaa-4aaa-8aaa-aaaa00000001";
    const ambigB = "ambig000-bbbb-4bbb-8bbb-bbbb00000002";
    await insertMessage(tenantId, unique);
    await insertMessage(tenantId, ambigA);
    await insertMessage(tenantId, ambigB);

    // A full uuid is returned as-is with no lookup (even one that does not exist).
    expect(await store.resolveMessageId(unique)).toEqual({ id: unique });
    const ghost = "deadbeef-dead-4ead-8ead-deaddeaddead";
    expect(await store.resolveMessageId(ghost)).toEqual({ id: ghost });

    // A unique prefix resolves to exactly the full id.
    expect(await store.resolveMessageId("11110000")).toEqual({ id: unique });

    // A prefix that matches ≥2 rows is ambiguous.
    expect(await store.resolveMessageId("ambig000")).toEqual({ ambiguous: true });

    // A prefix that matches nothing is null.
    expect(await store.resolveMessageId("zzzzzzzz")).toBeNull();
    expect(await store.resolveMessageId("")).toBeNull();

    // LIKE metacharacters are escaped, not treated as wildcards (adversarial
    // review). "_" would otherwise match any single char — "ambig00_" must NOT
    // resolve to "ambig000…", and bare "%"/"_" match nothing literally.
    expect(await store.resolveMessageId("ambig00_")).toBeNull();
    expect(await store.resolveMessageId("%")).toBeNull();
    expect(await store.resolveMessageId("_")).toBeNull();
  });

  it("is tenant-scoped: a prefix matching only ANOTHER tenant's row -> null", async () => {
    const a = await makeTenant("resolve-scope-a");
    const b = await makeTenant("resolve-scope-b");
    const idA = "5c0ped00-1111-4111-8111-111100000000";
    await insertMessage(a.tenantId, idA);

    const storeA: TenantScopedStore = new EmailsSelfHostedStore(pgClient!).forTenant(a.tenantId);
    const storeB: TenantScopedStore = new EmailsSelfHostedStore(pgClient!).forTenant(b.tenantId);

    expect(await storeA.resolveMessageId("5c0ped00")).toEqual({ id: idA });
    // B cannot resolve A's prefix — RLS + explicit tenant_id filter both fail closed.
    expect(await storeB.resolveMessageId("5c0ped00")).toBeNull();
  });
});

describe.skipIf(!pgClient)("GET/PATCH/DELETE /v1/messages/{id} prefix resolution", () => {
  it("exact id 200; unique prefix 200 (full id); ambiguous 409; no match 404", async () => {
    const deps = makeDeps();
    const { tenantId, token } = await makeTenant("resolve-http");
    const exact = "77770000-7777-4777-8777-777700000000";
    const ambigA = "b1a50000-aaaa-4aaa-8aaa-aaaa00000001";
    const ambigB = "b1a50000-bbbb-4bbb-8bbb-bbbb00000002";
    await insertMessage(tenantId, exact);
    await insertMessage(tenantId, ambigA);
    await insertMessage(tenantId, ambigB);

    // Exact full id.
    const full = await call(deps, "GET", `/v1/messages/${exact}`, { token });
    expect(full.status).toBe(200);
    expect(full.body.message.id).toBe(exact);

    // Unique prefix resolves and returns the FULL id.
    const pref = await call(deps, "GET", "/v1/messages/77770000", { token });
    expect(pref.status).toBe(200);
    expect(pref.body.message.id).toBe(exact);

    // Ambiguous prefix -> 409 ambiguous_id.
    const ambig = await call(deps, "GET", "/v1/messages/b1a50000", { token });
    expect(ambig.status).toBe(409);
    expect(ambig.body.reason).toBe("ambiguous_id");

    // No match -> 404.
    const miss = await call(deps, "GET", "/v1/messages/00000000", { token });
    expect(miss.status).toBe(404);
  });

  it("PATCH and DELETE accept a unique prefix", async () => {
    const deps = makeDeps();
    const { tenantId, token } = await makeTenant("resolve-write");
    const patchId = "9a110000-1111-4111-8111-111100000000";
    const deleteId = "de100000-2222-4222-8222-222200000000";
    await insertMessage(tenantId, patchId);
    await insertMessage(tenantId, deleteId);

    const patched = await call(deps, "PATCH", "/v1/messages/9a110000", { token, body: { is_read: true } });
    expect(patched.status).toBe(200);
    expect(patched.body.message.id).toBe(patchId);
    expect(patched.body.message.is_read).toBe(true);

    const deleted = await call(deps, "DELETE", "/v1/messages/de100000", { token });
    expect(deleted.status).toBe(200);
    expect(deleted.body.id).toBe(deleteId);
    // The row is gone: a second resolve is now a clean 404.
    expect((await call(deps, "GET", "/v1/messages/de100000", { token })).status).toBe(404);
  });

  it("cross-tenant: a prefix for another tenant's message 404s (isolation preserved)", async () => {
    const deps = makeDeps();
    const a = await makeTenant("resolve-iso-a");
    const b = await makeTenant("resolve-iso-b");
    const idA = "c0550000-1111-4111-8111-111100000000";
    await insertMessage(a.tenantId, idA);

    expect((await call(deps, "GET", "/v1/messages/c0550000", { token: a.token })).status).toBe(200);
    expect((await call(deps, "GET", "/v1/messages/c0550000", { token: b.token })).status).toBe(404);
    // Full id is likewise invisible cross-tenant.
    expect((await call(deps, "GET", `/v1/messages/${idA}`, { token: b.token })).status).toBe(404);
  });
});
