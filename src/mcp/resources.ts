import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase, type Database } from "../db/database.js";
import { listAddresses } from "../db/addresses.js";
import { listDomains } from "../db/domains.js";
import { listAddressProvisioningByIds, listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../db/provisioning.js";
import { countValue } from "../db/scalars.js";
import { isSelfHostedMode } from "../db/self-hosted-store.js";
import { assessDomainReadiness } from "../lib/domain-readiness.js";
import { domainInboundReadinessSignals } from "../lib/domain-inbound-evidence.js";
import { loadConfig } from "../lib/config.js";
import { resolveEmailsMode } from "../lib/mode.js";
import { resolveMailDataSource } from "../lib/mail-data-source.js";
import { listMailboxSources, listMailboxStatus } from "../cli/tui/data.js";

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

function selfHostedSelected(): boolean {
  try {
    return isSelfHostedMode();
  } catch {
    return process.env["EMAILS_MODE"]?.trim() === "self_hosted"
      || process.env["HASNA_EMAILS_MODE"]?.trim() === "self_hosted";
  }
}

function selfHostedApiStatus(error?: unknown): Record<string, unknown> {
  return {
    available: error === undefined,
    error: error instanceof Error ? error.message : (error === undefined ? null : String(error)),
  };
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
    const mode = resolveEmailsMode();
    return {
      ...domain,
      provisioning,
      readiness: assessDomainReadiness(domain, provisioning, {
        ...domainInboundReadinessSignals(domain, mode),
        ready_addresses,
      }),
    };
  });
  return {
    domains,
    total: countDomains(db),
    limit: DOMAIN_RESOURCE_LIMIT,
    truncated,
    mode: "local",
    source: "local_sqlite",
    cli_equivalent: `emails domain status --limit ${DOMAIN_RESOURCE_LIMIT} --json`,
  };
}

export function domainsResourcePayloadForRuntime(db?: Database): Record<string, unknown> {
  if (!selfHostedSelected()) return domainsResourcePayload(db ?? getDatabase());

  try {
    const mode = resolveEmailsMode();
    const domainRows = listDomains(undefined, undefined, { limit: DOMAIN_RESOURCE_LIMIT + 1, offset: 0 });
    const truncated = domainRows.length > DOMAIN_RESOURCE_LIMIT;
    const domains = domainRows.slice(0, DOMAIN_RESOURCE_LIMIT).map((domain) => ({
      ...domain,
      provisioning: null,
      readiness: assessDomainReadiness(domain, null, {
        ...domainInboundReadinessSignals(domain, mode),
        ready_addresses: 0,
      }),
    }));
    return {
      domains,
      total: null,
      total_source: "unavailable_without_api_count",
      limit: DOMAIN_RESOURCE_LIMIT,
      truncated,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(),
      cli_equivalent: `emails domain status --limit ${DOMAIN_RESOURCE_LIMIT} --json`,
    };
  } catch (error) {
    return {
      domains: [],
      total: 0,
      limit: DOMAIN_RESOURCE_LIMIT,
      truncated: false,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(error),
      note: "Self-hosted API domain resource data is unavailable; no local database or config state was read.",
      cli_equivalent: `emails domain status --limit ${DOMAIN_RESOURCE_LIMIT} --json`,
    };
  }
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
    mode: "local",
    source: "local_sqlite",
    cli_equivalent: `emails address list --limit ${ADDRESS_RESOURCE_LIMIT} --json`,
  };
}

export async function addressesResourcePayloadForRuntime(db?: Database): Promise<Record<string, unknown>> {
  if (!selfHostedSelected()) return await addressesResourcePayload(db ?? getDatabase());

  try {
    const addressRows = listAddresses(undefined, undefined, { limit: ADDRESS_RESOURCE_LIMIT + 1, offset: 0 });
    const truncated = addressRows.length > ADDRESS_RESOURCE_LIMIT;
    const addresses = addressRows.slice(0, ADDRESS_RESOURCE_LIMIT).map((address) => ({
      ...address,
      provider_name: null,
      owner: null,
      administrator: null,
      provisioning: null,
    }));
    return {
      addresses,
      total: null,
      total_source: "unavailable_without_api_count",
      limit: ADDRESS_RESOURCE_LIMIT,
      truncated,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(),
      cli_equivalent: `emails address list --limit ${ADDRESS_RESOURCE_LIMIT} --json`,
    };
  } catch (error) {
    return {
      addresses: [],
      total: 0,
      limit: ADDRESS_RESOURCE_LIMIT,
      truncated: false,
      mode: "self_hosted",
      source: "self_hosted_api",
      api: selfHostedApiStatus(error),
      note: "Self-hosted API address resource data is unavailable; no local database or config state was read.",
      cli_equivalent: `emails address list --limit ${ADDRESS_RESOURCE_LIMIT} --json`,
    };
  }
}

