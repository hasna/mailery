import type { Command } from "commander";
import type { Database } from "../../db/database.js";
import type { DnsRecord, Domain, DomainSourceOfTruth, DomainType, Provider } from "../../types/index.js";
import chalk from "../../lib/chalk-lite.js";
import { createDomain, listDomains, listUsableDomains, deleteDomain, findDomainsByName, getDomain, getDomainByName, moveDomainProvider, updateDnsStatus, updateDomainReadiness } from "../../db/domains.js";
import { getProvider, listProviderNamesByIds } from "../../db/providers.js";
import { isSelfHostedMode } from "../../db/self-hosted-store.js";
import { getDatabase, now } from "../../db/database.js";
import { getAdapter } from "../../providers/index.js";
import { formatDnsTable, generateDmarcRecord, generateSpfRecord } from "../../lib/dns.js";
import { colorDnsStatus, truncate, tableRow } from "../../lib/format.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";
import { createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus } from "../../db/warming.js";
import { formatWarmingStatus, generateWarmingPlan, getTodayLimit, getTodaySentCount } from "../../lib/warming.js";
import { listDomainProvisioningByIds, listReadyAddressCountsByDomains, setDomainProvisioning } from "../../db/provisioning.js";
import { formatDomainReadinessState } from "../../lib/domain-readiness.js";
import { normalizeRoute53RegistrationContact } from "../../lib/route53-contact.js";
import { resolveEmailsMode } from "../../lib/mode.js";
import {
  assessDomainLifecycleReadiness,
  buildDomainLifecycleSummary,
  defaultDomainSourceOfTruth,
  type DomainLifecycleSummary,
} from "../../lib/domain-readiness-service.js";

function normalizeDomainType(value: string | undefined): DomainType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (["system", "self_hosted", "local_only"].includes(normalized)) return normalized as DomainType;
  handleError(new Error(`Invalid domain type '${value}'. Use system, self_hosted, or local_only.`));
}

function normalizeSourceOfTruth(value: string | undefined): DomainSourceOfTruth | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "postgres" || normalized === "local") return normalized;
  handleError(new Error(`Invalid source of truth '${value}'. Use local or postgres.`));
}

function normalizeDnsProvider(value: string | undefined): string {
  const normalized = String(value ?? "manual").trim().toLowerCase().replace(/-/g, "_");
  if (["manual", "cloudflare", "route53"].includes(normalized)) return normalized;
  handleError(new Error(`Invalid DNS provider '${value}'. Use manual, cloudflare, or route53.`));
}

function selfHostedLocalOnly(command: string): void {
  if (!isSelfHostedMode()) return;
  handleError(new Error(
    `\`${command}\` is local-mode-only and unavailable in self_hosted API-only mode. ` +
      "Use the self-hosted server/operator API/workers for domain provisioning and lifecycle changes, " +
      "or set EMAILS_MODE=local intentionally to use local SQLite/config state.",
  ));
}

function resolveSelfHostedDomainId(ref: string): string {
  const exact = getDomain(ref);
  if (exact) return exact.id;
  const matches = listDomains(undefined, undefined, { limit: 1000 })
    .filter((domain) => domain.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    handleError(new Error(`Domain ID is ambiguous in self_hosted mode: ${matches.map((domain) => domain.id.slice(0, 8)).join(", ")}`));
  }
  handleError(new Error(`Domain not found: ${ref}`));
}

function fallbackDomainDnsRecords(domain: string, provider: Provider): DnsRecord[] {
  const records = [generateSpfRecord(domain), generateDmarcRecord(domain)];
  if (provider.type === "sandbox") return records;
  return records;
}

interface DomainDnsTask {
  purpose: string;
  type: string;
  name: string;
  value: string;
  status: "pending";
  check_command: string;
  verify_command: string;
}

function domainDnsTasks(domain: string, records: DnsRecord[]): DomainDnsTask[] {
  return records.map((record) => ({
    purpose: record.purpose,
    type: record.type,
    name: record.name,
    value: record.value,
    status: "pending" as const,
    check_command: `emails domain check ${domain}`,
    verify_command: `emails domain verify ${domain}`,
  }));
}

function resolveDomainRecord(
  domainOrId: string,
  opts: { provider?: string } = {},
  db: Database = getDatabase(),
): Domain {
  if (opts.provider) {
    const providerId = resolveId("providers", opts.provider);
    const domain = getDomainByName(providerId, domainOrId, db);
    if (!domain) handleError(new Error(`Domain not found for provider ${opts.provider}: ${domainOrId}`));
    return domain;
  }

  const byId = getDomain(domainOrId, db);
  if (byId) return byId;

  const matches = findDomainsByName(domainOrId, db);
  if (matches.length === 0) handleError(new Error(`Domain not found: ${domainOrId}`));
  if (matches.length > 1) {
    const choices = matches.map((domain) => `${domain.domain} provider=${domain.provider_id.slice(0, 8)}`).join(", ");
    handleError(new Error(`Domain is ambiguous; pass --provider. Matches: ${choices}`));
  }
  return matches[0]!;
}

function formatDomainLifecycleSummary(summary: DomainLifecycleSummary): string {
  const lines = [chalk.bold(`\nDomain ${summary.domain}`)];
  lines.push(`  Mode:            ${summary.mode} (${summary.mode_label})`);
  lines.push(`  Source of truth: ${summary.source_of_truth}`);
  lines.push(`  Type:            ${summary.domain_type}`);
  lines.push(`  Provider:        ${summary.provider ? `${summary.provider.name} (${summary.provider.type})` : "(missing)"}`);
  lines.push(`  Ownership:       ${summary.ownership_status}`);
  lines.push(`  Inbound:         ${summary.readiness.inbound_ready ? chalk.green("ready") : chalk.yellow(summary.inbound_status)}`);
  lines.push(`  Outbound:        ${summary.readiness.outbound_ready ? chalk.green("ready") : chalk.yellow(summary.outbound_status)}`);
  lines.push(`  Monitoring:      ${summary.monitoring_status}`);
  lines.push(`  DNS:             DKIM:${summary.dns.dkim} SPF:${summary.dns.spf} DMARC:${summary.dns.dmarc}`);
  if (summary.missing_requirements.length > 0) lines.push(chalk.dim(`  Missing:         ${summary.missing_requirements.join("; ")}`));
  if (summary.next_actions.length > 0) {
    lines.push(chalk.dim("  Next:"));
    for (const action of summary.next_actions.slice(0, 3)) lines.push(chalk.dim(`    ${action}`));
  }
  lines.push("");
  return lines.join("\n");
}

