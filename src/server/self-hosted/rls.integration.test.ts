// Row-Level Security isolation proof (design §6 Layer 2, migration 0013).
//
// Layer 1 (the typed scoped store) is proven in multi-tenancy.integration.test.ts.
// THIS file proves Layer 2 — the Postgres backstop — at the DB layer, exactly as
// it behaves in production:
//
//   * The prod serving role `emails_app` is NOSUPERUSER, NOBYPASSRLS, and OWNS the
//     tables. A table owner bypasses RLS UNLESS `FORCE ROW LEVEL SECURITY` is set;
//     FORCE is honored only because the owner is non-superuser/non-bypassrls. So we
//     reparent the tables under test to a purpose-built NOBYPASSRLS role and run
//     every assertion as that role — a faithful stand-in for `emails_app`.
//   * Fail-closed: with NO `app.current_tenant` GUC set, zero rows are visible.
//   * Isolation: with the GUC set to tenant A, only A's rows are visible; B's rows
//     are invisible across representative tables (hand-written + generic + composite).
//   * Cross-tenant WRITE is rejected at the DB layer even if a handler forgot Layer 1
//     (a USING-only policy also governs INSERT/UPDATE via the default WITH CHECK).
//   * FORCE is load-bearing: with FORCE off, the owner sees everything again.
//
// Gated on EMAILS_TEST_POSTGRES_URL (an ephemeral Postgres). The connecting role
// is a superuser (it seeds + reparents); the ASSERTIONS run under SET LOCAL ROLE to
// the NOBYPASSRLS probe, so the superuser's own RLS bypass never masks a leak.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPgPool, createQueryClient, MigrationLedger } from "../../storage-kit/index.js";
import type { PoolQueryClient, TypedQueryClient } from "../../storage-kit/index.js";
import { DEFAULT_TENANT_ID, emailsSelfHostedMigrations } from "./migrations.js";
import { assertServingRoleCannotBypassRls } from "./serve.js";

const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pg: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

const PROBE = "emails_rls_probe";
const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
// Representative of every access shape: hand-written domains/messages, a generic
// registry resource (contacts), and the composite-PK resource (email_agent_settings).
const TABLES = ["domains", "contacts", "messages", "email_agent_settings"] as const;

