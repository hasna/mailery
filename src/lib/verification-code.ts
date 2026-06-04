import type { InboundEmail } from "../db/inbound.js";

export interface VerificationCodeMatch {
  code: string;
  email: InboundEmail;
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

export function findVerificationCode(
  emails: InboundEmail[],
  filters: { from?: string; subject?: string } = {},
): VerificationCodeMatch | null {
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

