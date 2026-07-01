import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { getInboundEmail } from "../db/inbound.js";
import { getLatestActiveProviderId } from "../db/providers.js";
import {
  listPendingForwarding,
  recordForwardingDelivery,
  type ForwardingRule,
} from "../db/forwarding.js";
import { createSentEmailLedger, storeSentEmailContent } from "./sent-ledger.js";
import { sendWithFailover, type SendResult } from "./send.js";

export interface ForwardingRunOptions {
  providerId?: string;
  fromAddress?: string;
  limit?: number;
  backfill?: boolean;
  db?: Database;
  send?: (providerId: string, opts: Parameters<typeof sendWithFailover>[1], db: Database) => Promise<SendResult>;
}

export interface ForwardingRunItem {
  rule_id: string;
  inbound_email_id: string;
  target_address: string;
  status: "sent" | "failed" | "skipped";
  sent_email_id: string | null;
  error: string | null;
}

export interface ForwardingRunResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  items: ForwardingRunItem[];
}

export async function processForwardingRules(opts: ForwardingRunOptions = {}): Promise<ForwardingRunResult> {
  const db = opts.db ?? getDatabase();
  const pending = listPendingForwarding(opts.limit ?? 100, db, { backfill: opts.backfill });
  const result: ForwardingRunResult = { attempted: pending.length, sent: 0, failed: 0, skipped: 0, items: [] };

  for (const pendingItem of pending) {
    const inbound = getInboundEmail(pendingItem.inbound_email_id, db);
    if (!inbound) {
      result.skipped++;
      result.items.push(item(pendingItem.rule, pendingItem.inbound_email_id, "skipped", null, "Inbound email no longer exists"));
      continue;
    }

    const providerId = opts.providerId ?? pendingItem.rule.provider_id ?? getLatestActiveProviderId(undefined, db);
    const from = opts.fromAddress ?? pendingItem.rule.from_address ?? pendingItem.rule.source_address;
    if (!providerId) {
      recordForwardingDelivery({
        rule_id: pendingItem.rule.id,
        inbound_email_id: inbound.id,
        status: "failed",
        error: "No active provider available for app-level forwarding",
      }, db);
      result.failed++;
      result.items.push(item(pendingItem.rule, inbound.id, "failed", null, "No active provider available for app-level forwarding"));
      continue;
    }

    const subject = /^fwd?:/i.test(inbound.subject.trim()) ? inbound.subject : `Fwd: ${inbound.subject}`;
    const body = formatForwardedBody(inbound.from_address, inbound.received_at, inbound.text_body ?? "");
    const sendOpts = {
      from,
      to: pendingItem.rule.target_address,
      subject,
      text: body,
      html: `<pre>${escapeHtml(body)}</pre>`,
      idempotency_key: `forward:${pendingItem.rule.id}:${inbound.id}`,
      headers: {
        "X-Hasna-Forwarded-For": pendingItem.rule.source_address,
        "X-Hasna-Inbound-Id": inbound.id,
      },
    };

    try {
      const send = opts.send ?? sendWithFailover;
      const sent = await send(providerId, sendOpts, db);
      const email = await createSentEmailLedger(sent.providerId, sendOpts, sent.messageId, db, sent.selfHostedSendAttemptId);
      await storeSentEmailContent(email.id, { text: body, html: sendOpts.html }, db);
      recordForwardingDelivery({
        rule_id: pendingItem.rule.id,
        inbound_email_id: inbound.id,
        sent_email_id: email.id,
        status: "sent",
      }, db);
      result.sent++;
      result.items.push(item(pendingItem.rule, inbound.id, "sent", email.id, null));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordForwardingDelivery({
        rule_id: pendingItem.rule.id,
        inbound_email_id: inbound.id,
        status: "failed",
        error: message,
      }, db);
      result.failed++;
      result.items.push(item(pendingItem.rule, inbound.id, "failed", null, message));
    }
  }

  return result;
}

function item(
  rule: ForwardingRule,
  inboundEmailId: string,
  status: ForwardingRunItem["status"],
  sentEmailId: string | null,
  error: string | null,
): ForwardingRunItem {
  return {
    rule_id: rule.id,
    inbound_email_id: inboundEmailId,
    target_address: rule.target_address,
    status,
    sent_email_id: sentEmailId,
    error,
  };
}

function formatForwardedBody(from: string, receivedAt: string, body: string): string {
  return [
    "---------- Forwarded message ----------",
    `From: ${from}`,
    `Date: ${receivedAt}`,
    "",
    body,
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
