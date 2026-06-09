import type { Database } from "./database.js";
import type { SQLQueryBindings } from "bun:sqlite";
import type { EmailEvent, EventFilter, EventRow, EventSummary, EventType } from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { parseJsonObject } from "./json.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

const EVENT_COLUMNS = [
  "id",
  "email_id",
  "provider_id",
  "provider_event_id",
  "type",
  "recipient",
  "metadata",
  "occurred_at",
  "created_at",
].join(", ");

const EVENT_SUMMARY_COLUMNS = [
  "id",
  "email_id",
  "provider_id",
  "provider_event_id",
  "type",
  "recipient",
  "occurred_at",
  "created_at",
].join(", ");

type EventSummaryRow = Omit<EventRow, "metadata">;

function rowToEvent(row: EventRow): EmailEvent {
  return {
    ...row,
    metadata: parseJsonObject(row.metadata),
    type: row.type as EventType,
  };
}

function rowToEventSummary(row: EventSummaryRow): EventSummary {
  return {
    ...row,
    type: row.type as EventType,
  };
}

export interface CreateEventInput {
  email_id?: string | null;
  provider_id: string;
  provider_event_id?: string | null;
  type: EventType;
  recipient?: string | null;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

function eventFromInput(id: string, timestamp: string, input: CreateEventInput): EmailEvent {
  return {
    id,
    email_id: input.email_id || null,
    provider_id: input.provider_id,
    provider_event_id: input.provider_event_id || null,
    type: input.type,
    recipient: input.recipient || null,
    metadata: input.metadata || {},
    occurred_at: input.occurred_at,
    created_at: timestamp,
  };
}

export function createEvent(input: CreateEventInput, db?: Database): EmailEvent {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();
  const event = eventFromInput(id, timestamp, input);

  d.run(
    `INSERT INTO events (id, email_id, provider_id, provider_event_id, type, recipient, metadata, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      event.email_id,
      event.provider_id,
      event.provider_event_id,
      event.type,
      event.recipient,
      JSON.stringify(event.metadata),
      event.occurred_at,
      timestamp,
    ],
  );

  return event;
}

export function listEvents(filter: EventFilter = {}, db?: Database): EmailEvent[] {
  const rows = selectEventRows(filter, EVENT_COLUMNS, db) as EventRow[];
  return rows.map(rowToEvent);
}

export function listEventSummaries(filter: EventFilter = {}, db?: Database): EventSummary[] {
  const rows = selectEventRows(filter, EVENT_SUMMARY_COLUMNS, db) as EventSummaryRow[];
  return rows.map(rowToEventSummary);
}

function selectEventRows(filter: EventFilter = {}, columns: string, db?: Database): EventRow[] | EventSummaryRow[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.email_id) {
    conditions.push("email_id = ?");
    params.push(filter.email_id);
  }

  if (filter.provider_id) {
    conditions.push("provider_id = ?");
    params.push(filter.provider_id);
  }

  if (filter.type) {
    if (Array.isArray(filter.type)) {
      conditions.push(`type IN (${filter.type.map(() => "?").join(",")})`);
      params.push(...filter.type);
    } else {
      conditions.push("type = ?");
      params.push(filter.type);
    }
  }

  if (filter.since) {
    conditions.push("occurred_at >= ?");
    params.push(filter.since);
  }

  if (filter.until) {
    conditions.push("occurred_at <= ?");
    params.push(filter.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let limitClause = "";
  const limit = safeOptionalLimit(filter.limit);
  if (limit !== null) {
    limitClause = " LIMIT ?";
    params.push(limit);
    limitClause += " OFFSET ?";
    params.push(safeOffset(filter.offset));
  }

  const rows = d
    .query(`SELECT ${columns} FROM events ${where} ORDER BY occurred_at DESC${limitClause}`)
    .all(...params) as EventRow[] | EventSummaryRow[];

  return rows;
}

export function getEvent(id: string, db?: Database): EmailEvent | null {
  const d = db || getDatabase();
  const row = d.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`).get(id) as EventRow | null;
  return row ? rowToEvent(row) : null;
}

export function getEventsByEmail(email_id: string, db?: Database): EmailEvent[] {
  return listEvents({ email_id }, db);
}

export function upsertEvent(input: CreateEventInput, db?: Database): EmailEvent {
  return upsertEventWithResult(input, db).event;
}

export function upsertEventWithResult(input: CreateEventInput, db?: Database): { event: EmailEvent; created: boolean } {
  const d = db || getDatabase();

  if (input.provider_event_id) {
    const id = uuid();
    const timestamp = now();
    const event = eventFromInput(id, timestamp, input);
    const result = d.run(
      `INSERT OR IGNORE INTO events
         (id, email_id, provider_id, provider_event_id, type, recipient, metadata, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        event.email_id,
        event.provider_id,
        event.provider_event_id,
        event.type,
        event.recipient,
        JSON.stringify(event.metadata),
        event.occurred_at,
        timestamp,
      ],
    );

    if (result.changes > 0) return { event, created: true };

    const existing = d.query(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE provider_id = ? AND provider_event_id = ?`,
    ).get(input.provider_id, input.provider_event_id) as EventRow | null;
    if (existing) {
      return { event: rowToEvent(existing), created: false };
    }
  }

  return { event: createEvent(input, d), created: true };
}
