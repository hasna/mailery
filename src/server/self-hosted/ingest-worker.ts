// Self-hosted-side SES-inbound ingestion worker for the Emails self_hosted service.
//
// Runs as a long-lived ECS task alongside the self_hosted API (`emails-serve
// ingest-worker`). It long-polls a dedicated SQS queue that is fanned out from
// the shared SES-inbound SNS topic, fetches each archived raw message from the
// SES→S3 inbound bucket, normalizes it, and writes it to the SAME self_hosted
// Postgres `messages` table the /v1 API serves — so NEW inbound mail lands in
// the self_hosted automatically, with no per-machine step.
//
// Idempotency / dedup:
//   - `source_id` = the S3 object key, so redelivery of the same SQS message is
//     an upsert (never a duplicate).
//   - Before writing, we also skip anything already present under the same key
//     in `message_id` (the local→self_hosted history backfill stored the object key
//     there), so the live drain never duplicates imported history.
//
// Failure handling: any fetch/parse/DB error leaves the message on the queue
// for SQS redelivery; after the queue's maxReceiveCount it lands in the DLQ
// (nothing is silently dropped, and the durable copy remains in S3).
//
// Amendment A1 (PURE REMOTE): the worker reads/writes the shared self_hosted Postgres
// directly via the same store the serve uses. The RDS DSN is a server-side
// secret (never distributed to clients).

import { parseSesNotification } from "../../lib/inbound-realtime.js";
import { parseInboundMime } from "../../lib/inbound-mime.js";
import { getSelfHostedPool, closeSelfHostedPool } from "./env.js";
import {
  EmailsSelfHostedStore,
  type InboundRouteResolution,
  type TenantScopedStore,
  type MessageInput,
} from "./store.js";

/** Minimal store surface the worker needs (kept narrow for testability). */
export interface IngestStore {
  resolveInboundRecipients(recipients: string[]): Promise<InboundRouteResolution>;
  quarantineInbound(input: {
    sourceId: string;
    bucket: string;
    objectKey: string;
    envelopeRecipients: string[];
    reason: string;
    detail?: string | null;
  }): Promise<void>;
  forTenant(tenantId: string): Pick<TenantScopedStore, "findMessageIdByKey" | "upsertMessage">;
}

export interface IngestDeps {
  store: IngestStore;
  /** Fetch a raw RFC822 object from S3 as bytes. */
  fetchObject: (bucket: string, key: string) => Promise<Buffer>;
  now: () => string;
}

export type IngestStatus = "ingested" | "duplicate" | "quarantined" | "error";

export interface IngestResult {
  status: IngestStatus;
  key?: string;
  id?: string;
  inserted?: boolean;
  tenant_ids?: string[];
  quarantined_recipients?: string[];
  reason?: string;
  error?: string;
}

