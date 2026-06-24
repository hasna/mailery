import { getDatabase, getDataDir } from "../db/database.js";
import type { Database } from "../db/database.js";
import { listProviderSummaries } from "../db/providers.js";
import { getDomain, listDomains } from "../db/domains.js";
import { listUsableSendingAddresses } from "../db/addresses.js";
import { listGmailSyncStatesByProviderIds } from "../db/gmail-sync-state.js";
import { listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../db/provisioning.js";
import { countValue } from "../db/scalars.js";
import type { Domain } from "../types/index.js";
import { assessDomainReadiness } from "./domain-readiness.js";
import { getInboundBuckets, getGmailSyncConfig, loadConfig } from "./config.js";
import { enrichAddresses, type EnrichedAddress } from "./address-ownership.js";

const USABLE_FROM_LIMIT = 25;
const DOMAIN_READINESS_LIMIT = 25;

export interface EmailSystemStatus {
  generated_at: string;
  database: {
    data_dir: string;
  };
  providers: {
    total: number;
    active: number;
    by_type: Record<string, number>;
    gmail: Array<{
      id: string;
      name: string;
      synced_count: number;
      unread_count: number;
      last_synced_at: string | null;
      last_message_id: string | null;
    }>;
  };
  domains: {
    total: number;
    send_ready: number;
    receive_ready: number;
    usable: Array<{
      id: string;
      domain: string;
      provider_id: string;
      provider_name: string | null;
      state: string;
      send_ready: boolean;
      receive_ready: boolean;
      ready_addresses: number;
      issues: string[];
      fix_commands: string[];
    }>;
    usable_limit: number;
    usable_truncated: boolean;
  };
  addresses: {
    total: number;
    active: number;
    verified: number;
    owned: number;
    ready_to_receive: number;
    usable_from: EnrichedAddress[];
    usable_from_limit: number;
    usable_from_truncated: boolean;
  };
  inbox: {
    total: number;
    unread: number;
    latest_received_at: string | null;
    inbound_buckets: ReturnType<typeof getInboundBuckets>;
    realtime: {
      queue_configured: boolean;
      queue_url: string | null;
      last_poll_at: string | null;
      last_error: string | null;
    };
    gmail_attachment_storage: ReturnType<typeof getGmailSyncConfig>["attachment_storage"];
  };
  provisioning: {
    domains_pending: number;
    domains_failed: number;
    addresses_pending: number;
    addresses_failed: number;
  };
  next_actions: string[];
  cli_equivalents: Record<string, string>;
}

type AgentProviderSummary = ReturnType<typeof listProviderSummaries>[number];

function countByType(providers: AgentProviderSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const provider of providers) counts[provider.type] = (counts[provider.type] ?? 0) + 1;
  return counts;
}

function gmailProviderStatuses(providers: AgentProviderSummary[], db: Database): EmailSystemStatus["providers"]["gmail"] {
  const gmailProviders = providers.filter((provider) => provider.type === "gmail");
  const providerIds = gmailProviders.map((provider) => provider.id);
  const states = listGmailSyncStatesByProviderIds(providerIds, db);
  const counts = new Map<string, { synced_count: number; unread_count: number }>(
    providerIds.map((providerId) => [providerId, { synced_count: 0, unread_count: 0 }]),
  );

  if (providerIds.length > 0) {
    const placeholders = providerIds.map(() => "?").join(", ");
    const rows = db.query(
      `SELECT
         provider_id,
         COUNT(*) AS synced_count,
         COALESCE(SUM(CASE WHEN is_sent = 0 AND is_read = 0 AND is_archived = 0 THEN 1 ELSE 0 END), 0) AS unread_count
       FROM inbound_emails
       WHERE provider_id IN (${placeholders})
       GROUP BY provider_id`,
    ).all(...providerIds) as Array<{ provider_id: string; synced_count: unknown; unread_count: unknown }>;
    for (const row of rows) {
      counts.set(row.provider_id, {
        synced_count: countValue(row.synced_count),
        unread_count: countValue(row.unread_count),
      });
    }
  }

  return gmailProviders.map((provider) => {
    const state = states.get(provider.id);
    const providerCounts = counts.get(provider.id) ?? { synced_count: 0, unread_count: 0 };
    return {
      id: provider.id,
      name: provider.name,
      synced_count: providerCounts.synced_count,
      unread_count: providerCounts.unread_count,
      last_synced_at: state?.last_synced_at ?? null,
      last_message_id: state?.last_message_id ?? null,
    };
  });
}

