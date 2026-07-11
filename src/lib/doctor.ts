import { getDatabase } from "../db/database.js";
import { listProviders } from "../db/providers.js";
import { countValue } from "../db/scalars.js";
import { checkAllProviders } from "./health.js";
import { loadConfig } from "./config.js";
import { resolveEmailsMode } from "./mode.js";
import { existsSync } from "fs";
import { join } from "path";
import type { Database } from "../db/database.js";
import type { DoctorCheck } from "./diagnostics-format.js";

export { formatDiagnostics } from "./diagnostics-format.js";
export type { DoctorCheck } from "./diagnostics-format.js";

export interface DiagnosticsOptions {
  liveProviderChecks?: boolean;
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
  const mode = resolveEmailsMode();
  checks.push({
    name: "Mode",
    status: mode.warning ? "warn" : "pass",
    message: mode.warning ?? `${mode.label} mode (${mode.mode})`,
  });
  checks.push(
    existsSync(configPath)
      ? { name: "Config", status: "pass", message: "Config file exists" }
      : { name: "Config", status: "warn", message: "No config file (run 'emails config set' to create)" },
  );

  // 3. Providers
  const providers = listProviders(d);
  if (mode.mode === "self_hosted") {
    checks.push({ name: "Providers", status: "pass", message: "Self-hosted provider configuration is owned by the deployment operator" });
  } else {
    checks.push(
      providers.length > 0
        ? {
            name: "Providers",
            status: "pass",
            message: `${providers.length} provider(s) configured`,
          }
        : {
            name: "Providers",
            status: "warn",
            message: "No providers configured",
          },
    );
  }

  // 4. Provider health
  if (mode.mode !== "self_hosted" && providers.length > 0) {
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

  return checks;
}
