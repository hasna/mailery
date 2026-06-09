import type { Database } from "./database.js";
import { getDatabase } from "./database.js";
import { parseJsonObject } from "./json.js";

export interface EmailContent {
  email_id: string;
  html: string | null;
  text_body: string | null;
  headers: Record<string, string>;
}

interface EmailContentRow {
  email_id: string;
  html: string | null;
  text_body: string | null;
  headers_json: string;
}

export function storeEmailContent(
  emailId: string,
  content: { html?: string; text?: string; headers?: Record<string, string> },
  db?: Database,
): void {
  const d = db || getDatabase();
  d.run(
    `INSERT OR REPLACE INTO email_content (email_id, html, text_body, headers_json)
     VALUES (?, ?, ?, ?)`,
    [
      emailId,
      content.html || null,
      content.text || null,
      JSON.stringify(content.headers || {}),
    ],
  );
}

export function getEmailContent(
  emailId: string,
  db?: Database,
): EmailContent | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM email_content WHERE email_id = ?")
    .get(emailId) as EmailContentRow | null;
  if (!row) return null;
  return {
    email_id: row.email_id,
    html: row.html,
    text_body: row.text_body,
    headers: parseJsonObject<Record<string, string>>(row.headers_json),
  };
}
