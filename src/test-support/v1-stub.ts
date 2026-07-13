// Reusable /v1 stub-server test helper for the self-hosted-ONLY client.
//
// WHY A SEPARATE PROCESS: the client's resource store (src/db/self-hosted-store.ts)
// performs its HTTP call SYNCHRONOUSLY via a spawned `curl` (spawnSync), which
// blocks Bun's event loop. An in-process `Bun.serve` on the same loop would
// deadlock (it can never accept the connection while the main thread is parked in
// spawnSync). So the stub runs OUT OF PROCESS, exactly like
// src/cli/commands/domain.self-hosted.test.ts and
// src/db/self-hosted-resource-routing.test.ts. Because it listens on a real TCP
// port it ALSO serves the async fetch path used by SelfHostedMailDataSource, so
// one helper covers db repos, CLI commands, MCP tools, and inbox/mail reads.
//
// WHAT IT SERVES (all under /v1, Bearer-authenticated):
//   - Generic CRUD for any resource: GET/POST /v1/<resource>,
//     GET/PATCH/PUT/DELETE /v1/<resource>/<id>. Lists are returned under both the
//     resource key and `items` so the store's envelope extraction always resolves.
//     Single entities are returned as `{ <singular>: entity }`.
//   - Messages semantics matching the real API and the mail-data-source fake:
//     GET /v1/messages (direction/to/from/subject/search/since/limit/offset filters,
//     newest-first), GET /v1/messages/counts, POST /v1/messages/send.
//   - Control endpoints (unauthenticated so a beforeEach can always reset):
//     POST /v1/__reset  { resources? }  -> replace the whole store (empty clears it)
//     GET  /v1/__dump                   -> read the whole store back for assertions
//
// SAFETY: no secret is ever logged. The API key lives only in the subprocess env
// and the Authorization header; the helper never prints it.

import { resetSelfHostedConfigCache } from "../db/self-hosted-store.js";
import { resetMailDataSource } from "../lib/mail-data-source.js";

/** Seed data keyed by /v1 resource name (e.g. `{ domains: [...], messages: [...] }`). */
export type V1StubResources = Record<string, Array<Record<string, unknown>>>;

export interface V1StubOptions {
  /** Bearer key the stub requires (default: a fixed test key). */
  apiKey?: string;
  /** Initial resources. Also used as the baseline restored by `reset()`. */
  seed?: V1StubResources;
}

export interface V1Stub {
  /** Origin only, e.g. `http://127.0.0.1:PORT` (NO trailing `/v1`). */
  readonly baseUrl: string;
  /** The Bearer key the stub requires. */
  readonly apiKey: string;
  /** Replace the entire store with `resources`. */
  seed(resources: V1StubResources): Promise<void>;
  /** Restore the store to the initial seed passed to `startV1Stub` (or empty). */
  reset(): Promise<void>;
  /** Read a resource's current rows back from the stub (for assertions). */
  list(resource: string): Promise<Array<Record<string, unknown>>>;
  /** Read the entire store back from the stub. */
  dump(): Promise<V1StubResources>;
  /**
   * Point the client at this stub: EMAILS_MODE=self_hosted, EMAILS_SELF_HOSTED_URL,
   * EMAILS_SELF_HOSTED_API_KEY, then reset the config + mail-data-source caches.
   * Call in `beforeEach`.
   */
  applyEnv(): void;
  /** Remove the env this helper set and reset caches. Call in `afterEach`. */
  clearEnv(): void;
  /** Kill the subprocess. Call in `afterAll`. */
  stop(): void;
}

const DEFAULT_API_KEY = "hasna_emails_stub_key_0123456789";

