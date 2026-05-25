/**
 * Gmail inbox sync via @hasna/connectors SDK operations.
 *
 * All Gmail API calls go through the connectors layer — no direct Gmail SDK
 * and no direct connector CLI stdout parsing in this package.
 *
 * Features:
 * - Full message fetch with text + HTML body (--body --html flags)
 * - Attachment download via connector attachments download --dir
 * - Optional S3 upload after local download
 * - Pagination via nextPageToken
 * - Dedup by (provider_id, message_id) — safe to re-run
 * - Per-message error isolation
 */

import { runConnectorOperation } from "@hasna/connectors";
import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { storeInboundEmail, updateAttachmentPaths, listInboundEmails } from "../db/inbound.js";
import type { AttachmentPath } from "../db/inbound.js";
import { getDatabase, getDataDir } from "../db/database.js";
import { getGmailSyncConfig } from "./config.js";
import { uploadGmailArchive, uploadGmailArchiveAttachment, uploadGmailArchiveManifest } from "./gmail-archive.js";
import type { Database } from "../db/database.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConnectorSyncOptions {
  /** open-emails provider ID */
  providerId: string;
  /** Gmail label ID, e.g. "INBOX", "SENT". Default: "INBOX" */
  labelFilter?: string;
  /** Gmail search query, e.g. "is:unread from:someone@example.com" */
  query?: string;
  /** Max messages per batch fetch. Default: 50 */
  batchSize?: number;
  /** Total max messages to sync in this run */
  maxMessages?: number;
  /** Only fetch messages after this ISO date string */
  since?: string;
  /** Resume pagination from this page token */
  pageToken?: string;
  /** Connector Gmail profile name */
  profile?: string;
  /** Archive raw MIME and metadata to this S3 bucket for this run. */
  archiveS3Bucket?: string;
  /** Download and store attachment files. Default: true */
  downloadAttachments?: boolean;
  db?: Database;
}

/** @deprecated Use ConnectorSyncOptions */
export type GmailSyncOptions = ConnectorSyncOptions;

export interface GmailSyncResult {
  synced: number;
  skipped: number;
  attachments_saved: number;
  errors: string[];
  nextPageToken?: string;
  done: boolean;
}

interface ConnectorOperationResponse<T> {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  data?: T;
}

interface GmailListMessage {
  id: string;
  threadId?: string;
}

interface GmailListMessagesEnvelope {
  messages?: GmailListMessage[];
  nextPageToken?: string;
}

interface GmailMessageDetail {
  id: string;
  threadId?: string;
  labelIds?: string[];
  historyId?: string;
  internalDate?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  body?: string;
  snippet?: string;
  size?: number;
  raw?: string;
}

interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

type GmailConnectorInput = Record<string, unknown> & {
  args?: Array<string | number | boolean>;
};

