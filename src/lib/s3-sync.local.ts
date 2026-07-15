/**
 * S3 inbox sync — polls an S3 bucket for raw emails stored by SES receipt rules
 * and stores them in the local inbound_emails DB.
 *
 * Flow:
 *   SES receipt rule → S3 bucket (raw RFC 2822) → this sync → inbound_emails table
 *
 * Uses mailparser to parse raw RFC 2822 email files.
 * Scans the configured prefix and relies on DB dedup by S3 key. SES object
 * names are random, so a key-ordered cursor would skip valid later mail.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import { storeInboundEmail, updateAttachmentPaths } from "../db/inbound.local.js";
import type { AttachmentPath } from "../db/inbound.local.js";
import { backfillLegacyS3RawUrls, getDatabase, getDataDir, rebuildInboundCanonicalState, resolvePartialId } from "../db/database.js";
import { loadConfig, saveConfig, getInboundAttachmentStorageConfig } from "./config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/database.js";
import { emitEmailsEventBestEffort, inboundReceivedEventData } from "./emails-events.js";
import { s3ObjectUrl } from "./s3-object.js";

const MAIL_SOURCES_CONFIG_KEY = "mail_sources";

export type MailSourceStatus = "live" | "import" | "legacy" | "retired";

export interface S3SyncOptions {
  bucket?: string;
  prefix?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  providerId?: string;
  sourceId?: string;
  forceSource?: boolean;
  /** Exact S3 object keys to process without listing the whole prefix. */
  keys?: string[];
  /** Max objects to process per run */
  limit?: number;
  db?: Database;
}

export interface S3SyncResult {
  synced: number;
  skipped: number;
  attachments_saved: number;
  errors: string[];
  last_key?: string;
}

type S3Sdk = typeof import("@aws-sdk/client-s3");
type MailparserSdk = typeof import("mailparser");
type RawMailSource = Record<string, unknown>;

export interface S3MailSource {
  id: string;
  type: "s3";
  name?: string;
  bucket: string;
  prefix?: string;
  region: string;
  provider_id?: string;
  status: MailSourceStatus;
  live_sync_enabled: boolean;
  created_at?: string;
  updated_at?: string;
  retired_at?: string | null;
}

export interface RegisterS3SourceInput {
  id?: string;
  bucket: string;
  prefix?: string;
  region?: string;
  providerId?: string;
  name?: string;
  status?: MailSourceStatus;
  liveSyncEnabled?: boolean;
}

let s3SdkPromise: Promise<S3Sdk> | undefined;
let mailparserPromise: Promise<MailparserSdk> | undefined;

function loadS3Sdk(): Promise<S3Sdk> {
  s3SdkPromise ??= import("@aws-sdk/client-s3");
  return s3SdkPromise;
}