export async function agentContextResourcePayload(db?: Database): Promise<Record<string, unknown>> {
  const { getAgentContextForRuntime } = await import("../lib/agent-context.js");
  const context = await getAgentContextForRuntime(db);
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
      mailboxes: status["mailboxes"],
      sources: status["sources"],
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
    full_context_cli: "emails agent context --json",
  };
}

export function mailboxesResourcePayload(db: Database = getDatabase()): Record<string, unknown> {
  return {
    ...listMailboxStatus(undefined, db),
    cli_equivalent: "emails inbox mailboxes --json",
  };
}

export async function mailboxesResourcePayloadForRuntime(db?: Database): Promise<Record<string, unknown>> {
  const ds = resolveMailDataSource();
  if (ds.mode === "local" && db) return mailboxesResourcePayload(db);
  return {
    ...(await ds.listMailboxStatus()),
    cli_equivalent: "emails inbox mailboxes --json",
  };
}

export function sourcesResourcePayload(db: Database = getDatabase()): Record<string, unknown> {
  return {
    sources: listMailboxSources({ limit: 100 }, db),
    cli_equivalent: "emails inbox sources --json",
  };
}

export async function sourcesResourcePayloadForRuntime(db?: Database): Promise<Record<string, unknown>> {
  const ds = resolveMailDataSource();
  if (ds.mode === "local" && db) return sourcesResourcePayload(db);
  return {
    sources: await ds.listMailboxSources({ limit: 100 }),
    cli_equivalent: "emails inbox sources --json",
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
      fix_command: `emails provision status ${domain}`,
    }));
  const addressErrors = addressRows
    .slice(0, RECENT_ERROR_LIMIT_PER_COMPONENT)
    .map(({ email, last_error }) => ({
      component: "address-provisioning",
      entity: email,
      message: last_error ?? "address provisioning failed",
      fix_command: `emails doctor delivery ${email}`,
    }));
  const errors = [
    realtimeError ? {
      component: "inbound-realtime",
      message: realtimeError,
      fix_command: "emails inbox sync-status",
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
    mode: "local",
    source: "local_sqlite",
    cli_equivalent: "emails status --json",
  };
}

export function recentErrorsResourcePayloadForRuntime(db?: Database): Record<string, unknown> {
  if (!selfHostedSelected()) return recentErrorsResourcePayload(db ?? getDatabase());
  return {
    errors: [],
    truncated: false,
    limits: {
      per_component: RECENT_ERROR_LIMIT_PER_COMPONENT,
    },
    truncated_components: {
      domain_provisioning: false,
      address_provisioning: false,
    },
    mode: "self_hosted",
    source: "self_hosted_api",
    api: {
      available: false,
      error: null,
    },
    note: "No self-hosted API endpoint currently exposes provisioning/realtime error history; no local database or config state was read.",
    cli_equivalent: "emails status --json",
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
      const { getAgentContextForRuntime } = await import("../lib/agent-context.js");
      return jsonResource("emails://agent/context/full", await getAgentContextForRuntime());
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
      const { getEmailSystemStatusForRuntime } = await import("../lib/agent-context.js");
      return jsonResource("emails://status", await getEmailSystemStatusForRuntime());
    },
  );

  server.registerResource(
    "emails-inbox-sync-status",
    "emails://inbox/sync-status",
    {
      title: "Emails Inbox Sync Status",
      description: "Inbox source status for S3 ingestion, realtime queue, and local mailbox sources.",
      mimeType: "application/json",
    },
    async () => {
      const { getEmailSystemStatusForRuntime } = await import("../lib/agent-context.js");
      const status = await getEmailSystemStatusForRuntime();
      return jsonResource("emails://inbox/sync-status", {
        inbox: status.inbox,
        mailboxes: status.mailboxes,
        sources: status.sources,
        cli_equivalents: status.cli_equivalents,
      });
    },
  );

  server.registerResource(
    "emails-mailboxes",
    "emails://mailboxes",
    {
      title: "Emails Mailboxes",
      description: "Folder counts for the active mailbox source of truth.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://mailboxes", await mailboxesResourcePayloadForRuntime());
    },
  );

  server.registerResource(
    "emails-sources",
    "emails://sources",
    {
      title: "Emails Sources",
      description: "Ingestion streams with source-aware counts and legacy/orphaned badges.",
      mimeType: "application/json",
    },
    async () => {
      return jsonResource("emails://sources", await sourcesResourcePayloadForRuntime());
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
      return jsonResource("emails://domains", domainsResourcePayloadForRuntime());
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
      return jsonResource("emails://addresses", await addressesResourcePayloadForRuntime());
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
      return jsonResource("emails://recent-errors", recentErrorsResourcePayloadForRuntime());
    },
  );
}
