import { existsSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "bun:test";
import { createPgPool, createQueryClient, MigrationLedger } from "../../storage-kit/index.js";
import { DEFAULT_TENANT_ID, emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore, type TenantScopedStore } from "./store.js";
import { resourceSpecForPath, SELF_HOSTED_RESOURCES } from "./resources.js";

const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const client = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

// Ground-truth prod schema dump (pg_dump --schema-only), used as the highest-
// fidelity drift fixture when present. It is a gitignored local artifact, so the
// real-dump test is additionally gated on its presence (the self-contained test
// below reproduces every drift class for CI without it).
const prodDumpPath = `${import.meta.dir}/../../../.prod-full-schema.sql`;
const hasProdDump = existsSync(prodDumpPath);

/** Make a plain pg_dump loadable via node-pg (which is not psql). */
function loadableDump(sql: string): string {
  return sql
    // Strip psql meta-commands pg_dump 16.4+ emits (\restrict / \unrestrict).
    .split("\n")
    .filter((line) => !line.startsWith("\\restrict") && !line.startsWith("\\unrestrict"))
    .join("\n")
    // The dump resets search_path to '' for the session; keep it 'public' so the
    // migrations' unqualified DDL still resolves on a pooled connection.
    .replace(
      "SELECT pg_catalog.set_config('search_path', '', false);",
      "SELECT pg_catalog.set_config('search_path', 'public', false);",
    );
}

afterAll(async () => { await client?.close(); });

// The two "0012" tests below assert 0012's TRANSITIONAL end-state (the legacy
// single-column uniques are retained; RLS is not yet on), so they migrate only
// THROUGH 0012 — migration 0013 (which drops those uniques and enables RLS) has
// its own dedicated coverage in rls.integration.test.ts.
const TENANCY_MIGRATION_ID = "0012_emails_tenancy_identity_and_backfill";
const RLS_MIGRATION_ID = "0013_emails_tenancy_rls_and_seal";
const migrationsBefore0012 = () => {
  const all = emailsSelfHostedMigrations();
  const tenancyIndex = all.findIndex((migration) => migration.id === TENANCY_MIGRATION_ID);
  if (tenancyIndex < 0) throw new Error(`Missing migration ${TENANCY_MIGRATION_ID}`);
  return all.slice(0, tenancyIndex);
};
const migrationsThrough0012 = () => {
  const all = emailsSelfHostedMigrations();
  const tenancyIndex = all.findIndex((migration) => migration.id === TENANCY_MIGRATION_ID);
  if (tenancyIndex < 0) throw new Error(`Missing migration ${TENANCY_MIGRATION_ID}`);
  return all.slice(0, tenancyIndex + 1);
};

async function resetPublicSchema(): Promise<void> {
  await client!.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await client!.execute("CREATE SCHEMA public");
}

async function columnType(table: string, column: string): Promise<string | null> {
  const row = await client!.get<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return row?.data_type ?? null;
}

/**
 * The writes the self-hosted server actually makes, one per drift class, each
 * chosen to stress a reconcile: legacy CHECK enums (provider='external',
 * mode='redirect', new triage/digest/event/source enums), dropped legacy FKs
 * (ids that live in messages / self_hosted_providers / are external), relaxed
 * NOT NULL (domains/addresses provider_id, send_keys key_hash, in-progress
 * agent runs), added columns (updated_at, group_members.id), restored defaults
 * (omitted since/until/subject/type/target_daily_volume), and jsonb->text.
 * Returns [] on success or a list of "resource: error" strings.
 */
async function serverWriteFailures(store: TenantScopedStore): Promise<string[]> {
  const R = (p: string) => resourceSpecForPath(p)!;
  const uid = () => crypto.randomUUID();
  const fails: string[] = [];
  const attempt = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { fails.push(`${name}: ${(e as Error).message.split("\n")[0]}`); }
  };

  await attempt("domains.create", () => store.createDomain({ domain: `d-${uid()}.com` }));
  await attempt("addresses.create", () => store.createAddress({ email: `a-${uid()}@x.com` }));
  await attempt("email-agents provider=external", () =>
    store.updateResource(R("email-agents"), "labeler", { provider: "external", enabled: true }));
  await attempt("email-agent-runs in-progress (FK/started/checks)", () =>
    store.createResource(R("email-agent-runs"), {
      agent_key: "labeler", inbound_email_id: "in1", provider: "external", model: "m",
      status: "running", priority: 9, risk_score: 250, labels_json: ["x"], tool_calls_json: [], output_json: {},
    }));
  await attempt("email-digests omit since/until/started/completed", () =>
    store.createResource(R("email-digests"), {
      period: "today", provider: "external", model: "m", status: "ok", message_count: 0,
    }));
  await attempt("triage custom label", () =>
    store.createResource(R("triage"), { email_id: "e1", label: "needs-decision", priority: 3, sentiment: "mixed" }));
  await attempt("forwarding mode=redirect", () =>
    store.createResource(R("forwarding"), { source_address: "s@x.com", target_address: "t@x.com", mode: "redirect", enabled: true }));
  await attempt("events type=processed (metadata jsonb->text, FK)", () =>
    store.createResource(R("events"), { provider_id: "ses", type: "processed", recipient: "r@x.com", metadata: { k: "v" } }));
  await attempt("sources type=imap (checks/FK/json)", () =>
    store.createResource(R("sources"), { mailbox_id: "mb1", provider_id: "p", type: "imap", name: "n", status: "paused", settings_json: { a: 1 }, provider_snapshot_json: { b: 2 } }));
  await attempt("warming omit start_date/volume", () =>
    store.createResource(R("warming"), { domain: `w-${uid()}.com`, status: "warming" }));
  await attempt("scheduled omit from/provider/scheduled_at/subject", () =>
    store.createResource(R("scheduled"), { to_addresses: ["a@x.com"], status: "queued" }));
  await attempt("sequences status=draft", () =>
    store.createResource(R("sequences"), { name: `seq-${uid()}`, status: "draft" }));
  await attempt("sequence-enrollments (FK/timestamps)", () =>
    store.createResource(R("sequence-enrollments"), { sequence_id: "s1", contact_email: "c@x.com", current_step: 0, status: "paused" }));
  await attempt("sequence-steps omit step_number/template_name", () =>
    store.createResource(R("sequence-steps"), { sequence_id: "s1" }));
  await attempt("sandbox-emails omit subject", () =>
    store.createResource(R("sandbox-emails"), { provider_id: "sandbox", from_address: "s@x.com", to_addresses: ["a@x.com"], cc_addresses: [], bcc_addresses: [], attachments_json: "[]", headers_json: "{}" }));
  await attempt("provisioning detail_json (jsonb->text)", () =>
    store.createResource(R("provisioning"), { entity_type: "domain", entity_id: "d1", to_state: "active", detail_json: { x: 1 } }));
  await attempt("send-keys mint/verify (key_hash/updated_at)", async () => {
    const { token, key } = await store.mintSendKey({ owner_id: "o1", label: "k" });
    const verified = await store.verifySendKey(token);
    if (!verified || verified.id !== key.id) throw new Error("verify failed");
  });
  await attempt("templates omit subject_template", () =>
    store.createResource(R("templates"), { name: `tpl-${uid()}` }));
  await attempt("owners omit type", () =>
    store.createResource(R("owners"), { name: `Owner ${uid()}` }));
  await attempt("aliases omit target_address", () =>
    store.createResource(R("aliases"), { domain: `al-${uid()}.com`, local_part: "info" }));
  await attempt("group-members create+get (id/updated_at)", async () => {
    const gm = await store.createResource(R("group-members"), { group_id: "g1", email: `gm-${uid()}@x.com`, name: "G", vars: JSON.stringify({ t: 1 }) });
    const got = await store.getResource(R("group-members"), String(gm["id"]));
    if (!got) throw new Error("get by minted id failed");
    await store.updateResource(R("group-members"), String(gm["id"]), { name: "G2" });
  });
  await attempt("messages.create", () =>
    store.createMessage({ from_addr: "f@x.com", to_addrs: ["t@x.com"], subject: "s", direction: "outbound" }));

  return fails;
}

