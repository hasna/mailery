import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { registerStatusCommands } from "./status.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";

const LEGACY_HOSTED_ENV_KEYS = [
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

async function runStatusCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  let data: unknown;
  let formatted = "";
  registerStatusCommands(program, (payload, text) => {
    data = payload;
    formatted = text;
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, formatted };
}

let previousHome: string | undefined;
let tempHome: string | undefined;
let previousLegacyEnv: Partial<Record<typeof LEGACY_HOSTED_ENV_KEYS[number], string>> = {};

function localDbPath(): string {
  if (!tempHome) throw new Error("tempHome not initialized");
  return join(tempHome, ".hasna", "emails", "emails.db");
}

function useSelfHostedStatusMode(): () => void {
  delete process.env["EMAILS_DB_PATH"];
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example/v1";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
  resetMailDataSource();
  resetSelfHostedConfigCache();

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const requestUrl = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    const body = requestUrl.pathname.endsWith("/messages/counts")
      ? {
          counts: {
            inbox: 2,
            unread: 1,
            starred: 0,
            sent: 1,
            archived: 1,
            spam: 0,
            trash: 0,
            total: 4,
            latest_received_at: "2026-07-08T19:50:52.000Z",
          },
        }
      : { messages: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = previousFetch;
    delete process.env["EMAILS_MODE"];
    delete process.env["EMAILS_SELF_HOSTED_URL"];
    delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
    resetMailDataSource();
    resetSelfHostedConfigCache();
  };
}

beforeEach(() => {
  previousHome = process.env["HOME"];
  previousLegacyEnv = {};
  for (const key of LEGACY_HOSTED_ENV_KEYS) {
    previousLegacyEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempHome = mkdtempSync(join(tmpdir(), "emails-status-test-home-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  resetMailDataSource();
  resetSelfHostedConfigCache();
  for (const key of LEGACY_HOSTED_ENV_KEYS) {
    const previous = previousLegacyEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  previousHome = undefined;
});

describe("local status CLI commands", () => {
  it("prints a compact agent context by default and full JSON in verbose mode", async () => {
    const compact = await runStatusCommand(["agent", "context"]);
    expect(compact.formatted).toContain("Agent context summary");
    expect(compact.formatted).toContain("Details: use emails agent context --verbose");
    expect(compact.formatted.trim().startsWith("{")).toBe(false);
    expect(compact.data).toMatchObject({ workflows: expect.any(Object) });

    const verbose = await runStatusCommand(["agent", "context", "--verbose"]);
    expect(verbose.formatted.trim().startsWith("{")).toBe(true);
    expect(verbose.formatted).toContain('"workflows"');
  });

  it("does not expose removed cloud AI agent subcommands", async () => {
    await expect(runStatusCommand(["agent", "defaults"])).rejects.toThrow(/unknown command/);
    await expect(runStatusCommand(["agent", "run", "categorizer"])).rejects.toThrow(/unknown command/);
  });

  it("does not create local SQLite for self-hosted status", async () => {
    const restore = useSelfHostedStatusMode();
    try {
      expect(existsSync(localDbPath())).toBe(false);
      const result = await runStatusCommand(["status"]);
      expect(existsSync(localDbPath())).toBe(false);
      expect(result.data).toMatchObject({
        mode: { current: "self_hosted" },
        database: { data_dir: null },
        inbox: {
          total: 3,
          unread: 1,
          latest_received_at: "2026-07-08T19:50:52.000Z",
        },
      });
      expect(result.formatted).toContain("Mode:       self_hosted");
    } finally {
      restore();
    }
  });

  it("does not create local SQLite for self-hosted agent context", async () => {
    const restore = useSelfHostedStatusMode();
    try {
      expect(existsSync(localDbPath())).toBe(false);
      const result = await runStatusCommand(["agent", "context"]);
      expect(existsSync(localDbPath())).toBe(false);
      expect(result.data).toMatchObject({
        status: {
          mode: { current: "self_hosted" },
          database: { data_dir: null },
          inbox: { total: 3, unread: 1 },
        },
      });
      expect(result.formatted).toContain("Agent context summary");
    } finally {
      restore();
    }
  });
});