// The stub server. Kept free of backticks and `${}` so it embeds cleanly in this
// module's template literal. Reads its key + seed from env; announces its port.
const SERVER_SRC = String.raw`
const KEY = process.env.V1_STUB_API_KEY || "";
let store = safeParse(process.env.V1_STUB_SEED);
// Secret token -> send-key id map. Kept OUT of the store object so it is never
// returned by __dump (a send token must never leave the server). Cleared on __reset.
let sendTokens = {};

function safeParse(raw) {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}
function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } });
}
function singular(r) {
  if (r.endsWith("es") && (r.endsWith("sses") || r.endsWith("ches") || r.endsWith("xes"))) return r.slice(0, -2);
  if (r.endsWith("s")) return r.slice(0, -1);
  return r;
}
function rowsFor(resource) {
  if (!Array.isArray(store[resource])) store[resource] = [];
  return store[resource];
}
function includesText(value, query) {
  if (!query) return true;
  return String(value == null ? "" : value).toLowerCase().includes(String(query).toLowerCase());
}
function hasLabel(row, label) {
  return Array.isArray(row.labels) && row.labels.some(function (v) { return String(v).toLowerCase() === label; });
}
function isOutbound(row) { return String(row.direction || "").toLowerCase() === "outbound"; }

// Send-key From-scope check, mirroring the server: an owner may send from an
// address it OWNS or ADMINISTERS. Canonicalizes the From (a single angle-addr or a
// bare email); an ambiguous/multi-angle From is denied (spoofing resistance).
function canonicalFrom(value) {
  const s = String(value == null ? "" : value).trim().toLowerCase();
  if (!s) return "";
  const angles = s.match(/<[^>]*>/g);
  if (angles && angles.length === 1) {
    const inner = angles[0].slice(1, -1).trim();
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(inner) ? inner : "";
  }
  if (angles && angles.length > 1) return "";
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) ? s : "";
}
function isOwnerAuthorizedFrom(ownerId, from) {
  const email = canonicalFrom(from);
  if (!email || !ownerId) return false;
  return rowsFor("addresses").some(function (a) {
    return String(a.email == null ? "" : a.email).toLowerCase() === email &&
      (String(a.owner_id) === String(ownerId) || String(a.administrator_id) === String(ownerId));
  });
}

function listMessages(params) {
  let ordered = rowsFor("messages").slice().sort(function (a, b) {
    return String(b.received_at || b.created_at || "").localeCompare(String(a.received_at || a.created_at || ""));
  });
  const direction = params.get("direction");
  if (direction) ordered = ordered.filter(function (r) { return String(r.direction || "").toLowerCase() === direction; });
  const to = params.get("to");
  if (to) ordered = ordered.filter(function (r) { return String(r.to_addrs || "").toLowerCase().includes(to.toLowerCase()); });
  ordered = ordered.filter(function (r) { return includesText(r.from_addr, params.get("from")); });
  ordered = ordered.filter(function (r) { return includesText(r.subject, params.get("subject")); });
  const search = params.get("search");
  if (search) {
    ordered = ordered.filter(function (r) {
      const hay = [r.from_addr, r.to_addrs, r.subject, r.body_text].join(" ").toLowerCase();
      return hay.includes(search.toLowerCase());
    });
  }
  const since = params.get("since");
  if (since) {
    const cutoff = Date.parse(since);
    ordered = ordered.filter(function (r) {
      const t = Date.parse(String(r.received_at || r.created_at || ""));
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  const limit = Number(params.get("limit") || "500");
  const offset = Number(params.get("offset") || "0");
  return ordered.slice(offset, offset + limit);
}

function messageCounts() {
  const messages = rowsFor("messages");
  const inboxRows = messages.filter(function (r) {
    return !isOutbound(r) && !hasLabel(r, "archived") && !hasLabel(r, "spam") && !hasLabel(r, "trash");
  });
  let latest = null;
  for (const r of messages) {
    if (isOutbound(r)) continue;
    const d = String(r.received_at || r.created_at || "");
    if (d && (latest === null || d > latest)) latest = d;
  }
  return {
    inbox: inboxRows.length,
    unread: inboxRows.filter(function (r) { return !r.is_read; }).length,
    starred: messages.filter(function (r) {
      return !isOutbound(r) && Boolean(r.is_starred) && !hasLabel(r, "archived") && !hasLabel(r, "spam") && !hasLabel(r, "trash");
    }).length,
    sent: messages.filter(isOutbound).length,
    archived: messages.filter(function (r) { return !isOutbound(r) && hasLabel(r, "archived") && !hasLabel(r, "spam") && !hasLabel(r, "trash"); }).length,
    spam: messages.filter(function (r) { return !isOutbound(r) && (hasLabel(r, "spam") || String(r.status || "").toLowerCase() === "spam"); }).length,
    trash: messages.filter(function (r) { return !isOutbound(r) && hasLabel(r, "trash"); }).length,
    total: messages.length,
    latest_received_at: latest,
  };
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");

    // Control endpoints (unauthenticated).
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "__reset") {
      const body = await req.json().catch(function () { return {}; });
      store = body && body.resources ? body.resources : {};
      sendTokens = {};
      return json({ ok: true });
    }
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "__dump") {
      return json({ resources: store });
    }

    if (KEY && req.headers.get("authorization") !== "Bearer " + KEY) return json({ error: "unauthorized" }, 401);
    if (parts[0] !== "v1" || !parts[1]) return json({ error: "not found" }, 404);

    const resource = parts[1];
    const sub = parts[2];
    const id = sub !== undefined ? decodeURIComponent(sub) : undefined;

    // Messages special endpoints.
    if (resource === "messages" && sub === "counts" && req.method === "GET") {
      return json({ counts: messageCounts() });
    }
    if (resource === "messages" && sub === "send" && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const now = new Date().toISOString();
      const rec = Object.assign(
        { id: crypto.randomUUID(), direction: "outbound", status: "sent", is_read: true, labels: [] },
        body,
        { message_id: "stub-" + (rowsFor("messages").length + 1), created_at: now, updated_at: now },
      );
      rowsFor("messages").push(rec);
      return json({ message: rec }, 201);
    }
    if (resource === "messages" && id === undefined && req.method === "GET") {
      return json({ messages: listMessages(url.searchParams) });
    }

    // Scoped send keys: bespoke mint/verify (matched before the generic matcher so
    // "mint"/"verify" are not read as a send-key id). Mirrors the server: the token
    // and its hash live ONLY here; the generic /v1/send-keys resource is summary-only.
    if (resource === "send-keys" && sub === "mint" && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const ownerId = String(body.owner_id == null ? "" : body.owner_id).trim();
      if (!ownerId) return json({ error: "owner_id is required" }, 400);
      const label = body.label == null ? null : String(body.label);
      const ts = new Date().toISOString();
      const token = "esk_" + crypto.randomUUID().replace(/-/g, "");
      const keyId = crypto.randomUUID();
      const key = {
        id: keyId, owner_id: ownerId, prefix: token.slice(0, 12), label: label,
        last_used_at: null, revoked_at: null, created_at: ts, updated_at: ts,
      };
      rowsFor("send-keys").push(key);
      sendTokens[token] = keyId;
      return json({ token: token, key: key }, 201);
    }
    if (resource === "send-keys" && sub === "verify" && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const token = typeof body.token === "string" ? body.token : "";
      if (!token.trim()) return json({ error: "token is required" }, 400);
      const keyId = sendTokens[token];
      const key = keyId ? rowsFor("send-keys").find(function (r) { return String(r.id) === String(keyId); }) : null;
      if (!key || key.revoked_at) return json({ valid: false, authorized: false, key: null });
      key.last_used_at = new Date().toISOString();
      key.updated_at = key.last_used_at;
      const from = typeof body.from === "string" ? body.from.trim() : "";
      if (!from) return json({ valid: true, authorized: false, key: key });
      return json({ valid: true, authorized: isOwnerAuthorizedFrom(key.owner_id, from), key: key });
    }

    const rows = rowsFor(resource);

    if (id === undefined && req.method === "GET") {
      const out = {};
      out[resource] = rows;
      out.items = rows;
      return json(out);
    }
    if (id === undefined && req.method === "POST") {
      const body = await req.json().catch(function () { return {}; });
      const now = new Date().toISOString();
      const entity = Object.assign(
        { id: body && body.id ? body.id : crypto.randomUUID() },
        body,
        { created_at: (body && body.created_at) || now, updated_at: now },
      );
      rows.push(entity);
      const wrap = {};
      wrap[singular(resource)] = entity;
      return json(wrap, 201);
    }
    if (id !== undefined && req.method === "GET") {
      const e = rows.find(function (r) { return String(r.id) === id; });
      if (!e) return json({ error: "not found" }, 404);
      const wrap = {};
      wrap[singular(resource)] = e;
      return json(wrap);
    }
    if (id !== undefined && (req.method === "PATCH" || req.method === "PUT")) {
      const e = rows.find(function (r) { return String(r.id) === id; });
      if (!e) return json({ error: "not found" }, 404);
      const patch = await req.json().catch(function () { return {}; });
      Object.assign(e, patch, { updated_at: new Date().toISOString() });
      const wrap = {};
      wrap[singular(resource)] = e;
      return json(wrap);
    }
    if (id !== undefined && req.method === "DELETE") {
      const i = rows.findIndex(function (r) { return String(r.id) === id; });
      if (i < 0) return json({ error: "not found" }, 404);
      rows.splice(i, 1);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  },
});
console.log("PORT=" + server.port);
`;

