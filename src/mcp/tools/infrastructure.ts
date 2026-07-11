// MCP tool module: infrastructure.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDomain } from '../../db/domains.js';
import { getProvider } from '../../db/providers.js';
import { getAdapter } from '../../providers/index.js';
import { getDatabase } from '../../db/database.js';
import { loadConfig, getConfigValue, setConfigValue } from '../../lib/config.js';
import { normalizeRoute53RegistrationContact } from '../../lib/route53-contact.js';
import { formatError, resolveId, ProviderNotFoundError } from '../helpers.js';

const MAX_MCP_S3_SYNC_LIMIT = 10000;
const MAX_MCP_PROVISION_WAIT_SECONDS = 300;
const MAX_MCP_PROVISION_INTERVAL_SECONDS = 60;
const MAX_DOMAIN_REGISTRATION_YEARS = 10;

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
    address_line_1: z.string(), city: z.string(), state: z.string().optional(),
    country_code: z.string().describe("Two-letter country code, e.g. US"),
    zip_code: z.string(),
    organization_name: z.string().optional(),
    duration_years: z.number().int().positive().max(MAX_DOMAIN_REGISTRATION_YEARS).optional().describe("Registration years (default: 1, max: 10)"),
  },
  async (params) => {
    try {
      const { r53RegisterDomain } = await import("@hasna/domains");
      const contact = normalizeRoute53RegistrationContact({
        first_name: params.first_name, last_name: params.last_name,
        email: params.email, phone: params.phone,
        address_line_1: params.address_line_1, city: params.city,
        state: params.state, country_code: params.country_code,
        zip_code: params.zip_code, organization_name: params.organization_name,
      });
      const result = await r53RegisterDomain(params.domain, contact as Parameters<typeof r53RegisterDomain>[1], params.duration_years ?? 1);
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
      state: z.string().optional(), country_code: z.string(), zip_code: z.string(),
      organization_name: z.string().optional(),
    }).optional().describe("Registrant contact info (omit if domain already purchased)"),
    duration_years: z.number().int().positive().max(MAX_DOMAIN_REGISTRATION_YEARS).optional(),
    add_mx: z.boolean().optional().describe("Also publish an inbound MX record for receiving (default false)"),
    force_mx_switch: z.boolean().optional().describe("Allow adding inbound MX when an existing provider already owns root MX"),
  },
  async ({ domain, provider_id, contact, duration_years, add_mx, force_mx_switch }) => {
    try {
      const {
        r53CheckAvailability, r53RegisterDomain, r53GetRegistrationStatus,
        r53UpdateNameservers, cfEnsureZone, pollRegistrationUntilDone,
      } = await import("@hasna/domains");

      const provider = getProvider(resolveId("providers", provider_id));
      if (!provider) throw new ProviderNotFoundError(provider_id);
      if (add_mx) {
        const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
        await guardSesInboundMx(domain, !!force_mx_switch);
      }

      const steps: string[] = [];

      // 1. Buy domain if contact info provided, and wait for registration.
      if (contact) {
        const avail = await r53CheckAvailability(domain);
        if (!avail.available) throw new Error(`${domain} is not available for registration`);
        steps.push(`availability: ${avail.available}, price: ${avail.price ?? "unknown"} ${avail.currency ?? ""}`);
        const reg = await r53RegisterDomain(domain, normalizeRoute53RegistrationContact(contact) as Parameters<typeof r53RegisterDomain>[1], duration_years ?? 1);
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
      const dns = await setupEmailDns({ domain, provider, addMx: add_mx ?? false, forceMxSwitch: !!force_mx_switch });
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
    force_mx_switch: z.boolean().optional().describe("Allow adding inbound MX when an existing provider already owns root MX"),
  },
  async ({ domain, provider_id, cloudflare_token, add_mx, mx_server, register_domain, force_mx_switch }) => {
    try {
      const provider = getProvider(resolveId("providers", provider_id));
      if (!provider) throw new ProviderNotFoundError(provider_id);
      if (add_mx) {
        const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
        await guardSesInboundMx(domain, !!force_mx_switch);
      }

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
        forceMxSwitch: !!force_mx_switch,
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
    limit: z.number().int().positive().max(MAX_MCP_S3_SYNC_LIMIT).optional().describe("Max emails per run (default: 100, max: 10000)"),
  },
  async ({ bucket, prefix, region, provider_id, limit }) => {
    try {
      const { syncS3Inbox } = await import("../../lib/s3-sync.js");
      const result = await syncS3Inbox({ bucket, prefix, region, providerId: provider_id, limit: limit ?? 100 });
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
  { key: z.string().describe("Config key (e.g. attachment_storage, attachment_s3_bucket, default_provider)") },
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
  "Set a configuration value. Known keys: attachment_storage (local|s3|none), attachment_s3_bucket, attachment_s3_prefix, attachment_s3_region, default_provider, failover-providers",
  {
    key: z.string().describe("Config key"),
    value: z.string().describe("Config value (strings, numbers, or JSON)"),
  },
  async ({ key, value }) => {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      setConfigValue(key, parsed);
      return { content: [{ type: "text", text: JSON.stringify({ [key]: parsed }, null, 2) }] };
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

  // ─── PROVISIONING ───────────────────────────────────────────────────────────

  server.tool(
    "provision_domain",
    "Provision a domain for sending: create the SES identity and publish DKIM/SPF/DMARC (+optional MX) DNS records in Cloudflare. DNS is always Cloudflare.",
    {
      domain: z.string(),
      provider_id: z.string().describe("SES provider ID"),
      send_provider: z.string().optional(),
      add_mx: z.boolean().optional().describe("Also publish inbound MX (ses-s3 receive)"),
      force_mx_switch: z.boolean().optional().describe("Allow adding inbound MX when an existing provider already owns root MX"),
    },
    async ({ domain, provider_id, send_provider, add_mx, force_mx_switch }) => {
      try {
        const db = getDatabase();
        const resolvedProviderId = resolveId("providers", provider_id);
        const provider = getProvider(resolvedProviderId);
        if (!provider) throw new ProviderNotFoundError(provider_id);
        if (add_mx) {
          const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
          await guardSesInboundMx(domain, !!force_mx_switch);
        }
        const { getDomainByName } = await import("../../db/domains.js");
        const { setDomainProvisioning } = await import("../../db/provisioning.js");
        const rec = getDomainByName(resolvedProviderId, domain, db) ?? createDomain(resolvedProviderId, domain, db);
        setDomainProvisioning(rec.id, { provisioning_status: "ses_identity_created", send_provider: send_provider ?? "ses", dns_provider: "cloudflare" }, db);
        const adapter = getAdapter(provider);
        await adapter.addDomain(domain);
        const { setupEmailDns } = await import("../../lib/cloudflare-dns.js");
        const dns = await setupEmailDns({ domain, provider, addMx: !!add_mx, forceMxSwitch: !!force_mx_switch });
        setDomainProvisioning(rec.id, { provisioning_status: "dns_published", next_check_at: new Date().toISOString() }, db);
        return { content: [{ type: "text" as const, text: JSON.stringify({ domain, dns_provider: "cloudflare", records_published: dns.created, dns }, null, 2) }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true }; }
    },
  );

  server.tool(
    "provision_address",
    "Create an email address on a provisioned domain with a receive strategy (ses-s3 | cf-routing | resend-webhook).",
    {
      email: z.string(),
      provider_id: z.string(),
      domain_id: z.string().optional().describe("Domain ID or prefix; defaults to matching provider/domain"),
      receive_strategy: z.enum(["ses-s3", "cf-routing", "resend-webhook"]).optional(),
      forward_to: z.string().optional(),
      owner: z.string().optional().describe("Owner name, ID, or ID prefix"),
      administrator: z.string().optional().describe("Administering agent name, ID, or ID prefix"),
      wait: z.boolean().optional().describe("Advance provisioning now and wait until ready"),
      timeout_seconds: z.number().int().positive().max(MAX_MCP_PROVISION_WAIT_SECONDS).optional().describe("Max seconds to wait when wait=true (max 300)"),
      interval_seconds: z.number().int().positive().max(MAX_MCP_PROVISION_INTERVAL_SECONDS).optional().describe("Polling interval when wait=true (max 60)"),
      inbound_bucket: z.string().optional().describe("Inbound S3 bucket for receive validation"),
    },
    async ({ email, provider_id, domain_id, receive_strategy, forward_to, owner, administrator, wait, timeout_seconds, interval_seconds, inbound_bucket }) => {
      try {
        const db = getDatabase();
        const pid = resolveId("providers", provider_id);
        const provider = getProvider(pid);
        if (!provider) throw new ProviderNotFoundError(provider_id);
        const { createAddress, getAddressByEmail } = await import("../../db/addresses.js");
        const { getDomainByName } = await import("../../db/domains.js");
        const { getAddressProvisioning, setAddressProvisioning } = await import("../../db/provisioning.js");
        const addr = getAddressByEmail(pid, email, db) ?? createAddress({ provider_id: pid, email }, db);
        const domainName = email.split("@")[1];
        const domainId = domain_id ? resolveId("domains", domain_id) : (domainName ? getDomainByName(pid, domainName, db)?.id ?? null : null);
        setAddressProvisioning(addr.id, {
          domain_id: domainId,
          receive_strategy: receive_strategy ?? "ses-s3",
          forward_to: forward_to ?? null,
          provisioning_status: "requested",
          next_check_at: new Date().toISOString(),
        }, db);
        let ownership = null;
        if (owner) {
          const { setAddressOwnerByRef } = await import("../../lib/address-ownership.js");
          ownership = setAddressOwnerByRef(addr.id, owner, administrator, db);
        }

        let provisioning = getAddressProvisioning(addr.id, db);
        if (wait) {
          const { getInboundConfig } = await import("../../lib/config.js");
          const cfg = getInboundConfig();
          if (cfg.profile) process.env["AWS_PROFILE"] = cfg.profile;
          const bucket = inbound_bucket ?? cfg.bucket;
          if (!bucket) throw new Error("No inbound bucket: pass inbound_bucket or set inbound_s3_bucket");
          const { makeAddressDeps } = await import("../../lib/provision/real-deps.js");
          const { advanceAddress } = await import("../../lib/provision/orchestrator.js");
          const deps = makeAddressDeps({ provider, inboundBucket: bucket, region: cfg.region, db });
          const deadline = Date.now() + (timeout_seconds ?? 120) * 1000;
          const intervalMs = (interval_seconds ?? 5) * 1000;
          while (Date.now() < deadline) {
            provisioning = getAddressProvisioning(addr.id, db);
            if (provisioning?.provisioning_status === "ready") break;
            if (provisioning?.provisioning_status === "failed") {
              throw new Error(`Address provisioning failed: ${provisioning.last_error ?? "unknown error"}`);
            }
            const res = await advanceAddress(addr.id, deps, { db, now: new Date().toISOString() });
            provisioning = getAddressProvisioning(addr.id, db);
            if (provisioning?.provisioning_status === "ready") break;
            if (res.error || provisioning?.provisioning_status === "failed") {
              throw new Error(`Address provisioning failed: ${res.error ?? provisioning?.last_error ?? "unknown error"}`);
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
          }
          provisioning = getAddressProvisioning(addr.id, db);
          if (provisioning?.provisioning_status !== "ready") {
            throw new Error(`Timed out waiting for ${email} to become ready (current=${provisioning?.provisioning_status ?? "unknown"})`);
          }
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          id: addr.id,
          email,
          receive_strategy: receive_strategy ?? "ses-s3",
          domain_id: domainId,
          provisioning,
          ownership,
          cli_equivalent: `emails address provision ${email} --provider ${provider_id}${owner ? ` --owner ${owner}` : ""}${administrator ? ` --administrator ${administrator}` : ""}${wait ? " --wait" : ""} --json`,
        }, null, 2) }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true }; }
    },
  );

  server.tool(
    "add_forwarding_rule",
    "Create or update an app-level forwarding rule. It forwards inbound mail only after this app has received or synced the source mailbox.",
    {
      source_address: z.string().describe("Mailbox to watch, e.g. user@example.com"),
      target_address: z.string().describe("Destination for forwarded copies"),
      provider_id: z.string().optional().describe("Provider used to send forwarded copies"),
      from_address: z.string().optional().describe("From address for forwarded copies; defaults to source_address"),
      enabled: z.boolean().optional().describe("Whether the rule is enabled; default true"),
    },
    async ({ source_address, target_address, provider_id, from_address, enabled }) => {
      try {
        const providerId = provider_id ? resolveId("providers", provider_id) : null;
        const { createForwardingRule } = await import("../../db/forwarding.js");
        const rule = createForwardingRule({
          source_address,
          target_address,
          provider_id: providerId,
          from_address: from_address ?? null,
          enabled: enabled !== false,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({
          ...rule,
          cli_equivalent: `emails forwarding add ${source_address} ${target_address}${provider_id ? ` --provider ${provider_id}` : ""}${from_address ? ` --from ${from_address}` : ""}${enabled === false ? " --disabled" : ""} --json`,
        }, null, 2) }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true }; }
    },
  );

  server.tool(
    "list_forwarding_rules",
    "List app-level forwarding rules.",
    {
      source_address: z.string().optional(),
      enabled: z.boolean().optional(),
      limit: z.number().int().positive().max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async ({ source_address, enabled, limit, offset }) => {
      try {
        const { listForwardingRules } = await import("../../db/forwarding.js");
        const rules = listForwardingRules({ source_address, enabled, limit: limit ?? 50, offset: offset ?? 0 });
        return { content: [{ type: "text" as const, text: JSON.stringify({
          rules,
          cli_equivalent: `emails forwarding list${source_address ? ` --source ${source_address}` : ""}${enabled === true ? " --enabled" : enabled === false ? " --disabled" : ""}${limit ? ` --limit ${limit}` : ""}${offset ? ` --offset ${offset}` : ""} --json`,
        }, null, 2) }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true }; }
    },
  );

  server.tool(
    "run_forwarding_rules",
    "Process pending app-level forwarding rules.",
    {
      provider_id: z.string().optional(),
      from_address: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
      backfill: z.boolean().optional().describe("Also process matching messages received before the forwarding rule was created"),
    },
    async ({ provider_id, from_address, limit, backfill }) => {
      try {
        const providerId = provider_id ? resolveId("providers", provider_id) : undefined;
        const { processForwardingRules } = await import("../../lib/forwarding.js");
        const result = await processForwardingRules({ providerId, fromAddress: from_address, limit: limit ?? 100, backfill });
        return { content: [{ type: "text" as const, text: JSON.stringify({
          ...result,
          cli_equivalent: `emails forwarding run${provider_id ? ` --provider ${provider_id}` : ""}${from_address ? ` --from ${from_address}` : ""}${limit ? ` --limit ${limit}` : ""}${backfill ? " --backfill" : ""} --json`,
        }, null, 2) }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true }; }
    },
  );

  server.tool(
    "provision_status",
    "Show provisioning status of domains and their addresses.",
    {
      domain: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum domains to return"),
      offset: z.number().int().min(0).optional().describe("Number of domains to skip"),
    },
    async ({ domain, limit, offset }) => {
      try {
        const db = getDatabase();
        const { findDomainsByName, listDomains } = await import("../../db/domains.js");
        const {
          listDomainProvisioningByIds,
          listAddressProvisioningByDomains,
        } = await import("../../db/provisioning.js");
        const domains = domain ? findDomainsByName(domain, db) : listDomains(undefined, db, { limit: limit ?? 50, offset: offset ?? 0 });
        const domainIds = domains.map((d) => d.id);
        const domainProvisioning = listDomainProvisioningByIds(domainIds, db);
        const addressProvisioning = listAddressProvisioningByDomains(domainIds, db);
        const result = domains.map((d) => ({
          domain: d.domain,
          provisioning: domainProvisioning.get(d.id) ?? null,
          addresses: (addressProvisioning.get(d.id) ?? [])
            .map((a) => ({ email: a.email, provisioning: a.provisioning })),
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) { return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true }; }
    },
  );

}
