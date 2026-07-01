import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { getDatabase, reconcileMailboxMessageState } from "../../db/database.js";
import { getInboundEmail, listInboundEmailSummaries, storeInboundEmail, type InboundEmail } from "../../db/inbound.js";
import { getConfigValue, loadConfig, saveConfig, setConfigValue } from "../../lib/config.js";
import { openLocalTarget, type LocalOpenResult } from "../../lib/local-actions.js";
import {
  DEFAULT_MAILERY_CLOUD_API_URL,
  MaileryCloudClient,
  MaileryCloudError,
  type MaileryCloudBillingOverview,
  type MaileryCloudClientOptions,
  type MaileryCloudDigestWindow,
  type MaileryCloudMeResponse,
  type MaileryCloudMessage,
  type MaileryCloudMessageUploadInput,
  type MaileryCloudMessageWithAttachments,
} from "../../lib/mailery-cloud-client.js";
import { handleError, parseCliPositiveIntOption } from "../utils.js";

const CLOUD_API_URL_KEY = "cloud_api_url";
const CLOUD_SESSION_TOKEN_KEY = "cloud_session_token";
const CLOUD_API_KEY_KEY = "cloud_api_key";

type OutputFn = (data: unknown, formatted: string) => void;

interface CloudGlobalOptions {
  apiUrl?: string;
  token?: string;
  apiKey?: string;
}

interface CloudCommandDeps {
  createClient?: (opts: MaileryCloudClientOptions) => MaileryCloudClientLike;
  openUrl?: (url: string) => LocalOpenResult;
  listInboundSummaries?: typeof listInboundEmailSummaries;
  getInboundEmail?: typeof getInboundEmail;
  storeInboundEmail?: typeof storeInboundEmail;
}

type MaileryCloudClientLike = Pick<
  MaileryCloudClient,
  | "health"
  | "signup"
  | "login"
  | "logout"
  | "me"
  | "billingOverview"
  | "createCheckout"
  | "createPortal"
  | "listMailboxes"
  | "createMailbox"
  | "messageGroups"
  | "listMessages"
  | "createMessage"
  | "getMessage"
  | "parseMessage"
  | "listDigests"
  | "generateDigest"
  | "listApiKeys"
  | "createApiKey"
  | "revokeApiKey"
  | "checkDomainAvailability"
  | "setupDomain"
>;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getApiUrl(opts: CloudGlobalOptions): string {
  return opts.apiUrl
    ?? stringValue(getConfigValue(CLOUD_API_URL_KEY))
    ?? process.env["MAILERY_CLOUD_API_URL"]
    ?? process.env["MAILERY_API_URL"]
    ?? DEFAULT_MAILERY_CLOUD_API_URL;
}

function getToken(opts: CloudGlobalOptions): string | undefined {
  return opts.token
    ?? opts.apiKey
    ?? process.env["MAILERY_API_KEY"]
    ?? process.env["MAILERY_CLOUD_TOKEN"]
    ?? stringValue(getConfigValue(CLOUD_SESSION_TOKEN_KEY))
    ?? stringValue(getConfigValue(CLOUD_API_KEY_KEY));
}

function saveCloudToken(apiUrl: string, key: typeof CLOUD_SESSION_TOKEN_KEY | typeof CLOUD_API_KEY_KEY, token: string): void {
  const config = loadConfig();
  config[CLOUD_API_URL_KEY] = apiUrl;
  config[key] = token;
  if (key === CLOUD_SESSION_TOKEN_KEY) delete config[CLOUD_API_KEY_KEY];
  if (key === CLOUD_API_KEY_KEY) delete config[CLOUD_SESSION_TOKEN_KEY];
  saveConfig(config);
}

function clearCloudTokens(): void {
  const config = loadConfig();
  delete config[CLOUD_SESSION_TOKEN_KEY];
  delete config[CLOUD_API_KEY_KEY];
  saveConfig(config);
}

function authSavedPayload(apiUrl: string, me: MaileryCloudMeResponse | null, email?: string): Record<string, unknown> {
  return {
    api_url: apiUrl,
    authenticated: true,
    token_saved: true,
    user: me?.user ?? (email ? { email } : null),
    tenant: me?.tenant ?? null,
    auth: me?.auth ?? null,
  };
}

