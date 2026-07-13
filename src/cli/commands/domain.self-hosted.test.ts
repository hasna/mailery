// Covers the client-flip (self_hosted) branch of the domain CLI end to end
// against the REAL self-hosted-store (curl over HTTP): with EMAILS_SELF_HOSTED_URL +
// EMAILS_SELF_HOSTED_API_KEY set and mode=self_hosted, `domain add`, `domain list`,
// and `domain remove` must route reads AND writes to the selfHosted HTTP API — never
// to a local provider row/adapter (the selfHosted API exposes no /v1/providers).
//
// The self-hosted-store performs its HTTP call with a SYNCHRONOUS `curl` (spawnSync),
// which blocks Bun's event loop — so the stand-in for <app>.hasna.xyz/v1 runs in
// a SEPARATE process (an in-process server would deadlock). No module mocks are
// used, so the real transport path is exercised and nothing leaks across files.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDomainCommands } from "./domain.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { closeDatabase, resetDatabase } from "../../db/database.js";

const API_KEY = "hasna_emails_test_key_1234567890";
let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let serverDir = "";
let baseOrigin = "";

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
    if (parts[0] !== "v1" || parts[1] !== "domains") return json({ error: "not found" }, 404);
    const id = parts[2];
    if (req.method === "GET" && !id) return json({ domains: [...rows.values()] });
    if (req.method === "POST" && !id) {
      const body = await req.json();
      const now = new Date().toISOString();
      const entity = { id: crypto.randomUUID(), domain: body.domain, provider: body.provider ?? null, verified: false, created_at: now, updated_at: now };
      rows.set(entity.id, entity);
      return json({ domain: entity }, 201);
    }
    if (id && req.method === "GET") { const e = rows.get(id); return e ? json({ domain: e }) : json({ error: "not found" }, 404); }
    if (id && (req.method === "PATCH" || req.method === "PUT")) {
      const e = rows.get(id); if (!e) return json({ error: "not found" }, 404);
      const patch = await req.json(); const u = { ...e, ...patch, updated_at: new Date().toISOString() }; rows.set(id, u); return json({ domain: u });
    }
    if (id && req.method === "DELETE") return rows.delete(id) ? json({ ok: true }) : json({ error: "not found" }, 404);
    return json({ error: "method not allowed" }, 405);
  },
});
console.log("PORT=" + server.port);
`;

async function serverDomains(): Promise<Array<{ domain: string }>> {
  const res = await fetch(`${baseOrigin}/v1/domains`, { headers: { authorization: `Bearer ${API_KEY}` } });
  const body = (await res.json()) as { domains: Array<{ domain: string }> };
  return body.domains;
}

beforeAll(async () => {
  serverDir = mkdtempSync(join(tmpdir(), "emails-selfHosted-test-"));
  const scriptPath = join(serverDir, "server.mjs");
  writeFileSync(scriptPath, SERVER_SRC);
  serverProc = Bun.spawn(["bun", scriptPath], {
    env: { ...process.env, TEST_API_KEY: API_KEY },
    stdout: "pipe",
    stderr: "inherit",
  });
  // Read the announced port from stdout.
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

async function runDomainCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDomainCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runDomainCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runDomainCommand(args);
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

describe("domain CLI — selfHosted (self_hosted) routing", () => {
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

  it("add writes to the selfHosted API (not a local provider)", async () => {
    const { data } = await runDomainCommand(["domain", "add", "cloudy.example.com", "--provider", "selfHosted"]);
    const entity = data as { id: string; domain: string };
    expect(entity.domain).toBe("cloudy.example.com");
    const remote = await serverDomains();
    expect(remote.map((d) => d.domain)).toEqual(["cloudy.example.com"]);
  });

  it("list reads from the selfHosted API", async () => {
    await runDomainCommand(["domain", "add", "one.example.com", "--provider", "selfHosted"]);
    await runDomainCommand(["domain", "add", "two.example.com", "--provider", "selfHosted"]);
    const { data } = await runDomainCommand(["domain", "list"]);
    const domains = data as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain).sort()).toEqual(["one.example.com", "two.example.com"]);
  });

  it("domains list (plural) reads from the selfHosted API instead of blocking", async () => {
    await runDomainCommand(["domain", "add", "alpha.example.com", "--provider", "selfHosted"]);
    await runDomainCommand(["domain", "add", "beta.example.com", "--provider", "selfHosted"]);
    const { data } = await runDomainCommand(["domains", "list"]);
    const domains = data as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain).sort()).toEqual(["alpha.example.com", "beta.example.com"]);
  });

  it("domains status (no arg) lists via the selfHosted API instead of blocking", async () => {
    await runDomainCommand(["domain", "add", "gamma.example.com", "--provider", "selfHosted"]);
    const { data } = await runDomainCommand(["domains", "status"]);
    const domains = data as Array<{ domain: string }>;
    expect(domains.map((d) => d.domain)).toEqual(["gamma.example.com"]);
  });

  it("domains status <domain> shows the API record in self_hosted", async () => {
    await runDomainCommand(["domain", "add", "delta.example.com", "--provider", "selfHosted"]);
    const { data } = await runDomainCommand(["domains", "status", "delta.example.com"]);
    const rec = data as { domain: string };
    expect(rec.domain).toBe("delta.example.com");
  });

  it("API-backed add/list do not create a default local DB under HOME", async () => {
    await withTempHome("emails-domain-self-hosted-api-", async (tmpHome) => {
      await fetch(`${baseOrigin}/v1/__reset`, { method: "POST" });
      closeDatabase();
      resetDatabase();
      delete process.env["EMAILS_DB_PATH"];
      delete process.env["HASNA_EMAILS_DB_PATH"];
      process.env["EMAILS_MODE"] = "self_hosted";
      process.env["EMAILS_SELF_HOSTED_URL"] = baseOrigin;
      process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
      resetSelfHostedConfigCache();

      await runDomainCommand(["domain", "add", "nodatabase.example.com", "--provider", "selfHosted"]);
      const { data } = await runDomainCommand(["domain", "list"]);

      expect((data as Array<{ domain: string }>).map((d) => d.domain)).toEqual(["nodatabase.example.com"]);
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });

  it("blocks local domain lifecycle commands before creating a default local DB", async () => {
    await withTempHome("emails-domain-self-hosted-local-only-", async (tmpHome) => {
      closeDatabase();
      resetDatabase();
      delete process.env["EMAILS_DB_PATH"];
      delete process.env["HASNA_EMAILS_DB_PATH"];
      process.env["EMAILS_MODE"] = "self_hosted";
      process.env["EMAILS_SELF_HOSTED_URL"] = baseOrigin;
      process.env["EMAILS_SELF_HOSTED_API_KEY"] = API_KEY;
      resetSelfHostedConfigCache();

      // Lifecycle/mutation + the singular readiness table still require local
      // state and must block. (The plural `domains list`/`domains status` reads
      // now degrade to the /v1 API instead of blocking — covered above.)
      for (const args of [
        ["domain", "adopt", "example.com", "--provider", "ses-provider"],
        ["domain", "status"],
        ["domain", "usable"],
      ]) {
        const result = await runDomainCommandExpectingExit(args);
        expect(result.error).toBe("process.exit:1");
        expect(result.stderr).toContain("self_hosted API-only mode");
        expect(result.stderr).toContain("self-hosted server/operator API/workers");
        expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
      }
    });
  });

  it("add is idempotent by name against the selfHosted API", async () => {
    await runDomainCommand(["domain", "add", "dup.example.com", "--provider", "selfHosted"]);
    await runDomainCommand(["domain", "add", "dup.example.com", "--provider", "selfHosted"]);
    expect((await serverDomains()).length).toBe(1);
  });

  it("remove deletes from the selfHosted API", async () => {
    await runDomainCommand(["domain", "add", "gone.example.com", "--provider", "selfHosted"]);
    const remote = await serverDomains();
    expect(remote.length).toBe(1);
    const id = (remote[0] as { id: string }).id;
    await runDomainCommand(["domain", "remove", id, "--yes"]);
    expect((await serverDomains()).length).toBe(0);
  });

  it("resolves an id PREFIX against the selfHosted dataset for remove", async () => {
    await runDomainCommand(["domain", "add", "prefix.example.com", "--provider", "selfHosted"]);
    const remote = await serverDomains();
    const id = (remote[0] as { id: string }).id;
    // An 8-char prefix must be resolved by listing the self-hosted store (not local
    // SQLite, which is :memory: and empty here) — proving reads route to selfHosted.
    await runDomainCommand(["domain", "remove", id.slice(0, 8), "--yes"]);
    expect((await serverDomains()).length).toBe(0);
  });
});
