import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { CANONICAL_OPEN_EMAILS_S3_BUCKET, CANONICAL_OPEN_EMAILS_S3_REGION, loadConfig, saveConfig, getConfigValue, setConfigValue } from "../../lib/config.js";
import { redactSecrets } from "../../lib/redaction.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliPage, summarizeCliValue } from "../utils.js";

const KNOWN_KEYS: { key: string; description: string; example: string }[] = [
  { key: "default_provider", description: "Default provider ID used when --provider is not specified", example: "abc12345" },
  { key: "failover-providers", description: "Comma-separated provider IDs used as failover for send()", example: "abc12345,def67890" },
  { key: "gmail_attachment_storage", description: "Where to store Gmail attachments: local | s3 | none", example: "local" },
  { key: "gmail_s3_bucket", description: "S3 bucket name for attachment storage (requires gmail_attachment_storage=s3)", example: "my-email-archive" },
  { key: "gmail_s3_prefix", description: "S3 key prefix for attachments (default: emails)", example: "emails" },
  { key: "gmail_s3_region", description: "AWS region for S3 uploads (default: us-east-1)", example: "us-east-1" },
  { key: "gmail_archive_s3_bucket", description: "S3 bucket for durable Gmail archive uploads", example: CANONICAL_OPEN_EMAILS_S3_BUCKET },
  { key: "gmail_archive_s3_region", description: "AWS region for Gmail archive uploads", example: CANONICAL_OPEN_EMAILS_S3_REGION },
  { key: "gmail_archive_s3_prefix", description: "S3 key prefix for Gmail archive uploads (default: gmail)", example: "gmail" },
  { key: "cloudflare_api_token", description: "Cloudflare API token for auto DNS setup (also reads CLOUDFLARE_API_TOKEN env var)", example: "abc123..." },
  { key: "cloudflare_api_key", description: "Cloudflare global API key for auto DNS setup (also reads CLOUDFLARE_API_KEY env var)", example: "abc123..." },
  { key: "cloudflare_email", description: "Cloudflare account email used with cloudflare_api_key (also reads CLOUDFLARE_EMAIL env var)", example: "admin@example.com" },
  { key: "cloudflare_account_id", description: "Optional Cloudflare account ID for zone creation workflows (also reads CLOUDFLARE_ACCOUNT_ID env var)", example: "abc12345" },
  { key: "brandsight_api_key", description: "BrandSight/GCD API key for DNS setup (also reads BRANDSIGHT_API_KEY env var)", example: "abc123..." },
  { key: "brandsight_api_secret", description: "BrandSight/GCD API secret for DNS setup (also reads BRANDSIGHT_API_SECRET env var)", example: "abc123..." },
  { key: "brandsight_customer_id", description: "BrandSight/GCD customer ID for DNS setup (also reads BRANDSIGHT_CUSTOMER_ID env var)", example: "123456" },
  { key: "ai_provider", description: "Default Mailery AI provider: cerebras or groq", example: "cerebras" },
  { key: "ai_model", description: "Default Mailery AI model override for the selected provider", example: "zai-glm-4.7" },
  { key: "cerebras_api_key", description: "Cerebras API key for `mailery agent` (also reads CEREBRAS_API_KEY env var)", example: "csk_..." },
  { key: "cerebras_model", description: "Cerebras model for `mailery agent` (default: zai-glm-4.7)", example: "zai-glm-4.7" },
  { key: "groq_api_key", description: "Groq API key for `mailery agent --provider groq` (also reads GROQ_API_KEY env var)", example: "gsk_..." },
  { key: "groq_model", description: "Groq model for `mailery agent --provider groq` (default: qwen/qwen3-32b)", example: "qwen/qwen3-32b" },
  { key: "cloud_api_url", description: "Mailery Cloud API URL used by `mailery cloud`", example: "https://mailery.co" },
  { key: "cloud_api_key", description: "Mailery Cloud API key used by `mailery cloud` (also reads MAILERY_API_KEY)", example: "ml_..." },
  { key: "cloud_session_token", description: "Mailery Cloud session token from email/password login", example: "eyJ..." },
  { key: "brave_search_api_key", description: "Optional Brave Search API key for managed email agent domain/company lookups (also reads BRAVE_SEARCH_API_KEY)", example: "BSA..." },
  { key: "inbound_s3_bucket", description: "S3 bucket name used by SES for inbound email storage", example: "my-emails-bucket" },
  { key: "inbound_s3_prefix", description: "S3 key prefix for inbound emails (default: inbound/<domain>/)", example: "inbound/example.com/" },
  { key: "inbound_s3_region", description: "AWS region for inbound S3 bucket (default: us-east-1)", example: "us-east-1" },
  { key: "inbound_s3_profile", description: "AWS profile for inbound S3 sync when not using provider credentials", example: "hasna-xyz-infra" },
];

