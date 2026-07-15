import { describe, expect, it, test } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { testAuthDeps, selfScopedStore } from "./auth/test-support.js";
import { emailsSelfHostedMigrations } from "./migrations.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

// Column order the store inserts with (see EmailsSelfHostedStore.INSERT_COLS).
const COLS = [
  "id", "direction", "from_addr", "to_addrs", "cc_addrs", "subject", "body_text",
  "body_html", "status", "provider_message_id", "message_id", "in_reply_to",
  "received_at", "is_read", "is_starred", "labels", "headers", "attachments", "source_id",
  "idempotency_key", "send_payload_hash", "send_state", "send_started_at",
];

/**
 * In-memory query client that models JUST the `messages` table well enough to
 * exercise insert, ON CONFLICT (source_id) upsert, list ordering, and get-by-id.
 */
function messagesClient(): { client: TypedQueryClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];

  function rowFromParams(params: readonly unknown[]): Record<string, unknown> {
    const r: Record<string, unknown> = {};
    COLS.forEach((c, i) => (r[c] = params[i] ?? null));
    const now = new Date().toISOString();
    r["created_at"] = now;
    r["updated_at"] = now;
    return r;
  }

  const client: TypedQueryClient = {
    async query(sql, params) {
      const rowsOut = (await client.many(sql, params)) as never[];
      return { rows: rowsOut, rowCount: rowsOut.length };
    },
    async many<T>(sql: string, _params?: readonly unknown[]): Promise<T[]> {
      if (sql.includes("SELECT 1")) return [{ ok: 1 } as unknown as T];
      if (sql.includes("FROM messages")) {
        const sorted = [...rows].sort((a, b) => {
          const av = String(a["received_at"] ?? a["created_at"] ?? "");
          const bv = String(b["received_at"] ?? b["created_at"] ?? "");
          return bv.localeCompare(av);
        });
        return sorted as unknown as T[];
      }
      return [] as T[];
    },
    async get<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      if (sql.includes("attachments ->")) {
        const row = rows.find((item) => item["id"] === (params ?? [])[0]);
        const raw = row?.["attachments"];
        const attachments = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) as unknown[] : [];
        return ({ attachment: attachments[Number((params ?? [])[1])] ?? null } as unknown as T);
      }
      if (sql.startsWith("INSERT INTO messages") && sql.includes("idempotency_key")) {
        const incoming = rowFromParams(params ?? []);
        const duplicate = rows.find((row) => row["idempotency_key"] === incoming["idempotency_key"]);
        if (duplicate) return null;
        rows.push(incoming);
        return incoming as unknown as T;
      }
      if (sql.includes("FROM messages WHERE idempotency_key")) {
        return (rows.find((row) => row["idempotency_key"] === (params ?? [])[0]) as unknown as T) ?? null;
      }
      if (sql.startsWith("UPDATE messages SET send_state = 'sending'")) {
        const row = rows.find((item) => item["id"] === (params ?? [])[0] && item["send_state"] === "pending");
        if (!row) return null;
        row["send_state"] = "sending";
        row["send_started_at"] = new Date().toISOString();
        return row as unknown as T;
      }
      if (sql.startsWith("UPDATE messages SET send_state = 'sent'")) {
        const row = rows.find((item) => item["id"] === (params ?? [])[0]);
        if (!row) return null;
        row["send_state"] = "sent";
        row["status"] = "sent";
        row["provider_message_id"] = (params ?? [])[1];
        return row as unknown as T;
      }
      if (sql.startsWith("UPDATE messages SET send_state = 'uncertain'")) {
        const row = rows.find((item) => item["id"] === (params ?? [])[0]);
        if (!row || row["send_state"] === "sent") return null;
        row["send_state"] = "uncertain";
        row["status"] = "uncertain";
        return row as unknown as T;
      }
      if (sql.includes("FROM messages WHERE id")) {
        const id = (params ?? [])[0];
        return (rows.find((r) => r["id"] === id) as unknown as T) ?? null;
      }
      return null;
    },
    async one<T>(sql: string, params?: readonly unknown[]): Promise<T> {
      if (sql.includes("INSERT INTO messages")) {
        const incoming = rowFromParams(params ?? []);
        const isUpsert = sql.includes("ON CONFLICT") && sql.includes("source_id");
        if (isUpsert && incoming["source_id"] != null) {
          const existing = rows.find((r) => r["source_id"] === incoming["source_id"]);
          if (existing) {
            for (const c of COLS) if (c !== "id") existing[c] = incoming[c];
            existing["updated_at"] = new Date().toISOString();
            return { ...existing, inserted: false } as unknown as T;
          }
        }
        rows.push(incoming);
        return { ...incoming, inserted: true } as unknown as T;
      }
      throw new Error(`unexpected one() SQL: ${sql.slice(0, 40)}`);
    },
    async execute() {},
  };
  return { client, rows };
}

