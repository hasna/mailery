import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { getConfigValue, setConfigValue, loadConfig, saveConfig } from "../../lib/config.js";
import { getInboundEmail, listInboundEmailSummaries } from "../../db/inbound.js";
import { MaileryCloudClient, type MaileryCloudRequestOptions } from "../../lib/mailery-cloud-client.js";
import { handleError, parseCliPositiveIntOption } from "../utils.js";

type Output = (data: unknown, formatted: string) => void;

interface CloudRequestOptions {
  apiUrl?: string;
  apiKey?: string;
}

function configuredApiUrl(apiUrl?: string): string {
  return (
    apiUrl ||
    process.env["MAILERY_API_URL"] ||
    (getConfigValue("cloud_api_url") as string | undefined) ||
    "https://mailery.co"
  ).replace(/\/+$/, "");
}

function configuredToken(apiKey?: string): string | undefined {
  return (
    apiKey ||
    process.env["MAILERY_API_KEY"] ||
    process.env["MAILERY_SESSION_TOKEN"] ||
    (getConfigValue("cloud_api_key") as string | undefined) ||
    (getConfigValue("cloud_session_token") as string | undefined)
  );
}

async function cloudRequest<T>(
  path: string,
  opts: CloudRequestOptions & MaileryCloudRequestOptions = {},
): Promise<T> {
  const apiUrl = configuredApiUrl(opts.apiUrl);
  const token = configuredToken(opts.apiKey);
  return new MaileryCloudClient({ apiUrl, token }).request<T>(path, opts);
}

function saveCloudAuth(input: { apiUrl: string; apiKey?: string; sessionToken?: string }): void {
  setConfigValue("cloud_api_url", input.apiUrl);
  if (input.apiKey) setConfigValue("cloud_api_key", input.apiKey);
  if (input.sessionToken) setConfigValue("cloud_session_token", input.sessionToken);
}

function clearCloudAuth(): void {
  const config = loadConfig();
  delete config["cloud_api_key"];
  delete config["cloud_session_token"];
  saveConfig(config);
}

function formatStatus(data: {
  api_url: string;
  me: { tenant?: { name?: string; plan?: string }; user?: { email?: string } | null; auth?: { via?: string } };
  billing?: { balance?: number };
}): string {
  return [
    chalk.bold("Mailery Cloud"),
    `  API:     ${chalk.cyan(data.api_url)}`,
    `  Tenant:  ${data.me.tenant?.name ?? "(unknown)"}`,
    `  User:    ${data.me.user?.email ?? data.me.auth?.via ?? "api key"}`,
    `  Plan:    ${data.me.tenant?.plan ?? "free"}`,
    `  Credits: ${data.billing?.balance ?? "unknown"}`,
  ].join("\n");
}

