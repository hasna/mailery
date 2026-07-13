import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigValue } from "../../lib/config.js";
import { registerConfigCommands } from "./config.js";

let originalHome: string | undefined;
let tmpHome: string;
const MODE_ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "EMAILS_CLIENT_ENV_SECRET",
] as const;
let originalModeEnv: Partial<Record<typeof MODE_ENV_KEYS[number], string | undefined>> = {};

async function runConfigCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  const logs: string[] = [];
  let data: unknown;
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  try {
    registerConfigCommands(program, (d, formatted) => {
      data = d;
      if (formatted) logs.push(String(formatted));
    });
    await program.parseAsync(["node", "emails", ...args]);
    return { data, out: logs.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

async function runConfigCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runConfigCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

function configPath(): string {
  return join(tmpHome, ".hasna", "emails", "config.json");
}

function writeLooseConfig(): void {
  const dir = join(tmpHome, ".hasna", "emails");
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ local_value: "stored-local-value" }, null, 2), { mode: 0o644 });
  chmodSync(configPath(), 0o644);
}

beforeEach(() => {
  originalHome = process.env["HOME"];
  originalModeEnv = {};
  for (const key of MODE_ENV_KEYS) {
    originalModeEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpHome = mkdtempSync(join(tmpdir(), "emails-config-command-"));
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  for (const key of MODE_ENV_KEYS) {
    const value = originalModeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("config command redaction", () => {
  it("redacts sensitive values in set, get, and list output", async () => {
    const setResult = await runConfigCommand(["config", "set", "cloudflare_api_token", "CLI_CONFIG_SECRET"]);
    expect(setResult.out).toContain("***");
    expect(setResult.out).not.toContain("CLI_CONFIG_SECRET");
    expect(getConfigValue("cloudflare_api_token")).toBe("CLI_CONFIG_SECRET");

    const getResult = await runConfigCommand(["config", "get", "cloudflare_api_token"]);
    expect(getResult.out).toContain("***");
    expect(getResult.out).not.toContain("CLI_CONFIG_SECRET");

    const listResult = await runConfigCommand(["config", "list"]);
    expect(listResult.out).toContain("***");
    expect(listResult.out).not.toContain("CLI_CONFIG_SECRET");
    expect(listResult.data).toEqual({ cloudflare_api_token: "***" });
  });

  it("shows attachment storage and actual inbound config keys", async () => {
    const result = await runConfigCommand(["config", "keys"]);
    expect(result.out).toContain("emails_mode");
    expect(result.out).toContain("local only");
    expect(result.out).toContain("attachment_storage");
    expect(result.out).toContain("attachment_s3_bucket");
    expect(result.out).toContain("inbound_s3_bucket");
    expect(result.out).toContain("inbound_s3_prefix");
    expect(result.out).toContain("inbound_s3_region");
    expect(result.out).not.toContain("aws_s3_inbound_bucket");
    expect(result.out).toContain("Use --verbose for examples");

    const verbose = await runConfigCommand(["config", "keys", "--verbose"]);
    expect(verbose.out).toContain("my-email-archive");
    expect(verbose.out).not.toContain("my-legacy-mail-archive");
    expect(verbose.out).toContain("env/client-env");
  });

  it("fails get, set, unset, and list in self_hosted mode before reading local config", async () => {
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.invalid";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";

    for (const args of [
      ["config", "get", "local_value"],
      ["config", "set", "local_value", "new-value"],
      ["config", "unset", "local_value"],
      ["config", "list"],
    ]) {
      writeLooseConfig();
      const result = await runConfigCommandExpectingExit(args);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("disabled in self_hosted API-only mode");
      expect(result.stderr).toContain("EMAILS_CLIENT_ENV_SECRET");
      expect(result.stderr).toContain("EMAILS_MODE=local");
      expect(statSync(configPath()).mode & 0o777).toBe(0o644);
    }
  });

  it("rejects config-selected self_hosted before writing local config", async () => {
    const result = await runConfigCommandExpectingExit(["config", "set", "emails_mode", "self_hosted"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("cannot select self_hosted from local config");
    expect(result.stderr).toContain("EMAILS_CLIENT_ENV_SECRET");
    expect(existsSync(configPath())).toBe(false);
  });

  it("allows explicit local mode to manage local config", async () => {
    process.env["EMAILS_MODE"] = "local";

    const setResult = await runConfigCommand(["config", "set", "emails_mode", "local"]);
    expect(setResult.out).toContain("emails_mode");
    expect(getConfigValue("emails_mode")).toBe("local");

    const getResult = await runConfigCommand(["config", "get", "emails_mode"]);
    expect(getResult.out).toContain('"local"');

    const listResult = await runConfigCommand(["config", "list"]);
    expect(listResult.out).toContain("emails_mode");

    const unsetResult = await runConfigCommand(["config", "unset", "emails_mode"]);
    expect(unsetResult.out).toContain("emails_mode removed");
    expect(getConfigValue("emails_mode")).toBeUndefined();
  });
});
