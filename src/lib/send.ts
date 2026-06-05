import { getProvider } from "../db/providers.js";
import { getAdapter } from "../providers/index.js";
import { getFailoverProviderIds } from "./config.js";
import { getAddressSendability } from "../db/address-lifecycle.js";
import { assertSendAuthorized } from "../db/send-keys.js";
import { canonicalSender } from "./email-address.js";
import { getWarmingSchedule } from "../db/warming.js";
import { getTodayLimit, getTodaySentCount } from "./warming.js";
import type { SendEmailOptions } from "../types/index.js";
import type { Database } from "../db/database.js";

export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 10;

export interface SendResult {
  messageId: string;
  providerId: string;
  usedFailover: boolean;
}

export function getAttachmentDecodedSize(content: string): number {
  return Buffer.from(content, "base64").byteLength;
}

export function validateSendAttachments(attachments: SendEmailOptions["attachments"]): void {
  if (!attachments || attachments.length === 0) return;
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Too many attachments: ${attachments.length} (max ${MAX_ATTACHMENT_COUNT})`);
  }
  for (const attachment of attachments) {
    const size = getAttachmentDecodedSize(attachment.content);
    if (size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new Error(`Attachment "${attachment.filename}" is too large: ${(size / 1024 / 1024).toFixed(1)}MB (max 25MB)`);
    }
  }
}

export function assertWarmingLimit(opts: SendEmailOptions, db?: Database): void {
  if (opts.bypass_warming) return;
  const fromDomain = canonicalSender(opts.from)?.split("@")[1] ?? opts.from.split("@")[1];
  if (!fromDomain) return;
  const warmingSchedule = getWarmingSchedule(fromDomain, db);
  if (!warmingSchedule) return;
  const limit = getTodayLimit(warmingSchedule);
  if (limit === null) return;
  const sent = getTodaySentCount(fromDomain, db);
  if (sent >= limit) {
    throw new Error(`Warming limit reached for ${fromDomain}: ${sent}/${limit} emails sent today. Use bypass_warming for a trusted local override or wait until tomorrow.`);
  }
}

/**
 * Send an email with automatic failover.
 * If the primary provider fails and failover-providers is configured,
 * retries each failover provider in order.
 */
export async function sendWithFailover(
  primaryProviderId: string,
  opts: SendEmailOptions,
  db?: Database,
): Promise<SendResult> {
  validateSendAttachments(opts.attachments);
  assertWarmingLimit(opts, db);

  // Scoped-auth guard: when an auth_token (send key) is supplied, the sender
  // must own or administer the From address. No token = trusted local caller.
  if (opts.auth_token) {
    assertSendAuthorized(opts.auth_token, opts.from, db);
  }

  // Lifecycle guard: a suspended or over-quota sender address is blocked before
  // any provider is touched.
  if (opts.from) {
    const senderEmail = canonicalSender(opts.from) ?? opts.from;
    const s = getAddressSendability(senderEmail, db);
    if (!s.sendable) throw new Error(`Send blocked: ${s.reason}`);
  }

  const providerIds = [primaryProviderId, ...getFailoverProviderIds()];
  const errors: string[] = [];

  for (let i = 0; i < providerIds.length; i++) {
    const providerId = providerIds[i]!;
    const provider = getProvider(providerId, db);
    if (!provider) {
      errors.push(`Provider not found: ${providerId}`);
      continue;
    }

    try {
      const adapter = getAdapter(provider);
      const messageId = await adapter.sendEmail(opts);
      return { messageId, providerId, usedFailover: i > 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${provider.name}] ${msg}`);
      if (i < providerIds.length - 1) {
        process.stderr.write(`\n⚠ Send failed on ${provider.name}, trying failover...\n`);
      }
    }
  }

  throw new Error(`All providers failed:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`);
}
