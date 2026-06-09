import type { PutObjectCommandInput } from "@aws-sdk/client-s3";
import { buildGmailArchiveKeys, safeGmailArchiveSegment } from "./gmail-archive-keys.js";
import type { GmailArchiveKeyInput } from "./gmail-archive-keys.js";

export { buildGmailArchiveKeys } from "./gmail-archive-keys.js";
export type { GmailArchiveKeyInput, GmailArchiveKeys } from "./gmail-archive-keys.js";

export interface GmailArchiveUploadInput extends GmailArchiveKeyInput {
  bucket: string;
  region?: string;
  raw?: string;
  metadata: unknown;
  client?: S3Like;
}

export interface GmailArchiveUploadResult {
  raw_s3_url?: string;
  metadata_s3_url: string;
  manifest_s3_url?: string;
}

export interface GmailArchiveAttachmentInput extends GmailArchiveKeyInput {
  bucket: string;
  region?: string;
  filename: string;
  body: Uint8Array | Buffer | string;
  contentType?: string;
  client?: S3Like;
}

export interface GmailArchiveAttachmentResult {
  filename: string;
  key: string;
  s3_url: string;
}

export interface GmailArchiveManifest {
  profile: string;
  message_id: string;
  raw_s3_url?: string;
  metadata_s3_url: string;
  attachments: Array<{
    filename: string;
    s3_url: string;
    content_type?: string;
    size?: number;
  }>;
  archived_at: string;
}

export interface GmailArchiveManifestInput extends GmailArchiveKeyInput {
  bucket: string;
  region?: string;
  manifest: GmailArchiveManifest;
  client?: S3Like;
}

export interface GmailArchiveVerifyInput extends GmailArchiveKeyInput {
  bucket: string;
  region?: string;
  expectedAttachments?: string[];
  requireRaw?: boolean;
  client?: S3Like;
}

export interface GmailArchiveVerifyResult {
  bucket: string;
  profile: string;
  messageId: string;
  ok: boolean;
  checked: string[];
  missing: string[];
}

export interface S3PrefixMigrationInput {
  sourceBucket: string;
  targetBucket: string;
  sourcePrefix?: string;
  targetPrefix?: string;
  continuationToken?: string;
  region?: string;
  limit?: number;
  dryRun?: boolean;
  client?: S3Like;
  sourceClient?: S3Like;
  targetClient?: S3Like;
}

export interface S3PrefixMigrationResult {
  scanned: number;
  copied: number;
  dryRun: boolean;
  objects: Array<{ source: string; target: string }>;
  nextContinuationToken?: string;
}

export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

type S3Sdk = typeof import("@aws-sdk/client-s3");

let s3SdkPromise: Promise<S3Sdk> | undefined;

function loadS3Sdk(): Promise<S3Sdk> {
  s3SdkPromise ??= import("@aws-sdk/client-s3");
  return s3SdkPromise;
}

export async function uploadGmailArchive(input: GmailArchiveUploadInput): Promise<GmailArchiveUploadResult> {
  const { PutObjectCommand, S3Client } = await loadS3Sdk();
  const client = input.client ?? new S3Client({ region: input.region ?? "us-east-1" });
  const keys = buildGmailArchiveKeys(input);

  const metadataBody = JSON.stringify(input.metadata, null, 2);
  await client.send(new PutObjectCommand({
    Bucket: input.bucket,
    Key: keys.metadata,
    Body: metadataBody,
    ContentType: "application/json",
  }));

  const result: GmailArchiveUploadResult = {
    metadata_s3_url: `s3://${input.bucket}/${keys.metadata}`,
  };

  if (input.raw) {
    await client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: keys.raw,
      Body: Buffer.from(input.raw, "base64url"),
      ContentType: "message/rfc822",
    }));
    result.raw_s3_url = `s3://${input.bucket}/${keys.raw}`;
  }

  return result;
}

export async function uploadGmailArchiveAttachment(input: GmailArchiveAttachmentInput): Promise<GmailArchiveAttachmentResult> {
  const { PutObjectCommand, S3Client } = await loadS3Sdk();
  const client = input.client ?? new S3Client({ region: input.region ?? "us-east-1" });
  const keys = buildGmailArchiveKeys(input);
  const filename = safeGmailArchiveSegment(input.filename);
  const key = `${keys.attachmentsPrefix}${filename}`;
  await client.send(new PutObjectCommand({
    Bucket: input.bucket,
    Key: key,
    Body: input.body,
    ContentType: input.contentType ?? "application/octet-stream",
  }));
  return {
    filename: input.filename,
    key,
    s3_url: `s3://${input.bucket}/${key}`,
  };
}

