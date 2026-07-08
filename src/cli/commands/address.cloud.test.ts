// Covers the client-flip (self_hosted) branch of the address CLI: with
// HASNA_MAILERY_API_URL + HASNA_MAILERY_API_KEY set and mode=self_hosted,
// `mailery addresses` must READ from the cloud HTTP API (<app>.hasna.xyz/v1/addresses)
// rather than the local SQLite store. This mirrors the domains resource, which
// already routes to the cloud, and locks in the fix for the mission-alignment gap
// where `addresses` used to show empty LOCAL state in cloud mode.
//
// The cloud-store performs its HTTP call with a SYNCHRONOUS `curl` (spawnSync),
// which blocks Bun's event loop — so the stand-in for <app>.hasna.xyz/v1 runs in a
// SEPARATE process (an in-process server would deadlock). No module mocks are used,
// so the real transport path is exercised.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAddressCommands } from "./address.js";
import { resetCloudConfigCache } from "../../db/cloud-store.js";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";

const API_KEY = "hasna_mailery_test_key_addresses_1234";
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
  serverDir = mkdtempSync(join(tmpdir(), "mailery-addr-cloud-test-"));
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
  if (!baseOrigin) throw new Error("mock cloud server did not report a port");
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
  await program.parseAsync(["node", "mailery", ...args]);
  return { data, out: out.join("\n") };
}

describe("address CLI — cloud (self_hosted) routing", () => {
  beforeEach(async () => {
    await fetch(`${baseOrigin}/v1/__reset`, { method: "POST" });
    process.env["EMAILS_DB_PATH"] = ":memory:";
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_MAILERY_API_URL"] = baseOrigin;
    process.env["HASNA_MAILERY_API_KEY"] = API_KEY;
    resetCloudConfigCache();
  });
  afterEach(() => {
    delete process.env["MAILERY_MODE"];
    delete process.env["HASNA_MAILERY_API_URL"];
    delete process.env["HASNA_MAILERY_API_KEY"];
    resetCloudConfigCache();
    closeDatabase();
  });

  it("`addresses` reads from the cloud API, not local SQLite", async () => {
    await seedCloudAddress("cloud-a@example.com");
    await seedCloudAddress("cloud-b@example.com");

    const { data } = await runAddressCommand(["addresses"]);
    const addresses = data as Array<{ email: string }>;
    expect(addresses.map((a) => a.email).sort()).toEqual(["cloud-a@example.com", "cloud-b@example.com"]);
  });

  it("does NOT return local addresses when flipped to cloud", async () => {
    // Seed the local SQLite island DIRECTLY (raw insert) — the repo helpers
    // (createAddress) correctly route to the cloud in cloud mode, so they cannot
    // be used to plant a local-only row. In cloud mode the CLI must ignore this
    // local row and show only what the cloud API returns (here: nothing, because
    // __reset cleared the mock).
    resetDatabase();
    const local = getDatabase();
    const provider = createProvider({ name: "sandbox", type: "sandbox" }, local);
    const nowIso = new Date().toISOString();
    local.run(
      `INSERT INTO addresses (id, provider_id, email, display_name, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [crypto.randomUUID(), provider.id, "local-only@example.com", null, nowIso, nowIso],
    );

    const { data, out } = await runAddressCommand(["addresses"]);
    const addresses = (data as Array<{ email: string }>) ?? [];
    expect(addresses.map((a) => a.email)).not.toContain("local-only@example.com");
    expect(out).toContain("No addresses configured.");
  });
});
