import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createTemplate } from "../../db/templates.js";
import { registerTemplateCommands } from "./templates.js";

async function runTemplateCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerTemplateCommands(program, (d, formatted) => {
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

describe("template list command", () => {
  it("paginates templates for human and structured output", async () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      const template = createTemplate({ name: `cli-template-${i}`, subject_template: `Template ${i}` });
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE templates SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, template.id]);
    }

    const result = await runTemplateCommand(["template", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ name: string }>;

    expect(data.map((template) => template.name)).toEqual(["cli-template-3", "cli-template-2"]);
    expect(result.out).toContain("cli-template-3");
    expect(result.out).not.toContain("cli-template-4");
  });

  it("returns lean structured rows without template bodies", async () => {
    createTemplate({
      name: "body-heavy",
      subject_template: "Body heavy",
      html_template: `<main>${"CLI hidden html ".repeat(100)}</main>`,
      text_template: "CLI hidden text ".repeat(100),
    });

    const result = await runTemplateCommand(["template", "list", "--limit", "1"]);
    const data = result.data as Array<Record<string, unknown>>;

    expect(data[0]?.name).toBe("body-heavy");
    expect(data[0]?.has_html_template).toBe(true);
    expect(data[0]?.has_text_template).toBe(true);
    expect(data[0]).not.toHaveProperty("html_template");
    expect(data[0]).not.toHaveProperty("text_template");
    expect(JSON.stringify(data)).not.toContain("CLI hidden");
  });
});
