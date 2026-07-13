import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { storeSandboxEmail } from "../../db/sandbox.js";
import { registerSandboxCommands } from "./sandbox.js";

const LEGACY_MODE_ENV_KEYS = [
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
] as const;

function clearModeEnv(): void {
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  for (const key of LEGACY_MODE_ENV_KEYS) delete process.env[key];
}

async function runSandboxCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const formatted: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  registerSandboxCommands(program, (payload, text) => {
    data = payload;
    if (text) formatted.push(String(text));
  });
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } finally {
    console.log = originalLog;
  }
  return { data, formatted: formatted.join("\n"), consoleOutput: logs.join("\n") };
}

async function runSandboxCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runSandboxCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

function seedSandboxEmail() {
  const provider = createProvider({ name: "sandbox", type: "sandbox" });
  const email = storeSandboxEmail({
    provider_id: provider.id,
    from_address: "sender@example.com",
    to_addresses: ["ops@example.com"],
    cc_addresses: [],
    bcc_addresses: [],
    reply_to: null,
    subject: "Sandbox HTML",
    html: '<p>Hello <strong>there</strong> &amp; welcome</p><p><a href="https://example.com/docs">docs</a></p>',
    text_body: null,
    attachments: [],
    headers: {},
  });
  return { provider, email };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  clearModeEnv();
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  clearModeEnv();
});

describe("sandbox CLI commands", () => {
  it("lists and counts sandbox emails without body payloads", async () => {
    seedSandboxEmail();

    const list = await runSandboxCommand(["sandbox", "list", "--limit", "1"]);
    const rows = list.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe("Sandbox HTML");
    expect(rows[0]).not.toHaveProperty("html");
    expect(rows[0]).not.toHaveProperty("text_body");

    const count = await runSandboxCommand(["sandbox", "count"]);
    expect(count.data).toEqual({ count: 1 });
  });

  it("renders sandbox HTML through the shared readable formatter", async () => {
    const { email } = seedSandboxEmail();

    const shown = await runSandboxCommand(["sandbox", "show", email.id]);

    expect(shown.consoleOutput).toContain("Hello there & welcome");
    expect(shown.consoleOutput).toContain("docs (https://example.com/docs)");
    expect(shown.consoleOutput).not.toContain("<strong>");
    expect(shown.consoleOutput).not.toContain("&amp;");
  });

  it("fails closed in self_hosted mode before rendering a local body file", async () => {
    process.env["EMAILS_MODE"] = "self_hosted";

    const result = await runSandboxCommandExpectingExit(["sandbox", "open", "abc123"]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("unavailable in self_hosted mode");
  });

  for (const args of [
    ["sandbox", "list"],
    ["sandbox", "show", "abc123"],
    ["sandbox", "clear"],
    ["sandbox", "count"],
  ]) {
    it(`fails closed for emails ${args.join(" ")}`, async () => {
      process.env["EMAILS_MODE"] = "self_hosted";

      const result = await runSandboxCommandExpectingExit(args);

      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("self_hosted API-only mode");
      expect(result.stderr).toContain("emails inbox");
      expect(result.stderr).toContain("EMAILS_MODE=local");
    });
  }
});
