import { expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut } from "./support.js";

const inbound = { metering_active: true, month: "2026-09", monthly_included: 6000, received: 4800,
  remaining_included: 1200, charged_credits: 0, overage_credit_cost: 1, warning_percent: 80,
  status: "near_allowance", resets_at: "2026-10-01T00:00:00.000Z" };
const overview = { balance: 10, plans: {}, subscriptions: [], ledger: [], credit_packs: {}, inbound_usage: inbound };

for (const args of [["billing", "status"], ["usage"]]) {
  test(`${args.join(" ")} exposes inbound allowance, overage and reset in text and JSON`, async () => {
    const h = makeHarness({ env: { MAILERY_API_KEY: "ml_key" }, route: () => ({ body: overview }) });
    await runCli(argv(...args), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain("inbound: 4800/6000 included");
    expect(h.out()).toContain("1200 remaining");
    expect(h.out()).toContain("near allowance");
    expect(h.out()).toContain(inbound.resets_at);
    const j = makeHarness({ env: { MAILERY_API_KEY: "ml_key" }, route: () => ({ body: overview }) });
    await runCli(argv(...args, "--json"), j.deps);
    expect((parseJsonOut(j.out()).data as any).inbound_usage).toEqual(inbound);
  });
}
