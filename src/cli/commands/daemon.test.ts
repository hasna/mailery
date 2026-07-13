import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { registerDaemonCommands } from "./daemon.js";

const SELF_HOSTED_ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_DB_PATH",
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
  "EMAILS_CLIENT_ENV_SECRET",
] as const;

let originalModeEnv: Partial<Record<typeof SELF_HOSTED_ENV_KEYS[number], string>> = {};

async function runDaemonCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDaemonCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runDaemonCommandExpectingExit(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  const errorSpy = mock((msg: unknown) => {
    errors.push(String(msg));
  });
  const exitSpy = mock((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  registerDaemonCommands(program, () => {});
  (console as unknown as { error: typeof errorSpy }).error = errorSpy;
  (process as unknown as { exit: typeof exitSpy }).exit = exitSpy;
  try {
    await expect(program.parseAsync(["node", "emails", ...args])).rejects.toThrow("exit:1");
  } finally {
    (console as unknown as { error: typeof originalError }).error = originalError;
    (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  }
  return errors.join("\n");
}

async function withTempSelfHostedHome<T>(prefix: string, fn: (tmpHome: string) => Promise<T>): Promise<T> {
  const originalHome = process.env["HOME"];
  const originalEnv: Partial<Record<typeof SELF_HOSTED_ENV_KEYS[number], string>> = {};
  for (const key of SELF_HOSTED_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  closeDatabase();
  resetDatabase();
  const tmpHome = mkdtempSync(join(tmpdir(), prefix));
  process.env["HOME"] = tmpHome;
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";
  try {
    return await fn(tmpHome);
  } finally {
    closeDatabase();
    resetDatabase();
    rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    for (const key of SELF_HOSTED_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  originalModeEnv = {};
  for (const key of SELF_HOSTED_ENV_KEYS) {
    originalModeEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["EMAILS_MODE"] = "local";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const key of SELF_HOSTED_ENV_KEYS) {
    const value = originalModeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("daemon commands", () => {
  it("reports queue status without requiring a process manager", async () => {
    const result = await runDaemonCommand(["daemon", "status"]);
    expect(result.out).toContain("Daemon status");
    expect(result.data).toMatchObject({ queue: { due_domains: 0, due_addresses: 0 } });
  });

  it("restart returns managed-process guidance", async () => {
    const result = await runDaemonCommand(["daemon", "restart"]);
    expect(result.out).toContain("No managed email daemon process");
    expect(result.data).toMatchObject({ managed_process: false });
  });

  it("fails status in self_hosted mode before opening local queue tables", async () => {
    await withTempSelfHostedHome("emails-daemon-status-self-hosted-", async (tmpHome) => {
      const errors = await runDaemonCommandExpectingExit(["daemon", "status"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("/health or /ready");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });

  it("fails log tail in self_hosted mode before reading local log files", async () => {
    await withTempSelfHostedHome("emails-daemon-logs-self-hosted-", async (tmpHome) => {
      const errors = await runDaemonCommandExpectingExit(["logs", "tail", "--component", "scheduler"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("local daemon/log diagnostics only");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });
});
