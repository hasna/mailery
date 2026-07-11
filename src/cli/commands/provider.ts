import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { createProvider, listProviders, listProviderSummaries, deleteProvider, getProvider, resolveProviderId, updateProvider } from "../../db/providers.js";
import { getAdapter } from "../../providers/index.js";
import { log } from "../../lib/logger.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage } from "../utils.js";

type SupportedProviderType = "resend" | "ses" | "sandbox";

function parseProviderType(value: string): SupportedProviderType {
  if (value === "resend" || value === "ses" || value === "sandbox") return value;
  handleError(new Error("Provider type must be 'resend', 'ses', or 'sandbox'"));
  return "sandbox";
}

export function registerProviderCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const providerCmd = program.command("provider").description("Manage email providers");

  providerCmd
    .command("add")
    .description("Add an email provider (resend, ses, or sandbox)")
    .requiredOption("--name <name>", "Provider name")
    .requiredOption("--type <type>", "Provider type: resend | ses | sandbox")
    .option("--api-key <key>", "Resend API key")
    .option("--region <region>", "SES region")
    .option("--access-key <key>", "SES access key ID")
    .option("--secret-key <key>", "SES secret access key")
    .option("--skip-validation", "Skip credential validation after adding")
    .action(async (opts: {
      name: string;
      type: string;
      apiKey?: string;
      region?: string;
      accessKey?: string;
      secretKey?: string;
      skipValidation?: boolean;
    }) => {
      try {
        const type = parseProviderType(opts.type);
        const provider = createProvider({
          name: opts.name,
          type,
          api_key: opts.apiKey,
          region: opts.region,
          access_key: opts.accessKey,
          secret_key: opts.secretKey,
        });

        if (!opts.skipValidation && type !== "sandbox") {
          try {
            const adapter = getAdapter(provider);
            await adapter.listDomains();
          } catch (validationErr) {
            deleteProvider(provider.id);
            handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`));
          }
        }

        if (type === "sandbox") {
          log.success(`✓ Sandbox provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
          log.info(chalk.dim("  Emails sent to this provider are captured locally, not delivered."));
        } else {
          log.success(`✓ Provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("list")
    .description("List configured providers")
    .option("--limit <n>", "Maximum providers to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of providers to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const page = parseCliListPage(opts);
        const providers = listProviderSummaries(undefined, page);
        if (providers.length === 0) {
          output([], chalk.dim("No providers configured. Use 'emails provider add' to add one."));
          return;
        }
        const lines: string[] = [chalk.bold("\nProviders:")];
        for (const p of providers) {
          const status = p.active ? chalk.green("active") : chalk.yellow("inactive");
          lines.push(`  ${chalk.cyan(p.id.slice(0, 8))}  ${p.name}  [${p.type}]  ${status}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: providers.length,
          limit: page.limit,
          offset: page.offset,
          noun: "provider",
          detailCommand: "use emails provider update <id> --help for editable fields",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(providers, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("remove <id>")
    .description("Remove a provider")
    .option("--yes", "Skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        const resolvedId = resolveProviderId(id);
        if (!resolvedId) handleError(new Error(`Provider not found or ambiguous: ${id}`));
        const provider = getProvider(resolvedId);
        if (!provider) handleError(new Error(`Provider not found: ${id}`));
        await confirmDestructiveAction(`Remove provider ${provider.name}?`, opts.yes);
        deleteProvider(resolvedId);
        console.log(chalk.green(`✓ Provider removed: ${provider.name}`));
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("update <id>")
    .description("Update an existing provider")
    .option("--name <name>", "Provider name")
    .option("--api-key <key>", "Resend API key")
    .option("--region <region>", "SES region")
    .option("--access-key <key>", "SES access key ID")
    .option("--secret-key <key>", "SES secret access key")
    .option("--skip-validation", "Skip credential validation after update")
    .action(async (id: string, opts: {
      name?: string;
      apiKey?: string;
      region?: string;
      accessKey?: string;
      secretKey?: string;
      skipValidation?: boolean;
    }) => {
      try {
        const resolvedId = resolveProviderId(id);
        if (!resolvedId) handleError(new Error(`Provider not found or ambiguous: ${id}`));
        const existing = getProvider(resolvedId);
        if (!existing) handleError(new Error(`Provider not found: ${id}`));

        const original = { ...existing! };
        const updates: Record<string, string | undefined> = {};
        if (opts.name !== undefined) updates.name = opts.name;
        if (opts.apiKey !== undefined) updates.api_key = opts.apiKey;
        if (opts.region !== undefined) updates.region = opts.region;
        if (opts.accessKey !== undefined) updates.access_key = opts.accessKey;
        if (opts.secretKey !== undefined) updates.secret_key = opts.secretKey;

        const updated = updateProvider(resolvedId, updates);

        if (!opts.skipValidation && updated.type !== "sandbox") {
          try {
            const adapter = getAdapter(updated);
            await adapter.listDomains();
          } catch (validationErr) {
            updateProvider(resolvedId, {
              name: original.name,
              api_key: original.api_key ?? undefined,
              region: original.region ?? undefined,
              access_key: original.access_key ?? undefined,
              secret_key: original.secret_key ?? undefined,
            });
            handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Update was reverted.`));
          }
        }

        log.success(`✓ Provider updated: ${updated.name} (${updated.id.slice(0, 8)})`);
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("status")
    .description("Health check active supported providers")
    .action(async () => {
      try {
        const { checkAllProviders, formatProviderHealth } = await import("../../lib/health.js");
        const results = await checkAllProviders();
        if (results.length === 0) {
          output([], chalk.dim("No active supported providers. Add one with 'emails provider add'"));
          return;
        }
        const lines: string[] = [chalk.bold("\nProvider Health:\n")];
        for (const h of results) {
          lines.push(formatProviderHealth(h));
          lines.push("");
        }
        output(results, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("check")
    .description("Verify supported providers are healthy")
    .action(async () => {
      try {
        const providers = listProviders();
        if (providers.length === 0) {
          console.log(chalk.dim("No providers configured."));
          console.log(chalk.bold("\nQuick setup:"));
          console.log(chalk.dim("  SES:    emails provider add --type ses --name \"My SES\" --region us-east-1 --access-key ... --secret-key ..."));
          console.log(chalk.dim("  Resend: emails provider add --type resend --name \"My Resend\" --api-key re_..."));
          console.log(chalk.dim("  Sandbox: emails provider add --type sandbox --name \"Local Sandbox\""));
          return;
        }

        console.log(chalk.bold(`\nChecking ${providers.length} provider(s)...\n`));
        for (const p of providers) {
          const icon = p.active ? "" : chalk.dim("[inactive] ");
          process.stdout.write(`  ${icon}${chalk.cyan(p.name)} (${p.type}) ... `);
          if (p.type === "ses") {
            if (!p.access_key || !p.secret_key) {
              console.log(chalk.yellow("⚠ missing credentials"));
            } else {
              try {
                const adapter = getAdapter(p);
                await adapter.listDomains();
                console.log(chalk.green("✓ connected"));
              } catch (e) {
                console.log(chalk.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
              }
            }
          } else if (p.type === "resend") {
            if (!p.api_key) {
              console.log(chalk.yellow("⚠ missing API key"));
            } else {
              try {
                const adapter = getAdapter(p);
                await adapter.listDomains();
                console.log(chalk.green("✓ connected"));
              } catch (e) {
                console.log(chalk.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
              }
            }
          } else {
            console.log(chalk.dim("sandbox (no auth needed)"));
          }
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });
}
