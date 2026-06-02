/**
 * Cloudflare DNS setup helper for email domain verification.
 *
 * Uses the @hasna/connectors SDK to automatically create the DNS records
 * required for email sending (SES/Resend) in a Cloudflare-managed zone.
 *
 * Records created:
 *   - CNAME × 3  DKIM tokens (SES EasyDKIM)
 *   - TXT         SPF record
 *   - TXT         DMARC record
 *   - MX          (optional, for receiving email)
 */

import { runConnectorOperation } from "@hasna/connectors";
import type { DnsRecord } from "../types/index.js";
import type { Provider } from "../types/index.js";
import { getAdapter } from "../providers/index.js";
import { getCloudflareToken, getCloudflareAuth } from "./config.js";
import {
  type CloudflareAuth,
  cloudflareAuthEnv,
  resolveCloudflareAuth,
} from "./cloudflare-auth.js";

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

class ConnectorsCloudflareClient implements CloudflareDnsClient {
  private readonly auth?: CloudflareAuth;

  constructor(auth?: CloudflareAuth | string) {
    // Back-compat: a bare string is treated as a scoped token.
    if (typeof auth === "string") this.auth = { kind: "token", token: auth };
    else this.auth = auth;
  }

  async listZones(params?: { name?: string; page?: number; perPage?: number }): Promise<CloudflareZone[]> {
    const data = await this.run<unknown>("zones.list", {
      name: params?.name,
      page: params?.page,
      perPage: params?.perPage,
    });
    return unwrapList<CloudflareZone>(data);
  }

  async listDnsRecords(
    zoneId: string,
    params?: { type?: string; name?: string; page?: number; perPage?: number },
  ): Promise<CloudflareDnsRecord[]> {
    const data = await this.run<unknown>("dns.list", {
      args: [zoneId],
      type: params?.type,
      name: params?.name,
      page: params?.page,
      perPage: params?.perPage,
    });
    return unwrapList<CloudflareDnsRecord>(data);
  }

  async createDnsRecord(
    zoneId: string,
    params: {
      type: "TXT" | "CNAME" | "MX";
      name: string;
      content: string;
      ttl?: number;
      proxied?: boolean;
      priority?: number;
    },
  ): Promise<CloudflareDnsRecord> {
    const data = await this.run<unknown>("dns.create", {
      args: [zoneId],
      type: params.type,
      name: params.name,
      content: params.content,
      ttl: params.ttl,
      proxied: params.proxied,
      priority: params.priority,
    });
    return unwrapRecord(data);
  }

  private async run<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    // Inject the auth env vars the Cloudflare connector expects (token or
    // global key + email), restoring any previous values afterwards.
    const injected = this.auth ? cloudflareAuthEnv(this.auth) : {};
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(injected)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const result = await runConnectorOperation<T>({
        connector: "cloudflare",
        operation,
        input,
      });
      if (!result.success) {
        throw new Error(result.stderr || result.stdout || `Cloudflare ${operation} failed`);
      }
      return result.data as T;
    } finally {
      for (const key of Object.keys(injected)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key]!;
      }
    }
  }
}

function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const envelope = data as Record<string, unknown>;
    for (const key of ["result", "results", "records", "zones", "data"]) {
      const value = envelope[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

function unwrapRecord(data: unknown): CloudflareDnsRecord {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const envelope = data as Record<string, unknown>;
    if (envelope["result"] && typeof envelope["result"] === "object") {
      return envelope["result"] as CloudflareDnsRecord;
    }
    if (envelope["record"] && typeof envelope["record"] === "object") {
      return envelope["record"] as CloudflareDnsRecord;
    }
    return envelope as unknown as CloudflareDnsRecord;
  }
  throw new Error("Cloudflare DNS create returned an invalid response");
}

/**
 * Create a Cloudflare instance from an explicit token, config file, or env var.
 */
export function getCloudflare(apiToken?: string): CloudflareDnsClient {
  // Explicit token wins (back-compat). Otherwise resolve full auth — scoped
  // token OR global key + email — from config + env + vault names.
  if (apiToken) return new ConnectorsCloudflareClient(apiToken);
  const auth = getCloudflareAuth() ?? resolveCloudflareAuth();
  // Last-ditch back-compat: a bare configured token via the old accessor.
  if (!auth) return new ConnectorsCloudflareClient(getCloudflareToken());
  return new ConnectorsCloudflareClient(auth);
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
