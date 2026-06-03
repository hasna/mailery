/**
 * S3 inbox sync — polls an S3 bucket for raw emails stored by SES receipt rules
 * and stores them in the local inbound_emails DB.
 *
 * Flow:
 *   SES receipt rule → S3 bucket (raw RFC 2822) → this sync → inbound_emails table
 *
 * Uses mailparser to parse raw RFC 2822 email files.
 * Tracks last-synced S3 key in config so only new emails are fetched.
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { simpleParser } from "mailparser";
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

function makeS3Client(opts: S3SyncOptions): S3Client {
  const region = opts.region || process.env["AWS_REGION"] || "us-east-1";
  const credentials = opts.accessKeyId && opts.secretAccessKey
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
    : undefined;
  return new S3Client({ region, credentials });
}

function getLastSyncedKey(bucket: string, prefix: string): string | undefined {
  const config = loadConfig();
  const key = `s3_sync_last_key_${bucket}_${prefix.replace(/\//g, "_")}`;
  return config[key] as string | undefined;
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

/**
 * List new S3 objects since last sync (using StartAfter for efficient pagination).
 */
async function listNewObjects(
  s3: S3Client,
  bucket: string,
  prefix: string,
  _lastKey: string | undefined,
  limit: number,
): Promise<{ key: string; size: number; lastModified?: Date }[]> {
  // NOTE: SES inbound stores objects under RANDOM keys, so a key-ordered cursor
  // (StartAfter: lastKey) silently skips any later-arriving object whose key
  // sorts before the last-synced key. We therefore paginate the FULL prefix and
  // rely on dedup-by-key in syncS3Inbox for idempotency. `limit` caps how many
  // objects we examine per run (callers raise it for large backlogs).
  const objects: { key: string; size: number; lastModified?: Date }[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));

    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.Key !== prefix) {
        objects.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified });
      }
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken && objects.length < limit);

  return objects.slice(0, limit);
}

/**
 * Download and parse a raw RFC 2822 email from S3.
 */
async function fetchAndParseEmail(s3: S3Client, bucket: string, key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty S3 object: ${key}`);

  // Stream to buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const rawEmail = Buffer.concat(chunks);

  return simpleParser(rawEmail);
}

/**
 * Sync new emails from S3 into the local inbound_emails table.
 */
export async function syncS3Inbox(opts: S3SyncOptions): Promise<S3SyncResult> {
  const db = opts.db ?? getDatabase();
  const s3 = makeS3Client(opts);
  const prefix = opts.prefix ?? "";
  const limit = opts.limit ?? 100;

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

  // Get last synced key for incremental sync
  const lastKey = getLastSyncedKey(opts.bucket, prefix);

  // List new objects
  let objects: { key: string; size: number }[];
  try {
    objects = await listNewObjects(s3, opts.bucket, prefix, lastKey, limit);
  } catch (e) {
    result.errors.push(`Failed to list S3 objects: ${String(e)}`);
    return result;
  }

  if (objects.length === 0) return result;

  for (const obj of objects) {
    try {
      // Dedup by S3 key stored as message_id
      const existing = db
        .query("SELECT id FROM inbound_emails WHERE message_id = ? LIMIT 1")
        .get(obj.key);
      if (existing) {
        result.skipped++;
        result.last_key = obj.key;
        continue;
      }

      // Download + parse
      const parsed = await fetchAndParseEmail(s3, opts.bucket, obj.key);

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

      // Attachment metadata
      const attachmentMeta = (parsed.attachments ?? []).map((a) => ({
        filename: a.filename ?? "attachment",
        content_type: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
      }));

      const stored = storeInboundEmail({
        provider_id: providerId,
        message_id: obj.key, // use S3 key as message ID for dedup
        in_reply_to_email_id: null,
        from_address: fromAddr,
        to_addresses: toAddrs,
        cc_addresses: ccAddrs,
        subject: parsed.subject ?? "(no subject)",
        text_body: parsed.text ?? null,
        html_body: typeof parsed.html === "string" ? parsed.html : null,
        attachments: attachmentMeta,
        attachment_paths: [],
        headers: Object.fromEntries(
          Object.entries(parsed.headers ?? {}).map(([k, v]) => [k, String(v)])
        ),
        raw_size: obj.size,
        received_at: (parsed.date ?? new Date()).toISOString(),
      }, db);

      // Threading: link this inbound to an existing thread if it replies to one
      // of our sent emails (via In-Reply-To / References), else start a new one.
      try {
        const headerObj = Object.fromEntries(
          Object.entries(parsed.headers ?? {}).map(([k, v]) => [k, String(v)]),
        );
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
              const { S3Client: S3C, PutObjectCommand } = await import("@aws-sdk/client-s3");
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
    } catch (e) {
      result.errors.push(`${obj.key}: ${String(e)}`);
    }
  }

  // Persist last synced key
  if (result.last_key) {
    setLastSyncedKey(opts.bucket, prefix, result.last_key);
  }

  return result;
}