function formatDomainLifecycleList(summaries: DomainLifecycleSummary[], opts: { verbose?: boolean } = {}): string {
  if (summaries.length === 0) return chalk.dim("No domains configured.");
  const lines = [chalk.bold("\nDomains:")];
  lines.push(tableRow(
    [chalk.bold("Domain"), 22],
    [chalk.bold("Mode"), 12],
    [chalk.bold("Source"), 10],
    [chalk.bold("Provider"), 14],
    [chalk.bold("Inbound"), 10],
    [chalk.bold("Outbound"), 10],
    [chalk.bold("Next"), 26],
  ));
  for (const summary of summaries) {
    const next = summary.next_actions[0] ?? "none";
    lines.push(tableRow(
      [truncate(summary.domain, 22), 22],
      [summary.mode, 12],
      [summary.source_of_truth, 10],
      [summary.provider ? truncate(summary.provider.name, 14) : "(missing)", 14],
      [summary.readiness.inbound_ready ? chalk.green("ready") : chalk.yellow(summary.inbound_status), 10],
      [summary.readiness.outbound_ready ? chalk.green("ready") : chalk.yellow(summary.outbound_status), 10],
      [truncate(next, 26), 26],
    ));
    if (opts.verbose && summary.missing_requirements.length > 0) {
      lines.push(chalk.dim(`  ${summary.domain}: ${summary.missing_requirements.join("; ")}`));
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function registerDomainCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const domainCmd = program.command("domain").description("Manage sending domains");
  const domainsCmd = program.command("domains").description("Manage domain lifecycle");

  const listDomainsAction = (opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
    try {
      const page = parseCliListPage(opts);
      const providerId = isSelfHostedMode()
        ? opts.provider
        : opts.provider ? resolveId("providers", opts.provider) : undefined;
      const domains = isSelfHostedMode()
        ? listDomains(providerId, undefined, page)
        : listDomains(providerId, getDatabase(), page);
      if (domains.length === 0) {
        output([], chalk.dim("No domains configured."));
        return;
      }
      const lines: string[] = [chalk.bold("\nDomains:")];
      for (const d of domains) {
        const dkim = colorDnsStatus(d.dkim_status);
        const spf = colorDnsStatus(d.spf_status);
        const dmarc = colorDnsStatus(d.dmarc_status);
        lines.push(`  ${chalk.cyan(d.id.slice(0, 8))}  ${d.domain}  DKIM:${dkim}  SPF:${spf}  DMARC:${dmarc}`);
      }
      lines.push("");
      lines.push(formatListHint({
        shown: domains.length,
        limit: page.limit,
        offset: page.offset,
        noun: "domain",
        detailCommand: "use emails domain status or emails domain dns <domain> for details",
        verbose: opts.verbose || isCliVerboseOutput(),
      }));
      output(domains, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  const listLifecycleAction = (opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
    try {
      // Self-hosted has no local lifecycle/provisioning tables; read domains via
      // the /v1 API (same path as `domain list`) instead of hard-blocking.
      if (isSelfHostedMode()) {
        listDomainsAction(opts);
        return;
      }
      const db = getDatabase();
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const page = parseCliListPage(opts);
      const rows = listDomains(providerId, db, page).map((domain) => buildDomainLifecycleSummary(domain, { db }));
      output(rows, `${formatDomainLifecycleList(rows, { verbose: opts.verbose || isCliVerboseOutput() })}\n${formatListHint({
        shown: rows.length,
        limit: page.limit,
        offset: page.offset,
        noun: "domain",
        detailCommand: "use emails domains status <domain> for lifecycle details",
        verbose: opts.verbose || isCliVerboseOutput(),
      })}`);
    } catch (e) {
      handleError(e);
    }
  };

  const statusLifecycleAction = (domainOrId: string | undefined, opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
    try {
      // Self-hosted: no local lifecycle data. List via the /v1 API, or render the
      // one matching domain's API record, instead of hard-blocking.
      if (isSelfHostedMode()) {
        if (!domainOrId) {
          listDomainsAction(opts);
          return;
        }
        const match = listDomains(undefined, undefined, { limit: 1000 })
          .find((d) => d.id === domainOrId || d.id.startsWith(domainOrId) || d.domain.toLowerCase() === domainOrId.toLowerCase());
        if (!match) {
          handleError(new Error(`Domain not found: ${domainOrId}`));
          return;
        }
        output(match, `${chalk.bold(`\nDomain ${match.domain}`)}\n  ID:   ${match.id.slice(0, 8)}\n  DNS:  DKIM:${colorDnsStatus(match.dkim_status)} SPF:${colorDnsStatus(match.spf_status)} DMARC:${colorDnsStatus(match.dmarc_status)}\n  ${chalk.dim("Full lifecycle readiness requires local mode or the operator API.")}\n`);
        return;
      }
      selfHostedLocalOnly(domainOrId ? "emails domains status" : "emails domains list");
      if (!domainOrId) {
        listLifecycleAction(opts);
        return;
      }
      const db = getDatabase();
      const domain = resolveDomainRecord(domainOrId, opts, db);
      const summary = buildDomainLifecycleSummary(domain, { db });
      output(summary, formatDomainLifecycleSummary(summary));
    } catch (e) {
      handleError(e);
    }
  };

  const addDomainAction = async (
    domain: string,
    opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string },
    commandPrefix: "domain" | "domains",
  ) => {
    try {
      // Self-hosted (self_hosted) mode: the domain is created directly on the app's
      // self_hosted HTTP API (<API_URL>/v1/domains). Providers are a local-only concept
      // (the self_hosted API exposes no /v1/providers), so we do NOT resolve a local
      // provider row or call a provider adapter — `--provider` is passed through
      // as a label. This makes `domain add` a real self_hosted write, not a local one.
      if (isSelfHostedMode()) {
        const existing = getDomainByName(opts.provider, domain);
        const selfHostedMode = resolveEmailsMode();
        const selfHostedDomainType = normalizeDomainType(opts.domainType) ?? "self_hosted";
        if (opts.dryRun) {
          output({
            dry_run: true,
            domain,
            provider_id: opts.provider,
            mode: selfHostedMode.mode,
            provider: null,
            source_of_truth: "postgres",
            domain_type: selfHostedDomainType,
            existing: existing ? { id: existing.id, domain: existing.domain } : null,
            would_create_domain: !existing,
            would_call_provider: false,
            cli_equivalent: `emails ${commandPrefix} add ${domain} --provider ${opts.provider}`,
          }, existing
            ? chalk.dim(`Domain already exists in self_hosted: ${domain} (${existing.id.slice(0, 8)})`)
            : chalk.dim(`Would create ${domain} on the self_hosted API (provider label ${opts.provider}).`));
          return;
        }
        if (existing) {
          output(existing, chalk.green(`✓ Domain already exists: ${domain} (${existing.id.slice(0, 8)})`));
          return;
        }
        const created = createDomain(opts.provider, domain);
        output(created, chalk.green(`✓ Domain added to self_hosted: ${domain} (${created.id.slice(0, 8)})`));
        return;
      }

      const db = getDatabase();
      const providerId = resolveId("providers", opts.provider);
      const provider = getProvider(providerId, db);
      if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
      const existing = getDomainByName(providerId, domain, db);
      const mode = resolveEmailsMode();
      const domainType = normalizeDomainType(opts.domainType) ?? "self_hosted";
      const sourceOfTruth = normalizeSourceOfTruth(opts.sourceOfTruth) ?? defaultDomainSourceOfTruth(mode.mode);

      if (opts.dryRun) {
        output({
          dry_run: true,
          domain,
          provider_id: providerId,
          mode: mode.mode,
          provider: provider
            ? { id: provider.id, name: provider.name, type: provider.type, region: provider.region, active: provider.active }
            : null,
          source_of_truth: sourceOfTruth,
          domain_type: domainType,
          existing: existing ? buildDomainLifecycleSummary(existing, { db }) : null,
          would_create_domain: !existing,
          would_call_provider: !existing,
          cli_equivalent: `emails ${commandPrefix} add ${domain} --provider ${opts.provider}`,
        }, existing
          ? chalk.dim(`Domain already exists locally: ${domain} (${existing.id.slice(0, 8)})`)
          : chalk.dim(`Would add ${domain} to provider ${provider!.name} and register it as ${sourceOfTruth} source of truth.`));
        return;
      }

      if (existing) {
        const summary = buildDomainLifecycleSummary(existing, { db });
        output(summary, chalk.green(`✓ Domain already exists: ${domain} (${existing.id.slice(0, 8)})\n`) + formatDomainLifecycleSummary(summary));
        return;
      }

      const adapter = getAdapter(provider!);
      await adapter.addDomain(domain);

      const created = createDomain(providerId, domain, db);
      const updated = updateDomainReadiness(created.id, {
        domain_type: domainType,
        source_of_truth: sourceOfTruth,
      }, db);
      const summary = buildDomainLifecycleSummary(updated, { db });
      output(summary, chalk.green(`✓ Domain added: ${domain} (${updated.id.slice(0, 8)})\n`) + formatDomainLifecycleSummary(summary));
    } catch (e) {
      handleError(e);
    }
  };

  const connectDomainAction = async (
    domain: string,
    opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string; dnsProvider?: string; registerProvider?: boolean },
    commandPrefix: "domain" | "domains",
  ) => {
    try {
      selfHostedLocalOnly(`emails ${commandPrefix} connect`);
      const db = getDatabase();
      const providerId = resolveId("providers", opts.provider);
      const provider = getProvider(providerId, db);
      if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
      const mode = resolveEmailsMode();
      const sourceOfTruth = normalizeSourceOfTruth(opts.sourceOfTruth) ?? defaultDomainSourceOfTruth(mode.mode);
      const domainType = normalizeDomainType(opts.domainType) ?? (sourceOfTruth === "postgres" ? "self_hosted" : "local_only");
      const dnsProvider = normalizeDnsProvider(opts.dnsProvider);
      const existing = getDomainByName(providerId, domain, db);
      const fallbackRecords = fallbackDomainDnsRecords(domain, provider!);
      const fallbackTasks = domainDnsTasks(domain, fallbackRecords);

      if (opts.dryRun) {
        output({
          dry_run: true,
          domain,
          provider_id: providerId,
          provider: { id: provider!.id, name: provider!.name, type: provider!.type, region: provider!.region, active: provider!.active },
          source_of_truth: sourceOfTruth,
          domain_type: domainType,
          dns_provider: dnsProvider,
          would_create_domain: !existing,
          would_register_provider: opts.registerProvider !== false,
          dns_tasks: fallbackTasks,
          cli_equivalent: `emails ${commandPrefix} connect ${domain} --provider ${opts.provider}`,
        }, chalk.dim(`Would connect ${domain} to ${provider!.name}, generate DNS tasks, and return readiness without purchasing the domain.`));
        return;
      }

      let records: DnsRecord[] = [];
      if (opts.registerProvider !== false) {
        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);
        records = await adapter.getDnsRecords(domain);
      }
      if (records.length === 0) records = fallbackRecords;

      const rec = existing ?? createDomain(providerId, domain, db);
      const generatedAt = now();
      const updated = updateDomainReadiness(rec.id, {
        domain_type: domainType,
        source_of_truth: sourceOfTruth,
        dns_records: {
          expected_records: records,
          generated_at: generatedAt,
          dns_provider: dnsProvider,
        },
        provider_metadata: {
          ...rec.provider_metadata,
          dns_setup: {
            dns_provider: dnsProvider,
            expected_records: records,
            generated_at: generatedAt,
            register_provider: opts.registerProvider !== false,
          },
        },
        last_dns_check_at: generatedAt,
      }, db);
      setDomainProvisioning(rec.id, {
        provisioning_status: opts.registerProvider !== false ? "ses_identity_created" : "registered",
        dns_provider: dnsProvider,
        send_provider: provider!.type,
        last_error: null,
      }, db);

      const lifecycle = buildDomainLifecycleSummary(updated, { db });
      const dnsTasks = domainDnsTasks(domain, records);
      const result = {
        domain,
        domain_id: updated.id,
        created: !existing,
        registered_with_provider: opts.registerProvider !== false,
        provider: lifecycle.provider,
        source_of_truth: sourceOfTruth,
        domain_type: domainType,
        dns_provider: dnsProvider,
        dns_tasks: dnsTasks,
        lifecycle,
        next_actions: lifecycle.next_actions,
      };
      const lines = [chalk.green(`✓ Connected ${domain} to ${provider!.name}`)];
      lines.push(chalk.dim(`  Source of truth: ${sourceOfTruth} · DNS provider: ${dnsProvider}`));
      lines.push(chalk.bold("\nDNS tasks:"));
      for (const task of dnsTasks) {
        lines.push(`  ${chalk.cyan(task.type.padEnd(6))} ${task.name} ${chalk.dim(task.value)}`);
      }
      lines.push("");
      lines.push(formatDomainLifecycleSummary(lifecycle).trimEnd());
      output(result, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  const enableInboundAction = (domainOrId: string, opts: { provider?: string; force?: boolean }) => {
    try {
      selfHostedLocalOnly("emails domains enable-inbound");
      const db = getDatabase();
      const domain = resolveDomainRecord(domainOrId, opts, db);
      const summary = buildDomainLifecycleSummary(domain, { db });
      if (!opts.force && !summary.readiness.receive_ready && !summary.readiness.inbound_evidence_ready) {
        handleError(new Error(`Inbound self_hosted source is not configured for ${domain.domain}; run emails domain adopt ${domain.domain} --provider ${domain.provider_id} or pass --force after manual/provider setup.`));
      }
      const updated = updateDomainReadiness(domain.id, {
        inbound_status: "ready",
        last_inbound_check_at: now(),
      }, db);
      setDomainProvisioning(domain.id, {
        provisioning_status: "inbound_ready",
        last_error: null,
        next_check_at: null,
      }, db);
      const next = buildDomainLifecycleSummary(updated, { db });
      output(next, chalk.green(`✓ Inbound enabled for ${domain.domain}\n`) + formatDomainLifecycleSummary(next));
    } catch (e) {
      handleError(e);
    }
  };

  const enableOutboundAction = (domainOrId: string, opts: { provider?: string; force?: boolean }) => {
    try {
      selfHostedLocalOnly("emails domains enable-outbound");
      const db = getDatabase();
      const domain = resolveDomainRecord(domainOrId, opts, db);
      const dnsReady = domain.dkim_status === "verified" && domain.spf_status === "verified";
      if (!opts.force && !dnsReady) {
        handleError(new Error(`Outbound is not verified for ${domain.domain}; DKIM and SPF must be verified or pass --force after manual/provider setup.`));
      }
      const updated = updateDomainReadiness(domain.id, {
        ownership_status: domain.verified_at || dnsReady ? "verified" : domain.ownership_status,
        outbound_status: "ready",
        monitoring_status: domain.dmarc_status === "verified" ? "monitoring" : domain.monitoring_status,
        last_outbound_check_at: now(),
      }, db);
      if (dnsReady) {
        setDomainProvisioning(domain.id, {
          provisioning_status: "verified",
          last_error: null,
          next_check_at: null,
        }, db);
      }
      const next = buildDomainLifecycleSummary(updated, { db });
      output(next, chalk.green(`✓ Outbound enabled for ${domain.domain}\n`) + formatDomainLifecycleSummary(next));
    } catch (e) {
      handleError(e);
    }
  };

  const disableOutboundAction = (domainOrId: string, opts: { provider?: string }) => {
    try {
      selfHostedLocalOnly("emails domains disable-outbound");
      const db = getDatabase();
      const domain = resolveDomainRecord(domainOrId, opts, db);
      const updated = updateDomainReadiness(domain.id, {
        outbound_status: "disabled",
        restricted_at: now(),
      }, db);
      const summary = buildDomainLifecycleSummary(updated, { db });
      output(summary, chalk.yellow(`⏸ Outbound disabled for ${domain.domain}\n`) + formatDomainLifecycleSummary(summary));
    } catch (e) {
      handleError(e);
    }
  };

  const dnsAction = async (domain: string, opts: { provider?: string }) => {
    try {
      selfHostedLocalOnly("emails domain dns");
      let providerId: string | undefined;
      if (opts.provider) {
        providerId = resolveId("providers", opts.provider);
      }

      const found = providerId ? getDomainByName(providerId, domain) : findDomainsByName(domain)[0];

      if (found) {
        const provider = getProvider(found.provider_id);
        if (provider) {
          const adapter = getAdapter(provider);
          const records = await adapter.getDnsRecords(domain);
          const summary = buildDomainLifecycleSummary(found);
          output({
            domain,
            records,
            lifecycle: summary,
          }, chalk.bold(`\nDNS Records for ${domain}:\n`) + formatDnsTable(records) + formatDomainLifecycleSummary(summary));
          return;
        }
      }

      const { generateSpfRecord, generateDmarcRecord } = await import("../../lib/dns.js");
      const records = [generateSpfRecord(domain), generateDmarcRecord(domain)];
      output({
        domain,
        records,
        lifecycle: null,
      }, chalk.bold(`\nDNS Records for ${domain} (generic):\n`) + formatDnsTable(records));
    } catch (e) {
      handleError(e);
    }
  };

  const verifyAction = async (domain: string, opts: { provider?: string }) => {
    try {
      selfHostedLocalOnly("emails domain verify");
      const db = getDatabase();
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const found = providerId ? getDomainByName(providerId, domain, db) : findDomainsByName(domain, db)[0];
      if (!found) handleError(new Error(`Domain not found: ${domain}`));

      const provider = getProvider(found!.provider_id, db);
      if (!provider) handleError(new Error("Provider not found"));

      const adapter = getAdapter(provider!);
      let status = await adapter.verifyDomain(domain);
      let reinitiatedRecords: Awaited<ReturnType<NonNullable<typeof adapter.reinitiateDomainVerification>>> | null = null;
      if (
        provider!.type === "ses" &&
        adapter.reinitiateDomainVerification &&
        (status.dkim === "failed" || status.spf === "failed")
      ) {
        reinitiatedRecords = await adapter.reinitiateDomainVerification(domain);
        const refreshed = await adapter.verifyDomain(domain);
        status = {
          dkim: refreshed.dkim === "failed" ? "pending" : refreshed.dkim,
          spf: refreshed.spf === "failed" ? "pending" : refreshed.spf,
          dmarc: refreshed.dmarc,
        };
      }
      const updated = updateDnsStatus(found!.id, status.dkim, status.spf, status.dmarc, db);
      const lifecycle = buildDomainLifecycleSummary(updated, { db });

      const lines = [chalk.bold(`\nDNS Status for ${domain}:`)];
      if (reinitiatedRecords) {
        lines.push(chalk.yellow("  SES verification was failed; identity/DKIM verification was re-initiated."));
        if (reinitiatedRecords.length > 0) {
          lines.push(chalk.dim("  Required SES verification records:"));
          lines.push(formatDnsTable(reinitiatedRecords).trimEnd());
        }
      }
      lines.push(`  DKIM:  ${colorDnsStatus(status.dkim)}`);
      lines.push(`  SPF:   ${colorDnsStatus(status.spf)}`);
      lines.push(`  DMARC: ${colorDnsStatus(status.dmarc)}`);
      lines.push(formatDomainLifecycleSummary(lifecycle).trimEnd());
      lines.push("");
      output({ domain, status, reinitiated_records: reinitiatedRecords, lifecycle }, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  const checkAction = async (domain: string, opts: { provider?: string }) => {
    try {
      selfHostedLocalOnly("emails domain check");
      const { checkDomainAuthentication, formatDnsCheck } = await import("../../lib/dns-check.js");
      const { inspectPublicMx, ownerLabel, requiresMxSwitchConfirmation, formatMxRecords } = await import("../../lib/mx-ownership.js");

      let providerId: string | undefined;
      if (opts.provider) {
        providerId = resolveId("providers", opts.provider);
      }

      const found = providerId ? getDomainByName(providerId, domain) : findDomainsByName(domain)[0];

      let expectedRecords;
      if (found) {
        const provider = getProvider(found.provider_id);
        if (provider) {
          const adapter = getAdapter(provider);
          expectedRecords = await adapter.getDnsRecords(domain);
        }
      }

      if (!expectedRecords) {
        const { generateSpfRecord, generateDmarcRecord } = await import("../../lib/dns.js");
        expectedRecords = [generateSpfRecord(domain), generateDmarcRecord(domain)];
      }

      const authentication = await checkDomainAuthentication(domain, expectedRecords);
      const results = authentication.records;
      const mx = await inspectPublicMx(domain);
      let lifecycle: DomainLifecycleSummary | null = null;
      if (found) {
        const missingOutbound =
          authentication.signals.ownership.status === "missing" ||
          authentication.signals.dkim.status === "missing" ||
          authentication.signals.spf.status === "missing" ||
          authentication.signals.mail_from.status === "missing";
        const updated = updateDomainReadiness(found.id, {
          ownership_status: authentication.signals.ownership.status === "verified"
            ? "verified"
            : authentication.signals.ownership.status === "missing"
              ? "failed"
              : "pending",
          inbound_status: authentication.inbound_ready
            ? "ready"
            : authentication.signals.mx.status === "missing"
              ? "failed"
              : "pending",
          outbound_status: authentication.outbound_ready ? "ready" : missingOutbound ? "failed" : "pending",
          monitoring_status: authentication.dmarc_monitoring_ready ? "monitoring" : "none",
          dns_records: {
            checked_at: authentication.checked_at,
            records: results,
            missing_requirements: authentication.missing_requirements,
            warnings: authentication.warnings,
          },
          last_dns_check_at: authentication.checked_at,
        });
        lifecycle = buildDomainLifecycleSummary(updated);
      }

      const lines = [chalk.bold(`\nDNS Check for ${domain}:`), formatDnsCheck(results).trimEnd(), ""];
      lines.push(chalk.bold("Authentication readiness:"));
      lines.push(`  Outbound: ${authentication.outbound_ready ? chalk.green("ready") : chalk.yellow("not ready")}`);
      lines.push(`  Inbound:  ${authentication.inbound_ready ? chalk.green("ready") : chalk.yellow("not ready")}`);
      lines.push(`  DMARC:    ${authentication.dmarc_monitoring_ready ? chalk.green("monitoring ready") : chalk.yellow("monitoring not verified")}`);
      if (authentication.missing_requirements.length > 0) {
        lines.push(chalk.dim(`  Missing: ${authentication.missing_requirements.join("; ")}`));
      }
      for (const warning of authentication.warnings) {
        lines.push(chalk.dim(`  Note: ${warning}`));
      }
      lines.push("");
      lines.push(chalk.bold("Root MX ownership:"));
      lines.push(`  ${ownerLabel(mx.owner)} - ${mx.summary}`);
      lines.push(`  ${chalk.dim(formatMxRecords(mx.records))}`);
      if (requiresMxSwitchConfirmation(mx)) {
        lines.push(chalk.yellow("  Existing inbound is protected. Use SES send-only setup unless you intentionally move or mix root MX."));
      } else if (mx.owner === "aws-ses") {
        lines.push(chalk.green("  SES already owns root inbound MX."));
      } else {
        lines.push(chalk.dim("  No root MX detected; SES inbound MX can be added when receiving is desired."));
      }
      lines.push("");
      const allMatch = results.every((r) => r.match);
      if (allMatch) {
        lines.push(chalk.green("All DNS records verified successfully."));
      } else {
        const missing = results.filter((r) => !r.match).length;
        lines.push(chalk.yellow(`${missing} record(s) not yet propagated or missing.`));
      }
      if (lifecycle) lines.push(formatDomainLifecycleSummary(lifecycle).trimEnd());
      lines.push("");
      output({ domain, records: results, authentication, mx, lifecycle }, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  domainsCmd
    .action(() => listLifecycleAction({}));

  domainsCmd
    .command("list")
    .description("List domains with lifecycle readiness")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show expanded lifecycle details")
    .action(listLifecycleAction);

  domainsCmd
    .command("status [domain]")
    .description("Show domain lifecycle readiness")
    .option("--provider <id>", "Provider ID")
    .option("--limit <n>", "Maximum domains to show when no domain is passed")
    .option("--offset <n>", "Number of domains to skip when no domain is passed", "0")
    .option("--verbose", "Show expanded lifecycle details")
    .action(statusLifecycleAction);

  domainsCmd
    .command("add <domain>")
    .description("Add a domain to a provider")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--source-of-truth <source>", "Source of truth: local or postgres")
    .option("--dry-run", "Resolve inputs and show the planned change without calling the provider or writing to the DB")
    .action((domain: string, opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string }) => addDomainAction(domain, opts, "domains"));

  domainsCmd
    .command("connect <domain>")
    .description("Connect an already-owned domain and generate DNS readiness tasks")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--source-of-truth <source>", "Source of truth: local or postgres")
    .option("--dns-provider <provider>", "DNS provider label: manual, cloudflare, or route53", "manual")
    .option("--no-register-provider", "Do not call the mail provider to register the domain")
    .option("--dry-run", "Show the connection plan without calling the provider or writing to the DB")
    .action((domain: string, opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string; dnsProvider?: string; registerProvider?: boolean }) => connectDomainAction(domain, opts, "domains"));

  domainsCmd
    .command("dns <domain>")
    .description("Show required DNS records and lifecycle context for a domain")
    .option("--provider <id>", "Provider ID")
    .action(dnsAction);

  domainsCmd
    .command("verify <domain>")
    .description("Re-verify domain DNS status and update lifecycle context")
    .option("--provider <id>", "Provider ID")
    .action(verifyAction);

  domainsCmd
    .command("check <domain>")
    .description("Live DNS check with per-domain authentication readiness")
    .option("--provider <id>", "Provider ID")
    .action(checkAction);

  domainsCmd
    .command("enable-inbound <domain>")
    .description("Mark a domain inbound-ready after provider/DNS routing is configured")
    .option("--provider <id>", "Provider ID")
    .option("--force", "Mark inbound ready even if local readiness checks are not yet verified")
    .action(enableInboundAction);

  domainsCmd
    .command("enable-outbound <domain>")
    .description("Enable outbound sending for a verified domain")
    .option("--provider <id>", "Provider ID")
    .option("--force", "Enable outbound even if local DKIM/SPF checks are not yet verified")
    .action(enableOutboundAction);

  domainsCmd
    .command("disable-outbound <domain>")
    .description("Disable outbound sending for a domain")
    .option("--provider <id>", "Provider ID")
    .action(disableOutboundAction);

  domainCmd
    .command("add <domain>")
    .description("Add a domain to a provider")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--source-of-truth <source>", "Source of truth: local or postgres")
    .option("--dry-run", "Resolve inputs and show the planned change without calling the provider or writing to the DB")
    .action((domain: string, opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string }) => addDomainAction(domain, opts, "domain"));

  domainCmd
    .command("connect <domain>")
    .description("Connect an already-owned domain and generate DNS readiness tasks")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain-type <type>", "Domain type: system, self_hosted, or local_only")
    .option("--source-of-truth <source>", "Source of truth: local or postgres")
    .option("--dns-provider <provider>", "DNS provider label: manual, cloudflare, or route53", "manual")
    .option("--no-register-provider", "Do not call the mail provider to register the domain")
    .option("--dry-run", "Show the connection plan without calling the provider or writing to the DB")
    .action((domain: string, opts: { provider: string; dryRun?: boolean; domainType?: string; sourceOfTruth?: string; dnsProvider?: string; registerProvider?: boolean }) => connectDomainAction(domain, opts, "domain"));

  // ── adopt: seamlessly add an already-registered & SES-verified domain ────────
  domainCmd
    .command("adopt <domain>")
    .description("Add an already-registered, SES-verified domain: register it, wire SES inbound (S3), add a catch-all, and optionally sync")
    .requiredOption("--provider <id>", "SES provider where the domain is verified")
    .option("--no-inbound", "Skip SES inbound (S3 receipt rule) setup")
    .option("--bucket <name>", "Inbound S3 bucket (default: config, else emails-inbound-<accountId>)")
    .option("--region <region>", "AWS region (default: the provider's region)")
    .option("--catch-all <target>", "Route ALL mail for this domain to this address")
    .option("--sync", "Run an initial inbound sync after wiring")
    .option("--force-mx-switch", "Allow SES inbound setup even when public root MX belongs to another provider")
    .action(async (domain: string, opts: { provider: string; inbound?: boolean; bucket?: string; region?: string; catchAll?: string; sync?: boolean; forceMxSwitch?: boolean }) => {
      try {
        selfHostedLocalOnly("emails domain adopt");
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) return handleError(new Error(`Provider not found: ${opts.provider}`));

        const region = opts.region ?? provider.region ?? "us-east-1";
        const accessKeyId = provider.access_key ?? undefined;
        const secretAccessKey = provider.secret_key ?? undefined;
        const lines: string[] = [chalk.bold(`\nAdopting ${domain} → ${provider.name}`)];

        if (opts.inbound !== false && provider.type === "ses") {
          const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
          await guardSesInboundMx(domain, !!opts.forceMxSwitch);
        }

        // 1. Ensure the SES identity exists (idempotent if already verified).
        const adapter = getAdapter(provider);
        await adapter.addDomain(domain);
        lines.push(chalk.green(`✓ SES identity ensured`));

        // 2. Register in the emails store.
        const rec = getDomainByName(providerId, domain, db) ?? createDomain(providerId, domain, db);
        setDomainProvisioning(rec.id, {
          provisioning_status: "ses_identity_created",
          dns_provider: "cloudflare",
          send_provider: provider.type,
          last_error: null,
        }, db);
        lines.push(chalk.green(`✓ Registered in Emails (${rec.id.slice(0, 8)})`));

        // 3. Record verification status.
        try {
          const st = await adapter.verifyDomain(domain);
          updateDnsStatus(rec.id, st.dkim, st.spf, st.dmarc, db);
          if (st.dkim === "verified") {
            setDomainProvisioning(rec.id, { provisioning_status: "verified", next_check_at: null, last_error: null }, db);
          }
          lines.push(`  ${colorDnsStatus(st.dkim)} DKIM · ${colorDnsStatus(st.spf)} SPF · ${colorDnsStatus(st.dmarc)} DMARC`);
        } catch { /* non-fatal */ }

        // 4. Inbound — per provider.
        if (opts.inbound !== false && provider.type === "resend") {
          lines.push(chalk.green(`✓ Resend domain ready`));
          lines.push(chalk.dim(`  Inbound is push: add a Resend inbound webhook -> POST /webhook/resend-inbound on 'emails serve'`));
        }
        // 4a. SES inbound (S3 bucket + receipt rule → mail for *@domain lands in S3).
        if (opts.inbound !== false && provider.type === "ses") {
          // Bucket is account-specific — resolve the SES account for this provider
          // so domains in different accounts get the right bucket.
          let bucket = opts.bucket;
          if (!bucket) {
            const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
            const sts = new STSClient({ region, credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined });
            const acct = (await sts.send(new GetCallerIdentityCommand({}))).Account;
            bucket = `emails-inbound-${acct}`;
          }
          const { setupInboundEmail } = await import("../../lib/aws-inbound.js");
          const r = await setupInboundEmail({ domain, bucket, region, accessKeyId, secretAccessKey });
          lines.push(chalk.green(`✓ SES inbound → s3://${r.bucket}/${r.s3_prefix}`) + chalk.dim(` (rule ${r.rule_name}${r.bucket_created ? ", bucket created" : ""})`));
          lines.push(chalk.dim(`  Publish MX in DNS:  ${r.mx_record}  (for @${domain})`));
          // Register the bucket so 'inbox watch' / the TUI auto-pull sync it
          // (multi-bucket: domains can live in different AWS accounts).
          const { addInboundBucket } = await import("../../lib/config.js");
          addInboundBucket(r.bucket, region, providerId);
          const { registerS3Source } = await import("../../lib/s3-sync.js");
          const source = registerS3Source({
            bucket: r.bucket,
            prefix: r.s3_prefix,
            region,
            providerId,
            name: `${domain} SES/S3 inbound`,
            status: "live",
            liveSyncEnabled: true,
          });
          setDomainProvisioning(rec.id, { provisioning_status: "ready", next_check_at: null, last_error: null }, db);
          updateDomainReadiness(rec.id, {
            provider_metadata: {
              inbound: {
                strategy: "ses-s3",
                bucket: r.bucket,
                prefix: r.s3_prefix,
                region,
                source_id: source.id,
                rule_set: r.rule_set,
                rule_name: r.rule_name,
              },
            },
            last_inbound_check_at: now(),
          }, db);
        }

        // 5. Catch-all: the protected global catch-all already covers every domain;
        // optionally pin a domain-specific target.
        const { ensureDefaultCatchAll, createCatchAll } = await import("../../db/aliases.js");
        ensureDefaultCatchAll(db);
        if (opts.catchAll) {
          createCatchAll(domain, opts.catchAll, db);
          lines.push(chalk.green(`✓ catch-all *@${domain} → ${opts.catchAll}`));
        }

        // 6. Optional initial sync.
        if (opts.sync && opts.inbound !== false) {
          const { getInboundConfig } = await import("../../lib/config.js");
          const bucket = opts.bucket ?? getInboundConfig().bucket;
          if (bucket) {
            const { syncS3Inbox } = await import("../../lib/s3-sync.js");
            const sr = await syncS3Inbox({ bucket, prefix: `inbound/${domain}/`, region, providerId, limit: 500 });
            lines.push(chalk.green(`✓ Synced ${sr.synced} message(s)`) + (sr.errors.length ? chalk.yellow(` (${sr.errors.length} errors)`) : ""));
          }
        }

        lines.push(chalk.dim(`\n  Live mail:  emails inbox watch   ·   browse:  emails ui`));
        output({ domain, provider: provider.name, domain_id: rec.id }, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("list")
    .description("List domains")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action(listDomainsAction);

  domainCmd
    .command("dns <domain>")
    .description("Show DNS records for a domain")
    .option("--provider <id>", "Provider ID (optional if domain is unambiguous)")
    .action(dnsAction);

  domainCmd
    .command("verify <domain>")
    .description("Re-verify domain DNS status")
    .option("--provider <id>", "Provider ID")
    .action(verifyAction);

  domainCmd
    .command("status")
    .description("Show domain readiness summary table")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show per-domain issues and first fix command")
    .action((opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        selfHostedLocalOnly("emails domain status");
        const db = getDatabase();
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const page = parseCliListPage(opts);
        const verbose = opts.verbose || isCliVerboseOutput();
        const domains = listDomains(providerId, db, page);
        if (domains.length === 0) {
          output([], chalk.dim("No domains configured."));
          return;
        }
        const domainIds = domains.map((domain) => domain.id);
        const providerNames = listProviderNamesByIds(domains.map((domain) => domain.provider_id), db);
        const domainProvisioning = listDomainProvisioningByIds(domainIds, db);
        const readyAddressCounts = listReadyAddressCountsByDomains(domainIds, db);
        const rows = domains.map((d) => {
          const provisioning = domainProvisioning.get(d.id) ?? null;
          const ready_addresses = readyAddressCounts.get(d.id) ?? 0;
          const readiness = assessDomainLifecycleReadiness(d, resolveEmailsMode(), ready_addresses, provisioning);
          return {
            ...d,
            provider_name: providerNames.get(d.provider_id) ?? null,
            provisioning,
            readiness,
          };
        });
        const lines: string[] = [""];
        lines.push(tableRow(
          [chalk.bold("Domain"), 18],
          [chalk.bold("Provider"), 14],
          [chalk.bold("Send"), 12],
          [chalk.bold("Receive"), 12],
          [chalk.bold("DNS"), 18],
          [chalk.bold("Readiness"), 22],
        ));
        for (const row of rows) {
          const providerName = row.provider_name ? truncate(row.provider_name, 14) : row.provider_id.slice(0, 8);
          const send = row.readiness.send_ready ? chalk.green("ready") : chalk.yellow("not ready");
          const receive = row.readiness.receive_ready ? chalk.green("ready") : chalk.yellow("not ready");
          const dns = verbose
            ? `D:${colorDnsStatus(row.dkim_status)} S:${colorDnsStatus(row.spf_status)} M:${colorDnsStatus(row.dmarc_status)}`
            : `D:${row.dkim_status} S:${row.spf_status} M:${row.dmarc_status}`;
          const dnsCell = verbose ? dns : truncate(dns, 18);
          const state = row.readiness.state === "broken"
            ? chalk.red(formatDomainReadinessState(row.readiness.state))
            : row.readiness.state.includes("ready")
              ? chalk.green(formatDomainReadinessState(row.readiness.state))
              : chalk.yellow(formatDomainReadinessState(row.readiness.state));
          const stateCell = verbose ? state : truncate(state, 22);
          lines.push(tableRow(
            [truncate(row.domain, 18), 18],
            [providerName, 14],
            [send, 12],
            [receive, 12],
            [dnsCell, verbose ? 34 : 18],
            [stateCell, verbose ? 28 : 22],
          ));
          if (verbose && row.readiness.issues.length > 0) {
            lines.push(chalk.dim(`  ${row.domain}: ${row.readiness.issues.join(", ")}`));
          }
          if (verbose && row.readiness.fix_commands.length > 0 && !row.readiness.receive_ready) {
            lines.push(chalk.dim(`  fix: ${row.readiness.fix_commands[0]}`));
          }
        }
        lines.push("");
        lines.push(formatListHint({
          shown: rows.length,
          limit: page.limit,
          offset: page.offset,
          noun: "domain",
          detailCommand: verbose ? "use emails domain dns <domain> for DNS records" : "use --verbose for issue/fix lines or emails domain dns <domain>",
          verbose,
        }));
        output(rows, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("usable")
    .description("List domains usable for sending and/or receiving")
    .option("--receive", "Only domains ready to receive")
    .option("--send", "Only domains ready to send")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip after filtering", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { receive?: boolean; send?: boolean; provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        selfHostedLocalOnly("emails domain usable");
        const db = getDatabase();
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const page = parseCliListPage(opts);
        const domains = listUsableDomains({
          provider_id: providerId,
          send: opts.send,
          receive: opts.receive,
          limit: page.limit,
          offset: page.offset,
        }, db);
        const domainIds = domains.map((domain) => domain.id);
        const providerNames = listProviderNamesByIds(domains.map((domain) => domain.provider_id), db);
        const domainProvisioning = listDomainProvisioningByIds(domainIds, db);
        const readyAddressCounts = listReadyAddressCountsByDomains(domainIds, db);
        const rows = domains.map((domain) => {
          const provisioning = domainProvisioning.get(domain.id) ?? null;
          const ready_addresses = readyAddressCounts.get(domain.id) ?? 0;
          const readiness = assessDomainLifecycleReadiness(domain, resolveEmailsMode(), ready_addresses, provisioning);
          return {
            ...domain,
            provider_name: providerNames.get(domain.provider_id) ?? null,
            provisioning,
            readiness,
          };
        });
        const visibleRows = rows.filter((row) => {
          if (opts.send && !row.readiness.send_ready) return false;
          if (opts.receive && !row.readiness.receive_ready) return false;
          return opts.send || opts.receive ? true : row.readiness.send_ready || row.readiness.receive_ready;
        });
        const lines = visibleRows.length ? [chalk.bold("\nUsable domains:")] : [chalk.dim("No usable domains found.")];
        for (const row of visibleRows) {
          const modes = [
            row.readiness.send_ready ? "send" : null,
            row.readiness.receive_ready ? "receive" : null,
          ].filter(Boolean).join("+");
          lines.push(`  ${chalk.cyan(row.domain)}  ${chalk.dim(row.provider_name ?? row.provider_id.slice(0, 8))}  ${chalk.green(modes || "none")}  ${chalk.dim(formatDomainReadinessState(row.readiness.state))}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: visibleRows.length,
          limit: page.limit,
          offset: page.offset,
          noun: "domain",
          detailCommand: "use emails domain status for readiness details",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(visibleRows, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("move-provider <domain>")
    .description("Move an existing domain and its addresses to another provider")
    .requiredOption("--to-provider <id>", "Target provider ID")
    .option("--from-provider <id>", "Source provider ID; required if the domain exists on multiple providers")
    .option("--dry-run", "Show the planned provider move without mutating state")
    .option("--yes", "Skip confirmation prompt")
    .action(async (domainName: string, opts: { toProvider: string; fromProvider?: string; dryRun?: boolean; yes?: boolean }) => {
      try {
        selfHostedLocalOnly("emails domain move-provider");
        const db = getDatabase();
        const toProviderId = resolveId("providers", opts.toProvider);
        const toProvider = getProvider(toProviderId);
        if (!toProvider) handleError(new Error(`Provider not found: ${opts.toProvider}`));

        let domain;
        if (opts.fromProvider) {
          const fromProviderId = resolveId("providers", opts.fromProvider);
          domain = getDomainByName(fromProviderId, domainName, db);
          if (!domain) handleError(new Error(`Domain not found for source provider: ${domainName}`));
        } else {
          const matches = findDomainsByName(domainName, db);
          if (matches.length === 0) handleError(new Error(`Domain not found: ${domainName}`));
          if (matches.length > 1) {
            const choices = matches.map((d) => `${d.id.slice(0, 8)} provider=${d.provider_id.slice(0, 8)}`).join(", ");
            handleError(new Error(`Domain is ambiguous; pass --from-provider. Matches: ${choices}`));
          }
          domain = matches[0];
        }

        const fromProvider = getProvider(domain!.provider_id);
        if (!fromProvider) handleError(new Error(`Source provider not found: ${domain!.provider_id}`));
        const targetDomain = getDomainByName(toProviderId, domain!.domain, db);
        const matchingAddresses = db
          .query(
            `SELECT COUNT(*) AS count
               FROM addresses
              WHERE provider_id = ?
                AND LOWER(substr(email, instr(email, '@') + 1)) = LOWER(?)`,
          )
          .get(domain!.provider_id, domain!.domain) as { count: number } | null;
        const conflicts = db
          .query(
            `SELECT a.email
               FROM addresses a
              WHERE a.provider_id = ?
                AND LOWER(substr(a.email, instr(a.email, '@') + 1)) = LOWER(?)
                AND EXISTS (
                  SELECT 1
                    FROM addresses b
                   WHERE b.provider_id = ?
                     AND b.email = a.email COLLATE NOCASE
                     AND b.id != a.id
                )
              ORDER BY a.email ASC
              LIMIT 10`,
          )
          .all(domain!.provider_id, domain!.domain, toProviderId) as Array<{ email: string }>;

        const plan = {
          domain: domain!.domain,
          domain_id: domain!.id,
          from_provider_id: domain!.provider_id,
          from_provider_name: fromProvider!.name,
          to_provider_id: toProviderId,
          to_provider_name: toProvider!.name,
          matching_addresses: Number(matchingAddresses?.count ?? 0),
          target_domain_exists: !!targetDomain,
          conflicts: conflicts.map((row) => row.email),
        };

        if (opts.dryRun) {
          output({ dry_run: true, ...plan }, chalk.dim(`Would move ${domain!.domain} from ${fromProvider!.name} to ${toProvider!.name} and update ${plan.matching_addresses} address row(s).`));
          return;
        }

        if (targetDomain && targetDomain.id !== domain!.id) {
          handleError(new Error(`Target provider already has domain ${domain!.domain} (${targetDomain.id.slice(0, 8)})`));
        }
        if (conflicts.length > 0) {
          handleError(new Error(`Target provider already has matching address row(s): ${conflicts.map((row) => row.email).join(", ")}`));
        }

        await confirmDestructiveAction(`Move ${domain!.domain} from ${fromProvider!.name} to ${toProvider!.name}?`, opts.yes);
        const result = moveDomainProvider(domain!.id, toProviderId, db);
        output({ ...plan, ...result }, chalk.green(`✓ Moved ${domain!.domain} to ${toProvider!.name}; updated ${result.moved_addresses} address row(s).`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("remove <id>")
    .description("Remove a domain")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        if (isSelfHostedMode()) {
          const resolvedId = resolveSelfHostedDomainId(id);
          const domain = getDomain(resolvedId);
          if (!domain) handleError(new Error(`Domain not found: ${id}`));
          await confirmDestructiveAction(`Remove domain ${domain.domain}?`, opts.yes);
          deleteDomain(resolvedId);
          console.log(chalk.green(`✓ Domain removed: ${domain.domain}`));
          return;
        }
        const resolvedId = resolveId("domains", id);
        const domain = getDomain(resolvedId);
        if (!domain) handleError(new Error(`Domain not found: ${id}`));
        await confirmDestructiveAction(`Remove domain ${domain.domain}?`, opts.yes);
        deleteDomain(resolvedId);
        console.log(chalk.green(`✓ Domain removed: ${domain.domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("check <domain>")
    .description("Live DNS check — verify actual DNS records against expected")
    .option("--provider <id>", "Provider ID")
    .action(checkAction);

  // ─── WARMING COMMANDS ──────────────────────────────────────────────────────

  domainCmd
    .command("setup-cloudflare <domain>")
    .description("Auto-create DNS records in Cloudflare for email sending (DKIM, SPF, DMARC)")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .option("--cloudflare-token <token>", "Cloudflare API token (falls back to config/env)")
    .option("--mx", "Also add MX record for receiving email")
    .option("--mx-server <host>", "Custom MX server hostname")
    .option("--register-ses", "Register the domain with SES first if not already added")
    .option("--force-mx-switch", "Allow adding MX even when existing root MX belongs to another provider")
    .action(async (domain: string, opts: {
      provider: string;
      cloudflareToken?: string;
      mx?: boolean;
      mxServer?: string;
      registerSes?: boolean;
      forceMxSwitch?: boolean;
    }) => {
      try {
        selfHostedLocalOnly("emails domain setup-cloudflare");
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        if (opts.mx) {
          const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
          await guardSesInboundMx(domain, !!opts.forceMxSwitch);
        }

        // Optionally register with SES first
        if (opts.registerSes) {
          console.log(chalk.dim(`Registering ${domain} with ${provider!.type.toUpperCase()}...`));
          const adapter = getAdapter(provider!);
          await adapter.addDomain(domain);
          const { createDomain, getDomainByName } = await import("../../db/domains.js");
          getDomainByName(providerId, domain) ?? createDomain(providerId, domain);
          console.log(chalk.green(`  ✓ Domain registered with ${provider!.type.toUpperCase()}`));
        }

        const { setupEmailDns } = await import("../../lib/cloudflare-dns.js");

        console.log(chalk.dim(`Setting up DNS records in Cloudflare for ${domain}...`));
        const result = await setupEmailDns({
          domain,
          provider: provider!,
          apiToken: opts.cloudflareToken,
          addMx: opts.mx,
          mxServer: opts.mxServer,
          forceMxSwitch: opts.forceMxSwitch,
        });

        console.log(chalk.bold(`\nCloudflare DNS setup for ${domain}:`));
        console.log(chalk.dim(`  Zone: ${result.zone_name} (${result.zone_id})\n`));

        for (const r of result.records) {
          const icon = r.status === "created" ? chalk.green("✓")
            : r.status === "skipped" ? chalk.dim("–")
            : chalk.red("✗");
          const label = r.status === "skipped" ? chalk.dim("already exists") : "";
          const err = r.error ? chalk.red(` (${r.error})`) : "";
          console.log(`  ${icon} ${r.type.padEnd(6)} ${r.name}${label}${err}`);
        }

        console.log(`\n  Created: ${chalk.green(String(result.created))}  Skipped: ${chalk.dim(String(result.skipped))}${result.failed > 0 ? `  Failed: ${chalk.red(String(result.failed))}` : ""}`);

        if (result.created > 0) {
          console.log(chalk.dim(`\n  DNS changes may take a few minutes to propagate.`));
          console.log(chalk.dim(`  Verify with: emails domain verify ${domain} --provider ${opts.provider}`));
        }
        console.log();
        output(result, "");
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("setup-brandsight <domain>")
    .description("Auto-create DNS records in BrandSight/GCD for email sending and SES receiving")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .option("--api-key <key>", "BrandSight API key (falls back to config/env)")
    .option("--api-secret <secret>", "BrandSight API secret (falls back to config/env)")
    .option("--customer-id <id>", "BrandSight customer ID (falls back to config/env)")
    .option("--mx", "Also add SES inbound MX record for receiving email")
    .option("--mail-from <subdomain>", "Custom SES MAIL FROM subdomain (default mail.<domain>)")
    .option("--no-set-nameservers", "Do not switch the registrar nameservers to BrandSight/GCD")
    .option("--remove-dnssec", "Remove stale registrar DNSSEC records before/while switching to unsigned BrandSight DNS")
    .option("--force-mx-switch", "Allow adding SES inbound MX even when existing root MX belongs to another provider")
    .action(async (domain: string, opts: {
      provider: string;
      apiKey?: string;
      apiSecret?: string;
      customerId?: string;
      mx?: boolean;
      mailFrom?: string;
      setNameservers?: boolean;
      removeDnssec?: boolean;
      forceMxSwitch?: boolean;
    }) => {
      try {
        selfHostedLocalOnly("emails domain setup-brandsight");
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        if (opts.mx) {
          const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
          await guardSesInboundMx(domain, !!opts.forceMxSwitch);
        }

        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);
        if (provider!.type === "ses" && adapter.reinitiateDomainVerification) {
          await adapter.reinitiateDomainVerification(domain);
        }
        let mailFrom: string | null = null;
        if (adapter.setMailFrom) {
          mailFrom = await adapter.setMailFrom(domain, opts.mailFrom);
        }

        const { getBrandsightAuth } = await import("../../lib/config.js");
        const auth = opts.apiKey || opts.apiSecret || opts.customerId
          ? {
              apiKey: opts.apiKey ?? "",
              apiSecret: opts.apiSecret ?? "",
              customerId: opts.customerId ?? "",
            }
          : getBrandsightAuth();
        if (!auth?.apiKey || !auth.apiSecret || !auth.customerId) {
          handleError(new Error("BrandSight credentials not configured (set config keys or pass --api-key, --api-secret, --customer-id)"));
        }

        const { setupBrandsightEmailDns } = await import("../../lib/brandsight-dns.js");
        console.log(chalk.dim(`Setting up DNS records in BrandSight for ${domain}...`));
        const result = await setupBrandsightEmailDns({
          domain,
          provider: provider!,
          auth: auth!,
          addMx: !!opts.mx,
          mailFromDomain: mailFrom,
          setNameservers: opts.setNameservers !== false,
          removeDnssec: !!opts.removeDnssec,
        });

        const db = getDatabase();
        const rec = getDomainByName(providerId, domain, db) ?? createDomain(providerId, domain, db);
        setDomainProvisioning(rec.id, {
          provisioning_status: "dns_published",
          dns_provider: "brandsight",
          send_provider: provider!.type,
          nameservers: result.nameservers.desired,
          mail_from_domain: mailFrom,
          last_error: result.failed > 0 ? `${result.failed} BrandSight DNS record(s) failed` : null,
          next_check_at: new Date().toISOString(),
        }, db);

        console.log(chalk.bold(`\nBrandSight DNS setup for ${domain}:`));
        console.log(chalk.dim(`  Nameservers: ${result.nameservers.status}`) + (result.nameservers.error ? chalk.red(` (${result.nameservers.error})`) : ""));
        console.log(chalk.dim(`  DNSSEC: ${result.dnssec.status}${result.dnssec.removed ? ` (${result.dnssec.removed} removed)` : ""}`) + (result.dnssec.error ? chalk.red(` (${result.dnssec.error})`) : ""));
        for (const r of result.records) {
          const icon = r.status === "created" || r.status === "replaced" ? chalk.green("✓")
            : r.status === "skipped" ? chalk.dim("–")
            : chalk.red("✗");
          const err = r.error ? chalk.red(` (${r.error})`) : "";
          console.log(`  ${icon} ${r.type.padEnd(6)} ${r.name} ${chalk.dim(r.status)}${err}`);
        }
        console.log(`\n  Created: ${chalk.green(String(result.created))}  Replaced: ${chalk.green(String(result.replaced))}  Skipped: ${chalk.dim(String(result.skipped))}${result.failed > 0 ? `  Failed: ${chalk.red(String(result.failed))}` : ""}`);
        console.log(chalk.dim(`\n  Verify: emails domain check ${domain} --provider ${opts.provider}`));
        console.log();
        output(result, "");
        if (result.failed > 0) handleError(new Error(`${result.failed} BrandSight DNS record(s) failed for ${domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm <domain>")
    .description("Start a warming schedule for a domain")
    .requiredOption("--target <n>", "Target daily send volume", parseInt)
    .option("--start-date <YYYY-MM-DD>", "Start date (default: today)")
    .option("--provider <id>", "Provider ID to associate")
    .action((domain: string, opts: { target: number; startDate?: string; provider?: string }) => {
      try {
        selfHostedLocalOnly("emails domain warm");
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const schedule = createWarmingSchedule({
          domain,
          provider_id: providerId,
          target_daily_volume: opts.target,
          start_date: opts.startDate,
        });
        console.log(chalk.green(`✓ Warming schedule created for ${domain}`));
        console.log(formatWarmingStatus(schedule));
        const plan = generateWarmingPlan(opts.target);
        console.log(chalk.dim(`\nWill reach target (${opts.target}/day) in ${plan[plan.length - 1]?.day ?? "?"} days`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-status <domain>")
    .description("Show warming schedule status for a domain")
    .action((domain: string) => {
      try {
        selfHostedLocalOnly("emails domain warm-status");
        const schedule = getWarmingSchedule(domain);
        if (!schedule) {
          console.log(chalk.yellow(`No warming schedule found for ${domain}`));
          return;
        }
        console.log("\n" + formatWarmingStatus(schedule) + "\n");
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-list")
    .description("List all domain warming schedules")
    .option("--status <status>", "Filter by status (active, paused, completed)")
    .option("--limit <n>", "Maximum schedules to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of schedules to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { status?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        selfHostedLocalOnly("emails domain warm-list");
        const page = parseCliListPage(opts);
        const schedules = listWarmingSchedules(opts.status, undefined, page);
        if (schedules.length === 0) {
          output([], chalk.dim("No warming schedules found."));
          return;
        }
        const lines = [""];
        lines.push(tableRow(
          [chalk.bold("Domain"), 20],
          [chalk.bold("Status"), 10],
          [chalk.bold("Start Date"), 12],
          [chalk.bold("Target"), 10],
          [chalk.bold("Today's Limit"), 14],
          [chalk.bold("Sent Today"), 12],
        ));
        for (const s of schedules) {
          const todayLimit = getTodayLimit(s);
          const todaySent = getTodaySentCount(s.domain);
          const statusColor = s.status === "active" ? chalk.green(s.status)
            : s.status === "paused" ? chalk.yellow(s.status)
            : chalk.dim(s.status);
          lines.push(tableRow(
            [truncate(s.domain, 20), 20],
            [statusColor, 10],
            [s.start_date, 12],
            [String(s.target_daily_volume), 10],
            [todayLimit !== null ? String(todayLimit) : chalk.dim("n/a"), 14],
            [String(todaySent), 12],
          ));
        }
        lines.push("");
        lines.push(formatListHint({
          shown: schedules.length,
          limit: page.limit,
          offset: page.offset,
          noun: "warming schedule",
          detailCommand: "use emails domain warm-status <domain> for details",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(schedules, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-pause <domain>")
    .description("Pause a domain warming schedule")
    .action((domain: string) => {
      try {
        selfHostedLocalOnly("emails domain warm-pause");
        const updated = updateWarmingStatus(domain, "paused");
        if (!updated) {
          console.log(chalk.yellow(`No warming schedule found for ${domain}`));
          return;
        }
        console.log(chalk.yellow(`⏸ Warming schedule paused for ${domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-resume <domain>")
    .description("Resume a paused domain warming schedule")
    .action((domain: string) => {
      try {
        selfHostedLocalOnly("emails domain warm-resume");
        const updated = updateWarmingStatus(domain, "active");
        if (!updated) {
          console.log(chalk.yellow(`No warming schedule found for ${domain}`));
          return;
        }
        console.log(chalk.green(`▶ Warming schedule resumed for ${domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-complete <domain>")
    .description("Mark a domain warming schedule as completed")
    .action((domain: string) => {
      try {
        selfHostedLocalOnly("emails domain warm-complete");
        const updated = updateWarmingStatus(domain, "completed");
        if (!updated) {
          console.log(chalk.yellow(`No warming schedule found for ${domain}`));
          return;
        }
        console.log(chalk.green(`✓ Warming schedule marked complete for ${domain}`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── DOMAIN PURCHASING (via @hasna/domains / Route 53) ───────────────────

  domainCmd
    .command("available <domain>")
    .description("Check if a domain is available for purchase and get pricing")
    .action(async (domain: string) => {
      try {
        const { r53CheckAvailability } = await import("@hasna/domains");
        const result = await r53CheckAvailability(domain);
        if (result.available) {
          const price = result.price ? chalk.green(` — ${result.currency ?? "USD"} ${result.price}/yr`) : "";
          console.log(chalk.green(`✓ ${domain} is available${price}`));
        } else {
          console.log(chalk.red(`✗ ${domain} is not available`));
        }
        output(result, "");
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("buy <domain>")
    .description("Purchase a domain via Route 53")
    .requiredOption("--email <email>", "Registrant email")
    .requiredOption("--first-name <name>", "First name")
    .requiredOption("--last-name <name>", "Last name")
    .requiredOption("--phone <phone>", "Phone in E.164 format (e.g. +1.5551234567)")
    .requiredOption("--address <addr>", "Street address")
    .requiredOption("--city <city>", "City")
    .option("--state <state>", "State/province; optional and omitted for countries where Route 53 rejects it")
    .requiredOption("--country <code>", "Two-letter country code (e.g. US, RO)")
    .requiredOption("--zip <zip>", "ZIP/postal code")
    .option("--org <name>", "Organization name")
    .option("--years <n>", "Registration years", "1")
    .action(async (domain: string, opts: {
      email: string; firstName: string; lastName: string;
      phone: string; address: string; city: string; state?: string;
      country: string; zip: string; org?: string; years: string;
    }) => {
      try {
        const { r53CheckAvailability, r53RegisterDomain } = await import("@hasna/domains");
        console.log(chalk.dim(`Checking availability of ${domain}...`));
        const avail = await r53CheckAvailability(domain);
        if (!avail.available) { console.error(chalk.red(`✗ ${domain} is not available`)); process.exit(1); }
        const price = avail.price ? ` (${avail.currency ?? "USD"} ${avail.price}/yr)` : "";
        console.log(chalk.green(`  ✓ Available${price}`));
        const contact = normalizeRoute53RegistrationContact({
          first_name: opts.firstName, last_name: opts.lastName,
          email: opts.email, phone: opts.phone,
          address_line_1: opts.address, city: opts.city,
          state: opts.state, country_code: opts.country,
          zip_code: opts.zip, organization_name: opts.org,
        });
        const result = await r53RegisterDomain(domain, contact as Parameters<typeof r53RegisterDomain>[1], parseInt(opts.years));
        console.log(chalk.green(`✓ Registration submitted for ${domain}`));
        console.log(chalk.dim(`  Operation ID: ${result.operationId}`));
        console.log(chalk.dim(`  Check status: emails domain purchase-status ${result.operationId}`));
        output(result, "");
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("purchase-status <operationId>")
    .description("Check domain registration/purchase status")
    .action(async (operationId: string) => {
      try {
        const { r53GetRegistrationStatus } = await import("@hasna/domains");
        const result = await r53GetRegistrationStatus(operationId);
        const color = result.status === "SUCCESSFUL" ? chalk.green : result.status === "FAILED" ? chalk.red : chalk.yellow;
        console.log(`Status: ${color(result.status)}`);
        if (result.domain) console.log(`Domain: ${result.domain}`);
        if (result.message) console.log(`Message: ${result.message}`);
        output(result, "");
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("list-registered")
    .description("List domains registered in Route 53")
    .action(async () => {
      try {
        const { r53ListRegisteredDomains } = await import("@hasna/domains");
        const domains = await r53ListRegisteredDomains();
        if (domains.length === 0) { output([], chalk.dim("No domains registered in Route 53.")); return; }
        const lines = [chalk.bold("\nRegistered domains:")];
        for (const d of domains) {
          const expiry = d.expiry ? chalk.dim(` — expires ${d.expiry.split("T")[0]}`) : "";
          const renew = d.auto_renew ? chalk.green(" [auto-renew]") : "";
          lines.push(`  ${chalk.cyan(d.domain)}${expiry}${renew}`);
        }
        lines.push("");
        output(domains, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  domainCmd
    .command("setup <domain>")
    .description("Full setup: buy + Route 53 zone + register with SES + configure DNS (DKIM/SPF/DMARC)")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .requiredOption("--email <email>", "Registrant email")
    .requiredOption("--first-name <name>", "First name")
    .requiredOption("--last-name <name>", "Last name")
    .requiredOption("--phone <phone>", "Phone (e.g. +1.5551234567)")
    .requiredOption("--address <addr>", "Street address")
    .requiredOption("--city <city>", "City")
    .option("--state <state>", "State/province; optional and omitted for countries where Route 53 rejects it")
    .requiredOption("--country <code>", "Country code (e.g. US, RO)")
    .requiredOption("--zip <zip>", "ZIP code")
    .option("--org <name>", "Organization name")
    .option("--years <n>", "Registration years", "1")
    .option("--skip-buy", "Skip domain purchase (domain already registered)")
    .action(async (domain: string, opts: {
      provider: string; email: string; firstName: string; lastName: string;
      phone: string; address: string; city: string; state?: string;
      country: string; zip: string; org?: string; years: string; skipBuy?: boolean;
    }) => {
      try {
        selfHostedLocalOnly("emails domain setup");
        const { r53CheckAvailability, r53RegisterDomain, r53CreateHostedZone, r53FindHostedZoneByDomain, r53UpsertRecords } = await import("@hasna/domains");
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
        const steps = opts.skipBuy ? 2 : 3;
        let step = 0;

        if (!opts.skipBuy) {
          step++;
          console.log(chalk.dim(`[${step}/${steps}] Checking and registering domain...`));
          const avail = await r53CheckAvailability(domain);
          if (!avail.available) handleError(new Error(`${domain} is not available`));
          const price = avail.price ? ` (${avail.currency ?? "USD"} ${avail.price}/yr)` : "";
          console.log(chalk.green(`  ✓ Available${price}`));
          const contact = normalizeRoute53RegistrationContact({
            first_name: opts.firstName, last_name: opts.lastName,
            email: opts.email, phone: opts.phone,
            address_line_1: opts.address, city: opts.city,
            state: opts.state, country_code: opts.country,
            zip_code: opts.zip, organization_name: opts.org,
          });
          const reg = await r53RegisterDomain(domain, contact as Parameters<typeof r53RegisterDomain>[1], parseInt(opts.years));
          console.log(chalk.green(`  ✓ Registration submitted (op: ${reg.operationId})`));
        }

        step++;
        console.log(chalk.dim(`[${step}/${steps}] Setting up Route 53 hosted zone...`));
        let zone = await r53FindHostedZoneByDomain(domain);
        let nameServers: string[] = [];
        if (!zone) {
          const created = await r53CreateHostedZone(domain, `Email sending for ${domain}`);
          zone = created;
          nameServers = (created as { name_servers?: string[] }).name_servers ?? [];
          console.log(chalk.green(`  ✓ Hosted zone created (${zone.id})`));
        } else {
          console.log(chalk.green(`  ✓ Using existing zone (${zone.id})`));
        }

        step++;
        console.log(chalk.dim(`[${step}/${steps}] Registering with SES and configuring DNS records...`));
        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);
        if (provider!.type === "ses" && adapter.reinitiateDomainVerification) {
          await adapter.reinitiateDomainVerification(domain);
        }
        createDomain(providerId, domain);
        const dnsRecords = await adapter.getDnsRecords(domain);
        const r53Records = dnsRecords.map((r) => ({
          name: r.name, type: r.type, ttl: 300,
          values: r.type === "TXT" ? [`"${r.value}"`] : [r.value],
        }));
        await r53UpsertRecords(zone.id, r53Records);
        console.log(chalk.green(`  ✓ ${r53Records.length} DNS records created`));

        console.log(chalk.bold(`\n✓ Setup complete for ${domain}`));
        if (nameServers.length > 0) {
          console.log(chalk.bold("\n  Name servers (point your registrar here):"));
          for (const ns of nameServers) console.log(chalk.cyan(`    ${ns}`));
        }
        console.log(chalk.dim(`\n  Verify: emails domain verify ${domain} --provider ${opts.provider}`));
        console.log();
      } catch (e) { handleError(e); }
    });
}