function globals(command: Command): CloudGlobalOptions {
  return command.optsWithGlobals?.() as CloudGlobalOptions ?? command.opts() as CloudGlobalOptions;
}

function makeClient(command: Command, deps: CloudCommandDeps = {}, tokenOverride?: string): MaileryCloudClientLike {
  const opts = globals(command);
  const apiUrl = getApiUrl(opts);
  const token = tokenOverride ?? getToken(opts);
  return deps.createClient?.({ apiUrl, token }) ?? new MaileryCloudClient({ apiUrl, token });
}

function formatMe(me: MaileryCloudMeResponse, apiUrl: string): string {
  const user = me.user ? `${me.user.email} (${me.user.role})` : "API key";
  const tenant = me.tenant ? `${me.tenant.name} ${chalk.dim(me.tenant.id)}` : "unknown tenant";
  return [
    chalk.bold("Mailery Cloud"),
    "  Mode:   cloud (Mailery Cloud)",
    `  API:    ${apiUrl}`,
    `  User:   ${user}`,
    `  Tenant: ${tenant}`,
    `  Auth:   ${me.auth.via} ${chalk.dim(me.auth.scopes.join(","))}`,
  ].join("\n");
}

function formatBilling(overview: MaileryCloudBillingOverview): string {
  const lines = [
    chalk.bold("Mailery Cloud billing"),
    `  Credits: ${overview.balance}`,
    "",
    "Plans:",
  ];
  for (const [key, plan] of Object.entries(overview.plans)) {
    lines.push(`  ${key.padEnd(10)} $${(plan.amountCents / 100).toFixed(0)}/mo, ${plan.monthlyCredits} credits`);
  }
  lines.push("", "Credit packs:");
  for (const [credits, cents] of Object.entries(overview.credit_packs)) {
    lines.push(`  ${String(credits).padEnd(10)} $${(cents / 100).toFixed(0)}`);
  }
  return lines.join("\n");
}

function maybeOpenUrl(url: string, open: boolean | undefined, deps: CloudCommandDeps): LocalOpenResult | undefined {
  if (open === false) return undefined;
  if (!process.stdout.isTTY) return undefined;
  return (deps.openUrl ?? openLocalTarget)(url);
}

function checkoutText(kind: string, url: string, opened?: LocalOpenResult): string {
  const openedText = opened
    ? opened.ok ? `Opened with ${opened.method}` : `Open failed: ${opened.error}`
    : "Browser open disabled";
  return [
    chalk.green(`Mailery Cloud ${kind} link ready.`),
    `  ${url}`,
    chalk.dim(`  ${openedText}`),
  ].join("\n");
}

function formatSetupResult(result: {
  apiUrl: string;
  email: string;
  mode: "signup" | "login";
  me: MaileryCloudMeResponse | null;
  apiKey?: Awaited<ReturnType<MaileryCloudClient["createApiKey"]>>;
  billing?: { url: string; opened?: LocalOpenResult };
}): string {
  const lines = [
    chalk.green("Mailery Cloud setup complete."),
    `  API:     ${result.apiUrl}`,
    `  Account: ${result.me?.user?.email ?? result.email}`,
    `  Mode:    ${result.mode}`,
  ];
  if (result.apiKey) {
    lines.push(
      `  API key: ${result.apiKey.api_key.name} (${result.apiKey.api_key.prefix})`,
      `  Secret:  ${result.apiKey.key}`,
      chalk.dim("  This secret is shown once. Store it in MAILERY_API_KEY for agents."),
    );
  }
  if (result.billing) {
    lines.push(
      `  Billing: ${result.billing.url}`,
      chalk.dim(`  ${result.billing.opened ? result.billing.opened.ok ? `Opened with ${result.billing.opened.method}` : `Open failed: ${result.billing.opened.error}` : "Browser open disabled"}`),
    );
  }
  return lines.join("\n");
}

function formatMailboxes(rows: Array<{ id: string; email: string; provider: string; status: string }>): string {
  if (rows.length === 0) return chalk.dim("No cloud mailboxes.");
  return [
    chalk.bold("Cloud mailboxes"),
    ...rows.map((row) => `  ${row.id.slice(0, 8)}  ${row.email.padEnd(32)} ${row.provider} ${row.status}`),
  ].join("\n");
}

