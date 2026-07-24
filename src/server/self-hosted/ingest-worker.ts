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
import { createHash } from "node:crypto";
import { getSelfHostedPool, closeSelfHostedPool } from "./env.js";
import {
  EmailsSelfHostedStore,
  type InboundRouteResolution,
  type TenantScopedStore,
  type MessageInput,
  type InboundSourceProvenance,
  type InboundProvenanceAuditResult,
} from "./store.js";
import {
  MAX_ATTACHMENT_REPAIR_RAW_BYTES,
  normalizeAttachmentRepairCanaryMessageIds,
  repairExistingS3ObjectAttachments,
  type AttachmentRepairResult,
} from "./attachment-repair.js";

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
  forTenant(tenantId: string): Pick<
    TenantScopedStore,
    "findMessageIdByKey" | "getInboundSourceProvenance" | "recordInboundSourceProvenance" | "createInboundMessageWithProvenance"
  >;
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

/**
 * Best-effort recipient recovery for notifications that arrive WITHOUT envelope
 * recipients — e.g. a raw S3 `ObjectCreated` event rather than an SES "Received"
 * notification (the latter carries `receipt.recipients`, the former does not).
 *
 * The SES receipt rule stores each inbound object at `<prefix><domain>/<id>`
 * (e.g. `inbound/adweb.com/abc123`), so the recipient domain is the path segment
 * immediately before the final object name. That segment is written by SES
 * infrastructure, NOT by the sender, so it is a safe basis for tenant routing —
 * unlike the MIME To/Cc headers, which are sender-controlled and are therefore
 * never used for tenant selection. The derived catch-all address is still
 * re-validated against `inbound_domain_routes` by `resolveInboundRecipients`, so
 * an unroutable or malformed key simply quarantines exactly as before.
 */
