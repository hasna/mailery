/**
 * Provisioning credential status (open-emails) — reports whether usable
 * credentials are present for each provisioning provider, across all supported
 * auth modes incl. HASNAXYZ vault env names. Pure (env injected); surfaced by
 * `emails doctor`.
 */

import { resolveCloudflareAuth, describeCloudflareAuth } from "./cloudflare-auth.js";

export interface ProvisionCredStatus {
  provider: string;
  configured: boolean;
  detail: string;
}

export function checkProvisionCredentials(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ProvisionCredStatus[] {
  const out: ProvisionCredStatus[] = [];

  // AWS (SES send/inbound + Route53 buy via @hasna/domains), us-east-1.
  const hasAws = !!(env["AWS_ACCESS_KEY_ID"] && env["AWS_SECRET_ACCESS_KEY"]) || !!env["AWS_PROFILE"];
  out.push({
    provider: "aws",
    configured: hasAws,
    detail: hasAws ? `${env["AWS_PROFILE"] ? `profile:${env["AWS_PROFILE"]}` : "access-keys"} (us-east-1 for SES inbound + Route53)` : "Set AWS_PROFILE or AWS_ACCESS_KEY_ID/SECRET",
  });

  // Cloudflare (DNS + Email Routing).
  const cf = resolveCloudflareAuth({ env });
  out.push({
    provider: "cloudflare",
    configured: !!cf,
    detail: cf ? describeCloudflareAuth(cf) + (env["CLOUDFLARE_ACCOUNT_ID"] || env["HASNAXYZ_CLOUDFLARE_LIVE_ACCOUNT_ID"] ? " (+account)" : " (no account id — zone create needs it)") : "Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL",
  });

  // Resend (optional secondary send + inbound webhook).
  const resend = !!(env["RESEND_API_KEY"] || env["HASNATOOLS_TODOS_EMAIL_LIVE_RESEND_API_KEY"]);
  out.push({
    provider: "resend",
    configured: resend,
    detail: resend ? "key present" : "optional — set RESEND_API_KEY for Resend send/inbound",
  });

  return out;
}