export async function ingestS3Object(
  deps: IngestDeps,
  bucket: string,
  key: string,
  note: { recipients?: string[]; timestamp?: string } = {},
): Promise<IngestResult> {
  if (!bucket) return { status: "error", key, reason: "no_bucket", error: "worker has no configured inbound bucket" };
  try {
    const envelopeRecipients = note.recipients ?? [];
    const route = await deps.store.resolveInboundRecipients(envelopeRecipients);
    if (route.unresolved.length > 0 || route.groups.length === 0) {
      await deps.store.quarantineInbound({
        sourceId: key,
        bucket,
        objectKey: key,
        envelopeRecipients,
        reason: route.groups.length === 0 ? "no_tenant_route" : "partial_tenant_route",
        detail: route.unresolved.length > 0
          ? `${route.unresolved.length} unresolved envelope recipient(s)`
          : "empty envelope recipients",
      });
    }
    if (route.groups.length === 0) {
      return { status: "quarantined", key, reason: "no_tenant_route", quarantined_recipients: route.unresolved };
    }

    const targets: Array<{
      group: InboundRouteResolution["groups"][number];
      scoped: Pick<TenantScopedStore, "findMessageIdByKey" | "upsertMessage">;
      existing: string | null;
    }> = [];
    for (const group of route.groups) {
      const scoped = deps.store.forTenant(group.tenantId);
      targets.push({ group, scoped, existing: await scoped.findMessageIdByKey(key) });
    }
    if (targets.every((target) => target.existing !== null)) {
      return {
        status: "duplicate",
        key,
        id: targets[0]?.existing ?? undefined,
        inserted: false,
        tenant_ids: targets.map((target) => target.group.tenantId),
      };
    }

    const raw = await deps.fetchObject(bucket, key);
    const parsed = await parseInboundMime(raw);
    const receivedAt = parsed.received_at ?? note.timestamp ?? deps.now();
    const tenantIds: string[] = [];
    const ids: string[] = [];
    let insertedAny = false;
    for (const { group, scoped, existing } of targets) {
      tenantIds.push(group.tenantId);
      if (existing) {
        ids.push(existing);
        continue;
      }
      const input: MessageInput = {
        from_addr: parsed.from_addr || "(unknown sender)",
        // MIME To/Cc headers are sender-controlled. Tenant selection and the
        // stored recipient list come only from the trusted SES envelope.
        to_addrs: group.recipients,
        cc_addrs: [],
        subject: parsed.subject || null,
        body_text: parsed.body_text,
        body_html: parsed.body_html,
        status: "received",
        direction: "inbound",
        message_id: key,
        in_reply_to: parsed.in_reply_to,
        received_at: receivedAt,
        is_read: false,
        headers: parsed.headers,
        attachments: parsed.attachments,
        source_id: key,
      };
      const { record, inserted } = await scoped.upsertMessage(input);
      ids.push(record.id);
      insertedAny ||= inserted;
    }
    return {
      status: insertedAny ? "ingested" : "duplicate",
      key,
      id: ids[0],
      inserted: insertedAny,
      tenant_ids: tenantIds,
      ...(route.unresolved.length > 0 ? { quarantined_recipients: route.unresolved } : {}),
    };
  } catch (err) {
    return { status: "error", key, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Process a single SQS message body (a raw SES "Received" notification, with or
 * without an SNS envelope). Pure w.r.t. its injected deps so it is unit-testable
 * without AWS or a database.
 *
 * Returns a status the caller uses to decide whether to delete the SQS message:
 * `ingested`, `duplicate`, and metadata-only `quarantined` are terminal (delete);
 * malformed or incomplete
 * notifications are errors and remain for SQS redrive/DLQ inspection.
 */
export async function processInboundNotification(
  deps: IngestDeps,
  body: string,
  defaultBucket: string | undefined,
): Promise<IngestResult> {
  const note = parseSesNotification(body);
  if (!note || !note.objectKey) return { status: "error", reason: "no_object_key", error: "notification has no S3 object key" };
  const bucket = defaultBucket;
  if (!bucket) return { status: "error", reason: "no_bucket", error: "worker has no configured inbound bucket" };
  const key = note.objectKey;
  return ingestS3Object(deps, bucket, key, { recipients: note.recipients, timestamp: note.timestamp });
}

interface WorkerOptions {
  queueUrl?: string;
  bucket?: string;
  region?: string;
  maxMessages?: number;
  waitTimeSeconds?: number;
  visibilityTimeout?: number;
}

export function validateIngestWorkerConfig(config: {
  queueUrl?: string;
  bucket?: string;
  databaseUrl?: string;
}): void {
  if (!config.queueUrl) throw new Error("ingest worker requires EMAILS_INGEST_QUEUE_URL");
  if (!config.bucket) throw new Error("ingest worker requires EMAILS_INGEST_S3_BUCKET");
  if (!config.databaseUrl) throw new Error("ingest worker requires EMAILS_DATABASE_URL");
}

export function shouldDeleteIngestResult(result: IngestResult): boolean {
  return result.status === "ingested" || result.status === "duplicate" || result.status === "quarantined";
}

/**
 * Run the ingest worker loop until SIGTERM/SIGINT. Reads its wiring from the
 * environment:
 *   EMAILS_INGEST_QUEUE_URL   (required) — the SQS queue to consume
 *   EMAILS_INGEST_S3_BUCKET   (required) — operator-owned inbound bucket
 *   AWS_REGION                 (default us-east-1)
 *   EMAILS_DATABASE_URL        (required) — self-hosted Postgres DSN
 */
export async function runIngestWorker(options: WorkerOptions = {}): Promise<void> {
  const region = options.region ?? process.env["AWS_REGION"] ?? "us-east-1";
  const queueUrl = options.queueUrl ?? process.env["EMAILS_INGEST_QUEUE_URL"];
  const defaultBucket = options.bucket ?? process.env["EMAILS_INGEST_S3_BUCKET"];
  const maxMessages = options.maxMessages ?? 10;
  const waitTimeSeconds = options.waitTimeSeconds ?? 20;
  const visibilityTimeout = options.visibilityTimeout ?? 120;

  validateIngestWorkerConfig({ queueUrl, bucket: defaultBucket, databaseUrl: process.env["EMAILS_DATABASE_URL"] });
  const configuredQueueUrl = queueUrl!;
  const configuredBucket = defaultBucket!;

  const { client } = getSelfHostedPool();
  const store = new EmailsSelfHostedStore(client);

  const [{ SQSClient, ReceiveMessageCommand, DeleteMessageCommand }, { S3Client, GetObjectCommand }] =
    await Promise.all([import("@aws-sdk/client-sqs"), import("@aws-sdk/client-s3")]);
  const sqs = new SQSClient({ region });
  const s3 = new S3Client({ region });

  const fetchObject = async (bucket: string, key: string): Promise<Buffer> => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error(`empty S3 object ${bucket}/${key}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const deps: IngestDeps = { store, fetchObject, now: () => new Date().toISOString() };

  let running = true;
  const stop = (sig: string) => {
    console.log(`[ingest] received ${sig}, finishing current batch and shutting down`);
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const counts = { ingested: 0, duplicate: 0, quarantined: 0, error: 0 };
  let lastReport = Date.now();
  console.log(
    `[ingest] starting: queue=${configuredQueueUrl.split("/").pop()} region=${region} ` +
      `bucket=${configuredBucket}`,
  );

  while (running) {
    let messages: Array<{ Body?: string; ReceiptHandle?: string }> = [];
    try {
      const out = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: configuredQueueUrl,
          MaxNumberOfMessages: maxMessages,
          WaitTimeSeconds: waitTimeSeconds,
          VisibilityTimeout: visibilityTimeout,
        }),
      );
      messages = out.Messages ?? [];
    } catch (err) {
      console.error(`[ingest] receive failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(5000);
      continue;
    }

    for (const m of messages) {
      if (!running) break;
      const result = await processInboundNotification(deps, m.Body ?? "", configuredBucket);
      counts[result.status]++;

      if (!shouldDeleteIngestResult(result)) {
        console.error(`[ingest] error key=${result.key ?? "-"}: ${result.error} (left for redelivery)`);
        continue; // do NOT delete — SQS redelivers, then DLQ after maxReceiveCount
      }

      if (m.ReceiptHandle) {
        try {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: configuredQueueUrl, ReceiptHandle: m.ReceiptHandle }));
        } catch (err) {
          console.error(`[ingest] delete failed key=${result.key ?? "-"}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (result.status === "ingested") {
        console.log(`[ingest] stored ${result.inserted ? "new" : "updated"} key=${result.key}`);
      }
    }

    if (Date.now() - lastReport > 30_000) {
      console.log(
        `[ingest] progress ingested=${counts.ingested} duplicate=${counts.duplicate} ` +
          `quarantined=${counts.quarantined} error=${counts.error}`,
      );
      lastReport = Date.now();
    }
  }

  console.log(
    `[ingest] stopped. totals ingested=${counts.ingested} duplicate=${counts.duplicate} ` +
      `quarantined=${counts.quarantined} error=${counts.error}`,
  );
  await closeSelfHostedPool();
}

interface BackfillOptions {
  bucket?: string;
  prefix?: string;
  region?: string;
  limit?: number;
  /** Trusted historical envelope recipients for this bounded prefix/backfill. */
  recipients?: string[];
}

/**
 * One-shot S3 listing backfill for existing SES raw objects. This is operator
 * tooling for bootstrapping or repairing a self-hosted deployment; steady-state
 * ingestion should use the SQS worker above.
 */
export async function runIngestS3Backfill(options: BackfillOptions = {}): Promise<void> {
  const region = options.region ?? process.env["AWS_REGION"] ?? "us-east-1";
  const bucket = options.bucket ?? process.env["EMAILS_INGEST_S3_BUCKET"];
  const prefix = options.prefix ?? process.env["EMAILS_INGEST_S3_PREFIX"] ?? "";
  const envLimit = Number(process.env["EMAILS_INGEST_BACKFILL_LIMIT"] ?? "0");
  const limit = options.limit ?? (Number.isFinite(envLimit) && envLimit > 0 ? envLimit : undefined);
  const recipients = options.recipients ?? (process.env["EMAILS_INGEST_BACKFILL_RECIPIENTS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  validateIngestWorkerConfig({
    queueUrl: "backfill",
    bucket,
    databaseUrl: process.env["EMAILS_DATABASE_URL"],
  });
  const configuredBucket = bucket!;

  const { client } = getSelfHostedPool();
  const store = new EmailsSelfHostedStore(client);
  const [{ S3Client, GetObjectCommand, ListObjectsV2Command }] = await Promise.all([import("@aws-sdk/client-s3")]);
  const s3 = new S3Client({ region });
  const fetchObject = async (objectBucket: string, key: string): Promise<Buffer> => {
    const res = await s3.send(new GetObjectCommand({ Bucket: objectBucket, Key: key }));
    if (!res.Body) throw new Error(`empty S3 object ${objectBucket}/${key}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const deps: IngestDeps = { store, fetchObject, now: () => new Date().toISOString() };
  const counts = { ingested: 0, duplicate: 0, quarantined: 0, error: 0 };
  let scanned = 0;
  let continuationToken: string | undefined;
  console.log(`[ingest-backfill] starting: region=${region} bucket=${configuredBucket} prefix=${prefix || "(none)"}`);
  try {
    do {
      const listed = await s3.send(new ListObjectsV2Command({
        Bucket: configuredBucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }));
      for (const object of listed.Contents ?? []) {
        if (!object.Key) continue;
        if (limit && scanned >= limit) break;
        scanned++;
        const result = await ingestS3Object(deps, configuredBucket, object.Key, { recipients });
        counts[result.status]++;
        if (result.status === "error") {
          console.error(`[ingest-backfill] error key=${result.key ?? object.Key}: ${result.error}`);
        }
      }
      if (limit && scanned >= limit) break;
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
    console.log(
      `[ingest-backfill] done scanned=${scanned} ingested=${counts.ingested} duplicate=${counts.duplicate} ` +
        `quarantined=${counts.quarantined} error=${counts.error}`,
    );
  } finally {
    await closeSelfHostedPool();
  }
  if (counts.error > 0) process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
