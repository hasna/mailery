import type { PgAdapterAsync } from "./remote-storage.js";
import { getStoragePg, runStorageMigrations } from "./storage-sync.js";
import { parseJsonArray, parseJsonObject } from "./json.js";
import { now, uuid } from "./database.js";
import type { Email, EmailRow, EmailStatus, SendEmailOptions } from "../types/index.js";
import { getSelfHostedRuntimeStatus } from "../lib/self-hosted-runtime.js";

type Remote = Pick<PgAdapterAsync, "all" | "run" | "close">;

export interface SelfHostedSendAttempt {
  id: string;
  provider_id: string;
  status: "pending" | "sent" | "failed";
  email_id: string | null;
  provider_message_id: string | null;
}

async function ensureSendAttemptTable(remote: Remote): Promise<void> {
  await remote.run(`
    CREATE TABLE IF NOT EXISTS email_send_attempts (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
      idempotency_key TEXT,
      from_address TEXT NOT NULL,
      to_addresses TEXT NOT NULL DEFAULT '[]',
      cc_addresses TEXT NOT NULL DEFAULT '[]',
      bcc_addresses TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
      provider_message_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await remote.run("CREATE INDEX IF NOT EXISTS idx_email_send_attempts_status ON email_send_attempts(status, created_at)");
  await remote.run("CREATE INDEX IF NOT EXISTS idx_email_send_attempts_provider ON email_send_attempts(provider_id, created_at)");
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function rowToEmail(row: EmailRow): Email {
  return {
    ...row,
    to_addresses: parseJsonArray<string>(row.to_addresses),
    cc_addresses: parseJsonArray<string>(row.cc_addresses),
    bcc_addresses: parseJsonArray<string>(row.bcc_addresses),
    tags: parseJsonObject<Record<string, string>>(row.tags),
    status: row.status as EmailStatus,
    has_attachments: Boolean(row.has_attachments),
    attachment_count: Number(row.attachment_count ?? 0),
    sent_at: iso(row.sent_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function assertSelfHostedSentRuntimeConfigured(): void {
  const status = getSelfHostedRuntimeStatus();
  if (!status.enabled) return;
  if (status.configured) return;
  throw new Error("Self-hosted source-of-truth mode requires HASNA_EMAILS_DATABASE_URL or EMAILS_DATABASE_URL.");
}

async function withRemote<T>(remote: Remote | undefined, fn: (remote: Remote) => Promise<T>): Promise<T> {
  if (remote) return fn(remote);
  const owned = await getStoragePg();
  try {
    await runStorageMigrations(owned);
    await ensureSendAttemptTable(owned);
    return await fn(owned);
  } finally {
    await owned.close();
  }
}

export async function createSelfHostedSendAttempt(
  providerId: string,
  opts: SendEmailOptions,
  remote?: Remote,
): Promise<SelfHostedSendAttempt> {
  assertSelfHostedSentRuntimeConfigured();
  return withRemote(remote, async (r) => {
    await ensureSendAttemptTable(r);
    const id = uuid();
    const timestamp = now();
    const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
    const ccArr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : [];
    const bccArr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : [];
    const idempotencyKey = (opts as unknown as Record<string, unknown>).idempotency_key as string | undefined;
    const payload = {
      reply_to: opts.reply_to ?? null,
      html_present: Boolean(opts.html),
      text_present: Boolean(opts.text),
      attachment_count: opts.attachments?.length ?? 0,
      tags: opts.tags ?? {},
      headers: opts.headers ?? {},
    };
    const rows = await r.all(
      `INSERT INTO email_send_attempts (
         id, provider_id, idempotency_key, from_address, to_addresses,
         cc_addresses, bcc_addresses, subject, payload_json, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       RETURNING id, provider_id, status, email_id, provider_message_id`,
      id,
      providerId,
      idempotencyKey || null,
      opts.from,
      JSON.stringify(toArr),
      JSON.stringify(ccArr),
      JSON.stringify(bccArr),
      opts.subject,
      JSON.stringify(payload),
      timestamp,
      timestamp,
    ) as SelfHostedSendAttempt[];
    return rows[0]!;
  });
}

export async function markSelfHostedSendAttemptSent(
  attemptId: string,
  input: { emailId?: string | null; providerMessageId?: string | null },
  remote?: Remote,
): Promise<void> {
  await withRemote(remote, async (r) => {
    await ensureSendAttemptTable(r);
    await r.run(
      `UPDATE email_send_attempts
          SET status = 'sent',
              email_id = COALESCE(?, email_id),
              provider_message_id = COALESCE(?, provider_message_id),
              error = NULL,
              updated_at = ?
        WHERE id = ?`,
      input.emailId || null,
      input.providerMessageId || null,
      now(),
      attemptId,
    );
  });
}

export async function markSelfHostedSendAttemptFailed(
  attemptId: string,
  error: string,
  remote?: Remote,
): Promise<void> {
  await withRemote(remote, async (r) => {
    await ensureSendAttemptTable(r);
    await r.run(
      `UPDATE email_send_attempts
          SET status = 'failed',
              error = ?,
              updated_at = ?
        WHERE id = ?`,
      error,
      now(),
      attemptId,
    );
  });
}

async function getEmailByIdempotencyKey(idempotencyKey: string, remote: Remote): Promise<Email | null> {
  const rows = await remote.all("SELECT * FROM emails WHERE idempotency_key = ? LIMIT 1", idempotencyKey) as EmailRow[];
  return rows[0] ? rowToEmail(rows[0]) : null;
}

export async function createSelfHostedSentEmail(
  providerId: string,
  opts: SendEmailOptions,
  providerMessageId?: string,
  attemptId?: string,
  remote?: Remote,
): Promise<Email> {
  assertSelfHostedSentRuntimeConfigured();
  const idempotencyKey = (opts as unknown as Record<string, unknown>).idempotency_key as string | undefined;
  return withRemote(remote, async (r) => {
    if (idempotencyKey) {
      const existing = await getEmailByIdempotencyKey(idempotencyKey, r);
      if (existing) return existing;
    }

    const id = uuid();
    const timestamp = now();
    const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
    const ccArr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : [];
    const bccArr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : [];
    const attachCount = opts.attachments?.length ?? 0;

    try {
      const rows = await r.all(
        `INSERT INTO emails (
           id, provider_id, provider_message_id, from_address, to_addresses,
           cc_addresses, bcc_addresses, reply_to, subject, status,
           has_attachments, attachment_count, tags, idempotency_key,
           sent_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        id,
        providerId,
        providerMessageId || null,
        opts.from,
        JSON.stringify(toArr),
        JSON.stringify(ccArr),
        JSON.stringify(bccArr),
        opts.reply_to || null,
        opts.subject,
        attachCount > 0,
        attachCount,
        JSON.stringify(opts.tags || {}),
        idempotencyKey || null,
        timestamp,
        timestamp,
        timestamp,
      ) as EmailRow[];
      const email = rowToEmail(rows[0]!);
      if (attemptId) {
        await markSelfHostedSendAttemptSent(attemptId, { emailId: email.id, providerMessageId }, r);
      }
      return email;
    } catch (error) {
      if (idempotencyKey) {
        const existing = await getEmailByIdempotencyKey(idempotencyKey, r);
        if (existing) return existing;
      }
      throw error;
    }
  });
}

