import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { listForwardingRules } from "../../db/forwarding.js";
import { registerForwardingCommands } from "./forwarding.js";

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
  "HASNA_EMAILS_DB_PATH",
] as const;

let originalEnv: Partial<Record<typeof MODE_ENV_KEYS[number], string | undefined>> = {};

async function runForwardingCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerForwardingCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeEach(() => {
  originalEnv = {};
  for (const key of MODE_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  for (const key of MODE_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv = {};
});

describe("forwarding command", () => {
  it("creates and lists app-level forwarding rules", async () => {
    const add = await runForwardingCommand(["forwarding", "add", "user@example.com", "archive@example.net"]);
    const list = await runForwardingCommand(["forwarding", "list"]);

    expect(add.data).toMatchObject({
      source_address: "user@example.com",
      target_address: "archive@example.net",
      mode: "app-copy",
      enabled: true,
    });
    expect(list.out).toContain("user@example.com -> archive@example.net");
    expect(listForwardingRules()).toHaveLength(1);
  });
});
