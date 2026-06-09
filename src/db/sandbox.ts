import type { Database } from "./database.js";
import type { Attachment } from "../types/index.js";
import { getDatabase, uuid } from "./database.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { safeLimit, safeOffset } from "./pagination.js";

export interface SandboxEmail {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments: Attachment[];
  headers: Record<string, string>;
  created_at: string;
}

export type SandboxEmailSummary = Omit<SandboxEmail, "html" | "text_body" | "headers">;

interface SandboxEmailRow {
  id: string;
  provider_id: string;
  from_address: string;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments_json: string;
  headers_json: string;
  created_at: string;
}

type SandboxEmailSummaryRow = Omit<SandboxEmailRow, "html" | "text_body" | "headers_json">;

const SANDBOX_SUMMARY_COLS = `
  id,
  provider_id,
  from_address,
  to_addresses,
  cc_addresses,
  bcc_addresses,
  reply_to,
  subject,
  attachments_json,
  created_at
`;

function rowToEmail(row: SandboxEmailRow): SandboxEmail {
  return {
    id: row.id,
    provider_id: row.provider_id,
    from_address: row.from_address,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    bcc_addresses: parseJsonArray<string>(row.bcc_addresses),
    reply_to: row.reply_to,
    subject: row.subject,
    html: row.html,
    text_body: row.text_body,
    attachments: parseJsonArray<Attachment>(row.attachments_json),
    headers: parseJsonObject<Record<string, string>>(row.headers_json),
    created_at: row.created_at,
  };
}

function rowToEmailSummary(row: SandboxEmailSummaryRow): SandboxEmailSummary {
  return {
    id: row.id,
    provider_id: row.provider_id,
    from_address: row.from_address,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    bcc_addresses: parseJsonArray<string>(row.bcc_addresses),
    reply_to: row.reply_to,
    subject: row.subject,
    attachments: parseJsonArray<Attachment>(row.attachments_json),
    created_at: row.created_at,
  };
}

export interface StoreSandboxEmailInput {
  provider_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  reply_to: string | null;
  subject: string;
  html: string | null;
  text_body: string | null;
  attachments: Attachment[];
  headers: Record<string, string>;
}

export function storeSandboxEmail(input: StoreSandboxEmailInput, db?: Database): SandboxEmail {
  const d = db || getDatabase();
  const id = uuid();

  d.run(
    `INSERT INTO sandbox_emails (id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses,
       reply_to, subject, html, text_body, attachments_json, headers_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.provider_id,
      input.from_address,
      JSON.stringify(input.to_addresses),
      JSON.stringify(input.cc_addresses),
      JSON.stringify(input.bcc_addresses),
      input.reply_to,
      input.subject,
      input.html,
      input.text_body,
      JSON.stringify(input.attachments),
      JSON.stringify(input.headers),
    ],
  );

  const row = d.query("SELECT * FROM sandbox_emails WHERE id = ?").get(id) as SandboxEmailRow;
  return rowToEmail(row);
}

export function listSandboxEmails(
  providerId?: string,
  limit = 50,
  dbOrOffset?: Database | number,
  maybeDb?: Database,
): SandboxEmail[] {
  const rawOffset = typeof dbOrOffset === "number" ? dbOrOffset : 0;
  const normalizedLimit = safeLimit(limit);
  const offset = safeOffset(rawOffset);
  const d = typeof dbOrOffset === "number"
    ? (maybeDb || getDatabase())
    : (dbOrOffset || getDatabase());

  let rows: SandboxEmailRow[];
  if (providerId) {
    rows = d.query(
      "SELECT * FROM sandbox_emails WHERE provider_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ).all(providerId, normalizedLimit, offset) as SandboxEmailRow[];
  } else {
    rows = d.query(
      "SELECT * FROM sandbox_emails ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ).all(normalizedLimit, offset) as SandboxEmailRow[];
  }
  return rows.map(rowToEmail);
}

export function listSandboxEmailSummaries(
  providerId?: string,
  limit = 50,
  dbOrOffset?: Database | number,
  maybeDb?: Database,
): SandboxEmailSummary[] {
  const rawOffset = typeof dbOrOffset === "number" ? dbOrOffset : 0;
  const normalizedLimit = safeLimit(limit);
  const offset = safeOffset(rawOffset);
  const d = typeof dbOrOffset === "number"
    ? (maybeDb || getDatabase())
    : (dbOrOffset || getDatabase());

  let rows: SandboxEmailSummaryRow[];
  if (providerId) {
    rows = d.query(
      `SELECT ${SANDBOX_SUMMARY_COLS} FROM sandbox_emails WHERE provider_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(providerId, normalizedLimit, offset) as SandboxEmailSummaryRow[];
  } else {
    rows = d.query(
      `SELECT ${SANDBOX_SUMMARY_COLS} FROM sandbox_emails ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(normalizedLimit, offset) as SandboxEmailSummaryRow[];
  }
  return rows.map(rowToEmailSummary);
}

export function getSandboxEmail(id: string, db?: Database): SandboxEmail | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM sandbox_emails WHERE id = ?").get(id) as SandboxEmailRow | null;
  if (!row) return null;
  return rowToEmail(row);
}

export function clearSandboxEmails(providerId?: string, db?: Database): number {
  const d = db || getDatabase();
  let result: { changes: number };
  if (providerId) {
    result = d.run("DELETE FROM sandbox_emails WHERE provider_id = ?", [providerId]);
  } else {
    result = d.run("DELETE FROM sandbox_emails");
  }
  return result.changes;
}

export function getSandboxCount(providerId?: string, db?: Database): number {
  const d = db || getDatabase();
  let row: { count: number } | null;
  if (providerId) {
    row = d.query("SELECT COUNT(*) as count FROM sandbox_emails WHERE provider_id = ?").get(providerId) as { count: number } | null;
  } else {
    row = d.query("SELECT COUNT(*) as count FROM sandbox_emails").get() as { count: number } | null;
  }
  return row?.count ?? 0;
}