function deps(): SelfHostedServiceDeps {
  const { client } = messagesClient();
  const store = selfScopedStore(client);
  // These message-state-machine tests isolate provider/idempotency behavior from
  // the independently-covered outbound policy store. Explicitly allow by default;
  // denial tests override this method below.
  (store as unknown as { evaluateOutboundPolicy: () => Promise<{ allowed: true }> }).evaluateOutboundPolicy =
    async () => ({ allowed: true });
  return {
    client,
    store,
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => "provider-message-id" },
    migrations: emailsSelfHostedMigrations(),
    version: "9.9.9",
    ...testAuthDeps(client, SIGNING_SECRET),
  };
}

function writeToken(): string {
  return mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET }).token;
}

function post(body: unknown, token = writeToken()): Request {
  return new Request("http://svc/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": token },
    body: JSON.stringify(body),
  });
}

const INBOUND = {
  from: '"Facebook" <friendsuggestion@facebookmail.com>',
  to: ["andrei@hasna.com"],
  cc: ["team@hasna.com"],
  subject: "Oana is a new friend suggestion",
  text: "plain body",
  html: "<p>html body</p>",
  status: "received",
  direction: "inbound",
  received_at: "2026-06-18T19:51:35.000Z",
  message_id: "<abc123@facebookmail.com>",
  in_reply_to: "<parent@x.com>",
  is_read: false,
  is_starred: true,
  labels: ["social", "facebook"],
  headers: { "x-spam-score": "0.1" },
  attachments: [{ filename: "a.png", size: 12 }],
  source_id: "local-row-1",
};

