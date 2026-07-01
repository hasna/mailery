/**
 * Inbound webhook — the push half of real-time inbound. Point an SNS HTTP(S)
 * subscription (on the SES inbound topic) at `POST /webhook/ses-inbound`:
 *   - SubscriptionConfirmation → we fetch SubscribeURL to confirm automatically.
 *   - Notification             → we parse it and run a dedup-safe syncS3Inbox so
 *                                the new message lands in the inbox immediately.
 *
 * No manual `mailery inbox sync-s3` needed. The bucket/region/prefix come from
 * config (inbound_s3_bucket / inbound_s3_region / inbound_s3_prefix).
 */
import { parseSesNotification } from "../../lib/inbound-realtime.js";
import { json, badRequest } from "./helpers.js";
import { getInboundBuckets, loadConfig } from "../../lib/config.js";
import { emitMaileryEventBestEffort } from "../../lib/mailery-events.js";
import { verifySnsStructure } from "../../lib/webhook-events.js";

/** Injected fetch so confirmation is testable. */
export type FetchLike = (url: string) => Promise<unknown>;

/** True only for genuine AWS SNS HTTPS endpoints (host-pinned, anti-SSRF). */
export function isAwsSnsUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname);
}

function configuredWebhookSecret(): string | undefined {
  const config = loadConfig();
  return (config["ses_inbound_webhook_secret"] as string | undefined)
    ?? (config["mailery_inbound_webhook_secret"] as string | undefined)
    ?? process.env["MAILERY_SES_INBOUND_WEBHOOK_SECRET"]
    ?? process.env["EMAILS_SES_INBOUND_WEBHOOK_SECRET"]
    ?? process.env["MAILERY_INBOUND_WEBHOOK_SECRET"];
}

function requireWebhookSecret(): boolean {
  const raw = process.env["MAILERY_REQUIRE_SES_INBOUND_SECRET"]
    ?? process.env["EMAILS_REQUIRE_SES_INBOUND_SECRET"];
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function requestWebhookSecret(req: Request): string | null {
  const direct = req.headers.get("x-mailery-webhook-secret")
    ?? req.headers.get("x-emails-webhook-secret");
  if (direct) return direct;
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export async function handleInboundWebhook(
  req: Request,
  path: string,
  method: string,
  deps?: { fetchUrl?: FetchLike; sync?: (bucket: string, prefix: string | undefined, region: string | undefined, opts?: { keys?: string[]; providerId?: string }) => Promise<{ synced: number }> },
): Promise<Response | null> {
  if (path !== "/webhook/ses-inbound" || method !== "POST") return null;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return badRequest("Invalid JSON"); }

  const secret = configuredWebhookSecret();
  if (secret || requireWebhookSecret()) {
    if (!secret) return json({ error: "SES inbound webhook secret is required but not configured" }, 503);
    if (requestWebhookSecret(req) !== secret) return json({ error: "Invalid webhook secret" }, 401);
  }
  if (!verifySnsStructure(body)) return badRequest("Invalid SNS payload");

  const type = body["Type"] ?? req.headers.get("x-amz-sns-message-type");

  // 1. Auto-confirm the SNS subscription — but only fetch genuine AWS SNS
  //    confirmation URLs (host-pinned to sns.<region>.amazonaws.com over HTTPS)
  //    so a forged body can't turn this into a server-side request forgery.
  if (type === "SubscriptionConfirmation" && typeof body["SubscribeURL"] === "string") {
    if (!isAwsSnsUrl(body["SubscribeURL"] as string)) {
      return badRequest("SubscribeURL is not a valid AWS SNS endpoint");
    }
    const fetchUrl = deps?.fetchUrl ?? (async (u: string) => { await fetch(u); });
    await fetchUrl(body["SubscribeURL"] as string);
    return json({ ok: true, confirmed: true });
  }

  // 2. Process an inbound notification.
  if (type === "Notification" || body["notificationType"] === "Received" || body["Records"]) {
    const note = parseSesNotification(typeof body["Message"] === "string" ? (body["Message"] as string) : JSON.stringify(body));
    if (!note) return json({ ok: true, ignored: "unrecognized notification" });

    const { getInboundConfig } = await import("../../lib/config.js");
    const inbound = getInboundConfig();
    // SECURITY: never trust note.bucket from the (unauthenticated) payload — a
    // forged notification could otherwise make us ingest an arbitrary bucket.
    // Always sync the operator-configured inbound bucket.
    const bucket = inbound.bucket;
    const region = inbound.region;
    const prefix = inbound.prefix;
    if (!bucket) return json({ ok: true, ignored: "no bucket configured" });
    const providerId = getInboundBuckets().find((entry) => entry.bucket === bucket)?.providerId;
    const objectKey = note.objectKey?.replace(/^\/+/, "");
    if (objectKey && prefix && !objectKey.startsWith(prefix)) {
      return json({ ok: true, ignored: "notification object key outside configured prefix", message_id: note.messageId, object_key: objectKey });
    }
    const exactKeys = objectKey ? [objectKey] : undefined;

    const sync = deps?.sync ?? (async (b: string, p: string | undefined, r: string | undefined, syncOpts?: { keys?: string[]; providerId?: string }) => {
      const { syncS3Inbox } = await import("../../lib/s3-sync.js");
      return syncS3Inbox({ bucket: b, prefix: p, region: r, providerId: syncOpts?.providerId, keys: syncOpts?.keys, limit: syncOpts?.keys?.length ?? 100 });
    });
    emitMaileryEventBestEffort({
      type: "mailery.inbound.sync.requested",
      subject: note.messageId,
      severity: "info",
      dedupeKey: `mailery:inbound:ses-sync-requested:${note.messageId}`,
      message: "SES inbound notification requested mailbox sync",
      data: {
        message_id: note.messageId,
        bucket,
        prefix: prefix ?? "",
        region,
        object_key: objectKey ?? null,
        provider_id: providerId ?? null,
      },
      metadata: {
        route: "/webhook/ses-inbound",
        exact_key: Boolean(exactKeys?.length),
      },
    });
    const result = await sync(bucket, prefix, region, { keys: exactKeys, providerId });
    return json({ ok: true, synced: result.synced, message_id: note.messageId, object_key: objectKey ?? null });
  }

  return json({ ok: true, ignored: "unhandled message type" });
}
