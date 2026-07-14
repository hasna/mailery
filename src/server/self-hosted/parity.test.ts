// Server-side coverage for the self-hosted-only PARITY additions:
//   * the new generic /v1 resources (aliases, forwarding, warming, triage,
//     provisioning, sources, events, email-agents, email-agent-runs,
//     email-digests) — routing, scope enforcement, and JSON/bool/int/num
//     column round-trips through a table-aware in-memory fake;
//   * the natural-key (agent_key) resource whose create upserts (idempotent);
//   * the mail-view endpoints (threads / mailboxes / raw); and
//   * domain/address provisioning fields flowing through PATCH.

import { describe, expect, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { testAuthDeps, selfScopedStore } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

/**
 * In-memory fake that emulates generic INSERT (plain + ON CONFLICT DO NOTHING),
 * SELECT-by-key, UPDATE ... SET (applied), and DELETE for arbitrary tables,
 * with JSONB round-tripping. It understands a configurable key column, so it
 * covers both UUID-keyed and natural-key (agent_key) resources.
 */
function tableClient(): TypedQueryClient {
  const tables = new Map<string, Record<string, unknown>[]>();
  const tableOf = (sql: string): string => sql.match(/(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i)?.[1] ?? "";
  const whereKey = (sql: string): string => sql.match(/WHERE\s+([a-z_]+)\s*=\s*\$1/i)?.[1] ?? "id";

  /** Parse an INSERT into a stored row (JSONB placeholders decoded). */
  const buildInsertRow = (sql: string, params: readonly unknown[]): Record<string, unknown> => {
    const cols = (sql.match(/INSERT INTO [a-z_]+ \(([^)]+)\)/i)?.[1] ?? "").split(",").map((c) => c.trim());
    const valueTokens = (sql.match(/VALUES \(([^)]+)\)/i)?.[1] ?? "").split(",").map((t) => t.trim());
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      let v = params[i];
      if (/::jsonb/i.test(valueTokens[i] ?? "") && typeof v === "string") {
        try { v = JSON.parse(v); } catch { /* leave */ }
      }
      row[c] = v;
    });
    return row;
  };

  const client: TypedQueryClient = {
    async query(sql, params) {
      const rows = (await client.many(sql, params)) as never[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      const t = tableOf(sql);
      const rows = tables.get(t) ?? [];
      if (/^\s*DELETE/i.test(sql)) {
        const key = whereKey(sql);
        const id = (params ?? [])[0];
        const removed = rows.filter((r) => r[key] === id);
        tables.set(t, rows.filter((r) => r[key] !== id));
        return removed.map((r) => ({ id: r[key] })) as unknown as T[];
      }
      return rows as unknown as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      const t = tableOf(sql);
      const rows = tables.get(t) ?? [];
      if (/^\s*INSERT/i.test(sql)) {
        // Conflict target may be composite (e.g. `(tenant_id, agent_key)`); a row
        // conflicts only when EVERY target column matches.
        const conflictCols = (sql.match(/ON CONFLICT \(([a-z_,\s]+)\)/i)?.[1] ?? "")
          .split(",").map((c) => c.trim()).filter(Boolean);
        const row = buildInsertRow(sql, params ?? []);
        if (conflictCols.length && rows.some((r) => conflictCols.every((c) => r[c] === row[c]))) return null; // DO NOTHING
        rows.push(row);
        tables.set(t, rows);
        return row as unknown as T;
      }
      const key = whereKey(sql);
      const target = rows.find((r) => r[key] === (params ?? [])[0]);
      if (/^\s*UPDATE/i.test(sql)) {
        if (!target) return null;
        for (const m of sql.matchAll(/([a-z_]+)\s*=\s*\$(\d+)(::jsonb)?/gi)) {
          const col = m[1]!;
          if (col === "updated_at") continue;
          let v = (params ?? [])[Number(m[2]) - 1];
          if (m[3] && typeof v === "string") { try { v = JSON.parse(v); } catch { /* leave */ } }
          target[col] = v;
        }
        return target as unknown as T;
      }
      return (target as unknown as T) ?? null;
    },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      const t = tableOf(sql);
      const row = buildInsertRow(sql, params ?? []);
      const rows = tables.get(t) ?? [];
      rows.push(row);
      tables.set(t, rows);
      return row as unknown as T;
    },
    async execute() {},
  };
  return client;
}

