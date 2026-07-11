import type { Database } from "../db/database.js";
import { getDatabase, now } from "../db/database.js";
import {
  emailDigestPeriodLabel,
  getLatestEmailDigest,
  normalizeEmailDigestPeriod,
  saveEmailDigest,
  type EmailDigest,
  type EmailDigestPeriod,
} from "../db/email-digests.js";
import { parseJsonArray } from "../db/json.js";

export interface EmailDigestWindow {
  period: EmailDigestPeriod;
  since: string;
  until: string;
}

export interface GenerateEmailDigestOptions {
  period?: EmailDigestPeriod | string;
  limit?: number;
  offline?: boolean;
  db?: Database;
  now?: Date;
}

export interface LoadEmailDigestOptions extends GenerateEmailDigestOptions {
  fresh?: boolean;
  allowLocalFallback?: boolean;
}

interface DigestSourceEmail {
  id: string;
  from_address: string;
  to_addresses: string[];
  subject: string;
  received_at: string;
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
  labels: string[];
  body_excerpt: string;
  agent_category: string | null;
  agent_labels: string[];
  agent_priority: number | null;
  agent_risk_score: number | null;
  agent_summary: string | null;
}

const MAX_DIGEST_EMAILS = 160;
const MAX_BODY_EXCERPT_CHARS = 900;

interface DigestOutput {
  summary: string;
  highlights: string[];
  action_items: string[];
  important_email_ids: string[];
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveEmailDigestWindow(periodInput: EmailDigestPeriod | string | undefined, at = new Date()): EmailDigestWindow {
  const period = normalizeEmailDigestPeriod(typeof periodInput === "string" ? periodInput : periodInput ?? "today");
  const todayStart = startOfLocalDay(at);
  if (period === "today") {
    return { period, since: todayStart.toISOString(), until: at.toISOString() };
  }
  if (period === "yesterday") {
    const since = addDays(todayStart, -1);
    return { period, since: since.toISOString(), until: todayStart.toISOString() };
  }
  if (period === "last7") {
    return { period, since: addDays(todayStart, -6).toISOString(), until: at.toISOString() };
  }
  const monthStart = new Date(at.getFullYear(), at.getMonth(), 1);
  return { period, since: monthStart.toISOString(), until: at.toISOString() };
}

function normalizedLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/^ai:/, "").slice(0, 64);
}

function importantFromLabels(labels: string[]): boolean {
  return labels.map(normalizedLabel).some((label) => (
    label === "important"
    || label === "priority"
    || label === "urgent"
    || label === "action-required"
    || label === "follow-up"
    || label === "security"
    || label === "customer"
  ));
}