describe("self-hosted Postgres integration", () => {
  it.skipIf(!client)("migrates dirty text legacy rows and enforces durable send idempotency", async () => {
    await resetPublicSchema();
    await client!.execute(`
      CREATE TABLE inbound_emails (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        text_body TEXT,
        html_body TEXT,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        provider_message_id TEXT,
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        sent_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO inbound_emails (
        id, message_id, from_address, to_addresses, cc_addresses, subject,
        text_body, html_body, received_at, created_at
      ) VALUES (
        'in-dirty', 's3-key-dirty', 'sender@example.com', 'not-json', '{bad',
        'legacy inbound', 'plain', '<p>html</p>', 'not-a-date', 'also-not-a-date'
      );
      INSERT INTO emails (
        id, provider_message_id, from_address, to_addresses, cc_addresses,
        subject, status, sent_at, created_at, updated_at
      ) VALUES (
        'sent-dirty', 'provider-dirty', 'sender@example.com', 'not-json', '{bad',
        'legacy sent', 'sent', 'not-a-date', 'also-not-a-date', 'still-not-a-date'
      );
    `);

    const ledger = new MigrationLedger(client!, emailsSelfHostedMigrations());
    await ledger.migrate();
    const applied = await ledger.listApplied();
    expect(applied.map((row) => row.id)).toContain("0006b_emails_legacy_messages_backfill_prep");
    expect(applied.map((row) => row.id)).toContain("0006_emails_rename_bridge");
    expect(applied.map((row) => row.id)).toContain("0008_emails_legacy_messages_backfill_dedupe");

    const legacyRows = await client!.many<{ id: string; direction: string; subject: string | null }>(
      "SELECT id, direction, subject FROM messages WHERE id IN ($1, $2) ORDER BY id",
      ["legacy-inbound:in-dirty", "legacy-sent:sent-dirty"],
    );
    expect(legacyRows).toEqual([
      { id: "legacy-inbound:in-dirty", direction: "inbound", subject: "legacy inbound" },
      { id: "legacy-sent:sent-dirty", direction: "outbound", subject: "legacy sent" },
    ]);

    const store = new EmailsSelfHostedStore(client!).forTenant(DEFAULT_TENANT_ID);
    const key = `ci-${crypto.randomUUID()}`;
    const input = {
      from_addr: "sender@example.com",
      to_addrs: ["recipient@example.com"],
      subject: "integration",
      idempotency_key: key,
      send_payload_hash: "sha256-integration",
    };
    const first = await store.reserveSendIntent(input);
    const duplicate = await store.reserveSendIntent(input);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.id).toBe(first.record.id);
    const claimed = await store.claimSendIntent(first.record.id);
    expect(claimed?.send_state).toBe("sending");
    expect((await store.completeSendIntent(first.record.id, "provider-ci")).send_state).toBe("sent");
  });

  it.skipIf(!client)("migrates typed timestamp legacy rows without text-assignment failures", async () => {
    await resetPublicSchema();
    await client!.execute(`
      CREATE TABLE inbound_emails (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        text_body TEXT,
        html_body TEXT,
        received_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        provider_message_id TEXT,
        from_address TEXT NOT NULL,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        sent_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO inbound_emails (
        id, message_id, from_address, to_addresses, cc_addresses, subject,
        text_body, html_body, received_at, created_at
      ) VALUES (
        'in-typed', 's3-key-typed', 'typed@example.com', '["to@example.com"]', '[]',
        'typed inbound', 'plain', '<p>html</p>', '2026-07-12T12:00:00Z', '2026-07-12T12:00:01Z'
      );
      INSERT INTO emails (
        id, provider_message_id, from_address, to_addresses, cc_addresses,
        subject, status, sent_at, created_at, updated_at
      ) VALUES (
        'sent-typed', 'provider-typed', 'typed@example.com', '["to@example.com"]', '[]',
        'typed sent', 'sent', '2026-07-12T12:01:00Z', '2026-07-12T12:01:01Z', '2026-07-12T12:01:02Z'
      );
    `);

    const ledger = new MigrationLedger(client!, emailsSelfHostedMigrations());
    await ledger.migrate();

    const legacyRows = await client!.many<{ id: string; direction: string; subject: string | null }>(
      "SELECT id, direction, subject FROM messages WHERE id IN ($1, $2) ORDER BY id",
      ["legacy-inbound:in-typed", "legacy-sent:sent-typed"],
    );
    expect(legacyRows).toEqual([
      { id: "legacy-inbound:in-typed", direction: "inbound", subject: "typed inbound" },
      { id: "legacy-sent:sent-typed", direction: "outbound", subject: "typed sent" },
    ]);
  });

  it.skipIf(!client)("round-2 parity: new generic resources round-trip through real jsonb", async () => {
    await resetPublicSchema();
    await new MigrationLedger(client!, emailsSelfHostedMigrations()).migrate();
    const store = new EmailsSelfHostedStore(client!).forTenant(DEFAULT_TENANT_ID);

    // group-members: the client pre-serializes `vars`; confirm it round-trips
    // through a real jsonb column + node-pg (the crux of the double-encode path).
    const gmSpec = resourceSpecForPath("group-members")!;
    const gm = await store.createResource(gmSpec, {
      group_id: "g1", email: "a@x.com", name: "Ada",
      vars: JSON.stringify({ team: "eng" }), added_at: "2026-07-13T00:00:00.000Z",
    });
    expect(typeof gm["id"]).toBe("string");
    expect(JSON.parse(String(gm["vars"]))).toEqual({ team: "eng" });
    const gmList = await store.listResource(gmSpec, { filters: { group_id: "g1" } });
    expect(gmList).toHaveLength(1);

    // sandbox-emails: raw arrays store native; pre-serialized json round-trips.
    const sbSpec = resourceSpecForPath("sandbox-emails")!;
    const sb = await store.createResource(sbSpec, {
      provider_id: "sandbox", from_address: "s@x.com",
      to_addresses: ["a@x.com"], cc_addresses: [], bcc_addresses: [],
      reply_to: null, subject: "Hi", html: "<p>hi</p>", text_body: "hi",
      attachments_json: JSON.stringify([{ filename: "a.txt" }]),
      headers_json: JSON.stringify({ "X-Test": "1" }),
      created_at: "2026-07-13T00:00:00.000Z",
    });
    expect(sb["to_addresses"]).toEqual(["a@x.com"]);
    expect(JSON.parse(String(sb["attachments_json"]))).toEqual([{ filename: "a.txt" }]);
    expect(JSON.parse(String(sb["headers_json"]))).toEqual({ "X-Test": "1" });

    // address-ownership-events: the client-minted id must be honored (idColumn).
    const aoSpec = resourceSpecForPath("address-ownership-events")!;
    const eventId = `evt-${crypto.randomUUID()}`;
    const created = await store.createResource(aoSpec, {
      id: eventId, address_id: "a1", action: "assign", previous_owner_id: null,
      previous_administrator_id: null, owner_id: "o1", administrator_id: "ag1",
      actor: "cli", reason: null, created_at: "2026-07-13T00:00:00.000Z",
    });
    expect(created["id"]).toBe(eventId);
    const fetched = await store.getResource(aoSpec, eventId);
    expect(fetched?.["owner_id"]).toBe("o1");

    // sequence steps + enrollments + webhook receipts persist and list.
    const stepSpec = resourceSpecForPath("sequence-steps")!;
    const step = await store.createResource(stepSpec, { sequence_id: "s1", step_number: 1, delay_hours: 24, template_name: "t" });
    expect(step["step_number"]).toBe(1);
    expect(step["delay_hours"]).toBe(24);

    const enrSpec = resourceSpecForPath("sequence-enrollments")!;
    const enr = await store.createResource(enrSpec, {
      sequence_id: "s1", contact_email: "c@x.com", provider_id: null, current_step: 0,
      status: "active", enrolled_at: "2026-07-13T00:00:00.000Z", next_send_at: null, completed_at: null,
    });
    const enrUpdated = await store.updateResource(enrSpec, String(enr["id"]), { status: "cancelled" });
    expect(enrUpdated?.["status"]).toBe("cancelled");

    const whSpec = resourceSpecForPath("webhook-receipts")!;
    const wh = await store.createResource(whSpec, { provider: "ses", event_id: "e9", resource_id: "m1", completed_at: "2026-07-13T00:00:00.000Z" });
    expect(wh["provider"]).toBe("ses");
  });

  it.skipIf(!client)("round-2 parity: send-key mint/verify/revoke + address ownership authorization", async () => {
    await resetPublicSchema();
    await new MigrationLedger(client!, emailsSelfHostedMigrations()).migrate();
    const store = new EmailsSelfHostedStore(client!).forTenant(DEFAULT_TENANT_ID);

    // Ownership: assign an owner + agent administrator, then authorize sends.
    const address = await store.createAddress({ email: "mine@x.com" });
    await store.applyAddressOwnership(address.id, { owner_id: "owner1", administrator_id: "agent1" });
    expect(await store.isOwnerAuthorizedFrom("owner1", "Ops <mine@x.com>")).toBe(true);
    expect(await store.isOwnerAuthorizedFrom("agent1", "mine@x.com")).toBe(true);
    expect(await store.isOwnerAuthorizedFrom("other", "mine@x.com")).toBe(false);
    expect(await store.isOwnerAuthorizedFrom("owner1", "victim@x.com")).toBe(false);
    // Clearing ownership (unassign) revokes authorization.
    await store.applyAddressOwnership(address.id, { owner_id: null, administrator_id: null });
    expect(await store.isOwnerAuthorizedFrom("owner1", "mine@x.com")).toBe(false);

    // Send-key mint → verify → revoke → verify fails. The hash is never on the
    // generic send_keys resource row.
    const { token, key } = await store.mintSendKey({ owner_id: "owner1", label: "ci" });
    expect(token.startsWith("esk_")).toBe(true);
    const skRow = await store.getResource(resourceSpecForPath("send-keys")!, key.id);
    expect(skRow).not.toBeNull();
    expect(skRow).not.toHaveProperty("key_hash");

    const verified = await store.verifySendKey(token);
    expect(verified?.id).toBe(key.id);
    expect(verified?.last_used_at).toBeTruthy();
    expect(await store.verifySendKey("esk_bogus")).toBeNull();

    await client!.execute("UPDATE send_keys SET revoked_at = now() WHERE id = $1", [key.id]);
    expect(await store.verifySendKey(token)).toBeNull();
  });

  // Regression for the production redeploy blocker. An earlier backfill created
  // the parity tables ad-hoc OUTSIDE the migration ledger with the FULL drifted
  // legacy shape, none of which 0009's `CREATE TABLE IF NOT EXISTS` can fix:
  //   1. INTEGER booleans        (seed `... VALUES (..., FALSE, ...)` -> type error)
  //   2. restrictive CHECK enums (provider IN ('cerebras','groq') rejects 'external')
  //   3. legacy FOREIGN KEYs     (into providers/groups/inbound_emails/mailboxes)
  //   4. missing columns         (audit tables w/o updated_at; group_members w/o id)
  //   5. NOT NULL w/o default    (provider_id, key_hash the new server never sets)
  //   6. lost fresh defaults     (subject_template/type/target_daily_volume/...)
  //   7. TEXT json               (tolerated; must NOT be rewritten)
  // This test recreates every class, runs the FULL migration set, and asserts it
  // applies, reconciles the drift, that EVERY representative server write then
  // succeeds, and that a second run is a clean no-op.
  it.skipIf(!client)("reconciles the fully-drifted ad-hoc prod schema (checks / FKs / missing cols / NOT NULL / defaults)", async () => {
    await resetPublicSchema();

    await client!.execute(`
      -- Legacy tables the drifted FKs point at (the self-hosted server no longer
      -- uses these; the FKs must be dropped so its inserts are not rejected).
      CREATE TABLE providers (id TEXT PRIMARY KEY);
      CREATE TABLE groups    (id TEXT PRIMARY KEY);
      CREATE TABLE mailboxes (id TEXT PRIMARY KEY);
      -- inbound_emails is ALSO read by the 0006b/0007 legacy backfill, so it needs
      -- its real (empty) column shape, not a bare id stub.
      CREATE TABLE inbound_emails (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        from_address TEXT,
        to_addresses TEXT,
        cc_addresses TEXT,
        subject TEXT,
        text_body TEXT,
        html_body TEXT,
        received_at TEXT,
        created_at TEXT
      );

      -- Base tables with drifted 0010 columns as TEXT + a legacy provider_id
      -- (NOT NULL, FK to providers) the new server never populates.
      CREATE TABLE domains (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        domain TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        provider TEXT,
        verified BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT,
        provisioning_status TEXT,
        nameservers_json TEXT,
        next_check_at TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE addresses (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        email TEXT NOT NULL UNIQUE,
        domain TEXT,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        verified BOOLEAN NOT NULL DEFAULT FALSE,
        daily_quota INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- INTEGER boolean + a lost DEFAULT on target_address.
      CREATE TABLE aliases (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        local_part TEXT NOT NULL,
        target_address TEXT NOT NULL,
        protected INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- INTEGER boolean + restrictive mode CHECK.
      CREATE TABLE forwarding_rules (
        id TEXT PRIMARY KEY,
        source_address TEXT NOT NULL,
        target_address TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'app-copy' CHECK (mode = 'app-copy'),
        provider_id TEXT,
        from_address TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- 4 INTEGER booleans + TEXT config_json + provider CHECK + NO pk on
      -- agent_key (worst case for the seed's ON CONFLICT arbiter).
      CREATE TABLE email_agent_settings (
        agent_key TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        always_on INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'external' CHECK (provider IN ('cerebras','groq')),
        model TEXT,
        apply_labels INTEGER DEFAULT 1,
        use_network_tools INTEGER DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Legacy row (provider must satisfy the OLD check that existed when it was
      -- written): enabled=1 -> true, apply_labels NULL -> default true.
      INSERT INTO email_agent_settings (agent_key, enabled, always_on, provider, apply_labels, use_network_tools, config_json)
      VALUES ('categorizer', 1, 0, 'cerebras', NULL, 1, '{"seeded":true}');

      -- TEXT json + status/priority/risk CHECKs + FK to inbound_emails + MISSING
      -- updated_at (the generic updater needs it).
      CREATE TABLE email_agent_runs (
        id TEXT PRIMARY KEY,
        agent_key TEXT NOT NULL,
        inbound_email_id TEXT NOT NULL REFERENCES inbound_emails(id),
        provider TEXT NOT NULL CHECK (provider IN ('cerebras','groq')),
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ok','error','skipped')),
        category TEXT,
        labels_json TEXT NOT NULL DEFAULT '[]',
        priority INTEGER CHECK (priority >= 1 AND priority <= 5),
        confidence REAL,
        risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
        summary TEXT, reasoning TEXT,
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        output_json TEXT NOT NULL DEFAULT '{}',
        error TEXT, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- TEXT metadata + type CHECK + FK to providers + MISSING updated_at.
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        email_id TEXT,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        provider_event_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('delivered','bounced','complained','opened','clicked','unsubscribed')),
        recipient TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        occurred_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- status/type CHECKs + FK to mailboxes + name lost its DEFAULT + TEXT json.
      CREATE TABLE mailbox_sources (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
        provider_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('ses','ses_s3','gmail','resend','sandbox','legacy_inbound','manual')),
        name TEXT NOT NULL,
        external_account_id TEXT, external_mailbox TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','legacy')),
        settings_json TEXT NOT NULL DEFAULT '{}',
        provider_snapshot_json TEXT NOT NULL DEFAULT '{}',
        last_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- MISSING id/created_at/updated_at + FK to legacy groups.
      CREATE TABLE group_members (
        group_id TEXT NOT NULL REFERENCES groups(id),
        email TEXT NOT NULL,
        name TEXT,
        vars TEXT NOT NULL DEFAULT '{}',
        added_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Inline legacy key_hash (NOT NULL) + owner_id NOT NULL + MISSING updated_at.
      CREATE TABLE send_keys (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        prefix TEXT,
        label TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      -- Lost DEFAULT on type / subject_template + TEXT metadata (0005 tables).
      CREATE TABLE owners (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        contact_email TEXT, external_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        subject_template TEXT NOT NULL,
        html_template TEXT, text_template TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Run the FULL migration set against the drifted schema.
    const ledger = new MigrationLedger(client!, emailsSelfHostedMigrations());
    await ledger.migrate();
    const applied = (await ledger.listApplied()).map((row) => row.id);
    expect(applied).toContain("0009_emails_selfhosted_parity_tables");
    expect(applied).toContain("0010_emails_selfhosted_provisioning_columns");
    expect(applied).toContain("0011_emails_selfhosted_parity_tables_2");

    // Booleans reconciled; the legacy row survived (1 -> true, NULL -> default).
    for (const [t, c] of [
      ["aliases", "protected"], ["forwarding_rules", "enabled"],
      ["email_agent_settings", "enabled"], ["email_agent_settings", "always_on"],
      ["email_agent_settings", "apply_labels"], ["email_agent_settings", "use_network_tools"],
    ] as const) {
      expect(await columnType(t, c)).toBe("boolean");
    }
    const legacyRow = await client!.get<{ enabled: boolean; apply_labels: boolean }>(
      `SELECT enabled, apply_labels FROM email_agent_settings WHERE agent_key = $1`, ["categorizer"],
    );
    expect(legacyRow?.enabled).toBe(true);
    expect(legacyRow?.apply_labels).toBe(true);
    // Seed applied (the exact INSERT that failed in prod), legacy row preserved.
    const settings = await client!.many<{ agent_key: string }>(`SELECT agent_key FROM email_agent_settings ORDER BY agent_key`);
    expect(settings.map((r) => r.agent_key)).toEqual(["categorizer", "fraud", "labeler"]);

    // Restrictive CHECKs + legacy FKs dropped.
    const constraintCount = await client!.get<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND contype IN ('c','f')
         AND conname IN (
           'email_agent_settings_provider_check','forwarding_rules_mode_check',
           'events_type_check','email_agent_runs_status_check','mailbox_sources_type_check',
           'domains_provider_id_fkey','addresses_provider_id_fkey',
           'email_agent_runs_inbound_email_id_fkey','events_provider_id_fkey',
           'mailbox_sources_mailbox_id_fkey','group_members_group_id_fkey')`,
    );
    expect(constraintCount?.n).toBe(0);

    // Missing columns added; json columns intentionally LEFT as text.
    expect(await columnType("email_agent_runs", "updated_at")).toBe("timestamp with time zone");
    expect(await columnType("send_keys", "updated_at")).toBe("timestamp with time zone");
    expect(await columnType("group_members", "id")).toBe("text");
    expect(await columnType("group_members", "updated_at")).toBe("timestamp with time zone");
    expect(await columnType("email_agent_settings", "config_json")).toBe("text");
    expect(await columnType("events", "metadata")).toBe("text");
    expect(await columnType("domains", "nameservers_json")).toBe("text");

    // CRITICAL: every representative server write now succeeds (checks/FKs/NOT
    // NULL/defaults/missing-cols/json all reconciled). Empty array == all passed.
    const store = new EmailsSelfHostedStore(client!).forTenant(DEFAULT_TENANT_ID);
    expect(await serverWriteFailures(store)).toEqual([]);

    // Idempotency: a second full run over the reconciled schema is a clean no-op.
    const rerun = await new MigrationLedger(client!, emailsSelfHostedMigrations()).migrate();
    expect(rerun.plan.filter((p) => p.state === "pending")).toHaveLength(0);
    expect(await columnType("email_agent_settings", "enabled")).toBe("boolean");
  });

  // Highest-fidelity variant: load the ACTUAL prod schema dump (gitignored local
  // artifact) rather than a reconstructed fixture, so the reconcile is validated
  // against the real legacy DDL — every table, every one of the 29 CHECKs, all
  // FKs, defaults and indexes exactly as they exist in production.
  it.skipIf(!client || !hasProdDump)("migrates the REAL prod schema dump and every server write succeeds", async () => {
    await resetPublicSchema();
    await client!.execute(loadableDump(readFileSync(prodDumpPath, "utf8")));

    // The reported failure reproduces on the real schema without the fix; with it,
    // the full set applies.
    const ledger = new MigrationLedger(client!, emailsSelfHostedMigrations());
    await ledger.migrate();
    const applied = (await ledger.listApplied()).map((row) => row.id);
    expect(applied).toContain("0009_emails_selfhosted_parity_tables");
    expect(applied).toContain("0010_emails_selfhosted_provisioning_columns");
    expect(applied).toContain("0011_emails_selfhosted_parity_tables_2");

    // Reconciled: booleans converted, provider CHECK gone, seed applied.
    expect(await columnType("email_agent_settings", "enabled")).toBe("boolean");
    const settings = await client!.many<{ agent_key: string }>(`SELECT agent_key FROM email_agent_settings ORDER BY agent_key`);
    expect(settings.map((r) => r.agent_key)).toEqual(expect.arrayContaining(["categorizer", "fraud", "labeler"]));

    // CRITICAL: the self-hosted server can write every resource against the real
    // reconciled schema (provider='external', in-progress agent runs, digests,
    // send keys, group members, ... — the writes that faulted deploys 2 and 3).
    const store = new EmailsSelfHostedStore(client!).forTenant(DEFAULT_TENANT_ID);
    expect(await serverWriteFailures(store)).toEqual([]);

    // Idempotent on a second run over the real schema.
    const rerun = await new MigrationLedger(client!, emailsSelfHostedMigrations()).migrate();
    expect(rerun.plan.filter((p) => p.state === "pending")).toHaveLength(0);
  });

  // ---- 0012: multi-tenancy identity + tenant_id backfill --------------------
  // Loads a DRIFTED prod-shaped schema (the drift classes 0012 must survive:
  // domains/addresses carry the prod `(provider_id, <col>)` unique, group_members
  // carries a `(group_id, email)` PRIMARY KEY, email_agent_settings a single-col
  // PK), migrates through 0011, seeds pre-tenancy rows + credentials, then runs
  // 0012 and asserts: identity tables exist, tenant_id is NOT NULL and backfilled
  // to the default tenant on EVERY data table, the credential/resolution maps are
  // backfilled, the per-tenant composite uniques are in place (and the old global
  // uniques are gone), the identity tables are unreachable via the resource layer,
  // and a 2nd full run is a clean no-op.
  const TENANT_DATA_TABLES = [
    "domains", "addresses", "messages", "contacts", "self_hosted_providers", "templates",
    "contact_groups", "sequences", "owners", "send_keys", "scheduled_emails", "aliases",
    "forwarding_rules", "warming_schedules", "email_triage", "provisioning_events",
    "mailbox_sources", "events", "email_agent_settings", "email_agent_runs", "email_digests",
    "group_members", "sequence_steps", "sequence_enrollments", "address_ownership_events",
    "webhook_receipts", "sandbox_emails",
  ] as const;
  const IDENTITY_TABLES = [
    "tenants", "users", "memberships", "sessions", "api_key_tenants", "invitations",
    "password_reset_tokens", "email_verification_tokens", "inbound_domain_routes", "send_key_tenants",
  ] as const;

  async function indexExists(name: string): Promise<boolean> {
    const row = await client!.get<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'i' AND relname = $1`,
      [name],
    );
    return (row?.n ?? 0) > 0;
  }
  async function primaryKeyColumns(table: string): Promise<string[]> {
    const rows = await client!.many<{ attname: string }>(
      `SELECT att.attname::text AS attname
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.attnum
        WHERE c.conrelid = ('public.' || $1)::regclass AND c.contype = 'p'
        ORDER BY k.ord`,
      [table],
    );
    return rows.map((r) => r.attname);
  }

  it.skipIf(!client)("0012 creates identity tables, backfills tenant_id to the default tenant, and swaps uniques (drift-aware + idempotent)", async () => {
    await resetPublicSchema();

    // Drifted prod-shaped base schema (before any migration).
    await client!.execute(`
      CREATE TABLE providers (id TEXT PRIMARY KEY);
      CREATE TABLE groups    (id TEXT PRIMARY KEY);
      -- prod drift: (provider_id, domain) UNIQUE, provider_id NOT NULL FK.
      CREATE TABLE domains (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        domain TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (provider_id, domain)
      );
      -- prod drift: (provider_id, email) UNIQUE.
      CREATE TABLE addresses (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        email TEXT NOT NULL,
        domain TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (provider_id, email)
      );
      -- (contacts is left to the migrations to create fresh; its prod shape ==
      -- the fresh (email) UNIQUE shape, which 0012 swaps to (tenant_id, email).)
      -- prod drift: (group_id, email) is the PRIMARY KEY (no id column).
      CREATE TABLE group_members (
        group_id TEXT NOT NULL REFERENCES groups(id),
        email TEXT NOT NULL,
        name TEXT,
        vars TEXT NOT NULL DEFAULT '{}',
        added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (group_id, email)
      );
      -- single-column PK, to exercise the PK -> (tenant_id, agent_key) change.
      CREATE TABLE email_agent_settings (
        agent_key TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        always_on BOOLEAN NOT NULL DEFAULT FALSE,
        provider TEXT NOT NULL DEFAULT 'external',
        model TEXT,
        apply_labels BOOLEAN NOT NULL DEFAULT TRUE,
        use_network_tools BOOLEAN NOT NULL DEFAULT TRUE,
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE send_keys (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        key_hash TEXT NOT NULL,
        prefix TEXT,
        label TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- api_keys pre-created in the contract's shape so the auth migration's
      -- CREATE TABLE IF NOT EXISTS is a no-op and our seeded row survives.
      CREATE TABLE api_keys (
        kid text PRIMARY KEY,
        app text NOT NULL,
        agent text,
        scopes jsonb NOT NULL,
        token_hash text NOT NULL,
        issued_at timestamptz NOT NULL,
        expires_at timestamptz,
        revoked_at timestamptz,
        revoked_reason text,
        last_used_at timestamptz,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Phase A: migrate everything EXCEPT 0012 (reconciles the drift, creates the
    // remaining tables). Then seed pre-tenancy rows into the migration-created
    // tables (messages) and the credential sources (api_keys/send_keys/domains).
    await new MigrationLedger(client!, migrationsBefore0012()).migrate();

    await client!.execute(`
      INSERT INTO providers (id) VALUES ('p1');
      INSERT INTO domains (id, provider_id, domain) VALUES ('dom-a', 'p1', 'a.example'), ('dom-b', 'p1', 'b.example');
      INSERT INTO addresses (id, provider_id, email) VALUES ('addr-a', 'p1', 'user@a.example');
      INSERT INTO contacts (id, email) VALUES ('con-a', 'contact@a.example');
      INSERT INTO groups (id) VALUES ('g1');
      INSERT INTO group_members (group_id, email) VALUES ('g1', 'member@a.example');
      INSERT INTO send_keys (id, owner_id, key_hash, prefix) VALUES ('sk-a', 'owner1', 'hash-a', 'esk_aaaa');
      INSERT INTO messages (id, from_addr, direction, source_id, idempotency_key, send_state)
        VALUES ('msg-a', 'sender@a.example', 'outbound', 'src-a', 'idem-a', 'none');
      INSERT INTO api_keys (kid, app, scopes, token_hash, issued_at)
        VALUES ('kid-a', 'emails', '["emails:*"]'::jsonb, 'tok-hash-a', now());
    `);

    // Phase B: run through 0012 — 0012 becomes the only pending migration.
    const result = await new MigrationLedger(client!, migrationsThrough0012()).migrate();
    expect(result.plan.map((p) => p.migration.id)).toContain("0012_emails_tenancy_identity_and_backfill");
    expect(
      result.applied.map((r) => r.id),
    ).toContain("0012_emails_tenancy_identity_and_backfill");

    // 1. Identity + resolution tables exist.
    for (const t of IDENTITY_TABLES) {
      const reg = await client!.get<{ oid: string | null }>(
        `SELECT to_regclass('public.' || $1) AS oid`, [t],
      );
      expect(reg?.oid, `identity table ${t} should exist`).not.toBeNull();
    }

    // 2. Default tenant seeded with the fixed sentinel id.
    const tenant = await client!.get<{ id: string; slug: string; status: string }>(
      `SELECT id, slug, status FROM tenants WHERE id = $1`, [DEFAULT_TENANT_ID],
    );
    expect(tenant?.slug).toBe("default");
    expect(tenant?.status).toBe("active");

    // 3. tenant_id exists, is NOT NULL, and is backfilled to the default tenant on
    //    EVERY data table (zero rows outside the default tenant, zero NULLs).
    for (const t of TENANT_DATA_TABLES) {
      expect(await columnType(t, "tenant_id"), `${t}.tenant_id type`).toBe("uuid");
      const nullable = await client!.get<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`, [t],
      );
      expect(nullable?.is_nullable, `${t}.tenant_id NOT NULL`).toBe("NO");
      const stray = await client!.get<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id IS DISTINCT FROM $1`, [DEFAULT_TENANT_ID],
      );
      expect(stray?.n, `${t} rows outside default tenant`).toBe(0);
    }

    // Seeded rows are specifically confirmed to have moved into the default tenant.
    for (const [t, id] of [["domains", "dom-a"], ["addresses", "addr-a"], ["contacts", "con-a"], ["messages", "msg-a"]] as const) {
      const row = await client!.get<{ tenant_id: string }>(`SELECT tenant_id FROM ${t} WHERE id = $1`, [id]);
      expect(row?.tenant_id, `${t} seeded row`).toBe(DEFAULT_TENANT_ID);
    }

    // 4. Credential + resolution maps backfilled to the default tenant.
    const keyMap = await client!.get<{ tenant_id: string }>(
      `SELECT tenant_id FROM api_key_tenants WHERE kid = $1`, ["kid-a"],
    );
    expect(keyMap?.tenant_id).toBe(DEFAULT_TENANT_ID);
    const skMap = await client!.get<{ tenant_id: string }>(
      `SELECT tenant_id FROM send_key_tenants WHERE send_key_id = $1`, ["sk-a"],
    );
    expect(skMap?.tenant_id).toBe(DEFAULT_TENANT_ID);
    const routes = await client!.many<{ domain: string; tenant_id: string }>(
      `SELECT domain, tenant_id FROM inbound_domain_routes ORDER BY domain`,
    );
    expect(routes).toEqual([
      { domain: "a.example", tenant_id: DEFAULT_TENANT_ID },
      { domain: "b.example", tenant_id: DEFAULT_TENANT_ID },
    ]);

    // 5. Per-tenant composite uniques in place.
    for (const idx of [
      "domains_tenant_domain_uidx", "addresses_tenant_email_uidx", "contacts_tenant_email_uidx",
      "templates_tenant_name_uidx", "contact_groups_tenant_name_uidx", "warming_schedules_tenant_domain_uidx",
      "aliases_tenant_domain_local_part_uidx", "forwarding_rules_tenant_route_uidx",
      "email_agent_runs_tenant_agent_inbound_uidx", "group_members_tenant_group_email_uidx",
      "messages_tenant_source_id_uidx", "messages_tenant_idempotency_key_uidx",
      "webhook_receipts_tenant_provider_event_uidx",
    ]) {
      expect(await indexExists(idx), `composite unique ${idx}`).toBe(true);
    }
    // email_agent_settings PK swapped to the composite.
    expect((await primaryKeyColumns("email_agent_settings")).sort()).toEqual(["agent_key", "tenant_id"]);
    // The shipped store's ON CONFLICT targets survive transitionally.
    expect(await indexExists("messages_idempotency_key_uidx")).toBe(true);
    expect(await indexExists("messages_source_id_uidx")).toBe(true);
    expect(await indexExists("email_agent_settings_agent_key_uidx")).toBe(true);

    // 6. Old GLOBAL uniques are gone — a second tenant may reuse the same domain,
    //    but a duplicate WITHIN a tenant is still rejected.
    await client!.execute(
      `INSERT INTO tenants (id, slug, name) VALUES ('22222222-2222-2222-2222-222222222222', 'tenant-two', 'Tenant Two')`,
    );
    // same domain value, different tenant -> allowed
    await client!.execute(
      `INSERT INTO domains (id, provider_id, domain, tenant_id) VALUES ('dom-a-t2', 'p1', 'a.example', '22222222-2222-2222-2222-222222222222')`,
    );
    // same domain value, same (default) tenant -> unique violation
    let dupBlocked = false;
    try {
      await client!.execute(
        `INSERT INTO domains (id, provider_id, domain, tenant_id) VALUES ('dom-a-dup', 'p1', 'a.example', '${DEFAULT_TENANT_ID}')`,
      );
    } catch { dupBlocked = true; }
    expect(dupBlocked, "duplicate domain within a tenant must be blocked").toBe(true);

    // 7. Identity/secret tables are NOT reachable via the generic resource layer.
    const resourceTables = new Set(SELF_HOSTED_RESOURCES.map((r) => r.table));
    for (const t of IDENTITY_TABLES) {
      expect(resourceTables.has(t), `${t} must not be a generic resource`).toBe(false);
    }

    // 8. Idempotent: a 2nd run (through 0012) is a clean no-op and invariants hold.
    const rerun = await new MigrationLedger(client!, migrationsThrough0012()).migrate();
    expect(rerun.plan.filter((p) => p.state === "pending")).toHaveLength(0);
    expect(await columnType("domains", "tenant_id")).toBe("uuid");
    expect((await primaryKeyColumns("email_agent_settings")).sort()).toEqual(["agent_key", "tenant_id"]);
  });

  // ---- 0012 dedup: pre-existing DUPLICATE DATA on a composite target ----------
  // Prod carries duplicate rows on a subset of the 12 composite-unique targets
  // (two pre-tenancy domains/addresses that coexisted under the old
  // (provider_id, <col>) unique but collide once every row is backfilled to ONE
  // default tenant). The naive backfill + CREATE UNIQUE INDEX would fault. This
  // fixture seeds representative duplicates — a domain dup and an address dup, each
  // with id-based dependents to reparent — runs 0012, and asserts the deterministic
  // survivor is kept, dependents are reparented (no orphaned references), losers are
  // deleted, the composite unique is built, unrelated data is untouched, and a
  // re-run of the whole 0012 body is a clean no-op.
  it.skipIf(!client)("0012 dedups pre-existing duplicate data (deterministic survivor + FK reparent) before building the composite uniques", async () => {
    await resetPublicSchema();

    // Drifted prod-shaped base: domains/addresses carry the (provider_id, <col>)
    // unique, which is exactly what let the duplicate rows coexist pre-tenancy.
    await client!.execute(`
      CREATE TABLE providers (id TEXT PRIMARY KEY);
      CREATE TABLE domains (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        domain TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (provider_id, domain)
      );
      CREATE TABLE addresses (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        email TEXT NOT NULL,
        domain TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (provider_id, email)
      );
      CREATE TABLE api_keys (
        kid text PRIMARY KEY, app text NOT NULL, agent text, scopes jsonb NOT NULL,
        token_hash text NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz,
        revoked_at timestamptz, revoked_reason text, last_used_at timestamptz,
        created_by text, created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Phase A: migrate everything EXCEPT 0012 (reconciles drift + creates the
    // dependent tables: provisioning_events, address_ownership_events, messages).
    await new MigrationLedger(client!, migrationsBefore0012()).migrate();

    // Seed the duplicate data + id-based dependents. tenant_id does not exist yet
    // (0012 adds it), so every row backfills to the default tenant, turning the
    // pre-tenancy (provider_id, <col>) coexistence into a within-tenant collision.
    await client!.execute(`
      INSERT INTO providers (id) VALUES ('p1'), ('p2'), ('p3');

      -- DOMAIN dup: 'dup.example' x2. Survivor 'dom-keep' has the MOST dependents
      -- (3 addresses); loser 'dom-orphan' is (near-)orphan but deliberately carries
      -- ONE stray address (addresses.domain_id) + ONE provisioning audit row
      -- (polymorphic provisioning_events.entity_id) that MUST be reparented, and is
      -- the MORE RECENT row — so keeping 'dom-keep' proves dependent-count beats
      -- recency. Different provider_id lets them coexist under the drifted unique.
      INSERT INTO domains (id, provider_id, domain, status, updated_at) VALUES
        ('dom-keep',   'p1', 'dup.example', 'ready',        '2026-06-22T00:00:00Z'),
        ('dom-orphan', 'p2', 'dup.example', 'inbound_ready','2026-12-01T00:00:00Z'),
        ('dom-solo',   'p1', 'solo.example','ready',        '2026-05-01T00:00:00Z');

      -- ADDRESS dup: 'dupe@dup.example' x3 (survivor + two losers), all under
      -- 'dom-keep'. Survivor 'addr-keep' has the MOST dependents (3 ownership
      -- events); loser 'addr-l1' is the MOST RECENT and has 2 dependents (1
      -- ownership + 1 provisioning-address) that must be reparented; loser
      -- 'addr-l2' has none. Distinct provider_id lets them coexist pre-tenancy.
      -- 'addr-od' is 'dom-orphan''s stray dependent; 'addr-solo' is unrelated.
      INSERT INTO addresses (id, provider_id, email, domain_id, updated_at) VALUES
        ('addr-keep', 'p1', 'dupe@dup.example', 'dom-keep',   '2026-03-01T00:00:00Z'),
        ('addr-l1',   'p2', 'dupe@dup.example', 'dom-keep',   '2026-06-01T00:00:00Z'),
        ('addr-l2',   'p3', 'dupe@dup.example', 'dom-keep',   '2026-01-01T00:00:00Z'),
        ('addr-od',   'p1', 'orphan-dep@dup.example', 'dom-orphan', '2026-02-01T00:00:00Z'),
        ('addr-solo', 'p1', 'solo@solo.example', 'dom-solo',  '2026-05-01T00:00:00Z');

      -- id-based dependents that must survive the collapse by moving to the survivor.
      INSERT INTO address_ownership_events (id, address_id, action) VALUES
        ('oe-k1', 'addr-keep', 'assign'),
        ('oe-k2', 'addr-keep', 'transfer'),
        ('oe-k3', 'addr-keep', 'transfer'),
        ('oe-l1', 'addr-l1',   'assign');
      INSERT INTO provisioning_events (id, entity_type, entity_id, to_state) VALUES
        ('pe-dom', 'domain',  'dom-orphan', 'inbound_ready'),
        ('pe-adr', 'address', 'addr-l1',    'active');

      -- Messages reference addresses by EMAIL STRING (not id): must be preserved
      -- verbatim (never reparented, never deleted) across the dedup.
      INSERT INTO messages (id, from_addr, direction, source_id, send_state) VALUES
        ('msg-dup', 'dupe@dup.example', 'inbound', 'src-dup', 'none');

      -- webhook_receipts (the 12th target): a (provider, event_id) dup with NO id
      -- dependents — exercises the generic helper's empty-reference-graph path,
      -- keeping the most-recently-updated survivor.
      INSERT INTO webhook_receipts (id, provider, event_id, updated_at) VALUES
        ('wr-keep', 'ses', 'evt-1', '2026-06-01T00:00:00Z'),
        ('wr-drop', 'ses', 'evt-1', '2026-01-01T00:00:00Z');

      INSERT INTO api_keys (kid, app, scopes, token_hash, issued_at)
        VALUES ('kid-d', 'emails', '["emails:*"]'::jsonb, 'tok-d', now());
    `);

    // Baseline row counts to prove NO unrelated data is lost.
    const countOf = async (sql: string): Promise<number> =>
      (await client!.get<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`))?.n ?? 0;
    const beforeMessages = await countOf("messages");
    const beforeOwnership = await countOf("address_ownership_events");
    const beforeProvisioning = await countOf("provisioning_events");

    // Phase B: run 0012 (through 0012; 0013 is covered separately).
    const result = await new MigrationLedger(client!, migrationsThrough0012()).migrate();
    expect(result.applied.map((r) => r.id)).toContain("0012_emails_tenancy_identity_and_backfill");

    // ---- survivor chosen per the rule (dependent-count primary) --------------
    const domRows = await client!.many<{ id: string }>(
      `SELECT id FROM domains WHERE domain = 'dup.example'`);
    expect(domRows.map((r) => r.id)).toEqual(["dom-keep"]); // loser deleted, survivor kept
    const addrRows = await client!.many<{ id: string }>(
      `SELECT id FROM addresses WHERE email = 'dupe@dup.example'`);
    expect(addrRows.map((r) => r.id)).toEqual(["addr-keep"]);

    // losers gone
    for (const gone of ["dom-orphan"]) {
      expect(await countOf(`domains WHERE id = '${gone}'`)).toBe(0);
    }
    for (const gone of ["addr-l1", "addr-l2"]) {
      expect(await countOf(`addresses WHERE id = '${gone}'`)).toBe(0);
    }

    // ---- dependents reparented onto the survivor (no orphaned references) -----
    // domains: the loser's stray address + provisioning audit row moved to the survivor.
    expect((await client!.get<{ domain_id: string }>(
      `SELECT domain_id FROM addresses WHERE id = 'addr-od'`))?.domain_id).toBe("dom-keep");
    expect(await countOf(
      `addresses WHERE domain_id IS NOT NULL AND domain_id NOT IN (SELECT id FROM domains)`)).toBe(0);
    expect((await client!.get<{ entity_id: string }>(
      `SELECT entity_id FROM provisioning_events WHERE id = 'pe-dom'`))?.entity_id).toBe("dom-keep");
    expect(await countOf(
      `provisioning_events WHERE entity_type = 'domain' AND entity_id NOT IN (SELECT id FROM domains)`)).toBe(0);

    // addresses: the loser's ownership event + provisioning-address row moved over.
    expect((await client!.get<{ address_id: string }>(
      `SELECT address_id FROM address_ownership_events WHERE id = 'oe-l1'`))?.address_id).toBe("addr-keep");
    expect(await countOf(`address_ownership_events WHERE address_id = 'addr-keep'`)).toBe(4);
    expect(await countOf(
      `address_ownership_events WHERE address_id NOT IN (SELECT id FROM addresses)`)).toBe(0);
    expect((await client!.get<{ entity_id: string }>(
      `SELECT entity_id FROM provisioning_events WHERE id = 'pe-adr'`))?.entity_id).toBe("addr-keep");
    expect(await countOf(
      `provisioning_events WHERE entity_type = 'address' AND entity_id NOT IN (SELECT id FROM addresses)`)).toBe(0);

    // webhook_receipts (12th target, no reference graph): most-recent survivor kept.
    expect((await client!.many<{ id: string }>(
      `SELECT id FROM webhook_receipts WHERE provider = 'ses' AND event_id = 'evt-1'`))
      .map((r) => r.id)).toEqual(["wr-keep"]);

    // ---- composite unique indexes were created, and enforce within-tenant -----
    expect(await indexExists("domains_tenant_domain_uidx")).toBe(true);
    expect(await indexExists("addresses_tenant_email_uidx")).toBe(true);
    expect(await indexExists("webhook_receipts_tenant_provider_event_uidx")).toBe(true);
    let dupBlocked = false;
    try {
      await client!.execute(
        `INSERT INTO domains (id, provider_id, domain, tenant_id) VALUES ('dom-x', 'p1', 'dup.example', '${DEFAULT_TENANT_ID}')`);
    } catch { dupBlocked = true; }
    expect(dupBlocked, "duplicate domain within tenant must be blocked post-dedup").toBe(true);

    // ---- no unrelated data lost; string-based message ref preserved verbatim ---
    expect(await countOf("domains WHERE id = 'dom-solo'")).toBe(1);
    expect(await countOf("addresses WHERE id = 'addr-solo'")).toBe(1);
    expect(await countOf("messages")).toBe(beforeMessages); // msg-dup survives
    const msg = await client!.get<{ from_addr: string }>(
      `SELECT from_addr FROM messages WHERE id = 'msg-dup'`);
    expect(msg?.from_addr).toBe("dupe@dup.example"); // NOT reparented (string ref)
    // Every dependent row is preserved (reparented, never dropped).
    expect(await countOf("address_ownership_events")).toBe(beforeOwnership);
    expect(await countOf("provisioning_events")).toBe(beforeProvisioning);

    // ---- re-running the ENTIRE 0012 body is a clean, data-preserving no-op -----
    const mig0012 = emailsSelfHostedMigrations().find(
      (m) => m.id === "0012_emails_tenancy_identity_and_backfill")!;
    await client!.execute(mig0012.sql); // idempotent: no dups remain to collapse
    expect((await client!.many<{ id: string }>(
      `SELECT id FROM domains WHERE domain = 'dup.example'`)).map((r) => r.id)).toEqual(["dom-keep"]);
    expect((await client!.many<{ id: string }>(
      `SELECT id FROM addresses WHERE email = 'dupe@dup.example'`)).map((r) => r.id)).toEqual(["addr-keep"]);
    expect(await countOf(`address_ownership_events WHERE address_id = 'addr-keep'`)).toBe(4);
    expect(await countOf("messages")).toBe(beforeMessages);
    // A ledger re-run (through 0012) remains a no-op too.
    const rerun = await new MigrationLedger(client!, migrationsThrough0012()).migrate();
    expect(rerun.plan.filter((p) => p.state === "pending")).toHaveLength(0);
  });

  it.skipIf(!client)("0016 removes pending, unverified, and stale legacy inbound routes", async () => {
    await resetPublicSchema();
    await new MigrationLedger(client!, emailsSelfHostedMigrations()).migrate();
    const tenantId = "33333333-3333-3333-3333-333333333333";
    await client!.execute(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'route-seal', 'Route Seal')`,
      [tenantId],
    );
    await client!.execute(
      `INSERT INTO domains (id, domain, status, verified, tenant_id) VALUES
         ('route-pending', 'pending-route.example', 'pending', false, $1),
         ('route-active', 'active-route.example', 'active', true, $1)`,
      [tenantId],
    );
    await client!.execute(
      `INSERT INTO inbound_domain_routes (domain, tenant_id) VALUES
         ('pending-route.example', $1),
         ('active-route.example', $1),
         ('stale-route.example', $1)`,
      [tenantId],
    );

    const seal = emailsSelfHostedMigrations().find(
      (migration) => migration.id === "0016_inbound_routing_and_quarantine",
    )!;
    await client!.execute(seal.sql);
    const routes = await client!.many<{ domain: string }>(
      `SELECT domain FROM inbound_domain_routes WHERE tenant_id = $1 ORDER BY domain`,
      [tenantId],
    );
    expect(routes.map((route) => route.domain)).toEqual(["active-route.example"]);
  });
});