function deps(): SelfHostedServiceDeps {
  const client = tableClient();
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

const readToken = () => mintApiKey({ app: "emails", scopes: ["emails:read"], signingSecret: SIGNING_SECRET }).token;
const writeToken = () => mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;

describe("self-hosted parity: new migrations", () => {
  test("0009 + 0010 are registered and append after 0008", () => {
    const ids = emailsSelfHostedMigrations().map((m) => m.id);
    expect(ids).toContain("0009_emails_selfhosted_parity_tables");
    expect(ids).toContain("0010_emails_selfhosted_provisioning_columns");
    expect(ids.indexOf("0009_emails_selfhosted_parity_tables")).toBeGreaterThan(
      ids.indexOf("0008_emails_legacy_messages_backfill_dedupe"),
    );
    expect(ids.indexOf("0010_emails_selfhosted_provisioning_columns")).toBeGreaterThan(
      ids.indexOf("0009_emails_selfhosted_parity_tables"),
    );
  });

  test("released migration ids/checksums are unchanged by the append", () => {
    const released = Object.fromEntries(emailsSelfHostedMigrations().map((m) => [m.id, m.checksum]));
    expect(released["0005_mailery_selfhosted_resources"]).toBe(
      "sha256:04d715446f80b8f0f1926097c3837bbd83fe76ad7400f10eef70189d97651bbc",
    );
  });

  test("0009 seeds the three email agent settings rows and 0010 adds provisioning columns", () => {
    const m = Object.fromEntries(emailsSelfHostedMigrations().map((x) => [x.id, x.sql]));
    const parity = m["0009_emails_selfhosted_parity_tables"]!;
    expect(parity).toContain("CREATE TABLE IF NOT EXISTS aliases");
    expect(parity).toContain("CREATE TABLE IF NOT EXISTS forwarding_rules");
    expect(parity).toContain("CREATE TABLE IF NOT EXISTS email_agent_settings");
    expect(parity).toContain("'categorizer'");
    expect(parity).toContain("ON CONFLICT (agent_key) DO NOTHING");
    const prov = m["0010_emails_selfhosted_provisioning_columns"]!;
    expect(prov).toContain("ALTER TABLE domains ADD COLUMN IF NOT EXISTS provisioning_status");
    expect(prov).toContain("ALTER TABLE addresses ADD COLUMN IF NOT EXISTS domain_id");
  });

  test("0011 appends after 0010 and creates the round-2 parity tables + ownership/secret columns", () => {
    const list = emailsSelfHostedMigrations();
    const ids = list.map((m) => m.id);
    expect(ids).toContain("0011_emails_selfhosted_parity_tables_2");
    expect(ids.indexOf("0011_emails_selfhosted_parity_tables_2")).toBeGreaterThan(
      ids.indexOf("0010_emails_selfhosted_provisioning_columns"),
    );
    const sql = Object.fromEntries(list.map((m) => [m.id, m.sql]))["0011_emails_selfhosted_parity_tables_2"]!;
    for (const table of [
      "group_members",
      "sequence_steps",
      "sequence_enrollments",
      "address_ownership_events",
      "webhook_receipts",
      "sandbox_emails",
      "send_key_secrets",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("ALTER TABLE addresses ADD COLUMN IF NOT EXISTS owner_id");
    expect(sql).toContain("ALTER TABLE addresses ADD COLUMN IF NOT EXISTS administrator_id");
    // The send-key hash must NOT live on the generic-resource send_keys table.
    expect(sql).not.toContain("ALTER TABLE send_keys ADD COLUMN IF NOT EXISTS key_hash");
  });
});

describe("self-hosted parity: generic resource round-trips", () => {
  test("aliases create -> list -> get -> delete (protected bool round-trips)", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/aliases", {
      token: writeToken(),
      body: { domain: "x.com", local_part: "ceo", target_address: "boss@x.com", protected: true },
    }));
    expect(create?.status).toBe(201);
    const row = await create!.json();
    expect(row.domain).toBe("x.com");
    expect(row.protected).toBe(true);
    expect(typeof row.id).toBe("string");

    const list = await handleSelfHostedRequest(d, req("GET", "/v1/aliases", { token: readToken() }));
    expect((await list!.json()).items).toHaveLength(1);

    const get = await handleSelfHostedRequest(d, req("GET", `/v1/aliases/${row.id}`, { token: readToken() }));
    expect((await get!.json()).target_address).toBe("boss@x.com");

    const del = await handleSelfHostedRequest(d, req("DELETE", `/v1/aliases/${row.id}`, { token: writeToken() }));
    expect(del?.status).toBe(200);
    const gone = await handleSelfHostedRequest(d, req("GET", `/v1/aliases/${row.id}`, { token: readToken() }));
    expect(gone?.status).toBe(404);
  });

  test("forwarding rule persists the enabled boolean", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/forwarding", {
      token: writeToken(),
      body: { source_address: "a@x.com", target_address: "b@x.com", enabled: false },
    }));
    expect(create?.status).toBe(201);
    expect((await create!.json()).enabled).toBe(false);
  });

  test("warming schedule keeps target_daily_volume as an integer", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/warming", {
      token: writeToken(),
      body: { domain: "x.com", target_daily_volume: 50, start_date: "2026-07-13", status: "active" },
    }));
    const row = await create!.json();
    expect(row.target_daily_volume).toBe(50);
    expect(row.start_date).toBe("2026-07-13");
  });

  test("triage round-trips priority (int) and confidence (real)", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/triage", {
      token: writeToken(),
      body: { inbound_email_id: "ie1", label: "urgent", priority: 1, confidence: 0.87, sentiment: "negative" },
    }));
    const row = await create!.json();
    expect(row.priority).toBe(1);
    expect(row.confidence).toBe(0.87);
    expect(row.label).toBe("urgent");
  });

  test("provisioning event stores detail_json as JSON", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/provisioning", {
      token: writeToken(),
      body: { entity_type: "domain", entity_id: "dom1", to_state: "verifying", detail_json: { attempt: 2 } },
    }));
    const row = await create!.json();
    expect(row.to_state).toBe("verifying");
    expect(row.detail_json).toEqual({ attempt: 2 });
  });

  test("sources store settings_json + provider_snapshot_json objects", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/sources", {
      token: writeToken(),
      body: { mailbox_id: "mb1", type: "ses_s3", name: "SES", settings_json: { bucket: "b" }, provider_snapshot_json: {} },
    }));
    const row = await create!.json();
    expect(row.type).toBe("ses_s3");
    expect(row.settings_json).toEqual({ bucket: "b" });
  });

  test("events store the metadata object", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/events", {
      token: writeToken(),
      body: { provider_id: "p1", type: "delivered", recipient: "a@x.com", metadata: { smtp: "250" }, occurred_at: "2026-07-13T00:00:00.000Z" },
    }));
    const row = await create!.json();
    expect(row.type).toBe("delivered");
    expect(row.metadata).toEqual({ smtp: "250" });
  });

  test("email-agent-runs round-trip json arrays + numeric fields", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/email-agent-runs", {
      token: writeToken(),
      body: {
        agent_key: "labeler", inbound_email_id: "ie1", provider: "external", model: "m", status: "ok",
        labels_json: ["work", "urgent"], priority: 2, confidence: 0.5, risk_score: 10,
        tool_calls_json: [], output_json: { ok: true },
      },
    }));
    const row = await create!.json();
    expect(row.labels_json).toEqual(["work", "urgent"]);
    expect(row.priority).toBe(2);
    expect(row.risk_score).toBe(10);
  });

  test("email-digests round-trip highlight/action arrays and counts", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/email-digests", {
      token: writeToken(),
      body: {
        period: "today", since: "2026-07-13T00:00:00.000Z", until: "2026-07-13T23:59:59.000Z",
        provider: "external", model: "m", status: "ok", message_count: 12,
        highlights_json: ["h1"], action_items_json: ["a1"], important_email_ids_json: ["ie1"], label_counts_json: { work: 3 },
      },
    }));
    const row = await create!.json();
    expect(row.message_count).toBe(12);
    expect(row.highlights_json).toEqual(["h1"]);
    expect(row.label_counts_json).toEqual({ work: 3 });
  });

  test("read scope may GET but not POST a parity resource", async () => {
    const d = deps();
    const list = await handleSelfHostedRequest(d, req("GET", "/v1/warming", { token: readToken() }));
    expect(list?.status).toBe(200);
    const post = await handleSelfHostedRequest(d, req("POST", "/v1/warming", { token: readToken(), body: { domain: "x.com", target_daily_volume: 1 } }));
    expect(post?.status).toBe(403);
  });
});

