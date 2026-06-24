import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createAddress, findAddressesByEmail, listAddressEmails, deleteAddress, getAddress, getAddressByEmail } from "../../db/addresses.js";
import { getDomainByName } from "../../db/domains.js";
import { suspendAddress, activateAddress, setAddressQuota, countSendsTodayByAddress } from "../../db/address-lifecycle.js";
import { getProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { getAdapter } from "../../providers/index.js";
import { colorDnsStatus, tableRow, truncate } from "../../lib/format.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";
import { getAddressProvisioning, setAddressProvisioning } from "../../db/provisioning.js";
import {
  getAddressOwnershipDetail,
  getAddressOwnershipHistoryByRef,
  listEnrichedAddresses,
  setAddressOwnerByRef,
  suggestAddressLocalParts,
  transferAddressOwnerByRef,
  unassignAddressOwnerByRef,
} from "../../lib/address-ownership.js";

type ReceiveStrategy = "ses-s3" | "cf-routing" | "resend-webhook";

export function registerAddressCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const addressCmd = program.command("address").description("Manage sender email addresses");

  const listAddressesAction = (opts: { provider?: string; limit?: string; offset?: string; verbose?: boolean }) => {
    try {
      const db = getDatabase();
      const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
      const page = parseCliListPage(opts);
      const addresses = listEnrichedAddresses(providerId, db, page);
      if (addresses.length === 0) {
        output([], chalk.dim("No addresses configured."));
        return;
      }
      const verbose = opts.verbose || isCliVerboseOutput();
      const lines: string[] = [chalk.bold("\nAddresses:")];
      if (verbose) {
        const quotaCounts = countSendsTodayByAddress(
          addresses.filter((address) => address.daily_quota !== null).map((address) => address.email),
          db,
        );
        for (const a of addresses) {
          const verified = a.verified ? colorDnsStatus("verified") : colorDnsStatus("pending");
          const name = a.display_name ? ` (${a.display_name})` : "";
          const status = a.status === "suspended" ? chalk.red("suspended") : chalk.green("active");
          const quota = a.daily_quota !== null ? chalk.dim(`  quota ${quotaCounts.get(a.email.trim().toLowerCase()) ?? 0}/${a.daily_quota}/day`) : "";
          const owner = a.owner
            ? chalk.dim(`  owner ${a.owner.name} (${a.owner.type})`)
            : chalk.dim("  owner none");
          const administrator = a.administrator && (!a.owner || a.administrator.id !== a.owner.id)
            ? chalk.dim(`  admin ${a.administrator.name}`)
            : "";
          lines.push(`  ${chalk.cyan(a.id.slice(0, 8))}  ${a.email}${name}  [${verified}] [${status}]${quota}${owner}${administrator}`);
        }
      } else {
        lines.push(tableRow(
          [chalk.bold("ID"), 8],
          [chalk.bold("Email"), 36],
          [chalk.bold("Provider"), 16],
          [chalk.bold("State"), 10],
          [chalk.bold("Owner"), 18],
        ));
        for (const a of addresses) {
          const state = `${a.verified ? "verified" : "pending"}/${a.status}`;
          const owner = a.owner ? `${a.owner.name}${a.administrator && a.administrator.id !== a.owner.id ? `:${a.administrator.name}` : ""}` : "-";
          lines.push(tableRow(
            [chalk.cyan(a.id.slice(0, 8)), 8],
            [truncate(a.email, 36), 36],
            [truncate(a.provider_name ?? a.provider_id.slice(0, 8), 16), 16],
            [state, 10],
            [truncate(owner, 18), 18],
          ));
        }
      }
      lines.push("");
      lines.push(formatListHint({
        shown: addresses.length,
        limit: page.limit,
        offset: page.offset,
        noun: "address",
        detailCommand: "use mailery address owner <email-or-id> for ownership details",
        verbose,
      }));
      output(addresses, lines.join("\n"));
    } catch (e) {
      handleError(e);
    }
  };

  program
    .command("addresses")
    .description("List sender email addresses (alias: mailery address list)")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum addresses to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of addresses to skip", "0")
    .option("--verbose", "Show expanded owner/admin/quota fields")
    .action(listAddressesAction);

  addressCmd
    .command("add <email>")
    .description("Add a sender address")
    .requiredOption("--provider <id>", "Provider ID")
    .option("--name <displayName>", "Display name")
    .action(async (email: string, opts: { provider: string; name?: string }) => {
      try {
        const providerId = resolveId("providers", opts.provider);
        const provider = getProvider(providerId);
        if (!provider) handleError(new Error(`Provider not found: ${opts.provider}`));

        const existing = getAddressByEmail(providerId, email);
        if (existing) {
          output(existing, chalk.green(`✓ Address already exists: ${email} (${existing.id.slice(0, 8)})`));
          return;
        }

        const adapter = getAdapter(provider!);
        await adapter.addAddress(email);

        const addr = createAddress({ provider_id: providerId, email, display_name: opts.name });
        output(addr, chalk.green(`✓ Address added: ${email} (${addr.id.slice(0, 8)})`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("list")
    .description("List sender addresses")
    .option("--provider <id>", "Filter by provider ID")
    .option("--limit <n>", "Maximum addresses to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of addresses to skip", "0")
    .option("--verbose", "Show expanded owner/admin/quota fields")
    .action(listAddressesAction);

  addressCmd
    .command("owner <email-or-id>")
    .description("Show owner and administering agent for an address")
    .action((ref: string) => {
      try {
        const detail = getAddressOwnershipDetail(ref);
        const owner = detail.address.owner;
        const administrator = detail.address.administrator;
        const lines = [chalk.bold(`\n${detail.address.email}`)];
        lines.push(`  ID:       ${detail.address.id}`);
        lines.push(`  Provider: ${detail.address.provider_name ?? detail.address.provider_id}`);
        lines.push(owner
          ? `  Owner:    ${owner.name} (${owner.type}) ${chalk.dim(owner.id)}`
          : `  Owner:    ${chalk.dim("none")}`);
        lines.push(administrator
          ? `  Admin:    ${administrator.name} (${administrator.type}) ${chalk.dim(administrator.id)}`
          : `  Admin:    ${chalk.dim("none")}`);
        const lastChange = detail.history[0];
        if (lastChange) {
          lines.push(`  Changed:  ${lastChange.action} at ${lastChange.created_at}${lastChange.actor ? ` by ${lastChange.actor}` : ""}`);
          if (lastChange.reason) lines.push(`  Reason:   ${lastChange.reason}`);
        }
        lines.push("");
        output(detail, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("set-owner <email-or-id>")
    .description("Assign address ownership; human owners require an agent administrator")
    .requiredOption("--owner <name-or-id>", "Owner name, ID, or ID prefix")
    .option("--administrator <name-or-id>", "Administering agent name, ID, or ID prefix")
    .action((ref: string, opts: { owner: string; administrator?: string }) => {
      try {
        const detail = setAddressOwnerByRef(ref, opts.owner, opts.administrator);
        const owner = detail.address.owner!;
        const administrator = detail.address.administrator!;
        output(detail, chalk.green(`✓ ${detail.address.email} owned by ${owner.name} (${owner.type}), administered by ${administrator.name}`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("transfer-owner <email-or-id>")
    .description("Explicitly transfer address ownership to another owner")
    .requiredOption("--owner <name-or-id>", "New owner name, ID, or ID prefix")
    .option("--administrator <name-or-id>", "Administering agent name, ID, or ID prefix")
    .requiredOption("--reason <reason>", "Reason recorded in the ownership audit log")
    .option("--actor <actor>", "Actor recorded in the ownership audit log", "cli")
    .option("--yes", "Skip confirmation prompt")
    .action(async (ref: string, opts: { owner: string; administrator?: string; reason: string; actor?: string; yes?: boolean }) => {
      try {
        const before = getAddressOwnershipDetail(ref);
        await confirmDestructiveAction(`Transfer owner for ${before.address.email} to ${opts.owner}?`, opts.yes);
        const detail = transferAddressOwnerByRef(ref, opts.owner, opts.administrator, { actor: opts.actor, reason: opts.reason });
        const owner = detail.address.owner!;
        const administrator = detail.address.administrator!;
        output(detail, chalk.green(`✓ ${detail.address.email} transferred to ${owner.name} (${owner.type}), administered by ${administrator.name}`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("unassign-owner <email-or-id>")
    .description("Clear owner/admin assignment for an address")
    .requiredOption("--reason <reason>", "Reason recorded in the ownership audit log")
    .option("--actor <actor>", "Actor recorded in the ownership audit log", "cli")
    .option("--yes", "Skip confirmation prompt")
    .action(async (ref: string, opts: { reason: string; actor?: string; yes?: boolean }) => {
      try {
        const before = getAddressOwnershipDetail(ref);
        await confirmDestructiveAction(`Clear owner/admin assignment for ${before.address.email}?`, opts.yes);
        const detail = unassignAddressOwnerByRef(ref, { actor: opts.actor, reason: opts.reason });
        output(detail, chalk.green(`✓ ${detail.address.email} is now unowned`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("owner-history <email-or-id>")
    .description("Show ownership/admin change history for an address")
    .option("--limit <n>", "Maximum events to show", "20")
    .action((ref: string, opts: { limit: string }) => {
      try {
        const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 20));
        const detail = getAddressOwnershipHistoryByRef(ref, limit);
        const lines = [chalk.bold(`\nOwnership history: ${detail.address.email}`)];
        if (detail.history.length === 0) {
          lines.push(chalk.dim("  No ownership changes recorded."));
        } else {
          for (const event of detail.history) {
            const owner = event.owner_id ? event.owner_id.slice(0, 8) : "none";
            const admin = event.administrator_id ? event.administrator_id.slice(0, 8) : "none";
            lines.push(`  ${event.created_at}  ${event.action}  owner=${owner} admin=${admin}${event.actor ? ` actor=${event.actor}` : ""}`);
            if (event.reason) lines.push(chalk.dim(`    ${event.reason}`));
          }
        }
        lines.push("");
        output(detail, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("suggest")
    .description("Suggest available sender addresses for a domain")
    .requiredOption("--domain <domain>", "Domain name")
    .action((opts: { domain: string }) => {
      try {
        const db = getDatabase();
        const domain = opts.domain.trim().toLowerCase();
        const exists = listAddressEmails(undefined, db);
        const suggestions = suggestAddressLocalParts(domain, exists);
        output({ domain, suggestions }, suggestions.length ? suggestions.join("\n") : chalk.dim(`No obvious suggestions left for ${domain}.`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("provision <email>")
    .description("Create an email address on a provisioned domain (alias of the address provisioning workflow)")
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
    .action(async (email: string, opts: {
      provider: string;
      domain?: string;
      receive: string;
      forwardTo?: string;
      owner?: string;
      administrator?: string;
      dryRun?: boolean;
      wait?: boolean;
      timeout: string;
      interval: string;
      bucket?: string;
    }) => {
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
            cli_equivalent: `mailery address provision ${email} --provider ${opts.provider}${opts.owner ? ` --owner ${opts.owner}` : ""}${opts.wait ? " --wait" : ""} --json`,
          }, existing
            ? chalk.dim(`Would update provisioning for existing address ${email} (${existing.id.slice(0, 8)}).`)
            : chalk.dim(`Would create ${email} and request ${opts.receive} receive provisioning.`));
          return;
        }

        const addr = existing ?? createAddress({ provider_id: providerId, email }, db);

        setAddressProvisioning(addr.id, plannedProvisioning, db);

        let ownership = opts.owner ? setAddressOwnerByRef(addr.id, opts.owner, opts.administrator, db) : null;
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

        ownership = ownership ?? getAddressOwnershipDetail(addr.id, db);
        const readyText = provisioning?.provisioning_status === "ready"
          ? chalk.green(`✓ address ${email} ready to receive (receive=${opts.receive})`)
          : chalk.green(`✓ address ${email} requested (receive=${opts.receive})`) + chalk.dim(`\n  Finish now: mailery address provision ${email} --provider ${opts.provider} --wait`);
        output({ id: addr.id, email, receive: opts.receive, created: !existing, provisioning, ownership }, readyText);
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("verify <email>")
    .description("Check verification status of an address")
    .option("--provider <id>", "Provider ID")
    .action(async (email: string, opts: { provider?: string }) => {
      try {
        const db = getDatabase();
        const providerId = opts.provider ? resolveId("providers", opts.provider) : undefined;
        const found = findAddressesByEmail(email, db).find((a) => !providerId || a.provider_id === providerId);
        if (!found) handleError(new Error(`Address not found: ${email}`));

        const provider = getProvider(found!.provider_id);
        if (!provider) handleError(new Error("Provider not found"));

        const adapter = getAdapter(provider!);
        const isVerified = await adapter.verifyAddress(email);

        if (isVerified) {
          db.run("UPDATE addresses SET verified = 1, updated_at = datetime('now') WHERE id = ?", [found!.id]);
          console.log(chalk.green(`✓ ${email} is verified`));
        } else {
          console.log(chalk.yellow(`⚠ ${email} is not yet verified`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("remove <id>")
    .description("Remove a sender address")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        const resolvedId = resolveId("addresses", id);
        const addr = getAddress(resolvedId);
        if (!addr) handleError(new Error(`Address not found: ${id}`));
        await confirmDestructiveAction(`Remove sender address ${addr.email}?`, opts.yes);
        deleteAddress(resolvedId);
        console.log(chalk.green(`✓ Address removed: ${addr.email}`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("suspend <id>")
    .description("Suspend a sender address (blocks sending until reactivated)")
    .action((id: string) => {
      try {
        const resolvedId = resolveId("addresses", id);
        if (!getAddress(resolvedId)) handleError(new Error(`Address not found: ${id}`));
        const a = suspendAddress(resolvedId);
        output(a, chalk.yellow(`⏸ Suspended ${a.email} — sending blocked`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("activate <id>")
    .description("Reactivate a suspended sender address")
    .action((id: string) => {
      try {
        const resolvedId = resolveId("addresses", id);
        if (!getAddress(resolvedId)) handleError(new Error(`Address not found: ${id}`));
        const a = activateAddress(resolvedId);
        output(a, chalk.green(`✓ Activated ${a.email} — sending allowed`));
      } catch (e) {
        handleError(e);
      }
    });

  addressCmd
    .command("quota <id> <perDay>")
    .description("Set a daily send quota for an address (use 'none' to clear)")
    .action((id: string, perDay: string) => {
      try {
        const resolvedId = resolveId("addresses", id);
        if (!getAddress(resolvedId)) handleError(new Error(`Address not found: ${id}`));
        const quota = /^(none|null|unlimited|0?)$/i.test(perDay) && perDay !== "0"
          ? null
          : Number.parseInt(perDay, 10);
        if (quota !== null && Number.isNaN(quota)) handleError(new Error(`Invalid quota: ${perDay}`));
        const a = setAddressQuota(resolvedId, quota);
        output(a, a.daily_quota === null
          ? chalk.green(`✓ Cleared daily quota for ${a.email}`)
          : chalk.green(`✓ Daily quota for ${a.email}: ${a.daily_quota}/day`));
      } catch (e) {
        handleError(e);
      }
    });
}
