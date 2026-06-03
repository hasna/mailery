import type { Command } from "commander";
import chalk from "chalk";
import { getProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { getAdapter } from "../../providers/index.js";
import { createDomain, getDomainByName, listDomains } from "../../db/domains.js";
import { createAddress, getAddressByEmail, listAddresses } from "../../db/addresses.js";
import {
  setDomainProvisioning, getDomainProvisioning,
  setAddressProvisioning, getAddressProvisioning,
  listProvisioningEvents,
} from "../../db/provisioning.js";
import { handleError, resolveId } from "../utils.js";

type ReceiveStrategy = "ses-s3" | "cf-routing" | "resend-webhook";

export function registerProvisionCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program.command("provision").description("Automated domain + address provisioning");

  // ── status ────────────────────────────────────────────────────────────────
  cmd
    .command("status [domain]")
    .description("Show provisioning status of domains and addresses")
    .action((domainName?: string) => {
      const db = getDatabase();
      const domains = listDomains(undefined, db).filter((d) => !domainName || d.domain === domainName);
      const lines: string[] = [];
      for (const d of domains) {
        const p = getDomainProvisioning(d.id, db);
        lines.push(`${chalk.bold(d.domain)}  ${chalk.cyan(p?.provisioning_status ?? "none")}  dns=${p?.dns_provider ?? "?"}  send=${p?.send_provider ?? "-"}${p?.last_error ? chalk.red(" err=" + p.last_error) : ""}`);
        const addrs = listAddresses(undefined, db).filter((a) => getAddressProvisioning(a.id, db)?.domain_id === d.id);
        for (const a of addrs) {
          const ap = getAddressProvisioning(a.id, db);
          lines.push(`  ${a.email}  ${chalk.cyan(ap?.provisioning_status ?? "none")}  recv=${ap?.receive_strategy ?? "-"}`);
        }
      }
      const text = lines.length ? lines.join("\n") : "No provisioned domains.";
      output({ domains: domains.map((d) => ({ domain: d.domain, provisioning: getDomainProvisioning(d.id, db) })) }, text);
    });

  // ── address create ─────────────────────────────────────────────────────────
  cmd
    .command("address <email>")
    .description("Create an email address on a provisioned domain")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--domain <id>", "Domain ID (defaults to the address's domain if registered)")
    .option("--receive <strategy>", "Receive strategy: ses-s3 | cf-routing | resend-webhook", "ses-s3")
    .option("--forward-to <email>", "Forward target (for cf-routing)")
    .action(async (email: string, opts: { provider: string; domain?: string; receive: string; forwardTo?: string }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        if (!getProvider(providerId)) handleError(new Error(`Provider not found: ${opts.provider}`));
        const addr = getAddressByEmail(providerId, email, db) ?? createAddress({ provider_id: providerId, email }, db);
        const domainName = email.split("@")[1];
        const domainId = opts.domain ? resolveId("domains", opts.domain) : (domainName ? getDomainByName(providerId, domainName, db)?.id ?? null : null);
        setAddressProvisioning(addr.id, {
          domain_id: domainId,
          receive_strategy: opts.receive as ReceiveStrategy,
          forward_to: opts.forwardTo ?? null,
          provisioning_status: "requested",
          next_check_at: new Date().toISOString(),
        }, db);
        output({ id: addr.id, email, receive: opts.receive }, chalk.green(`✓ address ${email} provisioned (receive=${opts.receive})`));
      } catch (e) { handleError(e); }
    });

  // ── domain setup ─────────────────────────────────────────────────────────
  cmd
    .command("domain <domain>")
    .description("Provision a domain for sending: SES identity + MAIL FROM + publish DNS in Cloudflare")
    .requiredOption("--provider <id>", "SES provider ID")
    .option("--send <provider>", "Send provider", "ses")
    .option("--add-mx", "Also publish inbound MX (ses-s3 receive)")
    .option("--mail-from <subdomain>", "Custom MAIL FROM subdomain (default mail.<domain>)")
    .option("--wait", "Poll SES until the domain is verified for sending")
    .option("--timeout <sec>", "Max seconds to wait for verification", "600")
    .action(async (domain: string, opts: { provider: string; send: string; addMx?: boolean; mailFrom?: string; wait?: boolean; timeout: string }) => {
      try {
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));
        const rec = getDomainByName(providerId, domain, db) ?? createDomain(providerId, domain, db);
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
        const dns = await setupEmailDns({ domain, provider: provider!, addMx: !!opts.addMx });
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
          chalk.green(`✓ ${domain}: SES identity + MAIL FROM (${mailFrom ?? "n/a"}), ${dns.created} DNS records in Cloudflare${opts.wait ? (verified ? ", VERIFIED ✓" : ", verification still pending") : `. Verify: emails domain verify ${domain} --provider ${opts.provider}`}`),
        );
      } catch (e) { handleError(e); }
    });

  // ── roundtrip (acceptance test) ─────────────────────────────────────────
  cmd
    .command("roundtrip")
    .description("Send N tokened emails around a ring of addresses and confirm 100% receipt (via SES inbound → S3 → SQLite)")
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
        if (opts.profile) process.env["AWS_PROFILE"] = opts.profile;
        const db = getDatabase();
        const providerId = resolveId("providers", opts.provider);
        if (!getProvider(providerId)) handleError(new Error(`Provider not found: ${opts.provider}`));
        const addresses = opts.addresses.split(",").map((a) => `${a.trim()}@${opts.domain}`);
        const { getInboundConfig } = await import("../../lib/config.js");
        const bucket = opts.bucket ?? getInboundConfig().bucket;
        if (!bucket) handleError(new Error("No inbound bucket: pass --bucket or set inbound_s3_bucket"));
        const throttle = parseInt(opts.throttle, 10);

        const { sendWithFailover } = await import("../../lib/send.js");
        const { syncS3Inbox } = await import("../../lib/s3-sync.js");
        const { runRoundtrip } = await import("../../lib/provision/roundtrip.js");

        const report = await runRoundtrip(
          {
            send: async ({ from, to, subject, text }) => {
              const r = await sendWithFailover(providerId, { from, to, subject, text, html: `<p>${text}</p>` }, db);
              await new Promise((res) => setTimeout(res, throttle));
              return { messageId: r.messageId };
            },
            fetchReceived: async (mailbox) => {
              const domain = mailbox.split("@")[1]!;
              await syncS3Inbox({ bucket: bucket!, prefix: `inbound/${domain}/`, providerId, limit: 1000, db });
              const rows = db.query("SELECT subject FROM inbound_emails WHERE to_addresses LIKE ?").all(`%${mailbox}%`) as { subject: string }[];
              return rows;
            },
          },
          {
            addresses,
            count: parseInt(opts.count, 10),
            tokenPrefix: `RT-${opts.domain.split(".")[0]}`,
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

  // ── retry ───────────────────────────────────────────────────────────────
  cmd
    .command("retry <domain>")
    .description("Re-queue a domain for the provisioning daemon (clear error, check now)")
    .option("--provider <id>", "Provider ID")
    .action((domain: string, opts: { provider?: string }) => {
      const db = getDatabase();
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const rec = providerId ? getDomainByName(providerId, domain, db) : listDomains(undefined, db).find((d) => d.domain === domain);
      if (!rec) return handleError(new Error(`Domain not found: ${domain}`));
      setDomainProvisioning(rec.id, { last_error: null, next_check_at: new Date().toISOString() }, db);
      const events = listProvisioningEvents("domain", rec.id, db);
      output({ domain, requeued: true, events: events.length }, chalk.green(`✓ ${domain} re-queued (${events.length} prior events)`));
    });
}