describe("self-hosted parity: natural-key email-agents (agent_key)", () => {
  test("create is keyed on agent_key and idempotent; get/update address by agent_key", async () => {
    const d = deps();
    const first = await handleSelfHostedRequest(d, req("POST", "/v1/email-agents", {
      token: writeToken(),
      body: { agent_key: "categorizer", enabled: true, provider: "external", config_json: { a: 1 } },
    }));
    expect(first?.status).toBe(201);
    expect((await first!.json()).agent_key).toBe("categorizer");

    // Re-create with the same key upserts to a no-op (idempotent ensure), never a dup.
    const again = await handleSelfHostedRequest(d, req("POST", "/v1/email-agents", {
      token: writeToken(),
      body: { agent_key: "categorizer", enabled: false },
    }));
    expect(again?.status).toBe(201);
    const list = await handleSelfHostedRequest(d, req("GET", "/v1/email-agents", { token: readToken() }));
    expect((await list!.json()).items).toHaveLength(1);

    const get = await handleSelfHostedRequest(d, req("GET", "/v1/email-agents/categorizer", { token: readToken() }));
    expect(get?.status).toBe(200);
    expect((await get!.json()).agent_key).toBe("categorizer");

    const patch = await handleSelfHostedRequest(d, req("PATCH", "/v1/email-agents/categorizer", {
      token: writeToken(),
      body: { enabled: false, always_on: true },
    }));
    expect(patch?.status).toBe(200);
    const patched = await patch!.json();
    expect(patched.enabled).toBe(false);
    expect(patched.always_on).toBe(true);
  });
});

