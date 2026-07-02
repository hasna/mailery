import type { Domain } from "../types/index.js";
import { getInboundBuckets } from "./config.js";
import type { DomainReadinessSignals } from "./domain-readiness.js";
import type { MaileryModeResolution } from "./mode.js";
import { listLiveS3Sources, type S3MailSource } from "./s3-sync.js";

function normalizedPrefix(value: string | undefined): string {
  return String(value ?? "").trim().replace(/^\/+/, "").replace(/\/?$/, "/");
}

export function listDomainLiveS3Sources(domain: Domain, sources: S3MailSource[] = listLiveS3Sources()): S3MailSource[] {
  const expectedPrefix = `inbound/${domain.domain.toLowerCase()}/`;
  return sources.filter((source) => {
    if (source.provider_id && source.provider_id !== domain.provider_id) return false;
    return normalizedPrefix(source.prefix).toLowerCase() === expectedPrefix;
  });
}

export function domainInboundReadinessSignals(domain: Domain, mode: MaileryModeResolution): DomainReadinessSignals {
  const selfHostedSource = domain.source_of_truth === "postgres" || (mode.mode === "self_hosted" && domain.source_of_truth !== "local" && domain.source_of_truth !== "cloud");
  if (!selfHostedSource) {
    return {
      mode: mode.mode,
      source_of_truth: domain.source_of_truth,
      inbound_status: domain.inbound_status,
    };
  }
  const sources = listDomainLiveS3Sources(domain);
  const buckets = getInboundBuckets().filter((bucket) => !bucket.providerId || bucket.providerId === domain.provider_id);
  return {
    mode: mode.mode,
    source_of_truth: domain.source_of_truth,
    inbound_status: domain.inbound_status,
    live_s3_sources: sources.length,
    inbound_buckets: buckets.length,
  };
}
