import type { Database } from "../db/database.js";
import { getDatabase } from "../db/database.js";
import { findAddressesByEmail } from "../db/addresses.js";
import { findDomainsByName } from "../db/domains.js";
import { normalizeEmailAddress } from "../db/inbound.js";
import { resolveAlias } from "../db/aliases.js";
import { listAddressProvisioningByIds, listDomainProvisioningByIds, listReadyAddressCountsByDomains } from "../db/provisioning.js";
import { listAddressOwnershipEvents } from "../db/owners.js";
import { assessDomainReadiness } from "./domain-readiness.js";
import { domainInboundReadinessSignals } from "./domain-inbound-evidence.js";
import { enrichAddresses } from "./address-ownership.js";
import { getInboundBuckets, loadConfig } from "./config.js";
import { resolveMaileryMode } from "./mode.js";
import type { MxAssessment } from "./mx-ownership.js";

export interface DeliveryDoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix_command?: string;
}

export interface DeliveryDoctorReport {
  address: string;
  domain: string | null;
  alias_target: string | null;
  recent_local_messages: number;
  latest_received_at: string | null;
  checks: DeliveryDoctorCheck[];
  cli_equivalent: string;
}

export interface LiveDeliveryDoctorOptions {
  inspectMx?: (domain: string) => Promise<MxAssessment>;
}

function check(status: DeliveryDoctorCheck["status"], name: string, message: string, fix_command?: string): DeliveryDoctorCheck {
  return { name, status, message, fix_command };
}

function recentLocalMailSummary(address: string, db: Database): { count: number; latest_received_at: string | null } {
  const normalized = normalizeEmailAddress(address);
  if (!normalized) return { count: 0, latest_received_at: null };
  const rows = db.query(
    `SELECT e.received_at
     FROM inbound_recipients recipient
     JOIN inbound_emails e ON e.id = recipient.inbound_email_id
     WHERE recipient.address = ?
       AND e.is_archived = 0
     ORDER BY e.received_at DESC
     LIMIT 10`,
  ).all(normalized) as Array<{ received_at: string }>;
  return {
    count: rows.length,
    latest_received_at: rows[0]?.received_at ?? null,
  };
}

