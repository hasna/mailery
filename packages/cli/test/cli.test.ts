// Unit tests for command parsing, output shape, error mapping, and the
// hardened env-only credential model. No network, no DB — a routing fake
// `fetch` stands in for the server.

import { describe, expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { checkoutCountryCopy } from "../src/checkout-country-copy.js";
import { argv, makeHarness, parseJsonOut, type Harness } from "./support.js";

function harness(...args: Parameters<typeof makeHarness>): Harness {
  const options = args[0] ?? {};
  const route = options.route;
  return makeHarness({ ...options, route: route ? (call) => call.path === "/api/v1/billing/countries" ? { body: { version: "2026-10-23.1", restricted_countries: ["RO", "GB", "IM"], declaration_bases: ["billing", "residence"], disclosure_path: "/checkout", pricing_path: "/#pricing" } } : route(call) : undefined });
}

const SESSION = "sess_owner_1";
const USER = { id: "u1", email: "agent@example.com", name: "Agent", tenantId: "t1", role: "owner", isPlatformAdmin: false, emailVerifiedAt: "2026-07-08T00:00:00Z" };
const TENANT = { id: "t1", name: "Agent Co", slug: "agent-co", plan: "starter" };

describe("output + parsing", () => {
  test("whoami --json prints an ok envelope with the me payload", async () => {
    const h = harness({ route: (c) => c.path === "/api/v1/auth/me" ? { body: { user: USER, tenant: TENANT, auth: { via: "api_key", scopes: ["full"] } } } : undefined, env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("whoami", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(h.exitCode()).toBe(0);
    expect(env.ok).toBe(true);
    expect((env.data as { auth: { via: string } }).auth.via).toBe("api_key");
    // The daily surface authenticates with the API key.
    expect(h.calls[0]!.auth).toBe("Bearer ml_key");
  });

  test("whoami (text mode) prints human lines, not JSON", async () => {
    const h = harness({ route: () => ({ body: { user: USER, tenant: TENANT, auth: { via: "api_key", scopes: ["full"] } } }), env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("whoami"), h.deps);
    expect(h.out()).toContain("email:  agent@example.com");
    expect(h.out()).toContain("auth:   api_key");
    expect(() => JSON.parse(h.out())).toThrow();
  });

  test("domains search shows availability without public price fields", async () => {
    const h = harness({ route: (c) => c.path === "/api/v1/domains/availability" ? { body: { domain: c.query.domain, available: true, quoted_price_cents: 1500, quoted_price: 15, currency: "USD" } } : undefined, env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("domains", "search", "agent-mail.com", "--json"), h.deps);
    const data = parseJsonOut(h.out()).data as Record<string, unknown>;
    expect(data.domain).toBe("agent-mail.com");
    expect(data.available).toBe(true);
    expect(data.quoted_price_cents).toBeUndefined();
    expect(data.quoted_price).toBeUndefined();
    expect(data.currency).toBeUndefined();
    expect(h.calls[0]!.query.domain).toBe("agent-mail.com");
  });

  test("feedback posts the message and tags", async () => {
    const h = harness({ route: (c) => c.path === "/api/v1/feedback" && c.method === "POST" ? { body: { feedback: { id: "fb_1", kind: "idea", message: (c.body as { message: string }).message, status: "new" } } } : undefined, env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("feedback", "great tool", "--kind", "idea", "--tag", "cli", "--tag", "mcp", "--json"), h.deps);
    expect(parseJsonOut(h.out()).ok).toBe(true);
    const sent = h.calls[0]!.body as { message: string; kind: string; tags: string[] };
    expect(sent.message).toBe("great tool");
    expect(sent.kind).toBe("idea");
    expect(sent.tags).toEqual(["cli", "mcp"]);
  });

  test("send reads the body from stdin when --text is omitted", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/messages/send" ? { status: 202, body: { id: "m1", status: "test_sent", mode: "test", attachments: [] } } : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
      stdin: "piped body text",
    });
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@b.com,c@d.com", "--subject", "hi", "--json"), h.deps);
    expect(parseJsonOut(h.out()).ok).toBe(true);
    const sent = h.calls[0]!.body as { mailboxId: string; to: string[]; text: string };
    expect(sent.mailboxId).toBe("mb1");
    expect(sent.to).toEqual(["a@b.com", "c@d.com"]);
    expect(sent.text).toBe("piped body text");
  });

  test("send (text mode) says a test-mode send was not dispatched (send-status honesty)", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/messages/send" ? { status: 202, body: { id: "m1", status: "test_sent", mode: "test", attachments: [] } } : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@b.com", "--subject", "hi", "--text", "yo"), h.deps);
    expect(h.exitCode()).toBe(0);
    // PLA17-00095: a non-live server records test_sent and dispatches nothing —
    // the human line must say so instead of implying delivery.
    expect(h.out()).toContain('status test_sent');
    expect(h.out()).toContain('Not dispatched in test mode');
  });

  test("send (text mode, live mode) reports the dispatched status with no non-dispatch note", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/messages/send" ? { status: 202, body: { id: "m3", status: "sent", mode: "live", attachments: [] } } : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@b.com", "--subject", "hi", "--text", "yo"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain("status sent");
    expect(h.out()).not.toContain("Not dispatched");
  });

  test("send --from resolves the sender address to a mailbox id", async () => {
    const h = harness({
      route: (c) => {
        if (c.path === "/api/v1/mailboxes" && c.method === "GET") {
          return { body: { data: [{ id: "mb_support", email: "SUPPORT@acme-support.com", provider: "ses", status: "active" }] } };
        }
        if (c.path === "/api/v1/messages/send") return { status: 202, body: { id: "m2", status: "test_sent", mode: "test", attachments: [] } };
        return undefined;
      },
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("send", "--from", "support@acme-support.com", "--to", "customer@example.com", "--subject", "hi", "--text", "yo", "--json"), h.deps);
    expect(parseJsonOut(h.out()).ok).toBe(true);
    const sendCall = h.calls.find((c) => c.path === "/api/v1/messages/send");
    expect((sendCall!.body as { mailboxId: string }).mailboxId).toBe("mb_support");
  });

  test("send --from with no matching mailbox fails (usage error, no send call)", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/mailboxes" && c.method === "GET" ? { body: { data: [] } } : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("send", "--from", "missing@acme-support.com", "--to", "customer@example.com", "--text", "yo", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("cli_usage_error");
    expect(h.calls.some((c) => c.path === "/api/v1/messages/send")).toBe(false);
  });

  test("send with neither --mailbox nor --from is a usage error before any request", async () => {
    const h = harness({ route: () => ({}), env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("send", "--to", "customer@example.com", "--text", "yo", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("cli_usage_error");
    expect(h.calls).toHaveLength(0);
  });
});

describe("error mapping + exit codes", () => {
  test("a session-only command with no credentials fails before any request, with a login hint", async () => {
    const h = harness({ route: () => ({}) });
    await runCli(argv("keys", "list", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(h.exitCode()).toBe(1);
    expect(env.error!.hint).toContain("login");
    expect(h.calls).toHaveLength(0); // never hit the network
  });

  test("a 402 billing_required maps to a subscribe hint", async () => {
    const h = harness({ route: () => ({ status: 402, body: { error: { code: "billing_required", message: "needs a subscription" } } }), env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("domains", "search", "x.com", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("billing_required");
    expect(env.error!.hint).toContain("subscribe");
  });

  test("unknown command exits 2 (usage error)", async () => {
    const h = harness({ route: () => ({}) });
    await runCli(argv("frobnicate", "--json"), h.deps);
    expect(h.exitCode()).toBe(2);
    expect(parseJsonOut(h.out()).ok).toBe(false);
  });
});

describe("domain purchase (P5, live)", () => {
  test("domains buy posts only when price-bound consent equals the signed quote", async () => {
    const h = harness({
      route: (c) => {
        if (c.path === "/api/v1/domains/availability" && c.method === "GET") {
          return { body: { domain: "example.com", available: true, purchase_quote: { token: "quote_token", domain: "example.com", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true } } };
        }
        if (c.path === "/api/v1/domains/purchase" && c.method === "POST") {
          return { body: { domain: "example.com", ownership_ready: true, resumed: false, billing: { quoted_price_cents: 1500, currency: "usd" } } };
        }
        return undefined;
      },
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("domains", "buy", "example.com", "--yes", "--max-price-cents", "1500", "--currency", "usd", "--idempotency-key", "idem_cli_test", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { ownership_ready: boolean }).ownership_ready).toBe(true);
    const availability = h.calls.find((c) => c.path === "/api/v1/domains/availability");
    expect(availability).toBeDefined();
    expect(availability!.query.domain).toBe("example.com");
    const purchase = h.calls.find((c) => c.path === "/api/v1/domains/purchase");
    expect(purchase).toBeDefined();
    expect(purchase!.method).toBe("POST");
    expect(purchase!.headers["idempotency-key"]).toBe("idem_cli_test");
    expect((purchase!.body as { domain: string; quoteToken: string }).domain).toBe("example.com");
    expect((purchase!.body as { quoteToken: string }).quoteToken).toBe("quote_token");
  });

  test("domains buy without complete consent exposes the exact quote and never POSTs", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/domains/availability"
        ? { body: { domain: "example.com", available: true, purchase_quote: { token: "quote_token", domain: "example.com", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true } } }
        : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("domains", "buy", "example.com", "--json"), h.deps);
    const error = parseJsonOut(h.out()).error! as { code: string; message: string; hint?: string; details?: { quoted_price_cents?: number; currency?: string; suggested_idempotency_key?: string } };
    expect(error.code).toBe("price_confirmation_required");
    expect(error.details).toMatchObject({ quoted_price_cents: 1500, currency: "usd", suggested_idempotency_key: expect.stringContaining("mailery-cli-domain-purchase:example.com:") });
    expect(error.hint).toContain("--idempotency-key");
    expect(h.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("domains buy rejects a maximum below the quote and never POSTs", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/domains/availability"
        ? { body: { domain: "example.com", available: true, purchase_quote: { token: "quote_token", domain: "example.com", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true } } }
        : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("domains", "buy", "example.com", "--yes", "--max-price-cents", "1499", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("price_limit_exceeded");
    expect(h.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test.each(["0", "-1", "1.5", "abc"])("domains buy rejects invalid max-price-cents %s after quoting and never POSTs", async (value) => {
    const h = harness({
      route: (c) => c.path === "/api/v1/domains/availability"
        ? { body: { domain: "example.com", available: true, purchase_quote: { token: "quote_token", domain: "example.com", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true } } }
        : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("domains", "buy", "example.com", "--yes", "--max-price-cents", value, "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("invalid_price_limit");
    expect(h.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("domains buy rejects a quote in a different currency and never POSTs", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/domains/availability"
        ? { body: { domain: "example.com", available: true, purchase_quote: { token: "quote_token", domain: "example.com", quoted_price_cents: 1500, currency: "eur", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true } } }
        : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("domains", "buy", "example.com", "--yes", "--max-price-cents", "1500", "--currency", "usd", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("quote_currency_mismatch");
    expect(h.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("domains buy surfaces the server settled_funds cooling-off hint (no dead-end loop)", async () => {
    const h = harness({
      route: (c) => {
        if (c.path === "/api/v1/domains/availability" && c.method === "GET") {
          return { body: { domain: "agent-mail.com", available: true, purchase_quote: { token: "quote_token", domain: "agent-mail.com", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true } } };
        }
        if (c.path === "/api/v1/domains/purchase" && c.method === "POST") {
          return { status: 403, body: { error: { code: "settled_funds_required", message: "first domain purchase requires an account at least 7 days old (account age: 0 days)", details: { reason: "account_too_new", account_age_days: 0, min_account_age_days: 7, hint: "Your first custom-domain purchase is gated by an anti-fraud cooling-off: complete `mailery subscribe pro` ... once the account clears the 7-day window." } } } };
        }
        return undefined;
      },
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("domains", "buy", "agent-mail.com", "--yes", "--max-price-cents", "1500", "--currency", "usd", "--idempotency-key", "idem_cli_test", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("settled_funds_required");
    // The concrete next action from the server is surfaced as the CLI hint.
    expect(env.error!.hint).toContain("subscribe");
    expect(env.error!.hint).toContain("cooling-off");
  });
});

describe("credential storage hardening", () => {
  test("signup does NOT store the session token, only prints it once", async () => {
    const h = harness({ route: (c) => c.path === "/api/v1/terms/current" ? { body: { version: "a".repeat(64), url: "/api/v1/terms/versions/" + "a".repeat(64) } } : c.path === "/api/v1/auth/signup" ? { status: 201, body: { token: SESSION, user: USER, tenant: TENANT } } : undefined });
    await runCli(argv("signup", "--accept-terms", "a".repeat(64), "--email", "agent@example.com", "--password", "Sup3rSecret!"), h.deps);
    // Output contains the token and env export instruction
    expect(h.out()).toContain(SESSION);
    expect(h.out()).toContain("MAILERY_SESSION_TOKEN");
  });

  test("signup JSON mode includes token in data envelope", async () => {
    const h = harness({ route: (c) => c.path === "/api/v1/terms/current" ? { body: { version: "a".repeat(64), url: "/api/v1/terms/versions/" + "a".repeat(64) } } : c.path === "/api/v1/auth/signup" ? { status: 201, body: { token: SESSION, user: USER, tenant: TENANT } } : undefined });
    await runCli(argv("signup", "--accept-terms", "a".repeat(64), "--email", "agent@example.com", "--password", "Sup3rSecret!", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { token: string }).token).toBe(SESSION);
  });

  test("login does NOT store the session token, only prints it once", async () => {
    const h = harness({ route: (c) => c.path === "/api/v1/auth/login" ? { body: { token: SESSION, user: USER, tenant: TENANT } } : undefined });
    await runCli(argv("login", "--email", "agent@example.com", "--password", "Sup3rSecret!"), h.deps);
    expect(h.out()).toContain(SESSION);
    expect(h.out()).toContain("MAILERY_SESSION_TOKEN");
  });

  test("keys create does NOT store the API key, only prints it once", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => c.path === "/api/v1/api-keys" && c.method === "POST"
        ? { status: 201, body: { key: "ml_minted_secret", api_key: { id: "k1", name: "CLI", prefix: "ml_min", scopes: ["full"], createdAt: "2026-07-08" } } }
        : undefined,
    });
    await runCli(argv("keys", "create", "--scopes", "full"), h.deps);
    expect(h.out()).toContain("ml_minted_secret");
    expect(h.out()).toContain("MAILERY_API_KEY");
  });

  test("logout revokes server session when available and leaves no local context", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/auth/logout" ? { body: { ok: true } } : undefined,
      env: { MAILERY_SESSION_TOKEN: SESSION },
    });
    await runCli(argv("logout", "--json"), h.deps);
    expect(parseJsonOut(h.out()).ok).toBe(true);
    expect(h.calls).toHaveLength(1); // one server call to revoke
    const logoutCall = h.calls.find((c) => c.path === "/api/v1/auth/logout");
    expect(logoutCall).toBeDefined();
    expect(logoutCall!.auth).toBe(`Bearer ${SESSION}`);
  });

  test("logout treats an already-invalid session as completed", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/auth/logout"
        ? { status: 401, body: { error: { code: "unauthorized", message: "valid session token required" } } }
        : undefined,
      env: { MAILERY_SESSION_TOKEN: SESSION },
    });

    await runCli(argv("logout", "--json"), h.deps);

    expect(parseJsonOut(h.out()).ok).toBe(true);
    expect(h.exitCode()).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  test("logout reports transport or server failures instead of claiming revocation", async () => {
    const h = harness({
      route: (c) => c.path === "/api/v1/auth/logout"
        ? { status: 503, body: { error: { code: "service_unavailable", message: "revocation store unavailable" } } }
        : undefined,
      env: { MAILERY_SESSION_TOKEN: SESSION },
    });

    await runCli(argv("logout", "--json"), h.deps);

    const envelope = parseJsonOut(h.out());
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ code: "service_unavailable", status: 503 });
    expect(h.exitCode()).toBe(1);
  });

  test("logout reports an unreachable revocation service", async () => {
    const h = harness({
      fetch: async () => { throw new Error("connection refused"); },
      env: { MAILERY_SESSION_TOKEN: SESSION },
    });

    await runCli(argv("logout", "--json"), h.deps);

    const envelope = parseJsonOut(h.out());
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ code: "network" });
    expect(h.exitCode()).toBe(1);
  });

  test("keys revoke --all leaves no local config", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION, MAILERY_API_KEY: "ml_old" },
      route: (c) => {
        if (c.path === "/api/v1/keys/revoke-all") return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
        if (c.path === "/api/v1/api-keys" && c.method === "GET") {
          return { body: { data: [
            { id: "k1", name: "a", prefix: "ml_a", scopes: ["full"], lastUsedAt: null, revokedAt: null, createdAt: "x" },
          ] } };
        }
        if (/\/api\/v1\/api-keys\/.+\/revoke/.test(c.path)) return { body: { ok: true } };
        return undefined;
      },
    });
    await runCli(argv("keys", "revoke", "--all", "--json"), h.deps);
    expect(parseJsonOut(h.out()).ok).toBe(true);
  });
});

describe("break-glass keys revoke --all", () => {
  test("falls back to enumerate+revoke when /keys/revoke-all is not live, skipping already-revoked keys", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION, MAILERY_API_KEY: "ml_old" },
      route: (c) => {
        if (c.path === "/api/v1/keys/revoke-all") return { status: 404, body: { error: { code: "not_found", message: "no route" } } };
        if (c.path === "/api/v1/api-keys" && c.method === "GET") {
          return { body: { data: [
            { id: "k1", name: "a", prefix: "ml_a", scopes: ["full"], lastUsedAt: null, revokedAt: null, createdAt: "x" },
            { id: "k2", name: "b", prefix: "ml_b", scopes: ["full"], lastUsedAt: null, revokedAt: "2026-07-01", createdAt: "x" },
          ] } };
        }
        if (/\/api\/v1\/api-keys\/.+\/revoke/.test(c.path)) return { body: { ok: true } };
        return undefined;
      },
    });
    await runCli(argv("keys", "revoke", "--all", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { revoked: number; method: string }).revoked).toBe(1);
    expect((env.data as { method: string }).method).toBe("enumerate");
    // Only the active key k1 was revoked; k2 (already revoked) was skipped.
    const revokeCalls = h.calls.filter((c) => /\/revoke$/.test(c.path));
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0]!.path).toBe("/api/v1/api-keys/k1/revoke");
  });

  test("works with password auth alone: logs in first, then revokes all", async () => {
    const h = harness({
      route: (c) => {
        if (c.path === "/api/v1/auth/login") return { body: { token: SESSION, user: USER, tenant: TENANT } };
        if (c.path === "/api/v1/keys/revoke-all") return { status: 404, body: {} };
        if (c.path === "/api/v1/api-keys" && c.method === "GET") return { body: { data: [{ id: "k1", name: "a", prefix: "ml_a", scopes: ["full"], lastUsedAt: null, revokedAt: null, createdAt: "x" }] } };
        if (/\/revoke$/.test(c.path)) return { body: { ok: true } };
        return undefined;
      },
    });
    await runCli(argv("keys", "revoke", "--all", "--email", "agent@example.com", "--password", "Sup3rSecret!", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { revoked: number }).revoked).toBe(1);
    // The login happened, and the revoke used the freshly-issued session token.
    const login = h.calls.find((c) => c.path === "/api/v1/auth/login");
    expect(login).toBeDefined();
    const revoke = h.calls.find((c) => /\/revoke$/.test(c.path));
    expect(revoke!.auth).toBe(`Bearer ${SESSION}`);
  });
});

describe("verify (terminal email-verification status)", () => {
  test("reports verified when the account's email is confirmed (exit 0)", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => c.path === "/api/v1/auth/me"
        ? { body: { user: USER, tenant: TENANT, auth: { via: "session", scopes: ["full"] } } }
        : undefined,
    });
    await runCli(argv("verify", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { verified: boolean }).verified).toBe(true);
    expect(h.exitCode()).toBe(0);
  });

  test("unverified email fails with email_verification_required + a next-step hint (exit 1)", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => c.path === "/api/v1/auth/me"
        ? { body: { user: { ...USER, emailVerifiedAt: null }, tenant: TENANT, auth: { via: "session", scopes: [] } } }
        : undefined,
    });
    await runCli(argv("verify", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("email_verification_required");
    expect(env.error?.hint).toContain("mailery verify");
    expect(h.exitCode()).toBe(1);
  });

  test("--resend posts to the resend endpoint and explains the one-time browser step", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => c.path === "/api/v1/auth/verify/resend"
        ? { body: { ok: true, verified: false } }
        : undefined,
    });
    await runCli(argv("verify", "--resend"), h.deps);
    const resend = h.calls.find((c) => c.path === "/api/v1/auth/verify/resend");
    expect(resend?.method).toBe("POST");
    expect(resend?.auth).toBe(`Bearer ${SESSION}`);
    expect(h.out()).toContain("re-sent");
    expect(h.exitCode()).toBe(0);
  });

  test("api-key auth (no user) is treated as already verified", async () => {
    const h = harness({
      env: { MAILERY_API_KEY: "ml_key" },
      route: (c) => c.path === "/api/v1/auth/me"
        ? { body: { user: null, tenant: TENANT, auth: { via: "api_key", scopes: ["full"] } } }
        : undefined,
    });
    await runCli(argv("verify", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect((env.data as { verified: boolean }).verified).toBe(true);
    expect(h.exitCode()).toBe(0);
  });
});