export async function uploadGmailArchiveManifest(input: GmailArchiveManifestInput): Promise<string> {
  const { PutObjectCommand, S3Client } = await loadS3Sdk();
  const client = input.client ?? new S3Client({ region: input.region ?? "us-east-1" });
  const keys = buildGmailArchiveKeys(input);
  await client.send(new PutObjectCommand({
    Bucket: input.bucket,
    Key: keys.manifest,
    Body: JSON.stringify(input.manifest, null, 2),
    ContentType: "application/json",
  }));
  return `s3://${input.bucket}/${keys.manifest}`;
}

export async function verifyGmailArchive(input: GmailArchiveVerifyInput): Promise<GmailArchiveVerifyResult> {
  const { HeadObjectCommand, S3Client } = await loadS3Sdk();
  const client = input.client ?? new S3Client({ region: input.region ?? "us-east-1" });
  const keys = buildGmailArchiveKeys(input);
  const required = [
    keys.metadata,
    keys.manifest,
    ...(input.requireRaw === false ? [] : [keys.raw]),
    ...(input.expectedAttachments ?? []).map((filename) => `${keys.attachmentsPrefix}${safeGmailArchiveSegment(filename)}`),
  ];
  const checked: string[] = [];
  const missing: string[] = [];
  for (const key of required) {
    checked.push(key);
    try {
      await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: key }));
    } catch {
      missing.push(key);
    }
  }
  return {
    bucket: input.bucket,
    profile: input.profile,
    messageId: input.messageId,
    ok: missing.length === 0,
    checked,
    missing,
  };
}

export async function migrateS3Prefix(input: S3PrefixMigrationInput): Promise<S3PrefixMigrationResult> {
  const { CopyObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } = await loadS3Sdk();
  const client = input.client ?? new S3Client({ region: input.region ?? "us-east-1" });
  const sourceClient = input.sourceClient ?? client;
  const targetClient = input.targetClient ?? client;
  const canUseServerSideCopy = sourceClient === targetClient;
  const sourcePrefix = input.sourcePrefix ?? "";
  const targetPrefix = (input.targetPrefix ?? "").replace(/^\/+|\/+$/g, "");
  const migrated: Array<{ source: string; target: string }> = [];
  let continuationToken: string | undefined = input.continuationToken;
  let nextContinuationToken: string | undefined;

  do {
    const remaining = input.limit ? input.limit - migrated.length : undefined;
    if (remaining !== undefined && remaining <= 0) break;
    const listed = await sourceClient.send(new ListObjectsV2Command({
      Bucket: input.sourceBucket,
      Prefix: sourcePrefix,
      MaxKeys: remaining !== undefined ? Math.min(remaining, 1000) : undefined,
      ContinuationToken: continuationToken,
    })) as { Contents?: Array<{ Key?: string }>; NextContinuationToken?: string };
    const objects = (listed.Contents ?? []).filter((obj): obj is { Key: string } => Boolean(obj.Key));
    for (const object of objects) {
      const relative = sourcePrefix && object.Key.startsWith(sourcePrefix)
        ? object.Key.slice(sourcePrefix.length).replace(/^\/+/, "")
        : object.Key;
      const target = targetPrefix ? `${targetPrefix}/${relative}` : relative;
      migrated.push({ source: object.Key, target });
      if (!input.dryRun) {
        if (canUseServerSideCopy) {
          await targetClient.send(new CopyObjectCommand({
            Bucket: input.targetBucket,
            Key: target,
            CopySource: `${input.sourceBucket}/${encodeS3CopySourceKey(object.Key)}`,
          }));
        } else {
          const source = await sourceClient.send(new GetObjectCommand({
            Bucket: input.sourceBucket,
            Key: object.Key,
          })) as { Body?: unknown; ContentType?: string };
          await targetClient.send(new PutObjectCommand({
            Bucket: input.targetBucket,
            Key: target,
            Body: await materializeS3Body(source.Body),
            ContentType: source.ContentType,
          }));
        }
      }
    }
    continuationToken = listed.NextContinuationToken;
    nextContinuationToken = listed.NextContinuationToken;
  } while (continuationToken && (!input.limit || migrated.length < input.limit));

  return {
    scanned: migrated.length,
    copied: input.dryRun ? 0 : migrated.length,
    dryRun: Boolean(input.dryRun),
    objects: migrated,
    nextContinuationToken,
  };
}

function encodeS3CopySourceKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function materializeS3Body(body: unknown): Promise<PutObjectCommandInput["Body"]> {
  if (body == null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return body as PutObjectCommandInput["Body"];
  }
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    return Buffer.from(await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  }
  if (Symbol.asyncIterator in Object(body)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }
  return body as PutObjectCommandInput["Body"];
}