describe("self-hosted parity: mail-views", () => {
  test("GET /v1/messages/threads returns thread rollups (not treated as a message id)", async () => {
    const d = deps();
    let called = false;
    d.store.listThreads = async () => {
      called = true;
      return [{
        thread_key: "invoice", subject: "Invoice", message_count: 3, unread_count: 1,
        last_message_at: "2026-07-13T00:00:00.000Z", first_message_at: "2026-07-01T00:00:00.000Z",
        participants: ["a@x.com", "b@x.com"],
      }];
    };
    // If routing fell through to the single-message matcher, this would throw.
    d.store.getMessage = async () => { throw new Error("routed to getMessage by mistake"); };
    const res = await handleSelfHostedRequest(d, req("GET", "/v1/messages/threads", { token: readToken() }));
    expect(res?.status).toBe(200);
    expect(called).toBe(true);
    expect((await res!.json()).threads[0].message_count).toBe(3);
  });

  test("GET /v1/mailboxes returns mailboxes + folder counts", async () => {
    const d = deps();
    d.store.listMailboxes = async () => ({
      mailboxes: [{ id: "a1", address: "ceo@x.com", display_name: null, status: "active", total: 5, unread: 2 }],
      counts: { inbox: 5, unread: 2, starred: 0, sent: 1, archived: 0, spam: 0, trash: 0, total: 6, latest_received_at: null },
    });
    const res = await handleSelfHostedRequest(d, req("GET", "/v1/mailboxes", { token: readToken() }));
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.mailboxes[0].address).toBe("ceo@x.com");
    expect(body.counts.inbox).toBe(5);
  });

  test("GET /v1/messages/{id}/raw reconstructs MIME, 404 when missing", async () => {
    const d = deps();
    // The route resolves an id PREFIX first; pass it through so this test isolates
    // the raw-reconstruction behavior (resolution is covered by its own suite).
    d.store.resolveMessageId = async (id) => ({ id });
    d.store.getMessageRaw = async (id) => (id === "m1" ? { raw: "From: a@x.com\r\n\r\nhi", message_id: "<m1@x>" } : null);
    const ok = await handleSelfHostedRequest(d, req("GET", "/v1/messages/m1/raw", { token: readToken() }));
    expect(ok?.status).toBe(200);
    expect((await ok!.json()).raw).toContain("From: a@x.com");
    const missing = await handleSelfHostedRequest(d, req("GET", "/v1/messages/nope/raw", { token: readToken() }));
    expect(missing?.status).toBe(404);
  });

  test("mail-views require auth", async () => {
    const d = deps();
    expect((await handleSelfHostedRequest(d, req("GET", "/v1/mailboxes")))?.status).toBe(401);
    expect((await handleSelfHostedRequest(d, req("GET", "/v1/messages/threads")))?.status).toBe(401);
  });

  test("store.getMessageRaw builds RFC822 headers from a stored row", async () => {
    const d = deps();
    d.store.getMessage = async () => ({
      id: "m1", direction: "inbound", from_addr: "a@x.com", to_addrs: ["b@x.com"], cc_addrs: [],
      subject: "Hello", body_text: "Body here", body_html: null, status: "received",
      provider_message_id: null, message_id: "<m1@x>", in_reply_to: null, received_at: "2026-07-13T00:00:00.000Z",
      is_read: false, is_starred: false, labels: [], headers: {}, attachments: [], source_id: null,
      idempotency_key: null, send_payload_hash: null, send_state: "none", send_started_at: null,
      created_at: "2026-07-13T00:00:00.000Z", updated_at: "2026-07-13T00:00:00.000Z",
    });
    const raw = await d.store.getMessageRaw("m1");
    expect(raw?.raw).toContain("From: a@x.com");
    expect(raw?.raw).toContain("To: b@x.com");
    expect(raw?.raw).toContain("Subject: Hello");
    expect(raw?.raw).toContain("\r\n\r\nBody here");
  });
});

