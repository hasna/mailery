import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { registerStatusCommands } from "./status.js";

async function runStatusCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  let data: unknown;
  let formatted = "";
  registerStatusCommands(program, (payload, text) => {
    data = payload;
    formatted = text;
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, formatted };
}

let previousHome: string | undefined;
let tempHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "emails-status-test-home-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  previousHome = undefined;
});

describe("local status CLI commands", () => {
  it("prints a compact agent context by default and full JSON in verbose mode", async () => {
    const compact = await runStatusCommand(["agent", "context"]);
    expect(compact.formatted).toContain("Agent context summary");
    expect(compact.formatted).toContain("Details: use emails agent context --verbose");
    expect(compact.formatted.trim().startsWith("{")).toBe(false);
    expect(compact.data).toMatchObject({ workflows: expect.any(Object) });

    const verbose = await runStatusCommand(["agent", "context", "--verbose"]);
    expect(verbose.formatted.trim().startsWith("{")).toBe(true);
    expect(verbose.formatted).toContain('"workflows"');
  });

  it("does not expose removed cloud AI agent subcommands", async () => {
    await expect(runStatusCommand(["agent", "defaults"])).rejects.toThrow(/unknown command/);
    await expect(runStatusCommand(["agent", "run", "categorizer"])).rejects.toThrow(/unknown command/);
  });
});
