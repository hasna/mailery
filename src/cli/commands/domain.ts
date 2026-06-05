import type { Command } from "commander";
import chalk from "chalk";
import { createDomain, listDomains, deleteDomain, getDomain, getDomainByName, updateDnsStatus } from "../../db/domains.js";
import { listAddresses } from "../../db/addresses.js";
import { getProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { getAdapter } from "../../providers/index.js";
import { formatDnsTable } from "../../lib/dns.js";
import { colorDnsStatus, truncate, tableRow } from "../../lib/format.js";
import { confirmDestructiveAction, handleError, resolveId } from "../utils.js";
import { createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus } from "../../db/warming.js";
import { formatWarmingStatus, generateWarmingPlan, getTodayLimit, getTodaySentCount } from "../../lib/warming.js";
import { getAddressProvisioning, getDomainProvisioning } from "../../db/provisioning.js";
import { assessDomainReadiness, formatDomainReadinessState } from "../../lib/domain-readiness.js";

export function registerDomainCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const domainCmd = program.command("domain").description("Manage sending domains");

  const listDomainsAction = (opts: { provider?: string }) => {
    try {
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const domains = listDomains(providerId);
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
      output(domains, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  program
    .command("domains")
    .description("List sending domains (alias: emails domain list)")
    .option("--provider <id>", "Filter by provider ID")
    .action(listDomainsAction);

  domainCmd
    .command("add <domain>")
    .description("Add a domain to a provider")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--dry-run", "Resolve inputs and show the planned change without calling the provider or writing to the DB")
    .action(async (domain: string, opts: { provider: string; dryRun?: boolean }) => {
      try {
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
        const existing = getDomainByName(providerId, domain);

        if (opts.dryRun) {
          output({
            dry_run: true,
            domain,
            provider_id: providerId,
            existing,
            would_create_domain: !existing,
            would_call_provider: !existing,
            cli_equivalent: `emails domain add ${domain} --provider ${opts.provider}`,
          }, existing
            ? chalk.dim(`Domain already exists locally: ${domain} (${existing.id.slice(0, 8)})`)
            : chalk.dim(`Would add ${domain} to provider ${provider!.name} and register it locally.`));
          return;
        }

        if (existing) {
          output(existing, chalk.green(`✓ Domain already exists: ${domain} (${existing.id.slice(0, 8)})`));
          return;
        }

        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);

        const d = createDomain(providerId, domain);
        console.log(chalk.green(`✓ Domain added: ${domain} (${d.id.slice(0, 8)})`));
        console.log(chalk.dim("Run 'emails domain dns <domain>' to see required DNS records."));
      } catch (e) {
        handleError(e);
      }
    });

  // ── adopt: seamlessly add an already-registered & SES-verified domain ────────
  domainCmd
    .command("adopt <domain>")
    .description("Add an already-registered, SES-verified domain: register it, wire SES inbound (S3), add a catch-all, and optionally sync")
    .requiredOption("--provider <id>", "SES provider where the domain is verified")
    .option("--no-inbound", "Skip SES inbound (S3 receipt rule) setup")
    .option("--bucket <name>", "Inbound S3 bucket (default: config, else hasna-emails-prod-inbound-<accountId>)")
    .option("--region <region>", "AWS region (default: the provider's region)")
    .option("--catch-all <target>", "Route ALL mail for this domain to this address")
    .option("--sync", "Run an initial inbound sync after wiring")
    .action(async (domain: string, opts: { provider: string; inbound?: boolean; bucket?: string; region?: string; catchAll?: string; sync?: boolean }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) return handleError(new Error(`Provider not found: ${opts.provider}`));

        const region = opts.region ?? provider.region ?? "us-east-1";
        const accessKeyId = provider.access_key ?? undefined;
        const secretAccessKey = provider.secret_key ?? undefined;
        const lines: string[] = [chalk.bold(`\nAdopting ${domain} → ${provider.name}`)];

        // 1. Ensure the SES identity exists (idempotent if already verified).
        const adapter = getAdapter(provider);
        await adapter.addDomain(domain);
        lines.push(chalk.green(`✓ SES identity ensured`));

        // 2. Register in the emails store.
        const rec = getDomainByName(providerId, domain, db) ?? createDomain(providerId, domain, db);
        lines.push(chalk.green(`✓ Registered in emails (${rec.id.slice(0, 8)})`));

        // 3. Record verification status.
        try {
          const st = await adapter.verifyDomain(domain);
          updateDnsStatus(rec.id, st.dkim, st.spf, st.dmarc, db);
          lines.push(`  ${colorDnsStatus(st.dkim)} DKIM · ${colorDnsStatus(st.spf)} SPF · ${colorDnsStatus(st.dmarc)} DMARC`);
        } catch { /* non-fatal */ }

        // 4. Inbound — per provider.
        if (opts.inbound !== false && provider.type === "resend") {
          lines.push(chalk.green(`✓ Resend domain ready`));
          lines.push(chalk.dim(`  Inbound is push: add a Resend inbound webhook → POST /webhook/resend-inbound on 'emails serve'`));
        }
        if (opts.inbound !== false && provider.type === "gmail") {
          lines.push(chalk.dim(`  Gmail is account-based — receive with 'emails inbox sync' (emails ui can auto-pull Gmail)`));
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
            bucket = `hasna-emails-prod-inbound-${acct}`;
          }
          const { setupInboundEmail } = await import("../../lib/aws-inbound.js");
          const r = await setupInboundEmail({ domain, bucket, region, accessKeyId, secretAccessKey });
          lines.push(chalk.green(`✓ SES inbound → s3://${r.bucket}/${r.s3_prefix}`) + chalk.dim(` (rule ${r.rule_name}${r.bucket_created ? ", bucket created" : ""})`));
          lines.push(chalk.dim(`  Publish MX in DNS:  ${r.mx_record}  (for @${domain})`));
          // Register the bucket so 'inbox watch' / the TUI auto-pull sync it
          // (multi-bucket: domains can live in different AWS accounts).
          const { addInboundBucket } = await import("../../lib/config.js");
          addInboundBucket(r.bucket, region, providerId);
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
    .action(listDomainsAction);

  domainCmd
    .command("dns <domain>")
    .description("Show DNS records for a domain")
    .option("--provider <id>", "Provider ID (optional if domain is unambiguous)")
    .action(async (domain: string, opts: { provider?: string }) => {
      try {
        let providerId: string | undefined;
        if (opts.provider) {
          providerId = resolveId("providers", opts.provider);
        }

        // Find domain in DB
        const domains = listDomains(providerId);
        const found = domains.find((d) => d.domain === domain);

        if (found) {
          const provider = getProvider(found.provider_id);
          if (provider) {
            const adapter = getAdapter(provider);
            const records = await adapter.getDnsRecords(domain);
            output(records, chalk.bold(`\nDNS Records for ${domain}:\n`) + formatDnsTable(records));
            return;
          }
        }

        // Fallback: generate generic records
        const { generateSpfRecord, generateDmarcRecord } = await import("../../lib/dns.js");
        const records = [generateSpfRecord(domain), generateDmarcRecord(domain)];
        output(records, chalk.bold(`\nDNS Records for ${domain} (generic):\n`) + formatDnsTable(records));
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("verify <domain>")
    .description("Re-verify domain DNS status")
    .option("--provider <id>", "Provider ID")
    .action(async (domain: string, opts: { provider?: string }) => {
      try {
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const domains = listDomains(providerId);
        const found = domains.find((d) => d.domain === domain);
        if (!found) handleError(new Error(`Domain not found: ${domain}`));

        const provider = getProvider(found!.provider_id);
        if (!provider) handleError(new Error("Provider not found"));

        const adapter = getAdapter(provider!);
        const status = await adapter.verifyDomain(domain);
        updateDnsStatus(found!.id, status.dkim, status.spf, status.dmarc);

        console.log(chalk.bold(`\nDNS Status for ${domain}:`));
        console.log(`  DKIM:  ${colorDnsStatus(status.dkim)}`);
        console.log(`  SPF:   ${colorDnsStatus(status.spf)}`);
        console.log(`  DMARC: ${colorDnsStatus(status.dmarc)}`);
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("status")
    .description("Show domain readiness summary table")
    .option("--provider <id>", "Filter by provider ID")
    .action((opts: { provider?: string }) => {
      try {
        const db = getDatabase();
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const domains = listDomains(providerId, db);
        if (domains.length === 0) {
          output([], chalk.dim("No domains configured."));
          return;
        }
        const addresses = listAddresses(undefined, db);
        const rows = domains.map((d) => {
          const provider = getProvider(d.provider_id);
          const provisioning = getDomainProvisioning(d.id, db);
          const ready_addresses = addresses.filter((address) => {
            const addressProvisioning = getAddressProvisioning(address.id, db);
            return addressProvisioning?.domain_id === d.id && addressProvisioning.provisioning_status === "ready";
          }).length;
          const readiness = assessDomainReadiness(d, provisioning, { ready_addresses });
          return {
            ...d,
            provider_name: provider?.name ?? null,
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
          [chalk.bold("DNS"), 22],
          [chalk.bold("Readiness"), 28],
        ));
        for (const row of rows) {
          const providerName = row.provider_name ? truncate(row.provider_name, 14) : row.provider_id.slice(0, 8);
          const send = row.readiness.send_ready ? chalk.green("ready") : chalk.yellow("not ready");
          const receive = row.readiness.receive_ready ? chalk.green("ready") : chalk.yellow("not ready");
          const dns = `D:${colorDnsStatus(row.dkim_status)} S:${colorDnsStatus(row.spf_status)} M:${colorDnsStatus(row.dmarc_status)}`;
          const state = row.readiness.state === "broken"
            ? chalk.red(formatDomainReadinessState(row.readiness.state))
            : row.readiness.state.includes("ready")
              ? chalk.green(formatDomainReadinessState(row.readiness.state))
              : chalk.yellow(formatDomainReadinessState(row.readiness.state));
          lines.push(tableRow(
            [truncate(row.domain, 18), 18],
            [providerName, 14],
            [send, 12],
            [receive, 12],
            [dns, 22],
            [state, 28],
          ));
          if (row.readiness.issues.length > 0) {
            lines.push(chalk.dim(`  ${row.domain}: ${row.readiness.issues.join(", ")}`));
          }
          if (row.readiness.fix_commands.length > 0 && !row.readiness.receive_ready) {
            lines.push(chalk.dim(`  fix: ${row.readiness.fix_commands[0]}`));
          }
        }
        lines.push("");
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
    .action((opts: { receive?: boolean; send?: boolean; provider?: string }) => {
      try {
        const db = getDatabase();
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const addresses = listAddresses(undefined, db);
        const rows = listDomains(providerId, db).map((domain) => {
          const provisioning = getDomainProvisioning(domain.id, db);
          const ready_addresses = addresses.filter((address) => {
            const addressProvisioning = getAddressProvisioning(address.id, db);
            return addressProvisioning?.domain_id === domain.id && addressProvisioning.provisioning_status === "ready";
          }).length;
          const readiness = assessDomainReadiness(domain, provisioning, { ready_addresses });
          return {
            ...domain,
            provider_name: getProvider(domain.provider_id, db)?.name ?? null,
            provisioning,
            readiness,
          };
        }).filter((row) => {
          if (opts.receive && !row.readiness.receive_ready) return false;
          if (opts.send && !row.readiness.send_ready) return false;
          if (!opts.receive && !opts.send) return row.readiness.send_ready || row.readiness.receive_ready;
          return true;
        });
        const lines = rows.length ? [chalk.bold("\nUsable domains:")] : [chalk.dim("No usable domains found.")];
        for (const row of rows) {
          const modes = [
            row.readiness.send_ready ? "send" : null,
            row.readiness.receive_ready ? "receive" : null,
          ].filter(Boolean).join("+");
          lines.push(`  ${chalk.cyan(row.domain)}  ${chalk.dim(row.provider_name ?? row.provider_id.slice(0, 8))}  ${chalk.green(modes || "none")}  ${chalk.dim(formatDomainReadinessState(row.readiness.state))}`);
        }
        lines.push("");
        output(rows, lines.join("\n"));
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
    .action(async (domain: string, opts: { provider?: string }) => {
      try {
        const { checkDnsRecords, formatDnsCheck } = await import("../../lib/dns-check.js");

        let providerId: string | undefined;
        if (opts.provider) {
          providerId = resolveId("providers", opts.provider);
        }

        const domains = listDomains(providerId);
        const found = domains.find((d) => d.domain === domain);

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

        console.log(chalk.bold(`\nDNS Check for ${domain}:`));
        const results = await checkDnsRecords(domain, expectedRecords);
        console.log(formatDnsCheck(results));

        const allMatch = results.every((r) => r.match);
        if (allMatch) {
          console.log(chalk.green("All DNS records verified successfully."));
        } else {
          const missing = results.filter((r) => !r.match).length;
          console.log(chalk.yellow(`${missing} record(s) not yet propagated or missing.`));
        }
        console.log();
      } catch (e) { handleError(e); }
    });

  // ─── WARMING COMMANDS ──────────────────────────────────────────────────────

  domainCmd
    .command("setup-cloudflare <domain>")
    .description("Auto-create DNS records in Cloudflare for email sending (DKIM, SPF, DMARC)")
    .requiredOption("--provider <id>", "SES or Resend provider ID")
    .option("--cloudflare-token <token>", "Cloudflare API token (falls back to config/env)")
    .option("--mx", "Also add MX record for receiving email")
    .option("--mx-server <host>", "Custom MX server hostname")
    .option("--register-ses", "Register the domain with SES first if not already added")
    .action(async (domain: string, opts: {
      provider: string;
      cloudflareToken?: string;
      mx?: boolean;
      mxServer?: string;
      registerSes?: boolean;
    }) => {
      try {
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        // Optionally register with SES first
        if (opts.registerSes) {
          console.log(chalk.dim(`Registering ${domain} with ${provider!.type.toUpperCase()}...`));
          const adapter = getAdapter(provider!);
          await adapter.addDomain(domain);
          const { createDomain } = await import("../../db/domains.js");
          createDomain(providerId, domain);
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
    .command("warm <domain>")
    .description("Start a warming schedule for a domain")
    .requiredOption("--target <n>", "Target daily send volume", parseInt)
    .option("--start-date <YYYY-MM-DD>", "Start date (default: today)")
    .option("--provider <id>", "Provider ID to associate")
    .action((domain: string, opts: { target: number; startDate?: string; provider?: string }) => {
      try {
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
    .action((opts: { status?: string }) => {
      try {
        const schedules = listWarmingSchedules(opts.status);
        if (schedules.length === 0) {
          console.log(chalk.dim("No warming schedules found."));
          return;
        }
        console.log("");
        console.log(tableRow(
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
          console.log(tableRow(
            [truncate(s.domain, 20), 20],
            [statusColor, 10],
            [s.start_date, 12],
            [String(s.target_daily_volume), 10],
            [todayLimit !== null ? String(todayLimit) : chalk.dim("n/a"), 14],
            [String(todaySent), 12],
          ));
        }
        console.log("");
      } catch (e) {
        handleError(e);
      }
    });

  domainCmd
    .command("warm-pause <domain>")
    .description("Pause a domain warming schedule")
    .action((domain: string) => {
      try {
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
    .requiredOption("--state <state>", "State/province")
    .requiredOption("--country <code>", "Two-letter country code (e.g. US, RO)")
    .requiredOption("--zip <zip>", "ZIP/postal code")
    .option("--org <name>", "Organization name")
    .option("--years <n>", "Registration years", "1")
    .action(async (domain: string, opts: {
      email: string; firstName: string; lastName: string;
      phone: string; address: string; city: string; state: string;
      country: string; zip: string; org?: string; years: string;
    }) => {
      try {
        const { r53CheckAvailability, r53RegisterDomain } = await import("@hasna/domains");
        console.log(chalk.dim(`Checking availability of ${domain}...`));
        const avail = await r53CheckAvailability(domain);
        if (!avail.available) { console.error(chalk.red(`✗ ${domain} is not available`)); process.exit(1); }
        const price = avail.price ? ` (${avail.currency ?? "USD"} ${avail.price}/yr)` : "";
        console.log(chalk.green(`  ✓ Available${price}`));
        const result = await r53RegisterDomain(domain, {
          first_name: opts.firstName, last_name: opts.lastName,
          email: opts.email, phone: opts.phone,
          address_line_1: opts.address, city: opts.city,
          state: opts.state, country_code: opts.country,
          zip_code: opts.zip, organization_name: opts.org,
        }, parseInt(opts.years));
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
    .requiredOption("--state <state>", "State/province")
    .requiredOption("--country <code>", "Country code (e.g. US, RO)")
    .requiredOption("--zip <zip>", "ZIP code")
    .option("--org <name>", "Organization name")
    .option("--years <n>", "Registration years", "1")
    .option("--skip-buy", "Skip domain purchase (domain already registered)")
    .action(async (domain: string, opts: {
      provider: string; email: string; firstName: string; lastName: string;
      phone: string; address: string; city: string; state: string;
      country: string; zip: string; org?: string; years: string; skipBuy?: boolean;
    }) => {
      try {
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
          const reg = await r53RegisterDomain(domain, {
            first_name: opts.firstName, last_name: opts.lastName,
            email: opts.email, phone: opts.phone,
            address_line_1: opts.address, city: opts.city,
            state: opts.state, country_code: opts.country,
            zip_code: opts.zip, organization_name: opts.org,
          }, parseInt(opts.years));
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
