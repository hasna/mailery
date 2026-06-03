import { getProvider } from "../db/providers.js";
import { getAdapter } from "../providers/index.js";
import { getFailoverProviderIds } from "./config.js";
import { getAddressSendability } from "../db/address-lifecycle.js";
import { assertSendAuthorized } from "../db/send-keys.js";
import { canonicalSender } from "./email-address.js";
import type { SendEmailOptions } from "../types/index.js";
import type { Database } from "../db/database.js";

export interface SendResult {
  messageId: string;
  providerId: string;
  usedFailover: boolean;
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