describe("Emails self-hosted inbound messages", () => {
  test("migration set includes the inbound schema migration", () => {
    const ids = emailsSelfHostedMigrations().map((m) => m.id);
    expect(ids).toContain("0002_mailery_messages_inbound");
    // Inbound must come after the core message table.
    expect(ids.indexOf("0002_mailery_messages_inbound")).toBeGreaterThan(
      ids.indexOf("0001_mailery_selfhosted_core"),
    );
  });

  test("POST inbound preserves all fields and returns 201", async () => {
    const res = await handleSelfHostedRequest(deps(), post(INBOUND));
    expect(res?.status).toBe(201);
    const msg = (await res!.json()).message;
    expect(msg.direction).toBe("inbound");
    expect(msg.from_addr).toBe(INBOUND.from);
    expect(msg.to_addrs).toEqual(["andrei@hasna.com"]);
    expect(msg.cc_addrs).toEqual(["team@hasna.com"]);
    expect(msg.subject).toBe(INBOUND.subject);
    expect(msg.body_text).toBe("plain body");
    expect(msg.body_html).toBe("<p>html body</p>");
    expect(msg.received_at).toBe(INBOUND.received_at);
    expect(msg.message_id).toBe(INBOUND.message_id);
    expect(msg.in_reply_to).toBe(INBOUND.in_reply_to);
    expect(msg.is_read).toBe(false);
    expect(msg.is_starred).toBe(true);
    expect(msg.labels).toEqual(["social", "facebook"]);
    expect(msg.headers).toEqual({ "x-spam-score": "0.1" });
    expect(msg.attachments).toEqual([{ filename: "a.png", size: 12 }]);
    expect(msg.source_id).toBe("local-row-1");
  });

  test("inbound is inferred from received_at when direction is omitted", async () => {
    const { direction: _omit, ...noDirection } = INBOUND;
    const res = await handleSelfHostedRequest(deps(), post({ ...noDirection, source_id: "x" }));
    const msg = (await res!.json()).message;
    expect(msg.direction).toBe("inbound");
  });

  test("re-POST with the same source_id is idempotent (upsert, no duplicate)", async () => {
    const d = deps();
    const first = await handleSelfHostedRequest(d, post(INBOUND));
    expect(first?.status).toBe(201);
    const second = await handleSelfHostedRequest(d, post({ ...INBOUND, is_read: true }));
    expect(second?.status).toBe(200); // updated, not created
    const list = await handleSelfHostedRequest(d, req(d, "GET"));
    const body = await list!.json();
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].is_read).toBe(true); // reflects the update
  });

  test("GET /v1/messages orders by original receipt time (newest first)", async () => {
    const d = deps();
    await handleSelfHostedRequest(d, post({ ...INBOUND, source_id: "older", received_at: "2026-06-01T00:00:00.000Z" }));
    await handleSelfHostedRequest(d, post({ ...INBOUND, source_id: "newer", received_at: "2026-06-30T00:00:00.000Z" }));
    const list = await handleSelfHostedRequest(d, req(d, "GET"));
    const msgs = (await list!.json()).messages;
    expect(msgs.map((m: { source_id: string }) => m.source_id)).toEqual(["newer", "older"]);
  });

  test("GET /v1/messages omits full bodies while detail keeps them API-only", async () => {
    const d = deps();
    const created = await handleSelfHostedRequest(d, post({
      ...INBOUND,
      source_id: "lean-list",
      text: `plain body ${"x".repeat(800)}`,
      html: `<p>html body ${"x".repeat(800)}</p>`,
    }));
    const createdMessage = (await created!.json()).message;

    const list = await handleSelfHostedRequest(d, req(d, "GET"));
    const listed = (await list!.json()).messages[0];
    expect(listed.body_text).toBeUndefined();
    expect(listed.body_html).toBeUndefined();
    expect(listed.snippet).toStartWith("plain body");
    expect(listed.snippet.length).toBeLessThanOrEqual(500);

    const detail = await handleSelfHostedRequest(d, new Request(
      `http://svc/v1/messages/${encodeURIComponent(createdMessage.id)}`,
      { headers: { "x-api-key": writeToken() } },
    ));
    const detailed = (await detail!.json()).message;
    expect(detailed.body_text).toContain("plain body");
    expect(detailed.body_html).toContain("html body");
  });

  test("keeps attachment bytes out of message reads and serves them from the authenticated attachment route", async () => {
    const d = deps();
    const content = Buffer.from("attachment body").toString("base64");
    const created = await handleSelfHostedRequest(d, post({
      ...INBOUND,
      source_id: "attachment-source",
      attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 15, content_base64: content }],
    }));
    const message = (await created!.json()).message;
    expect(message.attachments[0].content_base64).toBeUndefined();
    const attachment = await handleSelfHostedRequest(d, new Request(
      `http://svc/v1/messages/${encodeURIComponent(message.id)}/attachments/0`,
      { headers: { "x-api-key": writeToken() } },
    ));
    expect(attachment?.status).toBe(200);
    expect((await attachment!.json()).attachment.content_base64).toBe(content);
    const abbreviated = await handleSelfHostedRequest(d, new Request(
      `http://svc/v1/messages/${encodeURIComponent(message.id.slice(0, 8))}/attachments/0`,
      { headers: { "x-api-key": writeToken() } },
    ));
    expect(abbreviated?.status).toBe(404);
    expect((await abbreviated!.json()).code).toBe("message_not_found");
  });

  test("distinguishes absent content/index and rejects oversized or malformed stored bytes", async () => {
    const d = deps();
    const created = await handleSelfHostedRequest(d, post({
      ...INBOUND,
      source_id: "attachment-negative-source",
      attachments: [
        { filename: "metadata.txt", content_type: "text/plain", size: 5 },
        { filename: "valid.txt", content_type: "text/plain", size: 5, content_base64: "aGVsbG8=" },
        { filename: "invalid.txt", content_type: "text/plain", size: 5, content_base64: "not base64" },
      ],
    }));
    const message = (await created!.json()).message;
    const get = (index: number, suffix = "") => handleSelfHostedRequest(d, new Request(
      `http://svc/v1/messages/${encodeURIComponent(message.id)}/attachments/${index}${suffix}`,
      { headers: { "x-api-key": writeToken() } },
    ));

    const unavailable = await get(0);
    expect(unavailable?.status).toBe(409);
    expect((await unavailable!.json()).code).toBe("attachment_content_unavailable");
    expect((await get(99))?.status).toBe(404);
    expect((await get(1, "?max_bytes=4"))?.status).toBe(413);
    expect((await get(2))?.status).toBe(422);
  });

  test("outbound ledger-only writes are rejected", async () => {
    const res = await handleSelfHostedRequest(
      deps(),
      post({ from: "me@hasna.com", to: ["you@x.com"], subject: "hi", text: "yo" }),
    );
    expect(res?.status).toBe(409);
    expect((await res!.json()).error).toContain("/v1/messages/send");
  });

  test("send endpoint invokes the configured provider before persisting", async () => {
    const d = deps();
    const sent: unknown[] = [];
    d.sender = { provider: "ses", send: async (input) => { sent.push(input); return "ses-message-1"; } };
    const res = await handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({ from: "me@example.com", to: ["you@example.com"], subject: "hi", text: "yo", idempotency_key: "send-1" }),
    }));
    expect(res?.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect((await res!.json()).message.provider_message_id).toBe("ses-message-1");
  });

  test("outbound policy denial is durably blocked before any provider side effect", async () => {
    const d = deps();
    let sends = 0;
    d.sender = { provider: "ses", send: async () => { sends++; return "must-not-send"; } };
    d.store.evaluateOutboundPolicy = async () => ({
      allowed: false,
      code: "recipient_suppressed",
      message: "one or more recipients are suppressed",
      status: 409,
    });
    d.store.markSendBlocked = async (id, reason) => {
      const current = await d.store.getMessage(id);
      return current ? { ...current, status: "blocked", send_state: "blocked", headers: { policy_denial: reason } } : null;
    };
    const res = await handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({
        from: "me@example.com",
        to: ["blocked@example.com"],
        subject: "must block",
        idempotency_key: "blocked-policy-key",
      }),
    }));
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ reason: "recipient_suppressed", retry_safe: false });
    expect(sends).toBe(0);
  });

  it("returns the same completed intent on retry without sending twice", async () => {
    const d = deps();
    let sends = 0;
    d.sender = { provider: "ses", send: async () => { sends++; return "ses-once"; } };
    const request = () => new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({ from: "me@example.com", to: ["you@example.com"], subject: "once", idempotency_key: "stable-key" }),
    });
    const first = await handleSelfHostedRequest(d, request());
    const second = await handleSelfHostedRequest(d, request());
    expect(first?.status).toBe(202);
    expect(second?.status).toBe(200);
    const replay = await second!.json();
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.message.idempotency_key).toBeUndefined();
    expect(replay.message.send_payload_hash).toBeUndefined();
    expect(sends).toBe(1);
  });

  it("resumes a durable pending intent left by a crash before provider claim", async () => {
    const d = deps();
    const reserve = d.store.reserveSendIntent.bind(d.store);
    d.store.reserveSendIntent = async (input) => {
      const result = await reserve(input);
      return { record: result.record, created: false };
    };
    let sends = 0;
    d.sender = { provider: "ses", send: async () => { sends++; return "ses-resumed"; } };
    const res = await handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({ from: "me@example.com", to: ["you@example.com"], subject: "resume", idempotency_key: "pending-key" }),
    }));
    expect(res?.status).toBe(202);
    expect(sends).toBe(1);
  });

  it("refuses to reuse an idempotency key for a different payload", async () => {
    const d = deps();
    const send = (subject: string) => handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({ from: "me@example.com", to: ["you@example.com"], subject, idempotency_key: "conflict-key" }),
    }));
    expect((await send("first"))?.status).toBe(202);
    const conflict = await send("different");
    expect(conflict?.status).toBe(409);
    expect((await conflict!.json()).retry_safe).toBe(false);
  });

  it("marks an expired sending lease uncertain instead of replaying the provider", async () => {
    const d = deps();
    const reserve = d.store.reserveSendIntent.bind(d.store);
    d.store.reserveSendIntent = async (input) => {
      const result = await reserve(input);
      const claimed = await d.store.claimSendIntent(result.record.id);
      return { record: { ...claimed!, send_started_at: "2000-01-01T00:00:00.000Z" }, created: false };
    };
    let sends = 0;
    d.sender = { provider: "ses", send: async () => { sends++; return "must-not-send"; } };
    const res = await handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({ from: "me@example.com", to: ["you@example.com"], subject: "stale", idempotency_key: "stale-key" }),
    }));
    expect(res?.status).toBe(409);
    expect((await res!.json()).retry_safe).toBe(false);
    expect(sends).toBe(0);
  });

  it("rejects malformed or oversized inline attachments before reserving a send", async () => {
    const d = deps();
    const send = (content: string) => handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({
        from: "me@example.com", to: ["you@example.com"], subject: "attachment", idempotency_key: crypto.randomUUID(),
        attachments: [{ filename: "x.bin", content }],
      }),
    }));
    expect((await send("not-base64"))?.status).toBe(400);
    expect((await send(Buffer.alloc(513 * 1024).toString("base64")))?.status).toBe(400);
  });

  it("rejects outbound header injection before reservation or provider send", async () => {
    const d = deps();
    let sends = 0;
    let reservations = 0;
    const reserve = d.store.reserveSendIntent.bind(d.store);
    d.store.reserveSendIntent = async (input) => { reservations++; return reserve(input); };
    d.sender = { provider: "ses", send: async () => { sends++; return "must-not-send"; } };
    const attachment = {
      filename: "safe.txt",
      content: Buffer.from("safe").toString("base64"),
      content_type: "text/plain",
    };
    const base = { from: "me@example.com", to: ["you@example.com"], subject: "safe", attachments: [attachment] };
    const attacks = [
      { from: "me@example.com\r\nBcc: victim@example.com" },
      { to: ["you@example.com\nCc: victim@example.com"] },
      { cc: ["copy@example.com\r\nBcc: victim@example.com"] },
      { bcc: ["blind@example.com\r\nX-Evil: yes"] },
      { subject: "safe\r\nBcc: victim@example.com" },
      { reply_to: "reply@example.com\nBcc: victim@example.com" },
      { attachments: [{ ...attachment, filename: "safe.txt\r\nBcc: victim@example.com" }] },
      { attachments: [{ ...attachment, filename: "bad-\uD800-name.txt" }] },
      { attachments: [{ ...attachment, content_type: "text/plain; name=evil" }] },
    ];
    for (const attack of attacks) {
      const res = await handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
        body: JSON.stringify({ ...base, ...attack, idempotency_key: crypto.randomUUID() }),
      }));
      expect(res?.status).toBe(400);
    }
    expect(reservations).toBe(0);
    expect(sends).toBe(0);
  });

  it("concurrent duplicate sends invoke the provider at most once", async () => {
    const d = deps();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    d.sender = { provider: "ses", send: async () => { sends++; await gate; return "ses-concurrent"; } };
    const request = () => new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({ from: "me@example.com", to: ["you@example.com"], subject: "race", idempotency_key: "race-key" }),
    });
    const first = handleSelfHostedRequest(d, request());
    await Bun.sleep(1);
    const second = await handleSelfHostedRequest(d, request());
    release();
    const firstResult = await first;
    expect(firstResult?.status).toBe(202);
    expect(second?.status).toBe(202);
    expect((await second!.json()).in_progress).toBe(true);
    expect(sends).toBe(1);
  });

  it("marks provider-success ledger failures uncertain and never reports retry-safe", async () => {
    const d = deps();
    d.sender = { provider: "ses", send: async () => "provider-accepted" };
    d.store.completeSendIntent = async () => { throw new Error("database write failed"); };
    const res = await handleSelfHostedRequest(d, new Request("http://svc/v1/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
      body: JSON.stringify({ from: "me@example.com", to: ["you@example.com"], subject: "crash", idempotency_key: "crash-key" }),
    }));
    const body = await res!.json();
    expect(res?.status).toBe(502);
    expect(body.error).toContain("ledger finalization failed");
    expect(body.retry_safe).toBe(false);
    expect(body.message.send_state).toBe("uncertain");
  });

  test("POST still requires from and to", async () => {
    const noFrom = await handleSelfHostedRequest(deps(), post({ to: ["a@b.com"] }));
    expect(noFrom?.status).toBe(400);
    const noTo = await handleSelfHostedRequest(deps(), post({ from: "a@b.com" }));
    expect(noTo?.status).toBe(400);
  });
});

function req(d: SelfHostedServiceDeps, method: string): Request {
  void d;
  return new Request("http://svc/v1/messages", {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": writeToken() },
  });
}