export function registerCloudCommands(program: Command, output: Output): void {
  const cloud = program.command("cloud").description("Use the paid Mailery Cloud platform without changing local-first defaults");

  cloud
    .command("login")
    .description("Store Mailery Cloud API auth")
    .option("--api-url <url>", "Mailery Cloud API URL", "https://mailery.co")
    .option("--api-key <key>", "Mailery Cloud API key (ml_...)")
    .option("--email <email>", "Email/password login email")
    .option("--password <password>", "Email/password login password")
    .option("--no-verify", "Store auth without calling the API")
    .action(async (opts: { apiUrl: string; apiKey?: string; email?: string; password?: string; verify?: boolean }) => {
      try {
        const apiUrl = configuredApiUrl(opts.apiUrl);
        if (opts.email || opts.password) {
          if (!opts.email || !opts.password) throw new Error("--email and --password are required together");
          const session = await cloudRequest<{ token: string; tenant: { name: string }; user: { email: string } }>("/api/v1/auth/login", {
            apiUrl,
            method: "POST",
            tokenRequired: false,
            body: { email: opts.email, password: opts.password },
          });
          saveCloudAuth({ apiUrl, sessionToken: session.token });
          output({ api_url: apiUrl, tenant: session.tenant, user: session.user }, chalk.green(`✓ Connected to Mailery Cloud as ${session.user.email}`));
          return;
        }

        if (!opts.apiKey) throw new Error("--api-key is required unless using --email/--password");
        if (opts.verify !== false) {
          await cloudRequest("/api/v1/auth/me", { apiUrl, apiKey: opts.apiKey });
        }
        saveCloudAuth({ apiUrl, apiKey: opts.apiKey });
        output({ api_url: apiUrl, api_key_prefix: opts.apiKey.slice(0, 12) }, chalk.green(`✓ Mailery Cloud API key saved for ${apiUrl}`));
      } catch (e) { handleError(e); }
    });

  cloud
    .command("signup")
    .description("Create a Mailery Cloud account and store the returned API key")
    .requiredOption("--email <email>", "Account email")
    .requiredOption("--password <password>", "Account password")
    .option("--name <name>", "Tenant/user name")
    .option("--api-url <url>", "Mailery Cloud API URL", "https://mailery.co")
    .action(async (opts: { email: string; password: string; name?: string; apiUrl: string }) => {
      try {
        const apiUrl = configuredApiUrl(opts.apiUrl);
        const session = await cloudRequest<{ token: string; apiKey?: string; tenant: { name: string }; user: { email: string } }>("/api/v1/auth/signup", {
          apiUrl,
          method: "POST",
          tokenRequired: false,
          body: { email: opts.email, password: opts.password, name: opts.name },
        });
        saveCloudAuth({ apiUrl, apiKey: session.apiKey, sessionToken: session.token });
        output({ api_url: apiUrl, tenant: session.tenant, user: session.user, api_key_created: Boolean(session.apiKey) }, chalk.green(`✓ Created Mailery Cloud account for ${session.user.email}`));
      } catch (e) { handleError(e); }
    });

  cloud
    .command("logout")
    .description("Remove stored Mailery Cloud credentials")
    .action(() => {
      clearCloudAuth();
      output({ ok: true }, chalk.green("✓ Mailery Cloud credentials removed"));
    });

  cloud
    .command("status")
    .description("Show Mailery Cloud account and credit status")
    .option("--api-url <url>", "Override Mailery Cloud API URL")
    .option("--api-key <key>", "Override Mailery Cloud API key")
    .action(async (opts: CloudRequestOptions) => {
      try {
        const apiUrl = configuredApiUrl(opts.apiUrl);
        const [me, billing] = await Promise.all([
          cloudRequest<{ tenant?: unknown; user?: unknown; auth?: unknown }>("/api/v1/auth/me", opts),
          cloudRequest<{ balance?: number }>("/api/v1/billing/overview", opts),
        ]);
        output({ api_url: apiUrl, me, billing }, formatStatus({ api_url: apiUrl, me: me as never, billing }));
      } catch (e) { handleError(e); }
    });

  const mailbox = cloud.command("mailbox").description("Manage Mailery Cloud mailboxes");
  mailbox
    .command("list")
    .description("List cloud mailboxes")
    .action(async () => {
      try {
        const data = await cloudRequest<{ data: Array<{ id: string; email: string; provider: string; status: string }> }>("/api/v1/mailboxes");
        output(data.data, data.data.length ? data.data.map((m) => `${m.id.slice(0, 8)}  ${m.email}  ${m.provider}  ${m.status}`).join("\n") : chalk.dim("No cloud mailboxes."));
      } catch (e) { handleError(e); }
    });
  mailbox
    .command("add <email>")
    .description("Create or update a cloud mailbox")
    .option("--name <name>", "Mailbox display name")
    .option("--provider <provider>", "manual, resend, ses, gmail, sandbox", "manual")
    .action(async (email: string, opts: { name?: string; provider?: string }) => {
      try {
        const data = await cloudRequest<{ id: string; email: string }>("/api/v1/mailboxes", {
          method: "POST",
          body: { email, name: opts.name, provider: opts.provider },
        });
        output(data, chalk.green(`✓ Cloud mailbox ${data.email} (${data.id.slice(0, 8)})`));
      } catch (e) { handleError(e); }
    });

  cloud
    .command("sync-inbox")
    .description("Upload local inbound emails to Mailery Cloud")
    .requiredOption("--mailbox-id <id>", "Cloud mailbox ID")
    .option("--limit <n>", "Local inbound emails to upload", "25")
    .option("--parse", "Ask cloud parser to summarize/classify each uploaded message")
    .action(async (opts: { mailboxId: string; limit?: string; parse?: boolean }) => {
      try {
        const limit = parseCliPositiveIntOption(opts.limit, 25, 200);
        const summaries = listInboundEmailSummaries({ limit });
        let uploaded = 0;
        for (const summary of summaries) {
          const email = getInboundEmail(summary.id);
          if (!email) continue;
          await cloudRequest("/api/v1/messages", {
            method: "POST",
            idempotencyKey: `local:${email.id}`,
            body: {
              mailboxId: opts.mailboxId,
              externalId: `local:${email.id}`,
              subject: email.subject,
              from: email.from_address,
              to: email.to_addresses,
              cc: email.cc_addresses,
              text: email.text_body,
              html: email.html_body,
              labels: email.label_ids,
              flags: {
                read: email.is_read,
                starred: email.is_starred,
                archived: email.is_archived,
                sent: email.is_sent,
              },
              attachments: email.attachments,
              attachmentPaths: email.attachment_paths.map((attachment) => ({
                filename: attachment.filename,
                contentType: attachment.content_type,
                size: attachment.size,
                localPath: attachment.local_path,
                s3Url: attachment.s3_url,
              })),
              receivedAt: email.received_at,
              parse: opts.parse === true,
            },
          });
          uploaded += 1;
        }
        output({ uploaded, limit, parsed: opts.parse === true }, chalk.green(`✓ Uploaded ${uploaded} email(s) to Mailery Cloud`));
      } catch (e) { handleError(e); }
    });

  const digest = cloud.command("digest").description("Generate or list Mailery Cloud digests");
  digest
    .command("generate")
    .description("Generate a cloud digest")
    .option("--window <window>", "today, yesterday, last_7_days, month", "today")
    .action(async (opts: { window: string }) => {
      try {
        const data = await cloudRequest<{ title: string; summary: string }>("/api/v1/digests/generate", {
          method: "POST",
          body: { window: opts.window },
        });
        output(data, `${chalk.bold(data.title)}\n${data.summary}`);
      } catch (e) { handleError(e); }
    });
  digest
    .command("list")
    .description("List recent cloud digests")
    .option("--limit <n>", "Number of digests", "10")
    .action(async (opts: { limit?: string }) => {
      try {
        const limit = parseCliPositiveIntOption(opts.limit, 10, 100);
        const data = await cloudRequest<{ data: Array<{ id: string; title: string; summary: string; createdAt: string }> }>(`/api/v1/digests?limit=${limit}`);
        output(data.data, data.data.length ? data.data.map((d) => `${d.id.slice(0, 8)}  ${d.title}\n${d.summary}`).join("\n\n") : chalk.dim("No cloud digests."));
      } catch (e) { handleError(e); }
    });
}
