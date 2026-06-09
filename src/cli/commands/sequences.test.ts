import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { addStep, createSequence, enroll, unenroll } from "../../db/sequences.js";
import { registerSequenceCommands } from "./sequences.js";

async function runSequenceCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerSequenceCommands(program, (d, formatted) => {
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

describe("sequence list command", () => {
  it("paginates sequences for human and structured output", async () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      const sequence = createSequence({ name: `cli-sequence-${i}` });
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE sequences SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, sequence.id]);
    }

    const result = await runSequenceCommand(["sequence", "list", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ name: string }>;

    expect(data.map((sequence) => sequence.name)).toEqual(["cli-sequence-3", "cli-sequence-2"]);
    expect(result.out).toContain("cli-sequence-3");
    expect(result.out).not.toContain("cli-sequence-4");
  });
});

describe("sequence show command", () => {
  it("prints enrollment counts without loading every enrollment row", async () => {
    const db = getDatabase();
    const sequence = createSequence({ name: "cli-show-counts" });
    addStep({ sequence_id: sequence.id, step_number: 1, delay_hours: 0, template_name: "welcome" });
    enroll({ sequence_id: sequence.id, contact_email: "active-a@example.com" });
    enroll({ sequence_id: sequence.id, contact_email: "active-b@example.com" });
    enroll({ sequence_id: sequence.id, contact_email: "cancelled@example.com" });
    unenroll(sequence.id, "cancelled@example.com");
    enroll({ sequence_id: sequence.id, contact_email: "completed@example.com" });
    db.run("UPDATE sequence_enrollments SET status = 'completed' WHERE sequence_id = ? AND contact_email = ?", [sequence.id, "completed@example.com"]);

    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await runSequenceCommand(["sequence", "show", "cli-show-counts"]);
    } finally {
      console.log = originalLog;
      db.query = originalQuery;
    }

    expect(logs.join("\n")).toContain("Enrollments: 2 active / 4 total");
    const enrollmentQueries = queries.filter((sql) => sql.includes("FROM sequence_enrollments"));
    expect(enrollmentQueries.some((sql) => sql.includes("COUNT(*) AS total"))).toBe(true);
    expect(enrollmentQueries.some((sql) => sql.includes("SELECT *"))).toBe(false);
  });
});

describe("sequence enrollments command", () => {
  it("lists all enrollments without requiring a sequence name", async () => {
    const sequence = createSequence({ name: "cli-enrollment-all" });
    const other = createSequence({ name: "cli-enrollment-other" });
    enroll({ sequence_id: sequence.id, contact_email: "first@example.com" });
    enroll({ sequence_id: other.id, contact_email: "second@example.com" });

    const result = await runSequenceCommand(["sequence", "enrollments"]);
    const data = result.data as Array<{ contact_email: string }>;

    expect(data.map((enrollment) => enrollment.contact_email).sort()).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
    expect(result.out).toContain("for all sequences");
  });

  it("filters by sequence and status before applying pagination", async () => {
    const db = getDatabase();
    const sequence = createSequence({ name: "cli-enrollment-page" });
    const other = createSequence({ name: "cli-enrollment-noise" });
    for (let i = 0; i < 5; i++) {
      const email = `active-${i}@example.com`;
      enroll({ sequence_id: sequence.id, contact_email: email });
      db.run(
        "UPDATE sequence_enrollments SET enrolled_at = ? WHERE sequence_id = ? AND contact_email = ?",
        [`2026-01-0${i + 1}T00:00:00.000Z`, sequence.id, email],
      );
    }
    enroll({ sequence_id: sequence.id, contact_email: "cancelled@example.com" });
    unenroll(sequence.id, "cancelled@example.com");
    db.run(
      "UPDATE sequence_enrollments SET enrolled_at = ? WHERE sequence_id = ? AND contact_email = ?",
      ["2026-01-10T00:00:00.000Z", sequence.id, "cancelled@example.com"],
    );
    enroll({ sequence_id: other.id, contact_email: "other@example.com" });

    const result = await runSequenceCommand([
      "sequence",
      "enrollments",
      "cli-enrollment-page",
      "--status",
      "active",
      "--limit",
      "2",
      "--offset",
      "1",
    ]);
    const data = result.data as Array<{ contact_email: string; sequence_id: string; status: string }>;

    expect(data.map((enrollment) => enrollment.contact_email)).toEqual([
      "active-3@example.com",
      "active-2@example.com",
    ]);
    expect(data.every((enrollment) => enrollment.sequence_id === sequence.id)).toBe(true);
    expect(data.every((enrollment) => enrollment.status === "active")).toBe(true);
  });
});
