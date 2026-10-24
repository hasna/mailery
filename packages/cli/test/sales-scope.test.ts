import { expect, test } from "bun:test";
import { MaileryClient, callTool } from "@hasna/mailery-sdk-internal";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut, routeFetch } from "./support.js";

const target = "http://127.0.0.1:55586";
const refusal = (code: string) => ({ status: 409, body: { error: { code, message: "Sales capability is unavailable" } } });
const quote = { token: "synthetic-quote", domain: "owned.example", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z" };
for (const [command, code] of [
  [["billing", "add-funds", "10", "--yes", "--replay-legacy", "--idempotency-key", "original-request"], "wallet_funding_disabled"],
  [["domains", "buy", "owned.example", "--yes", "--max-price-cents", "1500", "--currency", "usd", "--idempotency-key", "original-request"], "domain_sales_disabled"],
  [["domains", "setup", "owned.example", "--buy", "--yes", "--max-price-cents", "1500", "--currency", "usd", "--idempotency-key", "original-request"], "domain_sales_disabled"],
  [["domains", "renew", "domain-id", "--yes", "--idempotency-key", "original-request"], "domain_sales_disabled"],
  [["domains", "auto-renew", "domain-id", "on"], "domain_sales_disabled"],
] as const) test("CLI preserves server sales refusal for " + command.join(" "), async () => {
  const h = makeHarness({
    env: { MAILERY_BASE_URL: target, MAILERY_SESSION_TOKEN: "synthetic-session" },
    route: call => call.path.endsWith("/availability") ? { body: { ...quote, available: true, purchase_supported: true, purchase_quote: quote } } : refusal(code),
  });
  await runCli(argv(...command, "--json"), h.deps);
  expect(h.exitCode()).not.toBe(0);
  expect(parseJsonOut(h.out()).error?.code).toBe(code);
  expect(h.calls.filter(call => call.method === "POST")).toHaveLength(1);
});
test("MCP retains wallet/domain refusal codes", async () => {
  const client = new MaileryClient({
    baseUrl: target, sessionToken: "synthetic-session", retries: 0,
    fetch: routeFetch(call => call.path.endsWith("/availability")
      ? { body: { ...quote, available: true, purchase_supported: true, purchase_quote: quote } }
      : refusal(call.path.includes("wallet") ? "wallet_funding_disabled" : "domain_sales_disabled")),
  });
  const wallet = await callTool("add_wallet_funds", { amountCents: 1000, idempotencyKey: "original-request" }, client);
  const domain = await callTool("buy_domain", { domain: "owned.example", maxPriceCents: 1500, currency: "usd", idempotencyKey: "original-request" }, client);
  expect(wallet.isError).toBe(true);
  expect(domain.isError).toBe(true);
  expect(JSON.stringify(wallet)).toContain("wallet_funding_disabled");
  expect(JSON.stringify(domain)).toContain("domain_sales_disabled");
});
test("CLI BYO setup and hosted mailbox create need no purchase call", async () => {
  const h = makeHarness({
    env: { MAILERY_BASE_URL: target, MAILERY_SESSION_TOKEN: "synthetic-session" },
    route: call => ({ body: call.path.endsWith("/setup")
      ? { domain: "owned.example", status: "planned", records: [] }
      : { id: "mailbox", email: "agent@owned.example", provider: "ses", status: "active" } }),
  });
  await runCli(argv("domains", "setup", "owned.example", "--address", "agent", "--json"), h.deps);
  expect(h.exitCode()).toBe(0);
  await runCli(argv("mailboxes", "create", "agent@owned.example", "--json"), h.deps);
  expect(h.exitCode()).toBe(0);
  expect(h.calls.map(call => call.path)).toEqual(["/api/v1/domains/setup", "/api/v1/mailboxes"]);
  expect(h.calls[0]!.body).toEqual({ domain: "owned.example", address: "agent" });
});