function redactConfigEntry(key: string, value: unknown): unknown {
  return (redactSecrets({ [key]: value }) as Record<string, unknown>)[key];
}

export function registerConfigCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const configCmd = program.command("config").description("Manage configuration");

  configCmd
    .command("set <key> <value>")
    .description("Set a config value")
    .action((key: string, value: string) => {
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { parsed = value; }
        setConfigValue(key, parsed);
        console.log(chalk.green(`✓ ${key} = ${JSON.stringify(redactConfigEntry(key, parsed))}`));
      } catch (e) { handleError(e); }
    });

  configCmd
    .command("get <key>")
    .description("Get a config value")
    .action((key: string) => {
      try {
        const value = getConfigValue(key);
        if (value === undefined) { console.log(chalk.dim(`${key} is not set`)); }
        else { console.log(`${key} = ${JSON.stringify(redactConfigEntry(key, value))}`); }
      } catch (e) { handleError(e); }
    });

  configCmd
    .command("unset <key>")
    .description("Remove a config value")
    .action((key: string) => {
      try {
        const config = loadConfig();
        if (!(key in config)) {
          console.log(chalk.dim(`${key} is not set`));
          return;
        }
        delete config[key];
        saveConfig(config);
        console.log(chalk.green(`✓ ${key} removed`));
      } catch (e) { handleError(e); }
    });

  configCmd
    .command("list")
    .description("List all config values")
    .option("--limit <n>", "Maximum config values to show in compact output", "20")
    .option("--offset <n>", "Number of config values to skip in compact output", "0")
    .option("--verbose", "Show full redacted values instead of compact summaries")
    .action((opts: { limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const config = loadConfig();
        const keys = Object.keys(config).sort();
        if (keys.length === 0) { output({}, chalk.dim("No config values set. Run 'mailery config keys' to see available keys.")); return; }
        const redacted = redactSecrets(config);
        const verbose = opts.verbose || isCliVerboseOutput();
        const page = parseCliPage(opts, 20);
        const visibleKeys = verbose ? keys : keys.slice(page.offset, page.offset + page.limit);
        const lines = [chalk.bold("\nConfig:")];
        for (const key of visibleKeys) {
          const value = verbose ? JSON.stringify(redacted[key]) : summarizeCliValue(redacted[key], 90);
          lines.push(`  ${chalk.cyan(key.padEnd(32))} ${value}`);
        }
        lines.push("");
        if (!verbose) {
          lines.push(formatListHint({
            shown: visibleKeys.length,
            limit: page.limit,
            offset: page.offset,
            noun: "config value",
            detailCommand: "use mailery config get <key> for one value",
            verbose,
          }));
          if (visibleKeys.length < keys.length) {
            lines.push(chalk.dim(`Total config values: ${keys.length}.`));
          }
        }
        output(redacted, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  configCmd
    .command("keys")
    .description("Show all known config keys with descriptions")
    .option("--verbose", "Include examples for every key")
    .action((opts: { verbose?: boolean }) => {
      const verbose = opts.verbose || isCliVerboseOutput();
      const lines = [chalk.bold("\nKnown config keys:"), ""];
      for (const k of KNOWN_KEYS) {
        if (verbose) {
          lines.push(`  ${chalk.cyan(k.key)}`);
          lines.push(`    ${chalk.dim(k.description)}`);
          lines.push(`    ${chalk.dim("e.g.")} ${k.example}`);
          lines.push("");
        } else {
          lines.push(`  ${chalk.cyan(k.key.padEnd(30))} ${chalk.dim(k.description)}`);
        }
      }
      lines.push("");
      lines.push(chalk.dim("Set with: mailery config set <key> <value>. Use --verbose for examples."));
      output(KNOWN_KEYS, lines.join("\n"));
    });
}
