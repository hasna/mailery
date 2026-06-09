import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";
import { parseJsonObject } from "./json.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

export interface Template {
  id: string;
  name: string;
  subject_template: string;
  html_template: string | null;
  text_template: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type TemplateSummary = Omit<Template, "html_template" | "text_template"> & {
  has_html_template: boolean;
  has_text_template: boolean;
};

export interface ListTemplateOptions {
  limit?: number;
  offset?: number;
}

interface TemplateRow {
  id: string;
  name: string;
  subject_template: string;
  html_template: string | null;
  text_template: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface TemplateSummaryRow {
  id: string;
  name: string;
  subject_template: string;
  metadata: string;
  has_html_template: number;
  has_text_template: number;
  created_at: string;
  updated_at: string;
}

const TEMPLATE_COLUMNS = [
  "id",
  "name",
  "subject_template",
  "html_template",
  "text_template",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const TEMPLATE_SUMMARY_COLUMNS = [
  "id",
  "name",
  "subject_template",
  "metadata",
  "(html_template IS NOT NULL AND html_template != '') AS has_html_template",
  "(text_template IS NOT NULL AND text_template != '') AS has_text_template",
  "created_at",
  "updated_at",
].join(", ");

function rowToTemplate(row: TemplateRow): Template {
  return {
    ...row,
    metadata: parseJsonObject(row.metadata),
  };
}

function rowToTemplateSummary(row: TemplateSummaryRow): TemplateSummary {
  return {
    id: row.id,
    name: row.name,
    subject_template: row.subject_template,
    metadata: parseJsonObject(row.metadata),
    has_html_template: Boolean(row.has_html_template),
    has_text_template: Boolean(row.has_text_template),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createTemplate(
  input: {
    name: string;
    subject_template: string;
    html_template?: string;
    text_template?: string;
  },
  db?: Database,
): Template {
  const d = db || getDatabase();
  const id = uuid();
  const timestamp = now();

  d.run(
    `INSERT INTO templates (id, name, subject_template, html_template, text_template, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
    [
      id,
      input.name,
      input.subject_template,
      input.html_template || null,
      input.text_template || null,
      timestamp,
      timestamp,
    ],
  );

  return getTemplate(id, d)!;
}

export function getTemplate(nameOrId: string, db?: Database): Template | null {
  const d = db || getDatabase();
  // Try by ID first, then by name
  let row = d.query(`SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = ?`).get(nameOrId) as TemplateRow | null;
  if (!row) {
    row = d.query(`SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE name = ?`).get(nameOrId) as TemplateRow | null;
  }
  if (!row) return null;
  return rowToTemplate(row);
}

export function getTemplateByName(name: string, db?: Database): Template | null {
  const d = db || getDatabase();
  const row = d.query(`SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE name = ?`).get(name) as TemplateRow | null;
  if (!row) return null;
  return rowToTemplate(row);
}

export function listTemplates(db?: Database, opts?: ListTemplateOptions): Template[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = limit !== null
    ? d.query(`SELECT ${TEMPLATE_COLUMNS} FROM templates ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as TemplateRow[]
    : d.query(`SELECT ${TEMPLATE_COLUMNS} FROM templates ORDER BY created_at DESC`).all() as TemplateRow[];
  return rows.map(rowToTemplate);
}

export function listTemplateSummaries(db?: Database, opts?: ListTemplateOptions): TemplateSummary[] {
  const d = db || getDatabase();
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  const rows = limit !== null
    ? d.query(`SELECT ${TEMPLATE_SUMMARY_COLUMNS} FROM templates ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as TemplateSummaryRow[]
    : d.query(`SELECT ${TEMPLATE_SUMMARY_COLUMNS} FROM templates ORDER BY created_at DESC`).all() as TemplateSummaryRow[];
  return rows.map(rowToTemplateSummary);
}

export function deleteTemplate(nameOrId: string, db?: Database): boolean {
  const d = db || getDatabase();
  // Try by ID first
  let result = d.run("DELETE FROM templates WHERE id = ?", [nameOrId]);
  if (result.changes > 0) return true;
  // Try by name
  result = d.run("DELETE FROM templates WHERE name = ?", [nameOrId]);
  return result.changes > 0;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });
}
