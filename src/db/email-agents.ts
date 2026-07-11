import type { Database } from "./database.js";
import { getDatabase, now, uuid } from "./database.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { cappedLimit, safeOffset } from "./pagination.js";

export type EmailAgentKey = "categorizer" | "labeler" | "fraud";
export type EmailAgentProvider = "external";
export type EmailAgentRunStatus = "ok" | "error" | "skipped";

export interface EmailAgentDefinition {
  key: EmailAgentKey;
  name: string;
  description: string;
  defaultModel: string;
  appliesLabels: boolean;
  investigatesDomains: boolean;
}

export interface EmailAgentSetting {
  agent_key: EmailAgentKey;
  enabled: boolean;
  always_on: boolean;
  provider: EmailAgentProvider;
  model: string | null;
  apply_labels: boolean;
  use_network_tools: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SaveEmailAgentSettingInput {
  enabled?: boolean;
  always_on?: boolean;
  provider?: EmailAgentProvider;
  model?: string | null;
  apply_labels?: boolean;
  use_network_tools?: boolean;
  config?: Record<string, unknown>;
}

export interface EmailAgentRun {
  id: string;
  agent_key: EmailAgentKey;
  inbound_email_id: string;
  provider: EmailAgentProvider;
  model: string;
  status: EmailAgentRunStatus;
  category: string | null;
  labels: string[];
  priority: number | null;
  confidence: number | null;
  risk_score: number | null;
  summary: string | null;
  reasoning: string | null;
  tool_calls: string[];
  output: Record<string, unknown>;
  error: string | null;
  started_at: string;
  completed_at: string;
  created_at: string;
}

export interface SaveEmailAgentRunInput {
  agent_key: EmailAgentKey;
  inbound_email_id: string;
  provider: EmailAgentProvider;
  model: string;
  status: EmailAgentRunStatus;
  category?: string | null;
  labels?: string[];
  priority?: number | null;
  confidence?: number | null;
  risk_score?: number | null;
  summary?: string | null;
  reasoning?: string | null;
  tool_calls?: string[];
  output?: Record<string, unknown>;
  error?: string | null;
  started_at?: string;
  completed_at?: string;
}

export interface EmailAgentRunFilter {
  agent_key?: EmailAgentKey;
  inbound_email_id?: string;
  status?: EmailAgentRunStatus;
  limit?: number;
  offset?: number;
}

export interface PendingAgentEmail {
  id: string;
  from_address: string;
  subject: string;
  created_at: string;
  received_at: string;
}

export const EMAIL_AGENT_DEFINITIONS: EmailAgentDefinition[] = [
  {
    key: "categorizer",
    name: "Categorizer",
    description: "Classifies each inbound email into a useful category, priority, and short summary.",
    defaultModel: "external-summary",
    appliesLabels: false,
    investigatesDomains: false,
  },
  {
    key: "labeler",
    name: "Labeler",
    description: "Applies concise local labels to each inbound email for mailbox organization.",
    defaultModel: "external-summary",
    appliesLabels: true,
    investigatesDomains: false,
  },
  {
    key: "fraud",
    name: "Fraud Investigator",
    description: "Checks sender/link domains with read-only investigation tools and scores fraud risk.",
    defaultModel: "external-summary",
    appliesLabels: true,
    investigatesDomains: true,
  },
];

const MAX_AGENT_RUN_LIST_LIMIT = 500;
const MAX_PENDING_LIMIT = 500;

function assertAgentKey(value: string): asserts value is EmailAgentKey {
  if (!EMAIL_AGENT_DEFINITIONS.some((agent) => agent.key === value)) {
    throw new Error(`Unknown email agent "${value}". Use one of: ${EMAIL_AGENT_DEFINITIONS.map((agent) => agent.key).join(", ")}`);
  }
}

export function normalizeEmailAgentKey(value: string): EmailAgentKey {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, EmailAgentKey> = {
    category: "categorizer",
    classify: "categorizer",
    classifier: "categorizer",
    categories: "categorizer",
    labels: "labeler",
    label: "labeler",
    fraud: "fraud",
    risk: "fraud",
    security: "fraud",
  };
  const key = aliases[normalized] ?? normalized;
  assertAgentKey(key);
  return key;
}

export function getEmailAgentDefinition(agentKey: EmailAgentKey): EmailAgentDefinition {
  return EMAIL_AGENT_DEFINITIONS.find((agent) => agent.key === agentKey)!;
}

function rowToSetting(row: Record<string, unknown>): EmailAgentSetting {
  const agentKey = row.agent_key as string;
  assertAgentKey(agentKey);
  return {
    agent_key: agentKey,
    enabled: !!row.enabled,
    always_on: !!row.always_on,
    provider: row.provider as EmailAgentProvider,
    model: (row.model as string) || null,
    apply_labels: !!row.apply_labels,
    use_network_tools: !!row.use_network_tools,
    config: parseJsonObject(row.config_json as string | null | undefined),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToRun(row: Record<string, unknown>): EmailAgentRun {
  const agentKey = row.agent_key as string;
  assertAgentKey(agentKey);
  return {
    id: row.id as string,
    agent_key: agentKey,
    inbound_email_id: row.inbound_email_id as string,
    provider: row.provider as EmailAgentProvider,
    model: row.model as string,
    status: row.status as EmailAgentRunStatus,
    category: (row.category as string) || null,
    labels: parseJsonArray<string>(row.labels_json as string | null | undefined),
    priority: row.priority == null ? null : Number(row.priority),
    confidence: row.confidence == null ? null : Number(row.confidence),
    risk_score: row.risk_score == null ? null : Number(row.risk_score),
    summary: (row.summary as string) || null,
    reasoning: (row.reasoning as string) || null,
    tool_calls: parseJsonArray<string>(row.tool_calls_json as string | null | undefined),
    output: parseJsonObject(row.output_json as string | null | undefined),
    error: (row.error as string) || null,
    started_at: row.started_at as string,
    completed_at: row.completed_at as string,
    created_at: row.created_at as string,
  };
}

export function ensureEmailAgentSettings(db?: Database): EmailAgentSetting[] {
  const d = db || getDatabase();
  const timestamp = now();
  for (const agent of EMAIL_AGENT_DEFINITIONS) {
    d.run(
      `INSERT OR IGNORE INTO email_agent_settings
       (agent_key, enabled, always_on, provider, model, apply_labels, use_network_tools, config_json, created_at, updated_at)
       VALUES (?, 0, 0, 'external', ?, ?, 1, '{}', ?, ?)`,
      [agent.key, agent.defaultModel, agent.appliesLabels ? 1 : 0, timestamp, timestamp],
    );
  }
  return listEmailAgentSettings(d);
}

export function listEmailAgentSettings(db?: Database): EmailAgentSetting[] {
  const d = db || getDatabase();
  ensureEmailAgentSettingsRowsOnly(d);
  const rows = d
    .query("SELECT * FROM email_agent_settings ORDER BY agent_key ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToSetting);
}

export function getEmailAgentSetting(agentKey: EmailAgentKey, db?: Database): EmailAgentSetting {
  const d = db || getDatabase();
  ensureEmailAgentSettingsRowsOnly(d);
  const row = d
    .query("SELECT * FROM email_agent_settings WHERE agent_key = ? LIMIT 1")
    .get(agentKey) as Record<string, unknown> | null;
  if (!row) throw new Error(`Email agent setting missing: ${agentKey}`);
  return rowToSetting(row);
}

export function updateEmailAgentSetting(agentKey: EmailAgentKey, input: SaveEmailAgentSettingInput, db?: Database): EmailAgentSetting {
  const d = db || getDatabase();
  ensureEmailAgentSettingsRowsOnly(d);
  const current = getEmailAgentSetting(agentKey, d);
  const next = {
    enabled: input.enabled ?? current.enabled,
    always_on: input.always_on ?? current.always_on,
    provider: input.provider ?? current.provider,
    model: input.model === undefined ? current.model : input.model,
    apply_labels: input.apply_labels ?? current.apply_labels,
    use_network_tools: input.use_network_tools ?? current.use_network_tools,
    config: input.config ? { ...current.config, ...input.config } : current.config,
  };
  d.run(
    `UPDATE email_agent_settings
        SET enabled = ?,
            always_on = ?,
            provider = ?,
            model = ?,
            apply_labels = ?,
            use_network_tools = ?,
            config_json = ?,
            updated_at = ?
      WHERE agent_key = ?`,
    [
      next.enabled ? 1 : 0,
      next.always_on ? 1 : 0,
      next.provider,
      next.model,
      next.apply_labels ? 1 : 0,
      next.use_network_tools ? 1 : 0,
      JSON.stringify(next.config),
      now(),
      agentKey,
    ],
  );
  return getEmailAgentSetting(agentKey, d);
}

export function listEnabledAlwaysOnEmailAgents(db?: Database): EmailAgentSetting[] {
  return listEmailAgentSettings(db).filter((setting) => setting.enabled && setting.always_on);
}

export function saveEmailAgentRun(input: SaveEmailAgentRunInput, db?: Database): EmailAgentRun {
  const d = db || getDatabase();
  const startedAt = input.started_at ?? now();
  const completedAt = input.completed_at ?? now();
  const id = uuid();
  d.run(
    `INSERT INTO email_agent_runs
       (id, agent_key, inbound_email_id, provider, model, status, category, labels_json,
        priority, confidence, risk_score, summary, reasoning, tool_calls_json, output_json,
        error, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_key, inbound_email_id) DO UPDATE SET
       id = excluded.id,
       provider = excluded.provider,
       model = excluded.model,
       status = excluded.status,
       category = excluded.category,
       labels_json = excluded.labels_json,
       priority = excluded.priority,
       confidence = excluded.confidence,
       risk_score = excluded.risk_score,
       summary = excluded.summary,
       reasoning = excluded.reasoning,
       tool_calls_json = excluded.tool_calls_json,
       output_json = excluded.output_json,
       error = excluded.error,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at`,
    [
      id,
      input.agent_key,
      input.inbound_email_id,
      input.provider,
      input.model,
      input.status,
      input.category ?? null,
      JSON.stringify(normalizeLabels(input.labels ?? [])),
      input.priority ?? null,
      input.confidence ?? null,
      input.risk_score ?? null,
      input.summary ?? null,
      input.reasoning ?? null,
      JSON.stringify(input.tool_calls ?? []),
      JSON.stringify(input.output ?? {}),
      input.error ?? null,
      startedAt,
      completedAt,
      completedAt,
    ],
  );
  return getEmailAgentRun(input.agent_key, input.inbound_email_id, d)!;
}

export function getEmailAgentRun(agentKey: EmailAgentKey, inboundEmailId: string, db?: Database): EmailAgentRun | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM email_agent_runs WHERE agent_key = ? AND inbound_email_id = ? LIMIT 1")
    .get(agentKey, inboundEmailId) as Record<string, unknown> | null;
  return row ? rowToRun(row) : null;
}

export function listEmailAgentRuns(filter: EmailAgentRunFilter = {}, db?: Database): EmailAgentRun[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: string[] = [];
  if (filter.agent_key) {
    conditions.push("agent_key = ?");
    params.push(filter.agent_key);
  }
  if (filter.inbound_email_id) {
    conditions.push("inbound_email_id = ?");
    params.push(filter.inbound_email_id);
  }
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = d
    .query(`SELECT * FROM email_agent_runs ${where} ORDER BY completed_at DESC LIMIT ? OFFSET ?`)
    .all(...params, cappedLimit(filter.limit, 50, MAX_AGENT_RUN_LIST_LIMIT), safeOffset(filter.offset)) as Record<string, unknown>[];
  return rows.map(rowToRun);
}

export function listPendingInboundEmailsForAgent(agentKey: EmailAgentKey, limit = 50, db?: Database): PendingAgentEmail[] {
  const d = db || getDatabase();
  const normalizedLimit = cappedLimit(limit, 50, MAX_PENDING_LIMIT);
  return d
    .query(
      `SELECT e.id, e.from_address, e.subject, e.created_at, e.received_at
         FROM inbound_emails e
         LEFT JOIN email_agent_runs r
           ON r.inbound_email_id = e.id
          AND r.agent_key = ?
        WHERE e.is_sent = 0
          AND (r.id IS NULL OR r.status = 'error')
        ORDER BY e.created_at ASC, e.received_at ASC
        LIMIT ?`,
    )
    .all(agentKey, normalizedLimit) as PendingAgentEmail[];
}

function ensureEmailAgentSettingsRowsOnly(db: Database): void {
  const timestamp = now();
  for (const agent of EMAIL_AGENT_DEFINITIONS) {
    db.run(
      `INSERT OR IGNORE INTO email_agent_settings
       (agent_key, enabled, always_on, provider, model, apply_labels, use_network_tools, config_json, created_at, updated_at)
       VALUES (?, 0, 0, 'external', ?, ?, 1, '{}', ?, ?)`,
      [agent.key, agent.defaultModel, agent.appliesLabels ? 1 : 0, timestamp, timestamp],
    );
  }
}

function normalizeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    const value = label.trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9:-]/g, "").slice(0, 64);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}
