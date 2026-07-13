// Covers the client-flip (self_hosted) branch of the address CLI: with
// EMAILS_SELF_HOSTED_URL + EMAILS_SELF_HOSTED_API_KEY set and mode=self_hosted,
// `emails addresses` must READ from the selfHosted HTTP API (<app>.hasna.xyz/v1/addresses)
// rather than the local SQLite store. This mirrors the domains resource, which
// already routes to the selfHosted, and locks in the fix for the mission-alignment gap
// where `addresses` used to show empty LOCAL state in selfHosted mode.
//
// The self-hosted-store performs its HTTP call with a SYNCHRONOUS `curl` (spawnSync),
// which blocks Bun's event loop — so the stand-in for <app>.hasna.xyz/v1 runs in a
// SEPARATE process (an in-process server would deadlock). No module mocks are used,
// so the real transport path is exercised.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAddressCommands } from "./address.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";

const API_KEY = "hasna_emails_test_key_addresses_1234";
let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let serverDir = "";
let baseOrigin = "";

// A minimal stand-in for the self-hosted /v1/addresses resource.
const SERVER_SRC = `
const KEY = process.env.TEST_API_KEY;
const rows = new Map();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\\/+|\\/+$/g, "").split("/");
    if (req.method === "POST" && parts[0] === "v1" && parts[1] === "__reset") { rows.clear(); return json({ ok: true }); }
    if (req.headers.get("authorization") !== "Bearer " + KEY) return json({ error: "unauthorized" }, 401);
    if (parts[0] !== "v1" || parts[1] !== "addresses") return json({ error: "not found" }, 404);
    if (req.method === "GET" && !parts[2]) return json({ addresses: [...rows.values()] });
    if (req.method === "POST" && !parts[2]) {
      const body = await req.json();
      const now = new Date().toISOString();
      const entity = { id: crypto.randomUUID(), email: body.email, domain: null, display_name: body.display_name ?? null, status: body.status ?? "active", created_at: now, updated_at: now };
      rows.set(entity.id, entity);
      return json({ address: entity }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  },
});
console.log("PORT=" + server.port);
`;

async function seedCloudAddress(email: string) {
  const res = await fetch(`${baseOrigin}/v1/addresses`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status}`);
}

beforeAll(async () => {
  serverDir = mkdtempSync(join(tmpdir(), "emails-addr-selfHosted-test-"));
  const scriptPath = join(serverDir, "server.mjs");
  writeFileSync(scriptPath, SERVER_SRC);
  serverProc = Bun.spawn(["bun", scriptPath], {
    env: { ...process.env, TEST_API_KEY: API_KEY },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = serverProc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const m = buf.match(/PORT=(\d+)/);
    if (m) {
      baseOrigin = `http://127.0.0.1:${m[1]}`;
      break;
    }
  }
  reader.releaseLock();
  if (!baseOrigin) throw new Error("mock selfHosted server did not report a port");
});

afterAll(() => {
  serverProc?.kill();
  if (serverDir) rmSync(serverDir, { recursive: true, force: true });
});

async function runAddressCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAddressCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runAddressCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runAddressCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

async function withTempHome<T>(prefix: string, fn: (tmpHome: string) => Promise<T>): Promise<T> {
  const originalHome = process.env["HOME"];
  const tmpHome = mkdtempSync(join(tmpdir(), prefix));
  process.env["HOME"] = tmpHome;
  try {
    return await fn(tmpHome);
  } finally {
    closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

describe("address CLI — selfHosted (self_hosted) routing", () => {
  beforeEach(async () => {
    await fetch(`${baseOrigin}/v1/__reset`, { method: "POST" });
    process.env["EMAILS_DB_PATH"] = ":memory:";
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = baseOrigin;
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
    resetSelfHostedConfigCache();
  });
  afterEach(() => {
    delete process.env["EMAILS_MODE"];
    delete process.env["EMAILS_SELF_HOSTED_URL"];
    delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
    delete process.env["EMAILS_DB_PATH"];
    delete process.env["HASNA_EMAILS_DB_PATH"];
    resetSelfHostedConfigCache();
    closeDatabase();
  });

  it("`addresses` reads from the selfHosted API, not local SQLite", async () => {
    await seedCloudAddress("selfHosted-a@example.com");
    await seedCloudAddress("selfHosted-b@example.com");

    const { data } = await runAddressCommand(["addresses"]);
    const addresses = data as Array<{ email: string }>;
    expect(addresses.map((a) => a.email).sort()).toEqual(["selfHosted-a@example.com", "selfHosted-b@example.com"]);
  });

  it("API-backed address list does not create a default local DB under HOME", async () => {
    await withTempHome("emails-address-self-hosted-api-", async (tmpHome) => {
      await fetch(`${baseOrigin}/v1/__reset`, { method: "POST" });
      closeDatabase();
      resetDatabase();
      delete process.env["EMAILS_DB_PATH"];
      delete process.env["HASNA_EMAILS_DB_PATH"];
      process.env["EMAILS_MODE"] = "self_hosted";
      process.env["EMAILS_SELF_HOSTED_URL"] = baseOrigin;
      process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
      resetSelfHostedConfigCache();

      await seedCloudAddress("selfHosted-api@example.com");
      const { data } = await runAddressCommand(["addresses"]);

      expect((data as Array<{ email: string }>).map((a) => a.email)).toEqual(["selfHosted-api@example.com"]);
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });

  it("blocks local address lifecycle commands before creating a default local DB", async () => {
    await withTempHome("emails-address-self-hosted-local-only-", async (tmpHome) => {
      closeDatabase();
      resetDatabase();
      delete process.env["EMAILS_DB_PATH"];
      delete process.env["HASNA_EMAILS_DB_PATH"];
      process.env["EMAILS_MODE"] = "self_hosted";
      process.env["EMAILS_SELF_HOSTED_URL"] = baseOrigin;
      process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
      resetSelfHostedConfigCache();

      for (const args of [
        ["address", "provision", "agent@example.com", "--provider", "ses-provider"],
        ["address", "owner", "agent@example.com"],
        ["address", "quota", "addr123", "10"],
      ]) {
        const result = await runAddressCommandExpectingExit(args);
        expect(result.error).toBe("process.exit:1");
        expect(result.stderr).toContain("self_hosted API-only mode");
        expect(result.stderr).toContain("self-hosted server/operator API/workers");
        expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
      }
    });
  });

  it("does NOT return local addresses when flipped to selfHosted", async () => {
    // Seed the local SQLite island DIRECTLY (raw insert) — the repo helpers
    // (createAddress) correctly route to the selfHosted in selfHosted mode, so they cannot
    // be used to plant a local-only row. In selfHosted mode the CLI must ignore this
    // local row and show only what the selfHosted API returns (here: nothing, because
    // __reset cleared the mock).
    resetDatabase();
    const local = getDatabase();
    const nowIso = new Date().toISOString();
    const providerId = crypto.randomUUID();
    local.run(
      `INSERT INTO providers (id, name, type, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [providerId, "sandbox", "sandbox", nowIso, nowIso],
    );
    local.run(
      `INSERT INTO addresses (id, provider_id, email, display_name, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [crypto.randomUUID(), providerId, "local-only@example.com", null, nowIso, nowIso],
    );

    const { data, out } = await runAddressCommand(["addresses"]);
    const addresses = (data as Array<{ email: string }>) ?? [];
    expect(addresses.map((a) => a.email)).not.toContain("local-only@example.com");
    expect(out).toContain("No addresses configured.");
  });
});
