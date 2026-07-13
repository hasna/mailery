import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createOwner } from "../../db/owners.js";
import { createSendKey } from "../../db/send-keys.js";
import { registerSendKeyCommands } from "./sendkey.js";

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

async function runSendKeyCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerSendKeyCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runSendKeyCommandExpectingExit(args: string[]): Promise<string> {
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
  registerSendKeyCommands(program, () => {});
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

describe("sendkey list command", () => {
  it("paginates send keys and displays owner names without per-row lookup output drift", async () => {
    const db = getDatabase();
    const owner = createOwner({ type: "agent", name: "sendkey-agent" });
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const key = createSendKey(owner.id, `key-${i}`).key;
      hashes.push(key.key_hash);
      db.run("UPDATE send_keys SET created_at = ? WHERE id = ?", [`2026-01-0${i + 1}T00:00:00.000Z`, key.id]);
    }

    const result = await runSendKeyCommand(["sendkey", "list", "--owner", "sendkey-agent", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<Record<string, unknown> & { label: string | null; owner_id: string }>;

    expect(data.map((key) => key.label)).toEqual(["key-3", "key-2"]);
    expect(data.every((key) => key.owner_id === owner.id)).toBe(true);
    expect(data.every((key) => !("key_hash" in key))).toBe(true);
    expect(hashes.some((hash) => JSON.stringify(data).includes(hash))).toBe(false);
    expect(result.out).toContain("sendkey-agent");
    expect(result.out).not.toContain("key-4");
  });
});

describe("sendkey self_hosted guards", () => {
  it("fails revoke before reading local send-key hashes", async () => {
    await withTempSelfHostedHome("emails-sendkey-revoke-self-hosted-", async (tmpHome) => {
      const errors = await runSendKeyCommandExpectingExit(["sendkey", "revoke", "abc123"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("local send-key storage only");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });

  it("fails check before reading local owner/address rows", async () => {
    await withTempSelfHostedHome("emails-sendkey-check-self-hosted-", async (tmpHome) => {
      const errors = await runSendKeyCommandExpectingExit(["sendkey", "check", "agent-a", "from@example.com"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("local send-key storage only");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });
});
