/**
 * Provisioning credential status (mailery) — reports whether usable
 * credentials are present for each provisioning provider, across all supported
 * auth modes. Pure (env injected); surfaced by
 * `mailery doctor`.
 */

import { resolveCloudflareAuth, describeCloudflareAuth } from "./cloudflare-auth.js";

export interface ProvisionCredStatus {
  provider: string;
  configured: boolean;
  status?: "pass" | "warn" | "fail";
  detail: string;
}

export interface ProvisionCredConfig {
  aws_provider_credentials?: boolean;
  cloudflare_api_token?: string;
  cloudflare_api_key?: string;
  cloudflare_email?: string;
  cloudflare_account_id?: string;
}

export function checkProvisionCredentials(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  config: ProvisionCredConfig = {},
): ProvisionCredStatus[] {
  const out: ProvisionCredStatus[] = [];

  // AWS (SES send/inbound + Route53 buy via @hasna/domains), us-east-1.
  const hasEnvAws = !!(env["AWS_ACCESS_KEY_ID"] && env["AWS_SECRET_ACCESS_KEY"]) || !!env["AWS_PROFILE"];
  const hasStoredSesProviderCredentials = !!config.aws_provider_credentials;
  out.push({
    provider: "aws",
    configured: hasEnvAws || hasStoredSesProviderCredentials,
    status: hasEnvAws ? "pass" : hasStoredSesProviderCredentials ? "warn" : "fail",
    detail: hasEnvAws
      ? `${env["AWS_PROFILE"] ? `profile:${env["AWS_PROFILE"]}` : "access-keys"} (us-east-1 for SES inbound + Route53)`
      : hasStoredSesProviderCredentials
        ? "Stored SES provider credentials found for SES send/inbound; set AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET for Route53/domain purchase workflows"
      : "Set AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET",
  });

  // Cloudflare (DNS + Email Routing).
  const cf = resolveCloudflareAuth({
    env,
    configToken: config.cloudflare_api_token,
    configApiKey: config.cloudflare_api_key,
    configEmail: config.cloudflare_email,
  });
  const cfAccountId = env["CLOUDFLARE_ACCOUNT_ID"] ?? config.cloudflare_account_id;
  out.push({
    provider: "cloudflare",
    configured: !!cf,
    status: cf ? cfAccountId ? "pass" : "warn" : "fail",
    detail: cf ? describeCloudflareAuth(cf) + (cfAccountId ? " (+account)" : " (no account id — zone create needs it)") : "Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL",
  });

  // Resend (optional secondary send + inbound webhook).
  const resend = !!env["RESEND_API_KEY"];
  out.push({
    provider: "resend",
    configured: resend,
    detail: resend ? "key present" : "optional — set RESEND_API_KEY for Resend send/inbound",
  });

  return out;
}
