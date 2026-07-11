/**
 * `emails aws` command group — AWS infrastructure setup for email.
 */

import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { handleError } from "../utils.js";

export function registerAwsCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const awsCmd = program.command("aws").description("AWS infrastructure setup for email (S3, SES receipt rules)");

  // ─── SETUP INBOUND ────────────────────────────────────────────────────────

  awsCmd
    .command("setup-inbound")
    .description("Create S3 bucket + SES receipt rules to receive inbound email. Defaults --bucket/--region to config inbound_s3_bucket/region.")
    .requiredOption("--domain <domain>", "Domain to receive email for (e.g. example.com)")
    .option("--bucket <name>", "S3 bucket name (defaults to config inbound_s3_bucket)")
    .option("--region <region>", "AWS region (defaults to config inbound_s3_region or us-east-1)")
	    .option("--prefix <prefix>", "S3 key prefix (default: inbound/<domain>/)")
	    .option("--catch-all", "Also catch subdomains (*.example.com)")
	    .option("--profile <profile>", "AWS profile name (uses env vars if not set)")
	    .option("--provider <id>", "SES provider id for local source provenance")
	    .action(async (opts: {
	      domain: string; bucket?: string; region?: string;
	      prefix?: string; catchAll?: boolean; profile?: string; provider?: string;
	    }) => {
      try {
        const { getInboundConfig } = await import("../../lib/config.js");
        const inbound = getInboundConfig();
	        const profile = opts.profile ?? inbound.profile;
	        if (profile) process.env["AWS_PROFILE"] = profile;
	        const bucket = opts.bucket ?? inbound.bucket;
	        const region = opts.region ?? inbound.region;
	        if (!bucket) { handleError(new Error("No S3 bucket: pass --bucket or set 'emails config set inbound_s3_bucket <name>'")); return; }
	        let providerId: string | undefined;
	        if (opts.provider) {
	          const { getDatabase, resolvePartialIdOrThrow } = await import("../../db/database.js");
	          providerId = resolvePartialIdOrThrow(getDatabase(), "providers", opts.provider);
	        }

	        const { setupInboundEmail } = await import("../../lib/aws-inbound.js");

        console.log(chalk.dim(`Setting up inbound email for ${opts.domain}...`));

        console.log(chalk.dim(`  [1/3] Setting up S3 bucket: ${bucket}`));
	        const result = await setupInboundEmail({
	          domain: opts.domain,
	          bucket,
	          region,
	          prefix: opts.prefix,
	          catchAll: opts.catchAll,
	        });
	        const [{ addInboundBucket, setConfigValue }, { registerS3Source }] = await Promise.all([
	          import("../../lib/config.js"),
	          import("../../lib/s3-sync.js"),
	        ]);
	        if (profile) setConfigValue("inbound_s3_profile", profile);
	        addInboundBucket(result.bucket, region, providerId);
	        const source = registerS3Source({
	          bucket: result.bucket,
	          prefix: result.s3_prefix,
	          region,
	          providerId,
	          name: `${opts.domain} SES/S3 inbound`,
	          status: "live",
	          liveSyncEnabled: true,
	        });

        console.log(chalk.green(result.bucket_created
          ? `  ✓ S3 bucket created: ${result.bucket}`
          : `  ✓ S3 bucket already exists: ${result.bucket}`));

        console.log(chalk.dim("  [2/3] Configuring SES receipt rules..."));
        console.log(chalk.green(result.rule_set_created
          ? `  ✓ Receipt rule set created: ${result.rule_set}`
          : `  ✓ Using rule set: ${result.rule_set}`));
        console.log(chalk.green(result.rule_created
          ? `  ✓ Receipt rule created: ${result.rule_name}`
          : `  ✓ Receipt rule already exists: ${result.rule_name}`));

        console.log(chalk.dim("  [3/3] Done\n"));

        console.log(chalk.bold("Setup complete!"));
        console.log(`\n  Emails to ${chalk.cyan(`*@${opts.domain}`)} → ${chalk.cyan(`s3://${result.bucket}/${result.s3_prefix}`)}\n`);

        console.log(chalk.bold("  Required DNS records:"));
        console.log(chalk.yellow(`\n    MX  ${opts.domain}  ${result.mx_record}\n`));
        console.log(chalk.dim("  Add this MX record to your DNS provider."));
        console.log(chalk.dim("  (For Cloudflare: emails domain setup-cloudflare ... will set it automatically)\n"));

	        console.log(chalk.dim("  To sync received emails locally:"));
	        console.log(chalk.dim(`    emails inbox sync-s3 --source ${source.id}\n`));

	        output({ ...result, source }, "");
      } catch (e) { handleError(e); }
    });

  // ─── STATUS ───────────────────────────────────────────────────────────────

  awsCmd
    .command("status")
    .description("Show current SES receipt rules and inbound email configuration")
    .option("--region <region>", "AWS region", "us-east-1")
    .option("--profile <profile>", "AWS profile name")
    .action(async (opts: { region: string; profile?: string }) => {
      try {
        if (opts.profile) process.env["AWS_PROFILE"] = opts.profile;

        const { SESClient, DescribeActiveReceiptRuleSetCommand, ListReceiptRuleSetsCommand } = await import("@aws-sdk/client-ses");
        const ses = new SESClient({ region: opts.region });

        // Active rule set
        let activeRuleSet = "(none)";
        let rules: { Name?: string; Enabled?: boolean; Recipients?: string[] }[] = [];
        try {
          const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
          if (active.Metadata?.Name) {
            activeRuleSet = active.Metadata.Name;
            rules = active.Rules ?? [];
          }
        } catch { /* no active rule set */ }

        const allSets = await ses.send(new ListReceiptRuleSetsCommand({}));

        console.log(chalk.bold("\nSES Inbound Status:"));
        console.log(`  Active rule set: ${chalk.cyan(activeRuleSet)}`);
        console.log(`  All rule sets:   ${(allSets.RuleSets ?? []).map(r => r.Name).join(", ") || "(none)"}`);

        if (rules.length > 0) {
          console.log(chalk.bold("\n  Receipt rules:"));
          for (const r of rules) {
            const status = r.Enabled ? chalk.green("enabled") : chalk.dim("disabled");
            console.log(`    ${chalk.cyan(r.Name ?? "")}  [${status}]  ${(r.Recipients ?? []).join(", ")}`);
          }
        }
        console.log();
        output({ active_rule_set: activeRuleSet, rules }, "");
      } catch (e) { handleError(e); }
    });
}
