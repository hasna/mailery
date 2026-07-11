import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { registerProviderCommands } from "./provider.js";

async function runProviderCommand(args: string[]) {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = ((message?: unknown) => { logs.push(String(message ?? "")); }) as typeof console.log;
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerProviderCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { data, out: [...logs, ...out].join("\n") };
  } finally {
    console.log = originalLog;
  }
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("provider check command", () => {
  it("reports when no providers are configured", async () => {
    const result = await runProviderCommand(["provider", "check"]);

    expect(result.out).toContain("No providers configured.");
    expect(result.out).toContain("emails provider add --type ses");
  });
});

describe("provider list command", () => {
  it("paginates providers", async () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const provider = createProvider({ name: `provider-${i}`, type: "sandbox" });
      db.run("UPDATE providers SET created_at = ? WHERE id = ?", [`2026-01-0${i}T00:00:00.000Z`, provider.id]);
    }

    const result = await runProviderCommand(["provider", "list", "--limit", "2", "--offset", "1"]);

    expect(result.out).toContain("provider-3");
    expect(result.out).toContain("provider-2");
    expect(result.out).not.toContain("provider-4");
    expect(result.data).toMatchObject([
      { name: "provider-3" },
      { name: "provider-2" },
    ]);
  });

  it("returns credential-free provider rows", async () => {
    createProvider({
      name: "secret-provider",
      type: "resend",
      api_key: "provider-list-secret",
    });

    const result = await runProviderCommand(["provider", "list", "--limit", "1"]);
    const rows = result.data as Array<Record<string, unknown>>;

    expect(rows[0]?.name).toBe("secret-provider");
    expect(rows[0]).not.toHaveProperty("api_key");
    expect(rows[0]).not.toHaveProperty("secret_key");
    expect(rows[0]).not.toHaveProperty("oauth_refresh_token");
    expect(JSON.stringify(rows)).not.toContain("provider-list-secret");
  });
});
