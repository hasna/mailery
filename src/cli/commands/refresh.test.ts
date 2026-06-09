import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock the pull engine so we test the command's behavior, not AWS.
let pullResult: { pulled: number; ok: boolean; reason?: string; configured: boolean };
let lastOpts: unknown;
mock.module("../tui/autopull.js", () => ({
  autoPull: mock(async (opts: unknown) => { lastOpts = opts; return pullResult; }),
}));

const { registerRefreshCommand } = await import("./refresh.js");
const { Command } = await import("commander");

async function runAsync(args: string[]) {
  const out: string[] = [];
  const orig = console.log;
  console.log = ((m?: unknown) => { out.push(String(m ?? "")); }) as typeof console.log;
  let data: unknown;
  const program = new Command();
  program.exitOverride();
  // The command prints via console.log (warnings/errors) AND via the output()
  // callback (success/up-to-date) — capture both into `out`.
  registerRefreshCommand(program, (d, formatted) => { data = d; out.push(String(formatted ?? "")); });
  await program.parseAsync(["node", "emails", ...args]);
  console.log = orig;
  return { out: out.join("\n"), data };
}

beforeEach(() => { pullResult = { pulled: 0, ok: true, configured: true }; lastOpts = undefined; });

describe("emails refresh", () => {
  it("pulls all buckets with a high scan limit by default", async () => {
    pullResult = { pulled: 3, ok: true, configured: true };
    const { out } = await runAsync(["refresh"]);
    expect(lastOpts).toMatchObject({ s3: true, gmail: false, limit: 1000 });
    expect(out).toContain("Pulled 3 new emails");
  });

  it("passes --gmail through and respects --limit", async () => {
    await runAsync(["refresh", "--gmail", "--limit", "50"]);
    expect(lastOpts).toMatchObject({ s3: true, gmail: true, limit: 50 });
  });

  it("bounds invalid or oversized scan limits", async () => {
    await runAsync(["refresh", "--limit", "-1"]);
    expect(lastOpts).toMatchObject({ limit: 1000 });

    await runAsync(["refresh", "--limit", "999999"]);
    expect(lastOpts).toMatchObject({ limit: 10000 });
  });

  it("reports up-to-date when nothing new", async () => {
    pullResult = { pulled: 0, ok: true, configured: true };
    const { out } = await runAsync(["refresh"]);
    expect(out).toContain("Up to date");
  });

  it("warns when no inbound sources are configured", async () => {
    pullResult = { pulled: 0, ok: true, configured: false };
    const { out } = await runAsync(["refresh"]);
    expect(out).toContain("No inbound sources configured");
  });

  it("surfaces an error reason", async () => {
    pullResult = { pulled: 0, ok: false, reason: "Could not load credentials", configured: true };
    const { out } = await runAsync(["refresh"]);
    expect(out).toContain("Could not load credentials");
  });
});