describe("subscribe", () => {
  test("--no-wait prints the checkout URL and does not poll", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => c.path === "/api/v1/billing/checkout" ? { body: { url: "https://stripe.test/c/123" } } : { body: {} },
    });
    await runCli(argv("subscribe", "pro", "--country", "US", "--country-basis", "billing", "--country-policy-version", "2026-10-23.1", "--no-wait", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect((env.data as { checkout_url: string; waited: boolean }).checkout_url).toBe("https://stripe.test/c/123");
    expect((env.data as { waited: boolean }).waited).toBe(false);
    // No billing/overview poll happened.
    expect(h.calls.some((c) => c.path === "/api/v1/billing/overview")).toBe(false);
  });

  test("polls billing until entitled, then reports active", async () => {
    let polls = 0;
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => {
        if (c.path === "/api/v1/billing/checkout") return { body: { url: "https://stripe.test/c/1" } };
        if (c.path === "/api/v1/billing/overview") {
          polls += 1;
          return polls >= 2
            ? { body: { balance: 0, plans: {}, credit_packs: {}, subscriptions: [{ status: "active", plan: "starter" }], ledger: [] } }
            : { body: { balance: 0, plans: {}, credit_packs: {}, subscriptions: [], ledger: [] } };
        }
        return { body: {} };
      },
    });
    await runCli(argv("subscribe", "pro", "--country", "US", "--country-basis", "billing", "--country-policy-version", "2026-10-23.1", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect((env.data as { entitled: boolean }).entitled).toBe(true);
    expect(polls).toBe(2);
  });
});

