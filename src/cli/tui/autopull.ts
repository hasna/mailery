/**
 * Background auto-pull for the TUI — the "daemon" half, across every provider:
 *   • SES   — drain real-time SES→SNS→SQS and/or dedup-safe scan of each inbound
 *             S3 bucket (buckets can be in different AWS accounts).
 *   • Gmail — incremental sync of the newest messages for each active Gmail
 *             account (via its connector profile).
 *   • Resend — inbound is push (webhook to `emails serve`), so there's nothing to
 *             pull here; it lands the moment the server receives it.
 * Entirely best-effort: missing config/creds/connector-auth is a silent no-op.
 */
export interface PullResult { pulled: number; ok: boolean; reason?: string; configured: boolean }
export interface PullOpts { s3?: boolean; gmail?: boolean; limit?: number }

export async function autoPull(opts?: PullOpts): Promise<PullResult> {
  const doS3 = opts?.s3 !== false;
  const doGmail = opts?.gmail === true;
  const limit = opts?.limit ?? 100;
  const { getInboundConfig, getInboundBuckets, loadConfig } = await import("../../lib/config.js");
  const inbound = getInboundConfig();
  const buckets = getInboundBuckets();
  const config = loadConfig();
  const queueUrl = config["inbound_realtime_queue_url"] as string | undefined;
  const configured = buckets.length > 0 || Boolean(queueUrl);

  let pulled = 0;
  let reason: string | undefined;
  let ok = true;

  if (doS3) {
    try {
      const { syncS3Inbox } = await import("../../lib/s3-sync.js");
      const { getProvider } = await import("../../db/providers.js");
      if (inbound.profile) process.env["AWS_PROFILE"] = inbound.profile;
      const syncAll = async () => {
        let n = 0;
        for (const b of buckets) {
          const prov = b.providerId ? getProvider(b.providerId) : null;
          const r = await syncS3Inbox({
            bucket: b.bucket, prefix: inbound.prefix, region: b.region,
            accessKeyId: prov?.access_key ?? undefined,
            secretAccessKey: prov?.secret_key ?? undefined,
            limit,
          });
          n += r.synced;
        }
        return n;
      };
      // Always do a full dedup-safe scan of every bucket — this catches mail for
      // EVERY domain regardless of realtime wiring. (A previous version only
      // scanned S3 when the realtime SQS queue had messages; since that queue is
      // wired for one domain, mail to every other domain was never auto-pulled.)
      if (buckets.length > 0) {
        pulled += await syncAll();
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

  if (doGmail) {
    try { pulled += await pullGmail(); }
    catch (e) { if (ok) { ok = false; reason = e instanceof Error ? e.message : String(e); } }
  }

  return { pulled, ok, reason, configured: configured || doGmail };
}

/** Incremental sync of the newest messages for each active Gmail account. */
async function pullGmail(): Promise<number> {
  const { listActiveProviderSummaries } = await import("../../db/providers.js");
  const { syncGmailInbox } = await import("../../lib/gmail-sync.js");
  const gmails = listActiveProviderSummaries("gmail");
  let n = 0;
  for (const p of gmails) {
    // Provider name "Gmail (andreihasnacom)" → connector profile "andreihasnacom".
    const profile = p.name.match(/\(([^)]+)\)/)?.[1];
    try {
      const r = await syncGmailInbox({ providerId: p.id, profile, labelFilter: "INBOX", batchSize: 25, maxMessages: 25, downloadAttachments: true });
      n += r.synced;
    } catch { /* connector not authed here / transient — best-effort */ }
  }
  return n;
}
