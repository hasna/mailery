/**
 * Threading DB layer — read/write the threading fields on sent emails and
 * inbound emails, and resolve the parent of a reply by Message-ID.
 */
import type { Database } from "./database.js";
import { getDatabase, now } from "./database.js";
import { parseJsonArray } from "./json.js";

export interface EmailThreading {
  message_id: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  references: string[];
}

export function setEmailThreading(emailId: string, t: Partial<EmailThreading>, db?: Database): void {
  const d = db || getDatabase();
  const sets: string[] = ["updated_at = ?"]; const params: (string | null)[] = [now()];
  if (t.message_id !== undefined) { sets.push("message_id = ?"); params.push(t.message_id); }
  if (t.thread_id !== undefined) { sets.push("thread_id = ?"); params.push(t.thread_id); }
  if (t.in_reply_to !== undefined) { sets.push("in_reply_to = ?"); params.push(t.in_reply_to); }
  if (t.references !== undefined) { sets.push("references_json = ?"); params.push(JSON.stringify(t.references)); }
  params.push(emailId);
  d.run(`UPDATE emails SET ${sets.join(", ")} WHERE id = ?`, params);
}

export function getEmailThreading(emailId: string, db?: Database): EmailThreading | null {
  const d = db || getDatabase();
  const row = d.query("SELECT message_id, thread_id, in_reply_to, references_json FROM emails WHERE id = ?").get(emailId) as
    { message_id: string | null; thread_id: string | null; in_reply_to: string | null; references_json: string | null } | null;
  if (!row) return null;
  return { message_id: row.message_id, thread_id: row.thread_id, in_reply_to: row.in_reply_to, references: parseJsonArray<string>(row.references_json) };
}

/**
 * Find a sent email by its RFC Message-ID (with or without angle brackets).
 * SES REWRITES our Message-ID to `<{provider_message_id}@email.amazonses.com>`,
 * so we also match the Message-ID's local-part (before @) against the stored
 * provider_message_id — that's how a received copy links back to our send.
 */
export function getEmailByMessageId(messageId: string, db?: Database): { id: string; thread_id: string | null; references: string[]; message_id: string | null } | null {
  const d = db || getDatabase();
  const bare = messageId.replace(/[<>]/g, "").trim();
  const localPart = bare.split("@")[0] ?? bare;
  const row = d.query(
    `SELECT id, thread_id, references_json, message_id FROM emails
     WHERE message_id = ? OR message_id = ? OR provider_message_id = ? OR provider_message_id = ? LIMIT 1`,
  ).get(messageId, `<${bare}>`, bare, localPart) as { id: string; thread_id: string | null; references_json: string | null; message_id: string | null } | null;
  if (!row) return null;
  return { id: row.id, thread_id: row.thread_id, references: parseJsonArray<string>(row.references_json), message_id: row.message_id };
}

export function setInboundThreadId(inboundId: string, threadId: string, db?: Database): void {
  const d = db || getDatabase();
  d.run("UPDATE inbound_emails SET thread_id = ? WHERE id = ?", [threadId, inboundId]);
}

/** All sent + received emails in a thread, ordered by time. */
export function getThreadMessages(threadId: string, db?: Database): Array<{ kind: "sent" | "received"; id: string; from: string; subject: string; at: string }> {
  const d = db || getDatabase();
  const sent = d.query("SELECT id, from_address, subject, sent_at FROM emails WHERE thread_id = ?").all(threadId) as Array<{ id: string; from_address: string; subject: string; sent_at: string }>;
  const recv = d.query("SELECT id, from_address, subject, received_at FROM inbound_emails WHERE thread_id = ?").all(threadId) as Array<{ id: string; from_address: string; subject: string; received_at: string }>;
  const all = [
    ...sent.map((r) => ({ kind: "sent" as const, id: r.id, from: r.from_address, subject: r.subject, at: r.sent_at })),
    ...recv.map((r) => ({ kind: "received" as const, id: r.id, from: r.from_address, subject: r.subject, at: r.received_at })),
  ];
  return all.sort((a, b) => a.at.localeCompare(b.at));
}

import { parseReferences } from "../lib/threading.js";

/**
 * Resolve the thread for an inbound email from its In-Reply-To / References
 * headers. If any referenced Message-ID matches one of our sent emails, return
 * that email's thread_id (and id); otherwise start a new thread.
 */
export function resolveThreadForInbound(
  headers: Record<string, string> | undefined,
  newThreadId: string,
  db?: Database,
): { thread_id: string; parent_email_id: string | null } {
  const d = db || getDatabase();
  const h = headers ?? {};
  const ownMsgId = h["Message-ID"] ?? h["message-id"] ?? h["Message-Id"] ?? "";
  const inReplyTo = h["In-Reply-To"] ?? h["in-reply-to"] ?? "";
  const refs = parseReferences(h["References"] ?? h["references"]);
  // Own Message-ID first (the received copy of one of our sends shares it),
  // then In-Reply-To, then References newest→oldest.
  const candidates = [ownMsgId, inReplyTo, ...refs.reverse()].map((s) => s.trim()).filter(Boolean);
  for (const c of candidates) {
    const parent = getEmailByMessageId(c, d);
    if (parent) {
      return { thread_id: parent.thread_id ?? newThreadId, parent_email_id: parent.id };
    }
  }
  return { thread_id: newThreadId, parent_email_id: null };
}
