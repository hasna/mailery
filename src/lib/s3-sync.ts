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
import { storeInboundEmail, updateAttachmentPaths } from "../db/inbound.js";
import type { AttachmentPath } from "../db/inbound.js";
import { getDatabase, getDataDir, resolvePartialId } from "../db/database.js";
import { loadConfig, saveConfig, getGmailSyncConfig } from "./config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/database.js";

export interface S3SyncOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  providerId?: string;
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

function getExistingMessageIds(db: Database, messageIds: string[]): Set<string> {
  const unique = [...new Set(messageIds.filter(Boolean))];
  const existing = new Set<string>();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .query(`SELECT message_id FROM inbound_emails WHERE message_id IN (${placeholders})`)
      .all(...chunk) as Array<{ message_id: string | null }>;
    for (const row of rows) {
      if (row.message_id) existing.add(row.message_id);
    }
  }
  return existing;
}

async function processS3Object(
  db: Database,
  s3: S3Client,
  s3Sdk: S3Sdk,
  syncConfig: ReturnType<typeof getGmailSyncConfig>,
  bucket: string,
  providerId: string | null,
  obj: { key: string; size: number },
  result: S3SyncResult,
): Promise<void> {
  const parsed = await fetchAndParseEmail(s3, s3Sdk, bucket, obj.key);

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

  const attachmentMeta = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename ?? "attachment",
    content_type: a.contentType ?? "application/octet-stream",
    size: a.size ?? 0,
  }));

  const headerObj = flattenHeaders(parsed.headers);

  const stored = storeInboundEmail({
    provider_id: providerId,
    message_id: obj.key,
    in_reply_to_email_id: null,
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

  // Threading: link this inbound to an existing thread if it replies to one
  // of our sent emails (via In-Reply-To / References / own Message-ID).
  try {
    const { resolveThreadForInbound, setInboundThreadId } = await import("../db/threads.js");
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
    const outputDir = getAttachmentDir(stored.id);

    for (const att of parsed.attachments ?? []) {
      const filename = att.filename ?? `attachment_${paths.length + 1}`;
      const safeName = filename.replace(/[/\\?%*:|"<>]/g, "_");

      if (syncConfig.attachment_storage === "s3" && syncConfig.s3_bucket) {
        try {
          const { S3Client: S3C, PutObjectCommand } = await loadS3Sdk();
          const client = new S3C({ region: syncConfig.s3_region ?? "us-east-1" });
          const s3Key = `${syncConfig.s3_prefix ?? "emails"}/${stored.id}/${safeName}`;
          await client.send(new PutObjectCommand({
            Bucket: syncConfig.s3_bucket,
            Key: s3Key,
            Body: att.content,
            ContentType: att.contentType ?? "application/octet-stream",
          }));
          paths.push({ filename: safeName, content_type: att.contentType ?? "", size: att.size ?? 0, s3_url: `s3://${syncConfig.s3_bucket}/${s3Key}` });
        } catch (e) {
          result.errors.push(`S3 upload ${safeName}: ${String(e)}`);
        }
      } else {
        const filePath = join(outputDir, safeName);
        writeFileSync(filePath, att.content);
        paths.push({ filename: safeName, content_type: att.contentType ?? "", size: att.size ?? 0, local_path: filePath });
      }
      result.attachments_saved++;
    }

    if (paths.length > 0) updateAttachmentPaths(stored.id, paths, db);
  }
}

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
  const syncConfig = getGmailSyncConfig();
  const result: S3SyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [] };

  let continuationToken: string | undefined;
  let attemptedNewObjects = 0;
  do {
    let page: Awaited<ReturnType<typeof listObjectPage>>;
    try {
      page = await listObjectPage(s3, s3Sdk, opts.bucket, prefix, continuationToken);
    } catch (e) {
      result.errors.push(`Failed to list S3 objects: ${String(e)}`);
      return result;
    }

    const existingMessageIds = getExistingMessageIds(db, page.objects.map((object) => object.key));
    for (const obj of page.objects) {
      if (existingMessageIds.has(obj.key)) {
        result.skipped++;
        result.last_key = obj.key;
        continue;
      }

      if (attemptedNewObjects >= limit) break;
      attemptedNewObjects++;
      try {
        await processS3Object(db, s3, s3Sdk, syncConfig, opts.bucket, providerId, obj, result);
      } catch (e) {
        result.errors.push(`${obj.key}: ${String(e)}`);
      }
    }

    if (attemptedNewObjects >= limit) break;
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);

  // Persist last synced key
  if (result.last_key) {
    setLastSyncedKey(opts.bucket, prefix, result.last_key);
  }

  return result;
}