function truncate(value: string | null | undefined, limit: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, "").trim()}...`;
}

function sourceRows(window: EmailDigestWindow, limit: number, db: Database): DigestSourceEmail[] {
  const rows = db.query(
    `SELECT e.id,
            e.from_address,
            e.to_addresses,
            e.subject,
            e.received_at,
            e.is_read,
            e.is_starred,
            e.is_archived,
            e.label_ids_json,
            substr(COALESCE(NULLIF(e.text_body, ''), e.html_body, ''), 1, ?) AS body_excerpt,
            (
              SELECT r.category
                FROM email_agent_runs r
               WHERE r.inbound_email_id = e.id AND r.status = 'ok'
               ORDER BY CASE r.agent_key WHEN 'categorizer' THEN 0 WHEN 'labeler' THEN 1 ELSE 2 END,
                        r.completed_at DESC
               LIMIT 1
            ) AS agent_category,
            (
              SELECT r.labels_json
                FROM email_agent_runs r
               WHERE r.inbound_email_id = e.id AND r.status = 'ok'
               ORDER BY CASE r.agent_key WHEN 'categorizer' THEN 0 WHEN 'labeler' THEN 1 ELSE 2 END,
                        r.completed_at DESC
               LIMIT 1
            ) AS agent_labels_json,
            (
              SELECT r.priority
                FROM email_agent_runs r
               WHERE r.inbound_email_id = e.id AND r.status = 'ok' AND r.priority IS NOT NULL
               ORDER BY r.priority ASC, r.completed_at DESC
               LIMIT 1
            ) AS agent_priority,
            (
              SELECT r.risk_score
                FROM email_agent_runs r
               WHERE r.inbound_email_id = e.id AND r.status = 'ok' AND r.risk_score IS NOT NULL
               ORDER BY r.risk_score DESC, r.completed_at DESC
               LIMIT 1
            ) AS agent_risk_score,
            (
              SELECT r.summary
                FROM email_agent_runs r
               WHERE r.inbound_email_id = e.id
                 AND r.status = 'ok'
                 AND TRIM(COALESCE(r.summary, '')) != ''
               ORDER BY CASE r.agent_key WHEN 'categorizer' THEN 0 WHEN 'labeler' THEN 1 ELSE 2 END,
                        r.completed_at DESC
               LIMIT 1
            ) AS agent_summary
       FROM inbound_emails e
      WHERE e.is_sent = 0
        AND e.received_at >= ?
        AND e.received_at < ?
      ORDER BY e.received_at DESC, e.created_at DESC
      LIMIT ?`,
  ).all(MAX_BODY_EXCERPT_CHARS, window.since, window.until, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const labels = parseJsonArray<string>(row.label_ids_json as string | null | undefined);
    return {
      id: row.id as string,
      from_address: (row.from_address as string) || "",
      to_addresses: parseJsonArray<string>(row.to_addresses as string | null | undefined),
      subject: (row.subject as string) || "(no subject)",
      received_at: row.received_at as string,
      is_read: !!row.is_read,
      is_starred: !!row.is_starred,
      is_archived: !!row.is_archived,
      labels,
      body_excerpt: truncate(row.body_excerpt as string | null | undefined, MAX_BODY_EXCERPT_CHARS),
      agent_category: (row.agent_category as string) || null,
      agent_labels: parseJsonArray<string>(row.agent_labels_json as string | null | undefined),
      agent_priority: row.agent_priority == null ? null : Number(row.agent_priority),
      agent_risk_score: row.agent_risk_score == null ? null : Number(row.agent_risk_score),
      agent_summary: (row.agent_summary as string) || null,
    };
  });
}

function countLabels(emails: DigestSourceEmail[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const email of emails) {
    for (const raw of [...email.labels, ...email.agent_labels, email.agent_category ?? ""]) {
      const label = normalizedLabel(raw);
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function localImportantEmailIds(emails: DigestSourceEmail[]): string[] {
  return emails
    .filter((email) => email.is_starred || importantFromLabels([...email.labels, ...email.agent_labels, email.agent_category ?? ""]) || (email.agent_priority != null && email.agent_priority <= 2))
    .slice(0, 30)
    .map((email) => email.id);
}

function localDigestOutput(emails: DigestSourceEmail[], window: EmailDigestWindow): DigestOutput {
  const unread = emails.filter((email) => !email.is_read).length;
  const important = localImportantEmailIds(emails);
  const labelCounts = countLabels(emails);
  const topLabels = Object.entries(labelCounts).slice(0, 4).map(([label, count]) => `${label} (${count})`);
  const summary = emails.length
    ? `${emailDigestPeriodLabel(window.period)} has ${emails.length} inbound message${emails.length === 1 ? "" : "s"}, ${unread} unread, and ${important.length} marked important${topLabels.length ? `. Top labels: ${topLabels.join(", ")}` : ""}.`
    : `${emailDigestPeriodLabel(window.period)} has no inbound messages in this local store.`;
  const highlights = emails.slice(0, 6).map((email) => {
    const from = email.from_address.replace(/\s+/g, " ").trim() || "unknown sender";
    const summaryText = email.agent_summary ? `: ${truncate(email.agent_summary, 140)}` : "";
    return `${from} - ${email.subject}${summaryText}`;
  });
  const actionItems = emails
    .filter((email) => !email.is_read || important.includes(email.id))
    .slice(0, 6)
    .map((email) => `${email.subject} from ${email.from_address}`);
  return {
    summary,
    highlights,
    action_items: actionItems,
    important_email_ids: important,
  };
}

function filterKnownIds(ids: string[], emails: DigestSourceEmail[]): string[] {
  const known = new Set(emails.map((email) => email.id));
  return [...new Set(ids.filter((id) => known.has(id)))];
}

function saveDigestFromOutput(input: {
  window: EmailDigestWindow;
  provider: "local";
  model: string;
  emails: DigestSourceEmail[];
  output: DigestOutput;
  startedAt: string;
  status?: "ok" | "error";
  error?: string | null;
}, db: Database): EmailDigest {
  return saveEmailDigest({
    period: input.window.period,
    since: input.window.since,
    until: input.window.until,
    provider: input.provider,
    model: input.model,
    status: input.status ?? "ok",
    message_count: input.emails.length,
    summary: input.output.summary,
    highlights: input.output.highlights,
    action_items: input.output.action_items,
    important_email_ids: filterKnownIds(input.output.important_email_ids, input.emails),
    label_counts: countLabels(input.emails),
    error: input.error ?? null,
    started_at: input.startedAt,
    completed_at: now(),
  }, db);
}

export async function generateEmailDigest(
  periodOrOptions: EmailDigestPeriod | string | GenerateEmailDigestOptions = "today",
  optsOrDeps: GenerateEmailDigestOptions = {},
): Promise<EmailDigest> {
  const opts = typeof periodOrOptions === "object"
    ? periodOrOptions
    : { ...(optsOrDeps as GenerateEmailDigestOptions), period: periodOrOptions };
  const db = opts.db || getDatabase();
  const window = resolveEmailDigestWindow(opts.period, opts.now);
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_DIGEST_EMAILS, 500));
  const emails = sourceRows(window, limit, db);
  const startedAt = now();

  return saveDigestFromOutput({
    window,
    provider: "local",
    model: "local-emails-digest",
    emails,
    output: localDigestOutput(emails, window),
    startedAt,
  }, db);
}

export async function loadEmailDigest(
  periodOrOptions: EmailDigestPeriod | string | LoadEmailDigestOptions = "today",
  optsOrDeps: LoadEmailDigestOptions = {},
): Promise<EmailDigest> {
  const opts = typeof periodOrOptions === "object"
    ? periodOrOptions
    : { ...(optsOrDeps as LoadEmailDigestOptions), period: periodOrOptions };
  const db = opts.db || getDatabase();
  const period = normalizeEmailDigestPeriod(typeof opts.period === "string" ? opts.period : opts.period ?? "today");
  if (!opts.fresh) {
    const latest = getLatestEmailDigest(period, db);
    if (latest) return latest;
  }
  return generateEmailDigest({ ...opts, period });
}

export function formatEmailDigest(digest: EmailDigest): string {
  const lines = [
    `${emailDigestPeriodLabel(digest.period)} digest`,
    `  window: ${digest.since} to ${digest.until}`,
    `  messages: ${digest.message_count}`,
    `  provider: ${digest.provider} ${digest.model}`,
    "",
    `Summary: ${digest.summary ?? "(no summary)"}`,
  ];
  if (digest.highlights.length) {
    lines.push("", "Highlights:");
    for (const item of digest.highlights) lines.push(`- ${item}`);
  }
  if (digest.action_items.length) {
    lines.push("", "Action items:");
    for (const item of digest.action_items) lines.push(`- ${item}`);
  }
  if (digest.important_email_ids.length) {
    lines.push("", `Important email ids: ${digest.important_email_ids.join(", ")}`);
  }
  return lines.join("\n");
}
