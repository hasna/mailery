import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlias, ensureDefaultCatchAll } from "../../db/aliases.js";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { registerAliasCommands } from "./alias.js";

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

async function runAliasCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAliasCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runAliasCommandExpectingExit(args: string[]) {
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
    await runAliasCommand(args);
    return { error: null, stderr: errors.join("\n") };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

async function withTempSelfHostedHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), "emails-alias-self-hosted-"));
  const home = join(root, "home");
  closeDatabase();
  resetDatabase();
  process.env["HOME"] = home;
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["HASNA_EMAILS_DB_PATH"];
  delete process.env["HASNA_EMAILS_MODE"];
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
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

describe("alias list command", () => {
  it("paginates aliases for human and structured output", async () => {
    ensureDefaultCatchAll();
    createAlias("b@x.com", "t@x.com");
    createAlias("a@x.com", "t@x.com");
    createAlias("a@y.com", "t@y.com");

    const result = await runAliasCommand(["alias", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ local_part: string; domain: string }>;

    expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
    expect(result.out).toContain("a@x.com");
    expect(result.out).not.toContain("*@*");
  });

  it("paginates domain-filtered aliases", async () => {
    createAlias("c@x.com", "t@x.com");
    createAlias("a@x.com", "t@x.com");
    createAlias("b@x.com", "t@x.com");
    createAlias("a@y.com", "t@y.com");

    const result = await runAliasCommand(["alias", "list", "--domain", "x.com", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ local_part: string; domain: string }>;

    expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "b@x.com",
      "c@x.com",
    ]);
    expect(result.out).not.toContain("a@y.com");
  });

  it("fails closed in self_hosted mode before ensuring the default catch-all or opening local aliases", async () => {
    await withTempSelfHostedHome(async (home) => {
      const result = await runAliasCommandExpectingExit(["alias", "list"]);

      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("self_hosted API-only mode");
      expect(result.stderr).toContain("local alias routing state");
      expect(existsSync(localDbPath(home))).toBe(false);
    });
  });

  it("keeps explicit local mode alias list working", async () => {
    process.env["EMAILS_MODE"] = "local";
    ensureDefaultCatchAll();
    createAlias("local@example.com", "target@example.com");

    const result = await runAliasCommand(["alias", "list", "--domain", "example.com"]);
    const data = result.data as Array<{ local_part: string; domain: string }>;

    expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual(["local@example.com"]);
  });
});
