// `mailery account export|delete` command tests (launch lane L13, M13-003):
// the page walk, where the export lands, the typed-email confirmation, the
// refusal on mismatch, and the --json envelopes. No network — the routing fake
// fetch stands in for the server.

import { describe, expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut, type RouteHandler } from "./support.js";

const SESSION = "sess_owner_1";
const USER = { id: "u1", email: "Owner@Example.com", name: "Owner", tenantId: "t1", role: "owner", isPlatformAdmin: false, emailVerifiedAt: "2026-07-08T00:00:00Z" };
const TENANT = { id: "t1", name: "Agent Co", slug: "agent-co", plan: "free" };

const PAGE_ONE_MESSAGES = [
  { id: "m1", subject: "one", attachments: [{ id: "a1", filename: "x.txt", download_url: "/api/v1/attachments/a1/download" }] },
  { id: "m2", subject: "two", attachments: [] },
];
const PAGE_TWO_MESSAGES = [{ id: "m3", subject: "three", attachments: [] }];

function exportPage(query: Record<string, string>) {
  const common = {
    export_version: 1,
    generated_at: "2026-09-10T12:00:00.000Z",
    tenant: TENANT,
    users: [USER],
    mailboxes: [{ id: "mb1", email: "agent@agents.example" }],
    labels: [],
    api_keys: [],
    domains: [],
    subscriptions: [],
    credits: { balance: 0, monthly_grant: 0, ledger: [] },
  };
  if (!query.cursor) return { ...common, messages: { data: PAGE_ONE_MESSAGES, next_cursor: "m2", nextCursor: "m2" } };
  if (query.cursor === "m2") return { ...common, messages: { data: PAGE_TWO_MESSAGES, next_cursor: null, nextCursor: null } };
  return { ...common, messages: { data: [], next_cursor: null, nextCursor: null } };
}

function route(options: { deleteStatus?: number; deleteBody?: unknown } = {}): RouteHandler {
  return (c) => {
    if (c.path === "/api/v1/auth/me" && c.method === "GET") {
      return { body: { user: USER, tenant: TENANT, auth: { via: "session", scopes: ["full"] } } };
    }
    if (c.path === "/api/v1/account/export" && c.method === "GET") return { body: exportPage(c.query) };
    if (c.path === "/api/v1/account" && c.method === "DELETE") {
      return { status: options.deleteStatus ?? 200, body: options.deleteBody ?? { ok: true, deleted: { tenant_id: "t1", user_id: "u1" } } };
    }
    return undefined;
  };
}

function harness(options: Parameters<typeof route>[0] = {}, env: Record<string, string | undefined> = {}) {
  const h = makeHarness({ route: route(options), env: { MAILERY_SESSION_TOKEN: SESSION, MAILERY_API_KEY: "ml_key", ...env } });
  const written: Array<{ path: string; data: Uint8Array }> = [];
  h.deps.writeFile = async (path, data) => { written.push({ path, data }); };
  return { ...h, written };
}

