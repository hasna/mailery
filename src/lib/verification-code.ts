import { getDatabase, type Database } from "../db/database.js";
import { normalizeEmailAddress, type InboundEmail } from "../db/inbound.js";
import { safeLimit } from "../db/pagination.js";

export interface VerificationCodeEmail {
  id: string;
  from_address: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  received_at: string;
}

export interface VerificationCodeCandidateOptions {
  limit?: number;
  since?: string;
  from?: string;
  subject?: string;
}

export interface VerificationCodeMatch<T extends VerificationCodeEmail = InboundEmail> {
  code: string;
  email: T;
  confidence: "high" | "medium";
}

const CODE_CONTEXT_RE = /(?:code|verification|verify|temporary|one[-\s]?time|otp|passcode)[^\d]{0,80}(\d[\d\s-]{3,12}\d)/gi;
const STANDALONE_CODE_RE = /(?<!\d)(\d{4,10})(?!\d)/g;

function normalizeCode(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export function extractVerificationCodes(text: string): string[] {
  const ordered = new Map<string, number>();
  for (const match of text.matchAll(CODE_CONTEXT_RE)) {
    const code = normalizeCode(match[1] ?? "");
    if (code.length >= 4 && code.length <= 10) ordered.set(code, (ordered.get(code) ?? 0) + 2);
  }
  for (const match of text.matchAll(STANDALONE_CODE_RE)) {
    const code = normalizeCode(match[1] ?? "");
    if (code.length >= 4 && code.length <= 10) ordered.set(code, (ordered.get(code) ?? 0) + (code.length === 6 ? 1 : 0));
  }
  return [...ordered.entries()]
    .sort((a, b) => b[1] - a[1] || (b[0].length === 6 ? 1 : 0) - (a[0].length === 6 ? 1 : 0))
    .map(([code]) => code);
}

function candidateFilterSql(
  address: string,
  archived: boolean,
  filters: VerificationCodeCandidateOptions,
): { conditions: string[]; params: (string | number)[] } {
  const conditions = ["recipient.address = ?", "e.is_sent = 0", "e.is_archived = ?"];
  const params: (string | number)[] = [address, archived ? 1 : 0];
  if (filters.since) {
    conditions.push("e.received_at >= ?");
    params.push(filters.since);
  }
  const from = filters.from?.trim().toLowerCase();
  if (from) {
    conditions.push("LOWER(COALESCE(e.from_address, '')) LIKE ?");
    params.push(`%${from}%`);
  }
  const subject = filters.subject?.trim().toLowerCase();
  if (subject) {
    conditions.push("LOWER(COALESCE(e.subject, '')) LIKE ?");
    params.push(`%${subject}%`);
  }
  return { conditions, params };
}

export function listVerificationCodeCandidates(
  address: string,
  opts: VerificationCodeCandidateOptions = {},
  db?: Database,
): VerificationCodeEmail[] {
  const normalized = normalizeEmailAddress(address);
  if (!normalized) return [];

  const d = db || getDatabase();
  const limit = safeLimit(opts.limit);
  const active = candidateFilterSql(normalized, false, opts);
  const archived = candidateFilterSql(normalized, true, opts);
  const selected = "e.id, e.from_address, e.subject, e.text_body, e.html_body, e.received_at";

  return d.query(`
    WITH active AS (
      SELECT ${selected}
        FROM inbound_recipients recipient
        JOIN inbound_emails e ON e.id = recipient.inbound_email_id
       WHERE ${active.conditions.join(" AND ")}
       ORDER BY e.received_at DESC
       LIMIT ?
    ),
    archived AS (
      SELECT ${selected}
        FROM inbound_recipients recipient
        JOIN inbound_emails e ON e.id = recipient.inbound_email_id
       WHERE ${archived.conditions.join(" AND ")}
       ORDER BY e.received_at DESC
       LIMIT ?
    )
    SELECT * FROM active
    UNION ALL
    SELECT * FROM archived
    ORDER BY received_at DESC
  `).all(...active.params, limit, ...archived.params, limit) as VerificationCodeEmail[];
}

export function findVerificationCode<T extends VerificationCodeEmail = InboundEmail>(
  emails: T[],
  filters: { from?: string; subject?: string } = {},
): VerificationCodeMatch<T> | null {
  const from = filters.from?.toLowerCase();
  const subject = filters.subject?.toLowerCase();
  const sorted = [...emails].sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));

  for (const email of sorted) {
    if (from && !email.from_address.toLowerCase().includes(from)) continue;
    if (subject && !email.subject.toLowerCase().includes(subject)) continue;
    const body = [email.subject, email.text_body ?? "", email.html_body ?? ""].join("\n");
    const [code] = extractVerificationCodes(body);
    if (!code) continue;
    const high = /code|verification|verify|temporary|otp|passcode/i.test(body);
    return { code, email, confidence: high ? "high" : "medium" };
  }

  return null;
}
