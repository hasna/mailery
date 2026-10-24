import { expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut } from "./support.js";

for (const kind of ["subscription", "wallet"] as const) {
  const command = kind === "subscription" ? ["subscribe", "pro", "--no-wait"] : ["billing", "add-funds", "10", "--yes"];
  test(`${kind}: exact command retains its explicit original policy when current discovery changes`, async () => {
    let current = "original-policy", retained: unknown, dispatches = 0;
    const make = () => makeHarness({ env: { MAILERY_SESSION_TOKEN: "synthetic-session", MAILERY_BASE_URL: "http://127.0.0.1:1" }, route: call => {
      if (call.path.endsWith("countries")) return { body: { version: current, restricted_countries: ["RO"], disclosure_path: "/checkout" } };
      if (call.method === "POST") {
        if (!retained) { retained = call.body; dispatches++; }
        if (JSON.stringify(retained) !== JSON.stringify(call.body)) return { status: 409, body: { error: { code: "idempotency_key_conflict", message: "changed original purchase" } } };
        return { body: { url: "https://stripe.test/original" } };
      }
    } });
    const args = [...command, "--country", "US", "--country-basis", "billing", "--country-policy-version", current, "--idempotency-key", "original-purchase-key", "--json"];
    const first = make(); await runCli(argv(...args), first.deps); expect(first.exitCode()).toBe(0);
    current = "later-policy";
    const retry = make(); await runCli(argv(...args), retry.deps); expect(retry.exitCode()).toBe(0);
    expect(retained).toMatchObject({ countryPolicyVersion: "original-policy" });
    expect(retry.calls.find(call => call.method === "POST")!.body).toEqual(retained);
    expect(dispatches).toBe(1);
  });
  test(`${kind}: missing original policy refuses locally instead of substituting discovery`, async () => {
    const h = makeHarness({ env: { MAILERY_SESSION_TOKEN: "synthetic-session" }, route: call => call.path.endsWith("countries") ? { body: { version: "current-policy", restricted_countries: [], disclosure_path: "/checkout" } } : undefined });
    await runCli(argv(...command, "--country", "US", "--country-basis", "billing", "--idempotency-key", "stable-purchase-key", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error?.code).toBe("checkout_country_policy_required");
    expect(h.calls.some(call => call.method === "POST")).toBe(false);
  });
  test(`${kind}: explicit historical replay omits every declaration and keeps the original API/key`, async () => {
    const h = makeHarness({ env: { MAILERY_SESSION_TOKEN: "synthetic-session" }, route: () => ({ body: { url: "https://stripe.test/legacy" } }) });
    await runCli(argv(...command, "--replay-legacy", "--idempotency-key", "original-base-key", "--json"), h.deps);
    expect(h.exitCode()).toBe(0); expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.path).toBe(kind === "subscription" ? "/api/v1/billing/checkout" : "/api/v1/billing/wallet/topup");
    expect(h.calls[0]!.headers["idempotency-key"]).toBe("original-base-key");
    expect(h.calls[0]!.body).toEqual(kind === "subscription" ? { kind: "subscription", plan: "pro" } : { amountCents: 1000 });
    const invalid = makeHarness({ env: { MAILERY_SESSION_TOKEN: "synthetic-session" } });
    await runCli(argv(...command, "--replay-legacy", "--country", "US", "--idempotency-key", "original-base-key", "--json"), invalid.deps);
    expect(parseJsonOut(invalid.out()).error?.code).toBe("cli_usage_error"); expect(invalid.calls).toHaveLength(0);
  });
}
