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
import { simpleParser } from "mailparser";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { storeInboundEmail, updateAttachmentPaths, listInboundEmails } from "../db/inbound.js";
import type { AttachmentPath } from "../db/inbound.js";
import { getDatabase, getDataDir } from "../db/database.js";
import { getGmailSyncState, setGmailSyncState } from "../db/gmail-sync-state.js";
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
  /** Number of Gmail messages to process concurrently within one listed page. Default: 1 */
  messageConcurrency?: number;
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
  payload?: GmailMessagePart;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  body?: string;
  htmlBody?: string;
  snippet?: string;
  size?: number;
  raw?: string;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface ParsedRawAttachment extends GmailAttachmentMeta {
  content: Buffer;
}

interface ParsedRawMessage {
  detail: GmailMessageDetail;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: string;
  rawBuffer: Buffer;
  attachments: ParsedRawAttachment[];
}

interface GmailHistoryMessageRef {
  id: string;
  threadId?: string;
}

interface GmailHistoryRecord {
  id?: string;
  messages?: GmailHistoryMessageRef[];
  messagesAdded?: Array<{ message?: GmailHistoryMessageRef }>;
  labelsAdded?: Array<{ message?: GmailHistoryMessageRef }>;
  labelsRemoved?: Array<{ message?: GmailHistoryMessageRef }>;
  messageChanged?: Array<{ message?: GmailHistoryMessageRef }>;
}