interface AddressSummaryRow {
  total: unknown;
  active: unknown;
  verified: unknown;
  owned: unknown;
  ready_to_receive: unknown;
}

function addressSummary(db: Database): { total: number; active: number; verified: number; owned: number; ready_to_receive: number } {
  const row = db
    .query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN COALESCE(status, 'active') != 'suspended' THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) AS verified,
         COALESCE(SUM(CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS owned,
         COALESCE(SUM(CASE WHEN provisioning_status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_to_receive
       FROM addresses`,
    )
    .get() as AddressSummaryRow | null;
  return {
    total: countValue(row?.total),
    active: countValue(row?.active),
    verified: countValue(row?.verified),
    owned: countValue(row?.owned),
    ready_to_receive: countValue(row?.ready_to_receive),
  };
}

interface ProvisioningSummaryRow {
  domains_pending: unknown;
  domains_failed: unknown;
  addresses_pending: unknown;
  addresses_failed: unknown;
}

function provisioningSummary(db: Database): EmailSystemStatus["provisioning"] {
  const domainRow = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN provisioning_status NOT IN ('ready', 'failed', 'none') THEN 1 ELSE 0 END), 0) AS domains_pending,
         COALESCE(SUM(CASE WHEN provisioning_status = 'failed' THEN 1 ELSE 0 END), 0) AS domains_failed
       FROM domains`,
    )
    .get() as Pick<ProvisioningSummaryRow, "domains_pending" | "domains_failed"> | null;
  const addressRow = db
    .query(
      `SELECT
         COALESCE(SUM(CASE WHEN provisioning_status NOT IN ('ready', 'failed', 'none') THEN 1 ELSE 0 END), 0) AS addresses_pending,
         COALESCE(SUM(CASE WHEN provisioning_status = 'failed' THEN 1 ELSE 0 END), 0) AS addresses_failed
       FROM addresses`,
    )
    .get() as Pick<ProvisioningSummaryRow, "addresses_pending" | "addresses_failed"> | null;
  return {
    domains_pending: countValue(domainRow?.domains_pending),
    domains_failed: countValue(domainRow?.domains_failed),
    addresses_pending: countValue(addressRow?.addresses_pending),
    addresses_failed: countValue(addressRow?.addresses_failed),
  };
}

interface DomainSummaryRow {
  total: unknown;
  send_ready: unknown;
  receive_ready: unknown;
}

function domainSummary(db: Database): { total: number; send_ready: number; receive_ready: number } {
  const row = db
    .query(
      `WITH ready_counts AS (
         SELECT domain_id, COUNT(*) AS ready_addresses
         FROM addresses
         WHERE domain_id IS NOT NULL AND provisioning_status = 'ready'
         GROUP BY domain_id
       )
       SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE
           WHEN d.dkim_status = 'verified'
            AND d.spf_status = 'verified'
            AND COALESCE(d.dmarc_status, 'pending') != 'failed'
            AND NULLIF(d.last_error, '') IS NULL
           THEN 1 ELSE 0 END), 0) AS send_ready,
         COALESCE(SUM(CASE
           WHEN COALESCE(rc.ready_addresses, 0) > 0
             OR (
               d.provisioning_status IN ('ready', 'inbound_ready')
               AND d.dkim_status != 'failed'
               AND d.spf_status != 'failed'
               AND d.dmarc_status != 'failed'
               AND NULLIF(d.last_error, '') IS NULL
             )
           THEN 1 ELSE 0 END), 0) AS receive_ready
       FROM domains d
       LEFT JOIN ready_counts rc ON rc.domain_id = d.id`,
    )
    .get() as DomainSummaryRow | null;
  return {
    total: countValue(row?.total),
    send_ready: countValue(row?.send_ready),
    receive_ready: countValue(row?.receive_ready),
  };
}

interface InboxSummaryRow {
  total: unknown;
  unread: unknown;
  latest_received_at: string | null;
}

function inboxSummary(db: Database): { total: number; unread: number; latest_received_at: string | null } {
  const row = db
    .query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN is_read = 0 AND is_archived = 0 THEN 1 ELSE 0 END), 0) AS unread,
         MAX(received_at) AS latest_received_at
       FROM inbound_emails
       WHERE is_sent = 0`,
    )
    .get() as InboxSummaryRow | null;
  return {
    total: countValue(row?.total),
    unread: countValue(row?.unread),
    latest_received_at: row?.latest_received_at ?? null,
  };
}

function buildDomainReadiness(
  domains: Domain[],
  providersById: Map<string, AgentProviderSummary>,
  db: Database,
): EmailSystemStatus["domains"]["usable"] {
  const domainIds = domains.map((domain) => domain.id);
  const domainProvisioning = listDomainProvisioningByIds(domainIds, db);
  const readyAddressesByDomain = listReadyAddressCountsByDomains(domainIds, db);
  return domains.map((domain) => {
    const readiness = assessDomainReadiness(domain, domainProvisioning.get(domain.id) ?? null, {
      ready_addresses: readyAddressesByDomain.get(domain.id) ?? 0,
    });
    return {
      id: domain.id,
      domain: domain.domain,
      provider_id: domain.provider_id,
      provider_name: providersById.get(domain.provider_id)?.name ?? null,
      state: readiness.state,
      send_ready: readiness.send_ready,
      receive_ready: readiness.receive_ready,
      ready_addresses: readiness.ready_addresses,
      issues: readiness.issues,
      fix_commands: readiness.fix_commands,
    };
  });
}

function firstDomainFixCommand(
  providersById: Map<string, AgentProviderSummary>,
  db: Database,
): string | null {
  const row = db
    .query(
      `WITH ready_counts AS (
         SELECT domain_id, COUNT(*) AS ready_addresses
         FROM addresses
         WHERE domain_id IS NOT NULL AND provisioning_status = 'ready'
         GROUP BY domain_id
       )
       SELECT d.id
       FROM domains d
       LEFT JOIN ready_counts rc ON rc.domain_id = d.id
       WHERE
         d.dkim_status = 'failed'
         OR d.spf_status = 'failed'
         OR d.dmarc_status = 'failed'
         OR NULLIF(d.last_error, '') IS NOT NULL
         OR NOT (d.dkim_status = 'verified' AND d.spf_status = 'verified')
         OR NOT (
           COALESCE(rc.ready_addresses, 0) > 0
           OR (
             d.provisioning_status IN ('ready', 'inbound_ready')
             AND d.dkim_status != 'failed'
             AND d.spf_status != 'failed'
             AND d.dmarc_status != 'failed'
             AND NULLIF(d.last_error, '') IS NULL
           )
         )
       ORDER BY d.created_at DESC
       LIMIT 1`,
    )
    .get() as { id: string } | null;
  if (!row) return null;
  const domain = getDomain(row.id, db);
  if (!domain) return null;
  return buildDomainReadiness([domain], providersById, db)[0]?.fix_commands[0] ?? null;
}

export function getEmailSystemStatus(db: Database = getDatabase()): EmailSystemStatus {
  const providers = listProviderSummaries(db);
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const config = loadConfig();
  const inboundBuckets = getInboundBuckets();
  const inboxCounts = inboxSummary(db);
  const domainCounts = domainSummary(db);
  const addressCounts = addressSummary(db);
  const usableSenderRows = listUsableSendingAddresses(db, { limit: USABLE_FROM_LIMIT + 1 });
  const usableFromTruncated = usableSenderRows.length > USABLE_FROM_LIMIT;
  const usableFrom = enrichAddresses(usableSenderRows.slice(0, USABLE_FROM_LIMIT), db);
  const domainRows = listDomains(undefined, db, { limit: DOMAIN_READINESS_LIMIT + 1, offset: 0 });
  const domainReadinessTruncated = domainRows.length > DOMAIN_READINESS_LIMIT;
  const domainReadiness = buildDomainReadiness(domainRows.slice(0, DOMAIN_READINESS_LIMIT), providersById, db);

  const gmail = gmailProviderStatuses(providers, db);

  const provisioningRows = provisioningSummary(db);

  const nextActions: string[] = [];
  if (providers.length === 0) nextActions.push("mailery provider add --help");
  if (domainCounts.total === 0) nextActions.push("mailery domain add --help");
  if (addressCounts.total === 0) nextActions.push("mailery address add --help");
  if (inboundBuckets.length === 0 && gmail.length === 0) nextActions.push("mailery inbox sync-status");
  const domainFixCommand = firstDomainFixCommand(providersById, db);
  if (domainFixCommand) nextActions.push(domainFixCommand);
  if (provisioningRows.addresses_failed > 0 || provisioningRows.domains_failed > 0) nextActions.push("mailery provision status");

  return {
    generated_at: new Date().toISOString(),
    database: {
      data_dir: getDataDir(),
    },
    providers: {
      total: providers.length,
      active: providers.filter((provider) => provider.active).length,
      by_type: countByType(providers),
      gmail,
    },
    domains: {
      total: domainCounts.total,
      send_ready: domainCounts.send_ready,
      receive_ready: domainCounts.receive_ready,
      usable: domainReadiness,
      usable_limit: DOMAIN_READINESS_LIMIT,
      usable_truncated: domainReadinessTruncated,
    },
    addresses: {
      total: addressCounts.total,
      active: addressCounts.active,
      verified: addressCounts.verified,
      owned: addressCounts.owned,
      ready_to_receive: addressCounts.ready_to_receive,
      usable_from: usableFrom,
      usable_from_limit: USABLE_FROM_LIMIT,
      usable_from_truncated: usableFromTruncated,
    },
    inbox: {
      total: inboxCounts.total,
      unread: inboxCounts.unread,
      latest_received_at: inboxCounts.latest_received_at,
      inbound_buckets: inboundBuckets,
      realtime: {
        queue_configured: typeof config["inbound_realtime_queue_url"] === "string",
        queue_url: typeof config["inbound_realtime_queue_url"] === "string" ? config["inbound_realtime_queue_url"] : null,
        last_poll_at: typeof config["inbound_realtime_last_poll_at"] === "string" ? config["inbound_realtime_last_poll_at"] : null,
        last_error: typeof config["inbound_realtime_last_error"] === "string" ? config["inbound_realtime_last_error"] : null,
      },
      gmail_attachment_storage: getGmailSyncConfig().attachment_storage,
    },
    provisioning: provisioningRows,
    next_actions: [...new Set(nextActions)].slice(0, 5),
    cli_equivalents: {
      status: "mailery status --json",
      inbox_sync_status: "mailery inbox sync-status --json",
      provision_address: "mailery address provision <email> --provider <provider>",
      wait_code: "mailery inbox wait-code <address> --timeout 120",
      address_owner: "mailery address owner <email-or-id>",
    },
  };
}

export function formatEmailSystemStatus(status: EmailSystemStatus): string {
  const lines: string[] = [];
  lines.push("Email system status");
  lines.push(`  Providers: ${status.providers.active}/${status.providers.total} active`);
  lines.push(`  Domains:   ${status.domains.send_ready} send-ready, ${status.domains.receive_ready} receive-ready, ${status.domains.total} total`);
  const usableFromLabel = status.addresses.usable_from_truncated
    ? `${status.addresses.usable_from.length}+ listed`
    : `${status.addresses.usable_from.length} listed`;
  lines.push(`  Addresses: ${status.addresses.active}/${status.addresses.total} active, ${status.addresses.owned} owned, ${status.addresses.verified} verified, ${usableFromLabel} usable sender(s)`);
  lines.push(`  Inbox:     ${status.inbox.total} total, ${status.inbox.unread} unread${status.inbox.latest_received_at ? `, latest ${status.inbox.latest_received_at}` : ""}`);
  lines.push(`  Sources:   ${status.inbox.inbound_buckets.length} S3 bucket(s), ${status.providers.gmail.length} Gmail provider(s), realtime ${status.inbox.realtime.queue_configured ? "configured" : "not configured"}`);
  if (status.inbox.realtime.last_error) lines.push(`  Last realtime error: ${status.inbox.realtime.last_error}`);
  if (status.provisioning.domains_failed || status.provisioning.addresses_failed) {
    lines.push(`  Provisioning failures: ${status.provisioning.domains_failed} domain(s), ${status.provisioning.addresses_failed} address(es)`);
  }
  if (status.next_actions.length > 0) {
    lines.push("");
    lines.push("Next actions:");
    for (const action of status.next_actions) lines.push(`  ${action}`);
  }
  return lines.join("\n");
}

export function formatAgentContextSummary(context: Record<string, unknown>): string {
  const status = context["status"] as EmailSystemStatus | undefined;
  if (!status) return JSON.stringify(context, null, 2);

  const workflows = context["workflows"] as Record<string, unknown> | undefined;
  const workflowNames = workflows ? Object.keys(workflows) : [];
  const lines: string[] = [formatEmailSystemStatus(status)];
  lines.push("");
  lines.push("Agent context summary");
  lines.push(`  Workflows: ${workflowNames.length ? workflowNames.join(", ") : "none"}`);
  lines.push(`  Readiness: ${status.domains.send_ready}/${status.domains.total} send-ready domains, ${status.addresses.ready_to_receive}/${status.addresses.total} receive-ready addresses`);
  if (status.domains.usable.length > 0) {
    lines.push("  Usable domains:");
    for (const domain of status.domains.usable.slice(0, 5)) {
      lines.push(`    ${domain.domain} ${domain.state} send=${domain.send_ready ? "yes" : "no"} receive=${domain.receive_ready ? "yes" : "no"}`);
    }
    if (status.domains.usable.length > 5 || status.domains.usable_truncated) {
      lines.push(`    ... use mailery domain status --limit ${status.domains.usable_limit} for the full readiness table`);
    }
  }
  if (status.addresses.usable_from.length > 0) {
    lines.push("  Usable from-addresses:");
    for (const address of status.addresses.usable_from.slice(0, 5)) {
      const owner = address.owner ? ` owner=${address.owner.name}` : "";
      lines.push(`    ${address.email}${owner}`);
    }
    if (status.addresses.usable_from.length > 5 || status.addresses.usable_from_truncated) {
      lines.push(`    ... use mailery address list --limit ${status.addresses.usable_from_limit} for more addresses`);
    }
  }
  lines.push("");
  lines.push("Details: use mailery agent context --verbose or mailery agent context --json for the full redacted snapshot.");
  return lines.join("\n");
}

export function getAgentContext(db: Database = getDatabase()): Record<string, unknown> {
  const status = getEmailSystemStatus(db);
  return {
    status,
    workflows: {
      create_receive_address: [
        "mailery owner register <name> --type agent",
        "mailery address provision <email> --provider <provider> --owner <agent>",
        "mailery inbox wait-code <email> --timeout 120",
      ],
      diagnose_missing_mail: [
        "mailery status",
        "mailery inbox sync-status",
        "mailery inbox explain <email-id>",
        "mailery doctor delivery <address>",
      ],
      ownership: [
        "mailery address owner <email-or-id>",
        "mailery address set-owner <email-or-id> --owner <owner> --administrator <agent>",
      ],
    },
    refresh_cadence: {
      ui_local_reload_ms: 30000,
      ui_s3_pull_ms: 45000,
      ui_gmail_pull_ms: 120000,
      realtime_watch_command: "mailery inbox watch --all-buckets",
    },
  };
}

export function getNextEmailAction(goal?: string, db: Database = getDatabase()): Record<string, unknown> {
  const status = getEmailSystemStatus(db);
  const normalized = goal?.toLowerCase() ?? "";
  if (normalized.includes("code") || normalized.includes("verification")) {
    return {
      command: "mailery inbox wait-code <address> --timeout 120",
      reason: "Wait-code refreshes inbound S3 by default and extracts the latest matching code.",
      status,
    };
  }
  if (normalized.includes("owner")) {
    return {
      command: "mailery address owner <email-or-id>",
      reason: "Address ownership is stored on the address row and enriched with owner/admin records.",
      status,
    };
  }
  return {
    command: status.next_actions[0] ?? "mailery status",
    reason: status.next_actions.length > 0 ? "This is the first unresolved setup or health action." : "The system has no obvious setup gaps.",
    status,
  };
}