async function runGmailOperation<T>(
  operation: string,
  input: GmailConnectorInput,
  profile?: string,
): Promise<ConnectorOperationResponse<T>> {
  return runConnectorOperation<T>({
    connector: "gmail",
    operation,
    input,
    profile,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date().toISOString();
}

function parseAddresses(addrStr: string | undefined): string[] {
  if (!addrStr) return [];
  return addrStr.split(",").map((a) => a.trim()).filter(Boolean);
}

function buildQuery(opts: ConnectorSyncOptions): string | undefined {
  const parts: string[] = [];
  if (opts.query) parts.push(opts.query);
  if (opts.since) {
    const d = new Date(opts.since);
    if (!isNaN(d.getTime())) {
      parts.push(
        `after:${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function getAttachmentDir(emailId: string): string {
  const dir = join(getDataDir(), "attachments", emailId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Core sync ────────────────────────────────────────────────────────────────

/**
 * Sync one page of Gmail messages into the inbound_emails table.
 * Uses the connectors SDK for all Gmail API calls.
 */
export async function syncGmailInbox(opts: ConnectorSyncOptions): Promise<GmailSyncResult> {
  const db = opts.db ?? getDatabase();
  const batchSize = opts.batchSize ?? 50;
  const downloadAttachments = opts.downloadAttachments ?? true;
  const syncConfig = getGmailSyncConfig();
  const result: GmailSyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], done: true };

  const q = buildQuery(opts);

  // List messages
  const listResult = await runGmailOperation<GmailListMessage[] | GmailListMessagesEnvelope>(
    "messages.list",
    {
      max: batchSize,
      ...(opts.labelFilter ? { label: opts.labelFilter } : {}),
      ...(q ? { query: q } : {}),
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
    },
    opts.profile,
  );
  if (!listResult.success) {
    result.errors.push(`Failed to list messages: ${listResult.stderr || listResult.stdout}`);
    return result;
  }

  let messages: GmailListMessage[];
  let nextPageToken: string | undefined;
  const parsed = listResult.data;
  if (Array.isArray(parsed)) {
    messages = parsed;
  } else if (parsed && typeof parsed === "object") {
    const env = parsed as GmailListMessagesEnvelope;
    messages = env.messages ?? [];
    if (env.nextPageToken) {
      nextPageToken = env.nextPageToken;
      result.nextPageToken = nextPageToken;
      result.done = false;
    }
  } else {
    result.errors.push("Failed to read structured message list from Gmail connector operation");
    return result;
  }

  const capped = opts.maxMessages != null ? messages.slice(0, opts.maxMessages) : messages;

  for (const msgRef of capped) {
    if (!msgRef.id) continue;

    try {
      // Dedup
      const existing = db
        .query("SELECT id FROM inbound_emails WHERE provider_id = ? AND message_id = ? LIMIT 1")
        .get(opts.providerId, msgRef.id);
      if (existing) {
        result.skipped++;
        continue;
      }

      // Fetch full message — two calls: text body + HTML body
      // (connector returns only one body per call based on --html flag)
      const readTextResult = await runGmailOperation<GmailMessageDetail>(
        "messages.read",
        { args: [msgRef.id], body: true },
        opts.profile,
      );
      const detail = readTextResult.data ?? { id: msgRef.id };

      const textBody = detail.body || detail.snippet || null;
      const receivedAt = parseDate(detail.date ?? "");

      // Fetch HTML body separately
      let htmlBody: string | null = null;
      if (readTextResult.success) {
        const readHtmlResult = await runGmailOperation<GmailMessageDetail>(
          "messages.read",
          { args: [msgRef.id], body: true, html: true },
          opts.profile,
        );
        const htmlDetail = readHtmlResult.data;
        // Only use if it differs from text (indicates actual HTML content)
        if (htmlDetail?.body && htmlDetail.body !== textBody) {
          htmlBody = htmlDetail.body;
        }
      }

      // List attachments metadata
      const attListResult = await runGmailOperation<GmailAttachmentMeta[]>(
        "attachments.list",
        { args: [msgRef.id] },
        opts.profile,
      );
      const attachmentList = attListResult.success && Array.isArray(attListResult.data)
        ? attListResult.data
        : [];

      const attachmentMeta = attachmentList.map((a) => ({
        filename: a.filename,
        content_type: a.mimeType,
        size: a.size,
      }));

      let rawS3Url: string | null = null;
      let metadataS3Url: string | null = null;
      const archiveBucket = opts.archiveS3Bucket ?? syncConfig.archive_s3_bucket;
      if (archiveBucket) {
        let raw: string | undefined = detail.raw;
        if (!raw) {
          const rawResult = await runGmailOperation<{ raw?: string }>(
            "messages.getRaw",
            { args: [msgRef.id] },
            opts.profile,
          );
          raw = rawResult.data?.raw;
        }

        const archive = await uploadGmailArchive({
          bucket: archiveBucket,
          region: syncConfig.s3_region,
          prefix: syncConfig.archive_s3_prefix,
          profile: opts.profile ?? opts.providerId,
          messageId: msgRef.id,
          raw,
          metadata: {
            message: detail,
            attachments: attachmentList,
          },
        });
        rawS3Url = archive.raw_s3_url ?? null;
        metadataS3Url = archive.metadata_s3_url;
      }

      // Store email
      const stored = storeInboundEmail(
        {
          provider_id: opts.providerId,
          message_id: msgRef.id,
          in_reply_to_email_id: null,
          provider_thread_id: detail.threadId ?? msgRef.threadId ?? null,
          provider_history_id: detail.historyId ?? null,
          provider_internal_date: detail.internalDate ?? null,
          label_ids: detail.labelIds ?? [],
          raw_s3_url: rawS3Url,
          metadata_s3_url: metadataS3Url,
          from_address: detail.from ?? "",
          to_addresses: parseAddresses(detail.to),
          cc_addresses: parseAddresses(detail.cc),
          subject: detail.subject ?? "(no subject)",
          text_body: textBody,
          html_body: htmlBody,
          attachments: attachmentMeta,
          attachment_paths: [],
          headers: {},
          raw_size: detail.size ?? 0,
          received_at: receivedAt,
        },
        db,
      );

      result.synced++;

      // Download attachments
      let manifestUploaded = false;
      if (downloadAttachments && attachmentList.length > 0 && syncConfig.attachment_storage !== "none") {
        const outputDir = getAttachmentDir(stored.id);
        const dlResult = await runGmailOperation(
          "attachments.download",
          { args: [msgRef.id], dir: outputDir },
          opts.profile,
        );

        if (dlResult.success) {
          // Scan outputDir for downloaded files
          const paths: AttachmentPath[] = [];
          try {
            const files = readdirSync(outputDir);
            for (const file of files) {
              const filePath = join(outputDir, file);
              const stat = statSync(filePath);
              const meta = attachmentMeta.find((a) => a.filename === file);

              if (archiveBucket) {
                try {
                  const uploaded = await uploadGmailArchiveAttachment({
                    bucket: archiveBucket,
                    region: syncConfig.s3_region,
                    prefix: syncConfig.archive_s3_prefix,
                    profile: opts.profile ?? opts.providerId,
                    messageId: msgRef.id,
                    filename: file,
                    body: readFileSync(filePath),
                    contentType: meta?.content_type ?? "application/octet-stream",
                  });
                  paths.push({ filename: file, content_type: meta?.content_type ?? "", size: stat.size, s3_url: uploaded.s3_url });
                } catch (e) {
                  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
                  result.errors.push(`Archive attachment upload ${file}: ${detail}`);
                  paths.push({ filename: file, content_type: meta?.content_type ?? "", size: stat.size, local_path: filePath });
                }
              } else if (syncConfig.attachment_storage === "s3" && syncConfig.s3_bucket) {
                try {
                  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
                  const client = new S3Client({
                    region: syncConfig.s3_region ?? "us-east-1",
                    credentials: process.env["AWS_ACCESS_KEY_ID"] && process.env["AWS_SECRET_ACCESS_KEY"]
                      ? {
                          accessKeyId: process.env["AWS_ACCESS_KEY_ID"],
                          secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"],
                          ...(process.env["AWS_SESSION_TOKEN"] ? { sessionToken: process.env["AWS_SESSION_TOKEN"] } : {}),
                        }
                      : undefined,
                  });
                  const key = `${syncConfig.s3_prefix ?? "emails"}/${stored.id}/${file}`;
                  await client.send(new PutObjectCommand({
                    Bucket: syncConfig.s3_bucket,
                    Key: key,
                    Body: readFileSync(filePath),
                    ContentType: meta?.content_type ?? "application/octet-stream",
                  }));
                  paths.push({ filename: file, content_type: meta?.content_type ?? "", size: stat.size, s3_url: `s3://${syncConfig.s3_bucket}/${key}` });
                } catch (e) {
                  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
                  result.errors.push(`S3 upload ${file}: ${detail}`);
                  paths.push({ filename: file, content_type: meta?.content_type ?? "", size: stat.size, local_path: filePath });
                }
              } else {
                paths.push({ filename: file, content_type: meta?.content_type ?? "", size: stat.size, local_path: filePath });
              }
              result.attachments_saved++;
            }
          } catch { /* scan failed — non-fatal */ }

          if (paths.length > 0) updateAttachmentPaths(stored.id, paths, db);

          if (archiveBucket && metadataS3Url) {
            try {
              await uploadGmailArchiveManifest({
                bucket: archiveBucket,
                region: syncConfig.s3_region,
                prefix: syncConfig.archive_s3_prefix,
                profile: opts.profile ?? opts.providerId,
                messageId: msgRef.id,
                manifest: {
                  profile: opts.profile ?? opts.providerId,
                  message_id: msgRef.id,
                  ...(rawS3Url ? { raw_s3_url: rawS3Url } : {}),
                  metadata_s3_url: metadataS3Url,
                  attachments: paths
                    .filter((path) => path.s3_url)
                    .map((path) => ({
                      filename: path.filename,
                      s3_url: path.s3_url!,
                      content_type: path.content_type,
                      size: path.size,
                    })),
                  archived_at: new Date().toISOString(),
                },
              });
              manifestUploaded = true;
            } catch (e) {
              const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
              result.errors.push(`Archive manifest upload ${msgRef.id}: ${detail}`);
            }
          }
        }
      }

      if (archiveBucket && metadataS3Url && !manifestUploaded) {
        try {
          await uploadGmailArchiveManifest({
            bucket: archiveBucket,
            region: syncConfig.s3_region,
            prefix: syncConfig.archive_s3_prefix,
            profile: opts.profile ?? opts.providerId,
            messageId: msgRef.id,
            manifest: {
              profile: opts.profile ?? opts.providerId,
              message_id: msgRef.id,
              ...(rawS3Url ? { raw_s3_url: rawS3Url } : {}),
              metadata_s3_url: metadataS3Url,
              attachments: [],
              archived_at: new Date().toISOString(),
            },
          });
        } catch (e) {
          const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
          result.errors.push(`Archive manifest upload ${msgRef.id}: ${detail}`);
        }
      }
    } catch (e) {
      result.errors.push(`Message ${msgRef.id}: ${String(e)}`);
    }
  }

  return result;
}

