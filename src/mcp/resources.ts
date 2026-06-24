import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase, type Database } from "../db/database.js";
import { listDomains } from "../db/domains.js";
import { listAddressProvisioningByIds, listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../db/provisioning.js";
import { countValue } from "../db/scalars.js";
import { assessDomainReadiness } from "../lib/domain-readiness.js";
import { loadConfig } from "../lib/config.js";

const RECENT_ERROR_LIMIT_PER_COMPONENT = 50;
const DOMAIN_RESOURCE_LIMIT = 50;
const ADDRESS_RESOURCE_LIMIT = 100;
const AGENT_CONTEXT_SAMPLE_LIMIT = 5;

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(value, null, 2),
    }],
  };
}

function countDomains(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS count FROM domains").get() as { count: unknown } | null;
  return countValue(row?.count);
}

function countAddresses(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS count FROM addresses").get() as { count: unknown } | null;
  return countValue(row?.count);
}

export function domainsResourcePayload(db: Database = getDatabase()): Record<string, unknown> {
  const domainRows = listDomains(undefined, db, { limit: DOMAIN_RESOURCE_LIMIT + 1, offset: 0 });
  const truncated = domainRows.length > DOMAIN_RESOURCE_LIMIT;
  const visibleDomains = domainRows.slice(0, DOMAIN_RESOURCE_LIMIT);
  const domainIds = visibleDomains.map((domain) => domain.id);
  const readyAddressCounts = listReadyAddressCountsByDomains(domainIds, db);
  const domainProvisioning = listDomainProvisioningByIds(domainIds, db);
  const domains = visibleDomains.map((domain) => {
    const ready_addresses = readyAddressCounts.get(domain.id) ?? 0;
    const provisioning = domainProvisioning.get(domain.id) ?? null;
    return {
      ...domain,
      provisioning,
      readiness: assessDomainReadiness(domain, provisioning, { ready_addresses }),
    };
  });
  return {
    domains,
    total: countDomains(db),
    limit: DOMAIN_RESOURCE_LIMIT,
    truncated,
    cli_equivalent: `mailery domain status --limit ${DOMAIN_RESOURCE_LIMIT} --json`,
  };
}

export async function addressesResourcePayload(db: Database = getDatabase()): Promise<Record<string, unknown>> {
  const { listEnrichedAddresses } = await import("../lib/address-ownership.js");
  const addressRows = listEnrichedAddresses(undefined, db, { limit: ADDRESS_RESOURCE_LIMIT + 1, offset: 0 });
  const truncated = addressRows.length > ADDRESS_RESOURCE_LIMIT;
  const visibleAddresses = addressRows.slice(0, ADDRESS_RESOURCE_LIMIT);
  const addressProvisioning = listAddressProvisioningByIds(visibleAddresses.map((address) => address.id), db);
  const addresses = visibleAddresses.map((address) => ({
    ...address,
    provisioning: addressProvisioning.get(address.id) ?? null,
  }));
  return {
    addresses,
    total: countAddresses(db),
    limit: ADDRESS_RESOURCE_LIMIT,
    truncated,
    cli_equivalent: `mailery address list --limit ${ADDRESS_RESOURCE_LIMIT} --json`,
  };
}

export async function agentContextResourcePayload(db: Database = getDatabase()): Promise<Record<string, unknown>> {
  const { getAgentContext } = await import("../lib/agent-context.js");
  const context = getAgentContext(db);
  const status = context["status"] as Record<string, unknown>;
  const domains = status["domains"] as { usable?: unknown[]; usable_limit?: number; usable_truncated?: boolean } | undefined;
  const addresses = status["addresses"] as { usable_from?: Array<Record<string, unknown>>; usable_from_limit?: number; usable_from_truncated?: boolean } | undefined;
  const allUsableDomains = Array.isArray(domains?.usable) ? domains.usable : [];
  const allUsableFrom = Array.isArray(addresses?.usable_from) ? addresses.usable_from : [];
  const usableDomains = allUsableDomains.slice(0, AGENT_CONTEXT_SAMPLE_LIMIT);
  const usableFrom = allUsableFrom
    .slice(0, AGENT_CONTEXT_SAMPLE_LIMIT)
    .map((address) => ({
        id: address["id"],
        email: address["email"],
        provider_id: address["provider_id"],
        provider_name: address["provider_name"],
        owner: address["owner"],
        administrator: address["administrator"],
        status: address["status"],
        verified: address["verified"],
      }));
  return {
    status: {
      generated_at: status["generated_at"],
      database: status["database"],
      providers: status["providers"],
      domains: {
        ...(domains ?? {}),
        usable: usableDomains,
      },
      addresses: {
        ...(addresses ?? {}),
        usable_from: usableFrom,
      },
      inbox: status["inbox"],
      provisioning: status["provisioning"],
      next_actions: status["next_actions"],
      cli_equivalents: status["cli_equivalents"],
    },
    workflows: context["workflows"],
    refresh_cadence: context["refresh_cadence"],
    limits: {
      samples: AGENT_CONTEXT_SAMPLE_LIMIT,
      domain_full_limit: domains?.usable_limit ?? null,
      address_full_limit: addresses?.usable_from_limit ?? null,
    },
    truncated: {
      domains: Boolean(domains?.usable_truncated) || allUsableDomains.length > AGENT_CONTEXT_SAMPLE_LIMIT,
      addresses: Boolean(addresses?.usable_from_truncated) || allUsableFrom.length > AGENT_CONTEXT_SAMPLE_LIMIT,
    },
    full_context_resource: "emails://agent/context/full",
    full_context_cli: "mailery agent context --json",
  };
}