describe("Checkout retry and resume", () => {
  test("explicit purchase keys survive separate CLI invocations and stay out of the JSON body", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const h = harness({
        env: { MAILERY_SESSION_TOKEN: SESSION },
        route: () => ({ body: { url: "https://stripe.test/original" } }),
      });
      await runCli(argv("subscribe", "pro", "--country", "US", "--country-basis", "billing", "--country-policy-version", "2026-10-23.1", "--idempotency-key", "stable-cli-purchase", "--no-wait", "--json"), h.deps);
      const creation = h.calls.find((c) => c.path === "/api/v1/billing/checkout")!;
      expect(creation.headers["idempotency-key"]).toBe("stable-cli-purchase");
      expect(creation.body).toEqual({ kind: "subscription", plan: "pro", country: "US", countryBasis: "billing", countryPolicyVersion: "2026-10-23.1" });
      expect(h.calls).toHaveLength(2);
      expect(h.calls[0]!.path).toBe("/api/v1/billing/countries");
      expect(h.err()).toContain("RO, GB, IM");
    }
  });

  test("--resume polls entitlement without any Checkout creation", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => c.path === "/api/v1/billing/overview"
        ? { body: { balance: 1000, plans: {}, credit_packs: {}, subscriptions: [], ledger: [] } }
        : { status: 500, body: { error: { code: "unexpected", message: "unexpected mutation" } } },
    });
    await runCli(argv("subscribe", "pro", "--country", "US", "--country-basis", "billing", "--country-policy-version", "2026-10-23.1", "--resume", "--json"), h.deps);
    expect(h.calls.map((c) => [c.method, c.path])).toEqual([["GET", "/api/v1/billing/overview"]]);
    expect(parseJsonOut(h.out()).data).toMatchObject({ entitled: true, waited: true });
  });

  test("credit-only resume reports entitlement without claiming an active subscription", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => c.path === "/api/v1/billing/overview"
        ? { body: { balance: 1000, plans: {}, credit_packs: {}, subscriptions: [], ledger: [] } }
        : { status: 500, body: { error: { code: "unexpected", message: "unexpected mutation" } } },
    });
    let browserOpens = 0;
    h.deps.interactive = true;
    h.deps.openBrowser = () => { browserOpens += 1; };
    await runCli(argv("subscribe", "pro", "--resume"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.calls.map((c) => [c.method, c.path])).toEqual([["GET", "/api/v1/billing/overview"]]);
    expect(h.calls[0]!.auth).toBe(`Bearer ${SESSION}`);
    expect(browserOpens).toBe(0);
    expect(h.out()).toContain("Entitlement active. Balance: 1000.");
    expect(h.out()).not.toContain("Subscription active");
  });

  test("poll timeout directs the caller to resume-only observation", async () => {
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => c.path === "/api/v1/billing/checkout"
        ? { body: { url: "https://stripe.test/original" } }
        : { body: { balance: 0, plans: {}, credit_packs: {}, subscriptions: [], ledger: [] } },
    });
    await runCli(argv("subscribe", "pro", "--country", "US", "--country-basis", "billing", "--country-policy-version", "2026-10-23.1", "--timeout", "1", "--interval", "3", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error).toMatchObject({ code: "entitlement_timeout" });
    expect(parseJsonOut(h.out()).error!.hint).toContain("--resume");
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("--resume refuses creation options without provider I/O", async () => {
    const h = harness({ env: { MAILERY_SESSION_TOKEN: SESSION }, route: () => ({}) });
    await runCli(argv("subscribe", "pro", "--country", "US", "--country-basis", "billing", "--country-policy-version", "2026-10-23.1", "--resume", "--idempotency-key", "unused-purchase-key", "--json"), h.deps);
    expect(h.calls).toHaveLength(0);
    expect(parseJsonOut(h.out()).error!.code).toBe("cli_usage_error");
  });
});


