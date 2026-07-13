import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createScheduledEmail, getScheduledEmail } from "../../db/scheduled.js";
import { listSandboxEmails } from "../../db/sandbox.js";
import { createTemplate } from "../../db/templates.js";
import { addStep, createSequence, enroll, listEnrollments } from "../../db/sequences.js";
import { registerMiscCommands, runSchedulerTick } from "./misc.js";

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

async function runMiscCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  const consoleLines: string[] = [];
  const originalLog = console.log;
  registerMiscCommands(program, (_data, formatted) => {
    if (formatted) consoleLines.push(String(formatted));
  });
  console.log = (...values: unknown[]) => {
    consoleLines.push(values.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } finally {
    console.log = originalLog;
  }
  return consoleLines.join("\n");
}

async function runMiscCommandExpectingExit(args: string[]): Promise<string> {
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
  registerMiscCommands(program, () => {});
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

describe("schedule list commands", () => {
  it("renders scheduled-email summaries without exposing payload bodies", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "list-sandbox", type: "sandbox" }, db);
    createScheduledEmail({
      provider_id: provider.id,
      from_address: "sender@example.com",
      to_addresses: ["scheduled@example.com"],
      subject: "Scheduled summary",
      html: `<p>${"hidden html ".repeat(100)}</p>`,
      text_body: "hidden text ".repeat(100),
      attachments_json: [{ filename: "secret.txt", content: "hidden attachment".repeat(50) }],
      template_vars: { hidden: "hidden template vars".repeat(50) },
      scheduled_at: "2030-01-01T00:00:00.000Z",
    }, db);

    const output = await runMiscCommand(["schedule", "list", "--limit", "1"]);

    expect(output).toContain("Scheduled summary");
    expect(output).toContain("scheduled@example.com");
    expect(output).not.toContain("hidden html");
    expect(output).not.toContain("hidden text");
    expect(output).not.toContain("hidden attachment");
    expect(output).not.toContain("hidden template vars");
  });

  it("allows explicit local mode to use the local scheduled-email store", async () => {
    process.env["EMAILS_MODE"] = "local";

    const output = await runMiscCommand(["schedule", "list"]);

    expect(output).toContain("No scheduled emails.");
  });

  it("fails closed in self_hosted mode before creating the default local scheduler DB", async () => {
    await withTempSelfHostedHome("emails-schedule-self-hosted-", async (tmpHome) => {
      const errors = await runMiscCommandExpectingExit(["schedule", "list"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("local scheduler/automation storage only");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });
});

describe("scheduler tick", () => {
  it("processes scheduled emails and sequence enrollments through one shared tick", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "tick-sandbox", type: "sandbox" }, db);
    const scheduled = createScheduledEmail({
      provider_id: provider.id,
      from_address: "sender@example.com",
      to_addresses: ["scheduled@example.com"],
      subject: "Scheduled smoke",
      text_body: "scheduled body",
      scheduled_at: "2000-01-01T00:00:00.000Z",
    }, db);

    createTemplate({
      name: "tick-template",
      subject_template: "Welcome {{email}}",
      text_template: "hello {{email}}",
    }, db);
    const sequence = createSequence({ name: "tick-sequence" }, db);
    addStep({
      sequence_id: sequence.id,
      step_number: 1,
      delay_hours: 0,
      template_name: "tick-template",
      from_address: "sender@example.com",
    }, db);
    const enrollment = enroll({ sequence_id: sequence.id, contact_email: "sequence@example.com", provider_id: provider.id }, db);
    db.run("UPDATE sequence_enrollments SET next_send_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", enrollment.id]);

    const logs: string[] = [];
    const result = await runSchedulerTick({ scheduledLimit: 10, sequenceLimit: 10, log: (line) => logs.push(line) });

    expect(result.scheduled).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
    expect(result.sequences).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
    expect(getScheduledEmail(scheduled.id, db)?.status).toBe("sent");

    const subjects = listSandboxEmails(provider.id, 10, db).map((email) => email.subject);
    expect(subjects).toContain("Scheduled smoke");
    expect(subjects).toContain("Welcome sequence@example.com");
    expect(listEnrollments({ sequence_id: sequence.id }, db)[0]?.status).toBe("completed");
    expect(logs.some((line) => line.includes("Sent scheduled email"))).toBe(true);
    expect(logs.some((line) => line.includes("Sent sequence step"))).toBe(true);
  });

  it("fails closed in self_hosted mode before opening local scheduled or sequence tables", async () => {
    await withTempSelfHostedHome("emails-scheduler-tick-self-hosted-", async (tmpHome) => {
      await expect(runSchedulerTick()).rejects.toThrow("self_hosted API-only mode");

      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });
});

describe("batch command", () => {
  it("fails closed in self_hosted mode before reading local provider/template state", async () => {
    await withTempSelfHostedHome("emails-batch-self-hosted-", async (tmpHome) => {
      const errors = await runMiscCommandExpectingExit([
        "batch",
        "--csv",
        join(tmpHome, "recipients.csv"),
        "--template",
        "welcome",
        "--from",
        "sender@example.com",
      ]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("local scheduler/automation storage only");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });
});

describe("doctor command", () => {
  it("fails closed in self_hosted mode before opening local diagnostics state", async () => {
    await withTempSelfHostedHome("emails-doctor-self-hosted-", async (tmpHome) => {
      const errors = await runMiscCommandExpectingExit(["doctor"]);

      expect(errors).toContain("self_hosted API-only mode");
      expect(errors).toContain("/health or /ready");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
    });
  });
});
