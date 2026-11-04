import { expect, test } from "bun:test";
import { MaileryClient } from "../src/client.js";
import { callTool, MCP_TOOLS } from "../src/mcp.js";
import { ENDPOINTS } from "../src/endpoints.js";

test("SDK obtains exact order and sends only explicit separate choices on confirm", async () => {
  const calls: Array<{url: string; body: any; key: string | null}> = [];
  const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic-session", fetch: async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get("idempotency-key") }); return Response.json({ url: "https://checkout.stripe.com/synthetic", orderId: "order-fixture" }); } });
  await client.getCheckoutOrder("order-fixture");
  const input = { language: "en" as const, requestImmediatePerformance: true as const, acknowledgeWithdrawal: true as const, immediateVersion: "a".repeat(64), withdrawalVersion: "b".repeat(64), idempotencyKey: "fixture-order-key" };
  await client.confirmCheckoutOrder("order-fixture", input);
  expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/billing/checkout/order-fixture");
  expect(new URL(calls[0]!.url).searchParams.get("checkoutProtocol")).toBe("stripe-terms-v1");
  expect(calls[1]!.url).toEndWith("/api/v1/billing/checkout/order-fixture/confirm");
  expect(calls[1]!.body.requestImmediatePerformance).toBe(true); expect(calls[1]!.body.acknowledgeWithdrawal).toBe(true); expect(calls[1]!.key).toBe(input.idempotencyKey);
  for (const key of ["requestImmediatePerformance", "acknowledgeWithdrawal"]) await expect(client.confirmCheckoutOrder("order-fixture", { ...input, [key]: false } as any)).rejects.toThrow();
  expect(calls).toHaveLength(2);
});
test("MCP never supplies default consent", async () => {
  let calls = 0;
  const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic-session", fetch: async () => { calls++; return Response.json({url: "https://checkout.stripe.com/synthetic"}); } });
  const result = await callTool("confirm_checkout_order", { orderId: "order-fixture", language: "en" }, client);
  expect(result.isError).toBe(true); expect(calls).toBe(0);
  const positive=await callTool("confirm_checkout_order", {orderId:"order-fixture",language:"en",checkoutProtocol:"stripe-terms-v1",checkoutTermsVersion:"a".repeat(64),idempotencyKey:"fixture-confirm-key"},client);
  expect(positive.isError).not.toBe(true); expect(calls).toBe(1);
  const tool = MCP_TOOLS.find(t => t.name === "confirm_checkout_order")!;
  expect((tool.inputSchema.required as string[])).toContain("checkoutProtocol");
  expect((tool.inputSchema.required as string[])).toContain("checkoutTermsVersion");
});

for (const endpoint of [ENDPOINTS.getCheckoutOrder, ENDPOINTS.confirmCheckoutOrder]) {
  test(`OpenAPI ${endpoint.method} ${endpoint.path} requires owner user-session bearer authentication`, async () => {
    const spec = await Bun.file(new URL("../../../docs/openapi.json", import.meta.url)).json();
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    const operation = spec.paths[endpoint.path]?.[endpoint.method.toLowerCase()];
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(operation.description).toContain("owner user session");
    expect(operation.description).toContain("API keys are not accepted");
  });
}


test("current SDK preparation preserves exact intent and rejects incomplete protocol inputs locally", async () => {
  const calls: Array<{body: any; key: string | null}> = [];
  const client = new MaileryClient({baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic", fetch: async (_, init) => {
    calls.push({body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key")});
    return Response.json({url: "http://127.0.0.1:9/checkout"});
  }});
  const input = {language: "ro" as const, checkoutProtocol: "stripe-terms-v1" as const, checkoutTermsVersion: "c".repeat(64), idempotencyKey: "stable-confirmation"};
  await client.confirmCheckoutOrder("order-fixture", input);
  await client.confirmCheckoutOrder("order-fixture", input);
  expect(calls).toEqual([0, 1].map(() => ({body: {language: "ro", checkoutProtocol: "stripe-terms-v1", checkoutTermsVersion: "c".repeat(64)}, key: "stable-confirmation"})));
  for (const invalid of [{...input, checkoutProtocol: "wrong"}, {...input, checkoutTermsVersion: "wrong"}, {...input, checkoutTermsVersion: undefined}, {...input, idempotencyKey: ""}]) {
    await expect(client.confirmCheckoutOrder("order-fixture", invalid as any)).rejects.toThrow();
  }
  expect(calls).toHaveLength(2);
});

test("MCP rejects legacy choices even when current protocol fields are supplied", async () => {
  let calls = 0;
  const client = new MaileryClient({baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic", fetch: async () => {calls++; return Response.json({url: "http://127.0.0.1:9/checkout"});}});
  const input = {orderId: "order-fixture", language: "en", checkoutProtocol: "stripe-terms-v1", checkoutTermsVersion: "a".repeat(64), idempotencyKey: "stable-confirm"};
  for (const field of ["requestImmediatePerformance", "acknowledgeWithdrawal", "immediateVersion", "withdrawalVersion", "acceptedTerms"]) {
    for (const value of [true, false, undefined]) {
      expect((await callTool("confirm_checkout_order", {...input, [field]: value}, client)).isError).toBe(true);
    }
  }
  for (const invalid of [{...input, checkoutProtocol: undefined}, {...input, checkoutTermsVersion: "wrong"}]) {
    expect((await callTool("confirm_checkout_order", invalid, client)).isError).toBe(true);
  }
  expect(calls).toBe(0);
  expect((await callTool("confirm_checkout_order", input, client)).isError).not.toBe(true);
  expect(calls).toBe(1);
});