export function deriveKeyPathRecipients(objectKey: string): string[] {
  const parts = objectKey.split("/").filter(Boolean);
  if (parts.length < 2) return [];
  const domain = parts[parts.length - 2]!.trim().toLowerCase();
  if (!domain || domain.includes("@") || /\s/.test(domain) || !domain.includes(".")) return [];
  return [`catchall@${domain}`];
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
    let route = await deps.store.resolveInboundRecipients(envelopeRecipients);
    let routedRecipients = envelopeRecipients;
    // Fallback when the notification carried no usable envelope recipients (a raw
    // S3 ObjectCreated event has none). The trusted recipient domain is still
    // encoded in the SES-written object key path, so derive a catch-all for that
    // domain and re-resolve. Adopt it ONLY when it actually resolves a tenant
    // route; otherwise fall through to the unchanged quarantine path below.
    if (route.groups.length === 0) {
      const derived = deriveKeyPathRecipients(key);
      if (derived.length > 0) {
        const derivedRoute = await deps.store.resolveInboundRecipients(derived);
        if (derivedRoute.groups.length > 0) {
          route = derivedRoute;
          routedRecipients = derived;
        }
      }
    }
    if (route.unresolved.length > 0 || route.groups.length === 0) {
      await deps.store.quarantineInbound({
        sourceId: key,
        bucket,
        objectKey: key,
        envelopeRecipients: routedRecipients,
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
      scoped: Pick<
        TenantScopedStore,
        "findMessageIdByKey" | "getInboundSourceProvenance" | "recordInboundSourceProvenance" | "createInboundMessageWithProvenance"
      >;
      existing: string | null;
      provenance: InboundSourceProvenance | null;
    }> = [];
    for (const group of route.groups) {
      const scoped = deps.store.forTenant(group.tenantId);
      const existing = await scoped.findMessageIdByKey(key);
      targets.push({
        group,
        scoped,
        existing,
        provenance: existing ? await scoped.getInboundSourceProvenance(existing) : null,
      });
    }
    for (const target of targets) {
      if (target.provenance && (target.provenance.bucket !== bucket || target.provenance.object_key !== key)) {
        return { status: "error", key, reason: "provenance_conflict", error: "existing source provenance conflicts with the configured canonical source" };
      }
    }
    const raw = await deps.fetchObject(bucket, key);
    const rawSha256 = createHash("sha256").update(raw).digest("hex");
    for (const target of targets) {
      if (target.provenance && target.provenance.raw_sha256 !== rawSha256) {
        return { status: "error", key, reason: "provenance_hash_mismatch", error: "canonical source bytes no longer match immutable provenance" };
      }
    }
    // A fully provenanced replay is terminal only after the deployment's
    // canonical object has been fetched and verified against immutable bytes.
    // Preserve the fast exit here: matching duplicates are never parsed or
    // passed through any message/provenance write path.
    if (targets.every((target) => target.existing !== null && target.provenance !== null)) {
      return {
        status: "duplicate",
        key,
        id: targets[0]?.existing ?? undefined,
        inserted: false,
        tenant_ids: targets.map((target) => target.group.tenantId),
      };
    }
    // A legacy row with no provenance is bootstrapped from canonical object
    // identity only (configured bucket + exact key + raw SHA). Its stored mail
    // and attachment metadata are never reparsed or rewritten to establish
    // identity.
    if (targets.every((target) => target.existing !== null)) {
      for (const target of targets) {
        const provenanceResult = await target.scoped.recordInboundSourceProvenance({
          messageId: target.existing!,
          bucket,
          objectKey: key,
          rawSha256,
          establishedVia: "canonical_replay",
        });
        if (provenanceResult !== "recorded" && provenanceResult !== "existing_match") {
          throw new Error(`could not establish immutable legacy source provenance (${provenanceResult})`);
        }
      }
      return {
        status: "duplicate",
        key,
        id: targets[0]?.existing ?? undefined,
        inserted: false,
        tenant_ids: targets.map((target) => target.group.tenantId),
      };
    }
    const parsed = await parseInboundMime(raw);
    const receivedAt = parsed.received_at ?? note.timestamp ?? deps.now();
    const tenantIds: string[] = [];
    const ids: string[] = [];
    let insertedAny = false;
    for (const { group, scoped, existing } of targets) {
      tenantIds.push(group.tenantId);
      if (existing) {
        ids.push(existing);
        const provenanceResult = await scoped.recordInboundSourceProvenance({
          messageId: existing,
          bucket,
          objectKey: key,
          rawSha256,
          establishedVia: "canonical_replay",
        });
        if (provenanceResult !== "recorded" && provenanceResult !== "existing_match") {
          throw new Error(`could not establish immutable legacy source provenance (${provenanceResult})`);
        }
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
      const atomic = await scoped.createInboundMessageWithProvenance(input, {
        bucket,
        objectKey: key,
        rawSha256,
        establishedVia: "normal_ingest",
      });
      ids.push(atomic.record.id);
      insertedAny ||= atomic.inserted;
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
  const defaultBucket = process.env["EMAILS_INGEST_S3_BUCKET"];
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
  const bucket = process.env["EMAILS_INGEST_S3_BUCKET"];
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

export interface AttachmentRepairCanaryOptions {
  region?: string;
  objectKeys: string[];
  recipients: string[];
  canaryMessageIds: string[];
  /** False by default. The operator must pass --apply deliberately. */
  apply?: boolean;
}

export function validateAttachmentRepairCanaryOptions(options: AttachmentRepairCanaryOptions): {
  objectKey: string;
  messageIds: string[];
} {
  const objectKeys = options.objectKeys.map((value) => value.trim()).filter(Boolean);
  const messageIds = normalizeAttachmentRepairCanaryMessageIds(options.canaryMessageIds);
  if (objectKeys.length !== 1) throw new Error("attachment repair requires exactly one --object-key per invocation");
  if (messageIds.length === 0) throw new Error("attachment repair requires at least one --message-id per invocation");
  if (options.recipients.length === 0) throw new Error("attachment repair requires trusted --recipient routing evidence");
  return { objectKey: objectKeys[0]!, messageIds };
}

export function attachmentRepairResultSucceeded(result: AttachmentRepairResult): boolean {
  const allowed = result.apply
    ? new Set(["repaired", "already_complete"])
    : new Set(["would_repair", "already_complete"]);
  return result.items.length > 0 && result.items.every((item) => allowed.has(item.status));
}

export function redactedAttachmentRepairReport(result: AttachmentRepairResult): Record<string, unknown> {
  return {
    mode: result.apply ? "apply" : "dry-run",
    object_key_sha256: createHash("sha256").update(result.key).digest("hex"),
    items: result.items.map((item) => ({
      tenant_id: item.tenant_id,
      ...(item.message_id ? { message_id: item.message_id } : {}),
      status: item.status,
      ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
    })),
  };
}

export function finalizeAttachmentRepairCanary(
  result: AttachmentRepairResult,
  emit: (line: string) => void = (line) => console.log(line),
): AttachmentRepairResult[] {
  emit(JSON.stringify(redactedAttachmentRepairReport(result)));
  if (!attachmentRepairResultSucceeded(result)) {
    throw new Error("attachment repair did not complete successfully; no further object was attempted");
  }
  return [result];
}

/**
 * Bounded historical attachment repair. Unlike ingest-s3-backfill this never
 * lists a bucket and never invokes the generic message upsert: each requested
 * object must bind to an exact tenant-scoped canary message id, then an
 * attachment-only compare-and-swap is dry-run unless `apply` is explicit.
 */
export async function runAttachmentRepairCanary(options: AttachmentRepairCanaryOptions): Promise<AttachmentRepairResult[]> {
  const { objectKey } = validateAttachmentRepairCanaryOptions(options);
  const region = options.region ?? process.env["AWS_REGION"] ?? "us-east-1";
  if (!process.env["EMAILS_DATABASE_URL"]) throw new Error("attachment repair requires EMAILS_DATABASE_URL");
  const canonicalBucket = process.env["EMAILS_INGEST_S3_BUCKET"];
  if (!canonicalBucket) throw new Error("attachment repair requires EMAILS_INGEST_S3_BUCKET as the canonical source");

  const { client } = getSelfHostedPool();
  const store = new EmailsSelfHostedStore(client);
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region });
  const fetchObject = async (objectBucket: string, key: string): Promise<Buffer> => {
    const res = await s3.send(new GetObjectCommand({ Bucket: objectBucket, Key: key }));
    if (!res.Body) throw new Error("S3 object has no body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_ATTACHMENT_REPAIR_RAW_BYTES) {
        throw new Error(`S3 object exceeds attachment repair source byte limit ${MAX_ATTACHMENT_REPAIR_RAW_BYTES}`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  try {
    const result = await repairExistingS3ObjectAttachments({
      canonicalBucket,
      resolveInboundRecipients: (recipients) => store.resolveInboundRecipients(recipients),
      listAttachmentRepairBindings: (bucket, key) => store.listAttachmentRepairBindings(bucket, key),
      replaceAttachmentPayloadsAtomically: (bindings, updates) =>
        store.replaceAttachmentPayloadsAtomically(bindings, updates),
      fetchObject,
    }, {
      key: objectKey,
      recipients: options.recipients,
      canaryMessageIds: options.canaryMessageIds,
      apply: options.apply === true,
    });
    return finalizeAttachmentRepairCanary(result);
  } finally {
    await closeSelfHostedPool();
  }
}

export interface InboundProvenanceAuditOptions {
  since: string;
}

export function redactedInboundProvenanceFenceReport(fenceAt: string): { fence_at: string } {
  return { fence_at: fenceAt };
}

/**
 * Privacy-safe pre-0017 cutover fence. The only emitted value is the database
 * clock timestamp used later by the aggregate provenance audit.
 */
export async function runInboundProvenanceFence(
  emit: (line: string) => void = (line) => console.log(line),
): Promise<string> {
  if (!process.env["EMAILS_DATABASE_URL"]) throw new Error("inbound provenance fence requires EMAILS_DATABASE_URL");
  const { client } = getSelfHostedPool();
  try {
    const fenceAt = await new EmailsSelfHostedStore(client).captureInboundProvenanceFence();
    emit(JSON.stringify(redactedInboundProvenanceFenceReport(fenceAt)));
    return fenceAt;
  } finally {
    await closeSelfHostedPool();
  }
}

export function validateInboundProvenanceAuditOptions(options: InboundProvenanceAuditOptions): { since: string } {
  const raw = options.since.trim();
  if (!raw) throw new Error("inbound provenance audit requires exactly one --since <ISO8601> cutoff");
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) {
    throw new Error("inbound provenance audit --since must be a valid ISO 8601 timestamp");
  }
  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  const hour = Number(match[4]!);
  const minute = Number(match[5]!);
  const second = Number(match[6]!);
  const zone = match[8]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const [offsetHour, offsetMinute] = zone === "Z"
    ? [0, 0]
    : zone.slice(1).split(":").map(Number);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > monthDays[month - 1]!
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour! > 23
    || offsetMinute! > 59
  ) {
    throw new Error("inbound provenance audit --since must be a valid ISO 8601 timestamp");
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error("inbound provenance audit --since must be a valid ISO 8601 timestamp");
  return { since: parsed.toISOString() };
}

export function inboundProvenanceAuditSucceeded(result: InboundProvenanceAuditResult): boolean {
  return result.tenants_scanned > 0
    && result.missing_provenance === 0
    && result.invalid_provenance === 0
    && result.candidate_messages === result.valid_provenance;
}

export function redactedInboundProvenanceAuditReport(
  result: InboundProvenanceAuditResult,
): InboundProvenanceAuditResult & { status: "pass" | "fail"; gaps: number } {
  const gaps = result.missing_provenance + result.invalid_provenance;
  return {
    status: inboundProvenanceAuditSucceeded(result) ? "pass" : "fail",
    ...result,
    gaps,
  };
}

export function finalizeInboundProvenanceAudit(
  result: InboundProvenanceAuditResult,
  emit: (line: string) => void = (line) => console.log(line),
): InboundProvenanceAuditResult {
  const report = redactedInboundProvenanceAuditReport(result);
  emit(JSON.stringify(report));
  if (!inboundProvenanceAuditSucceeded(result)) {
    throw new Error(`inbound provenance audit found ${report.gaps} gap(s); API activation is forbidden`);
  }
  return result;
}

/**
 * Privacy-safe, read-only post-fence audit. The canonical bucket comes only
 * from deployment configuration; output is aggregate counts and a cutoff.
 */
export async function runInboundProvenanceAudit(
  options: InboundProvenanceAuditOptions,
): Promise<InboundProvenanceAuditResult> {
  const { since } = validateInboundProvenanceAuditOptions(options);
  if (!process.env["EMAILS_DATABASE_URL"]) throw new Error("inbound provenance audit requires EMAILS_DATABASE_URL");
  const canonicalBucket = process.env["EMAILS_INGEST_S3_BUCKET"];
  if (!canonicalBucket) throw new Error("inbound provenance audit requires EMAILS_INGEST_S3_BUCKET as the canonical source");
  const { client } = getSelfHostedPool();
  try {
    const result = await new EmailsSelfHostedStore(client).auditInboundSourceProvenance({
      since,
      canonicalBucket,
    });
    return finalizeInboundProvenanceAudit(result);
  } finally {
    await closeSelfHostedPool();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
