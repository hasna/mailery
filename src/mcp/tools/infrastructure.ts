// MCP tool module: infrastructure.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDomain } from '../../db/domains.js';
import { getProvider } from '../../db/providers.js';
import { getAdapter } from '../../providers/index.js';
import { getDatabase } from '../../db/database.js';
import { loadConfig, getConfigValue, setConfigValue } from '../../lib/config.js';
import { formatError, resolveId, ProviderNotFoundError } from '../helpers.js';

interface EmailAgent { id: string; name: string; session_id?: string; last_seen_at: string; project_id?: string; }
const emailAgents = new Map<string, EmailAgent>();

export function registerInfrastructureTools(server: McpServer): void {
  // ─── DOMAIN PURCHASING (via @hasna/domains / Route 53) ───────────────────────

  server.tool(
  "check_domain_availability",
  "Check if a domain is available for purchase via AWS Route 53 and get pricing",
  { domain: z.string().describe("Domain to check (e.g. example.com)") },
  async ({ domain }) => {
    try {
      const { r53CheckAvailability } = await import("@hasna/domains");
      const result = await r53CheckAvailability(domain);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
  );

  server.tool(
  "register_domain",
  "Purchase and register a domain via AWS Route 53. Returns an operation ID to track progress.",
  {
    domain: z.string(),
    first_name: z.string(), last_name: z.string(),
    email: z.string(), phone: z.string().describe("E.164 format, e.g. +1.5551234567"),
    address_line_1: z.string(), city: z.string(), state: z.string(),
    country_code: z.string().describe("Two-letter country code, e.g. US"),
    zip_code: z.string(),
    organization_name: z.string().optional(),
    duration_years: z.number().optional().describe("Registration years (default: 1)"),
  },
  async (params) => {
    try {
      const { r53RegisterDomain } = await import("@hasna/domains");
      const result = await r53RegisterDomain(params.domain, {
        first_name: params.first_name, last_name: params.last_name,
        email: params.email, phone: params.phone,
        address_line_1: params.address_line_1, city: params.city,
        state: params.state, country_code: params.country_code,
        zip_code: params.zip_code, organization_name: params.organization_name,
      }, params.duration_years ?? 1);
      return { content: [{ type: "text", text: JSON.stringify({ domain: params.domain, ...result }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
  );

  server.tool(
  "get_domain_registration_status",
  "Check the status of a domain registration operation",
  { operation_id: z.string() },
  async ({ operation_id }) => {
    try {
      const { r53GetRegistrationStatus } = await import("@hasna/domains");
      return { content: [{ type: "text", text: JSON.stringify(await r53GetRegistrationStatus(operation_id), null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
  );

  server.tool(
  "list_registered_domains",
  "List all domains registered in AWS Route 53",
  {},
  async () => {
    try {
      const { r53ListRegisteredDomains } = await import("@hasna/domains");
      return { content: [{ type: "text", text: JSON.stringify(await r53ListRegisteredDomains(), null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
  );

  server.tool(
  "setup_domain_for_email",
  "Full setup: buy domain (Route53) + create Cloudflare zone + delegate nameservers to Cloudflare + register with SES + publish DKIM/SPF/DMARC DNS records IN CLOUDFLARE. DNS is always managed in Cloudflare regardless of registrar. One call to go from domain name to fully configured email sending.",
  {
    domain: z.string().describe("Domain to set up"),
    provider_id: z.string().describe("SES or Resend provider ID"),
    contact: z.object({
      first_name: z.string(), last_name: z.string(), email: z.string(),
      phone: z.string(), address_line_1: z.string(), city: z.string(),
      state: z.string(), country_code: z.string(), zip_code: z.string(),
      organization_name: z.string().optional(),
    }).optional().describe("Registrant contact info (omit if domain already purchased)"),
    duration_years: z.number().optional(),
    add_mx: z.boolean().optional().describe("Also publish an inbound MX record for receiving (default false)"),
  },
  async ({ domain, provider_id, contact, duration_years, add_mx }) => {
    try {
      const {
        r53CheckAvailability, r53RegisterDomain, r53GetRegistrationStatus,
        r53UpdateNameservers, cfEnsureZone, pollRegistrationUntilDone,
      } = await import("@hasna/domains");

      const provider = getProvider(resolveId("providers", provider_id));
      if (!provider) throw new ProviderNotFoundError(provider_id);

      const steps: string[] = [];

      // 1. Buy domain if contact info provided, and wait for registration.
      if (contact) {
        const avail = await r53CheckAvailability(domain);
        if (!avail.available) throw new Error(`${domain} is not available for registration`);
        steps.push(`availability: ${avail.available}, price: ${avail.price ?? "unknown"} ${avail.currency ?? ""}`);
        const reg = await r53RegisterDomain(domain, contact, duration_years ?? 1);
        steps.push(`registration submitted, operation_id: ${reg.operationId}`);
        const result = await pollRegistrationUntilDone(reg.operationId, {
          getStatus: async (id: string) => await r53GetRegistrationStatus(id),
        });
        if (result.status !== "success") throw new Error(`registration ${result.status}: ${result.message ?? ""}`);
        steps.push("registration complete");
      }

      // 2. Create/reuse the CLOUDFLARE zone and delegate the registrar NS to it.
      //    DNS is always Cloudflare — never a Route53 hosted zone.
      const zone = await cfEnsureZone(domain);
      steps.push(`cloudflare zone: ${zone.id} (ns ${zone.nameservers.join(", ")})`);
      try {
        await r53UpdateNameservers(domain, zone.nameservers);
        steps.push("registrar nameservers delegated to Cloudflare");
      } catch (e) {
        steps.push(`nameserver delegation skipped/failed (domain may be at another registrar): ${formatError(e)}`);
      }

      // 3. Register with SES.
      const adapter = getAdapter(provider);
      await adapter.addDomain(domain);
      createDomain(resolveId("providers", provider_id), domain);
      steps.push("domain registered with SES");

      // 4. Publish DKIM/SPF/DMARC (+ optional MX) records IN CLOUDFLARE.
      const { setupEmailDns } = await import("../../lib/cloudflare-dns.js");
      const dns = await setupEmailDns({ domain, provider, addMx: add_mx ?? false });
      steps.push(`${dns.created} DNS records published to Cloudflare (${dns.skipped} skipped, ${dns.failed} failed)`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            domain, cloudflare_zone_id: zone.id, nameservers: zone.nameservers,
            dns_provider: "cloudflare",
            steps, next: `Verify SES: emails domain verify ${domain} --provider ${provider_id}`,
          }, null, 2),
        }],
      };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true }; }
  },
  );

  // ─── CLOUDFLARE DNS ───────────────────────────────────────────────────────────

  server.tool(
  "get_cloudflare_zone",
  "Find the Cloudflare zone ID for a domain. Looks up zone by domain name.",
  {
    domain: z.string().describe("Domain name to look up"),
    cloudflare_token: z.string().optional().describe("Cloudflare API token (falls back to config/env)"),
  },
  async ({ domain, cloudflare_token }) => {
    try {
      const { getCloudflare, findZone } = await import("../../lib/cloudflare-dns.js");
      const cf = getCloudflare(cloudflare_token);
      const zone = await findZone(cf, domain);
      if (!zone) return { content: [{ type: "text", text: `No Cloudflare zone found for ${domain}` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(zone, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "setup_cloudflare_dns",
  "Automatically create all email DNS records (DKIM, SPF, DMARC, optionally MX) in Cloudflare for a domain. Skips records that already exist.",
  {
    domain: z.string().describe("Domain to configure"),
    provider_id: z.string().describe("SES or Resend provider ID"),
    cloudflare_token: z.string().optional().describe("Cloudflare API token (falls back to cloudflare_api_token config or CLOUDFLARE_API_TOKEN env)"),
    add_mx: z.boolean().optional().describe("Also add MX record for receiving email"),
    mx_server: z.string().optional().describe("Custom MX server hostname (default: inbound-smtp.<region>.amazonaws.com for SES)"),
    register_domain: z.boolean().optional().describe("Register the domain with SES/Resend first if not already added"),
  },
  async ({ domain, provider_id, cloudflare_token, add_mx, mx_server, register_domain }) => {
    try {
      const provider = getProvider(resolveId("providers", provider_id));
      if (!provider) throw new ProviderNotFoundError(provider_id);

      if (register_domain) {
        const adapter = getAdapter(provider);
        await adapter.addDomain(domain);
        createDomain(resolveId("providers", provider_id), domain);
      }

      const { setupEmailDns } = await import("../../lib/cloudflare-dns.js");
      const result = await setupEmailDns({
        domain,
        provider,
        apiToken: cloudflare_token,
        addMx: add_mx,
        mxServer: mx_server,
      });

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "sync_s3_inbox",
  "Sync inbound emails from an S3 bucket (stored by SES receipt rules) into local DB. Parses raw RFC 2822 email files.",
  {
    bucket: z.string().describe("S3 bucket name"),
    prefix: z.string().optional().describe("S3 key prefix (e.g. inbound/example.com/)"),
    region: z.string().optional().describe("AWS region (default: us-east-1)"),
    provider_id: z.string().optional().describe("Associate emails with this provider ID"),
    limit: z.number().optional().describe("Max emails per run (default: 100)"),
  },
  async ({ bucket, prefix, region, provider_id, limit }) => {
    try {
      const { syncS3Inbox } = await import("../../lib/s3-sync.js");
      const result = await syncS3Inbox({ bucket, prefix, region, providerId: provider_id, limit });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "setup_ses_inbound",
  "Create S3 bucket + SES receipt rules to receive inbound email for a domain",
  {
    domain: z.string().describe("Domain to receive email for"),
    bucket: z.string().describe("S3 bucket name to create/use"),
    region: z.string().optional().describe("AWS region (default: us-east-1)"),
    prefix: z.string().optional().describe("S3 key prefix"),
    catch_all: z.boolean().optional().describe("Also catch subdomains"),
  },
  async ({ domain, bucket, region, prefix, catch_all }) => {
    try {
      const { setupInboundEmail } = await import("../../lib/aws-inbound.js");
      const result = await setupInboundEmail({ domain, bucket, region, prefix, catchAll: catch_all });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── CONFIG ───────────────────────────────────────────────────────────────────


  server.tool(
  "get_config",
  "Get a configuration value by key",
  { key: z.string().describe("Config key (e.g. gmail_attachment_storage, gmail_s3_bucket, default_provider)") },
  async ({ key }) => {
    try {
      const value = getConfigValue(key);
      return { content: [{ type: "text", text: value === undefined ? `${key} is not set` : JSON.stringify({ [key]: value }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "set_config",
  "Set a configuration value. Known keys: gmail_attachment_storage (local|s3|none), gmail_s3_bucket, gmail_s3_prefix, gmail_s3_region, default_provider, failover-providers",
  {
    key: z.string().describe("Config key"),
    value: z.string().describe("Config value (strings, numbers, or JSON)"),
  },
  async ({ key, value }) => {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      setConfigValue(key, parsed);
      return { content: [{ type: "text", text: `✓ ${key} = ${JSON.stringify(parsed)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "list_config",
  "List all configuration values",
  {},
  async () => {
    try {
      const config = loadConfig();
      return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── Feedback ────────────────────────────────────────────────────────────────

  server.tool(
  "send_feedback",
  "Send feedback about this service",
  {
    message: z.string(),
    email: z.string().optional(),
    category: z.enum(["bug", "feature", "general"]).optional(),
  },
  async (params) => {
    try {
      const db = getDatabase();
      const pkg = require("../../package.json");
      db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
        params.message, params.email || null, params.category || "general", pkg.version,
      ]);
      return { content: [{ type: "text" as const, text: "Feedback saved. Thank you!" }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  },
  );

  // ─── Agent Tools ──────────────────────────────────────────────────────────────

  server.tool("register_agent", "Register an agent session. Returns agent_id. Auto-triggers a heartbeat.", {
  name: z.string(),
  session_id: z.string().optional(),
  }, async (params) => {
  const existing = [...emailAgents.values()].find(a => a.name === params.name);
  if (existing) { existing.last_seen_at = new Date().toISOString(); if (params.session_id) existing.session_id = params.session_id; return { content: [{ type: "text" as const, text: JSON.stringify(existing) }] }; }
  const id = Math.random().toString(36).slice(2, 10);
  const ag: EmailAgent = { id, name: params.name, session_id: params.session_id, last_seen_at: new Date().toISOString() };
  emailAgents.set(id, ag);
  return { content: [{ type: "text" as const, text: JSON.stringify(ag) }] };
  });

  server.tool("heartbeat", "Update last_seen_at to signal agent is active.", {
  agent_id: z.string(),
  }, async (params) => {
  const ag = emailAgents.get(params.agent_id);
  if (!ag) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }], isError: true };
  ag.last_seen_at = new Date().toISOString();
  return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: ag.id, last_seen_at: ag.last_seen_at }) }] };
  });

  server.tool("set_focus", "Set active project context for this agent session.", {
  agent_id: z.string(),
  project_id: z.string().optional(),
  }, async (params) => {
  const ag = emailAgents.get(params.agent_id);
  if (!ag) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }], isError: true };
  ag.project_id = params.project_id;
  return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: ag.id, project_id: ag.project_id ?? null }) }] };
  });

  server.tool("list_agents", "List all registered agents.", {}, async () => {
  return { content: [{ type: "text" as const, text: JSON.stringify([...emailAgents.values()]) }] };
  });

}
