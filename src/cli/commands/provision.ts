import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { getProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { getAdapter } from "../../providers/index.js";
import { createDomain, findDomainsByName, getDomainByName, listDomains } from "../../db/domains.js";
import { createAddress, getAddressByEmail } from "../../db/addresses.js";
import { listInboundSubjectsForRecipient } from "../../db/inbound.js";
import {
  setDomainProvisioning, listDomainProvisioningByIds,
  setAddressProvisioning, getAddressProvisioning,
  listAddressProvisioningByDomains,
  listProvisioningEvents,
} from "../../db/provisioning.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";
import { normalizeRoute53RegistrationContact } from "../../lib/route53-contact.js";
import type { MxAssessment } from "../../lib/mx-ownership.js";

type ReceiveStrategy = "ses-s3" | "cf-routing" | "resend-webhook";

export interface ProvisionCommandDeps {
  inspectMx?: (domain: string) => Promise<MxAssessment>;
}

export function registerProvisionCommands(program: Command, output: (data: unknown, formatted: string) => void, deps: ProvisionCommandDeps = {}): void {
  const cmd = program.command("provision").description("Automated domain + address provisioning");

  // ── status ────────────────────────────────────────────────────────────────
  cmd
    .command("status [domain]")
    .description("Show provisioning status of domains and addresses")
    .option("--limit <n>", "Maximum domains to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of domains to skip", "0")
    .option("--verbose", "Show all address provisioning rows per domain")
    .action((domainName: string | undefined, opts: { limit?: string; offset?: string; verbose?: boolean }) => {
      const db = getDatabase();
      const page = parseCliListPage(opts);
      const verbose = opts.verbose || isCliVerboseOutput();
      const domains = domainName ? findDomainsByName(domainName, db) : listDomains(undefined, db, page);
      const domainIds = domains.map((domain) => domain.id);
      const domainProvisioning = listDomainProvisioningByIds(domainIds, db);
      const addressProvisioning = listAddressProvisioningByDomains(domainIds, db);
      const lines: string[] = [];
      for (const d of domains) {
        const p = domainProvisioning.get(d.id) ?? null;
        lines.push(`${chalk.bold(d.domain)}  ${chalk.cyan(p?.provisioning_status ?? "none")}  dns=${p?.dns_provider ?? "?"}  send=${p?.send_provider ?? "-"}${p?.last_error ? chalk.red(" err=" + p.last_error) : ""}`);
        const addressRows = addressProvisioning.get(d.id) ?? [];
        const visibleAddressRows = verbose ? addressRows : addressRows.slice(0, 4);
        for (const a of visibleAddressRows) {
          lines.push(`  ${a.email}  ${chalk.cyan(a.provisioning.provisioning_status)}  recv=${a.provisioning.receive_strategy ?? "-"}`);
        }
        if (!verbose && addressRows.length > visibleAddressRows.length) {
          lines.push(chalk.dim(`  ... ${addressRows.length - visibleAddressRows.length} more address provisioning row(s); use --verbose`));
        }
      }
      if (!domainName && lines.length) {
        lines.push("");
        lines.push(formatListHint({
          shown: domains.length,
          limit: page.limit,
          offset: page.offset,
          noun: "domain",
          detailCommand: "pass a domain name or use --verbose for address rows",
          verbose,
        }));
      }
      const text = lines.length ? lines.join("\n") : "No provisioned domains.";
      output({ domains: domains.map((d) => ({ domain: d.domain, provisioning: domainProvisioning.get(d.id) ?? null })) }, text);
    });

  // ── address create ─────────────────────────────────────────────────────────
  cmd
    .command("address <email>")
    .description("Create an email address on a provisioned domain")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain <id>", "Domain ID (defaults to the address's domain if registered)")
    .option("--receive <strategy>", "Receive strategy: ses-s3 | cf-routing | resend-webhook", "ses-s3")
    .option("--forward-to <email>", "Forward target (for cf-routing)")
    .option("--owner <name|id>", "Owner (human or agent). Human owners require --administrator.")
    .option("--administrator <name|id>", "Administering agent (required for human owners; defaults to owner for agents)")
    .option("--dry-run", "Resolve inputs and show the planned change without writing address, provisioning, or ownership state")
    .option("--wait", "Advance provisioning now and wait until the address is ready to receive")
    .option("--timeout <sec>", "Max seconds to wait when --wait is used", "120")
    .option("--interval <sec>", "Seconds between readiness checks when --wait is used", "5")
    .option("--bucket <name>", "Inbound S3 bucket for receive validation (defaults to config inbound_s3_bucket)")
    .action(async (email: string, opts: { provider: string; domain?: string; receive: string; forwardTo?: string; owner?: string; administrator?: string; dryRun?: boolean; wait?: boolean; timeout: string; interval: string; bucket?: string }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
        const existing = getAddressByEmail(providerId, email, db);
        const domainName = email.split("@")[1];
        const domainId = opts.domain ? resolveId("domains", opts.domain) : (domainName ? getDomainByName(providerId, domainName, db)?.id ?? null : null);
        const plannedProvisioning = {
          domain_id: domainId,
          receive_strategy: opts.receive as ReceiveStrategy,
          forward_to: opts.forwardTo ?? null,
          provisioning_status: "requested" as const,
          next_check_at: new Date().toISOString(),
        };
        if (opts.dryRun) {
          output({
            dry_run: true,
            id: existing?.id ?? null,
            email,
            provider_id: providerId,
            domain_id: domainId,
            receive: opts.receive,
            existing: !!existing,
            would_create_address: !existing,
            would_update_provisioning: true,
            would_assign_owner: !!opts.owner,
            current_provisioning: existing ? getAddressProvisioning(existing.id, db) : null,
            planned_provisioning: plannedProvisioning,
            cli_equivalent: `mailery provision address ${email} --provider ${opts.provider}${opts.owner ? ` --owner ${opts.owner}` : ""}${opts.wait ? " --wait" : ""} --dry-run --json`,
          }, existing
            ? chalk.dim(`Would update provisioning for existing address ${email} (${existing.id.slice(0, 8)}).`)
            : chalk.dim(`Would create ${email} and request ${opts.receive} receive provisioning.`));
          return;
        }

        const addr = existing ?? createAddress({ provider_id: providerId, email }, db);
        setAddressProvisioning(addr.id, plannedProvisioning, db);
        let ownerNote = "";
        if (opts.owner) {
          const { getOwnerByName, getOwner, assignAddressOwner } = await import("../../db/owners.js");
          const owner = getOwnerByName(opts.owner, db) ?? getOwner(opts.owner, db);
          if (!owner) return handleError(new Error(`Owner not found: ${opts.owner}`));
          const admin = opts.administrator ? (getOwnerByName(opts.administrator, db) ?? getOwner(opts.administrator, db)) : null;
          const own = assignAddressOwner(addr.id, owner.id, admin?.id, db);
          ownerNote = ` owner=${owner.name}(${owner.type}) admin=${own.administrator_id === owner.id ? "self" : opts.administrator}`;
        }

        let provisioning = getAddressProvisioning(addr.id, db);
        if (opts.wait) {
          const { getInboundConfig } = await import("../../lib/config.js");
          const cfg = getInboundConfig();
          if (cfg.profile) process.env["AWS_PROFILE"] = cfg.profile;
          const bucket = opts.bucket ?? cfg.bucket;
          if (!bucket) handleError(new Error("No inbound bucket: pass --bucket or set inbound_s3_bucket"));

          const { makeAddressDeps } = await import("../../lib/provision/real-deps.js");
          const { advanceAddress } = await import("../../lib/provision/orchestrator.js");
          const deps = makeAddressDeps({ provider: provider!, inboundBucket: bucket!, region: cfg.region, db });
          const deadline = Date.now() + Math.max(1, parseInt(opts.timeout, 10) || 120) * 1000;
          const intervalMs = Math.max(1, parseInt(opts.interval, 10) || 5) * 1000;

          while (Date.now() < deadline) {
            provisioning = getAddressProvisioning(addr.id, db);
            if (provisioning?.provisioning_status === "ready") break;
            if (provisioning?.provisioning_status === "failed") {
              handleError(new Error(`Address provisioning failed: ${provisioning.last_error ?? "unknown error"}`));
            }
            const res = await advanceAddress(addr.id, deps, { db, now: new Date().toISOString() });
            provisioning = getAddressProvisioning(addr.id, db);
            if (provisioning?.provisioning_status === "ready") break;
            if (res.error || provisioning?.provisioning_status === "failed") {
              handleError(new Error(`Address provisioning failed: ${res.error ?? provisioning?.last_error ?? "unknown error"}`));
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
          }

          provisioning = getAddressProvisioning(addr.id, db);
          if (provisioning?.provisioning_status !== "ready") {
            handleError(new Error(`Timed out waiting for ${email} to become ready (current=${provisioning?.provisioning_status ?? "unknown"})`));
          }
        }

        const readyText = provisioning?.provisioning_status === "ready"
          ? chalk.green(`✓ address ${email} ready to receive (receive=${opts.receive})${ownerNote}`)
          : chalk.green(`✓ address ${email} requested (receive=${opts.receive})${ownerNote}`) + chalk.dim(`\n  Finish now: mailery provision address ${email} --provider ${opts.provider} --wait`);
        output({ id: addr.id, email, receive: opts.receive, created: !existing, provisioning }, readyText);
      } catch (e) { handleError(e); }
    });

  // ── domain setup ─────────────────────────────────────────────────────────
  cmd
    .command("domain <domain>")
    .description("Provision a domain for sending: SES identity + MAIL FROM + publish DNS in Cloudflare")
    .requiredOption("--provider <id>", "SES provider ID")
    .option("--send <provider>", "Send provider", "ses")
    .option("--add-mx", "Also publish inbound MX (ses-s3 receive)")
    .option("--force-mx-switch", "Allow adding SES inbound MX even when existing root MX belongs to another provider")
    .option("--mail-from <subdomain>", "Custom MAIL FROM subdomain (default mail.<domain>)")
    .option("--dry-run", "Resolve inputs and show the planned change without calling providers or writing to the DB")
    .option("--wait", "Poll SES until the domain is verified for sending")
    .option("--timeout <sec>", "Max seconds to wait for verification", "600")
    .action(async (domain: string, opts: { provider: string; send: string; addMx?: boolean; forceMxSwitch?: boolean; mailFrom?: string; dryRun?: boolean; wait?: boolean; timeout: string }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
        const existing = getDomainByName(providerId, domain, db);
        if (opts.dryRun) {
          let mxAssessment: MxAssessment | null = null;
          let mxSafety = opts.addMx
            ? "Existing root MX is checked before DNS is written; use --force-mx-switch only after confirming inbound can move."
            : "Root MX is preserved; this is send-only SES setup.";
          let mxRequiresConfirmation = false;
          let mxFormattedRecords: string | null = null;
          if (opts.addMx) {
            const mx = await import("../../lib/mx-ownership.js");
            const inspectMx = deps.inspectMx ?? mx.inspectPublicMx;
            mxAssessment = await inspectMx(domain);
            mxRequiresConfirmation = mx.requiresMxSwitchConfirmation(mxAssessment);
            mxFormattedRecords = mx.formatMxRecords(mxAssessment.records);
            mxSafety = mxRequiresConfirmation
              ? mx.formatMxSwitchWarning(mxAssessment)
              : `Root MX is compatible with SES inbound: ${mxAssessment.summary}.`;
          }
          output({
            dry_run: true,
            domain,
            provider_id: providerId,
            existing,
            would_create_domain: !existing,
            would_call_provider: true,
            planned_provisioning: {
              provisioning_status: "ses_identity_created",
              send_provider: opts.send,
              dns_provider: "cloudflare",
              mail_from_domain: opts.mailFrom ?? `mail.${domain}`,
              add_mx: !!opts.addMx,
              force_mx_switch: !!opts.forceMxSwitch,
            },
            mx_safety: mxSafety,
            mx_assessment: mxAssessment,
            mx_requires_confirmation: mxRequiresConfirmation,
            cli_equivalent: `mailery provision domain ${domain} --provider ${opts.provider}${opts.addMx ? " --add-mx" : ""}${opts.forceMxSwitch ? " --force-mx-switch" : ""}${opts.wait ? " --wait" : ""} --dry-run --json`,
          }, existing
            ? chalk.dim(`Would provision existing domain ${domain} (${existing.id.slice(0, 8)}).`)
            : chalk.dim(`Would register ${domain} locally, create SES identity, publish DNS, and${opts.wait ? "" : " not"} wait for verification.`)
              + (opts.addMx
                ? chalk.yellow(`\n  ${mxSafety}${mxFormattedRecords ? `\n  Current MX: ${mxFormattedRecords}` : ""}`)
                : chalk.dim("\n  Root MX will be preserved (send-only).")));
          return;
        }

        if (opts.addMx) {
          const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
          await guardSesInboundMx(domain, !!opts.forceMxSwitch);
        }

        const rec = existing ?? createDomain(providerId, domain, db);
        setDomainProvisioning(rec.id, { provisioning_status: "ses_identity_created", send_provider: opts.send, dns_provider: "cloudflare" }, db);

        const adapter = getAdapter(provider!);
        await adapter.addDomain(domain);
        // Custom MAIL FROM (SES) for better SPF/DMARC alignment.
        let mailFrom: string | undefined;
        if (adapter.setMailFrom) {
          mailFrom = await adapter.setMailFrom(domain, opts.mailFrom);
          setDomainProvisioning(rec.id, { mail_from_domain: mailFrom }, db);
        }
        const { setupEmailDns } = await import("../../lib/cloudflare-dns.js");
        const dns = await setupEmailDns({ domain, provider: provider!, addMx: !!opts.addMx, forceMxSwitch: !!opts.forceMxSwitch });
        setDomainProvisioning(rec.id, { provisioning_status: "dns_published", next_check_at: new Date().toISOString() }, db);

        let verified = false;
        if (opts.wait) {
          const deadline = Date.now() + parseInt(opts.timeout, 10) * 1000;
          process.stdout.write(chalk.dim("Waiting for SES verification"));
          while (Date.now() < deadline) {
            const status = await adapter.verifyDomain(domain);
            if (status.dkim === "verified") { verified = true; break; }
            process.stdout.write(chalk.dim("."));
            await new Promise((r) => setTimeout(r, 15000));
          }
          process.stdout.write("\n");
          if (verified) setDomainProvisioning(rec.id, { provisioning_status: "verified", next_check_at: null }, db);
        }

        output(
          { domain, mail_from: mailFrom, dns, verified },
          chalk.green(`✓ ${domain}: SES identity + MAIL FROM (${mailFrom ?? "n/a"}), ${dns.created} DNS records in Cloudflare${opts.wait ? (verified ? ", VERIFIED ✓" : ", verification still pending") : `. Verify: mailery domain verify ${domain} --provider ${opts.provider}`}`),
        );
      } catch (e) { handleError(e); }
    });

  // ── up: full end-to-end orchestrator ─────────────────────────────────────
  cmd
    .command("up <domain>")
    .description("One command: SES identity + MAIL FROM → publish DNS (Cloudflare) → wait verify → inbound → addresses → round-trip test")
    .requiredOption("--provider <id>", "SES provider ID")
    .option("--addresses <list>", "Comma-separated local parts to create", "one,two,three")
    .option("--bucket <name>", "Inbound S3 bucket (defaults to config inbound_s3_bucket)")
    .option("--add-mx", "Publish inbound MX (ses-s3 receive)", true)
    .option("--no-add-mx", "Preserve existing root MX and skip SES inbound MX publishing")
    .option("--force-mx-switch", "Allow adding SES inbound MX even when existing root MX belongs to another provider")
    .option("--count <n>", "Round-trip messages per pair (0 = skip test)", "1")
    .option("--timeout <sec>", "Max seconds to wait for SES verification", "600")
    .option("--no-test", "Skip the final round-trip test")
    .option("--buy-if-needed", "Buy + delegate the domain first (via @hasna/domains SDK) if not already owned")
    .option("--purchase-profile <profile>", "AWS profile for the purchase (default: hasna-xyz-infra)")
    .action(async (domain: string, opts: { provider: string; addresses: string; bucket?: string; addMx?: boolean; forceMxSwitch?: boolean; count: string; timeout: string; test?: boolean; buyIfNeeded?: boolean; purchaseProfile?: string }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) return handleError(new Error(`Provider not found: ${opts.provider}`));
        const { getInboundConfig } = await import("../../lib/config.js");
        const cfg = getInboundConfig();
        const sesInboundRequested = opts.addMx !== false;
        const bucket = opts.bucket ?? cfg.bucket;
        if (sesInboundRequested && !bucket) return handleError(new Error("No inbound bucket: pass --bucket or set inbound_s3_bucket"));

        if (sesInboundRequested) {
          const { guardSesInboundMx } = await import("../../lib/mx-ownership.js");
          await guardSesInboundMx(domain, !!opts.forceMxSwitch);
        }

        const adapter = getAdapter(provider!);
        const rec = getDomainByName(providerId, domain, db) ?? createDomain(providerId, domain, db);
        const step = (n: string) => console.log(chalk.cyan(`▸ ${n}`));

        // ── Buy + delegate first (in-process @hasna/domains SDK) ──────────────
        if (opts.buyIfNeeded) {
          step("Buy + delegate domain (Route53 → Cloudflare)");
          const dom = await import("@hasna/domains");
          // Purchase runs in the purchase account; restore the SES profile after.
          const purchaseProfile = opts.purchaseProfile ?? "hasna-xyz-infra";
          const prevProfile = process.env["AWS_PROFILE"];
          process.env["AWS_PROFILE"] = purchaseProfile;
          try {
            const avail = await (dom as any).r53CheckAvailability(domain);
            if (avail.available) {
              const { readFileSync } = await import("node:fs");
              const { homedir } = await import("node:os");
              const rawContact = JSON.parse(readFileSync(`${homedir()}/.hasna/domains/config.json`, "utf-8")).contact;
              if (!rawContact?.first_name) throw new Error("No registrant contact configured (domains config set contact.*)");
              const contact = normalizeRoute53RegistrationContact(rawContact);
              const reg = await (dom as any).r53RegisterDomain(domain, contact, 1);
              console.log(chalk.dim(`  registering ${domain} (op ${reg.operationId})...`));
              const res = await (dom as any).pollRegistrationUntilDone(reg.operationId, { getStatus: (id: string) => (dom as any).r53GetRegistrationStatus(id) });
              if (res.status !== "success") throw new Error(`registration ${res.status}`);
              console.log(chalk.dim("  registered ✓"));
            } else {
              console.log(chalk.dim(`  ${domain} not available to register — assuming already owned`));
            }
            const zone = await (dom as any).cfEnsureZone(domain);
            await (dom as any).r53UpdateNameservers(domain, zone.nameservers);
            console.log(chalk.dim(`  Cloudflare zone ${zone.id}; nameservers → ${zone.nameservers.join(", ")}`));
            setDomainProvisioning(rec.id, { provisioning_status: "ns_delegated", purchase_provider: "route53", cf_zone_id: zone.id, nameservers: zone.nameservers }, db);
          } finally {
            if (prevProfile === undefined) delete process.env["AWS_PROFILE"]; else process.env["AWS_PROFILE"] = prevProfile;
          }
        }

        // SES + inbound run in the SES account.
        if (cfg.profile) process.env["AWS_PROFILE"] = cfg.profile;

        step("SES identity + MAIL FROM");
        await adapter.addDomain(domain);
        let mailFrom: string | undefined;
        if (adapter.setMailFrom) { mailFrom = await adapter.setMailFrom(domain); }
        setDomainProvisioning(rec.id, { provisioning_status: "ses_identity_created", send_provider: "ses", dns_provider: "cloudflare", mail_from_domain: mailFrom ?? null }, db);

        step("Publish DNS to Cloudflare");
        const { setupEmailDns } = await import("../../lib/cloudflare-dns.js");
        const dns = await setupEmailDns({ domain, provider: provider!, addMx: sesInboundRequested, forceMxSwitch: !!opts.forceMxSwitch });
        console.log(chalk.dim(`  ${dns.created} created, ${dns.skipped} skipped`));
        setDomainProvisioning(rec.id, { provisioning_status: "dns_published" }, db);

        step("Wait for SES verification");
        const deadline = Date.now() + parseInt(opts.timeout, 10) * 1000;
        let verified = false;
        while (Date.now() < deadline) {
          if ((await adapter.verifyDomain(domain)).dkim === "verified") { verified = true; break; }
          process.stdout.write(chalk.dim("."));
          await new Promise((r) => setTimeout(r, 15000));
        }
        process.stdout.write("\n");
        if (!verified) return handleError(new Error("SES verification timed out"));
        setDomainProvisioning(rec.id, { provisioning_status: "verified" }, db);
        console.log(chalk.green("  verified ✓"));

        step("Set up SES inbound (S3 receipt rules)");
        let inbound: { bucket: string; mx_record: string } | null = null;
        if (sesInboundRequested) {
          const { setupInboundEmail } = await import("../../lib/aws-inbound.js");
          inbound = await setupInboundEmail({ domain, bucket: bucket!, region: cfg.region });
          console.log(chalk.dim(`  bucket ${inbound.bucket}, MX ${inbound.mx_record}`));
          setDomainProvisioning(rec.id, { provisioning_status: "inbound_ready" }, db);
        } else {
          console.log(chalk.dim("  skipped; existing root MX preserved"));
        }

        step("Create addresses");
        const locals = opts.addresses.split(",").map((a) => a.trim());
        const sesReceiveReady = sesInboundRequested;
        for (const l of locals) {
          const email = `${l}@${domain}`;
          const addr = getAddressByEmail(providerId, email, db) ?? createAddress({ provider_id: providerId, email }, db);
          setAddressProvisioning(addr.id, { domain_id: rec.id, receive_strategy: "ses-s3", provisioning_status: sesReceiveReady ? "ready" : "requested" }, db);
          console.log(chalk.dim(`  + ${email}${sesReceiveReady ? "" : " (send-only; existing inbound preserved)"}`));
        }
        setDomainProvisioning(rec.id, { provisioning_status: sesReceiveReady ? "ready" : "verified", next_check_at: null }, db);

        let rtSuccess = true;
        const count = parseInt(opts.count, 10);
        if (!sesInboundRequested && opts.test !== false && count > 0) {
          step("Round-trip test");
          console.log(chalk.dim("  skipped; existing root MX was preserved, so SES->S3 receipt is not the active inbound path"));
        } else if (opts.test !== false && count > 0 && locals.length >= 2) {
          step(`Round-trip test (${count}/pair)`);
          const { sendWithFailover } = await import("../../lib/send.js");
          const { syncS3Inbox } = await import("../../lib/s3-sync.js");
          const { runRoundtrip } = await import("../../lib/provision/roundtrip.js");
          const roundtripStartedAt = new Date().toISOString();
          const subjectLimit = Math.max(100, count * locals.length * 2);
          const report = await runRoundtrip(
            {
              send: async ({ from, to, subject, text }) => {
                const r = await sendWithFailover(providerId, { from, to, subject, text, html: `<p>${text}</p>` }, db);
                await new Promise((res) => setTimeout(res, 1100));
                return { messageId: r.messageId };
              },
              fetchReceived: async (mailbox) => {
                await syncS3Inbox({
                  bucket: bucket!,
                  prefix: `inbound/${domain}/`,
                  providerId,
                  accessKeyId: provider.access_key ?? undefined,
                  secretAccessKey: provider.secret_key ?? undefined,
                  limit: 1000,
                  region: cfg.region,
                  db,
                });
                return listInboundSubjectsForRecipient(mailbox, { since: roundtripStartedAt, limit: subjectLimit }, db);
              },
            },
            { addresses: locals.map((l) => `${l}@${domain}`), count, tokenPrefix: `UP-${domain.split(".")[0]}-${Date.now()}`, pollAttempts: 10, pollIntervalMs: 9000 },
          );
          rtSuccess = report.success;
          console.log(report.success ? chalk.green(`  ✓ ${report.totalReceived}/${report.totalSent} delivered`) : chalk.red(`  ✗ ${report.totalReceived}/${report.totalSent}`));
        }

        output({ domain, mail_from: mailFrom, verified, inbound_bucket: inbound?.bucket ?? null, addresses: locals, roundtrip_ok: rtSuccess },
          (rtSuccess ? chalk.green : chalk.yellow)(`\n${rtSuccess ? "✓" : "⚠"} ${domain} provisioned via CLI (send via ${opts.provider}${sesInboundRequested ? ", receive via SES->S3" : ", existing inbound preserved"})`));
        if (!rtSuccess) process.exitCode = 1;
      } catch (e) { handleError(e); }
    });

  // ── roundtrip (acceptance test) ─────────────────────────────────────────
  cmd
    .command("roundtrip")
    .description("Send N tokened mailery around a ring of addresses and confirm 100% receipt (via SES inbound → S3 → SQLite)")
    .requiredOption("--domain <domain>", "Domain whose addresses to test")
    .requiredOption("--provider <id>", "SES provider ID (sends + inbound association)")
    .option("--addresses <list>", "Comma-separated local parts", "one,two,three")
    .option("--count <n>", "Messages per directed pair", "16")
    .option("--bucket <name>", "Inbound S3 bucket (defaults to config inbound_s3_bucket)")
    .option("--profile <profile>", "AWS profile for S3 sync")
    .option("--poll-attempts <n>", "Receipt poll attempts", "12")
    .option("--poll-interval <ms>", "Receipt poll interval ms", "10000")
    .option("--throttle <ms>", "Delay between sends (SES sandbox = 1100)", "1100")
    .action(async (opts: { domain: string; provider: string; addresses: string; count: string; bucket?: string; profile?: string; pollAttempts: string; pollInterval: string; throttle: string }) => {
      try {
        const { getInboundConfig: _gic } = await import("../../lib/config.js");
        const _profile = opts.profile ?? _gic().profile;
        if (_profile) process.env["AWS_PROFILE"] = _profile;
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
        const addresses = opts.addresses.split(",").map((a) => `${a.trim()}@${opts.domain}`);
        const { getInboundConfig } = await import("../../lib/config.js");
        const bucket = opts.bucket ?? getInboundConfig().bucket;
        if (!bucket) handleError(new Error("No inbound bucket: pass --bucket or set inbound_s3_bucket"));
        const throttle = parseInt(opts.throttle, 10);

        const { sendWithFailover } = await import("../../lib/send.js");
        const { syncS3Inbox } = await import("../../lib/s3-sync.js");
        const { runRoundtrip } = await import("../../lib/provision/roundtrip.js");
        const count = parseInt(opts.count, 10);
        const roundtripStartedAt = new Date().toISOString();
        const subjectLimit = Math.max(100, count * addresses.length * 2);

        const report = await runRoundtrip(
          {
            send: async ({ from, to, subject, text }) => {
              const r = await sendWithFailover(providerId, { from, to, subject, text, html: `<p>${text}</p>` }, db);
              await new Promise((res) => setTimeout(res, throttle));
              return { messageId: r.messageId };
            },
            fetchReceived: async (mailbox) => {
              const domain = mailbox.split("@")[1]!;
              await syncS3Inbox({
                bucket: bucket!,
                prefix: `inbound/${domain}/`,
                providerId,
                accessKeyId: provider!.access_key ?? undefined,
                secretAccessKey: provider!.secret_key ?? undefined,
                limit: 1000,
                db,
              });
              return listInboundSubjectsForRecipient(mailbox, { since: roundtripStartedAt, limit: subjectLimit }, db);
            },
          },
          {
            addresses,
            count,
            tokenPrefix: `RT-${opts.domain.split(".")[0]}-${Date.now()}`,
            pollAttempts: parseInt(opts.pollAttempts, 10),
            pollIntervalMs: parseInt(opts.pollInterval, 10),
          },
        );

        const lines = [chalk.bold(`\nRound-trip ${opts.domain}: ${report.totalReceived}/${report.totalSent} received`)];
        for (const d of report.directions) {
          lines.push(`  ${d.from} → ${d.to}: ${d.received}/${d.sent}${d.missing.length ? chalk.red(` (missing ${d.missing.length})`) : chalk.green(" ✓")}`);
        }
        lines.push(report.success ? chalk.green("✓ 100% delivery/receipt") : chalk.red(`✗ ${report.totalSent - report.totalReceived} missing`));
        output(report, lines.join("\n"));
        if (!report.success) process.exitCode = 1;
      } catch (e) { handleError(e); }
    });

  // ── daemon (reconciler loop) ─────────────────────────────────────────────
  cmd
    .command("daemon")
    .description("Run the provisioning reconciler: advance due domains/addresses toward ready")
    .requiredOption("--provider <id>", "SES provider ID")
    .option("--bucket <name>", "Inbound S3 bucket (defaults to config inbound_s3_bucket)")
    .option("--add-mx", "Publish inbound MX when setting up domains")
    .option("--force-mx-switch", "Allow adding SES inbound MX even when existing root MX belongs to another provider")
    .option("--once", "Run a single reconcile tick and exit")
    .option("--interval <sec>", "Seconds between ticks", "30")
    .option("--max-ticks <n>", "Stop after N ticks (default: unlimited)")
    .action(async (opts: { provider: string; bucket?: string; addMx?: boolean; forceMxSwitch?: boolean; once?: boolean; interval: string; maxTicks?: string }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) return handleError(new Error(`Provider not found: ${opts.provider}`));
        const { getInboundConfig } = await import("../../lib/config.js");
        const cfg = getInboundConfig();
        const bucket = opts.bucket ?? cfg.bucket;
        if (cfg.profile) process.env["AWS_PROFILE"] = cfg.profile;
        if (!bucket) return handleError(new Error("No inbound bucket: pass --bucket or set inbound_s3_bucket"));

        const { makeDomainDeps, makeAddressDeps } = await import("../../lib/provision/real-deps.js");
        const { reconcileTick, runDaemon } = await import("../../daemon/provisioner.js");
        const deps = {
          domainDeps: makeDomainDeps({ provider: provider!, inboundBucket: bucket!, region: cfg.region, addMx: !!opts.addMx, forceMxSwitch: !!opts.forceMxSwitch, db }),
          addressDeps: makeAddressDeps({ provider: provider!, inboundBucket: bucket!, region: cfg.region, db }),
        };
        const log = (event: string, detail: Record<string, unknown>) => console.log(chalk.dim(`[${event}] ${JSON.stringify(detail)}`));

        if (opts.once) {
          const s = await reconcileTick(deps, { db, log });
          output(s, chalk.green(`✓ tick: ${s.advanced} advanced, ${s.errors} errors (domains ${s.domainsProcessed}, addresses ${s.addressesProcessed})`));
          return;
        }
        console.log(chalk.dim(`Provisioning daemon started (interval ${opts.interval}s). Ctrl-C to stop.`));
        const total = await runDaemon(deps, {
          db, log,
          intervalSec: parseInt(opts.interval, 10),
          maxTicks: opts.maxTicks ? parseInt(opts.maxTicks, 10) : undefined,
        });
        output(total, chalk.green(`daemon stopped: ${total.advanced} advanced, ${total.errors} errors`));
      } catch (e) { handleError(e); }
    });

  // ── retry ───────────────────────────────────────────────────────────────
  cmd
    .command("retry <domain>")
    .description("Re-queue a domain for the provisioning daemon (clear error, check now)")
    .option("--provider <id>", "Provider ID")
    .action((domain: string, opts: { provider?: string }) => {
      const db = getDatabase();
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const rec = providerId ? getDomainByName(providerId, domain, db) : findDomainsByName(domain, db)[0];
      if (!rec) return handleError(new Error(`Domain not found: ${domain}`));
      setDomainProvisioning(rec.id, { last_error: null, next_check_at: new Date().toISOString() }, db);
      const events = listProvisioningEvents("domain", rec.id, db);
      output({ domain, requeued: true, events: events.length }, chalk.green(`✓ ${domain} re-queued (${events.length} prior events)`));
    });
}