describe("mailery account export", () => {
  test("walks every page with the session token and writes one document to --output", async () => {
    const h = harness();
    await runCli(argv("account", "export", "--output", "/tmp/export.json"), h.deps);
    expect(h.exitCode()).toBe(0);
    const exportCalls = h.calls.filter((c) => c.path === "/api/v1/account/export");
    expect(exportCalls.map((c) => c.query.cursor ?? null)).toEqual([null, "m2"]);
    expect(exportCalls.every((c) => c.query.limit === "1000")).toBe(true);
    // Owner routes authenticate with the SESSION token even when an API key is also set.
    expect(exportCalls.every((c) => c.auth === `Bearer ${SESSION}`)).toBe(true);

    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.path).toBe("/tmp/export.json");
    const document = JSON.parse(Buffer.from(h.written[0]!.data).toString("utf8")) as {
      export_version: number;
      pages: number;
      tenant: { slug: string };
      mailboxes: unknown[];
      messages: { data: Array<{ id: string }>; next_cursor: null };
    };
    expect(document.export_version).toBe(1);
    expect(document.pages).toBe(2);
    expect(document.tenant.slug).toBe("agent-co");
    expect(document.mailboxes).toHaveLength(1);
    expect(document.messages.data.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(document.messages.next_cursor).toBeNull();
    expect(h.out()).toContain("Exported 3 message(s) across 2 page(s) to /tmp/export.json");
    expect(h.out()).toContain("Attachment bytes are not embedded");
  });

  test("defaults the filename to the tenant slug and reports the summary as a --json envelope", async () => {
    const h = harness();
    await runCli(argv("account", "export", "--json", "--page-size", "500"), h.deps);
    expect(h.exitCode()).toBe(0);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    const data = env.data as { path: string; pages: number; messages: number; mailboxes: number; attachments: number; bytes: number };
    expect(data.path).toMatch(/^mailery-export-agent-co-\d{4}-\d{2}-\d{2}T[0-9-]+z\.json$/);
    expect(data.pages).toBe(2);
    expect(data.messages).toBe(3);
    expect(data.mailboxes).toBe(1);
    expect(data.attachments).toBe(1);
    expect(data.bytes).toBeGreaterThan(0);
    expect(h.written[0]!.path).toBe(data.path);
    expect(h.calls.filter((c) => c.path === "/api/v1/account/export").every((c) => c.query.limit === "500")).toBe(true);
    // The envelope is the only thing on stdout.
    expect(h.out().trim().startsWith("{")).toBe(true);
  });

  test("--output - streams the export document itself to stdout and refuses to combine with --json", async () => {
    const streamed = harness();
    await runCli(argv("account", "export", "--output", "-"), streamed.deps);
    expect(streamed.exitCode()).toBe(0);
    expect(streamed.written).toHaveLength(0);
    const document = JSON.parse(streamed.out()) as { messages: { data: unknown[] }; pages: number };
    expect(document.messages.data).toHaveLength(3);
    expect(document.pages).toBe(2);

    const conflicting = harness();
    await runCli(argv("account", "export", "--output", "-", "--json"), conflicting.deps);
    expect(conflicting.exitCode()).toBe(1);
    expect(parseJsonOut(conflicting.out()).error?.code).toBe("cli_usage_error");
    expect(conflicting.calls).toHaveLength(0);
  });

  test("rejects an out-of-range --page-size before calling the server", async () => {
    const h = harness();
    await runCli(argv("account", "export", "--page-size", "5000", "--json"), h.deps);
    expect(h.exitCode()).toBe(1);
    expect(parseJsonOut(h.out()).error?.code).toBe("cli_usage_error");
    expect(h.calls).toHaveLength(0);
  });

  test("needs a session: an API-key-only environment surfaces the auth hint, not a partial file", async () => {
    const h = makeHarness({
      route: (c) => c.path === "/api/v1/account/export" ? { status: 401, body: { error: { code: "unauthorized", message: "session required" } } } : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    const written: string[] = [];
    h.deps.writeFile = async (path) => { written.push(path); };
    await runCli(argv("account", "export", "--json"), h.deps);
    expect(h.exitCode()).toBe(1);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error?.hint).toContain("mailery login");
    expect(written).toHaveLength(0);
  });
});

describe("mailery account delete", () => {
  test("refuses on a confirmation mismatch and sends no DELETE", async () => {
    const h = harness();
    await runCli(argv("account", "delete", "--password", "pw", "--confirm-email", "someone-else@example.com", "--json"), h.deps);
    expect(h.exitCode()).toBe(1);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("confirmation_mismatch");
    expect(env.error?.message).toContain("nothing was deleted");
    expect(env.error?.hint).toContain("--confirm-email owner@example.com");
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/auth/me"]);
  });

  test("both flags are required (usage error, exit 2) and nothing is called", async () => {
    const h = harness();
    await runCli(argv("account", "delete", "--password", "pw"), h.deps);
    expect(h.exitCode()).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  test("deletes when the typed email matches the session identity (case- and whitespace-insensitive)", async () => {
    const h = harness();
    await runCli(argv("account", "delete", "--password", "pw", "--confirm-email", "  OWNER@example.com "), h.deps);
    expect(h.exitCode()).toBe(0);
    const del = h.calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/api/v1/account");
    expect(del.body).toEqual({ password: "pw" });
    expect(del.auth).toBe(`Bearer ${SESSION}`);
    expect(h.out()).toContain("Account owner@example.com (tenant agent-co) deleted.");
    expect(h.out()).toContain("Unset MAILERY_SESSION_TOKEN");
  });

  test("--json reports the server result plus the confirmed identity", async () => {
    const h = harness();
    await runCli(argv("account", "delete", "--password", "pw", "--confirm-email", "owner@example.com", "--json"), h.deps);
    expect(h.exitCode()).toBe(0);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ ok: true, deleted: { tenant_id: "t1", user_id: "u1" }, email: "owner@example.com", tenant: "agent-co" });
  });

  test("an active subscription (409) surfaces the portal hint; a wrong password (403) the re-auth hint", async () => {
    const blocked = harness({
      deleteStatus: 409,
      deleteBody: { error: { code: "subscription_active", message: "cancel the subscription in the Stripe customer portal before deleting the account", details: { portal: "POST /api/v1/billing/portal" } } },
    });
    await runCli(argv("account", "delete", "--password", "pw", "--confirm-email", "owner@example.com", "--json"), blocked.deps);
    expect(blocked.exitCode()).toBe(1);
    const env = parseJsonOut(blocked.out());
    expect(env.error?.code).toBe("subscription_active");
    expect(env.error?.status).toBe(409);
    expect(env.error?.hint).toContain("customer portal");

    const wrongPassword = harness({
      deleteStatus: 403,
      deleteBody: { error: { code: "invalid_password", message: "password re-authentication failed; the account was not deleted" } },
    });
    await runCli(argv("account", "delete", "--password", "nope", "--confirm-email", "owner@example.com"), wrongPassword.deps);
    expect(wrongPassword.exitCode()).toBe(1);
    expect(wrongPassword.err()).toContain("nothing was deleted");
  });

  test("an API-key-only environment never reaches DELETE: the session is required up front", async () => {
    const h = makeHarness({
      route: (c) => c.path === "/api/v1/auth/me" ? { body: { user: null, tenant: TENANT, auth: { via: "api_key", scopes: ["full"] } } } : undefined,
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("account", "delete", "--password", "pw", "--confirm-email", "owner@example.com", "--json"), h.deps);
    expect(h.exitCode()).toBe(1);
    const env = parseJsonOut(h.out());
    expect(env.error?.code).toBe("unauthorized");
    expect(env.error?.hint).toContain("mailery login");
    expect(h.calls).toHaveLength(0);
  });

  test("a session that resolves to no user email cannot confirm: no DELETE", async () => {
    const h = makeHarness({
      route: (c) => c.path === "/api/v1/auth/me" ? { body: { user: null, tenant: TENANT, auth: { via: "session", scopes: ["full"] } } } : undefined,
      env: { MAILERY_SESSION_TOKEN: SESSION },
    });
    await runCli(argv("account", "delete", "--password", "pw", "--confirm-email", "owner@example.com", "--json"), h.deps);
    expect(h.exitCode()).toBe(1);
    expect(parseJsonOut(h.out()).error?.code).toBe("session_required");
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
