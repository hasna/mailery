import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { getDataDir } from "../db/database.js";
import { resolveCloudflareAuth, type CloudflareAuth } from "./cloudflare-auth.js";

// Lazy getters so tests can override HOME via process.env before calling
function getConfigDir(): string { return getDataDir(); }
function getConfigPath(): string { return join(getConfigDir(), "config.json"); }

export interface EmailsConfig {
  default_provider?: string;
  [key: string]: unknown;
}

export const CANONICAL_OPEN_EMAILS_S3_BUCKET = "hasna-xyz-opensource-emails-prod";
export const CANONICAL_OPEN_EMAILS_S3_REGION = "us-east-1";
export const CANONICAL_OPEN_EMAILS_SECRETS_BASE = "hasna/xyz/opensource/emails/prod";
export const CANONICAL_OPEN_EMAILS_SECRET_PATHS = {
  env: `${CANONICAL_OPEN_EMAILS_SECRETS_BASE}/env`,
  aws: `${CANONICAL_OPEN_EMAILS_SECRETS_BASE}/aws`,
  s3: `${CANONICAL_OPEN_EMAILS_SECRETS_BASE}/s3`,
  rds: `${CANONICAL_OPEN_EMAILS_SECRETS_BASE}/rds`,
} as const;
export const CANONICAL_OPEN_EMAILS_RDS_CLUSTER = "hasna-xyz-infra-apps-prod-postgres";
export const CANONICAL_OPEN_EMAILS_RDS_DATABASE = "emails";
export const CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH = CANONICAL_OPEN_EMAILS_SECRET_PATHS.rds;

export interface CanonicalOpenEmailsRdsConfig {
  cluster: typeof CANONICAL_OPEN_EMAILS_RDS_CLUSTER;
  database: typeof CANONICAL_OPEN_EMAILS_RDS_DATABASE;
  runtimePath: typeof CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH;
  env: "HASNA_EMAILS_DATABASE_URL";
  fallbackEnv: "EMAILS_DATABASE_URL";
}

export function getCanonicalOpenEmailsRdsConfig(): CanonicalOpenEmailsRdsConfig {
  return {
    cluster: CANONICAL_OPEN_EMAILS_RDS_CLUSTER,
    database: CANONICAL_OPEN_EMAILS_RDS_DATABASE,
    runtimePath: CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH,
    env: "HASNA_EMAILS_DATABASE_URL",
    fallbackEnv: "EMAILS_DATABASE_URL",
  };
}

interface ConfigCacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  config: EmailsConfig;
}

let configCache: ConfigCacheEntry | null = null;

function cloneConfig(config: EmailsConfig): EmailsConfig {
  try {
    return JSON.parse(JSON.stringify(config)) as EmailsConfig;
  } catch {
    return { ...config };
  }
}

export function loadConfig(): EmailsConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    if (configCache?.path === path) configCache = null;
    return {};
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    if (configCache?.path === path) configCache = null;
    return {};
  }
  if (configCache?.path === path && configCache.mtimeMs === stats.mtimeMs && configCache.size === stats.size) {
    return cloneConfig(configCache.config);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as EmailsConfig) : {};
    configCache = { path, mtimeMs: stats.mtimeMs, size: stats.size, config: cloneConfig(config) };
    return cloneConfig(config);
  } catch {
    configCache = { path, mtimeMs: stats.mtimeMs, size: stats.size, config: {} };
    return {};
  }
}

export function saveConfig(config: EmailsConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2));
  const stats = statSync(path);
  configCache = { path, mtimeMs: stats.mtimeMs, size: stats.size, config: cloneConfig(config) };
}

export function getConfigValue(key: string): unknown {
  return loadConfig()[key];
}

export function setConfigValue(key: string, value: unknown): void {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
}

export function getDefaultProviderId(): string | undefined {
  return loadConfig().default_provider as string | undefined;
}

export function getFailoverProviderIds(): string[] {
  const val = loadConfig()["failover-providers"];
  if (!val) return [];
  return String(val).split(",").map(s => s.trim()).filter(Boolean);
}

// ─── Gmail Attachment Config ──────────────────────────────────────────────────

export type AttachmentStorage = "local" | "s3" | "none";

export interface GmailSyncConfig {
  /** Where to store attachment files: local fs, S3, or skip. Default: "local" */
  attachment_storage: AttachmentStorage;
  /** S3 bucket name (required when attachment_storage = "s3") */
  s3_bucket?: string;
  /** S3 key prefix (default: "emails") */
  s3_prefix?: string;
  /** S3 region (default: us-east-1) */
  s3_region?: string;
  /** S3 bucket for durable Gmail archive objects. */
  archive_s3_bucket?: string;
  /** S3 region for durable Gmail archive objects (default: us-east-1) */
  archive_s3_region?: string;
  /** S3 prefix for Gmail archive objects (default: "gmail") */
  archive_s3_prefix?: string;
}

/**
 * Default inbound mailbox store (SES receipt rules → S3). For this app SES runs
 * in the hasna-studio-alumia account, so the default bucket is the alumia
 * inbound bucket. Resolved from config, env, then a sensible default.
 */
export function getInboundConfig(): { bucket?: string; region: string; prefix?: string; profile?: string } {
  const config = loadConfig();
  return {
    bucket: (config["inbound_s3_bucket"] as string | undefined) ?? process.env["EMAILS_INBOUND_S3_BUCKET"],
    region: (config["inbound_s3_region"] as string | undefined) ?? process.env["AWS_REGION"] ?? "us-east-1",
    prefix: config["inbound_s3_prefix"] as string | undefined,
    profile: getSesProfile(),
  };
}