interface GmailHistoryEnvelope {
  history?: GmailHistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
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

function extractBodyFromPayload(payload: GmailMessagePart | undefined, preferHtml = false): string {
  if (!payload) return "";
  const targetType = preferHtml ? "text/html" : "text/plain";
  const parts: Array<{ mimeType: string; data: string }> = [];
  collectTextParts(payload, parts);
  return parts.find((part) => part.mimeType === targetType)?.data
    ?? parts.find((part) => part.mimeType.startsWith("text/"))?.data
    ?? "";
}

function collectTextParts(part: GmailMessagePart, results: Array<{ mimeType: string; data: string }>): void {
  const mimeType = (part.mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (part.body?.data && mimeType.startsWith("text/")) {
    results.push({ mimeType, data: Buffer.from(part.body.data, "base64url").toString("utf8") });
  }
  for (const child of part.parts ?? []) collectTextParts(child, results);
}

function collectAttachmentsFromPayload(part: GmailMessagePart | undefined, attachments: GmailAttachmentMeta[] = []): GmailAttachmentMeta[] {
  if (!part) return attachments;
  if (part.body?.attachmentId && part.filename) {
    attachments.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) collectAttachmentsFromPayload(child, attachments);
  return attachments;
}

function rawReceivedAt(detail: GmailMessageDetail, parsedDate: Date | undefined): string {
  if (parsedDate && !isNaN(parsedDate.getTime())) return parsedDate.toISOString();
  if (detail.internalDate && /^\d+$/.test(detail.internalDate)) {
    const date = new Date(Number(detail.internalDate));
    if (!isNaN(date.getTime())) return date.toISOString();
  }
  return parseDate(detail.date ?? "");
}

function parsedAddressText(value: { text?: string } | Array<{ text?: string }> | undefined): string {
  if (!value) return "";
  if (Array.isArray(value)) return value.map((entry) => entry.text).filter(Boolean).join(", ");
  return value.text ?? "";
}

async function parseRawGmailMessage(detail: GmailMessageDetail): Promise<ParsedRawMessage | null> {
  if (!detail.raw) return null;
  const rawBuffer = Buffer.from(detail.raw, "base64url");
  const parsed = await simpleParser(rawBuffer);
  const textBody = typeof parsed.text === "string" && parsed.text.length > 0 ? parsed.text : (detail.snippet ?? null);
  const htmlBody = typeof parsed.html === "string" && parsed.html.length > 0 ? parsed.html : null;
  const attachments = parsed.attachments.map((attachment, index) => ({
    attachmentId: `raw-${index}`,
    filename: basename(attachment.filename || `attachment-${index + 1}`),
    mimeType: attachment.contentType || "application/octet-stream",
    size: attachment.size ?? attachment.content.length,
    content: Buffer.from(attachment.content),
  }));

  return {
    detail: {
      ...detail,
      from: detail.from ?? parsedAddressText(parsed.from),
      to: detail.to ?? parsedAddressText(parsed.to),
      cc: detail.cc ?? parsedAddressText(parsed.cc),
      subject: detail.subject ?? parsed.subject ?? "(no subject)",
      date: detail.date ?? parsed.date?.toUTCString(),
      size: detail.size ?? rawBuffer.length,
    },
    textBody,
    htmlBody,
    receivedAt: rawReceivedAt(detail, parsed.date),
    rawBuffer,
    attachments,
  };
}

// ─── Core sync ────────────────────────────────────────────────────────────────

/**
 * Sync one page of Gmail messages into the inbound_emails table.
 * Uses the connectors SDK for all Gmail API calls.
 */
export async function syncGmailInbox(opts: ConnectorSyncOptions): Promise<GmailSyncResult> {
  const batchSize = opts.batchSize ?? 50;
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
  return syncGmailMessages(opts, capped, result);
}

async function syncGmailMessages(
  opts: Omit<ConnectorSyncOptions, "pageToken">,
  capped: GmailListMessage[],
  result: GmailSyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], done: true },
): Promise<GmailSyncResult> {
  const db = opts.db ?? getDatabase();
  const downloadAttachments = opts.downloadAttachments ?? true;
  const syncConfig = getGmailSyncConfig();
  const archiveRegion = syncConfig.archive_s3_region ?? syncConfig.s3_region;
  let latestHistoryId: string | undefined;
  const concurrency = normalizeConcurrency(opts.messageConcurrency);

  await mapWithConcurrency(capped, concurrency, async (msgRef) => {
    if (!msgRef.id) return;

    try {
      // Dedup
      const existing = db
        .query("SELECT id FROM inbound_emails WHERE provider_id = ? AND message_id = ? LIMIT 1")
        .get(opts.providerId, msgRef.id);
      if (existing) {
        result.skipped++;
        return;
      }

      const archiveBucket = opts.archiveS3Bucket ?? syncConfig.archive_s3_bucket;
      if (archiveBucket) {
        const rawResult = await runGmailOperation<GmailMessageDetail>(
          "messages.getRaw",
          { args: [msgRef.id] },
          opts.profile,
        );
        const parsedRaw = rawResult.success && rawResult.data?.raw
          ? await parseRawGmailMessage({
              ...rawResult.data,
              id: rawResult.data.id ?? msgRef.id,
              threadId: rawResult.data.threadId ?? msgRef.threadId,
            })
          : null;

        if (parsedRaw) {
          const { detail, textBody, htmlBody, attachments, rawBuffer } = parsedRaw;
          latestHistoryId = newerHistoryId(latestHistoryId, detail.historyId);
          const attachmentMeta = attachments.map((a) => ({
            filename: a.filename,
            content_type: a.mimeType,
            size: a.size,
          }));
          const archive = await uploadGmailArchive({
            bucket: archiveBucket,
            region: archiveRegion,
            prefix: syncConfig.archive_s3_prefix,
            profile: opts.profile ?? opts.providerId,
            messageId: msgRef.id,
            raw: detail.raw,
            metadata: {
              message: { ...detail, raw: undefined },
              attachments: attachments.map((attachment) => ({
                attachmentId: attachment.attachmentId,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.size,
              })),
            },
          });
          const rawS3Url = archive.raw_s3_url ?? null;
          const metadataS3Url = archive.metadata_s3_url;
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
              raw_size: detail.size ?? rawBuffer.length,
              received_at: parsedRaw.receivedAt,
            },
            db,
          );

          result.synced++;
          let paths: AttachmentPath[] = [];
          if (downloadAttachments && attachments.length > 0 && syncConfig.attachment_storage !== "none") {
            const outputDir = getAttachmentDir(stored.id);
            for (const attachment of attachments) {
              const filename = basename(attachment.filename || attachment.attachmentId);
              const filePath = join(outputDir, filename);
              writeFileSync(filePath, attachment.content);
              const uploaded = await uploadGmailArchiveAttachment({
                bucket: archiveBucket,
                region: archiveRegion,
                prefix: syncConfig.archive_s3_prefix,
                profile: opts.profile ?? opts.providerId,
                messageId: msgRef.id,
                filename,
                body: attachment.content,
                contentType: attachment.mimeType,
              });
              paths.push({ filename, content_type: attachment.mimeType, size: attachment.size, s3_url: uploaded.s3_url });
              result.attachments_saved++;
            }
            if (paths.length > 0) updateAttachmentPaths(stored.id, paths, db);
          }

          await uploadGmailArchiveManifest({
            bucket: archiveBucket,
            region: archiveRegion,
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
          return;
        }
      }

      // Fetch full message — two calls: text body + HTML body
      // (connector returns only one body per call based on --html flag)
      const readTextResult = await runGmailOperation<GmailMessageDetail>(
        "messages.read",
        { args: [msgRef.id], body: true },
        opts.profile,
      );
      const detail = readTextResult.data ?? { id: msgRef.id };
      latestHistoryId = newerHistoryId(latestHistoryId, detail.historyId);

      const textBody = detail.body || extractBodyFromPayload(detail.payload, false) || detail.snippet || null;
      const receivedAt = parseDate(detail.date ?? "");

      const htmlFromPayload = detail.htmlBody || extractBodyFromPayload(detail.payload, true);
      const htmlBody = htmlFromPayload && htmlFromPayload !== textBody ? htmlFromPayload : null;

      let attachmentList = collectAttachmentsFromPayload(detail.payload);
      if (!detail.payload) {
        const attListResult = await runGmailOperation<GmailAttachmentMeta[]>(
          "attachments.list",
          { args: [msgRef.id] },
          opts.profile,
        );
        attachmentList = attListResult.success && Array.isArray(attListResult.data)
          ? attListResult.data
          : [];
      }

      const attachmentMeta = attachmentList.map((a) => ({
        filename: a.filename,
        content_type: a.mimeType,
        size: a.size,
      }));

      let rawS3Url: string | null = null;
      let metadataS3Url: string | null = null;
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
          region: archiveRegion,
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
        const downloadResults = await Promise.all(attachmentList.map((attachment) => runGmailOperation(
          "attachments.download",
          {
            args: [msgRef.id],
            attachmentId: attachment.attachmentId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            dir: outputDir,
          },
          opts.profile,
        )));

        if (downloadResults.every((downloadResult) => downloadResult.success)) {
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
                    region: archiveRegion,
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
                region: archiveRegion,
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
            region: archiveRegion,
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
  });

  if (latestHistoryId) {
    setGmailSyncState(opts.providerId, { history_id: latestHistoryId, next_page_token: null }, db);
  }

  return result;
}

function normalizeConcurrency(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(64, Math.trunc(value)));
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(workers);
}

function newerHistoryId(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  try {
    return BigInt(candidate) > BigInt(current) ? candidate : current;
  } catch {
    return candidate > current ? candidate : current;
  }
}

/**
 * Sync mailbox deltas from the stored Gmail history cursor.
 *
 * If no history cursor exists yet, this falls back to normal message listing so
 * the first run can establish local rows. Gmail returns a new mailbox historyId
 * on every successful history response; that cursor is persisted for the next
 * incremental run.
 */
export async function syncGmailInboxHistory(opts: Omit<ConnectorSyncOptions, "pageToken">): Promise<GmailSyncResult> {
  const db = opts.db ?? getDatabase();
  const state = getGmailSyncState(opts.providerId, db);
  if (!state?.history_id) {
    return syncGmailInbox(opts);
  }

  const aggregate: GmailSyncResult = { synced: 0, skipped: 0, attachments_saved: 0, errors: [], done: true };
  const messageRefs = new Map<string, GmailListMessage>();
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;

  do {
    const page = await runGmailOperation<GmailHistoryEnvelope>(
      "history.list",
      {
        startHistoryId: state.history_id,
        maxResults: opts.batchSize ?? 100,
        ...(pageToken ? { pageToken } : {}),
      },
      opts.profile,
    );
    if (!page.success) {
      aggregate.errors.push(`Failed to list Gmail history: ${page.stderr || page.stdout}`);
      return aggregate;
    }

    const data = page.data ?? {};
    latestHistoryId = data.historyId ?? latestHistoryId;
    for (const record of data.history ?? []) {
      if (!latestHistoryId && record.id) latestHistoryId = record.id;
      for (const ref of extractHistoryMessageRefs(record)) {
        if (ref.id) messageRefs.set(ref.id, ref);
      }
    }
    pageToken = data.nextPageToken;
    aggregate.nextPageToken = pageToken;
    aggregate.done = !pageToken;
  } while (pageToken);

  if (messageRefs.size > 0) {
    const page = await syncGmailMessages(opts, Array.from(messageRefs.values()));
    aggregate.synced += page.synced;
    aggregate.skipped += page.skipped;
    aggregate.attachments_saved += page.attachments_saved;
    aggregate.errors.push(...page.errors);
  }

  if (latestHistoryId) {
    setGmailSyncState(opts.providerId, { history_id: latestHistoryId, next_page_token: null }, db);
  }

  return aggregate;
}

function extractHistoryMessageRefs(record: GmailHistoryRecord): GmailListMessage[] {
  const refs: GmailListMessage[] = [];
  refs.push(...(record.messages ?? []));
  for (const item of record.messagesAdded ?? []) if (item.message) refs.push(item.message);
  for (const item of record.labelsAdded ?? []) if (item.message) refs.push(item.message);
  for (const item of record.labelsRemoved ?? []) if (item.message) refs.push(item.message);
  for (const item of record.messageChanged ?? []) if (item.message) refs.push(item.message);
  return refs;
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
