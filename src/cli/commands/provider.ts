import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createProvider, listProviders, listProviderSummaries, deleteProvider, getProvider, updateProvider } from "../../db/providers.js";
import { createAddress } from "../../db/addresses.js";
import { getAdapter } from "../../providers/index.js";
import { log } from "../../lib/logger.js";
import { confirmDestructiveAction, formatListHint, handleError, isCliVerboseOutput, parseCliListPage, resolveId } from "../utils.js";

export function registerProviderCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const providerCmd = program.command("provider").description("Manage email providers");

  providerCmd
    .command("add")
    .description("Add an email provider (resend, ses, or gmail)")
    .requiredOption("--name <name>", "Provider name")
    .requiredOption("--type <type>", "Provider type: resend | ses | gmail")
    .option("--api-key <key>", "Resend API key")
    .option("--region <region>", "SES region")
    .option("--access-key <key>", "SES access key ID")
    .option("--secret-key <key>", "SES secret access key")
    .option("--client-id <id>", "Gmail OAuth client ID")
    .option("--client-secret <secret>", "Gmail OAuth client secret")
    .option("--skip-validation", "Skip credential validation after adding")
    .action(async (opts: {
      name: string;
      type: string;
      apiKey?: string;
      region?: string;
      accessKey?: string;
      secretKey?: string;
      clientId?: string;
      clientSecret?: string;
      skipValidation?: boolean;
    }) => {
      try {
        if (opts.type !== "resend" && opts.type !== "ses" && opts.type !== "gmail" && opts.type !== "sandbox") {
          handleError(new Error("Provider type must be 'resend', 'ses', 'gmail', or 'sandbox'"));
        }

        if (opts.type === "sandbox") {
          const provider = createProvider({ name: opts.name, type: "sandbox" });
          log.success(`✓ Sandbox provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
          log.info(chalk.dim("  Emails sent to this provider are captured locally — not delivered."));
          return;
        }

        if (opts.type === "gmail") {
          if (!opts.clientId) handleError(new Error("Gmail provider requires --client-id"));
          if (!opts.clientSecret) handleError(new Error("Gmail provider requires --client-secret"));

          const { startGmailOAuthFlow } = await import("../../lib/gmail-oauth.js");
          log.info(chalk.dim("Starting Gmail OAuth flow..."));
          const tokens = await startGmailOAuthFlow(opts.clientId!, opts.clientSecret!);

          const provider = createProvider({
            name: opts.name,
            type: "gmail",
            oauth_client_id: opts.clientId,
            oauth_client_secret: opts.clientSecret,
            oauth_refresh_token: tokens.refresh_token,
            oauth_access_token: tokens.access_token,
            oauth_token_expiry: tokens.expiry,
          });

          if (!opts.skipValidation) {
            try {
              const adapter = getAdapter(provider);
              await adapter.listAddresses();
            } catch (validationErr) {
              deleteProvider(provider.id);
              handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`));
            }
          }

          log.success(`\u2713 Gmail provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
          return;
        }

        const provider = createProvider({
          name: opts.name,
          type: opts.type as "resend" | "ses",
          api_key: opts.apiKey,
          region: opts.region,
          access_key: opts.accessKey,
          secret_key: opts.secretKey,
        });

        if (!opts.skipValidation) {
          try {
            const adapter = getAdapter(provider);
            await adapter.listDomains();
          } catch (validationErr) {
            deleteProvider(provider.id);
            handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Provider was not saved.`));
          }
        }

        log.success(`\u2713 Provider created: ${provider.name} (${provider.id.slice(0, 8)})`);
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
          output([], chalk.dim("No providers configured. Use 'mailery provider add' to add one."));
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
          detailCommand: "use mailery provider update <id> --help for editable fields",
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
        const resolvedId = resolveId("providers", id);
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
    .command("auth <id>")
    .description("Re-authenticate a Gmail provider (refresh OAuth tokens)")
    .action(async (id: string) => {
      try {
        const resolvedId = resolveId("providers", id);
        const provider = getProvider(resolvedId);
        if (!provider) handleError(new Error(`Provider not found: ${id}`));
        if (provider!.type !== "gmail") {
          handleError(new Error("Only Gmail providers require OAuth re-authentication"));
        }
        if (!provider!.oauth_client_id || !provider!.oauth_client_secret) {
          handleError(new Error("Provider is missing oauth_client_id or oauth_client_secret"));
        }

        const { startGmailOAuthFlow } = await import("../../lib/gmail-oauth.js");
        console.log(chalk.dim("Starting Gmail OAuth flow..."));
        const tokens = await startGmailOAuthFlow(provider!.oauth_client_id!, provider!.oauth_client_secret!);

        updateProvider(resolvedId, {
          oauth_refresh_token: tokens.refresh_token,
          oauth_access_token: tokens.access_token,
          oauth_token_expiry: tokens.expiry,
        });

        console.log(chalk.green(`✓ Gmail provider re-authenticated: ${provider!.name}`));
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
        const resolvedId = resolveId("providers", id);
        const existing = getProvider(resolvedId);
        if (!existing) handleError(new Error(`Provider not found: ${id}`));

        // Save original state for revert
        const original = { ...existing! };

        const updates: Record<string, string | undefined> = {};
        if (opts.name !== undefined) updates.name = opts.name;
        if (opts.apiKey !== undefined) updates.api_key = opts.apiKey;
        if (opts.region !== undefined) updates.region = opts.region;
        if (opts.accessKey !== undefined) updates.access_key = opts.accessKey;
        if (opts.secretKey !== undefined) updates.secret_key = opts.secretKey;

        const updated = updateProvider(resolvedId, updates);

        if (!opts.skipValidation) {
          try {
            const adapter = getAdapter(updated);
            if (updated.type === "gmail") {
              await adapter.listAddresses();
            } else {
              await adapter.listDomains();
            }
          } catch (validationErr) {
            // Revert the update
            updateProvider(resolvedId, {
              name: original.name,
              api_key: original.api_key ?? undefined,
              region: original.region ?? undefined,
              access_key: original.access_key ?? undefined,
              secret_key: original.secret_key ?? undefined,
              oauth_client_id: original.oauth_client_id ?? undefined,
              oauth_client_secret: original.oauth_client_secret ?? undefined,
              oauth_refresh_token: original.oauth_refresh_token ?? undefined,
              oauth_access_token: original.oauth_access_token ?? undefined,
              oauth_token_expiry: original.oauth_token_expiry ?? undefined,
            });
            handleError(new Error(`Provider credentials are invalid: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}. Update was reverted.`));
          }
        }

        log.success(`\u2713 Provider updated: ${updated.name} (${updated.id.slice(0, 8)})`);
      } catch (e) {
        handleError(e);
      }
    });

  providerCmd
    .command("status")
    .description("Health check all active providers")
    .action(async () => {
      try {
        const { checkAllProviders, formatProviderHealth } = await import("../../lib/health.js");
        const results = await checkAllProviders();
        if (results.length === 0) {
          output([], chalk.dim("No active providers. Add one with 'mailery provider add'"));
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

  // ─── CHECK ───────────────────────────────────────────────────────────────
  providerCmd
    .command("check")
    .description("Verify all providers are healthy with connector auth validation")
    .action(async () => {
      try {
        const providers = listProviders();
        if (providers.length === 0) {
          console.log(chalk.dim("No providers configured."));
          console.log(chalk.bold("\nQuick setup:"));
          console.log(chalk.dim("  SES:    mailery provider add --type ses --name \"My SES\" --region us-east-1 --access-key ... --secret-key ..."));
          console.log(chalk.dim("  Resend: mailery provider add --type resend --name \"My Resend\" --api-key re_..."));
          console.log(chalk.dim("  Gmail:  connectors auth gmail --no-browser  ->  mailery provider add-gmail"));
          return;
        }

        console.log(chalk.bold(`\nChecking ${providers.length} provider(s)...\n`));
        const { runConnectorCommand } = await import("@hasna/connectors");

        for (const p of providers) {
          const icon = p.active ? "" : chalk.dim("[inactive] ");
          process.stdout.write(`  ${icon}${chalk.cyan(p.name)} (${p.type}) ... `);

          if (p.type === "gmail") {
            // Check connector auth
            const meResult = await runConnectorCommand("gmail", ["-f", "json", "me"]);
            if (meResult.success) {
              let email = "";
              try { email = (JSON.parse(meResult.stdout) as { emailAddress?: string }).emailAddress ?? ""; } catch {}
              console.log(chalk.green(`✓ authenticated${email ? ` as ${email}` : ""}`));
            } else {
              console.log(chalk.red("✗ not authenticated"));
              console.log(chalk.dim(`    Fix: connectors auth gmail --no-browser`));
            }
          } else if (p.type === "ses") {
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

  // ─── ADD-GMAIL ────────────────────────────────────────────────────────────
  providerCmd
    .command("add-gmail")
    .description("Add a Gmail provider from saved connector tokens")
    .option("--name <name>", "Provider name (defaults to Gmail profile name)")
    .option("--profile <profile>", "Connector Gmail profile to use (default: \"default\")", "default")
    .option("--list-profiles", "List available Gmail profiles and exit")
    .action(async (opts: { name?: string; profile?: string; listProfiles?: boolean }) => {
      try {
        const HOME = process.env["HOME"] || process.env["USERPROFILE"] || "~";
        const profilesDir = join(HOME, ".connectors", "connect-gmail", "profiles");

        if (opts.listProfiles) {
          if (!existsSync(profilesDir)) {
            console.log(chalk.dim("No Gmail profiles found. Run: connectors auth gmail"));
            return;
          }
          const profiles = readdirSync(profilesDir).filter(
            (p) => existsSync(join(profilesDir, p, "tokens.json")),
          );
          console.log(chalk.bold("\nAvailable Gmail profiles:"));
          for (const p of profiles) console.log(`  ${chalk.cyan(p)}`);
          console.log();
          return;
        }

        const profile = opts.profile ?? "default";
        const tokensPath = join(profilesDir, profile, "tokens.json");

        if (!existsSync(tokensPath)) {
          console.error(chalk.red(`Gmail not authenticated (profile: "${profile}")`));
          console.log("");
          console.log(chalk.bold("To authenticate, run:"));
          console.log(chalk.cyan("  connectors auth gmail --no-browser"));
          console.log(chalk.dim("  (prints a URL — open it in your browser, complete OAuth, then re-run this command)"));
          console.log("");
          console.log(chalk.dim("Or check if credentials are configured:"));
          console.log(chalk.dim("  connectors config gmail show"));
          process.exit(1);
        }

        const tokens = JSON.parse(readFileSync(tokensPath, "utf-8")) as {
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: string;
        };

        if (!tokens.refreshToken) {
          console.error(chalk.red("Authentication incomplete — no refresh token found."));
          console.log(chalk.dim("Re-run: connectors auth gmail --no-browser"));
          process.exit(1);
        }

        // Get Gmail profile info to use as the email address
        const { runConnectorCommand } = await import("@hasna/connectors");
        console.log(chalk.dim("Verifying Gmail connection..."));
        const meResult = await runConnectorCommand("gmail", ["-f", "json", "me"]);
        let emailAddress = "";
        if (meResult.success) {
          try {
            const me = JSON.parse(meResult.stdout) as { emailAddress?: string };
            emailAddress = me.emailAddress ?? "";
          } catch {
            const match = meResult.stdout.match(/emailAddress[:\s]+([^\s,}]+)/);
            if (match?.[1]) emailAddress = match[1];
          }
        } else {
          console.error(chalk.red("Could not verify Gmail connection."));
          console.log(chalk.dim("Try re-authenticating: connectors auth gmail --no-browser"));
          process.exit(1);
        }

        const providerName = opts.name ?? (emailAddress ? `Gmail (${emailAddress})` : `Gmail (${profile})`);

        // Create provider
        const expiryMs = tokens.expiresAt ? parseInt(tokens.expiresAt, 10) : undefined;
        const expiry = expiryMs ? new Date(expiryMs).toISOString() : undefined;

        const provider = createProvider({
          name: providerName,
          type: "gmail",
          oauth_access_token: tokens.accessToken,
          oauth_refresh_token: tokens.refreshToken,
          oauth_token_expiry: expiry,
        });

        console.log(chalk.green(`✓ Connected as: ${emailAddress}`));
        console.log(chalk.green(`✓ Created provider: ${providerName} [${provider.id.slice(0, 8)}]`));

        // Create address record if we have the email
        if (emailAddress) {
          createAddress({ provider_id: provider.id, email: emailAddress });
          console.log(chalk.green(`✓ Added address: ${emailAddress}`));
        }

        console.log(chalk.bold("\nNext steps:"));
        console.log(chalk.dim(`  Sync inbox:    mailery inbox sync --provider ${provider.id.slice(0, 8)} --all`));
        console.log(chalk.dim(`  Check status:  mailery inbox status`));
        console.log(chalk.dim(`  Send email:    mailery send --from ${emailAddress} --to ... --subject ... --body ...`));
        console.log();
      } catch (e) {
        handleError(e);
      }
    });
}
