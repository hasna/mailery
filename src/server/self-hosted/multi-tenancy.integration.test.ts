// Multi-tenancy + auth security integration tests (WI-5b/5c + Addendum A1/A2).
//
// Runs the REAL request pipeline (handleSelfHostedRequest) against a real
// Postgres (EMAILS_TEST_POSTGRES_URL). Proves the security-critical guarantees:
//   - Layer-1 tenant isolation: tenant A can never read/patch/delete tenant B's
//     rows (hand-written domains/addresses/messages + generic resources + send
//     keys), and the same natural key is reusable per tenant.
//   - resolveRequestContext: session vs api-key dispatch; api key with NO tenant
//     mapping fails closed (403); malformed/foreign credentials -> 401.
//   - Addendum A1: signup/login/invite restricted to @hasna.<tld> (generic 403).
//   - Addendum A2: signup creates an UNVERIFIED user; login refused until the
//     emailed verification token is consumed (SES send is mocked/captured).
//   - M4: a body-supplied FK id pointing at another tenant's row is rejected.
//   - Role gates: viewer is read-only; last-owner cannot be demoted/removed.
//   - bootstrap-owner: the api-key operator seeds the first owner once.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger, type PoolQueryClient } from "../../storage-kit/index.js";
import { DEFAULT_TENANT_ID, emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { hashPassword } from "./auth/password.js";
import type { AuthMailerConfig } from "./auth/mailer.js";
import type { SelfHostedKeyStore } from "./keys.js";
import { ingestS3Object, shouldDeleteIngestResult } from "./ingest-worker.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod-0123456789";
const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pgClient: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

// A key-store stub: the tests that mint tenant keys through /v1/keys do so via the
// AuthStore binding; issuance itself is exercised elsewhere. Data-path key tests
// mint signed tokens directly with mintApiKey.
const stubKeyStore: SelfHostedKeyStore = {
  insertMinted: async () => {},
  list: async () => [],
  revoke: async () => false,
};

const MAILER: AuthMailerConfig = {
  from: "noreply@hasna.studio",
  verifyUrlBase: "https://app.test/verify",
  resetUrlBase: "https://app.test/reset",
  inviteUrlBase: "https://app.test/invite",
  productName: "Test Emails",
};

interface Captured { to: string; subject: string; text: string; html: string }

/** Deps sharing the migrated client, with a per-call captured-email sink. */
function makeDeps(): { deps: SelfHostedServiceDeps; sent: Captured[] } {
  const sent: Captured[] = [];
  const deps: SelfHostedServiceDeps = {
    client: pgClient!,
    store: new EmailsSelfHostedStore(pgClient!),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: {
      provider: "ses",
      send: async (opts) => {
        sent.push({
          to: String(opts.to),
          subject: opts.subject,
          text: opts.text ?? "",
          html: opts.html ?? "",
        });
        return `mock-${crypto.randomUUID()}`;
      },
    },
    migrations: emailsSelfHostedMigrations(),
    version: "test",
    authStore: new AuthStore(pgClient!),
    keyStore: stubKeyStore,
    signingSecret: SIGNING_SECRET,
    // Permissive limiter so the many test signups/logins are not throttled.
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
    mailer: MAILER,
    env: process.env,
  };
  return { deps, sent };
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

/** Extract a `?token=…` value from the last captured email. */
function lastToken(sent: Captured[]): string {
  const last = sent[sent.length - 1];
  const m = last?.text.match(/token=([^\s&"]+)/);
  return m ? decodeURIComponent(m[1]!) : "";
}

/** Create a tenant + a signed api key bound to it. */
async function makeTenant(slug: string): Promise<{ tenantId: string; token: string; kid: string }> {
  const t = await pgClient!.one<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [slug, slug],
  );
  const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET });
  await pgClient!.execute(`INSERT INTO api_key_tenants (kid, tenant_id) VALUES ($1, $2)`, [minted.kid, t.id]);
  return { tenantId: t.id, token: minted.token, kid: minted.kid };
}

async function createVerifiedUser(email: string, password: string, tenantId: string, role: string): Promise<string> {
  const hash = await hashPassword(password);
  const u = await pgClient!.one<{ id: string }>(
    `INSERT INTO users (email, password_hash, status, email_verified_at) VALUES ($1, $2, 'active', now()) RETURNING id`,
    [email, hash],
  );
  await pgClient!.execute(
    `INSERT INTO user_email_identities (user_id, email, is_primary, verified_at)
     VALUES ($1, $2, true, now())`,
    [u.id, email],
  );
  await pgClient!.execute(
    `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, $3, 'active')`,
    [u.id, tenantId, role],
  );
  return u.id;
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

describe.skipIf(!pgClient)("resolveRequestContext dispatch (design §4.3)", () => {
  it("api key bound to a tenant resolves; /v1/me reports the apikey principal", async () => {
    const { deps } = makeDeps();
    const { token, tenantId } = await makeTenant("rc-bound");
    const me = await call(deps, "GET", "/v1/me", { token });
    expect(me.status).toBe(200);
    expect(me.body.principal_type).toBe("apikey");
    expect(me.body.tenant.id).toBe(tenantId);
  });

  it("api key with NO tenant mapping fails closed (403 no_tenant)", async () => {
    const { deps } = makeDeps();
    const orphan = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;
    const res = await call(deps, "GET", "/v1/domains", { token: orphan });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("no_tenant");
  });

  it("missing / malformed / foreign-prefix credentials -> 401", async () => {
    const { deps } = makeDeps();
    expect((await call(deps, "GET", "/v1/domains")).status).toBe(401);
    expect((await call(deps, "GET", "/v1/domains", { token: "garbage" })).status).toBe(401);
    expect((await call(deps, "GET", "/v1/domains", { token: "emss_deadbeef" })).status).toBe(401);
  });

  it("the pre-existing api-key path maps to the default tenant (back-compat)", async () => {
    const { deps } = makeDeps();
    const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET });
    await pgClient!.execute(
      `INSERT INTO api_key_tenants (kid, tenant_id) VALUES ($1, $2) ON CONFLICT (kid) DO NOTHING`,
      [minted.kid, DEFAULT_TENANT_ID],
    );
    const res = await call(deps, "GET", "/v1/domains", { token: minted.token });
    expect(res.status).toBe(200);
  });
});

describe.skipIf(!pgClient)("tenant isolation matrix (WI-5c, Layer 1)", () => {
  it("a caller can never read/patch/delete another tenant's rows", async () => {
    const { deps } = makeDeps();
    const a = await makeTenant("iso-a");
    const b = await makeTenant("iso-b");

    // A creates a domain, a contact, and imports an inbound message.
    const dom = await call(deps, "POST", "/v1/domains", { token: a.token, body: { domain: "iso.example" } });
    expect(dom.status).toBe(201);
    const domId = dom.body.domain.id;
    const contact = await call(deps, "POST", "/v1/contacts", { token: a.token, body: { email: "who@iso.example" } });
    expect(contact.status).toBe(201);
    const contactId = contact.body.id;
    const msg = await call(deps, "POST", "/v1/messages", {
      token: a.token,
      body: { from: "x@iso.example", to: ["y@iso.example"], subject: "hi", source_id: `src-${crypto.randomUUID()}`, received_at: "2026-07-13T00:00:00Z" },
    });
    expect(msg.status).toBe(201);
    const msgId = msg.body.message.id;

    // B sees NONE of A's rows in lists.
    expect((await call(deps, "GET", "/v1/domains", { token: b.token })).body.domains).toHaveLength(0);
    expect((await call(deps, "GET", "/v1/contacts", { token: b.token })).body.items).toHaveLength(0);
    expect((await call(deps, "GET", "/v1/messages", { token: b.token })).body.messages).toHaveLength(0);

    // B cannot GET/PATCH/DELETE A's rows by id (404, no cross-tenant existence).
    expect((await call(deps, "GET", `/v1/domains/${domId}`, { token: b.token })).status).toBe(404);
    expect((await call(deps, "PATCH", `/v1/domains/${domId}`, { token: b.token, body: { status: "hacked" } })).status).toBe(404);
    expect((await call(deps, "DELETE", `/v1/domains/${domId}`, { token: b.token })).status).toBe(404);
    expect((await call(deps, "GET", `/v1/contacts/${contactId}`, { token: b.token })).status).toBe(404);
    expect((await call(deps, "DELETE", `/v1/contacts/${contactId}`, { token: b.token })).status).toBe(404);
    expect((await call(deps, "GET", `/v1/messages/${msgId}`, { token: b.token })).status).toBe(404);
    expect((await call(deps, "DELETE", `/v1/messages/${msgId}`, { token: b.token })).status).toBe(404);

    // A still sees its own rows.
    expect((await call(deps, "GET", "/v1/domains", { token: a.token })).body.domains).toHaveLength(1);
    expect((await call(deps, "GET", `/v1/domains/${domId}`, { token: a.token })).status).toBe(200);

    // The SAME domain name is registrable in B (per-tenant uniqueness).
    const domB = await call(deps, "POST", "/v1/domains", { token: b.token, body: { domain: "iso.example" } });
    expect(domB.status).toBe(201);
  });

  it("mailbox + thread rollups only count the caller's tenant", async () => {
    const { deps } = makeDeps();
    const a = await makeTenant("roll-a");
    const b = await makeTenant("roll-b");
    await call(deps, "POST", "/v1/addresses", { token: a.token, body: { email: "box@roll-a.example" } });
    await call(deps, "POST", "/v1/messages", {
      token: a.token,
      body: { from: "s@x.com", to: ["box@roll-a.example"], subject: "count me", source_id: `s-${crypto.randomUUID()}`, received_at: "2026-07-13T00:00:00Z" },
    });
    const bMail = await call(deps, "GET", "/v1/mailboxes", { token: b.token });
    expect(bMail.body.mailboxes).toHaveLength(0);
    expect(bMail.body.counts.total).toBe(0);
    const bThreads = await call(deps, "GET", "/v1/messages/threads", { token: b.token });
    expect(bThreads.body.threads).toHaveLength(0);
  });

  // NOTE: this exercises the Layer-1 (application) M4 control on the RLS-BYPASSED
  // path — EMAILS_TEST_POSTGRES_URL connects as a superuser, which bypasses RLS, so
  // assertNotOtherTenant can see the foreign-tenant row and return 404. Under
  // enforced FORCE RLS in prod the same request returns 201 and produces a HARMLESS
  // same-tenant-stamped dangling reference (RLS supersedes M4 — see store.ts
  // assertNotOtherTenant); the substantive isolation guarantee (cross-tenant WRITE
  // blocked at the DB layer) is proven in rls.integration.test.ts.
  it("M4: a body FK id referencing another tenant's row is rejected (404); a dangling id is allowed", async () => {
    const { deps } = makeDeps();
    const a = await makeTenant("fk-a");
    const b = await makeTenant("fk-b");
    const group = await call(deps, "POST", "/v1/groups", { token: a.token, body: { name: "A team" } });
    const groupId = group.body.id;

    // B references A's group_id -> rejected as not-found for B.
    const cross = await call(deps, "POST", "/v1/group-members", { token: b.token, body: { group_id: groupId, email: "m@fk-b.example" } });
    expect(cross.status).toBe(404);
    expect(cross.body.reason).toBe("cross_tenant_reference");

    // A dangling (nonexistent-anywhere) group_id is permitted (loose/denormalized).
    const dangling = await call(deps, "POST", "/v1/group-members", { token: b.token, body: { group_id: crypto.randomUUID(), email: "m2@fk-b.example" } });
    expect(dangling.status).toBe(201);
  });

  it("send-key verify is tenant-scoped: another tenant cannot resolve the token", async () => {
    const { deps } = makeDeps();
    const a = await makeTenant("sk-a");
    const b = await makeTenant("sk-b");
    const scoped = deps.store.forTenant(a.tenantId);
    const { token } = await scoped.mintSendKey({ owner_id: `owner-${crypto.randomUUID()}` });

    // A resolves it; B does not.
    const asA = await call(deps, "POST", "/v1/send-keys/verify", { token: a.token, body: { token } });
    expect(asA.body.valid).toBe(true);
    const asB = await call(deps, "POST", "/v1/send-keys/verify", { token: b.token, body: { token } });
    expect(asB.body.valid).toBe(false);
  });

  it("send-keys resource is SUMMARY-ONLY: key_hash never appears in any /v1/send-keys response", async () => {
    const { deps } = makeDeps();
    const a = await makeTenant("sk-redact");
    // Reproduce the drifted PROD shape: send_keys still carries a legacy secret
    // column the fresh migrations don't create. A row is seeded with a REAL-looking
    // hash so we can assert the exact secret value never escapes.
    const secret = "sha256$deadbeefcafefeed_never_leak_this";
    await pgClient!.execute(`ALTER TABLE send_keys ADD COLUMN IF NOT EXISTS key_hash text`);
    const skId = crypto.randomUUID();
    await pgClient!.execute(
      `INSERT INTO send_keys (id, owner_id, key_hash, prefix, label, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [skId, "owner-redact", secret, "esk_redact01", "leaky", a.tenantId],
    );

    // GET /v1/send-keys (list) and GET /v1/send-keys/:id must both omit key_hash
    // (and never surface the secret value anywhere in the serialized response),
    // while still returning the non-secret summary fields.
    const list = await call(deps, "GET", "/v1/send-keys", { token: a.token });
    expect(list.status).toBe(200);
    const seeded = list.body.items.find((i: any) => i.id === skId);
    expect(seeded, "seeded key present in list").toBeTruthy();
    expect(seeded).not.toHaveProperty("key_hash");
    expect(seeded.prefix).toBe("esk_redact01");
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(JSON.stringify(list.body)).not.toContain("key_hash");

    const one = await call(deps, "GET", `/v1/send-keys/${skId}`, { token: a.token });
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty("key_hash");
    expect(one.body.owner_id).toBe("owner-redact");
    expect(JSON.stringify(one.body)).not.toContain(secret);
    expect(JSON.stringify(one.body)).not.toContain("key_hash");
  });

  it("idempotency-key replay resolves within the tenant only", async () => {
    const { deps } = makeDeps();
    const a = await makeTenant("idem-a");
    const scoped = deps.store.forTenant(a.tenantId);
    const key = `k-${crypto.randomUUID()}`;
    const first = await scoped.reserveSendIntent({ from_addr: "s@x.com", to_addrs: ["t@x.com"], idempotency_key: key, send_payload_hash: "h1" });
    const replay = await scoped.reserveSendIntent({ from_addr: "s@x.com", to_addrs: ["t@x.com"], idempotency_key: key, send_payload_hash: "h1" });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.record.id).toBe(first.record.id);
    // Another tenant cannot see A's reserved intent by id.
    const b = await makeTenant("idem-b");
    expect(await deps.store.forTenant(b.tenantId).getMessage(first.record.id)).toBeNull();
  });
});

describe.skipIf(!pgClient)("central outbound enforcement", () => {
  it("allows a ready sender and blocks suppression, unverified senders, and quota before provider I/O", async () => {
    const { deps, sent } = makeDeps();
    const tenant = await makeTenant("outbound-policy");
    const domain = await call(deps, "POST", "/v1/domains", {
      token: tenant.token,
      body: { domain: "policy.example", status: "active", verified: true, provisioning_status: "ready" },
    });
    expect(domain.status).toBe(201);
    const register = (email: string, extra: Record<string, unknown> = {}) => call(deps, "POST", "/v1/addresses", {
      token: tenant.token,
      body: {
        email,
        status: "active",
        verified: true,
        domain_id: domain.body.domain.id,
        provisioning_status: "ready",
        ...extra,
      },
    });
    await register("ready@policy.example");
    const allowed = await call(deps, "POST", "/v1/messages/send", {
      token: tenant.token,
      body: {
        from: "ready@policy.example",
        to: ["ok@example.net"],
        subject: "allowed",
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(allowed.status).toBe(202);
    expect(sent).toHaveLength(1);

    const memberEmail = `member-send-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(memberEmail, "sup3rsecret!", tenant.tenantId, "member");
    const memberLogin = await call(deps, "POST", "/v1/auth/login", {
      body: { email: memberEmail, password: "sup3rsecret!" },
    });
    const memberBypass = await call(deps, "POST", "/v1/messages/send", {
      token: memberLogin.body.session_token,
      body: {
        from: "ready@policy.example",
        to: ["member-target@example.net"],
        subject: "member cannot omit sender authorization",
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(memberBypass).toMatchObject({ status: 403, body: { reason: "send_key_required" } });
    expect(sent).toHaveLength(1);

    const ambiguousRecipient = await call(deps, "POST", "/v1/messages/send", {
      token: tenant.token,
      body: {
        from: "ready@policy.example",
        to: ["first@example.net, second@example.net"],
        subject: "ambiguous recipient",
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(ambiguousRecipient.status).toBe(400);
    expect(sent).toHaveLength(1);

    await call(deps, "POST", "/v1/contacts", {
      token: tenant.token,
      body: { email: "blocked@example.net", suppressed: true },
    });
    const suppressed = await call(deps, "POST", "/v1/messages/send", {
      token: tenant.token,
      body: {
        from: "ready@policy.example",
        to: ["Blocked User <blocked@example.net>"],
        subject: "blocked",
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(suppressed).toMatchObject({ status: 409, body: { reason: "recipient_suppressed", retry_safe: false } });
    expect(sent).toHaveLength(1);

    await register("quota@policy.example", { daily_quota: 0 });
    const quota = await call(deps, "POST", "/v1/messages/send", {
      token: tenant.token,
      body: {
        from: "quota@policy.example",
        to: ["ok2@example.net"],
        subject: "quota",
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(quota).toMatchObject({ status: 429, body: { reason: "address_quota_exceeded" } });
    expect(sent).toHaveLength(1);

    await register("unverified@policy.example", { verified: false });
    const unverified = await call(deps, "POST", "/v1/messages/send", {
      token: tenant.token,
      body: {
        from: "unverified@policy.example",
        to: ["ok3@example.net"],
        subject: "unverified",
        idempotency_key: crypto.randomUUID(),
      },
    });
    expect(unverified).toMatchObject({ status: 403, body: { reason: "sender_unverified" } });
    expect(sent).toHaveLength(1);
  });
});

describe.skipIf(!pgClient)("envelope-only inbound tenant routing", () => {
  it("splits tenants, ignores spoofed headers, deduplicates per tenant, and quarantines no-route events", async () => {
    const { deps } = makeDeps();
    const a = await makeTenant("inbound-route-a");
    const b = await makeTenant("inbound-route-b");
    const domainA = `route-a-${crypto.randomUUID()}.example`;
    const domainB = `route-b-${crypto.randomUUID()}.example`;
    await deps.store.forTenant(a.tenantId).createDomain({ domain: domainA, status: "active", verified: true });
    await deps.store.forTenant(b.tenantId).createDomain({ domain: domainB, status: "active", verified: true });
    const key = `inbound/${crypto.randomUUID()}`;
    const raw = Buffer.from([
      "From: attacker@external.example",
      "To: spoofed@unrouted.example",
      "Cc: other@unrouted.example",
      "Subject: envelope wins",
      "",
      "body",
    ].join("\r\n"));
    const result = await ingestS3Object(
      { store: deps.store, fetchObject: async () => raw, now: () => new Date().toISOString() },
      "test-bucket",
      key,
      { recipients: [`alpha@${domainA}`, `beta@${domainB}`] },
    );
    expect(result).toMatchObject({ status: "ingested", tenant_ids: [a.tenantId, b.tenantId] });
    expect((await deps.store.forTenant(a.tenantId).listMessages())[0]!.to_addrs).toEqual([`alpha@${domainA}`]);
    expect((await deps.store.forTenant(b.tenantId).listMessages())[0]!.to_addrs).toEqual([`beta@${domainB}`]);

    const rowsBeforeReplay = await pgClient!.many<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(messages) AS row FROM messages WHERE source_id = $1 ORDER BY tenant_id`,
      [key],
    );
    const sourcesBeforeReplay = await pgClient!.many<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(inbound_message_sources) AS row
       FROM inbound_message_sources WHERE bucket = $1 AND object_key = $2 ORDER BY tenant_id, message_id`,
      ["test-bucket", key],
    );
    const replayFetches: string[] = [];
    const replay = await ingestS3Object(
      {
        store: deps.store,
        fetchObject: async (bucket, objectKey) => { replayFetches.push(`${bucket}/${objectKey}`); return raw; },
        now: () => new Date().toISOString(),
      },
      "test-bucket",
      key,
      { recipients: [`alpha@${domainA}`, `beta@${domainB}`] },
    );
    expect(replay.status).toBe("duplicate");
    expect(replayFetches).toEqual([`test-bucket/${key}`]);
    expect(shouldDeleteIngestResult(replay)).toBe(true);
    expect(await pgClient!.many<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(messages) AS row FROM messages WHERE source_id = $1 ORDER BY tenant_id`,
      [key],
    )).toEqual(rowsBeforeReplay);
    expect(await pgClient!.many<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(inbound_message_sources) AS row
       FROM inbound_message_sources WHERE bucket = $1 AND object_key = $2 ORDER BY tenant_id, message_id`,
      ["test-bucket", key],
    )).toEqual(sourcesBeforeReplay);

    const mismatchFetches: string[] = [];
    const mismatch = await ingestS3Object(
      {
        store: deps.store,
        fetchObject: async (bucket, objectKey) => {
          mismatchFetches.push(`${bucket}/${objectKey}`);
          return Buffer.from("different canonical bytes");
        },
        now: () => new Date().toISOString(),
      },
      "test-bucket",
      key,
      { recipients: [`alpha@${domainA}`, `beta@${domainB}`] },
    );
    expect(mismatch).toMatchObject({ status: "error", reason: "provenance_hash_mismatch" });
    expect(mismatchFetches).toEqual([`test-bucket/${key}`]);
    expect(shouldDeleteIngestResult(mismatch)).toBe(false);
    expect(await pgClient!.many<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(messages) AS row FROM messages WHERE source_id = $1 ORDER BY tenant_id`,
      [key],
    )).toEqual(rowsBeforeReplay);
    expect(await pgClient!.many<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(inbound_message_sources) AS row
       FROM inbound_message_sources WHERE bucket = $1 AND object_key = $2 ORDER BY tenant_id, message_id`,
      ["test-bucket", key],
    )).toEqual(sourcesBeforeReplay);

    const quarantineKey = `inbound/${crypto.randomUUID()}`;
    const quarantined = await ingestS3Object(
      { store: deps.store, fetchObject: async () => { throw new Error("quarantine must not fetch"); }, now: () => new Date().toISOString() },
      "test-bucket",
      quarantineKey,
      { recipients: ["nobody@no-route.example"] },
    );
    expect(quarantined.status).toBe("quarantined");
    expect((await pgClient!.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM inbound_quarantine WHERE source_id = $1 AND reason = 'no_tenant_route'`,
      [quarantineKey],
    )).n).toBe(1);
  });

  it("atomically claims, rejects cross-tenant reassignment, releases, transfers, and suspends routes", async () => {
    const { deps } = makeDeps();
    const a = await makeTenant(`route-life-a-${crypto.randomUUID()}`);
    const b = await makeTenant(`route-life-b-${crypto.randomUUID()}`);
    const domain = `route-life-${crypto.randomUUID()}.example`;
    const claimed = await call(deps, "POST", "/v1/domains", {
      token: a.token,
      body: { domain, status: "active", verified: true },
    });
    expect(claimed.status).toBe(201);
    const pending = await call(deps, "POST", "/v1/domains", {
      token: b.token,
      body: { domain, status: "pending", verified: false },
    });
    expect(pending.status).toBe(201);
    const hijack = await call(deps, "PATCH", `/v1/domains/${pending.body.domain.id}`, {
      token: b.token,
      body: { status: "active", verified: true },
    });
    expect(hijack).toMatchObject({ status: 409, body: { reason: "inbound_route_conflict" } });

    expect((await call(deps, "DELETE", `/v1/domains/${claimed.body.domain.id}`, { token: a.token })).status).toBe(200);
    expect((await call(deps, "PATCH", `/v1/domains/${pending.body.domain.id}`, {
      token: b.token,
      body: { status: "active", verified: true },
    })).status).toBe(200);
    expect((await deps.store.resolveInboundRecipients([`mail@${domain}`])).groups).toEqual([
      { tenantId: b.tenantId, recipients: [`mail@${domain}`] },
    ]);

    await pgClient!.execute(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [b.tenantId]);
    expect(await deps.store.resolveInboundRecipients([`mail@${domain}`])).toMatchObject({ groups: [], unresolved: [`mail@${domain}`] });
    await pgClient!.execute(`UPDATE tenants SET status = 'active' WHERE id = $1`, [b.tenantId]);
    expect((await call(deps, "DELETE", `/v1/domains/${pending.body.domain.id}`, { token: b.token })).status).toBe(200);
    expect((await pgClient!.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM inbound_domain_routes WHERE domain = $1`, [domain],
    )).n).toBe(0);
  });
});

describe.skipIf(!pgClient)("Addendum A1: @hasna gate", () => {
  it("signup with a non-hasna email is a generic 403", async () => {
    const { deps } = makeDeps();
    const res = await call(deps, "POST", "/v1/auth/signup", {
      body: { email: "intruder@gmail.com", password: "sup3rsecret!", tenant_name: "Evil" },
    });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("email_not_allowed");
  });

  it("login with a non-hasna email is a generic 403", async () => {
    const { deps } = makeDeps();
    const res = await call(deps, "POST", "/v1/auth/login", { body: { email: "x@gmail.com", password: "whatever12" } });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("email_not_allowed");
  });

  it("owner cannot invite a non-hasna address", async () => {
    const { deps } = makeDeps();
    const t = await makeTenant("inv-gate");
    const ownerEmail = `owner-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(ownerEmail, "sup3rsecret!", t.tenantId, "owner");
    const login = await call(deps, "POST", "/v1/auth/login", { body: { email: ownerEmail, password: "sup3rsecret!" } });
    const session = login.body.session_token;
    const res = await call(deps, "POST", `/v1/tenants/${t.tenantId}/invites`, {
      token: session,
      body: { email: "outsider@gmail.com", role: "member" },
    });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("email_not_allowed");
  });
});

describe.skipIf(!pgClient)("Addendum A2: signup -> verify -> login (SES send mocked)", () => {
  it("creates an UNVERIFIED user, refuses login until the emailed token is consumed", async () => {
    const { deps, sent } = makeDeps();
    const email = `founder-${crypto.randomUUID()}@hasna.com`;
    const password = "sup3rsecret!";

    const signup = await call(deps, "POST", "/v1/auth/signup", { body: { email, password, tenant_name: "Acme" } });
    expect(signup.status).toBe(200);
    expect(signup.body.verification_required).toBe(true);
    // A confirmation email was sent through the (mocked) SES sender.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.subject.toLowerCase()).toContain("confirm");
    // The token is only in the link, never returned in the API response.
    expect(JSON.stringify(signup.body)).not.toContain("emev_");

    // Login before verification is refused.
    const early = await call(deps, "POST", "/v1/auth/login", { body: { email, password } });
    expect(early.status).toBe(403);
    expect(early.body.reason).toBe("email_unverified");

    // Consume the verification token (link is a GET).
    const token = lastToken(sent);
    expect(token.startsWith("emev_")).toBe(true);
    const verify = await call(deps, "GET", `/v1/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(verify.status).toBe(200);
    expect(verify.body.verified).toBe(true);

    // Login now succeeds and returns a session bound to the new tenant.
    const login = await call(deps, "POST", "/v1/auth/login", { body: { email, password } });
    expect(login.status).toBe(200);
    expect(login.body.session_token.startsWith("emss_")).toBe(true);
    expect(login.body.tenant.slug).toBe("acme");
    expect(login.body.role).toBe("owner");

    // The session authenticates data routes.
    const me = await call(deps, "GET", "/v1/me", { token: login.body.session_token });
    expect(me.body.principal_type).toBe("user");
    expect(me.body.user.email).toBe(email);

    // A used verification token cannot be replayed.
    const replay = await call(deps, "GET", `/v1/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(replay.status).toBe(400);
  });

  it("resend issues a fresh confirmation email for an unverified user", async () => {
    const { deps, sent } = makeDeps();
    const email = `resend-${crypto.randomUUID()}@hasna.com`;
    await call(deps, "POST", "/v1/auth/signup", { body: { email, password: "sup3rsecret!", tenant_name: "Re" } });
    expect(sent).toHaveLength(1);
    const resend = await call(deps, "POST", "/v1/auth/verify-email/resend", { body: { email } });
    expect(resend.status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("signup never leaks whether an email already exists (generic response)", async () => {
    const { deps } = makeDeps();
    const email = `dup-${crypto.randomUUID()}@hasna.com`;
    const first = await call(deps, "POST", "/v1/auth/signup", { body: { email, password: "sup3rsecret!", tenant_name: "Dup1" } });
    const second = await call(deps, "POST", "/v1/auth/signup", { body: { email, password: "sup3rsecret!", tenant_name: "Dup2" } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});

describe.skipIf(!pgClient)("multiple verified email identities", () => {
  it("resends verification for an unverified alias after failed delivery and token expiry", async () => {
    const { deps, sent } = makeDeps();
    const primary = `identity-resend-${crypto.randomUUID()}@hasna.com`;
    const alias = `identity-resend-alias-${crypto.randomUUID()}@hasna.com`;
    const password = "sup3rsecret!";

    const signup = await call(deps, "POST", "/v1/auth/signup", {
      body: { email: primary, password, tenant_name: `Identity Resend ${crypto.randomUUID()}` },
    });
    expect(signup.status).toBe(200);
    expect((await call(deps, "GET", `/v1/auth/verify-email?token=${encodeURIComponent(lastToken(sent))}`)).status).toBe(200);
    const login = await call(deps, "POST", "/v1/auth/login", { body: { email: primary, password } });
    expect(login.status).toBe(200);

    const originalSend = deps.sender.send;
    const sentBeforeAlias = sent.length;
    let added: Awaited<ReturnType<typeof call>>;
    try {
      deps.sender.send = async () => {
        throw new Error("simulated alias verification delivery failure");
      };
      added = await call(deps, "POST", "/v1/me/email-identities", {
        token: login.body.session_token,
        body: { email: alias },
      });
    } finally {
      deps.sender.send = originalSend;
    }
    expect(added!.status).toBe(201);
    expect(sent).toHaveLength(sentBeforeAlias);

    const firstResend = await call(deps, "POST", "/v1/auth/verify-email/resend", { body: { email: alias } });
    expect(firstResend.status).toBe(200);
    expect(sent).toHaveLength(sentBeforeAlias + 1);
    const expiredToken = lastToken(sent);
    await pgClient!.execute(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute' WHERE email = $1`,
      [alias],
    );
    expect((await call(deps, "GET", `/v1/auth/verify-email?token=${encodeURIComponent(expiredToken)}`)).status).toBe(400);

    const secondResend = await call(deps, "POST", "/v1/auth/verify-email/resend", { body: { email: alias } });
    expect(secondResend.status).toBe(200);
    expect(sent).toHaveLength(sentBeforeAlias + 2);
    const freshToken = lastToken(sent);
    expect(freshToken).not.toBe(expiredToken);
    expect((await call(deps, "GET", `/v1/auth/verify-email?token=${encodeURIComponent(freshToken)}`)).status).toBe(200);
  });

  it("adds and verifies an alias, logs in through it, makes it primary, and protects the primary identity", async () => {
    const { deps, sent } = makeDeps();
    const primary = `identity-${crypto.randomUUID()}@hasna.com`;
    const alias = `identity-alias-${crypto.randomUUID()}@hasna.com`;
    const password = "sup3rsecret!";
    const signup = await call(deps, "POST", "/v1/auth/signup", {
      body: { email: primary, password, tenant_name: `Identity ${crypto.randomUUID()}` },
    });
    expect(signup.status).toBe(200);
    await call(deps, "GET", `/v1/auth/verify-email?token=${encodeURIComponent(lastToken(sent))}`);
    const login = await call(deps, "POST", "/v1/auth/login", { body: { email: primary, password } });
    const session = login.body.session_token;

    const added = await call(deps, "POST", "/v1/me/email-identities", {
      token: session,
      body: { email: alias },
    });
    expect(added.status).toBe(201);
    const aliasId = added.body.email_identity.id;
    expect(added.body.verification_required).toBe(true);
    // An unverified alias cannot be used to log in even though the primary is verified.
    expect((await call(deps, "POST", "/v1/auth/login", { body: { email: alias, password } })).body.reason).toBe("email_unverified");

    const aliasToken = lastToken(sent);
    expect((await call(deps, "GET", `/v1/auth/verify-email?token=${encodeURIComponent(aliasToken)}`)).status).toBe(200);
    expect((await call(deps, "POST", "/v1/auth/login", { body: { email: alias, password } })).status).toBe(200);

    const madePrimary = await call(deps, "POST", `/v1/me/email-identities/${aliasId}/primary`, { token: session });
    expect(madePrimary.status).toBe(200);
    const me = await call(deps, "GET", "/v1/me", { token: session });
    expect(me.body.user.email).toBe(alias);
    expect(me.body.email_identities).toHaveLength(2);
    expect(me.body.email_identities.filter((item: any) => item.is_primary)).toEqual([
      expect.objectContaining({ id: aliasId, email: alias, verified: true }),
    ]);
    const cannotDelete = await call(deps, "DELETE", `/v1/me/email-identities/${aliasId}`, { token: session });
    expect(cannotDelete.status).toBe(409);
  });
});

describe.skipIf(!pgClient)("role gates", () => {
  it("a viewer is read-only (write routes -> 403 insufficient_scope)", async () => {
    const { deps } = makeDeps();
    const t = await makeTenant("role-view");
    const email = `viewer-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(email, "sup3rsecret!", t.tenantId, "viewer");
    const login = await call(deps, "POST", "/v1/auth/login", { body: { email, password: "sup3rsecret!" } });
    const session = login.body.session_token;
    // read allowed
    expect((await call(deps, "GET", "/v1/domains", { token: session })).status).toBe(200);
    // write denied
    const write = await call(deps, "POST", "/v1/domains", { token: session, body: { domain: "viewer.example" } });
    expect(write.status).toBe(403);
    expect(write.body.reason).toBe("insufficient_scope");
  });

  it("the last owner cannot be demoted or removed", async () => {
    const { deps } = makeDeps();
    const t = await makeTenant("last-owner");
    const email = `solo-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(email, "sup3rsecret!", t.tenantId, "owner");
    const login = await call(deps, "POST", "/v1/auth/login", { body: { email, password: "sup3rsecret!" } });
    const session = login.body.session_token;
    const members = await call(deps, "GET", `/v1/tenants/${t.tenantId}/members`, { token: session });
    const ownerMembership = members.body.members[0].id;
    const demote = await call(deps, "PATCH", `/v1/memberships/${ownerMembership}`, { token: session, body: { role: "member" } });
    expect(demote.status).toBe(409);
    expect(demote.body.reason).toBe("last_owner");
    const remove = await call(deps, "DELETE", `/v1/memberships/${ownerMembership}`, { token: session });
    expect(remove.status).toBe(409);
  });
});

describe.skipIf(!pgClient)("bootstrap-owner (api-key migration bridge)", () => {
  it("seeds the first owner once, then refuses", async () => {
    const { deps } = makeDeps();
    const t = await makeTenant("bootstrap");
    const email = `boot-${crypto.randomUUID()}@hasna.com`;
    const first = await call(deps, "POST", "/v1/auth/bootstrap-owner", { token: t.token, body: { email, password: "sup3rsecret!" } });
    expect(first.status).toBe(201);
    // Owner can now log in (bootstrap creates a VERIFIED user).
    const login = await call(deps, "POST", "/v1/auth/login", { body: { email, password: "sup3rsecret!" } });
    expect(login.status).toBe(200);
    // A second bootstrap on the same tenant is refused.
    const second = await call(deps, "POST", "/v1/auth/bootstrap-owner", { token: t.token, body: { email: `boot2-${crypto.randomUUID()}@hasna.com`, password: "sup3rsecret!" } });
    expect(second.status).toBe(409);
    expect(second.body.reason).toBe("owner_exists");
    // A session (non-key) cannot bootstrap.
    const viaSession = await call(deps, "POST", "/v1/auth/bootstrap-owner", { token: login.body.session_token, body: { email: `x-${crypto.randomUUID()}@hasna.com`, password: "sup3rsecret!" } });
    expect(viaSession.status).toBe(403);
  });
});

describe.skipIf(!pgClient)("primary super-admin bootstrap", () => {
  it("is pinned to one operator key, race-idempotent, singleton, and audit-safe", async () => {
    const { deps } = makeDeps();
    const tenant = await makeTenant("primary-super-admin");
    const body = { email: "andrei@hasna.com", password: "test-only-password-93", name: "Andrei" };
    deps.env = { ...process.env, EMAILS_PRIMARY_SUPER_ADMIN_EMAIL: "andrei@hasna.com" };
    const unpinned = await call(deps, "POST", "/v1/auth/bootstrap-super-admin", { token: tenant.token, body });
    expect(unpinned.status).toBe(503);
    expect(unpinned.body.reason).toBe("bootstrap_not_configured");

    deps.env = {
      ...deps.env,
      EMAILS_PRIMARY_SUPER_ADMIN_BOOTSTRAP_KID: tenant.kid,
    };
    const attacker = await makeTenant("primary-super-admin-attacker");
    const crossTenantKey = await call(deps, "POST", "/v1/auth/bootstrap-super-admin", {
      token: attacker.token,
      body,
    });
    expect(crossTenantKey.status).toBe(403);
    expect(crossTenantKey.body.reason).toBe("bootstrap_key_forbidden");

    const raced = await Promise.all([
      call(deps, "POST", "/v1/auth/bootstrap-super-admin", { token: tenant.token, body }),
      call(deps, "POST", "/v1/auth/bootstrap-super-admin", { token: tenant.token, body }),
    ]);
    expect(raced.map((result) => result.status).sort()).toEqual([200, 201]);
    const first = raced.find((result) => result.status === 201)!;
    expect(first.body.user).toMatchObject({
      email: "andrei@hasna.com",
      global_role: "super_admin",
      is_primary_super_admin: true,
    });
    expect(first.body.user).not.toHaveProperty("password_hash");

    const replay = await call(deps, "POST", "/v1/auth/bootstrap-super-admin", { token: tenant.token, body });
    expect(replay.status).toBe(200);
    expect(replay.body.created).toBe(false);
    expect(replay.body.user.id).toBe(first.body.user.id);

    const audit = await pgClient!.one<{ n: number; secrets: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE to_jsonb(admin_bootstrap_audit)::text ~* 'password|token|secret')::int AS secrets
       FROM admin_bootstrap_audit WHERE user_id = $1`,
      [first.body.user.id],
    );
    expect(audit).toEqual({ n: 1, secrets: 0 });

    const mismatch = await call(deps, "POST", "/v1/auth/bootstrap-super-admin", {
      token: tenant.token,
      body: { ...body, email: "someone-else@hasna.com" },
    });
    expect(mismatch.status).toBe(403);

    const login = await call(deps, "POST", "/v1/auth/login", {
      body: { email: "andrei@hasna.com", password: body.password },
    });
    const viaSession = await call(deps, "POST", "/v1/auth/bootstrap-super-admin", {
      token: login.body.session_token,
      body,
    });
    expect(viaSession.status).toBe(403);
  });
});

describe.skipIf(!pgClient)("password reset + invite flows (SES mocked)", () => {
  it("forgot -> reset revokes sessions and sets a new password", async () => {
    const { deps, sent } = makeDeps();
    const t = await makeTenant("reset-flow");
    const email = `reset-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(email, "oldpassword1", t.tenantId, "owner");

    const login = await call(deps, "POST", "/v1/auth/login", { body: { email, password: "oldpassword1" } });
    const oldSession = login.body.session_token;
    expect((await call(deps, "GET", "/v1/me", { token: oldSession })).status).toBe(200);

    const forgot = await call(deps, "POST", "/v1/auth/password/forgot", { body: { email } });
    expect(forgot.status).toBe(200);
    const resetToken = lastToken(sent);
    expect(resetToken.startsWith("emrt_")).toBe(true);

    const reset = await call(deps, "POST", "/v1/auth/password/reset", { body: { token: resetToken, new_password: "brandnewpass9" } });
    expect(reset.status).toBe(200);

    // Old session was revoked by the reset.
    expect((await call(deps, "GET", "/v1/me", { token: oldSession })).status).toBe(401);
    // Old password no longer works; new one does.
    expect((await call(deps, "POST", "/v1/auth/login", { body: { email, password: "oldpassword1" } })).status).toBe(401);
    expect((await call(deps, "POST", "/v1/auth/login", { body: { email, password: "brandnewpass9" } })).status).toBe(200);
  });

  it("invite -> accept creates the member and mints a session", async () => {
    const { deps, sent } = makeDeps();
    const t = await makeTenant("invite-flow");
    const ownerEmail = `own-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(ownerEmail, "sup3rsecret!", t.tenantId, "owner");
    const ownerLogin = await call(deps, "POST", "/v1/auth/login", { body: { email: ownerEmail, password: "sup3rsecret!" } });

    const inviteeEmail = `new-${crypto.randomUUID()}@hasna.com`;
    const invite = await call(deps, "POST", `/v1/tenants/${t.tenantId}/invites`, {
      token: ownerLogin.body.session_token,
      body: { email: inviteeEmail, role: "member" },
    });
    expect(invite.status).toBe(201);
    const inviteToken = lastToken(sent);
    expect(inviteToken.startsWith("emiv_")).toBe(true);

    const accept = await call(deps, "POST", "/v1/invites/accept", { body: { token: inviteToken, password: "inviteepass1" } });
    expect(accept.status).toBe(200);
    expect(accept.body.session_token.startsWith("emss_")).toBe(true);
    expect(accept.body.role).toBe("member");

    // The new member can authenticate.
    const me = await call(deps, "GET", "/v1/me", { token: accept.body.session_token });
    expect(me.body.user.email).toBe(inviteeEmail);
  });
});

describe.skipIf(!pgClient)("API keys can never manage humans / orgs (design §5.2/§5.3)", () => {
  it("an api key is rejected from key-mint, org-create, and member-list", async () => {
    const { deps } = makeDeps();
    const t = await makeTenant("machine-only");
    expect((await call(deps, "POST", "/v1/keys", { token: t.token, body: {} })).status).toBe(403);
    expect((await call(deps, "POST", "/v1/tenants", { token: t.token, body: { name: "New" } })).status).toBe(403);
    expect((await call(deps, "GET", `/v1/tenants/${t.tenantId}/members`, { token: t.token })).status).toBe(403);
  });
});

describe.skipIf(!pgClient)("session lifecycle", () => {
  it("logout revokes only the current session; switch-tenant requires membership", async () => {
    const { deps } = makeDeps();
    const t1 = await makeTenant("sess-t1");
    const email = `multi-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(email, "sup3rsecret!", t1.tenantId, "owner");

    const s1 = (await call(deps, "POST", "/v1/auth/login", { body: { email, password: "sup3rsecret!" } })).body.session_token;
    const s2 = (await call(deps, "POST", "/v1/auth/login", { body: { email, password: "sup3rsecret!" } })).body.session_token;
    // logout s1 only
    expect((await call(deps, "POST", "/v1/auth/logout", { token: s1 })).status).toBe(200);
    expect((await call(deps, "GET", "/v1/me", { token: s1 })).status).toBe(401);
    expect((await call(deps, "GET", "/v1/me", { token: s2 })).status).toBe(200);

    // switch-tenant to an org the user does NOT belong to -> 403
    const other = await makeTenant("sess-other");
    const otherTenant = await pgClient!.get<{ slug: string }>(`SELECT slug FROM tenants WHERE id = $1`, [other.tenantId]);
    const denied = await call(deps, "POST", "/v1/auth/switch-tenant", { token: s2, body: { tenant_slug: otherTenant!.slug } });
    expect(denied.status).toBe(403);
    expect(denied.body.reason).toBe("not_a_member");
  });
});

describe.skipIf(!pgClient)("RBAC hardening (adversarial review fixes)", () => {
  async function loginSession(deps: SelfHostedServiceDeps, email: string, password: string): Promise<string> {
    return (await call(deps, "POST", "/v1/auth/login", { body: { email, password } })).body.session_token;
  }
  async function membershipIdByEmail(deps: SelfHostedServiceDeps, session: string, tenantId: string, email: string): Promise<string> {
    const members = await call(deps, "GET", `/v1/tenants/${tenantId}/members`, { token: session });
    return members.body.members.find((m: any) => m.email === email).id;
  }

  it("H1: an admin cannot self-promote to owner, modify/remove an owner, or invite an owner", async () => {
    const { deps } = makeDeps();
    const t = await makeTenant("rbac-h1");
    const ownerEmail = `owner-${crypto.randomUUID()}@hasna.com`;
    const adminEmail = `admin-${crypto.randomUUID()}@hasna.com`;
    const memberEmail = `member-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(ownerEmail, "sup3rsecret!", t.tenantId, "owner");
    await createVerifiedUser(adminEmail, "sup3rsecret!", t.tenantId, "admin");
    await createVerifiedUser(memberEmail, "sup3rsecret!", t.tenantId, "member");

    const ownerSession = await loginSession(deps, ownerEmail, "sup3rsecret!");
    const adminSession = await loginSession(deps, adminEmail, "sup3rsecret!");
    const adminMembership = await membershipIdByEmail(deps, ownerSession, t.tenantId, adminEmail);
    const ownerMembership = await membershipIdByEmail(deps, ownerSession, t.tenantId, ownerEmail);
    const memberMembership = await membershipIdByEmail(deps, ownerSession, t.tenantId, memberEmail);

    // admin self-promote to owner -> 403
    expect((await call(deps, "PATCH", `/v1/memberships/${adminMembership}`, { token: adminSession, body: { role: "owner" } })).status).toBe(403);
    // admin demote the owner -> 403
    expect((await call(deps, "PATCH", `/v1/memberships/${ownerMembership}`, { token: adminSession, body: { role: "member" } })).status).toBe(403);
    // admin remove the owner -> 403
    expect((await call(deps, "DELETE", `/v1/memberships/${ownerMembership}`, { token: adminSession })).status).toBe(403);
    // admin invite a new owner -> 403
    expect((await call(deps, "POST", `/v1/tenants/${t.tenantId}/invites`, { token: adminSession, body: { email: `x-${crypto.randomUUID()}@hasna.com`, role: "owner" } })).status).toBe(403);
    // admin CAN promote a member to admin -> 200
    expect((await call(deps, "PATCH", `/v1/memberships/${memberMembership}`, { token: adminSession, body: { role: "admin" } })).status).toBe(200);
    // owner CAN promote the admin to owner -> 200
    expect((await call(deps, "PATCH", `/v1/memberships/${adminMembership}`, { token: ownerSession, body: { role: "owner" } })).status).toBe(200);
  });

  it("L2a: inviting an unsupported role (viewer) is a clean 400, not a 500", async () => {
    const { deps } = makeDeps();
    const t = await makeTenant("rbac-viewer-invite");
    const ownerEmail = `owner-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(ownerEmail, "sup3rsecret!", t.tenantId, "owner");
    const session = await loginSession(deps, ownerEmail, "sup3rsecret!");
    const res = await call(deps, "POST", `/v1/tenants/${t.tenantId}/invites`, { token: session, body: { email: `v-${crypto.randomUUID()}@hasna.com`, role: "viewer" } });
    expect(res.status).toBe(400);
  });

  it("M2: suspending a tenant locks out its API keys (not just sessions)", async () => {
    const { deps } = makeDeps();
    const t = await makeTenant("rbac-suspend");
    const ownerEmail = `owner-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(ownerEmail, "sup3rsecret!", t.tenantId, "owner");
    const session = await loginSession(deps, ownerEmail, "sup3rsecret!");

    // Before suspension, the api key works.
    expect((await call(deps, "GET", "/v1/domains", { token: t.token })).status).toBe(200);
    // Owner suspends (soft-delete) the tenant.
    expect((await call(deps, "DELETE", `/v1/tenants/${t.tenantId}`, { token: session })).status).toBe(200);
    // After suspension, BOTH the api key and the session are locked out.
    expect((await call(deps, "GET", "/v1/domains", { token: t.token })).status).toBe(403);
    expect((await call(deps, "GET", "/v1/domains", { token: session })).status).toBe(401);
  });
});

describe.skipIf(!pgClient)("tenant-scoped key issuance (WI-2e)", () => {
  it("an owner mints a tenant key that resolves back to the same tenant", async () => {
    const { deps } = makeDeps();
    // Use the real ApiKeyStore for this flow so issuance persists.
    const { ApiKeyStore } = await import("@hasna/contracts/auth");
    const realKeyStore = new ApiKeyStore(pgClient!);
    await realKeyStore.ensureSchema();
    const depsWithKeys: SelfHostedServiceDeps = { ...deps, keyStore: realKeyStore };

    const t = await makeTenant("key-mint");
    const email = `admin-${crypto.randomUUID()}@hasna.com`;
    await createVerifiedUser(email, "sup3rsecret!", t.tenantId, "owner");
    const login = await call(depsWithKeys, "POST", "/v1/auth/login", { body: { email, password: "sup3rsecret!" } });
    const session = login.body.session_token;

    const created = await call(depsWithKeys, "POST", "/v1/keys", { token: session, body: { scopes: ["emails:read"] } });
    expect(created.status).toBe(201);
    expect(created.body.token.startsWith("hasna_")).toBe(true);

    // The minted key resolves to this tenant and can read.
    const asKey = await call(depsWithKeys, "GET", "/v1/me", { token: created.body.token });
    expect(asKey.body.principal_type).toBe("apikey");
    expect(asKey.body.tenant.id).toBe(t.tenantId);

    // It appears in the tenant's key list and can be revoked.
    const list = await call(depsWithKeys, "GET", "/v1/keys", { token: session });
    expect(list.body.keys.some((k: any) => k.kid === created.body.kid)).toBe(true);
    const revoke = await call(depsWithKeys, "DELETE", `/v1/keys/${created.body.kid}`, { token: session });
    expect(revoke.status).toBe(200);
  });
});
