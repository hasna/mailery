import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createTemplate } from "../../db/templates.js";
import { registerTemplateCommands } from "./templates.js";

const SELF_HOSTED_ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_DB_PATH",
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
  "EMAILS_CLIENT_ENV_SECRET",
] as const;

let originalModeEnv: Partial<Record<typeof SELF_HOSTED_ENV_KEYS[number], string>> = {};

async function runTemplateCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  const originalLog = console.log;
  registerTemplateCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  console.log = ((...values: unknown[]) => {
    out.push(values.map(String).join(" "));
  }) as typeof console.log;
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { data, out: out.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

async function runTemplateCommandExpectingExit(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  const errorSpy = mock((msg: unknown) => {
    errors.push(String(msg));
  });
  const exitSpy = mock((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  registerTemplateCommands(program, () => {});
  (console as unknown as { error: typeof errorSpy }).error = errorSpy;
  (process as unknown as { exit: typeof exitSpy }).exit = exitSpy;
  try {
    await expect(program.parseAsync(["node", "emails", ...args])).rejects.toThrow("exit:1");
  } finally {
    (console as unknown as { error: typeof originalError }).error = originalError;
    (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  }
  return errors.join("\n");
}

async function withTempSelfHostedHome<T>(prefix: string, fn: (tmpHome: string) => Promise<T>): Promise<T> {
  const originalHome = process.env["HOME"];
  const originalEnv: Partial<Record<typeof SELF_HOSTED_ENV_KEYS[number], string>> = {};
  for (const key of SELF_HOSTED_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  closeDatabase();
  resetDatabase();
  const tmpHome = mkdtempSync(join(tmpdir(), prefix));
  process.env["HOME"] = tmpHome;
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";
  try {
    return await fn(tmpHome);
  } finally {
    closeDatabase();
    resetDatabase();
    rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    for (const key of SELF_HOSTED_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  originalModeEnv = {};
  for (const key of SELF_HOSTED_ENV_KEYS) {
    originalModeEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["EMAILS_MODE"] = "local";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const key of SELF_HOSTED_ENV_KEYS) {
    const value = originalModeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

  it("fails closed in self_hosted mode before listing local templates", async () => {
    await withTempSelfHostedHome("emails-template-list-self-hosted-", async (tmpHome) => {
      const errors = await runTemplateCommandExpectingExit(["template", "list"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("local template storage only");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });
});

describe("preview command", () => {
  it("allows explicit local mode to render a terminal-only template preview", async () => {
    process.env["EMAILS_MODE"] = "local";
    createTemplate({
      name: "local-preview",
      subject_template: "Hello {{name}}",
      html_template: "<p>Hello {{name}}</p>",
    });

    const result = await runTemplateCommand(["preview", "local-preview", "--vars", "{\"name\":\"Ada\"}"]);

    expect(result.out).toContain("Subject:");
    expect(result.out).toContain("Hello Ada");
    expect(result.out).toContain("<p>Hello Ada</p>");
  });

  it("fails closed in self_hosted mode before reading templates or writing preview HTML", async () => {
    await withTempSelfHostedHome("emails-preview-self-hosted-", async (tmpHome) => {
      const errors = await runTemplateCommandExpectingExit(["preview", "welcome", "--open"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("local template storage only");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });

  it("also fails terminal preview in self_hosted because the current template source is local SQLite", async () => {
    await withTempSelfHostedHome("emails-preview-terminal-self-hosted-", async (tmpHome) => {
      const errors = await runTemplateCommandExpectingExit(["preview", "welcome"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("local SQLite templates");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });
});
