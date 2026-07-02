import type { Domain, DomainRouteStatus, DomainSourceOfTruth } from "../types/index.js";
import type { DomainProvisioning } from "../db/provisioning.js";

export type DomainReadinessState =
  | "ready_to_send_and_receive"
  | "ready_to_send"
  | "ready_to_receive"
  | "needs_dns"
  | "broken";

export interface DomainReadiness {
  state: DomainReadinessState;
  send_ready: boolean;
  receive_ready: boolean;
  inbound_evidence_ready: boolean;
  ready_addresses: number;
  inbound_evidence: {
    mode?: "local" | "self_hosted" | "cloud";
    source_of_truth?: DomainSourceOfTruth;
    inbound_status?: DomainRouteStatus;
    live_s3_sources: number;
    inbound_buckets: number;
  };
  issues: string[];
  fix_commands: string[];
}

export interface DomainReadinessSignals {
  ready_addresses?: number;
  mode?: "local" | "self_hosted" | "cloud";
  source_of_truth?: DomainSourceOfTruth;
  inbound_status?: DomainRouteStatus;
  live_s3_sources?: number;
  inbound_buckets?: number;
}

function ok(status: string | null | undefined): boolean {
  return status === "verified";
}

function bad(status: string | null | undefined): boolean {
  return status === "failed";
}

export function assessDomainReadiness(
  domain: Pick<Domain, "domain" | "dkim_status" | "spf_status" | "dmarc_status"> & Partial<Pick<Domain, "inbound_status" | "source_of_truth">>,
  provisioning?: DomainProvisioning | null,
  signals: DomainReadinessSignals = {},
): DomainReadiness {
  const issues: string[] = [];
  const fix_commands: string[] = [];
  const readyAddresses = signals.ready_addresses ?? 0;
  const inboundStatus = signals.inbound_status ?? domain.inbound_status;
  const sourceOfTruth = signals.source_of_truth ?? domain.source_of_truth;
  const mode = signals.mode;
  const liveS3Sources = signals.live_s3_sources ?? 0;
  const inboundBuckets = signals.inbound_buckets ?? 0;
  const selfHostedSource = sourceOfTruth === "postgres" || (mode === "self_hosted" && sourceOfTruth !== "local" && sourceOfTruth !== "cloud");
  const cloudSource = sourceOfTruth === "cloud" || (mode === "cloud" && sourceOfTruth !== "local" && sourceOfTruth !== "postgres");
  const inboundEvidenceReady = selfHostedSource ? liveS3Sources > 0 : true;
  const inboundLifecycleReady = inboundStatus === "ready";
  const provisioningReceiveReady = provisioning?.provisioning_status === "ready" || provisioning?.provisioning_status === "inbound_ready";

  if (!ok(domain.dkim_status)) issues.push(`DKIM ${domain.dkim_status}`);
  if (!ok(domain.spf_status)) issues.push(`SPF ${domain.spf_status}`);
  if (!ok(domain.dmarc_status)) issues.push(`DMARC ${domain.dmarc_status}`);
  if (selfHostedSource && !inboundLifecycleReady) issues.push(`Inbound ${inboundStatus ?? "pending"}`);
  if (selfHostedSource && !inboundEvidenceReady) issues.push("No live SES/S3 inbound source");
  if (bad(domain.dkim_status) || bad(domain.spf_status) || provisioning?.last_error) {
    if (provisioning?.last_error) issues.push(provisioning.last_error);
    fix_commands.push(`mailery domain check ${domain.domain}`);
    fix_commands.push(`mailery domain setup-cloudflare ${domain.domain}`);
    return {
      state: "broken",
      send_ready: false,
      receive_ready: selfHostedSource ? inboundLifecycleReady && inboundEvidenceReady : readyAddresses > 0,
      inbound_evidence_ready: inboundEvidenceReady,
      ready_addresses: readyAddresses,
      inbound_evidence: {
        mode,
        source_of_truth: sourceOfTruth,
        inbound_status: inboundStatus,
        live_s3_sources: liveS3Sources,
        inbound_buckets: inboundBuckets,
      },
      issues,
      fix_commands,
    };
  }

  const sendReady = ok(domain.dkim_status) && ok(domain.spf_status);
  const receiveReady = selfHostedSource
    ? inboundLifecycleReady && inboundEvidenceReady
    : cloudSource
      ? inboundLifecycleReady
      : inboundLifecycleReady || readyAddresses > 0 || provisioningReceiveReady;

  if (!sendReady) {
    fix_commands.push(`mailery domain dns ${domain.domain}`);
    fix_commands.push(`mailery domain verify ${domain.domain}`);
  }
  if (!receiveReady) {
    if (selfHostedSource && !inboundEvidenceReady) {
      fix_commands.push(`mailery domain adopt ${domain.domain} --provider <provider>`);
      fix_commands.push(`mailery inbox sync-s3 --source <source-id>`);
    } else {
      fix_commands.push(`mailery domain check ${domain.domain}`);
      fix_commands.push(`mailery provision domain ${domain.domain} --provider <provider> --dry-run`);
    }
  }

  let state: DomainReadinessState;
  if (sendReady && receiveReady) state = "ready_to_send_and_receive";
  else if (sendReady) state = "ready_to_send";
  else if (receiveReady) state = "ready_to_receive";
  else state = "needs_dns";

  return {
    state,
    send_ready: sendReady,
    receive_ready: receiveReady,
    inbound_evidence_ready: inboundEvidenceReady,
    ready_addresses: readyAddresses,
    inbound_evidence: {
      mode,
      source_of_truth: sourceOfTruth,
      inbound_status: inboundStatus,
      live_s3_sources: liveS3Sources,
      inbound_buckets: inboundBuckets,
    },
    issues,
    fix_commands,
  };
}

export function formatDomainReadinessState(state: DomainReadinessState): string {
  return state.replace(/_/g, " ");
}
