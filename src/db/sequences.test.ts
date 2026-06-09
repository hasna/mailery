import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import {
  createSequence,
  getSequence,
  listSequences,
  updateSequence,
  deleteSequence,
  addStep,
  listSteps,
  getStepAtIndex,
  removeStep,
  enroll,
  unenroll,
  listEnrollments,
  countEnrollmentsByStatus,
  getDueEnrollments,
  advanceEnrollment,
} from "./sequences.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  getDatabase(); // initialize schema
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

// ─── createSequence ───────────────────────────────────────────────────────────

describe("createSequence", () => {
  it("creates a sequence with required fields", () => {
    const seq = createSequence({ name: "welcome" });
    expect(seq.id).toHaveLength(36);
    expect(seq.name).toBe("welcome");
    expect(seq.description).toBeNull();
    expect(seq.status).toBe("active");
    expect(seq.created_at).toBeTruthy();
    expect(seq.updated_at).toBeTruthy();
  });

  it("creates a sequence with description", () => {
    const seq = createSequence({ name: "onboarding", description: "New user flow" });
    expect(seq.description).toBe("New user flow");
  });

  it("throws on duplicate name", () => {
    createSequence({ name: "dup" });
    expect(() => createSequence({ name: "dup" })).toThrow();
  });
});

// ─── getSequence ──────────────────────────────────────────────────────────────

describe("getSequence", () => {
  it("retrieves by id", () => {
    const seq = createSequence({ name: "by-id" });
    const found = getSequence(seq.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(seq.id);
  });

  it("retrieves by name", () => {
    createSequence({ name: "by-name" });
    const found = getSequence("by-name");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("by-name");
  });

  it("returns null for unknown", () => {
    expect(getSequence("nonexistent")).toBeNull();
  });
});

// ─── listSequences ────────────────────────────────────────────────────────────

describe("listSequences", () => {
  it("returns all sequences", () => {
    createSequence({ name: "a" });
    createSequence({ name: "b" });
    const all = listSequences();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array when none exist", () => {
    expect(listSequences()).toHaveLength(0);
  });

  it("paginates sequences after ordering newest first", () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      const seq = createSequence({ name: `page-${i}` });
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE sequences SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, seq.id]);
    }

    const page = listSequences(undefined, { limit: 2, offset: 1 });

    expect(page.map((seq) => seq.name)).toEqual(["page-3", "page-2"]);
  });
});

// ─── updateSequence ───────────────────────────────────────────────────────────

describe("updateSequence", () => {
  it("updates status to paused", () => {
    const seq = createSequence({ name: "pause-me" });
    const updated = updateSequence(seq.id, { status: "paused" });
    expect(updated.status).toBe("paused");
  });

  it("updates name and description", () => {
    const seq = createSequence({ name: "old-name" });
    const updated = updateSequence(seq.id, { name: "new-name", description: "desc" });
    expect(updated.name).toBe("new-name");
    expect(updated.description).toBe("desc");
  });

  it("throws for unknown id", () => {
    expect(() => updateSequence("bad-id", { status: "archived" })).toThrow();
  });
});

// ─── deleteSequence ───────────────────────────────────────────────────────────

