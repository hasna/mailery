/**
 * Cloudflare DNS setup helper for email domain verification.
 *
 * Uses a DIRECT Cloudflare REST client (no @hasna/connectors) to create the DNS records
 * required for email sending (SES/Resend) in a Cloudflare-managed zone.
 *
 * Records created:
 *   - TXT         SES identity verification token (_amazonses)
 *   - CNAME × 3  DKIM tokens (SES EasyDKIM)
 *   - TXT         SPF record
 *   - TXT         DMARC record
 *   - MX          (optional, for receiving email)
 */

import type { DnsRecord } from "../types/index.js";
import type { Provider } from "../types/index.js";
import { getAdapter } from "../providers/index.js";
import { getCloudflareToken, getCloudflareAuth } from "./config.js";
import { resolveCloudflareAuth } from "./cloudflare-auth.js";
import { DirectCloudflareClient } from "./cloudflare-dns-rest.js";

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

export interface CloudflareZone {
  id: string;
  name: string;
  name_servers?: string[];
  nameservers?: string[];
}

export interface CloudflareDnsRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

export interface CloudflareDnsClient {
  listZones(params?: { name?: string; page?: number; perPage?: number }): Promise<CloudflareZone[]>;
  listDnsRecords(zoneId: string, params?: { type?: string; name?: string; page?: number; perPage?: number }): Promise<CloudflareDnsRecord[]>;
  createDnsRecord(zoneId: string, params: {
    type: "TXT" | "CNAME" | "MX";
    name: string;
    content: string;
    ttl?: number;
    proxied?: boolean;
    priority?: number;
  }): Promise<CloudflareDnsRecord>;
}

// ─── Cloudflare factory ───────────────────────────────────────────────────────

/**
 * Create a Cloudflare DNS client. Uses the DIRECT Cloudflare REST client (plain
 * fetch + our own auth headers) — NOT @hasna/connectors — so provisioning never
 * shells out to a connector CLI or depends on the connectors package/source.
 */
export function getCloudflare(apiToken?: string): CloudflareDnsClient {
  if (apiToken) return new DirectCloudflareClient({ auth: apiToken });
  const auth = getCloudflareAuth() ?? resolveCloudflareAuth();
  const token = getCloudflareToken();
  return new DirectCloudflareClient({ auth: auth ?? (token ? { kind: "token", token } : undefined) });
}

// ─── Zone lookup ──────────────────────────────────────────────────────────────

/**
 * Find the Cloudflare zone for a domain.
 * Tries exact match first, then walks up the domain hierarchy.
 */
export async function findZone(
  cf: CloudflareDnsClient,
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
      const zones = await cf.listZones({ name: candidate });
      if (zones.length > 0) {
        const z = zones[0]!;
        return {
          id: z.id,
          name: z.name,
          nameservers: z.name_servers ?? z.nameservers ?? [],
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
  cf: CloudflareDnsClient,
  zoneId: string,
  records: DnsRecord[],
): Promise<DnsSetupRecord[]> {
  // Fetch existing records once
  const existing = await cf.listDnsRecords(zoneId, { perPage: 500 });

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
      await cf.createDnsRecord(zoneId, {
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
  cf: CloudflareDnsClient,
  zoneId: string,
  domain: string,
  mailserver: string,
  priority = 10,
): Promise<DnsSetupRecord> {
  // Check if MX already exists
  const existing = await cf.listDnsRecords(zoneId, { type: "MX", name: domain });
  const alreadyExists = existing.some((e: { content: string }) => e.content === mailserver);
  if (alreadyExists) {
    return { type: "MX", name: domain, content: mailserver, status: "skipped" };
  }

  try {
    await cf.createDnsRecord(zoneId, {
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
 * 3. Upsert all records (SES identity TXT, DKIM CNAMEs, SPF TXT, DMARC TXT)
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
  if (opts.provider.type === "ses" && adapter.reinitiateDomainVerification) {
    await adapter.reinitiateDomainVerification(opts.domain);
  }
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
