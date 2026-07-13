import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { addStep, createSequence, enroll, unenroll } from "../../db/sequences.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { registerSequenceCommands } from "./sequences.js";

const ENV_KEYS = [
  "HOME",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
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
] as const;

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

async function runSequenceCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await runSequenceCommand(args);
    return { error: null, stderr: errors.join("\n") };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

async function withTempSelfHostedHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), "emails-sequence-self-hosted-"));
  const home = join(root, "home");
  closeDatabase();
  resetDatabase();
  process.env["HOME"] = home;
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["HASNA_EMAILS_DB_PATH"];
  delete process.env["HASNA_EMAILS_MODE"];
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";
  resetSelfHostedConfigCache();
  try {
    return await fn(home);
  } finally {
    closeDatabase();
    resetDatabase();
    resetSelfHostedConfigCache();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function localDbPath(home: string): string {
  return join(home, ".hasna", "emails", "emails.db");
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  for (const key of ENV_KEYS) {
    if (key !== "HOME" && key !== "EMAILS_DB_PATH") delete process.env[key];
  }
  resetSelfHostedConfigCache();
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  for (const key of ENV_KEYS) {
    if (key !== "HOME") delete process.env[key];
  }
  resetSelfHostedConfigCache();
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

  it("fails closed in self_hosted mode before reading local enrollments", async () => {
    await withTempSelfHostedHome(async (home) => {
      const result = await runSequenceCommandExpectingExit(["sequence", "enrollments"]);

      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("self_hosted API-only mode");
      expect(result.stderr).toContain("local sequence enrollment rows");
      expect(existsSync(localDbPath(home))).toBe(false);
    });
  });
});

describe("sequence step command self_hosted guards", () => {
  it("fails closed in self_hosted mode before writing local steps", async () => {
    await withTempSelfHostedHome(async (home) => {
      const result = await runSequenceCommandExpectingExit([
        "sequence",
        "step",
        "add",
        "api-sequence",
        "--step",
        "1",
        "--delay",
        "0",
        "--template",
        "welcome",
      ]);

      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain("self_hosted API-only mode");
      expect(result.stderr).toContain("local sequence step rows");
      expect(existsSync(localDbPath(home))).toBe(false);
    });
  });
});
