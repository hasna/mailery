import { describe, expect, test } from "bun:test";
import { MaileryClient } from "../src/client.js";

function response(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

describe("MaileryClient retry safety", () => {
  test("retries a safe GET after a retryable server response", async () => {
    let calls = 0;
    const client = new MaileryClient({
      baseUrl: "https://mailery.test",
      apiKey: "ml_key",
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? response(503, { error: { code: "unavailable", message: "try again" } })
          : response(200, { data: [] });
      },
    });

    await expect(client.listDomains()).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("does not retry a mutating request without caller-stable idempotency", async () => {
    let calls = 0;
    const client = new MaileryClient({
      baseUrl: "https://mailery.test",
      sessionToken: "admin_session",
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        return response(503, { error: { code: "unavailable", message: "commit outcome unknown" } });
      },
    });

    await expect(client.adminAdjustCredits({ tenantId: "tenant_1", amount: 10, reason: "support" }))
      .rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(calls).toBe(1);
  });

  test("retries an idempotency-protected mutation with the same key", async () => {
    const keys: Array<string | undefined> = [];
    const client = new MaileryClient({
      baseUrl: "https://mailery.test",
      apiKey: "ml_key",
      sleep: async () => {},
      fetch: async (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        keys.push(headers["idempotency-key"]);
        return keys.length === 1
          ? response(503, { error: { code: "unavailable", message: "try again" } })
          : response(200, { domain: "example.com", ownership_ready: true, resumed: true });
      },
    });

    await expect(client.purchaseDomain({
      domain: "example.com",
      quoteToken: "signed_quote",
      maxPriceCents: 1500,
      currency: "usd",
      idempotencyKey: "caller-stable-key",
    })).resolves.toMatchObject({ domain: "example.com", resumed: true });
    expect(keys).toEqual(["caller-stable-key", "caller-stable-key"]);
  });

  test("setupDomain strips idempotencyKey from the body and sends it as Idempotency-Key", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const client = new MaileryClient({
      baseUrl: "https://mailery.test",
      apiKey: "ml_key",
      retries: 0,
      fetch: async (_input, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response(200, { domain: "example.com" });
      },
    });

    await client.setupDomain({
      domain: "example.com",
      buy: true,
      quoteToken: "signed_quote",
      maxPriceCents: 1500,
      currency: "usd",
      idempotencyKey: "setup-stable-key",
    });

    expect(capturedHeaders?.["idempotency-key"]).toBe("setup-stable-key");
    expect(capturedBody).toEqual({ domain: "example.com", buy: true, quoteToken: "signed_quote", maxPriceCents: 1500, currency: "usd" });
  });
});

describe("Checkout caller binding", () => {
  test("same-key transport retry sends the original header and normalized body", async () => {
    const requests: Array<{ key?: string; body: unknown }> = [];
    const client = new MaileryClient({
      baseUrl: "https://mailery.test", sessionToken: "synthetic-session", sleep: async () => {},
      fetch: async (_url, init) => {
        requests.push({ key: (init!.headers as Record<string, string>)["idempotency-key"], body: JSON.parse(String(init!.body)) });
        if (requests.length === 1) throw new Error("synthetic lost HTTP response");
        return response(200, { url: "https://stripe.test/original" });
      },
    });
    await expect(client.createCheckout({ kind: "subscription", plan: "pro", idempotencyKey: "stable-sdk-purchase" })).resolves.toBe("https://stripe.test/original");
    expect(requests).toEqual([
      { key: "stable-sdk-purchase", body: { kind: "subscription", plan: "pro" } },
      { key: "stable-sdk-purchase", body: { kind: "subscription", plan: "pro" } },
    ]);
  });

  test("credit-pack creation propagates an explicit key, while 0.1.0's string call remains headerless", async () => {
    const requests: Array<{ key?: string; body: unknown }> = [];
    const client = new MaileryClient({
      baseUrl: "https://mailery.test", sessionToken: "synthetic-session",
      fetch: async (_url, init) => {
        requests.push({ key: (init!.headers as Record<string, string>)["idempotency-key"], body: JSON.parse(String(init!.body)) });
        return response(200, { url: "https://stripe.test/original" });
      },
    });
    await client.createCheckout({ kind: "credit_pack", credits: 1000, idempotencyKey: "stable-pack-purchase" });
    await client.createCheckout("pro");
    expect(requests).toEqual([
      { key: "stable-pack-purchase", body: { kind: "credit_pack", credits: 1000 } },
      { key: undefined, body: { kind: "subscription", plan: "pro" } },
    ]);
  });

  test("an uncertain Checkout is returned unchanged without another request", async () => {
    let calls = 0;
    const client = new MaileryClient({
      baseUrl: "https://mailery.test", sessionToken: "synthetic-session",
      fetch: async () => { calls++; return response(409, { error: { code: "checkout_outcome_ambiguous", message: "retain the original purchase key" } }); },
    });
    await expect(client.createCheckout({ plan: "pro", idempotencyKey: "uncertain-purchase" })).rejects.toMatchObject({ code: "checkout_outcome_ambiguous" });
    expect(calls).toBe(1);
  });
});
