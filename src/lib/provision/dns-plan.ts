/**
 * DNS plan — the single source of truth for the exact set of DNS records a
 * domain needs, given its send provider and receive strategy. PURE, no I/O.
 *
 * The orchestrator publishes these records into Cloudflare (always our DNS).
 * Records with `managedBy: "cloudflare-routing"` are owned by the Cloudflare
 * Email Routing API instead of plain DNS writes, and are surfaced here only for
 * visibility — the routing module publishes them.
 *
 * Record values (2026, verified against AWS docs):
 *   DKIM (Easy DKIM)   CNAME <token>._domainkey.<domain> -> <token>.dkim.amazonses.com
 *   MAIL FROM MX       MX    mail.<domain>  10 feedback-smtp.<region>.amazonses.com
 *   MAIL FROM SPF      TXT   mail.<domain>  v=spf1 include:amazonses.com ~all
 *   DMARC              TXT   _dmarc.<domain> v=DMARC1; p=none; rua=mailto:dmarc@<domain>
 *   Inbound (ses-s3)   MX    <domain>       10 inbound-smtp.<region>.amazonaws.com
 */

export type SendProvider = "ses" | "resend";
export type ReceiveStrategy = "ses-s3" | "cf-routing" | "resend-webhook";

export type RecordPurpose =
  | "dkim"
  | "spf"
  | "dmarc"
  | "mail_from_mx"
  | "mail_from_spf"
  | "inbound_mx"
  | "resend_spf"
  | "resend_dkim"
  | "resend_mx"
  | "cf_routing_mx"
  | "cf_routing_spf";

export interface PlannedRecord {
  type: "CNAME" | "TXT" | "MX";
  name: string;
  content: string;
  priority?: number;
  purpose: RecordPurpose;
  /** Who publishes it: plain Cloudflare DNS, or the Cloudflare Email Routing API. */
  managedBy: "cloudflare" | "cloudflare-routing";
}

export interface DnsPlanInput {
  domain: string;
  region?: string;
  sendProvider: SendProvider;
  receiveStrategy: ReceiveStrategy;
  /** Required (exactly 3) when sendProvider === "ses". */
  dkimTokens?: string[];
  /** Defaults to `mail.<domain>`. */
  mailFromDomain?: string;
  /** Defaults to `dmarc@<domain>`. */
  dmarcRua?: string;
  /** Provider-returned records when sendProvider === "resend". */
  resendRecords?: PlannedRecord[];
}

export function buildDnsPlan(input: DnsPlanInput): PlannedRecord[] {
  const {
    domain,
    region = "us-east-1",
    sendProvider,
    receiveStrategy,
    dkimTokens = [],
    mailFromDomain = `mail.${domain}`,
    dmarcRua = `dmarc@${domain}`,
    resendRecords = [],
  } = input;

  const records: PlannedRecord[] = [];

  // ── Sending ──────────────────────────────────────────────────────────────
  if (sendProvider === "ses") {
    if (dkimTokens.length !== 3) {
      throw new Error(
        `SES Easy DKIM requires exactly 3 DKIM tokens, got ${dkimTokens.length}`,
      );
    }
    for (const token of dkimTokens) {
      records.push({
        type: "CNAME",
        name: `${token}._domainkey.${domain}`,
        content: `${token}.dkim.amazonses.com`,
        purpose: "dkim",
        managedBy: "cloudflare",
      });
    }
    // Custom MAIL FROM (improves alignment): MX + SPF on the mail-from subdomain.
    records.push({
      type: "MX",
      name: mailFromDomain,
      content: `feedback-smtp.${region}.amazonses.com`,
      priority: 10,
      purpose: "mail_from_mx",
      managedBy: "cloudflare",
    });
    records.push({
      type: "TXT",
      name: mailFromDomain,
      content: "v=spf1 include:amazonses.com ~all",
      purpose: "mail_from_spf",
      managedBy: "cloudflare",
    });
    // DMARC (relaxed monitoring policy by default).
    records.push({
      type: "TXT",
      name: `_dmarc.${domain}`,
      content: `v=DMARC1; p=none; rua=mailto:${dmarcRua}`,
      purpose: "dmarc",
      managedBy: "cloudflare",
    });
  } else if (sendProvider === "resend") {
    // Resend returns the precise records to publish; pass them through verbatim.
    records.push(...resendRecords);
  }

  // ── Receiving ────────────────────────────────────────────────────────────
  if (receiveStrategy === "ses-s3") {
    // Inbound mail for the whole domain lands on SES → S3 (root MX).
    records.push({
      type: "MX",
      name: domain,
      content: `inbound-smtp.${region}.amazonaws.com`,
      priority: 10,
      purpose: "inbound_mx",
      managedBy: "cloudflare",
    });
  }
  // cf-routing: the Cloudflare Email Routing API owns the root MX + SPF, so we
  // intentionally emit nothing here (the routing module publishes them).
  // resend-webhook: MX is configured against the Resend-supplied inbound host,
  // which is included in `resendRecords` when applicable.

  return records;
}
