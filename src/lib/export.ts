import { listEmails } from "../db/emails.js";
import { listEvents } from "../db/events.js";
import type { Database } from "../db/database.js";
import type { EventType } from "../types/index.js";

export const EXPORT_DEFAULT_LIMIT = 1000;
export const EXPORT_MAX_LIMIT = 10000;

export interface EmailExportFilters {
  provider_id?: string;
  from_address?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface EventExportFilters {
  provider_id?: string;
  type?: EventType;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

function boundedPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.trunc(value));
}

function nonNegativeInt(value: number | undefined): number {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function normalizeEmailFilters(filters: EmailExportFilters): EmailExportFilters {
  return {
    ...filters,
    limit: boundedPositiveInt(filters.limit, EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT),
    offset: nonNegativeInt(filters.offset),
  };
}

function normalizeEventFilters(filters: EventExportFilters): EventExportFilters {
  return {
    ...filters,
    limit: boundedPositiveInt(filters.limit, EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT),
    offset: nonNegativeInt(filters.offset),
  };
}

function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportEmailsCsv(filters: EmailExportFilters, db?: Database): string {
  const emails = listEmails(normalizeEmailFilters(filters), db);
  const header = "id,from,to,subject,status,sent_at";
  const rows = emails.map(e =>
    [e.id, e.from_address, e.to_addresses, e.subject, e.status, e.sent_at].map(csvCell).join(",")
  );
  return [header, ...rows].join("\n");
}

export function exportEmailsJson(filters: EmailExportFilters, db?: Database): string {
  return JSON.stringify(listEmails(normalizeEmailFilters(filters), db), null, 2);
}

export function exportEventsCsv(filters: EventExportFilters, db?: Database): string {
  const events = listEvents(normalizeEventFilters(filters), db);
  const header = "id,email_id,type,recipient,occurred_at";
  const rows = events.map(e => [e.id, e.email_id || "", e.type, e.recipient || "", e.occurred_at].map(csvCell).join(","));
  return [header, ...rows].join("\n");
}

export function exportEventsJson(filters: EventExportFilters, db?: Database): string {
  return JSON.stringify(listEvents(normalizeEventFilters(filters), db), null, 2);
}
