// HTTP request handler for the Mailery self_hosted cloud service.
//
// Surfaces the fleet-standard operational probes (/health, /ready, /version)
// plus the authenticated, versioned /v1 API. Every /v1 route requires a valid
// Hasna API key (@hasna/contracts/auth) scoped to `mailery:read` / `mailery:write`.
//
// Amendment A1 (PURE REMOTE): all data operations hit the cloud Postgres via the
// store, which wraps the vendored storage kit's typed client.

import type { ApiKeyVerifier, ApiKeyPrincipal } from "@hasna/contracts/auth";
import type { TypedQueryClient, Migration } from "../../generated/storage-kit/index.js";
import { checkHealth } from "../../generated/storage-kit/index.js";
import { MaileryCloudStore } from "./store.js";
import { maileryCloudOpenApi } from "./openapi.js";

interface ReadyResult {
  ok: boolean;
  latencyMs: number;
  pendingMigrations: string[];
  error?: string;
}

/**
 * SELECT-only readiness: reachable AND every defined migration is recorded in
 * `schema_migrations`. Unlike the kit's `checkReady`, this never issues DDL, so
 * it works under the least-privileged app role (which has no CREATE on public).
 */
async function readinessCheck(deps: CloudServiceDeps): Promise<ReadyResult> {
  const start = Date.now();
  try {
    const rows = await deps.client.many<{ id: string }>(`SELECT id FROM schema_migrations`);
    const applied = new Set(rows.map((r) => r.id));
    const pending = deps.migrations.filter((m) => !applied.has(m.id)).map((m) => m.id);
    return { ok: pending.length === 0, latencyMs: Date.now() - start, pendingMigrations: pending };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      pendingMigrations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CloudServiceDeps {
  client: TypedQueryClient;
  store: MaileryCloudStore;
  verifier: ApiKeyVerifier;
  migrations: readonly Migration[];
  version: string;
}

const MODE = "cloud" as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Parse an optional `daily_quota` field off an address request body.
 * `provided` is false when the key is absent (leave the column untouched); when
 * present it must be null (clear) or a non-negative integer.
 */
function parseDailyQuota(
  body: Record<string, unknown>,
): { provided: boolean; value: number | null; error?: string } {
  if (!("daily_quota" in body)) return { provided: false, value: null };
  const raw = body.daily_quota;
  if (raw === null) return { provided: true, value: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return { provided: true, value: raw };
  }
  return { provided: true, value: null, error: "daily_quota must be a non-negative integer or null" };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function queryInt(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Coerce a JSON body value into a string[] (array, comma/whitespace-tolerant). */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** Coerce a JSON body value into a plain object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Coerce a JSON body value into an array, else undefined. */
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Optional string|null passthrough: undefined stays undefined. */
function asOptStringOrNull(value: unknown): string | null | undefined {
  return value === undefined ? undefined : (value as string | null);
}

interface AuthOk {
  ok: true;
  principal: ApiKeyPrincipal;
}
interface AuthFail {
  ok: false;
  response: Response;
}

async function authenticate(
  deps: CloudServiceDeps,
  req: Request,
  url: URL,
  requiredScopes: string[],
): Promise<AuthOk | AuthFail> {
  const decision = await deps.verifier.authenticate(req.headers, {
    method: req.method,
    path: url.pathname,
    requiredScopes,
  });
  if (!decision.ok) {
    return {
      ok: false,
      response: json(decision.status, { error: decision.message, reason: decision.reason }),
    };
  }
  return { ok: true, principal: decision.principal };
}

/**
 * Route + handle a single request. Returns `null` when the path is not owned by
 * this service (so a caller can fall through to other handlers).
 */
export async function handleCloudRequest(
  deps: CloudServiceDeps,
  req: Request,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  // ---- operational probes (unauthenticated) ------------------------------
  if (path === "/health") {
    const health = await checkHealth(deps.client);
    return json(200, {
      status: "ok",
      version: deps.version,
      mode: MODE,
      name: "mailery",
      db: { ok: health.ok, latencyMs: health.latencyMs, ...(health.error ? { error: health.error } : {}) },
    });
  }

  if (path === "/ready") {
    const ready = await readinessCheck(deps);
    return json(ready.ok ? 200 : 503, {
      status: ready.ok ? "ready" : "not_ready",
      version: deps.version,
      mode: MODE,
      db: { ok: ready.ok, latencyMs: ready.latencyMs },
      pendingMigrations: ready.pendingMigrations,
      ...(ready.error ? { error: ready.error } : {}),
    });
  }

  if (path === "/version") {
    return json(200, { status: "ok", version: deps.version, mode: MODE, name: "mailery" });
  }

  if (path === "/openapi.json" || path === "/v1/openapi.json") {
    return json(200, { ...maileryCloudOpenApi, info: { ...maileryCloudOpenApi.info, version: deps.version } });
  }

  if (!path.startsWith("/v1/") && path !== "/v1") return null;

  // ---- /v1 (authenticated) -----------------------------------------------
  const read = ["mailery:read"];
  const write = ["mailery:write"];
  const store = deps.store;

  try {
    // /v1/domains
    if (path === "/v1/domains") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        return json(200, { domains: await store.listDomains({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }) });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const domain = String(body.domain ?? "").trim();
        if (!domain) return json(400, { error: "domain is required" });
        if (await store.getDomainByName(domain)) return json(409, { error: `domain ${domain} already exists` });
        const created = await store.createDomain({
          domain,
          status: body.status ? String(body.status) : undefined,
          provider: body.provider === undefined ? undefined : (body.provider as string | null),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          notes: body.notes === undefined ? undefined : (body.notes as string | null),
        });
        return json(201, { domain: created });
      }
      return json(405, { error: "method not allowed" });
    }

    const domainMatch = path.match(/^\/v1\/domains\/([^/]+)$/);
    if (domainMatch) {
      const id = decodeURIComponent(domainMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await store.getDomain(id);
        return rec ? json(200, { domain: rec }) : json(404, { error: "domain not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const rec = await store.updateDomain(id, {
          status: body.status === undefined ? undefined : String(body.status),
          provider: body.provider === undefined ? undefined : (body.provider as string | null),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          notes: body.notes === undefined ? undefined : (body.notes as string | null),
        });
        return rec ? json(200, { domain: rec }) : json(404, { error: "domain not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await store.deleteDomain(id)) ? json(200, { deleted: true, id }) : json(404, { error: "domain not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    // /v1/addresses
    if (path === "/v1/addresses") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        return json(200, { addresses: await store.listAddresses({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }) });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const email = String(body.email ?? "").trim();
        if (!email || !email.includes("@")) return json(400, { error: "a valid email is required" });
        const quota = parseDailyQuota(body);
        if (quota.error) return json(400, { error: quota.error });
        const created = await store.createAddress({
          email,
          display_name: body.display_name === undefined ? undefined : (body.display_name as string | null),
          status: body.status ? String(body.status) : undefined,
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          daily_quota: quota.provided ? quota.value : undefined,
        });
        return json(201, { address: created });
      }
      return json(405, { error: "method not allowed" });
    }

    const addressMatch = path.match(/^\/v1\/addresses\/([^/]+)$/);
    if (addressMatch) {
      const id = decodeURIComponent(addressMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await store.getAddress(id);
        return rec ? json(200, { address: rec }) : json(404, { error: "address not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const quota = parseDailyQuota(body);
        if (quota.error) return json(400, { error: quota.error });
        const rec = await store.updateAddress(id, {
          display_name: body.display_name === undefined ? undefined : (body.display_name as string | null),
          status: body.status === undefined ? undefined : String(body.status),
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
          dailyQuotaSet: quota.provided,
          daily_quota: quota.value,
        });
        return rec ? json(200, { address: rec }) : json(404, { error: "address not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await store.deleteAddress(id)) ? json(200, { deleted: true, id }) : json(404, { error: "address not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    // /v1/messages
    if (path === "/v1/messages") {
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        return json(200, { messages: await store.listMessages({ limit: queryInt(url, "limit"), offset: queryInt(url, "offset") }) });
      }
      if (method === "POST") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const from = String(body.from ?? body.from_addr ?? "").trim();
        if (!from) return json(400, { error: "from is required" });
        const rawTo = body.to ?? body.to_addrs;
        const to = Array.isArray(rawTo) ? rawTo.map((v) => String(v)) : typeof rawTo === "string" && rawTo.trim() ? [rawTo.trim()] : [];
        if (to.length === 0) return json(400, { error: "to is required" });

        // Direction defaults to outbound; any inbound signal marks it inbound so
        // the same POST route records both sent and received mail.
        const receivedAt = asOptStringOrNull(body.received_at);
        const directionRaw = body.direction === undefined ? undefined : String(body.direction);
        const direction =
          directionRaw ?? (receivedAt || body.message_id || body.in_reply_to ? "inbound" : undefined);

        const input = {
          from_addr: from,
          to_addrs: to,
          cc_addrs: body.cc === undefined && body.cc_addrs === undefined ? undefined : asStringArray(body.cc ?? body.cc_addrs),
          subject: asOptStringOrNull(body.subject),
          body_text: body.text === undefined ? asOptStringOrNull(body.body_text) : asOptStringOrNull(body.text),
          body_html: body.html === undefined ? asOptStringOrNull(body.body_html) : asOptStringOrNull(body.html),
          status: body.status ? String(body.status) : undefined,
          provider_message_id: asOptStringOrNull(body.provider_message_id),
          direction,
          message_id: asOptStringOrNull(body.message_id),
          in_reply_to: asOptStringOrNull(body.in_reply_to),
          received_at: receivedAt,
          is_read: typeof body.is_read === "boolean" ? body.is_read : undefined,
          is_starred: typeof body.is_starred === "boolean" ? body.is_starred : undefined,
          labels: body.labels === undefined ? undefined : asStringArray(body.labels),
          headers: asObject(body.headers),
          attachments: asArray(body.attachments),
          source_id: body.source_id === undefined ? undefined : String(body.source_id),
        };

        // With a source_id the write is idempotent (upsert): re-running an
        // import updates the existing row instead of creating a duplicate.
        if (input.source_id) {
          const { record, inserted } = await store.upsertMessage(input);
          return json(inserted ? 201 : 200, { message: record });
        }
        const created = await store.createMessage(input);
        return json(201, { message: created });
      }
      return json(405, { error: "method not allowed" });
    }

    const messageMatch = path.match(/^\/v1\/messages\/([^/]+)$/);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]!);
      if (method === "GET") {
        const auth = await authenticate(deps, req, url, read);
        if (!auth.ok) return auth.response;
        const rec = await store.getMessage(id);
        return rec ? json(200, { message: rec }) : json(404, { error: "message not found" });
      }
      if (method === "PATCH" || method === "PUT") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        const body = await readJsonBody(req);
        const rec = await store.updateMessageStatus(id, {
          status: body.status === undefined ? undefined : String(body.status),
          provider_message_id: body.provider_message_id === undefined ? undefined : (body.provider_message_id as string | null),
        });
        return rec ? json(200, { message: rec }) : json(404, { error: "message not found" });
      }
      if (method === "DELETE") {
        const auth = await authenticate(deps, req, url, write);
        if (!auth.ok) return auth.response;
        return (await store.deleteMessage(id)) ? json(200, { deleted: true, id }) : json(404, { error: "message not found" });
      }
      return json(405, { error: "method not allowed" });
    }

    return json(404, { error: "not found" });
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes("JSON"))) {
      return json(400, { error: `invalid request body: ${err.message}` });
    }
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: "internal error", detail: message });
  }
}
