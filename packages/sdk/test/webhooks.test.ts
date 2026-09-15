import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { MaileryClient } from "../src/client.js";
import { parseWebhookEvent, verifyWebhookSignature, WEBHOOK_REPLAY_WINDOW_SECONDS } from "../src/webhooks.js";

// Receiver-side helpers: WebCrypto HMAC must agree byte-for-byte with the
// server's node:crypto signer (`v1=` + hex HMAC-SHA256 over `${ts}.${body}`).

const secret = "whsec_sdk-receiver-secret";
const body = JSON.stringify({ id: "evt_1", type: "email.received", created_at: "2026-09-10T00:00:00.000Z", tenant_id: "t_1", data: { message_id: "m_1" } });
const timestamp = 1_789_000_000;
const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

describe("verifyWebhookSignature (WebCrypto)", () => {
  test("agrees with the server signer and enforces the replay window", async () => {
    expect(await verifyWebhookSignature({ secret, body, signature, timestamp, nowSeconds: timestamp + 5 })).toEqual({ ok: true });
    expect(await verifyWebhookSignature({ secret, body: new TextEncoder().encode(body), signature, timestamp: String(timestamp), nowSeconds: timestamp })).toEqual({ ok: true });
    expect(await verifyWebhookSignature({ secret, body: `${body}!`, signature, timestamp, nowSeconds: timestamp })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(await verifyWebhookSignature({ secret: "whsec_other", body, signature, timestamp, nowSeconds: timestamp })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(await verifyWebhookSignature({ secret, body, signature, timestamp, nowSeconds: timestamp + WEBHOOK_REPLAY_WINDOW_SECONDS + 1 })).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(await verifyWebhookSignature({ secret, body, signature: null, timestamp, nowSeconds: timestamp })).toEqual({ ok: false, reason: "malformed_signature" });
    expect(await verifyWebhookSignature({ secret, body, signature, timestamp: null, nowSeconds: timestamp })).toEqual({ ok: false, reason: "malformed_timestamp" });
    expect(await verifyWebhookSignature({ secret, body, signature: `v1=deadbeef, ${signature}`, timestamp, nowSeconds: timestamp })).toEqual({ ok: true });
    expect(WEBHOOK_REPLAY_WINDOW_SECONDS).toBe(300);
  });

  test("parseWebhookEvent verifies first and only then parses; failures throw with the reason", async () => {
    const event = await parseWebhookEvent<{ message_id: string }>({ secret, body, signature, timestamp, nowSeconds: timestamp });
    expect(event.type).toBe("email.received");
    expect(event.data.message_id).toBe("m_1");
    await expect(parseWebhookEvent({ secret, body, signature: "v1=00", timestamp, nowSeconds: timestamp })).rejects.toThrow("signature_mismatch");
  });
});

describe("webhook mutations and the retry loop", () => {
  // Review finding 9: the server binds a terminal failure to the idempotency
  // key, so retrying a keyed create replays the same error and burns the
  // 30/hour create budget. Without a key the SDK must not retry a mutation at
  // all; with a caller-supplied key the caller has opted into replay.
  function countingClient(status: number, retries: number): { client: MaileryClient; count: () => number } {
    let n = 0;
    const client = new MaileryClient({
      baseUrl: "https://mailery.test",
      apiKey: "ml_key",
      retries,
      sleep: async () => {},
      fetch: async () => {
        n += 1;
        return Response.json({ error: { code: "rate_limited", message: "slow down" } }, { status });
      },
    });
    return { client, count: () => n };
  }

  test("createWebhook without a key issues exactly one request even with retries enabled", async () => {
    const { client, count } = countingClient(429, 3);
    await expect(client.createWebhook({ url: "https://hooks.example.com/x" })).rejects.toThrow();
    expect(count()).toBe(1);
  });

  test("createWebhook with a caller-supplied key opts into the retry loop", async () => {
    const { client, count } = countingClient(429, 2);
    await expect(client.createWebhook({ url: "https://hooks.example.com/x", idempotencyKey: "caller-stable-key" })).rejects.toThrow();
    expect(count()).toBe(3);
  });

  test("rotateWebhookSecret without a key does not retry either", async () => {
    const { client, count } = countingClient(500, 3);
    await expect(client.rotateWebhookSecret("wh_1")).rejects.toThrow();
    expect(count()).toBe(1);
  });
});

describe("MaileryClient webhook methods", () => {
  type Call = { method: string; path: string; body?: unknown; headers: Record<string, string>; query: URLSearchParams };

  function clientWithCalls(calls: Call[]): MaileryClient {
    return new MaileryClient({
      baseUrl: "https://mailery.test",
      apiKey: "ml_key",
      retries: 0,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push({
          method: String(init?.method ?? "GET"),
          path: url.pathname,
          query: url.searchParams,
          headers: (init?.headers as Record<string, string>) ?? {},
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (url.pathname.endsWith("/redeliver")) return Response.json({ delivery: { id: "d2", event_id: "e1" } }, { status: 202 });
        if (url.pathname.endsWith("/deliveries")) return Response.json({ data: [{ id: "d1" }], next_cursor: "c2" });
        if (url.pathname === "/api/v1/webhooks" && init?.method === "GET") return Response.json({ data: [{ id: "w1" }] });
        return Response.json({ endpoint: { id: "w1" }, secret: "whsec_x", id: "w1", ok: true });
      },
    });
  }

  test("every method hits the documented route; create/rotate always carry an Idempotency-Key", async () => {
    const calls: Call[] = [];
    const client = clientWithCalls(calls);
    expect(await client.listWebhooks()).toEqual([{ id: "w1" }]);
    await client.createWebhook({ url: "https://hooks.example.com/x", events: ["email.received"] });
    await client.createWebhook({ url: "https://hooks.example.com/x", idempotencyKey: "stable-create-key" });
    await client.getWebhook("w1");
    await client.updateWebhook("w1", { status: "active", events: null });
    await client.deleteWebhook("w1");
    await client.rotateWebhookSecret("w1");
    await client.rotateWebhookSecret("w1", { idempotencyKey: "stable-rotate-key" });
    await client.testWebhook("w1");
    const page = await client.listWebhookDeliveries("w1", { status: "dead", limit: 10, cursor: "c1" });
    expect(page).toEqual({ data: [{ id: "d1" }], nextCursor: "c2" });
    expect(await client.redeliverWebhook("w1", "d1")).toEqual({ id: "d2", event_id: "e1" });

    const routes = calls.map((c) => `${c.method} ${c.path}`);
    expect(routes).toEqual([
      "GET /api/v1/webhooks",
      "POST /api/v1/webhooks",
      "POST /api/v1/webhooks",
      "GET /api/v1/webhooks/w1",
      "PATCH /api/v1/webhooks/w1",
      "DELETE /api/v1/webhooks/w1",
      "POST /api/v1/webhooks/w1/rotate-secret",
      "POST /api/v1/webhooks/w1/rotate-secret",
      "POST /api/v1/webhooks/w1/test",
      "GET /api/v1/webhooks/w1/deliveries",
      "POST /api/v1/webhooks/w1/deliveries/d1/redeliver",
    ]);
    // Idempotency keys: never invented, honoured when supplied, never in the body.
    expect(calls[1]!.headers["idempotency-key"]).toBeUndefined();
    expect(calls[1]!.body).toEqual({ url: "https://hooks.example.com/x", events: ["email.received"] });
    expect(calls[2]!.headers["idempotency-key"]).toBe("stable-create-key");
    expect((calls[2]!.body as Record<string, unknown>).idempotencyKey).toBeUndefined();
    expect(calls[6]!.headers["idempotency-key"]).toBeUndefined();
    expect(calls[7]!.headers["idempotency-key"]).toBe("stable-rotate-key");
    expect(calls[4]!.body).toEqual({ status: "active", events: null });
    expect(calls[9]!.query.get("status")).toBe("dead");
    expect(calls[9]!.query.get("limit")).toBe("10");
    expect(calls[9]!.query.get("cursor")).toBe("c1");
  });
});
