import { Resend } from "resend";
import type { DnsRecord, DnsStatus, Provider, SendEmailOptions, Stats } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";
import type { ProviderAdapter, RemoteAddress, RemoteDomain, RemoteEvent } from "./interface.js";

export class ResendAdapter implements ProviderAdapter {
  private client: Resend;
  private providerId: string;

  constructor(provider: Provider) {
    if (!provider.api_key) {
      throw new ProviderConfigError("Resend provider requires an API key");
    }
    this.client = new Resend(provider.api_key);
    this.providerId = provider.id;
  }

  async listDomains(): Promise<RemoteDomain[]> {
    const result = await this.client.domains.list();
    if (!result.data) return [];
    const list = result.data.data ?? [];

    return list.map((d) => ({
      domain: d.name,
      dkim_status: this.mapStatus(d.status),
      spf_status: this.mapStatus(d.status),
      dmarc_status: "pending" as DnsStatus,
    }));
  }

  async getDnsRecords(domain: string): Promise<DnsRecord[]> {
    const domains = await this.client.domains.list();
    if (!domains.data) return [];
    const list = domains.data.data ?? [];

    const found = list.find((d) => d.name === domain);
    if (!found) return [];

    const detail = await this.client.domains.get(found.id);
    if (!detail.data) return [];

    const records: DnsRecord[] = [];

    // DKIM records
    if (detail.data.records) {
      for (const rec of detail.data.records) {
        if (rec.type === "TXT" || rec.type === "CNAME" || rec.type === "MX") {
          records.push({
            type: rec.type as "TXT" | "CNAME" | "MX",
            name: rec.name,
            value: rec.value,
            purpose: "DKIM",
          });
        }
      }
    }

    // SPF
    records.push({
      type: "TXT",
      name: domain,
      value: "v=spf1 include:amazonses.com ~all",
      purpose: "SPF",
    });

    // DMARC
    records.push({
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      purpose: "DMARC",
    });

    return records;
  }

  async verifyDomain(domain: string): Promise<{ dkim: DnsStatus; spf: DnsStatus; dmarc: DnsStatus }> {
    const domains = await this.client.domains.list();
    if (!domains.data) {
      return { dkim: "pending", spf: "pending", dmarc: "pending" };
    }
    const list = domains.data.data ?? [];

    const found = list.find((d) => d.name === domain);
    if (!found) {
      return { dkim: "pending", spf: "pending", dmarc: "pending" };
    }

    // Trigger verification
    await this.client.domains.verify(found.id);

    // Get updated status
    const detail = await this.client.domains.get(found.id);
    const status = this.mapStatus(detail.data?.status ?? "not_started");

    return { dkim: status, spf: status, dmarc: "pending" };
  }

  async addDomain(domain: string): Promise<void> {
    // The Resend SDK returns { data, error } and does NOT throw — surface the
    // error (e.g. plan limit: "Your plan includes 1 domain. Upgrade to add more.")
    // so callers get a clear message instead of a silent no-op.
    const res = (await this.client.domains.create({ name: domain })) as { data?: unknown; error?: { message?: string } | null };
    if (res?.error) {
      throw new Error(`Resend could not add domain ${domain}: ${res.error.message ?? JSON.stringify(res.error)}`);
    }
  }

  async listAddresses(): Promise<RemoteAddress[]> {
    // Resend doesn't have a native sender address list concept
    return [];
  }

  async addAddress(_email: string): Promise<void> {
    // Resend allows sending from any verified domain address
    // No explicit registration needed
  }

  async verifyAddress(_email: string): Promise<boolean> {
    return true;
  }

  async sendEmail(opts: SendEmailOptions): Promise<string> {
    const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];

    // Resend requires at least one of html or text
    const bodyContent = opts.html
      ? { html: opts.html, text: opts.text }
      : { text: opts.text ?? "" };

