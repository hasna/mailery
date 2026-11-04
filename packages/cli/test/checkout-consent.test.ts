import { expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness } from "./support.js";

const version = "a".repeat(64);
async function confirm(options: string[]) {
  const h = makeHarness({ env: { MAILERY_SESSION_TOKEN: "synthetic" }, route: () => ({ body: { url: "http://127.0.0.1:9/checkout" } }) });
  await runCli(argv("billing", "confirm-order", "order-fixture", ...options, "--json"), h.deps);
  return h;
}
const exact = ["--language", "en", "--checkout-protocol", "stripe-terms-v1", "--checkout-terms-version", version, "--idempotency-key", "fixture-key"];
test("CLI carries exact Stripe preparation body and stable key without manufacturing acceptance", async () => {
  const h = await confirm(exact);
  expect(h.exitCode()).toBe(0);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.path).toBe("/api/v1/billing/checkout/order-fixture/confirm");
  expect(h.calls[0]!.headers["idempotency-key"]).toBe("fixture-key");
  expect(h.calls[0]!.body).toEqual({ language: "en", checkoutProtocol: "stripe-terms-v1", checkoutTermsVersion: version });
});
test("CLI refuses wrong or missing protocol/version and legacy choice flags before dispatch", async () => {
  for (const field of ["--checkout-protocol", "--checkout-terms-version", "--idempotency-key"]) {
    const missing = exact.filter((_, i) => i !== exact.indexOf(field) && i !== exact.indexOf(field) + 1);
    const h = await confirm(missing);
    expect(h.exitCode()).not.toBe(0); expect(h.calls).toHaveLength(0);
  }
  for (const args of [exact.map(x => x === "stripe-terms-v1" ? "wrong" : x), exact.map(x => x === version ? "wrong" : x), [...exact, "--request-start-now"], [...exact, "--acknowledge-withdrawal"]]) {
    const h = await confirm(args);
    expect(h.exitCode()).not.toBe(0); expect(h.calls).toHaveLength(0);
  }
});
