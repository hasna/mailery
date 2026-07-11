/**
 * Background auto-pull for the TUI:
 *   • SES   — drain real-time SES→SNS→SQS and/or dedup-safe scan of each inbound
 *             S3 bucket (buckets can be in different AWS accounts).
 *   • Resend — inbound is push (webhook to `emails serve`), so there's nothing to
 *             pull here; it lands the moment the server receives it.
 * Entirely best-effort: missing config/creds is a silent no-op.
 */
import { buildS3PullTargets } from "./autopull-targets.js";
export { buildS3PullTargets } from "./autopull-targets.js";
export type { S3PullTarget } from "./autopull-targets.js";

export interface PullForwardingResult { attempted: number; sent: number; failed: number; skipped: number }
export interface PullResult { pulled: number; ok: boolean; reason?: string; configured: boolean; forwarded?: PullForwardingResult }
export interface PullOpts { s3?: boolean; limit?: number; forwarding?: boolean }

export async function autoPull(opts?: PullOpts): Promise<PullResult> {
  const doS3 = opts?.s3 !== false;
  const limit = opts?.limit ?? 100;
  const { getInboundConfig, getInboundBuckets, loadConfig } = await import("../../lib/config.js");
  const inbound = getInboundConfig();
  const buckets = getInboundBuckets();
  const config = loadConfig();
  const queueUrl = config["inbound_realtime_queue_url"] as string | undefined;
  const { listLiveS3Sources } = await import("../../lib/s3-sync.js");
  const liveSources = listLiveS3Sources();
  const targets = buildS3PullTargets({ liveSources, buckets, inboundPrefix: inbound.prefix });
  const configured = targets.length > 0 || Boolean(queueUrl);

  let pulled = 0;
  let reason: string | undefined;
  let ok = true;
  const syncErrors: string[] = [];

  if (doS3) {
    try {
      const { syncS3Inbox } = await import("../../lib/s3-sync.js");
      const { getProvider } = await import("../../db/providers.js");
      if (inbound.profile) process.env["AWS_PROFILE"] = inbound.profile;
      const syncAll = async () => {
        let n = 0;
        for (const target of targets) {
          const prov = target.providerId ? getProvider(target.providerId) : null;
          const r = await syncS3Inbox({
            sourceId: target.sourceId,
            bucket: target.bucket,
            prefix: target.prefix,
            region: target.region,
            accessKeyId: prov?.access_key ?? undefined,
            secretAccessKey: prov?.secret_key ?? undefined,
            providerId: target.providerId,
            limit,
          });
          n += r.synced;
          if (r.errors.length > 0) syncErrors.push(...r.errors);
        }
        return n;
      };
      // Always do a full dedup-safe scan of every bucket — this catches mail for
      // EVERY domain regardless of realtime wiring. (A previous version only
      // scanned S3 when the realtime SQS queue had messages; since that queue is
      // wired for one domain, mail to every other domain was never auto-pulled.)
      if (targets.length > 0) {
        pulled += await syncAll();
        if (syncErrors.length > 0) {
          ok = false;
          reason = syncErrors[0];
        }
        // Best-effort: drain the realtime SQS queue so it doesn't back up. The
        // objects it points to are already covered by the scan above, so we just
        // clear it (no extra sync needed).
        if (queueUrl) {
          try {
            const { makeSqsAdapter } = await import("../../lib/inbound-realtime-aws.js");
            const { watchInboundOnce } = await import("../../lib/inbound-realtime.js");
            const sqs = makeSqsAdapter({ queueUrl, region: inbound.region, waitTimeSeconds: 1 });
            await watchInboundOnce(sqs, queueUrl, async () => ({ synced: 0 }));
          } catch { /* realtime drain is best-effort */ }
        }
      }
    } catch (e) { ok = false; reason = e instanceof Error ? e.message : String(e); }
  }

  let forwarded: PullForwardingResult | undefined;
  if (opts?.forwarding !== false) {
    try {
      const { processForwardingRules } = await import("../../lib/forwarding.js");
      const r = await processForwardingRules({ limit });
      forwarded = {
        attempted: r.attempted,
        sent: r.sent,
        failed: r.failed,
        skipped: r.skipped,
      };
      if (r.failed > 0 && ok) {
        ok = false;
        reason = `Forwarding failed for ${r.failed} message${r.failed === 1 ? "" : "s"}`;
      }
    } catch (e) {
      if (ok) {
        ok = false;
        reason = e instanceof Error ? e.message : String(e);
      }
    }
  }

  return {
    pulled,
    ok,
    reason,
    configured: configured || (forwarded?.attempted ?? 0) > 0,
    forwarded,
  };
}
