import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createAlias, ensureDefaultCatchAll } from "../../db/aliases.js";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { registerAliasCommands } from "./alias.js";

async function runAliasCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAliasCommands(program, (d, formatted) => {
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

describe("alias list command", () => {
  it("paginates aliases for human and structured output", async () => {
    ensureDefaultCatchAll();
    createAlias("b@x.com", "t@x.com");
    createAlias("a@x.com", "t@x.com");
    createAlias("a@y.com", "t@y.com");

    const result = await runAliasCommand(["alias", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ local_part: string; domain: string }>;

    expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
    expect(result.out).toContain("a@x.com");
    expect(result.out).not.toContain("*@*");
  });

  it("paginates domain-filtered aliases", async () => {
    createAlias("c@x.com", "t@x.com");
    createAlias("a@x.com", "t@x.com");
    createAlias("b@x.com", "t@x.com");
    createAlias("a@y.com", "t@y.com");

    const result = await runAliasCommand(["alias", "list", "--domain", "x.com", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ local_part: string; domain: string }>;

    expect(data.map((alias) => `${alias.local_part}@${alias.domain}`)).toEqual([
      "b@x.com",
      "c@x.com",
    ]);
    expect(result.out).not.toContain("a@y.com");
  });
});