/** An inbound S3 bucket + the SES provider whose creds reach it (buckets can be
 *  in different AWS accounts, so each carries its own provider). */
export interface InboundBucket { bucket: string; region: string; providerId?: string }

/**
 * All inbound S3 buckets to sync — domains can span multiple AWS accounts (one
 * bucket each), so the watcher/auto-pull iterates every one. Includes the legacy
 * single `inbound_s3_bucket` for back-compat, de-duplicated (list entries, which
 * carry a providerId, win over the legacy single).
 */
export function getInboundBuckets(): InboundBucket[] {
  const config = loadConfig();
  const list = Array.isArray(config["inbound_s3_buckets"]) ? config["inbound_s3_buckets"] as InboundBucket[] : [];
  const single = config["inbound_s3_bucket"] as string | undefined;
  const region = (config["inbound_s3_region"] as string | undefined) ?? process.env["AWS_REGION"] ?? "us-east-1";
  const all = [...list];
  if (single && !all.some((b) => b.bucket === single)) all.push({ bucket: single, region });
  const seen = new Set<string>();
  return all.filter((b) => b.bucket && !seen.has(b.bucket) && seen.add(b.bucket));
}

/** Register an inbound bucket so it's included in syncs (idempotent; fills in
 *  the providerId if a prior entry lacked one). */
export function addInboundBucket(bucket: string, region: string, providerId?: string): void {
  const config = loadConfig();
  const list = Array.isArray(config["inbound_s3_buckets"]) ? config["inbound_s3_buckets"] as InboundBucket[] : [];
  const existing = list.find((b) => b.bucket === bucket);
  if (existing) { existing.region = region; if (providerId) existing.providerId = providerId; }
  else list.push({ bucket, region, providerId });
  config["inbound_s3_buckets"] = list;
  saveConfig(config);
}

/**
 * AWS profile to use for SES + inbound S3 operations (so the operator does not
 * pass --profile every time). For this app SES runs in hasna-studio-alumia.
 */
export function getSesProfile(): string | undefined {
  const config = loadConfig();
  return (config["ses_aws_profile"] as string | undefined)
    ?? (config["inbound_s3_profile"] as string | undefined)
    ?? process.env["EMAILS_SES_AWS_PROFILE"]
    ?? undefined;
}

export function getCloudflareToken(): string | undefined {
  const fromConfig = loadConfig()["cloudflare_api_token"] as string | undefined;
  return fromConfig || process.env["CLOUDFLARE_API_TOKEN"] || undefined;
}

/**
 * Resolve Cloudflare auth (scoped token OR global key + email) from the emails
 * config file or standard env vars. Returns
 * undefined when nothing is configured.
 */
export function getCloudflareAuth(): CloudflareAuth | undefined {
  const config = loadConfig();
  return resolveCloudflareAuth({
    configToken: config["cloudflare_api_token"] as string | undefined,
    configApiKey: config["cloudflare_api_key"] as string | undefined,
    configEmail: config["cloudflare_email"] as string | undefined,
  });
}

export function getGmailSyncConfig(): GmailSyncConfig {
  const config = loadConfig();
  return {
    attachment_storage: (config["gmail_attachment_storage"] as AttachmentStorage) ?? "local",
    s3_bucket: config["gmail_s3_bucket"] as string | undefined,
    s3_prefix: (config["gmail_s3_prefix"] as string | undefined) ?? "emails",
    s3_region: (config["gmail_s3_region"] as string | undefined) ?? "us-east-1",
    archive_s3_bucket: (config["gmail_archive_s3_bucket"] as string | undefined)
      ?? process.env["HASNA_EMAILS_ARCHIVE_S3_BUCKET"]
      ?? process.env["EMAILS_ARCHIVE_S3_BUCKET"],
    archive_s3_region: getDefaultGmailArchiveS3Region(config),
    archive_s3_prefix: getDefaultGmailArchiveS3Prefix(config),
  };
}

export function getDefaultGmailArchiveS3Bucket(config: EmailsConfig = loadConfig()): string {
  return (config["gmail_archive_s3_bucket"] as string | undefined)
    ?? process.env["HASNA_EMAILS_ARCHIVE_S3_BUCKET"]
    ?? process.env["EMAILS_ARCHIVE_S3_BUCKET"]
    ?? CANONICAL_OPEN_EMAILS_S3_BUCKET;
}

export function getDefaultGmailArchiveS3Region(config: EmailsConfig = loadConfig()): string {
  return (config["gmail_archive_s3_region"] as string | undefined)
    ?? process.env["HASNA_EMAILS_ARCHIVE_S3_REGION"]
    ?? process.env["EMAILS_ARCHIVE_S3_REGION"]
    ?? CANONICAL_OPEN_EMAILS_S3_REGION;
}

export function getDefaultGmailArchiveS3Prefix(config: EmailsConfig = loadConfig()): string {
  return (config["gmail_archive_s3_prefix"] as string | undefined)
    ?? process.env["HASNA_EMAILS_ARCHIVE_S3_PREFIX"]
    ?? process.env["EMAILS_ARCHIVE_S3_PREFIX"]
    ?? "gmail";
}
