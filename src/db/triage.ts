import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";
import { safeLimit, safeOffset } from "./pagination.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TriageLabel = "action-required" | "fyi" | "urgent" | "follow-up" | "spam" | "newsletter" | "transactional";
export type TriageSentiment = "positive" | "negative" | "neutral";

export interface TriageResult {
  id: string;
  email_id: string | null;
  inbound_email_id: string | null;
  label: TriageLabel;
  priority: number;
  summary: string | null;
  sentiment: TriageSentiment | null;
  draft_reply: string | null;
  confidence: number;
  model: string | null;
  triaged_at: string;
  created_at: string;
}

export type TriageSummary = Omit<TriageResult, "draft_reply">;

export interface SaveTriageInput {
  email_id?: string | null;
  inbound_email_id?: string | null;
  label: TriageLabel;
  priority: number;
  summary?: string | null;
  sentiment?: TriageSentiment | null;
  draft_reply?: string | null;
  confidence?: number;
  model?: string | null;
}

export interface TriageFilter {
  label?: TriageLabel;
  priority?: number;
  sentiment?: TriageSentiment;
  limit?: number;
  offset?: number;
}

export interface TriageStats {
  total: number;
  by_label: Record<string, number>;
  by_priority: Record<number, number>;
  by_sentiment: Record<string, number>;
  avg_priority: number;
  avg_confidence: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rowToTriage(row: Record<string, unknown>): TriageResult {
  return {
    id: row.id as string,
    email_id: (row.email_id as string) || null,
    inbound_email_id: (row.inbound_email_id as string) || null,
    label: row.label as TriageLabel,
    priority: row.priority as number,
    summary: (row.summary as string) || null,
    sentiment: (row.sentiment as TriageSentiment) || null,
    draft_reply: (row.draft_reply as string) || null,
    confidence: (row.confidence as number) ?? 0,
    model: (row.model as string) || null,
    triaged_at: row.triaged_at as string,
    created_at: row.created_at as string,
  };
}

function rowToTriageSummary(row: Record<string, unknown>): TriageSummary {
  const { draft_reply: _draftReply, ...summary } = rowToTriage(row);
  return summary;
}

function triageWhere(filter?: TriageFilter): { where: string; params: (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter?.label) {
    conditions.push("label = ?");
    params.push(filter.label);
  }
  if (filter?.priority) {
    conditions.push("priority = ?");
    params.push(filter.priority);
  }
  if (filter?.sentiment) {
    conditions.push("sentiment = ?");
    params.push(filter.sentiment);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

const TRIAGE_SUMMARY_COLS = [
  "id",
  "email_id",
  "inbound_email_id",
  "label",
  "priority",
  "summary",
  "sentiment",
  "confidence",
  "model",
  "triaged_at",
  "created_at",
].join(", ");

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function saveTriage(input: SaveTriageInput, db?: Database): TriageResult {
  const d = db || getDatabase();
  const timestamp = now();

  if (!input.email_id && !input.inbound_email_id) {
    throw new Error("Either email_id or inbound_email_id must be provided");
  }

  // Upsert: delete existing triage for this email if any
  if (input.email_id) {
    d.run("DELETE FROM email_triage WHERE email_id = ?", [input.email_id]);
  }
  if (input.inbound_email_id) {
    d.run("DELETE FROM email_triage WHERE inbound_email_id = ?", [input.inbound_email_id]);
  }

  const id = uuid();
  d.run(
    `INSERT INTO email_triage (id, email_id, inbound_email_id, label, priority, summary, sentiment, draft_reply, confidence, model, triaged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.email_id || null,
      input.inbound_email_id || null,
      input.label,
      input.priority,
      input.summary || null,
      input.sentiment || null,
      input.draft_reply || null,
      input.confidence ?? 0,
      input.model || null,
      timestamp,
      timestamp,
    ],
  );

  return rowToTriage(
    d.query("SELECT * FROM email_triage WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

export function getTriage(
  emailId: string,
  type: "sent" | "inbound" = "sent",
  db?: Database,
): TriageResult | null {
  const d = db || getDatabase();
  const col = type === "inbound" ? "inbound_email_id" : "email_id";
  const row = d.query(`SELECT * FROM email_triage WHERE ${col} = ?`).get(emailId) as Record<string, unknown> | null;
  return row ? rowToTriage(row) : null;
}

export function getTriageById(id: string, db?: Database): TriageResult | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM email_triage WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? rowToTriage(row) : null;
}

export function listTriaged(filter?: TriageFilter, db?: Database): TriageResult[] {
  const d = db || getDatabase();
  const { where, params } = triageWhere(filter);
  const limit = safeLimit(filter?.limit);
  const offset = safeOffset(filter?.offset);

  const rows = d
    .query(`SELECT * FROM email_triage ${where} ORDER BY triaged_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToTriage);
}

export function listTriagedSummaries(filter?: TriageFilter, db?: Database): TriageSummary[] {
  const d = db || getDatabase();
  const { where, params } = triageWhere(filter);
  const limit = safeLimit(filter?.limit);
  const offset = safeOffset(filter?.offset);

  const rows = d
    .query(`SELECT ${TRIAGE_SUMMARY_COLS} FROM email_triage ${where} ORDER BY triaged_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToTriageSummary);
}

export function getUntriaged(
  type: "sent" | "inbound" = "sent",
  limit = 20,
  db?: Database,
): { id: string; subject: string; from_address: string }[] {
  const d = db || getDatabase();
  const normalizedLimit = safeLimit(limit, 20);

  if (type === "inbound") {
    return d
      .query(
        `SELECT ie.id, ie.subject, ie.from_address
         FROM inbound_emails ie
         LEFT JOIN email_triage t ON t.inbound_email_id = ie.id
         WHERE t.id IS NULL
         ORDER BY ie.received_at DESC
         LIMIT ?`,
      )
      .all(normalizedLimit) as { id: string; subject: string; from_address: string }[];
  }

  return d
    .query(
      `SELECT e.id, e.subject, e.from_address
       FROM emails e
       LEFT JOIN email_triage t ON t.email_id = e.id
       WHERE t.id IS NULL
       ORDER BY e.sent_at DESC
       LIMIT ?`,
    )
    .all(normalizedLimit) as { id: string; subject: string; from_address: string }[];
}

export function deleteTriage(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM email_triage WHERE id = ?", [id]);
  return result.changes > 0;
}

export function deleteTriageByEmail(emailId: string, type: "sent" | "inbound" = "sent", db?: Database): boolean {
  const d = db || getDatabase();
  const col = type === "inbound" ? "inbound_email_id" : "email_id";
  const result = d.run(`DELETE FROM email_triage WHERE ${col} = ?`, [emailId]);
  return result.changes > 0;
}

export function getTriageStats(db?: Database): TriageStats {
  const d = db || getDatabase();

  const total = (d.query("SELECT COUNT(*) as count FROM email_triage").get() as { count: number })?.count ?? 0;

  const labelRows = d.query("SELECT label, COUNT(*) as count FROM email_triage GROUP BY label").all() as { label: string; count: number }[];
  const by_label: Record<string, number> = {};
  for (const r of labelRows) by_label[r.label] = r.count;

  const priorityRows = d.query("SELECT priority, COUNT(*) as count FROM email_triage GROUP BY priority").all() as { priority: number; count: number }[];
  const by_priority: Record<number, number> = {};
  for (const r of priorityRows) by_priority[r.priority] = r.count;

  const sentimentRows = d.query("SELECT sentiment, COUNT(*) as count FROM email_triage WHERE sentiment IS NOT NULL GROUP BY sentiment").all() as { sentiment: string; count: number }[];
  const by_sentiment: Record<string, number> = {};
  for (const r of sentimentRows) by_sentiment[r.sentiment] = r.count;

  const avgRow = d.query("SELECT AVG(priority) as avg_p, AVG(confidence) as avg_c FROM email_triage").get() as { avg_p: number | null; avg_c: number | null } | null;

  return {
    total,
    by_label,
    by_priority,
    by_sentiment,
    avg_priority: avgRow?.avg_p ?? 0,
    avg_confidence: avgRow?.avg_c ?? 0,
  };
}

export function clearTriage(db?: Database): number {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM email_triage");
  return result.changes;
}
