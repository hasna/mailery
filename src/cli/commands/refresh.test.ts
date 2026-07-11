import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../../db/database.js";

// Mock the pull engine so we test the command's behavior, not AWS.
let pullResult: { pulled: number; ok: boolean; reason?: string; configured: boolean; forwarded?: { attempted: number; sent: number; failed: number; skipped: number } };
let lastOpts: unknown;
mock.module("../tui/autopull.js", () => ({
  autoPull: mock(async (opts: unknown) => { lastOpts = opts; return pullResult; }),
}));

const { registerRefreshCommand } = await import("./refresh.js");
const { Command } = await import("commander");
const originalHome = process.env["HOME"];
let tmpHome = "";

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

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  tmpHome = mkdtempSync(join(tmpdir(), "emails-refresh-source-"));
  process.env["HOME"] = tmpHome;
  resetDatabase();
  pullResult = { pulled: 0, ok: true, configured: true };
  lastOpts = undefined;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  process.exitCode = 0;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe("emails refresh", () => {
  it("pulls all buckets with a high scan limit by default", async () => {
    pullResult = { pulled: 3, ok: true, configured: true };
    const { out } = await runAsync(["refresh"]);
    expect(lastOpts).toMatchObject({ s3: true, forwarding: true, limit: 1000 });
    expect(out).toContain("Pulled 3 new emails");
  });

  it("can skip forwarding after refresh", async () => {
    await runAsync(["refresh", "--no-forwarding"]);
    expect(lastOpts).toMatchObject({ forwarding: false });
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

  it("reports forwarded mail when forwarding rules send copies", async () => {
    pullResult = { pulled: 2, ok: true, configured: true, forwarded: { attempted: 1, sent: 1, failed: 0, skipped: 0 } };
    const { out, data } = await runAsync(["refresh"]);
    expect(out).toContain("Pulled 2 new emails; forwarded 1");
    expect(data).toMatchObject({ pulled: 2, forwarded: { sent: 1 }, ok: true });
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