describe("self-hosted parity: provisioning fields on domains/addresses", () => {
  test("PATCH /v1/domains applies provisioning fields via applyDomainProvisioning", async () => {
    const d = deps();
    let seen: unknown;
    d.store.updateDomain = async () => ({
      id: "dom1", domain: "x.com", status: "pending", provider: null, verified: false, notes: null,
      created_at: "t", updated_at: "t",
    });
    d.store.applyDomainProvisioning = async (_id, patch) => {
      seen = patch;
      return { id: "dom1", domain: "x.com", status: "pending", provider: null, verified: false, notes: null, provisioning_status: "verifying", cf_zone_id: "z1", nameservers_json: ["ns1"], created_at: "t", updated_at: "t" };
    };
    const res = await handleSelfHostedRequest(d, req("PATCH", "/v1/domains/dom1", {
      token: writeToken(),
      body: { provisioning_status: "verifying", cf_zone_id: "z1", nameservers_json: ["ns1"] },
    }));
    expect(res?.status).toBe(200);
    expect(seen).toEqual({ provisioning_status: "verifying", cf_zone_id: "z1", nameservers_json: ["ns1"] });
    expect((await res!.json()).domain.provisioning_status).toBe("verifying");
  });

  test("PATCH /v1/addresses applies provisioning fields via applyAddressProvisioning", async () => {
    const d = deps();
    let seen: unknown;
    d.store.updateAddress = async () => ({
      id: "a1", email: "a@x.com", domain: "x.com", display_name: null, status: "active", verified: false, daily_quota: null,
      created_at: "t", updated_at: "t",
    });
    d.store.applyAddressProvisioning = async (_id, patch) => {
      seen = patch;
      return { id: "a1", email: "a@x.com", domain: "x.com", display_name: null, status: "active", verified: false, daily_quota: null, provisioning_status: "ready", receive_strategy: "ses-s3", created_at: "t", updated_at: "t" };
    };
    const res = await handleSelfHostedRequest(d, req("PATCH", "/v1/addresses/a1", {
      token: writeToken(),
      body: { provisioning_status: "ready", receive_strategy: "ses-s3", forward_to: null },
    }));
    expect(res?.status).toBe(200);
    expect(seen).toEqual({ provisioning_status: "ready", receive_strategy: "ses-s3", forward_to: null });
    expect((await res!.json()).address.provisioning_status).toBe("ready");
  });
});

