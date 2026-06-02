import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import { listProviders } from "../db/providers.js";
import { listDomains } from "../db/domains.js";
import { listAddresses } from "../db/addresses.js";
import { listContacts } from "../db/contacts.js";
import { listTemplates } from "../db/templates.js";
import { checkAllProviders } from "./health.js";
import { existsSync } from "fs";
import { join } from "path";
import type { Database } from "../db/database.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export async function runDiagnostics(db?: Database): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. DB accessible
  try {
    const d = db || getDatabase();
    d.query("SELECT 1").get();
    checks.push({ name: "Database", status: "pass", message: "SQLite database accessible" });
  } catch (e) {
    checks.push({ name: "Database", status: "fail", message: `Database error: ${e}` });
  }

  // 2. Config file
  const { getDataDir } = await import("../db/database.js");
  const configPath = join(getDataDir(), "config.json");
  checks.push(
    existsSync(configPath)
      ? { name: "Config", status: "pass", message: "Config file exists" }
      : { name: "Config", status: "warn", message: "No config file (run 'emails config set' to create)" },
  );

  // 3. Providers
  const providers = listProviders(db);
  checks.push(
    providers.length > 0
      ? { name: "Providers", status: "pass", message: `${providers.length} provider(s) configured` }
      : { name: "Providers", status: "warn", message: "No providers configured" },
  );

  // 4. Provider health
  if (providers.length > 0) {
    const health = await checkAllProviders(db);
    for (const h of health) {
      checks.push({
        name: `Provider: ${h.provider.name}`,
        status: h.status === "healthy" ? "pass" : h.status === "warning" ? "warn" : "fail",
        message: h.credentialsValid ? "Credentials valid" : `Credentials invalid: ${h.credentialError}`,
      });
    }
  }

  // 5. Domains
  const domains = listDomains(undefined, db);
  const verifiedDomains = domains.filter((d) => d.dkim_status === "verified");
  checks.push({
    name: "Domains",
    status: verifiedDomains.length === domains.length && domains.length > 0 ? "pass" : "warn",
    message: `${verifiedDomains.length}/${domains.length} domains verified`,
  });

  // 6. Addresses
  const addresses = listAddresses(undefined, db);
  checks.push({ name: "Addresses", status: addresses.length > 0 ? "pass" : "warn", message: `${addresses.length} sender address(es)` });

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
  for (const c of checkProvisionCredentials()) {
    checks.push({
      name: `Provisioning: ${c.provider}`,
      status: c.configured ? "pass" : c.provider === "resend" ? "warn" : "fail",
      message: c.detail,
    });
  }

  // 7. Contacts
  const contacts = listContacts(undefined, db);
  const suppressed = listContacts({ suppressed: true }, db);
  checks.push({
    name: "Contacts",
    status: suppressed.length > 0 ? "warn" : "pass",
    message: `${contacts.length} contacts (${suppressed.length} suppressed)`,
  });

  // 8. Templates
  const templates = listTemplates(db);
  checks.push({ name: "Templates", status: "pass", message: `${templates.length} template(s)` });

  // 9. Gmail OAuth status
  const gmailProviders = providers.filter((p) => p.type === "gmail");
  for (const p of gmailProviders) {
    if (!p.oauth_refresh_token) {
      checks.push({ name: `Gmail: ${p.name}`, status: "fail", message: "No refresh token — run 'emails provider auth <id>'" });
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

    // Live check via connectors SDK
    try {
      const { runConnectorCommand } = await import("@hasna/connectors");
      const meResult = await runConnectorCommand("gmail", ["-f", "json", "me"]);
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

export function formatDiagnostics(checks: DoctorCheck[]): string {
  const icons = { pass: chalk.green("\u2713"), warn: chalk.yellow("\u26A0"), fail: chalk.red("\u2717") };
  let output = chalk.bold("\n  Email System Diagnostics\n\n");
  for (const check of checks) {
    output += `  ${icons[check.status]} ${check.name}: ${check.message}\n`;
  }
  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  output += `\n  ${chalk.bold("Summary:")} ${chalk.green(passed + " passed")}`;
  if (warned) output += ` ${chalk.yellow(warned + " warnings")}`;
  if (failed) output += ` ${chalk.red(failed + " failed")}`;
  output += "\n";
  return output;
}