/**
 * Sync ALL pages until done.
 */
export async function syncGmailInboxAll(opts: Omit<ConnectorSyncOptions, "pageToken">): Promise<GmailSyncResult> {
  const aggregate: GmailSyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], done: true };
  let pageToken: string | undefined;

  do {
    const page = await syncGmailInbox({ ...opts, pageToken });
    aggregate.synced += page.synced;
    aggregate.skipped += page.skipped;
    aggregate.attachments_saved += page.attachments_saved;
    aggregate.errors.push(...page.errors);
    pageToken = page.nextPageToken;
    aggregate.done = page.done;
    if (aggregate.errors.length >= 20) {
      aggregate.errors.push("Too many errors — aborting pagination");
      break;
    }
  } while (!aggregate.done);

  return aggregate;
}

/**
 * List available Gmail labels.
 */
export async function listGmailLabels(_providerId: string): Promise<{ id: string; name: string }[]> {
  const result = await runGmailOperation<{ id: string; name: string }[] | { labels?: { id: string; name: string }[] }>(
    "labels.list",
    {},
  );
  if (!result.success) return [];
  if (Array.isArray(result.data)) return result.data;
  if (result.data && typeof result.data === "object") {
    return result.data.labels ?? [];
  }
  return [];
}

export async function listGmailConnectorProfiles(): Promise<string[]> {
  const result = await runGmailOperation<string[] | { profiles?: string[] }>(
    "profiles.list",
    {},
  );
  if (!result.success) return [];
  if (Array.isArray(result.data)) return result.data;
  return result.data?.profiles ?? [];
}

export { listInboundEmails };
