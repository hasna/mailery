// `mailery webhooks *` command tests: parsing, request shape, envelopes, and
// the secret-shown-once wording. No network — the routing fake fetch stands
// in for the server.

import { describe, expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut, type RouteHandler } from "./support.js";

const ENDPOINT = {
  id: "wh_1",
  url: "https://hooks.example.com/mailery",
  description: null,
  events: ["email.received"],
  status: "active",
  secret_prefix: "whsec_abc123",
  failure_count: 0,
  last_success_at: null,
  last_failure_at: null,
  created_at: "2026-09-10T00:00:00.000Z",
  updated_at: "2026-09-10T00:00:00.000Z",
};

const route: RouteHandler = (c) => {
  if (c.path === "/api/v1/webhooks" && c.method === "POST") return { status: 201, body: { endpoint: { ...ENDPOINT, events: (c.body as { events?: string[] }).events ?? null }, secret: "whsec_shown-once" } };
  if (c.path === "/api/v1/webhooks" && c.method === "GET") return { body: { data: [ENDPOINT, { ...ENDPOINT, id: "wh_2", status: "dead", failure_count: 20, events: null }] } };
  if (c.path === "/api/v1/webhooks/wh_1" && c.method === "GET") return { body: ENDPOINT };
  if (c.path === "/api/v1/webhooks/wh_1" && c.method === "PATCH") return { body: { ...ENDPOINT, ...(c.body as Record<string, unknown>) } };
  if (c.path === "/api/v1/webhooks/wh_1" && c.method === "DELETE") return { body: { ok: true, id: "wh_1" } };
  if (c.path === "/api/v1/webhooks/wh_1/rotate-secret") return { body: { endpoint: { ...ENDPOINT, secret_prefix: "whsec_def456" }, secret: "whsec_rotated-once" } };
  if (c.path === "/api/v1/webhooks/wh_1/test") return { status: 202, body: { event_id: "evt_1", delivery: { id: "d_1", status: "pending", event_type: "webhook.test", attempt: 0 } } };
  if (c.path === "/api/v1/webhooks/wh_1/deliveries") return { body: { data: [{ id: "d_1", event_id: "evt_1", event_type: "webhook.test", status: "failed", attempt: 2, response_status: 500, last_error: "HTTP 500: boom" }], next_cursor: "cursor-2" } };
  if (c.path === "/api/v1/webhooks/wh_1/deliveries/d_1/redeliver") return { status: 202, body: { delivery: { id: "d_2", event_id: "evt_1", event_type: "webhook.test", status: "pending", attempt: 0 } } };
  return undefined;
};

function harness() {
  return makeHarness({ route, env: { MAILERY_API_KEY: "ml_key" } });
}

describe("mailery webhooks", () => {
  test("create posts url/description/events with an idempotency key and prints the secret once", async () => {
    const h = harness();
    await runCli(argv("webhooks", "create", "https://hooks.example.com/mailery", "--events", "email.received,email.bounced", "--description", "agent inbox", "--json"), h.deps);
    expect(h.exitCode()).toBe(0);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { secret: string }).secret).toBe("whsec_shown-once");
    const call = h.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ url: "https://hooks.example.com/mailery", description: "agent inbox", events: ["email.received", "email.bounced"] });
    expect(call.headers["idempotency-key"]).toBeUndefined();
    expect(call.auth).toBe("Bearer ml_key");

    const text = harness();
    await runCli(argv("webhooks", "create", "https://hooks.example.com/mailery", "--idempotency-key", "stable-key-12345"), text.deps);
    expect(text.out()).toContain("Signing secret (shown once): whsec_shown-once");
    expect(text.calls[0]!.headers["idempotency-key"]).toBe("stable-key-12345");
  });

  test("list prints one line per endpoint with filter, status, and consecutive failures", async () => {
    const h = harness();
    await runCli(argv("webhooks", "list"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain("wh_1  https://hooks.example.com/mailery  [email.received]  active");
    expect(h.out()).toContain("wh_2  https://hooks.example.com/mailery  [*]  dead (20 consecutive failures)");
    const json = harness();
    await runCli(argv("webhooks", "list", "--json"), json.deps);
    expect((parseJsonOut(json.out()).data as unknown[]).length).toBe(2);
  });

  test("get / update / delete / rotate-secret / test hit their routes with the right bodies", async () => {
    const h = harness();
    await runCli(argv("webhooks", "get", "wh_1"), h.deps);
    expect(h.out()).toContain("secret:   whsec_abc123…");

    const update = harness();
    await runCli(argv("webhooks", "update", "wh_1", "--status", "active", "--events", "all", "--json"), update.deps);
    expect(update.calls[0]!.method).toBe("PATCH");
    expect(update.calls[0]!.body).toEqual({ events: null, status: "active" });

    const updateEvents = harness();
    await runCli(argv("webhooks", "update", "wh_1", "--events", "email.*,domain.ready", "--url", "https://new.example.com/h", "--json"), updateEvents.deps);
    expect(updateEvents.calls[0]!.body).toEqual({ url: "https://new.example.com/h", events: ["email.*", "domain.ready"] });

    const noop = harness();
    await runCli(argv("webhooks", "update", "wh_1", "--json"), noop.deps);
    expect(noop.exitCode()).toBe(1);
    expect((parseJsonOut(noop.out()).error as { code: string }).code).toBe("cli_usage_error");
    expect(noop.calls).toHaveLength(0);

    const badStatus = harness();
    await runCli(argv("webhooks", "update", "wh_1", "--status", "dead", "--json"), badStatus.deps);
    expect(badStatus.exitCode()).toBe(1);
    expect(badStatus.calls).toHaveLength(0);

    const del = harness();
    await runCli(argv("webhooks", "delete", "wh_1"), del.deps);
    expect(del.calls[0]!.method).toBe("DELETE");
    expect(del.out()).toContain("Webhook wh_1 deleted.");

    const rotate = harness();
    await runCli(argv("webhooks", "rotate-secret", "wh_1"), rotate.deps);
    expect(rotate.calls[0]!.path).toBe("/api/v1/webhooks/wh_1/rotate-secret");
    expect(rotate.calls[0]!.headers["idempotency-key"]).toBeUndefined();
    expect(rotate.out()).toContain("New signing secret (shown once): whsec_rotated-once");

    const testCmd = harness();
    await runCli(argv("webhooks", "test", "wh_1"), testCmd.deps);
    expect(testCmd.calls[0]!.path).toBe("/api/v1/webhooks/wh_1/test");
    expect(testCmd.out()).toContain("Test event evt_1 queued (delivery d_1, pending).");
  });

  test("deliveries lists attempts with status/error and the next cursor; redeliver queues a new delivery", async () => {
    const h = harness();
    await runCli(argv("webhooks", "deliveries", "wh_1", "--status", "failed", "--limit", "10"), h.deps);
    expect(h.calls[0]!.query).toEqual({ status: "failed", limit: "10" });
    expect(h.out()).toContain("d_1  webhook.test  failed  attempt 2  HTTP 500  HTTP 500: boom");
    expect(h.out()).toContain("next page: --cursor cursor-2");

    const redeliver = harness();
    await runCli(argv("webhooks", "redeliver", "wh_1", "d_1", "--json"), redeliver.deps);
    expect(redeliver.calls[0]!.path).toBe("/api/v1/webhooks/wh_1/deliveries/d_1/redeliver");
    expect((parseJsonOut(redeliver.out()).data as { id: string }).id).toBe("d_2");
  });
});
