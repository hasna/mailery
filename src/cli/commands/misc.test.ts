import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createScheduledEmail, getScheduledEmail } from "../../db/scheduled.js";
import { listSandboxEmails } from "../../db/sandbox.js";
import { createTemplate } from "../../db/templates.js";
import { addStep, createSequence, enroll, listEnrollments } from "../../db/sequences.js";
import { registerMiscCommands, runSchedulerTick } from "./misc.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
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
});
