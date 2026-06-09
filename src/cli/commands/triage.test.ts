import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createEmail } from "../../db/emails.js";
import { createProvider } from "../../db/providers.js";
import { saveTriage } from "../../db/triage.js";
import { registerTriageCommands } from "./triage.js";

async function runTriageCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  let formatted = "";
  registerTriageCommands(program, (payload, text) => {
    data = payload;
    formatted = text;
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, formatted };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("triage list command", () => {
  it("paginates triage results with offset", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "triage-provider", type: "sandbox" }, db);
    for (let i = 0; i < 4; i++) {
      const email = createEmail(provider.id, {
        from: "ops@example.com",
        to: `triage-${i}@example.com`,
        subject: `Triage ${i}`,
        text: "body",
      }, undefined, db);
      const triage = saveTriage({
        email_id: email.id,
        label: "fyi",
        priority: 3,
        summary: `summary ${i}`,
        draft_reply: `large draft ${i} `.repeat(500),
      }, db);
      db.run("UPDATE email_triage SET triaged_at = ?, created_at = ? WHERE id = ?", [
        `2026-01-01T00:0${i}:00.000Z`,
        `2026-01-01T00:0${i}:00.000Z`,
        triage.id,
      ]);
    }

    const { data, formatted } = await runTriageCommand(["triage", "list", "--limit", "2", "--offset", "1"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.summary)).toEqual(["summary 2", "summary 1"]);
    expect(rows[0]).not.toHaveProperty("draft_reply");
    expect(JSON.stringify(rows)).not.toContain("large draft");
    expect(formatted).toContain("Triaged emails (2)");
  });
});