/** Run `fn` in one transaction AS the NOBYPASSRLS probe, optionally with the tenant GUC set. */
async function asProbe<T>(tenantId: string | null, fn: (tx: TypedQueryClient) => Promise<T>): Promise<T> {
  return pg!.transaction(async (tx) => {
    await tx.execute(`SET LOCAL ROLE ${PROBE}`);
    if (tenantId !== null) await tx.execute(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    return fn(tx);
  });
}

async function countAsProbe(tenantId: string | null, table: string): Promise<number> {
  return asProbe(tenantId, async (tx) => (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).n);
}

beforeAll(async () => {
  if (!pg) return;
  // Fresh schema (drops any table a crashed prior run left owned by the probe),
  // then the probe role can be dropped cleanly and recreated.
  await pg.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await pg.execute("CREATE SCHEMA public");
  await pg.execute(`DROP ROLE IF EXISTS ${PROBE}`);
  await new MigrationLedger(pg, emailsSelfHostedMigrations()).migrate();

  // Seed two tenants + one row each in every representative table (as the
  // superuser, which bypasses RLS — seeding is not what we are testing).
  await pg.execute(
    `INSERT INTO tenants (id, slug, name) VALUES ($1,'rls-a','A'), ($2,'rls-b','B')`,
    [TENANT_A, TENANT_B],
  );
  await pg.execute(
    `INSERT INTO domains (id, domain, tenant_id) VALUES ('dom-a','a.example',$1), ('dom-b','b.example',$2)`,
    [TENANT_A, TENANT_B],
  );
  await pg.execute(
    `INSERT INTO contacts (id, email, tenant_id) VALUES ('con-a','a@a.example',$1), ('con-b','b@b.example',$2)`,
    [TENANT_A, TENANT_B],
  );
  await pg.execute(
    `INSERT INTO messages (id, from_addr, tenant_id) VALUES ('msg-a','from@a.example',$1), ('msg-b','from@b.example',$2)`,
    [TENANT_A, TENANT_B],
  );
  await pg.execute(
    `INSERT INTO email_agent_settings (tenant_id, agent_key, model) VALUES ($1,'labeler','m'), ($2,'labeler','m')`,
    [TENANT_A, TENANT_B],
  );

  // The prod-faithful part: make a NOBYPASSRLS role the OWNER of the tables under
  // test, so FORCE ROW LEVEL SECURITY (set by 0013) actually constrains it. A
  // non-superuser needs USAGE on the schema to resolve unqualified names.
  await pg.execute(`CREATE ROLE ${PROBE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await pg.execute(`GRANT USAGE ON SCHEMA public TO ${PROBE}`);
  for (const t of TABLES) await pg.execute(`ALTER TABLE ${t} OWNER TO ${PROBE}`);
});

afterAll(async () => {
  if (!pg) return;
  // DROP SCHEMA removes the probe-owned tables so the role can be dropped.
  await pg.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await pg.execute("CREATE SCHEMA public");
  await pg.execute(`DROP ROLE IF EXISTS ${PROBE}`);
  await pg.close();
});

describe.skipIf(!pg)("Row-Level Security backstop (Layer 2, migration 0013)", () => {
  it("fails closed: with NO app.current_tenant GUC, the NOBYPASSRLS role sees zero rows", async () => {
    for (const t of TABLES) {
      expect(await countAsProbe(null, t), `${t} with unset GUC`).toBe(0);
    }
    // The explicit empty-string path (NULLIF(...,'')::uuid) must ALSO be zero.
    for (const t of TABLES) {
      const n = await asProbe("", async (tx) => (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).n);
      expect(n, `${t} with empty GUC`).toBe(0);
    }
  });

  it("isolates by tenant: GUC=A shows only A's rows; B's rows are invisible", async () => {
    for (const t of TABLES) {
      expect(await countAsProbe(TENANT_A, t), `${t} visible to A`).toBe(1);
    }
    // Content is A's, never B's.
    const domains = await asProbe(TENANT_A, (tx) => tx.many<{ id: string; domain: string }>(`SELECT id, domain FROM domains`));
    expect(domains).toEqual([{ id: "dom-a", domain: "a.example" }]);
    // A cannot see B's specific row by id (the cross-tenant read is blocked).
    const bDomain = await asProbe(TENANT_A, (tx) => tx.get<{ id: string }>(`SELECT id FROM domains WHERE id = 'dom-b'`));
    expect(bDomain).toBeNull();
    const bContact = await asProbe(TENANT_A, (tx) => tx.get<{ id: string }>(`SELECT id FROM contacts WHERE id = 'con-b'`));
    expect(bContact).toBeNull();
  });

  it("blocks a cross-tenant WRITE at the DB layer even if Layer 1 were forgotten", async () => {
    // INSERT stamped with tenant B while scoped to A -> WITH CHECK (default = USING)
    // rejects. Match the RLS error specifically so a stray missing-table/permission
    // error could never masquerade as a passing assertion.
    const rls = /row-level security policy/i;
    await expect(
      asProbe(TENANT_A, (tx) =>
        tx.execute(`INSERT INTO domains (id, domain, tenant_id) VALUES ('dom-x','x.example',$1)`, [TENANT_B]),
      ),
    ).rejects.toThrow(rls);
    await expect(
      asProbe(TENANT_A, (tx) =>
        tx.execute(`INSERT INTO messages (id, from_addr, tenant_id) VALUES ('msg-x','from@x.example',$1)`, [TENANT_B]),
      ),
    ).rejects.toThrow(rls);
    // Re-homing an OWN row into tenant B (visible via USING, but WITH CHECK rejects the new tenant).
    await expect(
      asProbe(TENANT_A, (tx) =>
        tx.execute(`UPDATE domains SET tenant_id = $1 WHERE id = 'dom-a'`, [TENANT_B]),
      ),
    ).rejects.toThrow(rls);
    // Nothing leaked: B still owns exactly its original row (checked as superuser).
    const bCount = await pg!.one<{ n: number }>(`SELECT count(*)::int AS n FROM domains WHERE tenant_id = $1`, [TENANT_B]);
    expect(bCount.n).toBe(1);
  });

  it("allows an in-tenant WRITE (GUC=A, tenant_id=A) — the policy is not a blanket deny", async () => {
    await asProbe(TENANT_A, (tx) =>
      tx.execute(`INSERT INTO domains (id, domain, tenant_id) VALUES ('dom-a2','a2.example',$1)`, [TENANT_A]),
    );
    expect(await countAsProbe(TENANT_A, "domains")).toBe(2);
    // 0016 seals the schema: omitting tenant_id can no longer silently write to
    // the former default tenant, even when the GUC itself is set.
    await expect(
      asProbe(DEFAULT_TENANT_ID, (tx) =>
        tx.execute(`INSERT INTO domains (id, domain) VALUES ('dom-def','def.example')`),
      ),
    ).rejects.toThrow(/row-level security|not-null/i);
    expect(await countAsProbe(DEFAULT_TENANT_ID, "domains")).toBe(0);
  });

  it("worker path: a resolved-tenant message upsert on the composite conflict target works under RLS", async () => {
    // Mirrors TenantScopedStore.upsertMessage after envelope routing: the worker
    // resolves the tenant first, sets the same tenant GUC, explicitly stamps
    // tenant_id, and conflicts on (tenant_id, source_id).
    const upsert = (tx: TypedQueryClient) =>
      tx.one<{ inserted: boolean }>(
        `INSERT INTO messages (id, from_addr, source_id, tenant_id)
         VALUES ($1, 'ingest@x.example', 'obj-key-1', $2)
         ON CONFLICT (tenant_id, source_id) WHERE source_id IS NOT NULL
         DO UPDATE SET updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [crypto.randomUUID(), TENANT_A],
      );
    const first = await asProbe(TENANT_A, upsert);
    expect(first.inserted, "first upsert inserts").toBe(true);
    const second = await asProbe(TENANT_A, upsert);
    expect(second.inserted, "re-delivery updates in place (idempotent)").toBe(false);
    // The upserted row landed only in tenant A and is invisible to tenant B.
    expect(
      await asProbe(TENANT_B, (tx) => tx.get<{ id: string }>(`SELECT id FROM messages WHERE source_id = 'obj-key-1'`)),
    ).toBeNull();
  });

  it("boot assertion: rejects a role that can bypass RLS, accepts one that cannot", async () => {
    // The connecting role is a superuser (rolsuper) -> must be refused.
    await expect(assertServingRoleCannotBypassRls(pg!)).rejects.toThrow(/bypass Row-Level Security/i);
    // A client whose effective role is the NOBYPASSRLS probe -> must be accepted.
    const asProbeClient: TypedQueryClient = {
      query: (sql, p) => asProbe(null, (tx) => tx.query(sql, p)),
      many: (sql, p) => asProbe(null, (tx) => tx.many(sql, p)),
      get: (sql, p) => asProbe(null, (tx) => tx.get(sql, p)),
      one: (sql, p) => asProbe(null, (tx) => tx.one(sql, p)),
      execute: (sql, p) => asProbe(null, (tx) => tx.execute(sql, p)),
    };
    await expect(assertServingRoleCannotBypassRls(asProbeClient)).resolves.toBeUndefined();
  });

  it("FORCE is load-bearing: without FORCE the owner bypasses RLS (proving FORCE is what enforces it)", async () => {
    // With FORCE (0013) + no GUC, the owner sees nothing.
    expect(await countAsProbe(null, "contacts")).toBe(0);
    // Drop FORCE (as superuser): the owner now bypasses RLS and sees ALL tenants.
    await pg!.execute("ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY");
    try {
      const all = await countAsProbe(null, "contacts");
      expect(all, "owner bypasses RLS when NOT forced").toBeGreaterThanOrEqual(2);
    } finally {
      await pg!.execute("ALTER TABLE contacts FORCE ROW LEVEL SECURITY");
    }
    // Restored: the owner is constrained again.
    expect(await countAsProbe(null, "contacts")).toBe(0);
  });

  it("every one of the 27 tenant tables is RLS-enabled + FORCEd with a tenant policy", async () => {
    // Guards the hand-maintained table list in migration 0013: a dropped/misspelled
    // entry would leave a table un-forced (a silent hole) with no other failing test.
    const ALL_TENANT_TABLES = [
      "domains", "addresses", "messages", "contacts", "self_hosted_providers", "templates",
      "contact_groups", "sequences", "owners", "send_keys", "scheduled_emails", "aliases",
      "forwarding_rules", "warming_schedules", "email_triage", "provisioning_events",
      "mailbox_sources", "events", "email_agent_settings", "email_agent_runs", "email_digests",
      "group_members", "sequence_steps", "sequence_enrollments", "address_ownership_events",
      "webhook_receipts", "sandbox_emails",
    ];
    const flags = await pg!.many<{ relname: string; en: boolean; force: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS en, c.relforcerowsecurity AS force
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [ALL_TENANT_TABLES],
    );
    const notForced = ALL_TENANT_TABLES.filter((t) => {
      const f = flags.find((r) => r.relname === t);
      return !f || !f.en || !f.force;
    });
    expect(notForced, "tables not RLS-enabled+forced").toEqual([]);

    const pols = await pg!.many<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [ALL_TENANT_TABLES],
    );
    const noPolicy = ALL_TENANT_TABLES.filter((t) => !pols.find((p) => p.tablename === t));
    expect(noPolicy, "tables without a tenant policy").toEqual([]);
    expect(ALL_TENANT_TABLES).toHaveLength(27);
  });

  it("migration 0013 is internally idempotent: re-executing its SQL is a clean no-op", async () => {
    // The ledger skips already-applied ids, so this proves the migration BODY itself
    // (DROP POLICY IF EXISTS + CREATE, DROP INDEX IF EXISTS, ENABLE/FORCE) re-applies
    // without error and leaves RLS enabled — the "drift-aware, safe to re-run" claim.
    const rls0013 = emailsSelfHostedMigrations().find((m) => m.id === "0013_emails_tenancy_rls_and_seal")!;
    await pg!.execute(rls0013.sql);
    await pg!.execute(rls0013.sql);
    const domains = await pg!.one<{ en: boolean; force: boolean }>(
      `SELECT c.relrowsecurity AS en, c.relforcerowsecurity AS force
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'domains'`,
    );
    expect(domains.en && domains.force).toBe(true);
    // Isolation still holds after the re-run: the probe under GUC=A sees exactly
    // A's domains (whatever prior tests seeded), and none of B's.
    const aCount = (await pg!.one<{ n: number }>(`SELECT count(*)::int AS n FROM domains WHERE tenant_id = $1`, [TENANT_A])).n;
    expect(await countAsProbe(TENANT_A, "domains")).toBe(aCount);
    expect(aCount).toBeGreaterThanOrEqual(1);
  });
});
