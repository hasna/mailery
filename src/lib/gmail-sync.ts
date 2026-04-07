/**
 * Gmail inbox sync via @hasna/connectors SDK (runConnectorCommand).
 *
 * All Gmail API calls go through the connectors layer — no direct Gmail SDK.
 * Requires connect-gmail to be authenticated via: connectors auth gmail
 *
 * Features:
 * - Full message fetch with text + HTML body (--body --html flags)
 * - Attachment download via connector attachments download --dir
 * - Optional S3 upload after local download
 * - Pagination via nextPageToken
 * - Dedup by (provider_id, message_id) — safe to re-run
 * - Per-message error isolation
 */

import { runConnectorCommand } from "@hasna/connectors";
import { join } from "node:path";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { storeInboundEmail, updateAttachmentPaths, listInboundEmails } from "../db/inbound.js";
import type { AttachmentPath } from "../db/inbound.js";
import { getDatabase, getDataDir } from "../db/database.js";
import { getGmailSyncConfig } from "./config.js";
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

// ─── JSON parsing ─────────────────────────────────────────────────────────────

export function parseJsonFromOutput(output: string): unknown {
  const jsonStart = output.indexOf("[");
  const objStart = output.indexOf("{");
  let start = -1;
  if (jsonStart >= 0 && (objStart < 0 || jsonStart <= objStart)) {
    start = jsonStart;
  } else if (objStart >= 0) {
    start = objStart;
  }
  if (start < 0) throw new Error(`No JSON found in connector output: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start));
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

  // Build list args
  const listArgs = ["-f", "json", "messages", "list", "--max", String(batchSize)];
  if (opts.labelFilter) listArgs.push("--label", opts.labelFilter);
  const q = buildQuery(opts);
  if (q) listArgs.push("--query", q);

  // List messages
  const listResult = await runConnectorCommand("gmail", listArgs);
  if (!listResult.success) {
    result.errors.push(`Failed to list messages: ${listResult.stderr || listResult.stdout}`);
    return result;
  }

  let messages: { id: string }[];
  let nextPageToken: string | undefined;
  try {
    const parsed = parseJsonFromOutput(listResult.stdout);
    if (Array.isArray(parsed)) {
      messages = parsed as { id: string }[];
    } else {
      const env = parsed as { messages?: { id: string }[]; nextPageToken?: string };
      messages = env.messages ?? [];
      if (env.nextPageToken) {
        nextPageToken = env.nextPageToken;
        result.nextPageToken = nextPageToken;
        result.done = false;
      }
    }
  } catch (e) {
    result.errors.push(`Failed to parse message list: ${String(e)}`);
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
      interface MsgDetail {
        id: string; from?: string; to?: string; cc?: string;
        subject?: string; date?: string; body?: string;
        snippet?: string; size?: number;
      }

      const readTextResult = await runConnectorCommand("gmail", [
        "-f", "json", "messages", "read", msgRef.id, "--body",
      ]);
      let detail: MsgDetail = { id: msgRef.id };
      try {
        detail = parseJsonFromOutput(readTextResult.stdout) as MsgDetail;
      } catch { /* fall back to minimal data */ }

      const textBody = detail.body || detail.snippet || null;
      const receivedAt = parseDate(detail.date ?? "");

      // Fetch HTML body separately
      let htmlBody: string | null = null;
      if (readTextResult.success) {
        const readHtmlResult = await runConnectorCommand("gmail", [
          "-f", "json", "messages", "read", msgRef.id, "--body", "--html",
        ]);
        try {
          const htmlDetail = parseJsonFromOutput(readHtmlResult.stdout) as MsgDetail;
          // Only use if it differs from text (indicates actual HTML content)
          if (htmlDetail.body && htmlDetail.body !== textBody) {
            htmlBody = htmlDetail.body;
          }
        } catch { /* no HTML body */ }
      }

      // List attachments metadata
      const attListResult = await runConnectorCommand("gmail", ["-f", "json", "attachments", "list", msgRef.id]);
      type AttMeta = { attachmentId: string; filename: string; mimeType: string; size: number };
      let attachmentList: AttMeta[] = [];
      try {
        if (attListResult.success) {
          const parsed = parseJsonFromOutput(attListResult.stdout);
          attachmentList = Array.isArray(parsed) ? (parsed as AttMeta[]) : [];
        }
      } catch { /* no attachments or parse error — safe to ignore */ }

      const attachmentMeta = attachmentList.map((a) => ({
        filename: a.filename,
        content_type: a.mimeType,
        size: a.size,
      }));

      // Store email
      const stored = storeInboundEmail(
        {
          provider_id: opts.providerId,
          message_id: msgRef.id,
          in_reply_to_email_id: null,
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
      if (downloadAttachments && attachmentList.length > 0 && syncConfig.attachment_storage !== "none") {
        const outputDir = getAttachmentDir(stored.id);
        const dlResult = await runConnectorCommand("gmail", [
          "attachments", "download", msgRef.id, "--dir", outputDir,
        ]);

        if (dlResult.success) {
          // Scan outputDir for downloaded files
          const paths: AttachmentPath[] = [];
          try {
            const files = readdirSync(outputDir);
            for (const file of files) {
              const filePath = join(outputDir, file);
              const stat = statSync(filePath);
              const meta = attachmentMeta.find((a) => a.filename === file);

              if (syncConfig.attachment_storage === "s3" && syncConfig.s3_bucket) {
                try {
                  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
                  const { readFileSync } = await import("node:fs");
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
  const result = await runConnectorCommand("gmail", ["-f", "json", "labels", "list"]);
  if (!result.success) return [];
  try {
    return parseJsonFromOutput(result.stdout) as { id: string; name: string }[];
  } catch {
    return [];
  }
}

export { listInboundEmails };