describe("self-hosted parity: round-2 generic resources", () => {
  test("group-members create -> list -> get (vars round-trips) -> delete", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/group-members", {
      token: writeToken(),
      // The client pre-serializes vars (JSON.stringify) — mirror that here.
      body: { group_id: "g1", email: "a@x.com", name: "Ada", vars: JSON.stringify({ team: "eng" }), added_at: "2026-07-13T00:00:00.000Z" },
    }));
    expect(create?.status).toBe(201);
    const row = await create!.json();
    expect(row.group_id).toBe("g1");
    expect(row.email).toBe("a@x.com");
    expect(typeof row.id).toBe("string");
    expect(JSON.parse(String(row.vars))).toEqual({ team: "eng" });

    const list = await handleSelfHostedRequest(d, req("GET", "/v1/group-members?group_id=g1", { token: readToken() }));
    expect((await list!.json()).items).toHaveLength(1);

    const get = await handleSelfHostedRequest(d, req("GET", `/v1/group-members/${row.id}`, { token: readToken() }));
    expect((await get!.json()).email).toBe("a@x.com");

    const del = await handleSelfHostedRequest(d, req("DELETE", `/v1/group-members/${row.id}`, { token: writeToken() }));
    expect(del?.status).toBe(200);
  });

  test("sequence-steps keep step_number/delay_hours as integers", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/sequence-steps", {
      token: writeToken(),
      body: { sequence_id: "s1", step_number: 2, delay_hours: 48, template_name: "welcome", from_address: "s@x.com" },
    }));
    expect(create?.status).toBe(201);
    const row = await create!.json();
    expect(row.step_number).toBe(2);
    expect(row.delay_hours).toBe(48);
    expect(row.template_name).toBe("welcome");
  });

  test("sequence-enrollments round-trip current_step + status, filter by sequence_id", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/sequence-enrollments", {
      token: writeToken(),
      body: {
        sequence_id: "s1", contact_email: "c@x.com", provider_id: "p1", current_step: 0,
        status: "active", enrolled_at: "2026-07-13T00:00:00.000Z", next_send_at: null, completed_at: null,
      },
    }));
    expect(create?.status).toBe(201);
    const row = await create!.json();
    expect(row.current_step).toBe(0);
    expect(row.status).toBe("active");

    const patch = await handleSelfHostedRequest(d, req("PATCH", `/v1/sequence-enrollments/${row.id}`, {
      token: writeToken(),
      body: { status: "cancelled" },
    }));
    expect((await patch!.json()).status).toBe("cancelled");

    const list = await handleSelfHostedRequest(d, req("GET", "/v1/sequence-enrollments?sequence_id=s1", { token: readToken() }));
    expect((await list!.json()).items).toHaveLength(1);
  });

  test("address-ownership-events honor the client-supplied id (create then GET by that id)", async () => {
    const d = deps();
    const clientId = "evt-1234";
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/address-ownership-events", {
      token: writeToken(),
      body: {
        id: clientId, address_id: "a1", action: "assign", previous_owner_id: null,
        previous_administrator_id: null, owner_id: "o1", administrator_id: "ag1", actor: "cli", reason: null,
        created_at: "2026-07-13T00:00:00.000Z",
      },
    }));
    expect(create?.status).toBe(201);
    expect((await create!.json()).id).toBe(clientId);

    // The client reads the event straight back by the id it minted — must resolve.
    const get = await handleSelfHostedRequest(d, req("GET", `/v1/address-ownership-events/${clientId}`, { token: readToken() }));
    expect(get?.status).toBe(200);
    const row = await get!.json();
    expect(row.action).toBe("assign");
    expect(row.owner_id).toBe("o1");
  });

  test("webhook-receipts create + list (append-only ledger)", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/webhook-receipts", {
      token: writeToken(),
      body: { provider: "ses", event_id: "evt-9", resource_id: "msg-1", completed_at: "2026-07-13T00:00:00.000Z" },
    }));
    expect(create?.status).toBe(201);
    const row = await create!.json();
    expect(row.provider).toBe("ses");
    expect(row.event_id).toBe("evt-9");
    expect(typeof row.id).toBe("string");

    const list = await handleSelfHostedRequest(d, req("GET", "/v1/webhook-receipts", { token: readToken() }));
    expect((await list!.json()).items).toHaveLength(1);
  });

  test("sandbox-emails round-trip raw arrays + pre-serialized attachments/headers", async () => {
    const d = deps();
    const create = await handleSelfHostedRequest(d, req("POST", "/v1/sandbox-emails", {
      token: writeToken(),
      body: {
        provider_id: "sandbox", from_address: "s@x.com",
        to_addresses: ["a@x.com"], cc_addresses: [], bcc_addresses: [],
        reply_to: null, subject: "Hi", html: "<p>hi</p>", text_body: "hi",
        // to/cc/bcc are raw arrays; attachments/headers arrive pre-serialized.
        attachments_json: JSON.stringify([{ filename: "a.txt" }]),
        headers_json: JSON.stringify({ "X-Test": "1" }),
        created_at: "2026-07-13T00:00:00.000Z",
      },
    }));
    expect(create?.status).toBe(201);
    const row = await create!.json();
    expect(row.subject).toBe("Hi");
    expect(row.to_addresses).toEqual(["a@x.com"]);
    expect(JSON.parse(String(row.attachments_json))).toEqual([{ filename: "a.txt" }]);
    expect(JSON.parse(String(row.headers_json))).toEqual({ "X-Test": "1" });

    const list = await handleSelfHostedRequest(d, req("GET", "/v1/sandbox-emails?provider_id=sandbox", { token: readToken() }));
    expect((await list!.json()).items).toHaveLength(1);
  });
});