const MODE_ENV = "EMAILS_MODE";
const URL_ENV = "EMAILS_SELF_HOSTED_URL";
const KEY_ENV = "EMAILS_SELF_HOSTED_API_KEY";

/**
 * Start an out-of-process /v1 stub server and return a handle for driving it.
 *
 * Typical use:
 *
 *   let stub: V1Stub;
 *   beforeAll(async () => { stub = await startV1Stub({ seed: { domains: [...] } }); });
 *   afterAll(() => stub.stop());
 *   beforeEach(async () => { await stub.reset(); stub.applyEnv(); });
 *   afterEach(() => stub.clearEnv());
 */
export async function startV1Stub(options: V1StubOptions = {}): Promise<V1Stub> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const initialSeed = JSON.stringify(options.seed ?? {});

  const proc = Bun.spawn(["bun", "-e", SERVER_SRC], {
    env: { ...process.env, V1_STUB_API_KEY: apiKey, V1_STUB_SEED: initialSeed },
    stdout: "pipe",
    stderr: "inherit",
  });

  // Read the announced port from stdout.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let baseUrl = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const match = buffer.match(/PORT=(\d+)/);
    if (match) {
      baseUrl = `http://127.0.0.1:${match[1]}`;
      break;
    }
  }
  reader.releaseLock();
  if (!baseUrl) {
    proc.kill();
    throw new Error("v1-stub server did not report a port within 10s");
  }

  async function postReset(resources?: V1StubResources): Promise<void> {
    const res = await fetch(`${baseUrl}/v1/__reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resources ? { resources } : {}),
    });
    if (!res.ok) throw new Error(`v1-stub __reset failed: HTTP ${res.status}`);
  }

  const stub: V1Stub = {
    baseUrl,
    apiKey,
    async seed(resources) {
      await postReset(resources);
    },
    async reset() {
      await postReset(options.seed ? structuredClone(options.seed) : undefined);
    },
    async list(resource) {
      const all = await stub.dump();
      return all[resource] ?? [];
    },
    async dump() {
      const res = await fetch(`${baseUrl}/v1/__dump`);
      if (!res.ok) throw new Error(`v1-stub __dump failed: HTTP ${res.status}`);
      const body = (await res.json()) as { resources?: V1StubResources };
      return body.resources ?? {};
    },
    applyEnv() {
      process.env[MODE_ENV] = "self_hosted";
      process.env[URL_ENV] = baseUrl;
      process.env[KEY_ENV] = apiKey;
      resetSelfHostedConfigCache();
      resetMailDataSource();
    },
    clearEnv() {
      delete process.env[MODE_ENV];
      delete process.env[URL_ENV];
      delete process.env[KEY_ENV];
      resetSelfHostedConfigCache();
      resetMailDataSource();
    },
    stop() {
      proc.kill();
    },
  };

  return stub;
}