describe("deleteSequence", () => {
  it("deletes an existing sequence", () => {
    const seq = createSequence({ name: "to-delete" });
    expect(deleteSequence(seq.id)).toBe(true);
    expect(getSequence(seq.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteSequence("nonexistent")).toBe(false);
  });
});

// ─── addStep / listSteps / removeStep ─────────────────────────────────────────

describe("addStep", () => {
  it("adds a step to a sequence", () => {
    const seq = createSequence({ name: "step-seq" });
    const step = addStep({
      sequence_id: seq.id,
      step_number: 1,
      delay_hours: 24,
      template_name: "welcome",
    });
    expect(step.id).toHaveLength(36);
    expect(step.sequence_id).toBe(seq.id);
    expect(step.step_number).toBe(1);
    expect(step.delay_hours).toBe(24);
    expect(step.template_name).toBe("welcome");
    expect(step.from_address).toBeNull();
    expect(step.subject_override).toBeNull();
  });

  it("adds step with optional fields", () => {
    const seq = createSequence({ name: "step-seq-2" });
    const step = addStep({
      sequence_id: seq.id,
      step_number: 1,
      delay_hours: 48,
      template_name: "followup",
      from_address: "hello@example.com",
      subject_override: "Custom subject",
    });
    expect(step.from_address).toBe("hello@example.com");
    expect(step.subject_override).toBe("Custom subject");
  });

  it("throws on duplicate step_number in same sequence", () => {
    const seq = createSequence({ name: "step-dup" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" });
    expect(() => addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 48, template_name: "t2" })).toThrow();
  });
});

describe("listSteps", () => {
  it("returns steps ordered by step_number", () => {
    const seq = createSequence({ name: "ordered-steps" });
    addStep({ sequence_id: seq.id, step_number: 2, delay_hours: 48, template_name: "t2" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" });
    const steps = listSteps(seq.id);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.step_number).toBe(1);
    expect(steps[1]?.step_number).toBe(2);
  });

  it("returns empty for unknown sequence", () => {
    expect(listSteps("unknown")).toHaveLength(0);
  });
});

describe("getStepAtIndex", () => {
  it("returns one step by zero-based sorted index", () => {
    const seq = createSequence({ name: "indexed-steps" });
    addStep({ sequence_id: seq.id, step_number: 20, delay_hours: 48, template_name: "t20" });
    addStep({ sequence_id: seq.id, step_number: 10, delay_hours: 24, template_name: "t10" });

    expect(getStepAtIndex(seq.id, 0)?.template_name).toBe("t10");
    expect(getStepAtIndex(seq.id, 1)?.template_name).toBe("t20");
    expect(getStepAtIndex(seq.id, 2)).toBeNull();
  });
});

describe("removeStep", () => {
  it("removes an existing step", () => {
    const seq = createSequence({ name: "rm-step" });
    const step = addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" });
    expect(removeStep(step.id)).toBe(true);
    expect(listSteps(seq.id)).toHaveLength(0);
  });

  it("returns false for unknown step", () => {
    expect(removeStep("nonexistent")).toBe(false);
  });
});

// ─── enroll / unenroll / listEnrollments ──────────────────────────────────────

describe("enroll", () => {
  it("enrolls a contact", () => {
    const seq = createSequence({ name: "enroll-seq" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" });
    const e = enroll({ sequence_id: seq.id, contact_email: "alice@example.com" });
    expect(e.id).toHaveLength(36);
    expect(e.sequence_id).toBe(seq.id);
    expect(e.contact_email).toBe("alice@example.com");
    expect(e.current_step).toBe(0);
    expect(e.status).toBe("active");
    expect(e.next_send_at).not.toBeNull();
  });

  it("is idempotent on duplicate enrollment", () => {
    const seq = createSequence({ name: "idem-seq" });
    const e1 = enroll({ sequence_id: seq.id, contact_email: "bob@example.com" });
    const e2 = enroll({ sequence_id: seq.id, contact_email: "bob@example.com" });
    expect(e1.id).toBe(e2.id);
  });

  it("sets next_send_at based on first step delay", () => {
    const seq = createSequence({ name: "delay-seq" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 72, template_name: "t1" });
    const e = enroll({ sequence_id: seq.id, contact_email: "carol@example.com" });
    expect(e.next_send_at).not.toBeNull();
    const nextSend = new Date(e.next_send_at!).getTime();
    const now = Date.now();
    // Should be ~72 hours in future (within 5 second tolerance)
    expect(nextSend).toBeGreaterThan(now + 71 * 3600 * 1000);
    expect(nextSend).toBeLessThan(now + 73 * 3600 * 1000);
  });

  it("sets next_send_at to null when no steps exist", () => {
    const seq = createSequence({ name: "no-steps-seq" });
    const e = enroll({ sequence_id: seq.id, contact_email: "dave@example.com" });
    expect(e.next_send_at).toBeNull();
  });
});

describe("unenroll", () => {
  it("cancels an active enrollment", () => {
    const seq = createSequence({ name: "unenroll-seq" });
    enroll({ sequence_id: seq.id, contact_email: "eve@example.com" });
    expect(unenroll(seq.id, "eve@example.com")).toBe(true);
    const enrollments = listEnrollments({ sequence_id: seq.id });
    expect(enrollments[0]?.status).toBe("cancelled");
  });

  it("returns false when not enrolled", () => {
    const seq = createSequence({ name: "unenroll-na" });
    expect(unenroll(seq.id, "nobody@example.com")).toBe(false);
  });
});

describe("listEnrollments", () => {
  it("lists all enrollments", () => {
    const seq = createSequence({ name: "list-enroll" });
    enroll({ sequence_id: seq.id, contact_email: "a@example.com" });
    enroll({ sequence_id: seq.id, contact_email: "b@example.com" });
    expect(listEnrollments()).toHaveLength(2);
  });

  it("filters by sequence_id", () => {
    const s1 = createSequence({ name: "filter-s1" });
    const s2 = createSequence({ name: "filter-s2" });
    enroll({ sequence_id: s1.id, contact_email: "x@example.com" });
    enroll({ sequence_id: s2.id, contact_email: "y@example.com" });
    expect(listEnrollments({ sequence_id: s1.id })).toHaveLength(1);
  });

  it("filters by status", () => {
    const seq = createSequence({ name: "status-filter" });
    enroll({ sequence_id: seq.id, contact_email: "aa@example.com" });
    unenroll(seq.id, "aa@example.com");
    expect(listEnrollments({ status: "cancelled" })).toHaveLength(1);
    expect(listEnrollments({ status: "active" })).toHaveLength(0);
  });

  it("filters enrollments before applying pagination", () => {
    const db = getDatabase();
    const seq = createSequence({ name: "enrollment-page" });
    const other = createSequence({ name: "other-enrollment-page" });
    for (let i = 0; i < 5; i++) {
      const email = `active-${i}@example.com`;
      enroll({ sequence_id: seq.id, contact_email: email });
      db.run(
        "UPDATE sequence_enrollments SET enrolled_at = ? WHERE sequence_id = ? AND contact_email = ?",
        [`2026-01-0${i + 1}T00:00:00.000Z`, seq.id, email],
      );
    }
    enroll({ sequence_id: seq.id, contact_email: "cancelled@example.com" });
    unenroll(seq.id, "cancelled@example.com");
    db.run(
      "UPDATE sequence_enrollments SET enrolled_at = ? WHERE sequence_id = ? AND contact_email = ?",
      ["2026-01-10T00:00:00.000Z", seq.id, "cancelled@example.com"],
    );
    enroll({ sequence_id: other.id, contact_email: "other@example.com" });
    db.run(
      "UPDATE sequence_enrollments SET enrolled_at = ? WHERE sequence_id = ? AND contact_email = ?",
      ["2026-01-11T00:00:00.000Z", other.id, "other@example.com"],
    );

    const page = listEnrollments({ sequence_id: seq.id, status: "active", limit: 2, offset: 1 });

    expect(page.map((enrollment) => enrollment.contact_email)).toEqual([
      "active-3@example.com",
      "active-2@example.com",
    ]);
    expect(page.every((enrollment) => enrollment.sequence_id === seq.id)).toBe(true);
    expect(page.every((enrollment) => enrollment.status === "active")).toBe(true);
  });
});

describe("countEnrollmentsByStatus", () => {
  it("counts enrollment statuses without hydrating enrollment rows", () => {
    const db = getDatabase();
    const seq = createSequence({ name: "count-enrollments" });
    enroll({ sequence_id: seq.id, contact_email: "active-a@example.com" });
    enroll({ sequence_id: seq.id, contact_email: "active-b@example.com" });
    enroll({ sequence_id: seq.id, contact_email: "cancelled@example.com" });
    unenroll(seq.id, "cancelled@example.com");
    enroll({ sequence_id: seq.id, contact_email: "completed@example.com" });
    db.run("UPDATE sequence_enrollments SET status = 'completed' WHERE sequence_id = ? AND contact_email = ?", [seq.id, "completed@example.com"]);

    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    expect(countEnrollmentsByStatus(seq.id, recordingDb)).toEqual({
      active: 2,
      completed: 1,
      cancelled: 1,
      total: 4,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("COUNT(*) AS total");
    expect(queries[0]).not.toContain("SELECT *");
  });
});

// ─── getDueEnrollments ────────────────────────────────────────────────────────

describe("getDueEnrollments", () => {
  it("returns only active enrollments with next_send_at in the past", () => {
    const db = getDatabase();
    const seq = createSequence({ name: "due-seq" });
    enroll({ sequence_id: seq.id, contact_email: "past@example.com" });

    // Manually set next_send_at to past
    db.run(
      "UPDATE sequence_enrollments SET next_send_at = ? WHERE contact_email = ?",
      [new Date(Date.now() - 1000).toISOString(), "past@example.com"],
    );

    enroll({ sequence_id: seq.id, contact_email: "future@example.com" });
    // future enrollment has next_send_at in the future (default from delay_hours)

    const due = getDueEnrollments();
    const emails = due.map(e => e.contact_email);
    expect(emails).toContain("past@example.com");
    expect(emails).not.toContain("future@example.com");
  });

  it("excludes cancelled enrollments", () => {
    const db = getDatabase();
    const seq = createSequence({ name: "cancelled-due" });
    enroll({ sequence_id: seq.id, contact_email: "cancelled@example.com" });
    db.run(
      "UPDATE sequence_enrollments SET next_send_at = ?, status = 'cancelled' WHERE contact_email = ?",
      [new Date(Date.now() - 1000).toISOString(), "cancelled@example.com"],
    );
    expect(getDueEnrollments()).toHaveLength(0);
  });

  it("limits due enrollments after ordering by next send time", () => {
    const db = getDatabase();
    const seq = createSequence({ name: "due-limit" });
    for (let i = 0; i < 5; i++) {
      const email = `due-${i}@example.com`;
      enroll({ sequence_id: seq.id, contact_email: email });
      db.run(
        "UPDATE sequence_enrollments SET next_send_at = ? WHERE sequence_id = ? AND contact_email = ?",
        [`2026-01-0${i + 1}T00:00:00.000Z`, seq.id, email],
      );
    }

    const due = getDueEnrollments({ limit: 2 });

    expect(due.map((enrollment) => enrollment.contact_email)).toEqual([
      "due-0@example.com",
      "due-1@example.com",
    ]);
  });
});

// ─── advanceEnrollment ────────────────────────────────────────────────────────

describe("advanceEnrollment", () => {
  it("advances to next step", () => {
    const seq = createSequence({ name: "advance-seq" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" });
    addStep({ sequence_id: seq.id, step_number: 2, delay_hours: 48, template_name: "t2" });
    const e = enroll({ sequence_id: seq.id, contact_email: "frank@example.com" });
    const advanced = advanceEnrollment(e.id);
    expect(advanced).not.toBeNull();
    expect(advanced?.current_step).toBe(1); // moved to next index
    expect(advanced?.status).toBe("active");
    expect(advanced?.next_send_at).not.toBeNull();
  });

  it("completes when past last step", () => {
    const seq = createSequence({ name: "complete-seq" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" });
    const e = enroll({ sequence_id: seq.id, contact_email: "grace@example.com" });
    // current_step is 0 (about to send step 1), advance moves to step 2 which doesn't exist
    const advanced = advanceEnrollment(e.id);
    expect(advanced?.status).toBe("completed");
    expect(advanced?.completed_at).not.toBeNull();
    expect(advanced?.next_send_at).toBeNull();
  });

  it("returns null for unknown enrollment id", () => {
    expect(advanceEnrollment("bad-id")).toBeNull();
  });

  it("fetches only the next step when advancing", () => {
    const db = getDatabase();
    const seq = createSequence({ name: "advance-query-shape" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" });
    addStep({ sequence_id: seq.id, step_number: 2, delay_hours: 48, template_name: "t2" });
    addStep({ sequence_id: seq.id, step_number: 3, delay_hours: 72, template_name: "t3" });
    const e = enroll({ sequence_id: seq.id, contact_email: "query@example.com" });
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    const advanced = advanceEnrollment(e.id, recordingDb);

    expect(advanced?.current_step).toBe(1);
    expect(queries.filter((sql) => sql.includes("FROM sequence_steps") && sql.includes("LIMIT 1 OFFSET ?"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("FROM sequence_steps") && !sql.includes("LIMIT 1 OFFSET ?"))).toHaveLength(0);
  });

  it("cascade deletes steps on sequence delete", () => {
    const seq = createSequence({ name: "cascade-seq" });
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 24, template_name: "t1" });
    expect(listSteps(seq.id)).toHaveLength(1);
    deleteSequence(seq.id);
    expect(listSteps(seq.id)).toHaveLength(0);
  });
});
