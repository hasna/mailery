import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../db/providers.js";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createDomain, updateDnsStatus, updateDomainReadiness } from "../db/domains.js";
import { registerS3Source } from "./s3-sync.js";
import {
  buildDomainLifecycleSummary,
  enableDomainInboundReadiness,
  enableDomainOutboundReadiness,
  listDomainLifecycleSummaries,
} from "./domain-readiness-service.js";

let tempHome = "";
let previousHome: string | undefined;
let previousMode: string | undefined;

beforeEach(() => {
  previousHome = process.env["HOME"];
  previousMode = process.env["MAILERY_MODE"];
  tempHome = mkdtempSync(join(tmpdir(), "mailery-readiness-service-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["MAILERY_MODE"] = "self_hosted";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (previousMode === undefined) delete process.env["MAILERY_MODE"];
  else process.env["MAILERY_MODE"] = previousMode;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("domain readiness service", () => {
  it("exposes typed lifecycle summaries and self-hosted inbound evidence gates", () => {
    const provider = createProvider({ name: "SES", type: "ses", region: "us-east-1" });
    const domain = updateDomainReadiness(
      createDomain(provider.id, "example.com").id,
      { source_of_truth: "postgres", domain_type: "self_hosted" },
    );
    const verified = updateDnsStatus(domain.id, "verified", "verified", "pending");

    const before = buildDomainLifecycleSummary(verified);
    expect(before.provider).toMatchObject({ id: provider.id, name: "SES", type: "ses" });
    expect(before.readiness.send_ready).toBe(true);
    expect(before.readiness.receive_ready).toBe(false);
    expect(before.readiness.inbound_evidence_ready).toBe(false);
    expect(before.next_actions).toContain("mailery domain adopt example.com --provider <provider>");

    expect(() => enableDomainInboundReadiness(domain.id)).toThrow("Inbound cloud source is not configured");

    registerS3Source({
      bucket: "mailery-inbound",
      prefix: "inbound/example.com/",
      region: "us-east-1",
      providerId: provider.id,
      status: "live",
      liveSyncEnabled: true,
    });

    const enabled = enableDomainInboundReadiness(domain.id);
    expect(enabled.before.readiness.receive_ready).toBe(false);
    expect(enabled.after.readiness.receive_ready).toBe(true);
    expect(enabled.after.readiness.inbound_evidence.live_s3_sources).toBe(1);
    expect(enabled.after.provisioning?.provisioning_status).toBe("inbound_ready");

    const summaries = listDomainLifecycleSummaries({ provider_id: provider.id });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: domain.id,
      domain: "example.com",
      source_of_truth: "postgres",
      readiness: { send_ready: true, receive_ready: true },
    });
  });

  it("guards outbound readiness unless DKIM and SPF are verified", () => {
    const provider = createProvider({ name: "SES", type: "ses", region: "us-east-1" });
    const domain = updateDomainReadiness(
      createDomain(provider.id, "blocked.example.com").id,
      { source_of_truth: "postgres", domain_type: "self_hosted" },
    );

    expect(() => enableDomainOutboundReadiness(domain.id)).toThrow("Outbound is not verified");

    const verified = updateDnsStatus(domain.id, "verified", "verified", "verified");
    const summary = buildDomainLifecycleSummary(verified);
    expect(summary.readiness.send_ready).toBe(true);

    const enabled = enableDomainOutboundReadiness(domain.id);
    expect(enabled.after.outbound_status).toBe("ready");
    expect(enabled.after.readiness.outbound_ready).toBe(true);
    expect(enabled.after.provisioning?.provisioning_status).toBe("verified");
  });
});