function loadMailparser(): Promise<MailparserSdk> {
  mailparserPromise ??= import("mailparser");
  return mailparserPromise;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePrefix(prefix: string | null | undefined): string | undefined {
  const value = String(prefix ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function normalizeObjectKey(key: string | null | undefined): string | undefined {
  const value = String(key ?? "").trim().replace(/^\/+/, "");
  return value.length > 0 ? value : undefined;
}

function normalizeExactObjectKeys(keys: string[] | undefined, prefix: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys ?? []) {
    const key = normalizeObjectKey(raw);
    if (!key) continue;
    if (prefix && !key.startsWith(prefix)) {
      throw new Error(`S3 object key ${key} is outside configured prefix ${prefix}`);
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function normalizeStatus(status: unknown): MailSourceStatus {
  return status === "live" || status === "import" || status === "legacy" || status === "retired"
    ? status
    : "legacy";
}

function sourceId(type: "s3", bucket: string, prefix?: string): string {
  const suffix = [bucket, prefix]
    .map((part) => String(part ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-"))
    .filter(Boolean)
    .join("-");
  return `${type}-${suffix || "source"}`;
}

function readConfiguredSources(): RawMailSource[] {
  const raw = loadConfig()[MAIL_SOURCES_CONFIG_KEY];
  return Array.isArray(raw)
    ? raw.filter((item): item is RawMailSource => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function writeConfiguredSources(sources: RawMailSource[]): void {
  const config = loadConfig();
  config[MAIL_SOURCES_CONFIG_KEY] = sources;
  saveConfig(config);
}

function parseConfiguredS3Source(raw: RawMailSource): S3MailSource | null {
  if (raw["type"] !== "s3") return null;
  const bucket = typeof raw["bucket"] === "string" ? raw["bucket"].trim() : "";
  if (!bucket) return null;
  const status = normalizeStatus(raw["status"]);
  const region = typeof raw["region"] === "string" && raw["region"].trim() ? raw["region"].trim() : "us-east-1";
  const prefix = normalizePrefix(raw["prefix"] as string | undefined);
  return {
    id: typeof raw["id"] === "string" && raw["id"].trim() ? raw["id"].trim() : sourceId("s3", bucket, prefix),
    type: "s3",
    bucket,
    prefix,
    region,
    provider_id: typeof raw["provider_id"] === "string" ? raw["provider_id"] : undefined,
    name: typeof raw["name"] === "string" ? raw["name"] : undefined,
    status,
    live_sync_enabled: raw["live_sync_enabled"] == null ? status === "live" : raw["live_sync_enabled"] === true,
    created_at: typeof raw["created_at"] === "string" ? raw["created_at"] : undefined,
    updated_at: typeof raw["updated_at"] === "string" ? raw["updated_at"] : undefined,
    retired_at: typeof raw["retired_at"] === "string" ? raw["retired_at"] : null,
  };
}

function sourceIsLive(source: S3MailSource | null | undefined): boolean {
  return !!source && source.status === "live" && source.live_sync_enabled === true;
}

function sameS3Endpoint(
  source: Pick<S3MailSource, "bucket" | "prefix">,
  bucket: string,
  prefix?: string,
): boolean {
  return source.bucket === bucket && normalizePrefix(source.prefix) === normalizePrefix(prefix);
}

function prefixContains(parent: string | undefined, child: string | undefined): boolean {
  const normalizedParent = normalizePrefix(parent) ?? "";
  const normalizedChild = normalizePrefix(child) ?? "";
  return normalizedChild.length > normalizedParent.length && normalizedChild.startsWith(normalizedParent);
}

function findUniqueS3Source(
  sources: S3MailSource[],
  ref: string,
  extraExactMatch?: (source: S3MailSource) => boolean,
): S3MailSource | null {
  const exact = sources.filter((source) => source.id === ref || extraExactMatch?.(source));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new Error(`Ambiguous S3 source; choose one with --source. Matches: ${exact.map((source) => source.id).join(", ")}`);
  }

  const prefixMatches = sources.filter((source) => source.id.startsWith(ref));
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  if (prefixMatches.length > 1) {
    throw new Error(`Ambiguous S3 source prefix "${ref}"; choose one with --source. Matches: ${prefixMatches.map((source) => source.id).join(", ")}`);
  }

  return null;
}

export function listS3Sources(): S3MailSource[] {
  return readConfiguredSources()
    .map(parseConfiguredS3Source)
    .filter((source): source is S3MailSource => !!source);
}

export function listLiveS3Sources(): S3MailSource[] {
  return listS3Sources().filter(sourceIsLive);
}

export function registerS3Source(input: RegisterS3SourceInput): S3MailSource {
  const status = input.status ?? "live";
  const timestamp = nowIso();
  const prefix = normalizePrefix(input.prefix);
  const next: S3MailSource = {
    id: input.id ?? sourceId("s3", input.bucket, prefix),
    type: "s3",
    bucket: input.bucket,
    prefix,
    region: input.region ?? process.env["AWS_REGION"] ?? "us-east-1",
    provider_id: input.providerId,
    name: input.name,
    status,
    live_sync_enabled: input.liveSyncEnabled ?? status === "live",
    created_at: timestamp,
    updated_at: timestamp,
    retired_at: status === "retired" ? timestamp : null,
  };
  const sources = readConfiguredSources();
  const rawNext: RawMailSource = { ...next };
  const index = sources.findIndex((source) =>
    source["id"] === next.id ||
    (source["type"] === "s3" &&
      source["bucket"] === input.bucket &&
      normalizePrefix(source["prefix"] as string | undefined) === prefix));
  if (index >= 0) {
    const previous = sources[index]!;
    next.created_at = typeof previous["created_at"] === "string" ? previous["created_at"] : timestamp;
    sources[index] = { ...previous, ...rawNext, created_at: next.created_at };
  } else {
    sources.push(rawNext);
  }
  writeConfiguredSources(sources);
  return next;
}

export function retireS3Source(sourceIdOrBucket: string): S3MailSource {
  const sources = readConfiguredSources();
  const parsed = sources.map(parseConfiguredS3Source);
  const target = findUniqueS3Source(
    parsed.filter((source): source is S3MailSource => !!source),
    sourceIdOrBucket,
    (source) => source.bucket === sourceIdOrBucket,
  );
  const index = target ? parsed.findIndex((source) => source?.id === target.id) : -1;
  if (index < 0 || !parsed[index]) throw new Error(`S3 source not found: ${sourceIdOrBucket}`);
  const timestamp = nowIso();
  const retired = {
    ...sources[index]!,
    status: "retired",
    live_sync_enabled: false,
    retired_at: timestamp,
    updated_at: timestamp,
  };
  sources[index] = retired;
  writeConfiguredSources(sources);
  return parseConfiguredS3Source(retired)!;
}

function resolveS3SourceForSync(opts: S3SyncOptions): S3SyncOptions {
  const sources = listS3Sources();
  const prefix = normalizePrefix(opts.prefix);
  const requestedSourceId = typeof opts.sourceId === "string" && opts.sourceId.trim() ? opts.sourceId.trim() : undefined;
  const source = requestedSourceId
    ? findUniqueS3Source(sources, requestedSourceId)
    : opts.bucket
      ? sources.find((candidate) => sameS3Endpoint(candidate, opts.bucket!, prefix))
      : undefined;
  if (requestedSourceId && !source) throw new Error(`S3 source not found: ${requestedSourceId}`);
  if (source && !sourceIsLive(source) && !opts.forceSource) {
    throw new Error(`S3 source ${source.id} is ${source.status}${source.live_sync_enabled ? "" : " with live sync disabled"}; S3 sync is blocked.`);
  }
  if (opts.bucket && !requestedSourceId && !opts.forceSource) {
    const bucketSources = sources.filter((candidate) => candidate.bucket === opts.bucket);
    const coveredChildSources = bucketSources.filter((candidate) => prefixContains(prefix, candidate.prefix));
    if (coveredChildSources.length > 0) {
      throw new Error(`S3 bucket ${opts.bucket} has configured source prefixes under ${prefix ?? "<root>"}; choose a source with --source or an exact --prefix before syncing.`);
    }
  }
  if (!source && opts.bucket && !opts.forceSource) {
    const bucketSources = sources.filter((candidate) => candidate.bucket === opts.bucket);
    if (bucketSources.length > 0 && !bucketSources.some(sourceIsLive)) {
      throw new Error(`S3 bucket ${opts.bucket} only has retired or disabled sources; S3 sync is blocked.`);
    }
  }
  if (!source) return { ...opts, prefix };
  return {
    ...opts,
    bucket: source.bucket,
    prefix: source.prefix,
    region: opts.region ?? source.region,
    providerId: opts.providerId ?? source.provider_id,
  };
}

async function makeS3Client(opts: S3SyncOptions): Promise<{ s3: S3Client; s3Sdk: S3Sdk }> {
  const s3Sdk = await loadS3Sdk();
  const { S3Client } = s3Sdk;
  const region = opts.region || process.env["AWS_REGION"] || "us-east-1";
  const credentials = opts.accessKeyId && opts.secretAccessKey
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
    : undefined;
  return { s3: new S3Client({ region, credentials }), s3Sdk };
}

function setLastSyncedKey(bucket: string, prefix: string, lastKey: string): void {
  const config = loadConfig();
  const key = `s3_sync_last_key_${bucket}_${prefix.replace(/\//g, "_")}`;
  config[key] = lastKey;
  saveConfig(config);
}

function getAttachmentDir(emailId: string): string {
  const dir = join(getDataDir(), "attachments", emailId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MAX_ATTACHMENT_STORAGE_LEAF_BYTES = 240;

interface AttachmentStoragePlan {
  index: number;
  filename: string;
  content_type: string;
  size: number;
  content: Buffer;
  storageLeaf: string;
}

function truncateUtf8(value: string, byteLimit: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > byteLimit) break;
    output += character;
    bytes += next;
  }
  return output;
}

function legacySanitizeAttachmentFilename(filename: string): string {
  return filename.replace(/[/\\?%*:|"<>]/g, "_");
}

function attachmentStorageLeaf(index: number, filename: string): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("attachment index must be a non-negative integer");
  const prefix = `${String(index).padStart(6, "0")}-`;
  let sanitized = legacySanitizeAttachmentFilename(filename)
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") sanitized = "attachment";
  const budget = MAX_ATTACHMENT_STORAGE_LEAF_BYTES - Buffer.byteLength(prefix, "utf8");
  return `${prefix}${truncateUtf8(sanitized, budget) || "attachment"}`;
}

function buildAttachmentStoragePlans(
  attachments: ReadonlyArray<{
    filename?: string;
    contentType?: string;
    size?: number;
    content: Buffer;
  }>,
): AttachmentStoragePlan[] {
  return attachments.map((attachment, index) => {
    const filename = attachment.filename ?? `attachment_${index + 1}`;
    return {
      index,
      filename,
      content_type: attachment.contentType ?? "application/octet-stream",
      size: attachment.size ?? 0,
      content: attachment.content,
      storageLeaf: attachmentStorageLeaf(index, filename),
    };
  });
}

function attachmentS3Key(prefix: string | undefined, emailId: string, storageLeaf: string): string {
  const root = (prefix?.trim() || "emails").replace(/\/+$/, "");
  return `${root}/${emailId}/${storageLeaf}`;
}

function storeLocalAttachment(plan: AttachmentStoragePlan, outputDir: string): AttachmentPath {
  const filePath = join(outputDir, plan.storageLeaf);
  writeFileSync(filePath, plan.content);
  return {
    index: plan.index,
    filename: plan.filename,
    content_type: plan.content_type,
    size: plan.size,
    local_path: filePath,
  };
}

async function listObjectPage(
  s3: S3Client,
  s3Sdk: S3Sdk,
  bucket: string,
  prefix: string,
  continuationToken?: string,
): Promise<{ objects: { key: string; size: number; lastModified?: Date }[]; nextContinuationToken?: string }> {
  const { ListObjectsV2Command } = s3Sdk;
  // NOTE: SES inbound stores objects under RANDOM keys, so a key-ordered cursor
  // (StartAfter: lastKey) silently skips any later-arriving object whose key
  // sorts before the last-synced key. We therefore page the full prefix and
  // rely on DB dedup before downloading bodies.
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1000,
    ContinuationToken: continuationToken,
  }));
  const objects: { key: string; size: number; lastModified?: Date }[] = [];
  for (const obj of res.Contents ?? []) {
    if (obj.Key && obj.Key !== prefix) {
      objects.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified });
    }
  }
  return {
    objects,
    nextContinuationToken: res.IsTruncated ? res.NextContinuationToken : undefined,
  };
}

function getExistingS3Urls(db: Database, rawS3Urls: string[]): Set<string> {
  const unique = [...new Set(rawS3Urls.filter(Boolean))];
  const existing = new Set<string>();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .query(`SELECT raw_s3_url FROM inbound_emails WHERE raw_s3_url IN (${placeholders})`)
      .all(...chunk) as Array<{ raw_s3_url: string | null }>;
    for (const row of rows) {
      if (row.raw_s3_url) existing.add(row.raw_s3_url);
    }
  }
  return existing;
}

function tagExistingS3Provider(db: Database, rawS3Url: string, providerId: string | null): void {
  if (!providerId) return;
  const result = db.run(
    "UPDATE inbound_emails SET provider_id = ? WHERE raw_s3_url = ? AND provider_id IS NULL",
    [providerId, rawS3Url],
  );
  if (result.changes > 0) rebuildInboundCanonicalState(db);
}

async function processS3Object(
  db: Database,
  s3: S3Client,
  s3Sdk: S3Sdk,
  syncConfig: ReturnType<typeof getInboundAttachmentStorageConfig>,
  bucket: string,
  providerId: string | null,
  obj: { key: string; size: number },
  result: S3SyncResult,
): Promise<void> {
  const parsed = await fetchAndParseEmail(s3, s3Sdk, bucket, obj.key);
  const attachmentPlans = buildAttachmentStoragePlans(parsed.attachments ?? []);

  const fromAddr = typeof parsed.from?.text === "string"
    ? parsed.from.text
    : parsed.from?.value?.[0]?.address ?? "";
  const toAddrs = parsed.to
    ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((a) =>
        a.value?.map((v) => v.address ?? "") ?? [])
    : [];
  const ccAddrs = parsed.cc
    ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap((a) =>
        a.value?.map((v) => v.address ?? "") ?? [])
    : [];

  const attachmentMeta = attachmentPlans.map((attachment) => ({
    filename: attachment.filename,
    content_type: attachment.content_type,
    size: attachment.size,
  }));

  const headerObj = flattenHeaders(parsed.headers);
  const rawS3Url = s3ObjectUrl(bucket, obj.key);

  const stored = storeInboundEmail({
    provider_id: providerId,
    message_id: rawS3Url,
    in_reply_to_email_id: null,
    raw_s3_url: rawS3Url,
    from_address: fromAddr,
    to_addresses: toAddrs,
    cc_addresses: ccAddrs,
    subject: parsed.subject ?? "(no subject)",
    text_body: parsed.text ?? null,
    html_body: typeof parsed.html === "string" ? parsed.html : null,
    attachments: attachmentMeta,
    attachment_paths: [],
    headers: headerObj,
    raw_size: obj.size,
    received_at: (parsed.date ?? new Date()).toISOString(),
  }, db);

  emitEmailsEventBestEffort({
    type: "emails.inbound.received",
    subject: stored.id,
    severity: "notice",
    dedupeKey: `emails:inbound:received:${stored.id}`,
    message: `Inbound email received from SES/S3`,
    data: inboundReceivedEventData({
      emailId: stored.id,
      providerId,
      source: "ses-s3",
      messageId: rawS3Url,
      fromAddress: fromAddr,
      toAddresses: toAddrs,
      ccAddresses: ccAddrs,
      subject: parsed.subject ?? "(no subject)",
      receivedAt: stored.received_at,
      rawS3Url,
      attachmentCount: attachmentMeta.length,
    }),
    metadata: {
      bucket,
      object_key: obj.key,
    },
  });

  // Threading: link this inbound to an existing thread if it replies to one
  // of our sent emails (via In-Reply-To / References / own Message-ID).
  try {
    const { resolveThreadForInbound, setInboundThreadId } = await import("../db/threads.local.js");
    const { uuid } = await import("../db/database.js");
    const { thread_id, parent_email_id } = resolveThreadForInbound(headerObj, uuid(), db);
    setInboundThreadId(stored.id, thread_id, db);
    if (parent_email_id) db.run("UPDATE inbound_emails SET in_reply_to_email_id = ? WHERE id = ?", [parent_email_id, stored.id]);
  } catch { /* threading is best-effort */ }

  result.synced++;
  result.last_key = obj.key;

  // Save attachment files
  if (attachmentMeta.length > 0 && syncConfig.attachment_storage !== "none") {
    const paths: AttachmentPath[] = [];

    for (const attachment of attachmentPlans) {
      if (syncConfig.attachment_storage === "s3") {
        if (!syncConfig.s3_bucket) {
          result.errors.push(`S3 upload ${attachment.storageLeaf}: attachment_s3_bucket is required when attachment_storage=s3`);
          continue;
        }
        try {
          const { S3Client: S3C, PutObjectCommand } = await loadS3Sdk();
          const client = new S3C({ region: syncConfig.s3_region ?? "us-east-1" });
          const s3Key = attachmentS3Key(syncConfig.s3_prefix, stored.id, attachment.storageLeaf);
          await client.send(new PutObjectCommand({
            Bucket: syncConfig.s3_bucket,
            Key: s3Key,
            Body: attachment.content,
            ContentType: attachment.content_type,
          }));
          paths.push({
            index: attachment.index,
            filename: attachment.filename,
            content_type: attachment.content_type,
            size: attachment.size,
            s3_url: `s3://${syncConfig.s3_bucket}/${s3Key}`,
          });
          emitEmailsEventBestEffort({
            type: "emails.inbound.attachment.saved",
            subject: stored.id,
            severity: "info",
            dedupeKey: `emails:inbound:attachment:${stored.id}:${attachment.storageLeaf}`,
            message: "Inbound attachment stored",
            data: {
              email_id: stored.id,
              filename: attachment.filename,
              storage_leaf: attachment.storageLeaf,
              content_type: attachment.content_type,
              size: attachment.size,
              storage: "s3",
              uri: `s3://${syncConfig.s3_bucket}/${s3Key}`,
            },
          });
        } catch (e) {
          result.errors.push(`S3 upload ${attachment.storageLeaf}: ${String(e)}`);
          continue;
        }
      } else if (syncConfig.attachment_storage === "local") {
        const outputDir = getAttachmentDir(stored.id);
        const path = storeLocalAttachment(attachment, outputDir);
        paths.push(path);
        emitEmailsEventBestEffort({
          type: "emails.inbound.attachment.saved",
          subject: stored.id,
          severity: "info",
          dedupeKey: `emails:inbound:attachment:${stored.id}:${attachment.storageLeaf}`,
          message: "Inbound attachment stored",
          data: {
            email_id: stored.id,
            filename: attachment.filename,
            storage_leaf: attachment.storageLeaf,
            content_type: attachment.content_type,
            size: attachment.size,
            storage: "local",
            uri: path.local_path,
          },
        });
      }
      result.attachments_saved++;
    }

    if (paths.length > 0) updateAttachmentPaths(stored.id, paths, db);
  }
}

/** @internal Pure/local seams for deterministic attachment-storage tests. */
export const s3SyncLocalTestBoundary = {
  attachmentS3Key,
  buildAttachmentStoragePlans,
  storeLocalAttachment,
};

/**
 * Download and parse a raw RFC 2822 email from S3.
 */
async function fetchAndParseEmail(s3: S3Client, s3Sdk: S3Sdk, bucket: string, key: string) {
  const { GetObjectCommand } = s3Sdk;
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty S3 object: ${key}`);

  // Stream to buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const rawEmail = Buffer.concat(chunks);

  const { simpleParser } = await loadMailparser();
  return simpleParser(rawEmail);
}

/**
 * Flatten mailparser headers (a Map, or object) into a plain string record.
 * Object.entries(Map) is empty, so a Map must be iterated explicitly.
 */
function flattenHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: Iterable<[string, unknown]> =
    headers instanceof Map ? headers.entries() : Object.entries(headers as Record<string, unknown>);
  for (const [k, v] of entries) {
    out[k] =
      typeof v === "string" ? v
      : Array.isArray(v) ? v.map(String).join(" ")
      : (v && typeof v === "object" && "text" in (v as Record<string, unknown>)) ? String((v as Record<string, unknown>).text)
      : String(v);
  }
  return out;
}

export async function syncS3Inbox(opts: S3SyncOptions): Promise<S3SyncResult> {
  opts = resolveS3SourceForSync(opts);
  const bucket = opts.bucket;
  if (!bucket) throw new Error("No S3 bucket: pass bucket or sourceId");
  const db = opts.db ?? getDatabase();
  const { s3, s3Sdk } = await makeS3Client(opts);
  const prefix = opts.prefix ?? "";
  const requestedLimit = Math.trunc(opts.limit ?? 100);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;

  // Resolve a possibly-partial provider id to the full id so the inbound
  // foreign key (provider_id -> providers.id) is satisfied. Passing a short id
  // (e.g. "45c38857") previously failed with "FOREIGN KEY constraint failed".
  let providerId: string | null = opts.providerId ?? null;
  if (providerId) {
    const resolved = resolvePartialId(db, "providers", providerId);
    if (!resolved) throw new Error(`Provider not found: ${providerId}`);
    providerId = resolved;
  }
  backfillLegacyS3RawUrls([{ bucket, providerId }], db);
  const syncConfig = getInboundAttachmentStorageConfig();
  const result: S3SyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [] };
  const exactKeys = normalizeExactObjectKeys(opts.keys, prefix);

  if (exactKeys.length > 0) {
    const existingS3Urls = getExistingS3Urls(db, exactKeys.map((key) => s3ObjectUrl(bucket, key)));
    for (const key of exactKeys.slice(0, limit)) {
      const rawS3Url = s3ObjectUrl(bucket, key);
      if (existingS3Urls.has(rawS3Url)) {
        tagExistingS3Provider(db, rawS3Url, providerId);
        result.skipped++;
        result.last_key = key;
        continue;
      }
      try {
        await processS3Object(db, s3, s3Sdk, syncConfig, bucket, providerId, { key, size: 0 }, result);
      } catch (e) {
        result.errors.push(`${key}: ${String(e)}`);
      }
    }
    if (result.last_key) setLastSyncedKey(bucket, prefix, result.last_key);
    return result;
  }

  let continuationToken: string | undefined;
  let attemptedNewObjects = 0;
  do {
    let page: Awaited<ReturnType<typeof listObjectPage>>;
    try {
      page = await listObjectPage(s3, s3Sdk, bucket, prefix, continuationToken);
    } catch (e) {
      result.errors.push(`Failed to list S3 objects: ${String(e)}`);
      return result;
    }

    const existingS3Urls = getExistingS3Urls(db, page.objects.map((object) => s3ObjectUrl(bucket, object.key)));
    for (const obj of page.objects) {
      const rawS3Url = s3ObjectUrl(bucket, obj.key);
      if (existingS3Urls.has(rawS3Url)) {
        tagExistingS3Provider(db, rawS3Url, providerId);
        result.skipped++;
        result.last_key = obj.key;
        continue;
      }

      if (attemptedNewObjects >= limit) break;
      attemptedNewObjects++;
      try {
        await processS3Object(db, s3, s3Sdk, syncConfig, bucket, providerId, obj, result);
      } catch (e) {
        result.errors.push(`${obj.key}: ${String(e)}`);
      }
    }

    if (attemptedNewObjects >= limit) break;
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);

  // Persist last synced key
  if (result.last_key) {
    setLastSyncedKey(bucket, prefix, result.last_key);
  }

  return result;
}
