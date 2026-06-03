import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  SendEmailCommand,
  BatchGetMetricDataCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from "@aws-sdk/client-sesv2";
import type { DnsRecord, DnsStatus, Provider, SendEmailOptions, Stats } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";
import type { ProviderAdapter, RemoteAddress, RemoteDomain, RemoteEvent } from "./interface.js";

export class SESAdapter implements ProviderAdapter {
  private client: SESv2Client;
  private providerId: string;

  constructor(provider: Provider) {
    const region = provider.region || process.env["AWS_REGION"] || "us-east-1";
    const accessKeyId = provider.access_key || process.env["AWS_ACCESS_KEY_ID"];
    const secretAccessKey = provider.secret_key || process.env["AWS_SECRET_ACCESS_KEY"];

    if (!region) {
      throw new ProviderConfigError("SES provider requires a region");
    }

    const clientConfig: ConstructorParameters<typeof SESv2Client>[0] = { region };

    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = { accessKeyId, secretAccessKey };
    }

    this.client = new SESv2Client(clientConfig);
    this.providerId = provider.id;
  }

  async listDomains(): Promise<RemoteDomain[]> {
    const result = await this.client.send(
      new ListEmailIdentitiesCommand({}),
    );

    const domains: RemoteDomain[] = [];
    for (const identity of result.EmailIdentities ?? []) {
      if (!identity.IdentityName) continue;
      // Filter to domains only (exclude email addresses which contain @)
      if (identity.IdentityName.includes("@")) continue;
      try {
        const detail = await this.client.send(
          new GetEmailIdentityCommand({ EmailIdentity: identity.IdentityName }),
        );
        const dkimStatus = this.mapDkimStatus(detail.DkimAttributes?.Status);
        const verified = detail.VerifiedForSendingStatus ?? false;
        domains.push({
          domain: identity.IdentityName,
          dkim_status: dkimStatus,
          spf_status: verified ? "verified" : "pending",
          dmarc_status: "pending",
        });
      } catch {
        domains.push({
          domain: identity.IdentityName,
          dkim_status: "pending",
          spf_status: "pending",
          dmarc_status: "pending",
        });
      }
    }
    return domains;
  }

  async getDnsRecords(domain: string): Promise<DnsRecord[]> {
    const records: DnsRecord[] = [];

    try {
      const detail = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: domain }),
      );

      // DKIM CNAME records
      for (const token of detail.DkimAttributes?.Tokens ?? []) {
        records.push({
          type: "CNAME",
          name: `${token}._domainkey.${domain}`,
          value: `${token}.dkim.amazonses.com`,
          purpose: "DKIM",
        });
      }
    } catch {
      // Domain not registered yet — provide template records
    }

    // SPF record
    records.push({
      type: "TXT",
      name: domain,
      value: "v=spf1 include:amazonses.com ~all",
      purpose: "SPF",
    });

    // DMARC record
    records.push({
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      purpose: "DMARC",
    });

    return records;
  }

  async verifyDomain(domain: string): Promise<{ dkim: DnsStatus; spf: DnsStatus; dmarc: DnsStatus }> {
    try {
      const detail = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: domain }),
      );
      const dkimStatus = this.mapDkimStatus(detail.DkimAttributes?.Status);
      const verified = detail.VerifiedForSendingStatus ?? false;
      return {
        dkim: dkimStatus,
        spf: verified ? "verified" : "pending",
        dmarc: "pending",
      };
    } catch {
      return { dkim: "pending", spf: "pending", dmarc: "pending" };
    }
  }

  async addDomain(domain: string): Promise<void> {
    try {
      // EasyDKIM: create the identity WITHOUT DkimSigningAttributes so SES
      // generates and rotates the DKIM keys itself. (Passing an empty
      // DomainSigningPrivateKey is rejected with a validation error.)
      await this.client.send(
        new CreateEmailIdentityCommand({ EmailIdentity: domain }),
      );
    } catch (err: unknown) {
      // If identity already exists, that's fine
      if (err instanceof Error && err.name === "AlreadyExistsException") return;
      throw err;
    }
  }

  /**
   * Set a custom MAIL FROM domain (improves SPF/DMARC alignment). Defaults to
   * `mail.<domain>`. Requires the MAIL FROM MX + SPF records to be published.
   */
  async setMailFrom(domain: string, mailFromDomain?: string): Promise<string> {
    const mailFrom = mailFromDomain ?? `mail.${domain}`;
    await this.client.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: domain,
        MailFromDomain: mailFrom,
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      }),
    );
    return mailFrom;
  }

  async listAddresses(): Promise<RemoteAddress[]> {
    const result = await this.client.send(
      new ListEmailIdentitiesCommand({}),
    );

    const addresses: RemoteAddress[] = [];
    for (const identity of result.EmailIdentities ?? []) {
      if (!identity.IdentityName) continue;
      // Filter to email addresses only (exclude domains which don't contain @)
      if (!identity.IdentityName.includes("@")) continue;
      try {
        const detail = await this.client.send(
          new GetEmailIdentityCommand({ EmailIdentity: identity.IdentityName }),
        );
        addresses.push({
          email: identity.IdentityName,
          verified: detail.VerifiedForSendingStatus ?? false,
        });
      } catch {
        addresses.push({ email: identity.IdentityName, verified: false });
      }
    }
    return addresses;
  }

  async addAddress(email: string): Promise<void> {
    try {
      await this.client.send(
        new CreateEmailIdentityCommand({ EmailIdentity: email }),
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AlreadyExistsException") return;
      throw err;
    }
  }

  async verifyAddress(email: string): Promise<boolean> {
    try {
      const detail = await this.client.send(
        new GetEmailIdentityCommand({ EmailIdentity: email }),
      );
      return detail.VerifiedForSendingStatus ?? false;
    } catch {
      return false;
    }
  }

  async sendEmail(opts: SendEmailOptions): Promise<string> {
    const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
    const ccArr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : [];
    const bccArr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : [];

    // Build extra headers (List-Unsubscribe, custom headers)
    const extraHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.unsubscribe_url) {
      extraHeaders["List-Unsubscribe"] = `<${opts.unsubscribe_url}>`;
      extraHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    const hasCustomHeaders = Object.keys(extraHeaders).length > 0;

    if (opts.attachments && opts.attachments.length > 0 || hasCustomHeaders) {
      // Build raw MIME message for attachments or custom headers
      const rawMessage = buildRawMime({ ...opts, headers: { ...opts.headers, ...extraHeaders } });
      const result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: opts.from,
          // SESv2 SendEmail with Raw content still needs explicit recipients —
          // omitting Destination means the message is accepted but not delivered.
          Destination: {
            ToAddresses: toArr,
            CcAddresses: ccArr.length > 0 ? ccArr : undefined,
            BccAddresses: bccArr.length > 0 ? bccArr : undefined,
          },
          Content: {
            Raw: { Data: Buffer.from(rawMessage) },
          },
        }),
      );
      return result.MessageId ?? "";
    }

    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: opts.from,
        Destination: {
          ToAddresses: toArr,
          CcAddresses: ccArr.length > 0 ? ccArr : undefined,
          BccAddresses: bccArr.length > 0 ? bccArr : undefined,
        },
        ReplyToAddresses: opts.reply_to ? [opts.reply_to] : undefined,
        Content: {
          Simple: {
            Subject: { Data: opts.subject, Charset: "UTF-8" },
            Body: {
              ...(opts.html ? { Html: { Data: opts.html, Charset: "UTF-8" } } : {}),
              ...(opts.text ? { Text: { Data: opts.text, Charset: "UTF-8" } } : {}),
            },
          },
        },
        EmailTags: opts.tags
          ? Object.entries(opts.tags).map(([Name, Value]) => ({ Name, Value }))
          : undefined,
      }),
    );

    return result.MessageId ?? "";
  }

  async pullEvents(_since?: string): Promise<RemoteEvent[]> {
    // SES doesn't have a direct events list API — stats are aggregate only
    // Return empty; real webhook events come via SNS → webhook endpoint
    return [];
  }

  async getStats(period = "30d"): Promise<Stats> {
    const days = parseInt(period.replace("d", ""), 10) || 30;
    const endDate = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    try {
      const result = await this.client.send(
        new BatchGetMetricDataCommand({
          Queries: [
            { Id: "sent", Namespace: "VDM", Metric: "SEND", StartDate: startDate, EndDate: endDate },
            { Id: "delivered", Namespace: "VDM", Metric: "DELIVERY", StartDate: startDate, EndDate: endDate },
            { Id: "bounced", Namespace: "VDM", Metric: "PERMANENT_BOUNCE", StartDate: startDate, EndDate: endDate },
            { Id: "complained", Namespace: "VDM", Metric: "COMPLAINT", StartDate: startDate, EndDate: endDate },
            { Id: "opened", Namespace: "VDM", Metric: "OPEN", StartDate: startDate, EndDate: endDate },
            { Id: "clicked", Namespace: "VDM", Metric: "CLICK", StartDate: startDate, EndDate: endDate },
          ],
        }),
      );

      const sum = (id: string): number => {
        const entry = result.Results?.find((r) => r.Id === id);
        return (entry?.Values ?? []).reduce((a: number, b: number) => a + b, 0);
      };

      const sent = sum("sent");
      const delivered = sum("delivered");
      const bounced = sum("bounced");
      const complained = sum("complained");
      const opened = sum("opened");
      const clicked = sum("clicked");

      return {
        provider_id: this.providerId,
        period,
        sent,
        delivered,
        bounced,
        complained,
        opened,
        clicked,
        delivery_rate: sent > 0 ? (delivered / sent) * 100 : 0,
        bounce_rate: sent > 0 ? (bounced / sent) * 100 : 0,
        open_rate: sent > 0 ? (opened / sent) * 100 : 0,
      };
    } catch {
      return {
        provider_id: this.providerId,
        period,
        sent: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
        opened: 0,
        clicked: 0,
        delivery_rate: 0,
        bounce_rate: 0,
        open_rate: 0,
      };
    }
  }

  private mapDkimStatus(status?: string): DnsStatus {
    if (status === "SUCCESS") return "verified";
    if (status === "FAILED" || status === "TEMPORARY_FAILURE") return "failed";
    return "pending";
  }
}

