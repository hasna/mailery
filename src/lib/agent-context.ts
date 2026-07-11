import { getDatabase, getDataDir } from "../db/database.js";
import type { Database } from "../db/database.js";
import { listProviderSummaries } from "../db/providers.js";
import { listDomains } from "../db/domains.js";
import { listUsableSendingAddresses } from "../db/addresses.js";
import { listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../db/provisioning.js";
import { countValue } from "../db/scalars.js";
import type { Domain } from "../types/index.js";
import { assessDomainReadiness } from "./domain-readiness.js";
import { domainInboundReadinessSignals } from "./domain-inbound-evidence.js";
import { getInboundBuckets, loadConfig } from "./config.js";
import { enrichAddresses, type EnrichedAddress } from "./address-ownership.js";
import { resolveMailDataSource } from "./mail-data-source.js";
import { resolveEmailsMode, type EmailsMode, type EmailsModeLabel, type EmailsModeSource } from "./mode.js";
import {
  listMailboxSources,
  listMailboxStatus,
  type MailboxSourceSummary,
  type MailboxStatusSummary,
} from "../cli/tui/data.js";

const USABLE_FROM_LIMIT = 25;
const DOMAIN_READINESS_LIMIT = 25;
const SOURCE_STATUS_LIMIT = 50;

export interface EmailSystemStatus {
  generated_at: string;
  mode: {
    current: EmailsMode;
    label: EmailsModeLabel;
    source: EmailsModeSource;
    warning: string | null;
  };
  database: {
    data_dir: string;
  };
  providers: {
    total: number;
    active: number;
    by_type: Record<string, number>;
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
  };
  mailboxes: MailboxStatusSummary;
  sources: {
    total: number;
    active: number;
    legacy: number;
    orphaned: number;
    items: MailboxSourceSummary[];
    limit: number;
    truncated: boolean;
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

function domainSummary(db: Database): { total: number; send_ready: number; receive_ready: number } {
  const domains = listDomains(undefined, db);
  const domainIds = domains.map((domain) => domain.id);
  const domainProvisioning = listDomainProvisioningByIds(domainIds, db);
  const readyAddressesByDomain = listReadyAddressCountsByDomains(domainIds, db);
  const mode = resolveEmailsMode();
  let sendReady = 0;
  let receiveReady = 0;
  for (const domain of domains) {
    const readiness = assessDomainReadiness(domain, domainProvisioning.get(domain.id) ?? null, {
      ...domainInboundReadinessSignals(domain, mode),
      ready_addresses: readyAddressesByDomain.get(domain.id) ?? 0,
    });
    if (readiness.send_ready) sendReady += 1;
    if (readiness.receive_ready) receiveReady += 1;
  }
  return {
    total: domains.length,
    send_ready: sendReady,
    receive_ready: receiveReady,
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
  const mode = resolveEmailsMode();
  return domains.map((domain) => {
    const readiness = assessDomainReadiness(domain, domainProvisioning.get(domain.id) ?? null, {
      ...domainInboundReadinessSignals(domain, mode),
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
  for (const domain of buildDomainReadiness(listDomains(undefined, db), providersById, db)) {
    const command = domain.fix_commands[0];
    if (command) return command;
  }
  return null;
}

export function getEmailSystemStatus(db: Database = getDatabase()): EmailSystemStatus {
  const mode = resolveEmailsMode();
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

  const mailboxStatus = listMailboxStatus(undefined, db);
  const sourceRows = listMailboxSources({ limit: Math.max(SOURCE_STATUS_LIMIT + 1, 1000) }, db);
  const countedSources = sourceRows.filter((source) => source.kind !== "all");
  const sourcesTruncated = countedSources.length > SOURCE_STATUS_LIMIT;
  const visibleSources = sourceRows.slice(0, SOURCE_STATUS_LIMIT);

  const provisioningRows = provisioningSummary(db);

  const nextActions: string[] = [];
  if (providers.length === 0) nextActions.push("emails provider add --help");
  if (domainCounts.total === 0) nextActions.push("emails domain add --help");
  if (addressCounts.total === 0) nextActions.push("emails address add --help");
  if (visibleSources.filter((source) => source.kind !== "all").length === 0) nextActions.push("emails inbox sync-status");
  const domainFixCommand = firstDomainFixCommand(providersById, db);
  if (domainFixCommand) nextActions.push(domainFixCommand);
  if (provisioningRows.addresses_failed > 0 || provisioningRows.domains_failed > 0) nextActions.push("emails provision status");

  return {
    generated_at: new Date().toISOString(),
    mode: {
      current: mode.mode,
      label: mode.label,
      source: mode.source,
      warning: mode.warning,
    },
    database: {
      data_dir: getDataDir(),
    },
    providers: {
      total: providers.length,
      active: providers.filter((provider) => provider.active).length,
      by_type: countByType(providers),
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
    },
    mailboxes: mailboxStatus,
    sources: {
      total: countedSources.length,
      active: countedSources.filter((source) => source.badges.includes("active") || source.badges.includes("configured")).length,
      legacy: countedSources.filter((source) => source.badges.includes("legacy")).length,
      orphaned: countedSources.filter((source) => source.badges.includes("orphaned")).length,
      items: visibleSources,
      limit: SOURCE_STATUS_LIMIT,
      truncated: sourcesTruncated,
    },
    provisioning: provisioningRows,
    next_actions: [...new Set(nextActions)].slice(0, 5),
    cli_equivalents: {
      status: "emails status --json",
      inbox_sync_status: "emails inbox sync-status --json",
      provision_address: "emails address provision <email> --provider <provider>",
      wait_code: "emails inbox wait-code <address> --timeout 120",
      address_owner: "emails address owner <email-or-id>",
    },
  };
}

// The runtime status backs `emails status`, `emails agent context`, and the MCP
// status resources/tools. In self_hosted mode the inbox/mailbox/source reads must come from
// the API (not the empty local DB), so route those specific reads through the seam.
// Provider/domain/address/provisioning state stays local — that is local config, not
// message data. In local mode the seam resolves to SQLite, so the result is unchanged.
export async function getEmailSystemStatusForRuntime(
  db: Database = getDatabase(),
): Promise<EmailSystemStatus> {
  const status = getEmailSystemStatus(db);
  const ds = resolveMailDataSource();
  if (ds.mode !== "self_hosted") return status;

  const [counts, mailboxes, sources] = await Promise.all([
    ds.mailboxCounts(),
    ds.listMailboxStatus(),
    ds.listMailboxSources({ limit: Math.max(SOURCE_STATUS_LIMIT + 1, 1000), includeLatest: false }),
  ]);
  const receivedTotal = counts.inbox + counts.archived + counts.spam + counts.trash;
  return {
    ...status,
    inbox: {
      ...status.inbox,
      total: receivedTotal,
      unread: counts.unread,
    },
    mailboxes,
    sources: {
      total: sources.length,
      active: sources.length,
      legacy: 0,
      orphaned: 0,
      items: sources.slice(0, SOURCE_STATUS_LIMIT),
      limit: SOURCE_STATUS_LIMIT,
      truncated: sources.length > SOURCE_STATUS_LIMIT,
    },
  };
}

export function formatEmailSystemStatus(status: EmailSystemStatus): string {
  const lines: string[] = [];
  lines.push("Email system status");
  lines.push(`  Mode:       ${status.mode.current} (${status.mode.label})`);
  if (status.mode.warning) lines.push(`  Mode note:  ${status.mode.warning}`);
  lines.push(`  Capabilities: ${status.providers.active}/${status.providers.total} active provider credential(s)`);
  lines.push(`  Domains:   ${status.domains.send_ready} send-ready, ${status.domains.receive_ready} receive-ready, ${status.domains.total} total`);
  const usableFromLabel = status.addresses.usable_from_truncated
    ? `${status.addresses.usable_from.length}+ listed`
    : `${status.addresses.usable_from.length} listed`;
  lines.push(`  Addresses: ${status.addresses.active}/${status.addresses.total} active, ${status.addresses.owned} owned, ${status.addresses.verified} verified, ${usableFromLabel} usable sender(s)`);
  lines.push(`  Mailboxes: ${status.mailboxes.counts.inbox} inbox, ${status.mailboxes.counts.unread} unread, ${status.mailboxes.counts.sent} sent`);
  lines.push(`  Inbox:     ${status.inbox.total} total, ${status.inbox.unread} unread${status.inbox.latest_received_at ? `, latest ${status.inbox.latest_received_at}` : ""}`);
  lines.push(`  Sources:   ${status.sources.total} ingestion source(s), ${status.sources.legacy} legacy, ${status.sources.orphaned} orphaned, realtime ${status.inbox.realtime.queue_configured ? "configured" : "not configured"}`);
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
      lines.push(`    ... use emails domain status --limit ${status.domains.usable_limit} for the full readiness table`);
    }
  }
  if (status.addresses.usable_from.length > 0) {
    lines.push("  Usable from-addresses:");
    for (const address of status.addresses.usable_from.slice(0, 5)) {
      const owner = address.owner ? ` owner=${address.owner.name}` : "";
      lines.push(`    ${address.email}${owner}`);
    }
    if (status.addresses.usable_from.length > 5 || status.addresses.usable_from_truncated) {
      lines.push(`    ... use emails address list --limit ${status.addresses.usable_from_limit} for more addresses`);
    }
  }
  lines.push("");
  lines.push("Details: use emails agent context --verbose or emails agent context --json for the full redacted snapshot.");
  return lines.join("\n");
}

function buildAgentContext(status: EmailSystemStatus): Record<string, unknown> {
  return {
    status,
    workflows: {
      create_receive_address: [
        "emails owner register <name> --type agent",
        "emails address provision <email> --provider <provider> --owner <agent>",
        "emails inbox wait-code <email> --timeout 120",
      ],
      diagnose_missing_mail: [
        "emails status",
        "emails inbox sync-status",
        "emails inbox explain <email-id>",
        "emails doctor delivery <address>",
      ],
      ownership: [
        "emails address owner <email-or-id>",
        "emails address set-owner <email-or-id> --owner <owner> --administrator <agent>",
      ],
    },
    refresh_cadence: {
      ui_local_reload_ms: 30000,
      ui_s3_pull_ms: 45000,
      realtime_watch_command: "emails inbox watch --all-buckets",
    },
  };
}

export function getAgentContext(db: Database = getDatabase()): Record<string, unknown> {
  return buildAgentContext(getEmailSystemStatus(db));
}

export async function getAgentContextForRuntime(
  db: Database = getDatabase(),
): Promise<Record<string, unknown>> {
  return buildAgentContext(await getEmailSystemStatusForRuntime(db));
}

export function getNextEmailAction(goal?: string, db: Database = getDatabase()): Record<string, unknown> {
  const status = getEmailSystemStatus(db);
  const normalized = goal?.toLowerCase() ?? "";
  if (normalized.includes("code") || normalized.includes("verification")) {
    return {
      command: "emails inbox wait-code <address> --timeout 120",
      reason: "Wait-code refreshes inbound S3 by default and extracts the latest matching code.",
      status,
    };
  }
  if (normalized.includes("owner")) {
    return {
      command: "emails address owner <email-or-id>",
      reason: "Address ownership is stored on the address row and enriched with owner/admin records.",
      status,
    };
  }
  return {
    command: status.next_actions[0] ?? "emails status",
    reason: status.next_actions.length > 0 ? "This is the first unresolved setup or health action." : "The system has no obvious setup gaps.",
    status,
  };
}
