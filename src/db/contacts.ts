import type { Database } from "./database.js";
import { getDatabase, uuid, now } from "./database.js";
import { safeOffset, safeOptionalLimit } from "./pagination.js";

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  complaint_count: number;
  last_sent_at: string | null;
  suppressed: boolean;
  created_at: string;
  updated_at: string;
}

interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  send_count: number;
  bounce_count: number;
  complaint_count: number;
  last_sent_at: string | null;
  suppressed: number;
  created_at: string;
  updated_at: string;
}

const CONTACT_READ_CHUNK_SIZE = 500;
const CONTACT_WRITE_CHUNK_SIZE = 200;
type ContactCountColumn = "send_count" | "bounce_count" | "complaint_count";

function rowToContact(row: ContactRow): Contact {
  return {
    ...row,
    suppressed: !!row.suppressed,
  };
}

export function upsertContact(email: string, db?: Database): Contact {
  const d = db || getDatabase();
  const existing = d.query("SELECT * FROM contacts WHERE email = ?").get(email) as ContactRow | null;
  if (existing) return rowToContact(existing);

  const id = uuid();
  const timestamp = now();
  d.run(
    `INSERT INTO contacts (id, email, name, send_count, bounce_count, complaint_count, last_sent_at, suppressed, created_at, updated_at)
     VALUES (?, ?, NULL, 0, 0, 0, NULL, 0, ?, ?)`,
    [id, email, timestamp, timestamp],
  );

  return getContact(email, d)!;
}

export function getContact(email: string, db?: Database): Contact | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM contacts WHERE email = ?").get(email) as ContactRow | null;
  if (!row) return null;
  return rowToContact(row);
}

export interface ListContactOptions {
  suppressed?: boolean;
  limit?: number;
  offset?: number;
}

export function listContacts(opts?: ListContactOptions, db?: Database): Contact[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: Array<number> = [];
  if (opts?.suppressed !== undefined) {
    conditions.push("suppressed = ?");
    params.push(opts.suppressed ? 1 : 0);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const limit = safeOptionalLimit(opts?.limit);
  const offset = safeOffset(opts?.offset);
  if (limit !== null) {
    params.push(limit, offset);
  }
  const rows = d
    .query(`SELECT * FROM contacts${where} ORDER BY updated_at DESC${limit !== null ? " LIMIT ? OFFSET ?" : ""}`)
    .all(...params) as ContactRow[];
  return rows.map(rowToContact);
}

export function suppressContact(email: string, db?: Database): void {
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run("UPDATE contacts SET suppressed = 1, updated_at = ? WHERE email = ?", [now(), email]);
}

export function unsuppressContact(email: string, db?: Database): void {
  const d = db || getDatabase();
  upsertContact(email, d);
  d.run("UPDATE contacts SET suppressed = 0, updated_at = ? WHERE email = ?", [now(), email]);
}

export function incrementSendCount(email: string, db?: Database): void {
  incrementSendCounts([email], db);
}

export function incrementSendCounts(emails: Iterable<string>, db?: Database): void {
  incrementContactCounts(emails, "send_count", { updateLastSentAt: true }, db);
}

function incrementContactCounts(
  emails: Iterable<string>,
  column: ContactCountColumn,
  opts: { updateLastSentAt?: boolean; autoSuppressBounces?: boolean } = {},
  db?: Database,
): void {
  const counts = new Map<string, number>();
  for (const email of emails) {
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  if (counts.size === 0) return;

  const d = db || getDatabase();
  const timestamp = now();
  const entries = Array.from(counts.entries());

  for (let i = 0; i < entries.length; i += CONTACT_WRITE_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CONTACT_WRITE_CHUNK_SIZE);
    const valuesSql = chunk.map(() => "(?, ?, NULL, 0, 0, 0, NULL, 0, ?, ?)").join(", ");
    const insertParams: string[] = [];
    for (const [email] of chunk) {
      insertParams.push(uuid(), email, timestamp, timestamp);
    }

    d.run(
      `INSERT INTO contacts (id, email, name, send_count, bounce_count, complaint_count, last_sent_at, suppressed, created_at, updated_at)
       VALUES ${valuesSql}
       ON CONFLICT(email) DO NOTHING`,
      insertParams,
    );

    const caseSql = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const placeholders = chunk.map(() => "?").join(", ");
    const updateParams: Array<string | number> = [];
    for (const [email, count] of chunk) {
      updateParams.push(email, count);
    }
    if (opts.updateLastSentAt) {
      updateParams.push(timestamp);
    }
    updateParams.push(timestamp);
    for (const [email] of chunk) {
      updateParams.push(email);
    }

    d.run(
      `UPDATE contacts
          SET ${column} = ${column} + CASE email ${caseSql} ELSE 0 END,
              ${opts.updateLastSentAt ? "last_sent_at = ?," : ""}
              updated_at = ?
        WHERE email IN (${placeholders})`,
      updateParams,
    );

    if (opts.autoSuppressBounces) {
      d.run(
        `UPDATE contacts
            SET suppressed = 1,
                updated_at = ?
          WHERE bounce_count >= 3
            AND email IN (${placeholders})`,
        [timestamp, ...chunk.map(([email]) => email)],
      );
    }
  }
}

export function incrementBounceCount(email: string, db?: Database): void {
  incrementBounceCounts([email], db);
}

export function incrementBounceCounts(emails: Iterable<string>, db?: Database): void {
  incrementContactCounts(emails, "bounce_count", { autoSuppressBounces: true }, db);
}

export function incrementComplaintCount(email: string, db?: Database): void {
  incrementComplaintCounts([email], db);
}

export function incrementComplaintCounts(emails: Iterable<string>, db?: Database): void {
  incrementContactCounts(emails, "complaint_count", {}, db);
}

export function isContactSuppressed(email: string, db?: Database): boolean {
  const d = db || getDatabase();
  const row = d.query("SELECT suppressed FROM contacts WHERE email = ?").get(email) as { suppressed: number } | null;
  return row?.suppressed === 1;
}

export function getSuppressedEmailSet(emails: Iterable<string>, db?: Database): Set<string> {
  const uniqueEmails = Array.from(new Set(emails));
  const suppressed = new Set<string>();
  if (uniqueEmails.length === 0) return suppressed;

  const d = db || getDatabase();
  for (let i = 0; i < uniqueEmails.length; i += CONTACT_READ_CHUNK_SIZE) {
    const chunk = uniqueEmails.slice(i, i + CONTACT_READ_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = d
      .query(`SELECT email FROM contacts WHERE suppressed = 1 AND email IN (${placeholders})`)
      .all(...chunk) as Array<{ email: string }>;
    for (const row of rows) {
      suppressed.add(row.email);
    }
  }

  return suppressed;
}
