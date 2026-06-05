import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { listDomains } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { registerDomainCommands } from "./domain.js";

async function runDomainCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDomainCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("domain add command", () => {
  it("supports dry-run without mutating domain state", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });

    const result = await runDomainCommand(["domain", "add", "example.com", "--provider", provider.id, "--dry-run"]);

    expect(result.data).toMatchObject({
      dry_run: true,
      domain: "example.com",
      provider_id: provider.id,
      would_create_domain: true,
      would_call_provider: true,
    });
    expect(listDomains(undefined, getDatabase())).toHaveLength(0);
  });
});