export async function storeSelfHostedEmailContent(
  emailId: string,
  content: { html?: string; text?: string; headers?: Record<string, string> },
  remote?: Remote,
): Promise<void> {
  assertSelfHostedSentRuntimeConfigured();
  await withRemote(remote, async (r) => {
    await r.run(
      `INSERT INTO email_content (email_id, html, text_body, headers_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (email_id) DO UPDATE SET
         html = EXCLUDED.html,
         text_body = EXCLUDED.text_body,
         headers_json = EXCLUDED.headers_json`,
      emailId,
      content.html || null,
      content.text || null,
      JSON.stringify(content.headers || {}),
    );
  });
}

export async function setSelfHostedEmailThreading(
  emailId: string,
  threading: {
    message_id?: string | null;
    thread_id?: string | null;
    in_reply_to?: string | null;
    references?: string[];
  },
  remote?: Remote,
): Promise<void> {
  assertSelfHostedSentRuntimeConfigured();
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | null> = [now()];
  if (threading.message_id !== undefined) {
    sets.push("message_id = ?");
    params.push(threading.message_id);
  }
  if (threading.thread_id !== undefined) {
    sets.push("thread_id = ?");
    params.push(threading.thread_id);
  }
  if (threading.in_reply_to !== undefined) {
    sets.push("in_reply_to = ?");
    params.push(threading.in_reply_to);
  }
  if (threading.references !== undefined) {
    sets.push("references_json = ?");
    params.push(JSON.stringify(threading.references));
  }
  params.push(emailId);
  await withRemote(remote, async (r) => {
    await r.run(`UPDATE emails SET ${sets.join(", ")} WHERE id = ?`, params);
  });
}
