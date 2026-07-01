import { getProvider } from "../db/providers.js";
import { getAdapter } from "../providers/index.js";
import { getFailoverProviderIds } from "./config.js";
import { getAddressSendability } from "../db/address-lifecycle.js";
import { assertSendAuthorized } from "../db/send-keys.js";
import { canonicalSender } from "./email-address.js";
import { getWarmingSchedule } from "../db/warming.js";
import { getDomainByName } from "../db/domains.js";
import { countReadyAddressesForDomain, getDomainProvisioning } from "../db/provisioning.js";
import { createSelfHostedSendAttempt, markSelfHostedSendAttemptFailed } from "../db/self-hosted-sent.js";
import { assessDomainReadiness } from "./domain-readiness.js";
import { getSelfHostedRuntimeStatus } from "./self-hosted-runtime.js";
import { getTodayLimit, getTodaySentCount } from "./warming.js";
import type { Provider, SendEmailOptions } from "../types/index.js";
import type { Database } from "../db/database.js";

export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 10;

export interface SendResult {
  messageId: string;
  providerId: string;
  usedFailover: boolean;
  selfHostedSendAttemptId?: string;
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

function senderDomain(opts: SendEmailOptions): string | null {
  const sender = canonicalSender(opts.from) ?? opts.from;
  const domain = sender.split("@")[1]?.trim().toLowerCase();
  return domain || null;
}

function sesClientConfig(provider: Provider): { region: string; accessKeyId?: string; secretAccessKey?: string } {
  return {
    region: provider.region || process.env["AWS_REGION"] || "us-east-1",
    accessKeyId: provider.access_key || process.env["AWS_ACCESS_KEY_ID"],
    secretAccessKey: provider.secret_key || process.env["AWS_SECRET_ACCESS_KEY"],
  };
}

function okSesDkimStatus(status: unknown): boolean {
  return String(status ?? "").toUpperCase() === "SUCCESS";
}

function okMailFromStatus(status: unknown): boolean {
  return String(status ?? "").toUpperCase() === "SUCCESS";
}

async function assertLiveSesSendReady(provider: Provider, domainName: string, mailFromDomain: string | null | undefined): Promise<void> {
  if (process.env["MAILERY_SKIP_SELF_HOSTED_SES_PREFLIGHT"] === "1") return;

  const config = sesClientConfig(provider);
  const { getSandboxStatus } = await import("./ses-sandbox.js");
  const account = await getSandboxStatus(config);
  if (!account.productionAccess) {
    throw new Error(`Self-hosted SES send requires production access for provider ${provider.name}. Run: mailery ses sandbox request-production-access`);
  }
  if (!account.sendingEnabled) {
    throw new Error(`Self-hosted SES send requires sending to be enabled for provider ${provider.name}. Check AWS SES account status.`);
  }

  if (!mailFromDomain) {
    throw new Error(`Self-hosted SES send requires a configured custom MAIL FROM domain for ${domainName}. Run: mailery provision domain ${domainName} --provider ${provider.id}`);
  }

  const { SESv2Client, GetEmailIdentityCommand } = await import("@aws-sdk/client-sesv2");
  const clientConfig: ConstructorParameters<typeof SESv2Client>[0] = { region: config.region };
  if (config.accessKeyId && config.secretAccessKey) {
    clientConfig.credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  }
  const client = new SESv2Client(clientConfig);
  const identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domainName }));
  if (!identity.VerifiedForSendingStatus) {
    throw new Error(`Self-hosted SES send requires SES identity ${domainName} to be verified for sending.`);
  }
  if (!okSesDkimStatus(identity.DkimAttributes?.Status)) {
    throw new Error(`Self-hosted SES send requires DKIM SUCCESS for ${domainName}; current status is ${String(identity.DkimAttributes?.Status ?? "unknown")}.`);
  }

  const attrs = identity.MailFromAttributes;
  const actualMailFrom = attrs?.MailFromDomain?.toLowerCase();
  const expectedMailFrom = mailFromDomain.toLowerCase();
  if (actualMailFrom !== expectedMailFrom) {
    throw new Error(`Self-hosted SES send requires MAIL FROM ${mailFromDomain}; SES currently reports ${attrs?.MailFromDomain ?? "none"}.`);
  }
  if (!okMailFromStatus(attrs?.MailFromDomainStatus)) {
    throw new Error(`Self-hosted SES send requires MAIL FROM SUCCESS for ${mailFromDomain}; current status is ${String(attrs?.MailFromDomainStatus ?? "unknown")}.`);
  }
  if (attrs?.BehaviorOnMxFailure !== "REJECT_MESSAGE") {
    throw new Error(`Self-hosted SES send requires MAIL FROM BehaviorOnMxFailure=REJECT_MESSAGE for ${mailFromDomain}.`);
  }
}

export async function assertSelfHostedSendReady(provider: Provider, opts: SendEmailOptions, db?: Database): Promise<void> {
  const status = getSelfHostedRuntimeStatus();
  if (!status.enabled) return;
  if (!status.configured) {
    throw new Error("Self-hosted source-of-truth mode requires HASNA_EMAILS_DATABASE_URL or EMAILS_DATABASE_URL.");
  }
  if (provider.type !== "ses") {
    throw new Error(`Self-hosted cloud-backed sends require an AWS SES provider. Provider ${provider.name} is ${provider.type}.`);
  }

  const domainName = senderDomain(opts);
  if (!domainName) {
    throw new Error(`Self-hosted SES send requires a valid From domain: ${opts.from}`);
  }

  const domain = getDomainByName(provider.id, domainName, db);
  if (!domain) {
    throw new Error(`Self-hosted SES send requires domain ${domainName} to be registered for provider ${provider.name}. Run: mailery domain add ${domainName} --provider ${provider.id}`);
  }

  const provisioning = getDomainProvisioning(domain.id, db);
  const readiness = assessDomainReadiness(domain, provisioning, {
    ready_addresses: countReadyAddressesForDomain(domain.id, db),
  });
  if (!readiness.send_ready) {
    const issueText = readiness.issues.length > 0 ? readiness.issues.join("; ") : readiness.state;
    const fixText = readiness.fix_commands.length > 0 ? ` Fix: ${readiness.fix_commands.join(" && ")}` : "";
    throw new Error(`Self-hosted SES send requires ${domainName} to be send-ready before provider send. ${issueText}.${fixText}`);
  }
  await assertLiveSesSendReady(provider, domainName, provisioning?.mail_from_domain);
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

    let selfHostedSendAttemptId: string | undefined;
    try {
      await assertSelfHostedSendReady(provider, opts, db);
      if (getSelfHostedRuntimeStatus().enabled) {
        selfHostedSendAttemptId = (await createSelfHostedSendAttempt(providerId, opts)).id;
      }
      const adapter = getAdapter(provider);
      const messageId = await adapter.sendEmail(opts);
      return { messageId, providerId, usedFailover: i > 0, selfHostedSendAttemptId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (selfHostedSendAttemptId) {
        await markSelfHostedSendAttemptFailed(selfHostedSendAttemptId, msg).catch(() => {});
      }
      errors.push(`[${provider.name}] ${msg}`);
      if (i < providerIds.length - 1) {
        process.stderr.write(`\n⚠ Send failed on ${provider.name}, trying failover...\n`);
      }
    }
  }

  throw new Error(`All providers failed:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`);
}
