import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "./database.js";
import {
  createWarmingSchedule,
  getWarmingSchedule,
  listWarmingSchedules,
  updateWarmingStatus,
  deleteWarmingSchedule,
} from "./warming.js";

describe("warming CRUD", () => {
  beforeEach(() => {
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    getDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env["EMAILS_DB_PATH"];
  });

  it("creates a warming schedule", () => {
    const schedule = createWarmingSchedule({ domain: "example-warm-create.com", target_daily_volume: 1000 });
    expect(schedule.domain).toBe("example-warm-create.com");
    expect(schedule.target_daily_volume).toBe(1000);
    expect(schedule.status).toBe("active");
    expect(schedule.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(schedule.id).toBeTruthy();
  });

  it("creates a warming schedule with custom start_date", () => {
    const schedule = createWarmingSchedule({ domain: "custom.com", target_daily_volume: 500, start_date: "2025-01-01" });
    expect(schedule.start_date).toBe("2025-01-01");
  });

  it("getWarmingSchedule returns null for unknown domain", () => {
    const result = getWarmingSchedule("notfound.com");
    expect(result).toBeNull();
  });

  it("getWarmingSchedule retrieves by domain", () => {
    createWarmingSchedule({ domain: "get-test.com", target_daily_volume: 200 });
    const result = getWarmingSchedule("get-test.com");
    expect(result).not.toBeNull();
    expect(result!.domain).toBe("get-test.com");
  });

  it("listWarmingSchedules returns all", () => {
    createWarmingSchedule({ domain: "a.com", target_daily_volume: 100 });
    createWarmingSchedule({ domain: "b.com", target_daily_volume: 200 });
    const all = listWarmingSchedules();
    const domains = all.map((s) => s.domain);
    expect(domains).toContain("a.com");
    expect(domains).toContain("b.com");
  });

  it("listWarmingSchedules filters by status", () => {
    createWarmingSchedule({ domain: "active1.com", target_daily_volume: 100 });
    createWarmingSchedule({ domain: "paused1.com", target_daily_volume: 100 });
    updateWarmingStatus("paused1.com", "paused");

    const active = listWarmingSchedules("active");
    const paused = listWarmingSchedules("paused");

    expect(active.every((s) => s.status === "active")).toBe(true);
    expect(paused.every((s) => s.status === "paused")).toBe(true);
    expect(active.some((s) => s.domain === "active1.com")).toBe(true);
    expect(paused.some((s) => s.domain === "paused1.com")).toBe(true);
  });

  it("listWarmingSchedules paginates after status filtering", () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const schedule = createWarmingSchedule({ domain: `warm-${i}.example.com`, target_daily_volume: 100 });
      db.run("UPDATE warming_schedules SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, schedule.id]);
    }
    updateWarmingStatus("warm-4.example.com", "paused");

    const page = listWarmingSchedules("active", db, { limit: 2, offset: 1 });

    expect(page.map((schedule) => schedule.domain)).toEqual([
      "warm-2.example.com",
      "warm-1.example.com",
    ]);
  });

  it("updateWarmingStatus changes status", () => {
    createWarmingSchedule({ domain: "status-test.com", target_daily_volume: 300 });
    const paused = updateWarmingStatus("status-test.com", "paused");
    expect(paused).not.toBeNull();
    expect(paused!.status).toBe("paused");

    const completed = updateWarmingStatus("status-test.com", "completed");
    expect(completed!.status).toBe("completed");
  });

  it("updateWarmingStatus returns null for unknown domain", () => {
    const result = updateWarmingStatus("ghost.com", "paused");
    expect(result).toBeNull();
  });

  it("deleteWarmingSchedule removes the schedule", () => {
    createWarmingSchedule({ domain: "del.com", target_daily_volume: 100 });
    const deleted = deleteWarmingSchedule("del.com");
    expect(deleted).toBe(true);
    const result = getWarmingSchedule("del.com");
    expect(result).toBeNull();
  });

  it("deleteWarmingSchedule returns false for unknown domain", () => {
    const result = deleteWarmingSchedule("ghost.com");
    expect(result).toBe(false);
  });

  it("domain is unique — duplicate throws", () => {
    createWarmingSchedule({ domain: "unique.com", target_daily_volume: 100 });
    expect(() => createWarmingSchedule({ domain: "unique.com", target_daily_volume: 200 })).toThrow();
  });
});
