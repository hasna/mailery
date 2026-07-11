/**
 * Real-time inbound — push delivery so mail lands in the inbox without a manual
 * `emails inbox sync-s3`.
 *
 * Wiring: SES receipt rule (S3 action with a TopicArn) → SNS topic → SQS queue.
 * A watch daemon long-polls the queue; any notification triggers a dedup-safe
 * `syncS3Inbox` of the bucket/prefix, so the new object is pulled into SQLite
 * immediately. The same notification is also accepted over an HTTP webhook on
 * `emails serve` (see the inbound webhook route).
 *
 * The parser and poller here are pure / dependency-injected so they are fully
 * testable without AWS.
 */

export interface InboundNotification {
  messageId?: string;
  bucket?: string;
  objectKey?: string;
  recipients?: string[];
  /** SES receipt time (`mail.timestamp`, ISO 8601) when present. */
  timestamp?: string;
}

/**
 * Parse an inbound notification body into bucket/key/messageId. Accepts:
 *  - a raw SES "Received" notification,
 *  - that notification wrapped in an SNS envelope ({ Type, Message }),
 *  - an S3 ObjectCreated event ({ Records: [{ s3: … }] }).
 * Returns null when nothing recognizable is present.
 */
export function parseSesNotification(body: string): InboundNotification | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(body) as Record<string, unknown>; } catch { return null; }

  // Unwrap SNS envelope.
  if (typeof obj["Type"] === "string" && typeof obj["Message"] === "string") {
    const inner = parseSesNotification(obj["Message"] as string);
    if (inner) return inner;
  }

  // SES "Received" notification.
  if (obj["notificationType"] === "Received" || obj["mail"] || obj["receipt"]) {
    const mail = (obj["mail"] ?? {}) as Record<string, unknown>;
    const receipt = (obj["receipt"] ?? {}) as Record<string, unknown>;
    const action = (receipt["action"] ?? {}) as Record<string, unknown>;
    const out: InboundNotification = {};
    if (typeof mail["messageId"] === "string") out.messageId = mail["messageId"];
    if (typeof action["bucketName"] === "string") out.bucket = action["bucketName"] as string;
    if (typeof action["objectKey"] === "string") out.objectKey = action["objectKey"] as string;
    if (Array.isArray(receipt["recipients"])) out.recipients = receipt["recipients"] as string[];
    if (typeof mail["timestamp"] === "string") out.timestamp = mail["timestamp"] as string;
    if (out.messageId || out.bucket || out.objectKey || out.recipients) return out;
  }

  // S3 ObjectCreated event.
  const records = obj["Records"];
  if (Array.isArray(records) && records.length > 0) {
    const s3 = ((records[0] as Record<string, unknown>)["s3"] ?? {}) as Record<string, unknown>;
    const bucket = (s3["bucket"] ?? {}) as Record<string, unknown>;
    const object = (s3["object"] ?? {}) as Record<string, unknown>;
    if (typeof bucket["name"] === "string" || typeof object["key"] === "string") {
      return {
        bucket: typeof bucket["name"] === "string" ? bucket["name"] : undefined,
        objectKey: typeof object["key"] === "string" ? decodeURIComponent((object["key"] as string).replace(/\+/g, " ")) : undefined,
      };
    }
  }

  return null;
}

// ── SQS poller ────────────────────────────────────────────────────────────────

export interface SqsMessage { ReceiptHandle: string; Body: string }

/** Minimal SQS surface — injected so the poller is testable without AWS. */
export interface SqsLike {
  receive: () => Promise<SqsMessage[]>;
  deleteMessage: (receiptHandle: string) => Promise<void>;
}

export interface WatchResult {
  messages: number;
  triggered: boolean;
}

/**
 * One poll cycle: receive a batch, and if anything arrived, drain the bucket by
 * running the dedup-safe `sync` REPEATEDLY until it stops pulling new mail —
 * each scan is capped (e.g. 100 objects), so a backlog larger than one scan
 * would otherwise be lost when we delete the messages. Only after a full drain
 * do we delete the processed messages. If `sync` throws, messages are left on
 * the queue for redelivery.
 *
 * `sync` may return `{ synced }`; when it does, draining continues while
 * `synced > 0`. A void-returning sync runs exactly once (back-compat).
 */
const MAX_DRAIN_ITERATIONS = 50;

export async function watchInboundOnce(
  sqs: SqsLike,
  _queueUrl: string,
  sync: () => Promise<{ synced: number } | void>,
): Promise<WatchResult> {
  const messages = await sqs.receive();
  if (messages.length === 0) return { messages: 0, triggered: false };
  // Drain fully before deleting anything.
  for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
    const r = await sync();
    if (!r || r.synced === 0) break;
  }
  for (const m of messages) await sqs.deleteMessage(m.ReceiptHandle);
  return { messages: messages.length, triggered: true };
}
