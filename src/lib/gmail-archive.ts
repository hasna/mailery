import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface GmailArchiveKeyInput {
  profile: string;
  messageId: string;
  prefix?: string;
}

export interface GmailArchiveKeys {
  raw: string;
  metadata: string;
  manifest: string;
  attachmentsPrefix: string;
}

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
  region?: string;
  limit?: number;
  dryRun?: boolean;
  client?: S3Like;
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

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]+/g, "_");
}

export function buildGmailArchiveKeys(input: GmailArchiveKeyInput): GmailArchiveKeys {
  const prefix = (input.prefix ?? "gmail").replace(/^\/+|\/+$/g, "");
  const profile = safeSegment(input.profile || "default");
  const messageId = safeSegment(input.messageId);
  return {
    raw: `${prefix}/${profile}/raw/${messageId}.eml`,
    metadata: `${prefix}/${profile}/metadata/${messageId}.json`,
    manifest: `${prefix}/${profile}/manifests/${messageId}.json`,
    attachmentsPrefix: `${prefix}/${profile}/attachments/${messageId}/`,
  };
}

export async function uploadGmailArchive(input: GmailArchiveUploadInput): Promise<GmailArchiveUploadResult> {
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
  const client = input.client ?? new S3Client({ region: input.region ?? "us-east-1" });
  const keys = buildGmailArchiveKeys(input);
  const filename = safeSegment(input.filename);
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
  const client = input.client ?? new S3Client({ region: input.region ?? "us-east-1" });
  const keys = buildGmailArchiveKeys(input);
  const required = [
    keys.metadata,
    keys.manifest,
    ...(input.requireRaw === false ? [] : [keys.raw]),
    ...(input.expectedAttachments ?? []).map((filename) => `${keys.attachmentsPrefix}${safeSegment(filename)}`),
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
  const client = input.client ?? new S3Client({ region: input.region ?? "us-east-1" });
  const sourcePrefix = input.sourcePrefix ?? "";
  const targetPrefix = (input.targetPrefix ?? "").replace(/^\/+|\/+$/g, "");
  const listed = await client.send(new ListObjectsV2Command({
    Bucket: input.sourceBucket,
    Prefix: sourcePrefix,
    MaxKeys: input.limit,
  })) as { Contents?: Array<{ Key?: string }>; NextContinuationToken?: string };
  const objects = (listed.Contents ?? []).filter((obj): obj is { Key: string } => Boolean(obj.Key));
  const migrated: Array<{ source: string; target: string }> = [];
  for (const object of objects) {
    const relative = sourcePrefix && object.Key.startsWith(sourcePrefix)
      ? object.Key.slice(sourcePrefix.length).replace(/^\/+/, "")
      : object.Key;
    const target = targetPrefix ? `${targetPrefix}/${relative}` : relative;
    migrated.push({ source: object.Key, target });
    if (!input.dryRun) {
      await client.send(new CopyObjectCommand({
        Bucket: input.targetBucket,
        Key: target,
        CopySource: `${input.sourceBucket}/${encodeS3CopySourceKey(object.Key)}`,
      }));
    }
  }
  return {
    scanned: objects.length,
    copied: input.dryRun ? 0 : objects.length,
    dryRun: Boolean(input.dryRun),
    objects: migrated,
    nextContinuationToken: listed.NextContinuationToken,
  };
}

function encodeS3CopySourceKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