function formatMessages(rows: MaileryCloudMessage[]): string {
  if (rows.length === 0) return chalk.dim("No cloud messages.");
  return [
    chalk.bold("Cloud messages"),
    ...rows.map((row) => {
      const when = row.receivedAt ?? row.sentAt ?? row.createdAt;
      return `  ${row.id.slice(0, 8)}  ${when?.slice(0, 19) ?? ""}  ${row.fromAddress.padEnd(28).slice(0, 28)}  ${row.subject || "(no subject)"}`;
    }),
  ].join("\n");
}

function formatMessage(message: MaileryCloudMessageWithAttachments): string {
  return [
    chalk.bold(message.subject || "(no subject)"),
    `  ID:      ${message.id}`,
    `  From:    ${message.fromAddress}`,
    `  To:      ${message.toAddresses.join(", ")}`,
    `  Date:    ${message.receivedAt ?? message.sentAt ?? message.createdAt}`,
    `  Summary: ${message.summary ?? "(none)"}`,
    "",
    message.cleanMarkdown ?? message.textBody ?? "",
  ].join("\n").trim();
}

function uploadInputFromInbound(mailboxId: string, email: InboundEmail, parse: boolean): MaileryCloudMessageUploadInput {
  return {
    mailboxId,
    direction: email.is_sent ? "outbound" : "inbound",
    status: "synced",
    subject: email.subject,
    fromAddress: email.from_address,
    toAddresses: email.to_addresses,
    ccAddresses: email.cc_addresses,
    receivedAt: email.received_at,
    textBody: email.text_body,
    htmlBody: email.html_body,
    parse,
    externalId: email.message_id ?? email.id,
  };
}

function rawSize(message: MaileryCloudMessageWithAttachments): number {
  return Buffer.byteLength(`${message.textBody ?? ""}${message.htmlBody ?? ""}`);
}

function storeCloudMessage(message: MaileryCloudMessageWithAttachments, deps: CloudCommandDeps): { stored: boolean; id?: string; skipped?: boolean } {
  const messageId = `cloud:${message.id}`;
  const db = getDatabase();
  const existing = db.query("SELECT id FROM inbound_emails WHERE message_id = ? LIMIT 1").get(messageId) as { id: string } | null;
  if (existing) return { stored: false, skipped: true, id: existing.id };
  const stored = (deps.storeInboundEmail ?? storeInboundEmail)({
    provider_id: null,
    message_id: messageId,
    in_reply_to_email_id: null,
    from_address: message.fromAddress || "unknown@mailery.co",
    to_addresses: message.toAddresses ?? [],
    cc_addresses: message.ccAddresses ?? [],
    subject: message.subject ?? "",
    text_body: message.textBody ?? message.cleanMarkdown ?? message.summary ?? null,
    html_body: message.htmlBody ?? null,
    attachments: message.attachments.map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size: attachment.sizeBytes,
    })),
    attachment_paths: [],
    headers: { "X-Mailery-Cloud-Message-Id": message.id },
    raw_size: rawSize(message),
    received_at: message.receivedAt ?? message.sentAt ?? message.createdAt,
    label_ids: [
      message.isImportant ? "important" : "",
      message.isSpam ? "spam" : "",
      message.isTrash ? "trash" : "",
      message.isArchived ? "archived" : "",
    ].filter(Boolean),
  }, db);
  const readAt = message.isRead ? new Date().toISOString() : null;
  db.run(
    `UPDATE inbound_emails
        SET is_read = ?,
            read_at = ?,
            is_archived = ?,
            is_starred = ?,
            is_spam = ?,
            is_trash = ?
      WHERE id = ?`,
    [
      message.isRead ? 1 : 0,
      readAt,
      message.isArchived ? 1 : 0,
      message.isImportant ? 1 : 0,
      message.isSpam ? 1 : 0,
      message.isTrash ? 1 : 0,
      stored.id,
    ],
  );
  reconcileMailboxMessageState(db);
  return { stored: true, id: stored.id };
}

