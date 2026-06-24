import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigValue } from "../../lib/config.js";
import { registerConfigCommands } from "./config.js";

let originalHome: string | undefined;
let tmpHome: string;

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

beforeEach(() => {
  originalHome = process.env["HOME"];
  tmpHome = mkdtempSync(join(tmpdir(), "emails-config-command-"));
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
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

  it("shows canonical archive and actual inbound config keys", async () => {
    const result = await runConfigCommand(["config", "keys"]);
    expect(result.out).toContain("gmail_archive_s3_bucket");
    expect(result.out).toContain("inbound_s3_bucket");
    expect(result.out).toContain("inbound_s3_prefix");
    expect(result.out).toContain("inbound_s3_region");
    expect(result.out).not.toContain("aws_s3_inbound_bucket");
    expect(result.out).toContain("Use --verbose for examples");

    const verbose = await runConfigCommand(["config", "keys", "--verbose"]);
    expect(verbose.out).toContain("hasna-xyz-opensource-emails-prod");
  });
});