test("subscribe presents the current restrictions and refuses omission before any POST", async () => {
  const h = harness({ env: { MAILERY_SESSION_TOKEN: SESSION }, route: () => ({ body: {} }) });
  await runCli(argv("subscribe", "pro", "--no-wait", "--json"), h.deps);
  expect(parseJsonOut(h.out()).error!.code).toBe("checkout_country_required");
  expect(h.err()).toContain("RO, GB, IM");
  expect(h.calls.map((call) => call.method)).toEqual(["GET"]);
});


test("country disclosure follows the selected CLI language without changing the declaration", async () => {
  const h = harness({ env: { MAILERY_SESSION_TOKEN: SESSION, MAILERY_LANGUAGE: "ro" }, route: () => ({ body: { url: "http://127.0.0.1:55586/checkout" } }) });
  await runCli(argv("subscribe", "pro", "--country", "US", "--country-basis", "billing", "--country-policy-version", "2026-10-23.1", "--no-wait", "--json"), h.deps);
  expect(h.err()).toContain("Plata nu este disponibilă în:");
  expect(h.calls.find((call) => call.method === "POST")?.body).toMatchObject({ country: "US", countryBasis: "billing", countryPolicyVersion: "2026-10-23.1" });
});


for (const command of [["subscribe", "pro", "--no-wait"], ["billing", "add-funds", "25", "--yes", "--idempotency-key", "explicit-basis-topup"]]) {
  test(`${command[0]} requires an explicit billing or residence basis before a paid POST`, async () => {
    for (const basisArgs of [[], ["--country-basis", "nationality"]]) {
      const h = harness({ env: { MAILERY_SESSION_TOKEN: SESSION }, route: () => ({ body: {} }) });
      await runCli(argv(...command, "--country", "US", ...basisArgs, "--json"), h.deps);
      expect(parseJsonOut(h.out()).error!.code).toBe("cli_usage_error");
      expect(h.exitCode()).not.toBe(0);
      expect(h.calls.map((call) => call.method)).toEqual(["GET"]);
      expect(h.err()).toContain("RO, GB, IM");
    }
  });

  test(`${command[0]} forwards each explicitly chosen country basis`, async () => {
    for (const countryBasis of ["billing", "residence"]) {
      const h = harness({ env: { MAILERY_SESSION_TOKEN: SESSION }, route: () => ({ body: { url: "http://127.0.0.1:1/synthetic-checkout" } }) });
      await runCli(argv(...command, "--country", "US", "--country-basis", countryBasis, "--country-policy-version", "2026-10-23.1", "--json"), h.deps);
      expect(h.exitCode()).toBe(0);
      expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(1);
      expect(h.calls.find((call) => call.method === "POST")!.body).toMatchObject({ country: "US", countryBasis, countryPolicyVersion: "2026-10-23.1" });
    }
  });
}