function normalizeDigestWindow(value: string | undefined): MaileryCloudDigestWindow {
  const window = (value ?? "today") as MaileryCloudDigestWindow;
  if (["today", "yesterday", "last_7_days", "month"].includes(window)) return window;
  throw new Error("window must be one of: today, yesterday, last_7_days, month");
}

async function runUploadLocal(
  opts: { mailboxId: string; limit?: string; parse?: boolean; dryRun?: boolean },
  cmd: Command,
  deps: CloudCommandDeps,
  output: OutputFn,
): Promise<void> {
  const summaries = (deps.listInboundSummaries ?? listInboundEmailSummaries)({ limit: parseCliPositiveIntOption(opts.limit, 50, 500) });
  const uploads: MaileryCloudMessageUploadInput[] = [];
  for (const summary of summaries) {
    const email = (deps.getInboundEmail ?? getInboundEmail)(summary.id);
    if (email) uploads.push(uploadInputFromInbound(opts.mailboxId, email, !!opts.parse));
  }
  if (opts.dryRun) {
    output({ count: uploads.length, uploads }, chalk.dim(`Would upload ${uploads.length} local message(s).`));
    return;
  }
  const client = makeClient(cmd, deps);
  const results = [];
  for (const upload of uploads) {
    results.push(await client.createMessage(upload));
  }
  output({ uploaded: results.length, data: results }, chalk.green(`Uploaded ${results.length} local message(s) to Mailery Cloud.`));
}