    const payload: Parameters<typeof this.client.emails.send>[0] = {
      from: opts.from,
      to: toArr,
      subject: opts.subject,
      ...bodyContent,
    };

    if (opts.cc) payload.cc = Array.isArray(opts.cc) ? opts.cc : [opts.cc];
    if (opts.bcc) payload.bcc = Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc];
    if (opts.reply_to) payload.replyTo = opts.reply_to;

    if (opts.attachments && opts.attachments.length > 0) {
      payload.attachments = opts.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "base64"),
      }));
    }

    if (opts.tags) {
      payload.tags = Object.entries(opts.tags).map(([name, value]) => ({ name, value }));
    }

    // Build custom headers (List-Unsubscribe, etc.)
    const extraHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.unsubscribe_url) {
      extraHeaders["List-Unsubscribe"] = `<${opts.unsubscribe_url}>`;
      extraHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    if (Object.keys(extraHeaders).length > 0) {
      (payload as unknown as Record<string, unknown>).headers = extraHeaders;
    }

    const result = await this.client.emails.send(payload);
    if (result.error) {
      throw new Error(`Resend send failed: ${result.error.message}`);
    }
    return result.data?.id ?? "";
  }

  async pullEvents(since?: string): Promise<RemoteEvent[]> {
    // Resend doesn't have a native events endpoint — we list emails and check their status
    const events: RemoteEvent[] = [];

    try {
      // Resend v2+ has a list endpoint
      const result = await (this.client.emails as unknown as {
        list: (opts?: { limit?: number }) => Promise<{ data?: Array<{ id: string; from: string; to: string[]; subject: string; created_at: string; last_event: string }> | null; error?: { message: string } | null }>;
      }).list({ limit: 100 });

      if (result.data) {
        for (const email of result.data) {
          if (since && email.created_at < since) continue;
          const eventType = this.mapEventType(email.last_event);
          if (eventType) {
            events.push({
              provider_event_id: `${email.id}-${email.last_event}`,
              type: eventType,
              occurred_at: email.created_at,
              provider_message_id: email.id,
              metadata: { last_event: email.last_event },
            });
          }
        }
      }
    } catch {
      // List endpoint may not be available in all SDK versions
    }

    return events;
  }

  async getStats(period = "30d"): Promise<Stats> {
    const events = await this.pullEvents();
    return computeStats(this.providerId, period, events);
  }

  private mapStatus(status: string): DnsStatus {
    if (status === "verified" || status === "success") return "verified";
    if (status === "failed" || status === "temporary_failure" || status === "permanent_failure") return "failed";
    return "pending";
  }

  private mapEventType(event: string): "delivered" | "bounced" | "complained" | "opened" | "clicked" | null {
    switch (event) {
      case "delivered": return "delivered";
      case "bounced": case "bounce": return "bounced";
      case "complained": case "complaint": return "complained";
      case "opened": case "open": return "opened";
      case "clicked": case "click": return "clicked";
      default: return null;
    }
  }
}

function computeStats(providerId: string, period: string, events: RemoteEvent[]): Stats {
  const now = Date.now();
  const days = parseInt(period.replace("d", ""), 10) || 30;
  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  const filtered = events.filter((e) => e.occurred_at >= since);

  const sent = filtered.length;
  const delivered = filtered.filter((e) => e.type === "delivered").length;
  const bounced = filtered.filter((e) => e.type === "bounced").length;
  const complained = filtered.filter((e) => e.type === "complained").length;
  const opened = filtered.filter((e) => e.type === "opened").length;
  const clicked = filtered.filter((e) => e.type === "clicked").length;

  return {
    provider_id: providerId,
    period,
    sent,
    delivered,
    bounced,
    complained,
    opened,
    clicked,
    delivery_rate: sent > 0 ? (delivered / sent) * 100 : 0,
    bounce_rate: sent > 0 ? (bounced / sent) * 100 : 0,
    open_rate: delivered > 0 ? (opened / delivered) * 100 : 0,
  };
}
