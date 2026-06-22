import { getDatabase } from "../db/database.js";
import { listProviders } from "../db/providers.js";
import { countValue } from "../db/scalars.js";
import { checkAllProviders } from "./health.js";
import { loadConfig } from "./config.js";
import { existsSync } from "fs";
import { join } from "path";
import type { Database } from "../db/database.js";
import type { DoctorCheck } from "./diagnostics-format.js";

export { formatDiagnostics } from "./diagnostics-format.js";
export type { DoctorCheck } from "./diagnostics-format.js";

interface GmailAuthCheckResult {
  success: boolean;
  stdout: string;
  stderr?: string;
}

export interface DiagnosticsOptions {
  liveProviderChecks?: boolean;
  gmailAuthCheck?: () => Promise<GmailAuthCheckResult>;
}

async function runGmailAuthCheck(): Promise<GmailAuthCheckResult> {
  const { runConnectorCommand } = await import("@hasna/connectors");
  return runConnectorCommand("gmail", ["-f", "json", "me"]);
}

export async function runDiagnostics(db?: Database, opts: DiagnosticsOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let d: Database;

  // 1. DB accessible
  try {
    d = db || getDatabase();
    d.query("SELECT 1").get();
    checks.push({ name: "Database", status: "pass", message: "SQLite database accessible" });
  } catch (e) {
    checks.push({ name: "Database", status: "fail", message: `Database error: ${e}` });
    return checks;
  }

  // 2. Config file
  const { getDataDir } = await import("../db/database.js");
  const configPath = join(getDataDir(), "config.json");
  checks.push(
    existsSync(configPath)
      ? { name: "Config", status: "pass", message: "Config file exists" }
      : { name: "Config", status: "warn", message: "No config file (run 'mailery config set' to create)" },
  );

  // 3. Providers
  const providers = listProviders(d);
  checks.push(
    providers.length > 0
      ? { name: "Providers", status: "pass", message: `${providers.length} provider(s) configured` }
      : { name: "Providers", status: "warn", message: "No providers configured" },
  );

  // 4. Provider health
  if (providers.length > 0) {
    const health = await checkAllProviders(d, { validateCredentials: opts.liveProviderChecks === true });
    for (const h of health) {
      checks.push({
        name: `Provider: ${h.provider.name}`,
        status: h.status === "healthy" ? "pass" : h.status === "warning" ? "warn" : "fail",
        message: h.credentialsChecked
          ? h.credentialsValid ? "Credentials valid" : `Credentials invalid: ${h.credentialError}`
          : h.credentialsValid ? "Local provider configuration present; live credential check skipped" : `Local provider configuration incomplete: ${h.credentialError}`,
      });
    }
  }

  // 5. Domains
  const domainCounts = d.query(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN dkim_status = 'verified' THEN 1 ELSE 0 END), 0) AS verified
     FROM domains`,
  ).get() as { total: unknown; verified: unknown };
  const domains = countValue(domainCounts.total);
  const verifiedDomains = countValue(domainCounts.verified);
  checks.push({
    name: "Domains",
    status: verifiedDomains === domains && domains > 0 ? "pass" : "warn",
    message: `${verifiedDomains}/${domains} domains verified`,
  });

  // 6. Addresses
  const addressCounts = d.query("SELECT COUNT(*) AS total FROM addresses").get() as { total: unknown };
  const addresses = countValue(addressCounts.total);
  checks.push({ name: "Addresses", status: addresses > 0 ? "pass" : "warn", message: `${addresses} sender address(es)` });

  // 6b. SES sandbox / production access (best-effort; needs AWS creds)
  if (process.env["AWS_ACCESS_KEY_ID"] || process.env["AWS_PROFILE"]) {
    try {
      const { getSandboxStatus, describeSandboxStatus } = await import("./ses-sandbox.js");
      const status = await getSandboxStatus({ region: process.env["AWS_REGION"] ?? "us-east-1" });
      checks.push({
        name: "SES Sending",
        status: status.sendingEnabled ? "pass" : "fail",
        message: describeSandboxStatus(status),
      });
    } catch {
      // no creds / not reachable — skip silently
    }
  }

  // 6c. Provisioning credentials (AWS / Cloudflare / Resend)
  const { checkProvisionCredentials } = await import("./provision-creds.js");
  const config = loadConfig();
  const hasStoredAwsProviderCredentials = providers.some((provider) =>
    provider.type === "ses" && !!provider.access_key && !!provider.secret_key
  );
  for (const c of checkProvisionCredentials(undefined, {
    aws_provider_credentials: hasStoredAwsProviderCredentials,
    cloudflare_api_token: config["cloudflare_api_token"] as string | undefined,
    cloudflare_api_key: config["cloudflare_api_key"] as string | undefined,
    cloudflare_email: config["cloudflare_email"] as string | undefined,
    cloudflare_account_id: config["cloudflare_account_id"] as string | undefined,
  })) {
    checks.push({
      name: `Provisioning: ${c.provider}`,
      status: c.status ?? (c.configured ? "pass" : c.provider === "resend" ? "warn" : "fail"),
      message: c.detail,
    });
  }

  // 7. Contacts
  const contactCounts = d.query(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN suppressed = 1 THEN 1 ELSE 0 END), 0) AS suppressed
     FROM contacts`,
  ).get() as { total: unknown; suppressed: unknown };
  const contacts = countValue(contactCounts.total);
  const suppressed = countValue(contactCounts.suppressed);
  checks.push({
    name: "Contacts",
    status: suppressed > 0 ? "warn" : "pass",
    message: `${contacts} contacts (${suppressed} suppressed)`,
  });

  // 8. Templates
  const templateCounts = d.query("SELECT COUNT(*) AS total FROM templates").get() as { total: unknown };
  const templates = countValue(templateCounts.total);
  checks.push({ name: "Templates", status: "pass", message: `${templates} template(s)` });

  // 9. Gmail OAuth status
  const gmailProviders = providers.filter((p) => p.type === "gmail");
  for (const p of gmailProviders) {
    if (!p.oauth_refresh_token) {
      checks.push({ name: `Gmail: ${p.name}`, status: "fail", message: "No refresh token - run 'mailery provider auth <id>'" });
      continue;
    }

    const expiryStatus = (() => {
      if (!p.oauth_token_expiry) return { status: "warn" as const, message: "Token expiry unknown — will refresh on next use" };
      const expiry = new Date(p.oauth_token_expiry).getTime();
      const now = Date.now();
      if (expiry < now) return { status: "warn" as const, message: `Access token expired (${p.oauth_token_expiry}) — will auto-refresh` };
      const minsLeft = Math.round((expiry - now) / 60000);
      return { status: "pass" as const, message: `Access token valid (~${minsLeft}min remaining)` };
    })();

    if (opts.liveProviderChecks !== true) {
      checks.push({
        name: `Gmail: ${p.name}`,
        status: expiryStatus.status,
        message: `${expiryStatus.message}; live auth check skipped`,
      });
      continue;
    }

    // Live check via connectors SDK
    try {
      const meResult = await (opts.gmailAuthCheck ?? runGmailAuthCheck)();
      if (!meResult.success) throw new Error(meResult.stderr || meResult.stdout);
      let emailAddress = "";
      try {
        const me = JSON.parse(meResult.stdout) as { emailAddress?: string };
        emailAddress = me.emailAddress ?? "";
      } catch {
        const match = meResult.stdout.match(/emailAddress[:\s]+([^\s,}]+)/);
        if (match?.[1]) emailAddress = match[1];
      }
      checks.push({
        name: `Gmail: ${p.name}`,
        status: "pass",
        message: `Authenticated${emailAddress ? ` as ${emailAddress}` : ""} (${expiryStatus.message})`,
      });
    } catch (e) {
      checks.push({
        name: `Gmail: ${p.name}`,
        status: "fail",
        message: `Auth failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return checks;
}
