import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { setConfigValue } from "../../lib/config.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";
import { registerSyncCommands } from "./sync.js";

const MODE_ENV_KEYS = [
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

let originalModeEnv: Partial<Record<typeof MODE_ENV_KEYS[number], string>> = {};

function enableSelfHostedMode() {
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";
  resetSelfHostedConfigCache();
  resetMailDataSource();
}

async function runSyncCommandExpectingExit(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  program.command("provider").description("provider namespace");
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  const errorSpy = mock((msg: unknown) => {
    errors.push(String(msg));
  });
  const exitSpy = mock((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  registerSyncCommands(program, () => {});
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

async function withTempHome<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env["HOME"];
  const tmpHome = mkdtempSync(join(tmpdir(), prefix));
  process.env["HOME"] = tmpHome;
  try {
    return await fn();
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

beforeEach(() => {
  originalModeEnv = {};
  for (const key of MODE_ENV_KEYS) {
    originalModeEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MODE_ENV_KEYS) {
    const value = originalModeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSelfHostedConfigCache();
  resetMailDataSource();
});

describe("sync CLI commands in self_hosted mode", () => {
  for (const args of [
    ["provider", "sync"],
    ["pull"],
    ["stats"],
    ["stats", "--inbox"],
    ["monitor"],
    ["analytics"],
  ]) {
    it(`fails closed for emails ${args.join(" ")}`, async () => {
      enableSelfHostedMode();

      const error = await runSyncCommandExpectingExit(args);

      expect(error).toContain("self_hosted API-only mode");
      expect(error).toContain("local provider/log storage only");
    });
  }

  for (const args of [["stats"], ["monitor"]]) {
    it(`fails closed on legacy mode config before local ${args.join(" ")}`, async () => {
      await withTempHome("emails-sync-legacy-mode-", async () => {
        setConfigValue("mode", "remote");

        const error = await runSyncCommandExpectingExit(args);

        expect(error).toContain("config key 'mode' value 'remote'");
        expect(error).toContain("removed hosted/legacy runtime");
      });
    });
  }
});
