import { expect, test } from "bun:test";
import { MaileryClient } from "../src/client.js";
import { callTool, MCP_TOOLS } from "../src/mcp.js";

test("SDK obtains exact order and sends only explicit separate choices on confirm", async () => {
  const calls: Array<{url: string; body: any; key: string | null}> = [];
  const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic-session", fetch: async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get("idempotency-key") }); return Response.json({ url: "https://checkout.stripe.com/synthetic", orderId: "order-fixture" }); } });
  await client.getCheckoutOrder("order-fixture");
  const input = { language: "en" as const, requestImmediatePerformance: true as const, acknowledgeWithdrawal: true as const, immediateVersion: "a".repeat(64), withdrawalVersion: "b".repeat(64), idempotencyKey: "fixture-order-key" };
  await client.confirmCheckoutOrder("order-fixture", input);
  expect(calls[0]!.url).toEndWith("/api/v1/billing/checkout/order-fixture");
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
  const positive=await callTool("confirm_checkout_order", {orderId:"order-fixture",language:"en",requestImmediatePerformance:true,acknowledgeWithdrawal:true,immediateVersion:"a".repeat(64),withdrawalVersion:"b".repeat(64),idempotencyKey:"fixture-confirm-key"},client);
  expect(positive.isError).not.toBe(true); expect(calls).toBe(1);
  const tool = MCP_TOOLS.find(t => t.name === "confirm_checkout_order")!;
  expect((tool.inputSchema.required as string[])).toContain("requestImmediatePerformance");
  expect((tool.inputSchema.required as string[])).toContain("acknowledgeWithdrawal");
});
