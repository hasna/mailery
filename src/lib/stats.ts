import type { Stats } from "../types/index.js";
import { getDatabase, type Database } from "../db/database.js";
import { countValue } from "../db/scalars.js";

function parsePeriodDays(period: string): number {
  const days = Number.parseInt(period.replace("d", ""), 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

export function getLocalStats(providerId?: string, period = "30d", db?: Database): Stats {
  const d = db || getDatabase();
  const days = parsePeriodDays(period);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const providerClause = providerId ? " AND provider_id = ?" : "";
  const params = providerId ? [since, providerId, since, providerId] : [since, since];
  const row = d.query(
    `SELECT
       (
         SELECT COUNT(*)
           FROM emails
          WHERE sent_at >= ?${providerClause}
       ) AS sent,
       COALESCE(SUM(CASE WHEN type = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
       COALESCE(SUM(CASE WHEN type = 'bounced' THEN 1 ELSE 0 END), 0) AS bounced,
       COALESCE(SUM(CASE WHEN type = 'complained' THEN 1 ELSE 0 END), 0) AS complained,
       COALESCE(SUM(CASE WHEN type = 'opened' THEN 1 ELSE 0 END), 0) AS opened,
       COALESCE(SUM(CASE WHEN type = 'clicked' THEN 1 ELSE 0 END), 0) AS clicked
     FROM events
     WHERE occurred_at >= ?${providerClause}`,
  ).get(...params) as Record<string, unknown> | null;

  const sent = countValue(row?.sent);
  const delivered = countValue(row?.delivered);
  const bounced = countValue(row?.bounced);
  const complained = countValue(row?.complained);
  const opened = countValue(row?.opened);
  const clicked = countValue(row?.clicked);

  return {
    provider_id: providerId ?? "all",
    period,
    sent,
    delivered,
    bounced,
    complained,
    opened,
    clicked,
    delivery_rate: sent > 0 ? roundRate((delivered / sent) * 100) : 0,
    bounce_rate: sent > 0 ? roundRate((bounced / sent) * 100) : 0,
    open_rate: delivered > 0 ? roundRate((opened / delivered) * 100) : 0,
  };
}

export function formatStatsTable(stats: Stats): string {
  const lines = [
    `Provider: ${stats.provider_id}   Period: ${stats.period}`,
    ``,
    `  Sent:         ${stats.sent}`,
    `  Delivered:    ${stats.delivered}  (${stats.delivery_rate.toFixed(1)}%)`,
    `  Bounced:      ${stats.bounced}  (${stats.bounce_rate.toFixed(1)}%)`,
    `  Complained:   ${stats.complained}`,
    `  Opened:       ${stats.opened}  (${stats.open_rate.toFixed(1)}%)`,
    `  Clicked:      ${stats.clicked}`,
  ];
  return lines.join("\n") + "\n";
}
