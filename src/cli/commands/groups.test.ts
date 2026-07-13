import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { addMember, createGroup } from "../../db/groups.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { registerGroupCommands } from "./groups.js";

const ENV_KEYS = [
  "HOME",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

async function runGroupCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerGroupCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runGroupCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await runGroupCommand(args);
    return { error: null, stderr: errors.join("\n") };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

async function startGroupApiServer(): Promise<{ origin: string; proc: Subprocess }> {
  const code = `
const group = { id: "group-api-1", name: "api-group", description: "from api", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
const ok = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/groups" && req.method === "GET") return ok({ items: [group] });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  },
});
console.log("PORT " + server.port);
`;
  const proc = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 10_000;
  while (!output.includes("\n") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  reader.releaseLock();
  const port = output.match(/PORT (\d+)/)?.[1];
  if (!port) {
    proc.kill();
    throw new Error(`self-hosted group API test server did not report a port: ${output}`);
  }
  return { origin: `http://127.0.0.1:${port}`, proc };
}

async function withTempSelfHostedHome<T>(apiOrigin: string, fn: (home: string) => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), "emails-group-self-hosted-"));
  const home = join(root, "home");
  closeDatabase();
  resetDatabase();
  process.env["HOME"] = home;
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["HASNA_EMAILS_DB_PATH"];
  delete process.env["HASNA_EMAILS_MODE"];
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = apiOrigin;
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";
  resetSelfHostedConfigCache();
  try {
    return await fn(home);
  } finally {
    closeDatabase();
    resetDatabase();
    resetSelfHostedConfigCache();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function localDbPath(home: string): string {
  return join(home, ".hasna", "emails", "emails.db");
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  for (const key of ENV_KEYS) {
    if (key !== "HOME" && key !== "EMAILS_DB_PATH") delete process.env[key];
  }
  resetSelfHostedConfigCache();
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  for (const key of ENV_KEYS) {
    if (key !== "HOME") delete process.env[key];
  }
  resetSelfHostedConfigCache();
});

describe("group list command", () => {
  it("paginates groups and returns batched member counts", async () => {
    createGroup("gamma");
    createGroup("alpha");
    const delta = createGroup("delta");
    const beta = createGroup("beta");
    addMember(beta.id, "a@example.com");
    addMember(beta.id, "b@example.com");
    addMember(delta.id, "c@example.com");

    const result = await runGroupCommand(["group", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ name: string; member_count: number }>;

    expect(data.map((group) => group.name)).toEqual(["beta", "delta"]);
    expect(data.map((group) => group.member_count)).toEqual([2, 1]);
    expect(result.out).toContain("beta");
    expect(result.out).not.toContain("gamma");
  });

  it("uses the self_hosted API for group list without opening local member counts", async () => {
    const { origin, proc } = await startGroupApiServer();
    try {
      await withTempSelfHostedHome(origin, async (home) => {
        const result = await runGroupCommand(["group", "list"]);
        const data = result.data as Array<{ name: string; member_count?: number }>;

        expect(data).toEqual([{
          id: "group-api-1",
          name: "api-group",
          description: "from api",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }]);
        expect(data[0]).not.toHaveProperty("member_count");
        expect(result.out).toContain("members: API-only");
        expect(existsSync(localDbPath(home))).toBe(false);
      });
    } finally {
      proc.kill();
    }
  });
});

describe("group members command", () => {
  it("paginates members by email", async () => {
    const group = createGroup("cli-members");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com", undefined, { hidden: "large vars ".repeat(100) });
    addMember(group.id, "bob@example.com", undefined, { hidden: "shown hidden vars ".repeat(100) });

    const result = await runGroupCommand(["group", "members", "cli-members", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ email: string }>;

    expect(data.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
    expect(data.every((member) => !("vars" in member))).toBe(true);
    expect(JSON.stringify(data)).not.toContain("shown hidden vars");
    expect(result.out).not.toContain("shown hidden vars");
    expect(result.out).toContain("Members for 'cli-members'");
    expect(result.out).not.toContain("alice@example.com");
  });

  it("shows a paged member view in group details", async () => {
    const group = createGroup("cli-show-members");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com", undefined, { hidden: "show hidden vars ".repeat(100) });

    const result = await runGroupCommand(["group", "show", "cli-show-members", "--limit", "2", "--offset", "1"]);
    const data = result.data as { member_count: number; members: Array<{ email: string }> };

    expect(data.member_count).toBe(4);
    expect(data.members.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
    expect(data.members.every((member) => !("vars" in member))).toBe(true);
    expect(JSON.stringify(data)).not.toContain("show hidden vars");
    expect(result.out).not.toContain("show hidden vars");
    expect(result.out).toContain("2 shown / 4 total");
  });

  it("fails closed in self_hosted mode before reading local group members", async () => {
    await withTempSelfHostedHome("https://emails.example.test", async (home) => {
      const result = await runGroupCommandExpectingExit(["group", "members", "api-group"]);

      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("self_hosted API-only mode");
      expect(result.stderr).toContain("local group member rows");
      expect(existsSync(localDbPath(home))).toBe(false);
    });
  });
});
