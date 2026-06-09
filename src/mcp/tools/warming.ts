import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus } from "../../db/warming.js";
import { getTodayLimit, getTodaySentCount, generateWarmingPlan } from "../../lib/warming.js";
import { getDatabase } from "../../db/database.js";
import { formatError } from "../helpers.js";

export function registerWarmingTools(server: McpServer): void {
  server.tool(
    "create_warming_schedule",
    "Create a domain warming schedule to gradually ramp up email send volume",
    {
      domain: z.string().describe("Domain to warm up (e.g. example.com)"),
      target_daily_volume: z.number().describe("Target daily send volume to reach"),
      start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (default: today)"),
      provider_id: z.string().optional().describe("Provider ID to associate with this domain"),
    },
    async ({ domain, target_daily_volume, start_date, provider_id }) => {
      try {
        const schedule = createWarmingSchedule({ domain, target_daily_volume, start_date, provider_id });
        const plan = generateWarmingPlan(target_daily_volume);
        return { content: [{ type: "text", text: JSON.stringify({ schedule, plan_days: plan.length, final_day: plan[plan.length - 1]?.day }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_warming_status",
    "Get current warming status for a domain including today's limit and sent count",
    { domain: z.string().describe("Domain to check") },
    async ({ domain }) => {
      try {
        const schedule = getWarmingSchedule(domain);
        if (!schedule) throw new Error(`No warming schedule found for domain: ${domain}`);
        const db = getDatabase();
        const today_limit = getTodayLimit(schedule);
        const today_sent = getTodaySentCount(domain, db);
        const startDate = new Date(schedule.start_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        startDate.setHours(0, 0, 0, 0);
        const current_day = Math.max(1, Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
        return { content: [{ type: "text", text: JSON.stringify({ schedule, today_limit, today_sent, current_day }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "list_warming_schedules",
    "List all domain warming schedules",
    {
      status: z.enum(["active", "paused", "completed"]).optional().describe("Filter by status"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum schedules to return"),
      offset: z.number().int().min(0).optional().describe("Number of schedules to skip"),
    },
    async ({ status, limit, offset }) => {
      try {
        const effectiveLimit = limit ?? 100;
        const effectiveOffset = offset ?? 0;
        const rows = listWarmingSchedules(status, undefined, { limit: effectiveLimit + 1, offset: effectiveOffset });
        const schedules = rows.slice(0, effectiveLimit);
        return { content: [{ type: "text", text: JSON.stringify({
          schedules,
          limit: effectiveLimit,
          offset: effectiveOffset,
          truncated: rows.length > effectiveLimit,
          cli_equivalent: `emails domain warm-list${status ? ` --status ${status}` : ""}${limit !== undefined ? ` --limit ${limit}` : ""}${offset !== undefined ? ` --offset ${offset}` : ""} --json`,
        }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "update_warming_status",
    "Update the status of a domain warming schedule",
    {
      domain: z.string().describe("Domain to update"),
      status: z.enum(["active", "paused", "completed"]).describe("New status"),
    },
    async ({ domain, status }) => {
      try {
        const updated = updateWarmingStatus(domain, status);
        if (!updated) throw new Error(`No warming schedule found for domain: ${domain}`);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );
}
