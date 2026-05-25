/**
 * Cloudflare DNS setup helper for email domain verification.
 *
 * Uses @hasna/connect-cloudflare SDK to automatically create the DNS records
 * required for email sending (SES/Resend) in a Cloudflare-managed zone.
 *
 * Records created:
 *   - CNAME × 3  DKIM tokens (SES EasyDKIM)
 *   - TXT         SPF record
 *   - TXT         DMARC record
 *   - MX          (optional, for receiving email)
 */

import { Cloudflare, type CloudflareDnsRecord } from "@hasna/connect-cloudflare";
import type { DnsRecord } from "../types/index.js";
import type { Provider } from "../types/index.js";
import { getAdapter } from "../providers/index.js";
import { getCloudflareToken } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DnsSetupRecord {
  type: string;
  name: string;
  content: string;
  status: "created" | "skipped" | "failed";
  error?: string;
}

export interface EmailDnsSetupResult {
  domain: string;
  zone_id: string;
  zone_name: string;
  records: DnsSetupRecord[];
  created: number;
  skipped: number;
  failed: number;
}

// ─── Cloudflare factory ───────────────────────────────────────────────────────

/**
 * Create a Cloudflare instance from an explicit token, config file, or env var.
 */
export function getCloudflare(apiToken?: string): Cloudflare {
  const token = apiToken || getCloudflareToken();
  if (token) {
    return new Cloudflare({ apiToken: token });
  }
  // Fall back to connector's own config (~/.connectors/connect-cloudflare/)
  return Cloudflare.create();
}

// ─── Zone lookup ──────────────────────────────────────────────────────────────

/**
 * Find the Cloudflare zone for a domain.
 * Tries exact match first, then walks up the domain hierarchy.
 */
export async function findZone(
  cf: Cloudflare,
  domain: string,
): Promise<{ id: string; name: string; nameservers: string[] } | null> {
  // Try exact match first, then apex domain
  const candidates = [domain];
  const parts = domain.split(".");
  if (parts.length > 2) {
    candidates.push(parts.slice(-2).join("."));
  }

  for (const candidate of candidates) {
    try {
      const res = await cf.zones.list({ name: candidate });
      const zones = res.result ?? [];
      if (zones.length > 0) {
        const z = zones[0]!;
        return {
          id: z.id,
          name: z.name,
          nameservers: (z as unknown as { name_servers?: string[] }).name_servers ?? [],
        };
      }
    } catch {
      // keep trying
    }
  }
  return null;
}

// ─── DNS record upsert ────────────────────────────────────────────────────────

/**
 * Create DNS records in Cloudflare, skipping any that already exist
 * (matched by type + name + content).
 */
export async function upsertEmailDnsRecords(
  cf: Cloudflare,
  zoneId: string,
  records: DnsRecord[],
): Promise<DnsSetupRecord[]> {
  // Fetch existing records once
  const existingRes = await cf.dns.list(zoneId, { per_page: 500 });
  const existing = existingRes.result ?? [];

  const results: DnsSetupRecord[] = [];

  for (const record of records) {
    // TXT values from SES come without quotes; Cloudflare stores them with quotes
    const normalizedContent = record.value.replace(/^"|"$/g, "");

    // Check for existing record with same type + name
    const alreadyExists = existing.some(
      (e: CloudflareDnsRecord) =>
        e.type === record.type &&
        e.name === record.name &&
        e.content.replace(/^"|"$/g, "") === normalizedContent,
    );

    if (alreadyExists) {
      results.push({ type: record.type, name: record.name, content: normalizedContent, status: "skipped" });
      continue;
    }

    try {
      await cf.dns.create(zoneId, {
        type: record.type as "TXT" | "CNAME" | "MX",
        name: record.name,
        content: record.type === "TXT" ? `"${normalizedContent}"` : normalizedContent,
        ttl: 300,
        proxied: false,
      });
      results.push({ type: record.type, name: record.name, content: normalizedContent, status: "created" });
    } catch (e) {
      results.push({
        type: record.type,
        name: record.name,
        content: normalizedContent,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

/**
 * Add an MX record for receiving email (e.g. AWS SES inbound or Google Workspace).
 */
export async function addMxRecord(
  cf: Cloudflare,
  zoneId: string,
  domain: string,
  mailserver: string,
  priority = 10,
): Promise<DnsSetupRecord> {
  // Check if MX already exists
  const existingRes = await cf.dns.list(zoneId, { type: "MX", name: domain });
  const existing = existingRes.result ?? [];
  const alreadyExists = existing.some((e: { content: string }) => e.content === mailserver);
  if (alreadyExists) {
    return { type: "MX", name: domain, content: mailserver, status: "skipped" };
  }

  try {
    await cf.dns.create(zoneId, {
      type: "MX",
      name: domain,
      content: mailserver,
      priority,
      ttl: 300,
      proxied: false,
    });
    return { type: "MX", name: domain, content: mailserver, status: "created" };
  } catch (e) {
    return {
      type: "MX", name: domain, content: mailserver, status: "failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Full email DNS setup via Cloudflare:
 * 1. Get required DNS records from the provider adapter (SES/Resend)
 * 2. Find the Cloudflare zone for the domain
 * 3. Upsert all records (DKIM CNAMEs, SPF TXT, DMARC TXT)
 * 4. Optionally add MX record for receiving
 */
export async function setupEmailDns(opts: {
  domain: string;
  provider: Provider;
  apiToken?: string;
  addMx?: boolean;
  mxServer?: string;
}): Promise<EmailDnsSetupResult> {
  const cf = getCloudflare(opts.apiToken);

  // Get required DNS records from the email provider
  const adapter = getAdapter(opts.provider);
  const dnsRecords = await adapter.getDnsRecords(opts.domain);

  // Find Cloudflare zone
  const zone = await findZone(cf, opts.domain);
  if (!zone) {
    throw new Error(
      `No Cloudflare zone found for ${opts.domain}. ` +
      `Make sure the domain is added to your Cloudflare account.`,
    );
  }

  // Upsert email DNS records
  const records = await upsertEmailDnsRecords(cf, zone.id, dnsRecords);

  // Optionally add MX record
  if (opts.addMx) {
    const region = opts.provider.region ?? "us-east-1";
    const mxServer = opts.mxServer ?? `inbound-smtp.${region}.amazonaws.com`;
    const mxResult = await addMxRecord(cf, zone.id, opts.domain, mxServer);
    records.push(mxResult);
  }

  return {
    domain: opts.domain,
    zone_id: zone.id,
    zone_name: zone.name,
    records,
    created: records.filter((r) => r.status === "created").length,
    skipped: records.filter((r) => r.status === "skipped").length,
    failed: records.filter((r) => r.status === "failed").length,
  };
}