export function diagnoseInboundDelivery(address: string, db: Database = getDatabase()): DeliveryDoctorReport {
  const normalized = address.trim().toLowerCase();
  const domain = normalized.includes("@") ? normalized.split("@")[1] ?? null : null;
  const checks: DeliveryDoctorCheck[] = [];
  const exactAddresses = normalized.includes("@") ? findAddressesByEmail(normalized, db) : [];
  const domainRows = domain ? findDomainsByName(domain, db) : [];
  const aliasTarget = normalized.includes("@") ? resolveAlias(normalized, db) : null;
  const recent = recentLocalMailSummary(normalized, db);
  const inboundBuckets = getInboundBuckets();
  const config = loadConfig();
  const realtimeQueueConfigured = typeof config["inbound_realtime_queue_url"] === "string";
  const enrichedExactAddresses = exactAddresses.length > 0 ? enrichAddresses(exactAddresses, db) : [];
  const addressProvisioning = listAddressProvisioningByIds(exactAddresses.map((exact) => exact.id), db);
  const domainProvisioning = listDomainProvisioningByIds(domainRows.map((row) => row.id), db);
  const readyAddressesByDomain = listReadyAddressCountsByDomains(domainRows.map((row) => row.id), db);

  if (!normalized.includes("@")) {
    checks.push(check("fail", "Address format", "Expected a full email address.", undefined));
  } else {
    checks.push(check("pass", "Address format", "Address parses as local-part@domain."));
  }

  if (exactAddresses.length > 0) {
    for (const exact of enrichedExactAddresses) {
      const provisioning = addressProvisioning.get(exact.id);
      checks.push(check("pass", "Configured address", `${exact.email} is configured on provider ${exact.provider_id.slice(0, 8)}.`));
      checks.push(provisioning?.provisioning_status === "ready"
        ? check("pass", "Address receive readiness", "Address provisioning is ready.")
        : check("warn", "Address receive readiness", `Address provisioning is ${provisioning?.provisioning_status ?? "unknown"}.`, `mailery address provision ${normalized} --provider ${exact.provider_id} --wait`));
      checks.push(exact.owner
        ? check("pass", "Ownership", `Owned by ${exact.owner.name}.`)
        : check("warn", "Ownership", "No owner/admin assigned.", `mailery address set-owner ${exact.id} --owner <owner>`));
      const history = listAddressOwnershipEvents(exact.id, 1, db);
      if (history[0]) {
        const event = history[0];
        checks.push(check("pass", "Ownership audit", `Last ${event.action} at ${event.created_at}${event.actor ? ` by ${event.actor}` : ""}.`));
      }
    }
  } else if (aliasTarget) {
    checks.push(check("pass", "Alias", `${normalized} resolves to ${aliasTarget}.`));
  } else {
    checks.push(check("warn", "Configured address", "No exact address or alias configured locally.", domain ? `mailery address provision ${normalized} --provider <provider>` : undefined));
  }

  if (domainRows.length > 0) {
    const mode = resolveMaileryMode();
    for (const d of domainRows) {
      const readiness = assessDomainReadiness(d, domainProvisioning.get(d.id) ?? null, {
        ...domainInboundReadinessSignals(d, mode),
        ready_addresses: readyAddressesByDomain.get(d.id) ?? 0,
      });
      checks.push(readiness.receive_ready
        ? check("pass", "Domain receive readiness", `${d.domain} is receive-ready (${readiness.state}).`)
        : check("warn", "Domain receive readiness", `${d.domain} is not receive-ready (${readiness.state}).`, readiness.fix_commands[0]));
      checks.push(readiness.send_ready
        ? check("pass", "Domain send readiness", `${d.domain} is send-ready.`)
        : check("warn", "Domain send readiness", `${d.domain} send DNS is incomplete.`, `mailery domain verify ${d.domain}`));
    }
  } else if (domain) {
    checks.push(check(
      "warn",
      "Domain",
      `${domain} is not configured locally.`,
      `mailery provision domain ${domain} --provider <provider> --dry-run`,
    ));
  }

  if (inboundBuckets.length > 0) {
    checks.push(check("pass", "Inbound sources", `${inboundBuckets.length} S3 bucket(s) configured.`));
  } else {
    checks.push(check("fail", "Inbound sources", "No S3 inbound bucket configured.", "mailery inbox sync-status"));
  }

  if (realtimeQueueConfigured) {
    checks.push(check("pass", "Realtime", "Realtime queue is configured."));
  } else {
    checks.push(check("warn", "Realtime", "Realtime queue is not configured; manual refresh/sync is required.", domain ? `mailery inbox setup-realtime ${domain}` : undefined));
  }

  if (recent.count > 0) {
    checks.push(check("pass", "Recent local mail", `${recent.count} local message(s) found for ${normalized}.`));
  } else {
    checks.push(check("warn", "Recent local mail", "No local messages found for this address.", `mailery inbox wait ${normalized} --timeout 120`));
  }

  return {
    address: normalized,
    domain,
    alias_target: aliasTarget,
    recent_local_messages: recent.count,
    latest_received_at: recent.latest_received_at,
    checks,
    cli_equivalent: `mailery doctor delivery ${normalized} --json`,
  };
}

export async function diagnoseInboundDeliveryLive(
  address: string,
  db: Database = getDatabase(),
  opts: LiveDeliveryDoctorOptions = {},
): Promise<DeliveryDoctorReport> {
  const report = diagnoseInboundDelivery(address, db);
  if (!report.domain) return report;

  const {
    formatMxRecords,
    inspectPublicMx,
    ownerLabel,
    requiresMxSwitchConfirmation,
  } = await import("./mx-ownership.js");
  const mx = await (opts.inspectMx ?? inspectPublicMx)(report.domain);
  const owner = ownerLabel(mx.owner);
  const records = formatMxRecords(mx.records);

  if (mx.owner === "aws-ses") {
    report.checks.push(check("pass", "Public MX", `Root MX is owned by ${owner}: ${records}.`));
  } else if (mx.owner === "none") {
    report.checks.push(check("warn", "Public MX", "No public root MX records found.", `mailery domain check ${report.domain}`));
  } else if (requiresMxSwitchConfirmation(mx)) {
    report.checks.push(check(
      "warn",
      "Public MX",
      `Root MX is owned by ${owner}: ${records}. Do not add SES inbound MX unless you intend to move inbound mail.`,
      `mailery forwarding explain ${report.address}`,
    ));
  } else {
    report.checks.push(check("warn", "Public MX", `${mx.summary}.`, `mailery domain check ${report.domain}`));
  }

  return report;
}

export function formatDeliveryDoctorReport(report: DeliveryDoctorReport): string {
  const lines = [`Delivery diagnosis: ${report.address}`];
  lines.push(`  Domain:   ${report.domain ?? "(none)"}`);
  lines.push(`  Alias:    ${report.alias_target ?? "(none)"}`);
  lines.push(`  Recent:   ${report.recent_local_messages}${report.latest_received_at ? `, latest ${report.latest_received_at}` : ""}`);
  lines.push("");
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "fail";
    lines.push(`  [${mark}] ${c.name}: ${c.message}`);
    if (c.fix_command) lines.push(`        fix: ${c.fix_command}`);
  }
  return lines.join("\n");
}