describe("self-hosted parity: address ownership over /v1/addresses", () => {
  test("PATCH applies owner_id/administrator_id via applyAddressOwnership", async () => {
    const d = deps();
    d.store.updateAddress = async () => ({
      id: "a1", email: "a@x.com", domain: "x.com", display_name: null, status: "active", verified: false, daily_quota: null,
      created_at: "t", updated_at: "t",
    });
    let seen: unknown;
    d.store.applyAddressOwnership = async (_id, patch) => {
      seen = patch;
      return { id: "a1", email: "a@x.com", domain: "x.com", display_name: null, status: "active", verified: false, daily_quota: null, owner_id: patch.owner_id ?? null, administrator_id: patch.administrator_id ?? null, created_at: "t", updated_at: "t" };
    };
    const res = await handleSelfHostedRequest(d, req("PATCH", "/v1/addresses/a1", {
      token: writeToken(),
      body: { owner_id: "o1", administrator_id: "ag1", updated_at: "ignored" },
    }));
    expect(res?.status).toBe(200);
    expect(seen).toEqual({ owner_id: "o1", administrator_id: "ag1" });
    expect((await res!.json()).address.owner_id).toBe("o1");
  });

  test("PATCH with explicit nulls clears ownership (the unassign path)", async () => {
    const d = deps();
    d.store.updateAddress = async () => ({
      id: "a1", email: "a@x.com", domain: "x.com", display_name: null, status: "active", verified: false, daily_quota: null,
      created_at: "t", updated_at: "t",
    });
    let seen: unknown;
    d.store.applyAddressOwnership = async (_id, patch) => {
      seen = patch;
      return { id: "a1", email: "a@x.com", domain: "x.com", display_name: null, status: "active", verified: false, daily_quota: null, owner_id: null, administrator_id: null, created_at: "t", updated_at: "t" };
    };
    const res = await handleSelfHostedRequest(d, req("PATCH", "/v1/addresses/a1", {
      token: writeToken(),
      body: { owner_id: null, administrator_id: null },
    }));
    expect(res?.status).toBe(200);
    expect(seen).toEqual({ owner_id: null, administrator_id: null });
  });

  test("store.applyAddressOwnership writes then clears the columns", async () => {
    const d = deps();
    const created = await d.store.createAddress({ email: "own@x.com" });
    const assigned = await d.store.applyAddressOwnership(created.id, { owner_id: "o1", administrator_id: "ag1" });
    expect(assigned?.owner_id).toBe("o1");
    expect(assigned?.administrator_id).toBe("ag1");
    const cleared = await d.store.applyAddressOwnership(created.id, { owner_id: null });
    expect(cleared?.owner_id).toBeNull();
  });
});

