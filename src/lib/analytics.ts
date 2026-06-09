import { ansi } from "./ansi.js";
import { getDatabase } from "../db/database.js";
import type { Database } from "../db/database.js";
import { countValue } from "../db/scalars.js";

export interface AnalyticsData {
  dailyVolume: { date: string; count: number }[];
  topRecipients: { email: string; count: number }[];
  busiestHours: { hour: number; count: number }[];
  deliveryTrend: { date: string; sent: number; delivered: number; bounced: number }[];
}

function parsePeriodDays(period: string): number {
  const days = Number.parseInt(period.replace("d", ""), 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

export function getAnalytics(providerId?: string, period = "30d", db?: Database): AnalyticsData {
  const d = db || getDatabase();
  const days = parsePeriodDays(period);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Daily volume
  const volumeParams: any[] = [since];
  let volumeWhere = "WHERE sent_at >= ?";
  if (providerId) {
    volumeWhere += " AND provider_id = ?";
    volumeParams.push(providerId);
  }
  const dailyVolumeRows = d
    .query(`SELECT date(sent_at) as date, COUNT(*) as count FROM emails ${volumeWhere} GROUP BY date(sent_at) ORDER BY date`)
    .all(...volumeParams) as { date: string; count: unknown }[];
  const dailyVolume = dailyVolumeRows.map((row) => ({ date: row.date, count: countValue(row.count) }));

  // Top recipients: expand JSON arrays in SQLite so large histories do not hydrate every sent row.
  const topRecipientRows = d
    .query(
      `SELECT recipient.value AS email, COUNT(*) AS count
       FROM emails e
       JOIN json_each(
         CASE
           WHEN json_valid(e.to_addresses) THEN
             CASE WHEN json_type(e.to_addresses) = 'array' THEN e.to_addresses ELSE '[]' END
           ELSE '[]'
         END
       ) AS recipient
       WHERE e.sent_at >= ?${providerId ? " AND e.provider_id = ?" : ""}
         AND recipient.type = 'text'
       GROUP BY recipient.value
       ORDER BY count DESC, recipient.value ASC
       LIMIT 10`,
    )
    .all(...volumeParams) as { email: string; count: unknown }[];
  const topRecipients = topRecipientRows.map((row) => ({ email: row.email, count: countValue(row.count) }));

  // Busiest hours
  const busiestHourRows = d
    .query(
      `SELECT cast(strftime('%H', sent_at) as integer) as hour, COUNT(*) as count FROM emails ${volumeWhere} GROUP BY hour ORDER BY hour`,
    )
    .all(...volumeParams) as { hour: number; count: unknown }[];
  const busiestHours = busiestHourRows.map((row) => ({ hour: row.hour, count: countValue(row.count) }));

  // Delivery trend: reuse the sent/day aggregation and scan delivery events once.
  const trendParams: any[] = [since];
  let trendProviderFilter = "";
  if (providerId) {
    trendProviderFilter = " AND e.provider_id = ?";
    trendParams.push(providerId);
  }

  const eventsByDay = d
    .query(
      `SELECT
         date(ev.occurred_at) as date,
         COALESCE(SUM(CASE WHEN ev.type = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
         COALESCE(SUM(CASE WHEN ev.type = 'bounced' THEN 1 ELSE 0 END), 0) AS bounced
       FROM events ev
       JOIN emails e ON ev.email_id = e.id
       WHERE ev.type IN ('delivered', 'bounced')
         AND ev.occurred_at >= ?${trendProviderFilter}
       GROUP BY date(ev.occurred_at)`,
    )
    .all(...trendParams) as { date: string; delivered: unknown; bounced: unknown }[];

  const eventMap = new Map(eventsByDay.map((row) => [row.date, {
    delivered: countValue(row.delivered),
    bounced: countValue(row.bounced),
  }]));

  const deliveryTrend = dailyVolume.map((row) => ({
    date: row.date,
    sent: row.count,
    delivered: eventMap.get(row.date)?.delivered ?? 0,
    bounced: eventMap.get(row.date)?.bounced ?? 0,
  }));

  return { dailyVolume, topRecipients, busiestHours, deliveryTrend };
}

export function formatAnalytics(data: AnalyticsData): string {
  let output = "";

  // Daily volume - ASCII bar chart
  output += ansi.bold("\n  Daily Send Volume\n");
  if (data.dailyVolume.length === 0) {
    output += "  No data\n";
  } else {
    const maxCount = Math.max(...data.dailyVolume.map((d) => d.count), 1);
    for (const day of data.dailyVolume.slice(-14)) {
      const barLen = Math.round((day.count / maxCount) * 40);
      const bar = ansi.blue("\u2588".repeat(barLen));
      output += `  ${day.date}  ${bar} ${day.count}\n`;
    }
  }

  // Top recipients
  output += ansi.bold("\n  Top Recipients\n");
  if (data.topRecipients.length === 0) {
    output += "  No data\n";
  } else {
    for (const r of data.topRecipients.slice(0, 10)) {
      output += `  ${r.email}  ${ansi.gray(`(${r.count} emails)`)}\n`;
    }
  }

  // Busiest hours
  output += ansi.bold("\n  Busiest Hours\n");
  if (data.busiestHours.length === 0) {
    output += "  No data\n";
  } else {
    const maxHour = Math.max(...data.busiestHours.map((h) => h.count), 1);
    for (const h of data.busiestHours) {
      const barLen = Math.round((h.count / maxHour) * 30);
      const bar = ansi.cyan("\u2588".repeat(barLen));
      output += `  ${String(h.hour).padStart(2, "0")}:00  ${bar} ${h.count}\n`;
    }
  }

  // Delivery trend
  output += ansi.bold("\n  Delivery Trend (last 7 days)\n");
  if (data.deliveryTrend.length === 0) {
    output += "  No data\n";
  } else {
    for (const d of data.deliveryTrend.slice(-7)) {
      const total = d.sent || 1;
      const rate = ((d.delivered / total) * 100).toFixed(1);
      const rateColor = parseFloat(rate) > 95 ? ansi.green : parseFloat(rate) > 80 ? ansi.yellow : ansi.red;
      output += `  ${d.date}  sent:${d.sent} delivered:${d.delivered} bounced:${d.bounced}  ${rateColor(rate + "%")}\n`;
    }
  }

  return output;
}