function cloudErrorText(error: unknown): string {
  if (error instanceof MaileryCloudError && error.status === 404) {
    return `${error.message}. This Mailery Cloud endpoint is not live on the server yet.`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function registerCloudCommands(program: Command, output: OutputFn, deps: CloudCommandDeps = {}): void {
  const cloud = program
    .command("cloud")
    .description("Use Mailery Cloud as the hosted email source of truth")
    .option("--api-url <url>", "Mailery Cloud API URL")
    .option("--token <token>", "Session token or API key; defaults to MAILERY_API_KEY/config")
    .option("--api-key <key>", "Mailery Cloud API key; alias for --token");

  cloud
    .command("signup")
    .description("Create a Mailery Cloud user account and store the session")
    .requiredOption("--email <email>", "Account email")
    .requiredOption("--password <password>", "Account password")
    .option("--name <name>", "Display name")
    .action(async (opts: { email: string; password: string; name?: string }, cmd: Command) => {
      try {
        const apiUrl = getApiUrl(globals(cmd));
        const client = makeClient(cmd, deps, undefined);
        const auth = await client.signup({ email: opts.email, password: opts.password, name: opts.name });
        saveCloudToken(apiUrl, CLOUD_SESSION_TOKEN_KEY, auth.token);
        const authedClient = makeClient(cmd, deps, auth.token);
        const me = await authedClient.me().catch(() => null);
        output(authSavedPayload(apiUrl, me, opts.email), me ? formatMe(me, apiUrl) : chalk.green(`Created account for ${opts.email}.`));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  cloud
    .command("login")
    .description("Log in with email/password or store an existing Mailery Cloud API key")
    .option("--email <email>", "Account email")
    .option("--password <password>", "Account password")
    .option("--api-key <key>", "Mailery Cloud API key")
    .action(async (opts: { email?: string; password?: string; apiKey?: string }, cmd: Command) => {
      try {
        const globalOpts = globals(cmd);
        const apiUrl = getApiUrl(globalOpts);
        if (opts.apiKey || globalOpts.apiKey || globalOpts.token) {
          const token = opts.apiKey ?? globalOpts.apiKey ?? globalOpts.token!;
          const client = makeClient(cmd, deps, token);
          const me = await client.me();
          saveCloudToken(apiUrl, CLOUD_API_KEY_KEY, token);
          output({ api_url: apiUrl, me }, formatMe(me, apiUrl));
          return;
        }
        if (!opts.email || !opts.password) throw new Error("Provide --email and --password, or --api-key.");
        const client = makeClient(cmd, deps, undefined);
        const auth = await client.login({ email: opts.email, password: opts.password });
        saveCloudToken(apiUrl, CLOUD_SESSION_TOKEN_KEY, auth.token);
        const me = await makeClient(cmd, deps, auth.token).me().catch(() => null);
        output(authSavedPayload(apiUrl, me, opts.email), me ? formatMe(me, apiUrl) : chalk.green(`Signed in as ${opts.email}.`));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  cloud
    .command("logout")
    .description("Clear stored Mailery Cloud session/API key")
    .action(async (_opts: unknown, cmd: Command) => {
      try {
        await makeClient(cmd, deps).logout().catch(() => ({ ok: true }));
        clearCloudTokens();
        output({ ok: true }, chalk.green("Signed out of Mailery Cloud."));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  cloud
    .command("status")
    .description("Show Mailery Cloud connection and account status")
    .action(async (_opts: unknown, cmd: Command) => {
      try {
        const globalOpts = globals(cmd);
        const apiUrl = getApiUrl(globalOpts);
        const client = makeClient(cmd, deps);
        const info = await client.health().catch(() => null);
        const token = getToken(globalOpts);
        const mode = { current: "cloud", label: "Mailery Cloud" } as const;
        if (!token) {
          output({ mode, api_url: apiUrl, service: info, authenticated: false }, [
            chalk.bold("Mailery Cloud"),
            `  Mode: ${mode.current} (${mode.label})`,
            `  API:  ${apiUrl}`,
            `  Live: ${info ? "yes" : "no"}`,
            chalk.dim("  Not authenticated. Run `mailery cloud login`."),
          ].join("\n"));
          return;
        }
        const me = await client.me();
        output({ mode, api_url: apiUrl, service: info, authenticated: true, me }, formatMe(me, apiUrl));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  cloud
    .command("setup")
    .description("Bootstrap Mailery Cloud auth, optional agent API key, and optional billing link")
    .requiredOption("--email <email>", "Account email")
    .requiredOption("--password <password>", "Account password")
    .option("--name <name>", "Display name used for signup")
    .option("--login", "Log in to an existing account instead of creating one")
    .option("--api-key-name <name>", "Create an agent API key and print it once")
    .option("--scope <scope...>", "API key scopes: full, mail_read, mail_write, billing_read, admin")
    .option("--billing", "Create a Stripe subscription checkout link")
    .option("--plan <plan>", "Subscription plan key", "starter")
    .option("--no-open", "Do not open the Stripe checkout URL")
    .action(async (opts: {
      email: string;
      password: string;
      name?: string;
      login?: boolean;
      apiKeyName?: string;
      scope?: string[];
      billing?: boolean;
      plan?: string;
      open?: boolean;
    }, cmd: Command) => {
      try {
        const apiUrl = getApiUrl(globals(cmd));
        const client = makeClient(cmd, deps, undefined);
        const mode = opts.login ? "login" : "signup";
        const auth = opts.login
          ? await client.login({ email: opts.email, password: opts.password })
          : await client.signup({ email: opts.email, password: opts.password, name: opts.name });
        saveCloudToken(apiUrl, CLOUD_SESSION_TOKEN_KEY, auth.token);
        const authedClient = makeClient(cmd, deps, auth.token);
        const me = await authedClient.me().catch(() => null);
        const billing = opts.billing
          ? await authedClient.createCheckout({ kind: "subscription", plan: opts.plan ?? "starter" }).then((checkout) => ({
              ...checkout,
              opened: maybeOpenUrl(checkout.url, opts.open, deps),
            }))
          : undefined;
        const apiKey = opts.apiKeyName
          ? await authedClient.createApiKey({
              name: opts.apiKeyName,
              scopes: opts.scope?.length ? opts.scope : undefined,
            })
          : undefined;
        output({
          api_url: apiUrl,
          authenticated: true,
          token_saved: true,
          mode,
          user: me?.user ?? auth.user ?? { email: opts.email },
          tenant: me?.tenant ?? auth.tenant ?? null,
          auth: me?.auth ?? null,
          agent_auth: apiKey
            ? {
                type: "api_key",
                key: apiKey.key,
                id: apiKey.api_key.id,
                name: apiKey.api_key.name,
                prefix: apiKey.api_key.prefix,
                scopes: apiKey.api_key.scopes,
                shown_once: true,
              }
            : null,
          billing,
        }, formatSetupResult({ apiUrl, email: opts.email, mode, me, apiKey, billing }));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  const billing = cloud.command("billing").description("Manage Stripe billing for Mailery Cloud");

  billing
    .command("overview")
    .description("Show credit balance, subscription plans, credit packs, and ledger")
    .option("--limit <n>", "Maximum ledger rows", "20")
    .action(async (opts: { limit?: string }, cmd: Command) => {
      try {
        const overview = await makeClient(cmd, deps).billingOverview({ limit: parseCliPositiveIntOption(opts.limit, 20, 100) });
        output(overview, formatBilling(overview));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  const apiKeys = cloud.command("api-keys").alias("api-key").description("Manage one-time Mailery Cloud API keys");

  apiKeys
    .command("list")
    .description("List cloud API keys without secret material")
    .action(async (_opts: unknown, cmd: Command) => {
      try {
        const rows = (await makeClient(cmd, deps).listApiKeys()).map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          scopes: row.scopes,
          lastUsedAt: row.lastUsedAt,
          revokedAt: row.revokedAt,
          createdAt: row.createdAt,
        }));
        const lines = rows.length
          ? [
              chalk.bold("Mailery Cloud API keys"),
              ...rows.map((row) => `  ${row.id.slice(0, 8)}  ${row.name.padEnd(18)} ${row.prefix} ${row.scopes.join(",")}${row.revokedAt ? " revoked" : ""}`),
            ]
          : [chalk.dim("No cloud API keys.")];
        output({ data: rows }, lines.join("\n"));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  apiKeys
    .command("create")
    .description("Create a cloud API key and print the secret once")
    .option("--name <name>", "API key name", "CLI")
    .option("--scope <scope...>", "Scopes: full, mail_read, mail_write, billing_read, admin")
    .action(async (opts: { name?: string; scope?: string[] }, cmd: Command) => {
      try {
        const result = await makeClient(cmd, deps).createApiKey({
          name: opts.name ?? "CLI",
          scopes: opts.scope?.length ? opts.scope : undefined,
        });
        output(
          {
            key: result.key,
            record: {
              id: result.api_key.id,
              name: result.api_key.name,
              prefix: result.api_key.prefix,
              scopes: result.api_key.scopes,
              lastUsedAt: result.api_key.lastUsedAt,
              revokedAt: result.api_key.revokedAt,
              createdAt: result.api_key.createdAt,
            },
          },
          [
            chalk.green(`Created API key ${result.api_key.name} (${result.api_key.prefix}).`),
            `  ${result.key}`,
            chalk.dim("  This secret is shown once. Store it in MAILERY_API_KEY or run mailery cloud login --api-key <key>."),
          ].join("\n"),
        );
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  apiKeys
    .command("revoke <id>")
    .description("Revoke a cloud API key")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      try {
        const result = await makeClient(cmd, deps).revokeApiKey(id);
        output(result, chalk.green(`Revoked API key ${id}.`));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  billing
    .command("subscribe")
    .description("Create a Stripe subscription checkout link")
    .option("--plan <plan>", "Subscription plan key", "starter")
    .option("--no-open", "Do not open the Stripe checkout URL")
    .action(async (opts: { plan?: string; open?: boolean }, cmd: Command) => {
      try {
        const result = await makeClient(cmd, deps).createCheckout({ kind: "subscription", plan: opts.plan ?? "starter" });
        const opened = maybeOpenUrl(result.url, opts.open, deps);
        output({ ...result, opened }, checkoutText("subscription", result.url, opened));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  billing
    .command("buy-credits")
    .description("Create a Stripe credit-pack checkout link")
    .option("--credits <n>", "Credit pack size", "1000")
    .option("--no-open", "Do not open the Stripe checkout URL")
    .action(async (opts: { credits?: string; open?: boolean }, cmd: Command) => {
      try {
        const credits = parseCliPositiveIntOption(opts.credits, 1000, 1_000_000);
        const result = await makeClient(cmd, deps).createCheckout({ kind: "credit_pack", credits });
        const opened = maybeOpenUrl(result.url, opts.open, deps);
        output({ ...result, opened }, checkoutText("credit checkout", result.url, opened));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  billing
    .command("portal")
    .description("Open the Stripe customer portal")
    .option("--no-open", "Do not open the Stripe portal URL")
    .action(async (opts: { open?: boolean }, cmd: Command) => {
      try {
        const result = await makeClient(cmd, deps).createPortal();
        const opened = maybeOpenUrl(result.url, opts.open, deps);
        output({ ...result, opened }, checkoutText("billing portal", result.url, opened));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  const mailbox = cloud.command("mailbox").alias("mailboxes").description("Manage hosted Mailery Cloud mailboxes");

  mailbox
    .command("list")
    .description("List cloud mailboxes")
    .action(async (_opts: unknown, cmd: Command) => {
      try {
        const rows = await makeClient(cmd, deps).listMailboxes();
        output({ data: rows }, formatMailboxes(rows));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  mailbox
    .command("add <email>")
    .description("Create or connect a cloud mailbox")
    .option("--name <name>", "Mailbox display name")
    .option("--provider <provider>", "manual | ses | resend | sandbox", "manual")
    .action(async (email: string, opts: { name?: string; provider?: string }, cmd: Command) => {
      try {
        const row = await makeClient(cmd, deps).createMailbox({
          email,
          name: opts.name,
          provider: opts.provider as never,
        });
        output(row, chalk.green(`Cloud mailbox ready: ${row.email} (${row.id})`));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  const messages = cloud.command("messages").alias("message").description("List, read, upload, and pull hosted messages");

  messages
    .command("list")
    .description("List cloud messages")
    .option("--group <group>", "inbox | important | unread | archived | spam | trash")
    .option("--q <query>", "Search query")
    .option("--limit <n>", "Maximum messages", "50")
    .action(async (opts: { group?: string; q?: string; limit?: string }, cmd: Command) => {
      try {
        const rows = await makeClient(cmd, deps).listMessages({
          group: opts.group,
          q: opts.q,
          limit: parseCliPositiveIntOption(opts.limit, 50, 200),
        });
        output({ data: rows }, formatMessages(rows));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  messages
    .command("groups")
    .description("Show cloud mailbox group counts")
    .action(async (_opts: unknown, cmd: Command) => {
      try {
        const groups = await makeClient(cmd, deps).messageGroups();
        const lines = [chalk.bold("Cloud message groups"), ...Object.entries(groups).map(([key, value]) => `  ${key}: ${value ?? 0}`)];
        output(groups, lines.join("\n"));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  messages
    .command("get <id>")
    .description("Read one cloud message")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      try {
        const message = await makeClient(cmd, deps).getMessage(id);
        output(message, formatMessage(message));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  messages
    .command("upload-local")
    .description("Upload recent local inbox messages into Mailery Cloud")
    .requiredOption("--mailbox-id <id>", "Target cloud mailbox ID")
    .option("--limit <n>", "Maximum local messages", "50")
    .option("--parse", "Ask Mailery Cloud to parse uploaded messages")
    .option("--dry-run", "Preview without uploading")
    .action(async (opts: { mailboxId: string; limit?: string; parse?: boolean; dryRun?: boolean }, cmd: Command) => {
      try {
        await runUploadLocal(opts, cmd, deps, output);
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  messages
    .command("pull")
    .description("Pull cloud messages into the local SQLite inbox")
    .option("--group <group>", "Cloud message group", "inbox")
    .option("--limit <n>", "Maximum messages", "50")
    .action(async (opts: { group?: string; limit?: string }, cmd: Command) => {
      try {
        const client = makeClient(cmd, deps);
        const rows = await client.listMessages({ group: opts.group, limit: parseCliPositiveIntOption(opts.limit, 50, 200) });
        let stored = 0;
        let skipped = 0;
        for (const row of rows) {
          const message = await client.getMessage(row.id);
          const result = storeCloudMessage(message, deps);
          if (result.stored) stored += 1;
          if (result.skipped) skipped += 1;
        }
        output({ read: rows.length, stored, skipped }, chalk.green(`Pulled ${stored} cloud message(s), skipped ${skipped} duplicate(s).`));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  cloud
    .command("sync-inbox")
    .description("Alias for cloud messages upload-local")
    .requiredOption("--mailbox-id <id>", "Target cloud mailbox ID")
    .option("--limit <n>", "Maximum local messages", "50")
    .option("--parse", "Ask Mailery Cloud to parse uploaded messages")
    .option("--dry-run", "Preview without uploading")
    .action(async (opts: { mailboxId: string; limit?: string; parse?: boolean; dryRun?: boolean }, cmd: Command) => {
      try {
        await runUploadLocal(opts, cmd, deps, output);
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  const digest = cloud.command("digest").alias("digests").description("Generate and list hosted Mailery digests");

  digest
    .command("list")
    .description("List cloud digests")
    .option("--limit <n>", "Maximum digests", "20")
    .action(async (opts: { limit?: string }, cmd: Command) => {
      try {
        const rows = await makeClient(cmd, deps).listDigests({ limit: parseCliPositiveIntOption(opts.limit, 20, 100) });
        const lines = rows.length
          ? [chalk.bold("Cloud digests"), ...rows.map((row) => `  ${row.id.slice(0, 8)}  ${row.window.padEnd(12)} ${row.title}`)]
          : [chalk.dim("No cloud digests.")];
        output({ data: rows }, lines.join("\n"));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  digest
    .command("generate")
    .description("Generate a hosted digest")
    .option("--window <window>", "today | yesterday | last_7_days | month", "today")
    .action(async (opts: { window?: string }, cmd: Command) => {
      try {
        const row = await makeClient(cmd, deps).generateDigest(normalizeDigestWindow(opts.window));
        output(row, chalk.green(`Generated ${row.window} digest: ${row.title}`));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  const domain = cloud.command("domain").alias("domains").description("Set up cloud mail domains");

  domain
    .command("available <domain>")
    .description("Check hosted-domain purchase availability")
    .action(async (domainName: string, _opts: unknown, cmd: Command) => {
      try {
        const result = await makeClient(cmd, deps).checkDomainAvailability(domainName);
        const price = result.price ? ` ${result.currency ?? "USD"} ${result.price}` : "";
        output(result, result.available ? chalk.green(`${result.domain} is available${price}`) : chalk.red(`${result.domain} is not available`));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  domain
    .command("setup <domain>")
    .description("Ask Mailery Cloud to buy/configure a hosted mail domain")
    .option("--address <email>", "Initial mailbox address")
    .option("--purchase", "Purchase the domain if available")
    .option("--catch-all", "Configure catch-all receiving when supported")
    .action(async (domainName: string, opts: { address?: string; purchase?: boolean; catchAll?: boolean }, cmd: Command) => {
      try {
        const result = await makeClient(cmd, deps).setupDomain({
          domain: domainName,
          address: opts.address,
          purchase: !!opts.purchase,
          catchAll: !!opts.catchAll,
        });
        output(result, chalk.green(`Cloud domain ${result.domain}: ${result.status}`));
      } catch (e) {
        handleError(new Error(cloudErrorText(e)));
      }
    });

  cloud
    .command("config")
    .description("Show Mailery Cloud CLI config keys")
    .action(() => {
      const apiUrl = stringValue(getConfigValue(CLOUD_API_URL_KEY)) ?? DEFAULT_MAILERY_CLOUD_API_URL;
      const hasSession = !!stringValue(getConfigValue(CLOUD_SESSION_TOKEN_KEY));
      const hasApiKey = !!stringValue(getConfigValue(CLOUD_API_KEY_KEY));
      output(
        { api_url: apiUrl, has_session: hasSession, has_api_key: hasApiKey },
        [
          chalk.bold("Mailery Cloud config"),
          `  ${CLOUD_API_URL_KEY}: ${apiUrl}`,
          `  ${CLOUD_SESSION_TOKEN_KEY}: ${hasSession ? "***" : "unset"}`,
          `  ${CLOUD_API_KEY_KEY}: ${hasApiKey ? "***" : "unset"}`,
          chalk.dim("  Set with: mailery cloud login or mailery config set cloud_api_url <url>"),
        ].join("\n"),
      );
    });

  cloud
    .command("use <url>")
    .description("Set the default Mailery Cloud API URL")
    .action((url: string) => {
      setConfigValue(CLOUD_API_URL_KEY, url.replace(/\/+$/, ""));
      output({ api_url: url.replace(/\/+$/, "") }, chalk.green(`Mailery Cloud API URL set to ${url.replace(/\/+$/, "")}`));
    });
}