describe("self-hosted parity: scoped send-key mint/verify routing", () => {
  test("POST /v1/send-keys/mint returns the one-time token + summary (not read as an id)", async () => {
    const d = deps();
    let seen: unknown;
    d.store.mintSendKey = async (input) => {
      seen = input;
      return {
        token: "esk_ONE_TIME",
        key: { id: "k1", owner_id: input.owner_id, prefix: "esk_ONE_TIME", label: input.label ?? null, last_used_at: null, revoked_at: null, created_at: "t", updated_at: "t" },
      };
    };
    // If routing fell through to the generic matcher, "mint" would be read as an id.
    d.store.getResource = async () => { throw new Error("routed to generic getResource by mistake"); };
    const res = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/mint", { token: writeToken(), body: { owner_id: "o1", label: "ci" } }));
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.token).toBe("esk_ONE_TIME");
    expect(body.key.owner_id).toBe("o1");
    expect(seen).toEqual({ owner_id: "o1", label: "ci" });
  });

  test("POST /v1/send-keys/mint requires owner_id and write scope", async () => {
    const d = deps();
    d.store.mintSendKey = async () => ({ token: "x", key: { id: "k", owner_id: "o", prefix: "x", label: null, last_used_at: null, revoked_at: null, created_at: "t", updated_at: "t" } });
    const missing = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/mint", { token: writeToken(), body: {} }));
    expect(missing?.status).toBe(400);
    const forbidden = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/mint", { token: readToken(), body: { owner_id: "o1" } }));
    expect(forbidden?.status).toBe(403);
  });

  test("POST /v1/send-keys/verify resolves a token and confirms from-address scope", async () => {
    const d = deps();
    d.store.verifySendKey = async (token) =>
      token === "esk_ok"
        ? { id: "k1", owner_id: "o1", prefix: "esk_ok", label: null, last_used_at: "t", revoked_at: null, created_at: "t", updated_at: "t" }
        : null;
    d.store.isOwnerAuthorizedFrom = async (ownerId, from) => ownerId === "o1" && from === "mine@x.com";

    // No `from` => the key resolves (valid) but no scope check ran => default-deny.
    const valid = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/verify", { token: writeToken(), body: { token: "esk_ok" } }));
    expect(valid?.status).toBe(200);
    expect(await valid!.json()).toMatchObject({ valid: true, authorized: false });

    const owned = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/verify", { token: writeToken(), body: { token: "esk_ok", from: "mine@x.com" } }));
    expect((await owned!.json()).authorized).toBe(true);

    const foreign = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/verify", { token: writeToken(), body: { token: "esk_ok", from: "victim@x.com" } }));
    expect((await foreign!.json()).authorized).toBe(false);

    const bad = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/verify", { token: writeToken(), body: { token: "esk_bad" } }));
    expect(await bad!.json()).toEqual({ valid: false, authorized: false, key: null });

    const noToken = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/verify", { token: writeToken(), body: {} }));
    expect(noToken?.status).toBe(400);
  });

  test("send-key verify rejects the read scope (it mutates last_used_at)", async () => {
    const d = deps();
    d.store.verifySendKey = async () => null;
    const res = await handleSelfHostedRequest(d, req("POST", "/v1/send-keys/verify", { token: readToken(), body: { token: "esk_x" } }));
    expect(res?.status).toBe(403);
  });
});
