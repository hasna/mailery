import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";
import type { WarmingSchedule } from "../lib/warming.js";

interface WarmingRow {
  id: string;
  domain: string;
  provider_id: string | null;
  target_daily_volume: number;
  start_date: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToSchedule(row: WarmingRow): WarmingSchedule {
  return {
    ...row,
    status: row.status as WarmingSchedule["status"],
  };
}

export function createWarmingSchedule(
  input: {
    domain: string;
    provider_id?: string;
    target_daily_volume: number;
    start_date?: string;
  },
  db?: Database,
): WarmingSchedule {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  const startDate = input.start_date ?? new Date().toISOString().slice(0, 10);

  d.run(
    `INSERT INTO warming_schedules (id, domain, provider_id, target_daily_volume, start_date, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, input.domain, input.provider_id ?? null, input.target_daily_volume, startDate, timestamp, timestamp],
  );

  return getWarmingSchedule(input.domain, d)!;
}

export function getWarmingSchedule(domain: string, db?: Database): WarmingSchedule | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM warming_schedules WHERE domain = ?").get(domain) as WarmingRow | null;
  if (!row) return null;
  return rowToSchedule(row);
}

export interface ListWarmingScheduleOptions {
  limit?: number;
  offset?: number;
}

export function listWarmingSchedules(status?: string, db?: Database, opts?: ListWarmingScheduleOptions): WarmingSchedule[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const pageSql = limit !== null ? " LIMIT ? OFFSET ?" : "";
  if (status) {
    const rows = limit !== null
      ? d.query(`SELECT * FROM warming_schedules WHERE status = ? ORDER BY created_at DESC${pageSql}`).all(status, limit, offset) as WarmingRow[]
      : d.query("SELECT * FROM warming_schedules WHERE status = ? ORDER BY created_at DESC").all(status) as WarmingRow[];
    return rows.map(rowToSchedule);
  }
  const rows = limit !== null
    ? d.query(`SELECT * FROM warming_schedules ORDER BY created_at DESC${pageSql}`).all(limit, offset) as WarmingRow[]
    : d.query("SELECT * FROM warming_schedules ORDER BY created_at DESC").all() as WarmingRow[];
  return rows.map(rowToSchedule);
}

export function updateWarmingStatus(
  domain: string,
  status: "active" | "paused" | "completed",
  db?: Database,
): WarmingSchedule | null {
  const d = db || getDatabase();
  const timestamp = now();
  const result = d.run(
    "UPDATE warming_schedules SET status = ?, updated_at = ? WHERE domain = ?",
    [status, timestamp, domain],
  );
  if (result.changes === 0) return null;
  return getWarmingSchedule(domain, d);
}

export function deleteWarmingSchedule(domain: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM warming_schedules WHERE domain = ?", [domain]);
  return result.changes > 0;
}
