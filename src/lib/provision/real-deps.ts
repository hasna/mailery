/**
 * Real provisioning deps — wires the orchestrator's injected DomainDeps /
 * AddressDeps to actual services: @hasna/domains (buy/zone/NS), the SES adapter
 * (identity/MAIL FROM/verify), the direct Cloudflare DNS publish, and SES
 * inbound. Used by the provisioning daemon. No @hasna/connectors.
 *
 * Cross-account note: SES uses the configured SES provider's stored creds
 * (alumia); Cloudflare uses env auth; Route53 NS delegation uses the ambient AWS
 * env (run the daemon with the registrar account's profile). Steps already done
 * (zone exists, NS delegated, verified) are detected and skipped.
 */

import type { Provider } from "../../types/index.js";
import { getAdapter } from "../../providers/index.js";
import { getDomainProvisioning } from "../../db/provisioning.js";
import { listInboundSubjectsForRecipient } from "../../db/inbound.js";
import type { Database } from "../../db/database.js";
import type { DomainDeps, AddressDeps } from "./orchestrator.js";
import { runRoundtrip } from "./roundtrip.js";

const CF_NS_SUFFIX = ".ns.cloudflare.com";

export interface RealDepsOptions {
  provider: Provider;          // SES provider
  inboundBucket: string;
  region?: string;
  addMx?: boolean;
  db?: Database;
}

export function makeDomainDeps(opts: RealDepsOptions): DomainDeps {
  const region = opts.region ?? "us-east-1";
  const adapter = getAdapter(opts.provider);

  return {
    // The domain is bought + delegated by `domains buy` (xyz-infra). Here we
    // only confirm ownership/skip — the daemon focuses on SES setup.
    async buyOrSkip() {
      return { registrar: null };
    },
    async createCfZone(ctx) {
      const { cfEnsureZone } = await import("@hasna/domains");
      const zone = await cfEnsureZone(ctx.domain);
      return { zoneId: zone.id, nameservers: zone.nameservers };
    },
    async delegateNs(ctx) {
      const { r53UpdateNameservers } = await import("@hasna/domains");
      const ns = ctx.provisioning.nameservers;
      if (ns.length) await r53UpdateNameservers(ctx.domain, ns);
    },
    async checkNsPropagation(ctx) {
      try {
        const dns = await import("node:dns");
        const ns = await dns.promises.resolveNs(ctx.domain).catch(() => [] as string[]);
        return { propagated: ns.length > 0 && ns.every((n) => n.includes(CF_NS_SUFFIX)) };
      } catch {
        return { propagated: false };
      }
    },
    async createSesIdentity(ctx) {
      await adapter.addDomain(ctx.domain);
      let mailFromDomain = `mail.${ctx.domain}`;
      if (adapter.setMailFrom) mailFromDomain = await adapter.setMailFrom(ctx.domain);
      const records = await adapter.getDnsRecords(ctx.domain);
      const dkimTokens = records
        .filter((r) => r.type === "CNAME" && r.name.includes("_domainkey"))
        .map((r) => r.name.split(".")[0] ?? "")
        .filter(Boolean);
      return { dkimTokens, mailFromDomain };
    },
    async publishDns(ctx) {
      const { setupEmailDns } = await import("../cloudflare-dns.js");
      const result = await setupEmailDns({ domain: ctx.domain, provider: opts.provider, addMx: !!opts.addMx });
      return { recordsPublished: result.created };
    },
    async checkSesVerification(ctx) {
      const status = await adapter.verifyDomain(ctx.domain);
      return { verified: status.dkim === "verified" };
    },
    async setupInbound(ctx) {
      const { setupInboundEmail } = await import("../aws-inbound.js");
      const r = await setupInboundEmail({ domain: ctx.domain, bucket: opts.inboundBucket, region });
      return { bucket: r.bucket, mxRecord: r.mx_record };
    },
  };
}

export function makeAddressDeps(opts: RealDepsOptions): AddressDeps {
  const region = opts.region ?? "us-east-1";
  const providerId = opts.provider.id;

  return {
    // ses-s3: the domain-level receipt rule already matches every address, so
    // there is nothing per-address to wire. (cf-routing would create a rule.)
    async wireReceive() {
      return { routingRuleId: null };
    },
    async validateRoundtrip(ctx) {
      const domain = ctx.email.split("@")[1]!;
      const prov = getDomainProvisioning(
        // not strictly needed; kept for parity
        ctx.id, opts.db,
      );
      void prov;
      const { sendWithFailover } = await import("../send.js");
      const { syncS3Inbox } = await import("../s3-sync.js");
      const roundtripStartedAt = new Date().toISOString();
      const report = await runRoundtrip(
        {
          send: async ({ from, to, subject, text }) => {
            const r = await sendWithFailover(providerId, { from, to, subject, text, html: `<p>${text}</p>` }, opts.db);
            await new Promise((res) => setTimeout(res, 1100));
            return { messageId: r.messageId };
          },
          fetchReceived: async (mailbox) => {
            await syncS3Inbox({ bucket: opts.inboundBucket, prefix: `inbound/${domain}/`, providerId, limit: 1000, region, db: opts.db });
            const db = opts.db ?? (await import("../../db/database.js")).getDatabase();
            return listInboundSubjectsForRecipient(mailbox, { since: roundtripStartedAt, limit: 100 }, db);
          },
        },
        { addresses: [ctx.email, ctx.email], count: 1, tokenPrefix: `VAL-${Date.now()}`, pollAttempts: 8, pollIntervalMs: 8000 },
      );
      return { validated: report.success };
    },
  };
}