interface FailedDomainProvisioningRow {
  domain: string;
  last_error: string | null;
}

interface FailedAddressProvisioningRow {
  email: string;
  last_error: string | null;
}

export function recentErrorsResourcePayload(db: Database = getDatabase()): Record<string, unknown> {
  const config = loadConfig();
  const realtimeError = typeof config["inbound_realtime_last_error"] === "string"
    ? config["inbound_realtime_last_error"]
    : null;
  const domainRows = db
    .query("SELECT domain, last_error FROM domains WHERE provisioning_status = 'failed' ORDER BY updated_at DESC LIMIT ?")
    .all(RECENT_ERROR_LIMIT_PER_COMPONENT + 1) as FailedDomainProvisioningRow[];
  const addressRows = db
    .query("SELECT email, last_error FROM addresses WHERE provisioning_status = 'failed' ORDER BY updated_at DESC LIMIT ?")
    .all(RECENT_ERROR_LIMIT_PER_COMPONENT + 1) as FailedAddressProvisioningRow[];
  const domainErrorsTruncated = domainRows.length > RECENT_ERROR_LIMIT_PER_COMPONENT;
  const addressErrorsTruncated = addressRows.length > RECENT_ERROR_LIMIT_PER_COMPONENT;
  const domainErrors = domainRows
    .slice(0, RECENT_ERROR_LIMIT_PER_COMPONENT)
    .map(({ domain, last_error }) => ({
      component: "domain-provisioning",
      entity: domain,
      message: last_error ?? "domain provisioning failed",
      fix_command: `mailery provision status ${domain}`,
    }));
  const addressErrors = addressRows
    .slice(0, RECENT_ERROR_LIMIT_PER_COMPONENT)
    .map(({ email, last_error }) => ({
      component: "address-provisioning",
      entity: email,
      message: last_error ?? "address provisioning failed",
      fix_command: `mailery doctor delivery ${email}`,
    }));
  const errors = [
    realtimeError ? {
      component: "inbound-realtime",
      message: realtimeError,
      fix_command: "mailery inbox sync-status",
    } : null,
    ...domainErrors,
    ...addressErrors,
  ].filter(Boolean);
  return {
    errors,
    truncated: domainErrorsTruncated || addressErrorsTruncated,
    limits: {
      per_component: RECENT_ERROR_LIMIT_PER_COMPONENT,
    },
    truncated_components: {
      domain_provisioning: domainErrorsTruncated,
      address_provisioning: addressErrorsTruncated,
    },
    cli_equivalent: "mailery status --json",
  };
}

export function registerEmailResources(server: McpServer): void {
  server.registerResource(
    "emails-agent-context",
    "emails://agent/context",
    {
      title: "Emails Agent Context",
      description: "Redacted system snapshot and recommended CLI workflows for coding agents.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://agent/context", await agentContextResourcePayload());
    },
  );

  server.registerResource(
    "emails-agent-context-full",
    "emails://agent/context/full",
    {
      title: "Emails Agent Context Full",
      description: "Full redacted system snapshot and recommended workflows for coding agents.",
      mimeType: "application/json",
    },
    async () => {
      const { getAgentContext } = await import("../lib/agent-context.js");
      return jsonResource("emails://agent/context/full", getAgentContext());
    },
  );

  server.registerResource(
    "emails-status",
    "emails://status",
    {
      title: "Emails Status",
      description: "Redacted email system status, source health, and next actions.",
      mimeType: "application/json",
    },
    async () => {
      const { getEmailSystemStatus } = await import("../lib/agent-context.js");
      return jsonResource("emails://status", getEmailSystemStatus());
    },
  );

  server.registerResource(
    "emails-inbox-sync-status",
    "emails://inbox/sync-status",
    {
      title: "Emails Inbox Sync Status",
      description: "Inbox source status for S3, realtime queue, and Gmail sync.",
      mimeType: "application/json",
    },
    async () => {
      const { getEmailSystemStatus } = await import("../lib/agent-context.js");
      const status = getEmailSystemStatus();
      return jsonResource("emails://inbox/sync-status", {
        inbox: status.inbox,
        gmail: status.providers.gmail,
        cli_equivalents: status.cli_equivalents,
      });
    },
  );

  server.registerResource(
    "emails-domains",
    "emails://domains",
    {
      title: "Emails Domains",
      description: "Configured domains with provisioning and send/receive readiness.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://domains", domainsResourcePayload());
    },
  );

  server.registerResource(
    "emails-addresses",
    "emails://addresses",
    {
      title: "Emails Addresses",
      description: "Configured addresses with owner/admin/provider/provisioning context.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://addresses", await addressesResourcePayload());
    },
  );

  server.registerResource(
    "emails-recent-errors",
    "emails://recent-errors",
    {
      title: "Emails Recent Errors",
      description: "Recent sync, realtime, provisioning, and readiness errors.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://recent-errors", recentErrorsResourcePayload());
    },
  );
}
