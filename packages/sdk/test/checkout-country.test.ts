import { expect, test } from "bun:test";
import { MaileryClient } from "../src/client.js";
import { handleMcpMessage, MCP_TOOLS } from "../src/mcp.js";

test("SDK exposes the public policy and forwards the exact declaration with the original purchase key", async () => {
  const calls: Array<{ path: string; auth: string | null; key: string | null; body: unknown }> = [];
  const client = new MaileryClient({ baseUrl: "http://127.0.0.1:55586", sessionToken: "synthetic-owner-session", retries: 0, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    calls.push({ path, auth: headers.get("authorization"), key: headers.get("idempotency-key"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(path.endsWith("countries") ? { version: "synthetic-version", restricted_countries: ["RO"] } : { url: "http://127.0.0.1:55586/synthetic-checkout" });
  }});
  const policy = await client.getCheckoutCountryPolicy();
  expect(policy.restricted_countries).toEqual(["RO"]);
  expect(calls[0]!.auth).toBeNull();
  const declaration = { country: "US", countryBasis: "residence" as const, countryPolicyVersion: policy.version };
  await client.createCheckout({ kind: "credit_pack", credits: 1000, idempotencyKey: "stable-country-purchase", ...declaration });
  await client.topUpWallet({ amountCents: 1000, idempotencyKey: "stable-country-wallet", ...declaration });
  for (const call of calls.slice(1)) {
    expect(call.body).toMatchObject(declaration);
    expect(call.body).not.toHaveProperty("idempotencyKey");
    expect(call.auth).toBe("Bearer synthetic-owner-session");
  }
  expect(calls.map((call) => call.key)).toEqual([null, "stable-country-purchase", "stable-country-wallet"]);
});

test("MCP first-step policy and wallet schema expose and preserve the country declaration", async () => {
  const tool = MCP_TOOLS.find((tool) => tool.name === "add_wallet_funds")!;
  expect(tool.inputSchema.required).toEqual(["amountCents", "idempotencyKey"]);
  expect(tool.description).toContain("New purchases require all three country fields");
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new MaileryClient({ baseUrl: "http://127.0.0.1:55586", sessionToken: "synthetic-owner-session", retries: 0, fetch: async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ version: "policy-version", restricted_countries: ["RO"] });
  }});
  const first = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_checkout_country_policy", arguments: {} } }, client);
  expect(JSON.stringify(first)).toContain("RO");
  const declaration = { country: "US", countryBasis: "billing", countryPolicyVersion: "policy-version" };
  await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_wallet_funds", arguments: { amountCents: 1000, idempotencyKey: "stable-mcp-wallet", ...declaration } } }, client);
  expect(calls[0]!.path).toBe("/api/v1/billing/countries");
  expect(calls[1]!.body).toMatchObject(declaration);
});

test("SDK and MCP preserve an explicit original policy across discovery changes and can send exact historical bodies", async () => {
  let version = "original-version";
  const bodies: unknown[] = [];
  const client = new MaileryClient({ baseUrl: "http://127.0.0.1:1", sessionToken: "synthetic-session", retries: 0, fetch: async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("countries")) return Response.json({ version, restricted_countries: [] });
    bodies.push(JSON.parse(String(init?.body))); return Response.json({ url: "https://stripe.test/original" });
  } });
  const policy = await client.getCheckoutCountryPolicy();
  const declaration = { country: "US", countryBasis: "billing" as const, countryPolicyVersion: policy.version };
  await client.createCheckout({ kind: "subscription", plan: "pro", idempotencyKey: "original-checkout-key", ...declaration });
  version = "later-version"; await client.getCheckoutCountryPolicy();
  await client.createCheckout({ kind: "subscription", plan: "pro", idempotencyKey: "original-checkout-key", ...declaration });
  expect(bodies[1]).toEqual(bodies[0]);
  for (let attempt = 0; attempt < 2; attempt++) {
    await handleMcpMessage({ jsonrpc: "2.0", id: 10 + attempt, method: "tools/call", params: { name: "add_wallet_funds", arguments: { amountCents: 1000, idempotencyKey: "original-wallet-key", ...declaration } } }, client);
  }
  expect(bodies[3]).toEqual(bodies[2]);
  expect(bodies[3]).toMatchObject({ countryPolicyVersion: "original-version" });
  await client.createCheckout({ kind: "credit_pack", credits: 1000, idempotencyKey: "base-pack-key" });
  await handleMcpMessage({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "add_wallet_funds", arguments: { amountCents: 1000, idempotencyKey: "base-wallet-key" } } }, client);
  expect(bodies[4]).toEqual({ kind: "credit_pack", credits: 1000 });
  expect(bodies[5]).toEqual({ amountCents: 1000 });
});
