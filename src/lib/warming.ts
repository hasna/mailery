import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { sqlEmailDomain } from "../db/email-address-sql.js";

export interface WarmingSchedule {
  id: string;
  domain: string;
  provider_id: string | null;
  target_daily_volume: number;
  start_date: string;
  status: "active" | "paused" | "completed";
  created_at: string;
  updated_at: string;
}

export interface WarmingDay {
  day: number;
  date: string;
  limit: number;
  is_today: boolean;
  is_past: boolean;
}

/**
 * Generate a warming schedule: exponential ramp-up.
 * Day 1: 50, day 3: 100, day 5: 250, day 7: 500, day 9: 1000...
 * Doubles roughly every 2 days until target is reached.
 * Returns array of {day, limit} entries.
 */
export function generateWarmingPlan(targetDailyVolume: number): { day: number; limit: number }[] {
  const plan: { day: number; limit: number }[] = [];
  let current = 50;
  let day = 1;

  while (current < targetDailyVolume) {
    plan.push({ day, limit: Math.min(current, targetDailyVolume) });
    if (day % 2 === 0) current = Math.round(current * 2);
    day++;
    if (day > 60) break; // safety cap at 60 days
  }
  plan.push({ day, limit: targetDailyVolume }); // final day = full volume

  return plan;
}

/**
 * Get today's sending limit for a domain, given the warming schedule.
 * Returns null if no active schedule exists for the domain.
 */
export function getTodayLimit(schedule: WarmingSchedule): number | null {
  if (schedule.status !== "active") return null;

  const startDate = new Date(schedule.start_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  startDate.setHours(0, 0, 0, 0);

  const dayDiff = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  const currentDay = dayDiff + 1; // 1-based

  if (currentDay < 1) return 0; // not started yet

  const plan = generateWarmingPlan(schedule.target_daily_volume);
  const dayEntry = plan.find(p => p.day >= currentDay) ?? plan[plan.length - 1];

  if (!dayEntry) return schedule.target_daily_volume;
  if (currentDay > plan[plan.length - 1]!.day) return schedule.target_daily_volume; // graduated

  return dayEntry.limit;
}

/**
 * Get how many emails have been sent from a domain today.
 */
export function getTodaySentCount(domain: string, db?: Database): number {
  const d = db || getDatabase();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const tomorrow = new Date(`${today}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const start = `${today}T00:00:00`;
  const end = tomorrow.toISOString().slice(0, 19);
  const result = d.query(
    `SELECT COUNT(*) as count FROM emails WHERE ${sqlEmailDomain("from_address")} = ? AND sent_at >= ? AND sent_at < ?`,
  ).get(domain.toLowerCase(), start, end) as { count: number } | null;
  return result?.count ?? 0;
}

/**
 * Format warming schedule status for terminal display.
 */
export function formatWarmingStatus(schedule: WarmingSchedule, db?: Database): string {
  const todayLimit = getTodayLimit(schedule);
  const todaySent = getTodaySentCount(schedule.domain, db);

  const startDate = new Date(schedule.start_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  startDate.setHours(0, 0, 0, 0);
  const currentDay = Math.max(1, Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);

  const plan = generateWarmingPlan(schedule.target_daily_volume);
  const totalDays = plan[plan.length - 1]?.day ?? 30;
  const progress = Math.min(100, Math.round((currentDay / totalDays) * 100));

  return [
    `Domain: ${schedule.domain}`,
    `Status: ${schedule.status} | Day ${currentDay}/${totalDays} (${progress}% complete)`,
    `Today's limit: ${todayLimit ?? "unlimited"} | Sent today: ${todaySent}`,
    `Target: ${schedule.target_daily_volume}/day | Started: ${schedule.start_date}`,
  ].join("\n");
}