function buildRawMime(opts: SendEmailOptions): string {
  const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
  const rnd = () => crypto.randomUUID().replace(/-/g, "");
  // Fully independent boundaries (no prefix collision — a nested boundary that
  // is a prefix of its parent makes MIME parsers ambiguous and gets rejected).
  const mixedB = `mixed_${rnd()}`;
  const altB = `alt_${rnd()}`;
  const hasAttachments = (opts.attachments?.length ?? 0) > 0;

  const headerLines: string[] = [
    `From: ${opts.from}`,
    `To: ${toArr.join(", ")}`,
    ...(opts.cc ? [`Cc: ${(Array.isArray(opts.cc) ? opts.cc : [opts.cc]).join(", ")}`] : []),
    `Subject: ${opts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    ...(opts.reply_to ? [`Reply-To: ${opts.reply_to}`] : []),
    ...(opts.headers ? Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`) : []),
  ];

  // The body: an alternative part (text + html) when both exist, else a single
  // part. Wrapped in multipart/mixed ONLY when there are attachments.
  const altParts: string[] = [];
  if (opts.text) altParts.push(`--${altB}`, `Content-Type: text/plain; charset=UTF-8`, "", opts.text, "");
  if (opts.html) altParts.push(`--${altB}`, `Content-Type: text/html; charset=UTF-8`, "", opts.html, "");

  function bodyBlock(): { ctype: string; lines: string[] } {
    if (opts.text && opts.html) {
      return { ctype: `multipart/alternative; boundary="${altB}"`, lines: [...altParts, `--${altB}--`] };
    }
    if (opts.html) return { ctype: `text/html; charset=UTF-8`, lines: [opts.html] };
    return { ctype: `text/plain; charset=UTF-8`, lines: [opts.text ?? ""] };
  }

  const lines: string[] = [...headerLines];
  if (!hasAttachments) {
    const b = bodyBlock();
    lines.push(`Content-Type: ${b.ctype}`, "", ...b.lines);
    return lines.join("\r\n");
  }

  // With attachments: multipart/mixed { body, attachments... }
  lines.push(`Content-Type: multipart/mixed; boundary="${mixedB}"`, "");
  const b = bodyBlock();
  lines.push(`--${mixedB}`, `Content-Type: ${b.ctype}`, "", ...b.lines, "");
  for (const a of opts.attachments ?? []) {
    lines.push(`--${mixedB}`,
      `Content-Type: ${a.content_type}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      `Content-Transfer-Encoding: base64`, "", a.content, "");
  }
  lines.push(`--${mixedB}--`);
  return lines.join("\r\n");
}