for (const lang of ["en", "ro"] as const) {
  test(`the ${lang} explicit subscription handoff returns its URL in JSON mode before entitlement`, async () => {
    const command = ["pro", "--country", "US", "--country-basis", "residence", "--country-policy-version", "2026-10-23.1", "--idempotency-key", "copied-stable-purchase-key", "--no-wait"];
    const h = harness({
      env: { MAILERY_SESSION_TOKEN: SESSION, MAILERY_JSON: "1", MAILERY_LANGUAGE: lang },
      route: (call) => call.path === "/api/v1/billing/checkout"
        ? { body: { url: "http://127.0.0.1:1/synthetic-checkout" } }
        : { body: { balance: 0, plans: {}, credit_packs: {}, subscriptions: [], ledger: [] } },
    });
    await runCli(argv("subscribe", ...command, "--timeout", "1"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.err()).toContain(checkoutCountryCopy({ MAILERY_LANGUAGE: lang }).restrictions);
    expect(parseJsonOut(h.out()).data).toMatchObject({ checkout_url: "http://127.0.0.1:1/synthetic-checkout", waited: false });
    expect(h.calls.map((call) => call.path)).toEqual(["/api/v1/billing/countries", "/api/v1/billing/checkout"]);
    expect(h.calls[1]!.headers["idempotency-key"]).toBe("copied-stable-purchase-key");
  });
}
