import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { getDataDir } from "../db/database.js";
import { resolveCloudflareAuth, type CloudflareAuth } from "./cloudflare-auth.js";
import { getEmailsMode } from "./mode.js";

// Lazy getters so tests can override HOME via process.env before calling
function getConfigDir(): string { return getDataDir(); }
function getConfigPath(): string { return join(getConfigDir(), "config.json"); }
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

export interface EmailsConfig {
  default_provider?: string;
  [key: string]: unknown;
}

export const CANONICAL_OPEN_EMAILS_S3_BUCKET: string | null = null;
export const CANONICAL_OPEN_EMAILS_S3_REGION = "us-east-1";
export const CANONICAL_OPEN_EMAILS_SECRETS_BASE: string | null = null;
export const CANONICAL_OPEN_EMAILS_SECRET_PATHS = {
  env: null,
  aws: null,
  s3: null,
  rds: null,
} as const;
export const CANONICAL_OPEN_EMAILS_RDS_CLUSTER: string | null = null;
export const CANONICAL_OPEN_EMAILS_RDS_DATABASE: string | null = null;
export const CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH = CANONICAL_OPEN_EMAILS_SECRET_PATHS.rds;

export interface CanonicalOpenEmailsRdsConfig {
  cluster: string | null;
  database: string | null;
  runtimePath: string | null;
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

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only: config read/write should still work on filesystems that
    // do not support POSIX modes, but normal local installs get hardened.
  }
}

function ensureConfigDir(): string {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  chmodBestEffort(dir, CONFIG_DIR_MODE);
  return dir;
}

function ensureConfigFileMode(path = getConfigPath()): void {
  if (existsSync(path)) chmodBestEffort(path, CONFIG_FILE_MODE);
}

export function loadConfig(): EmailsConfig {
  ensureConfigDir();
  const path = getConfigPath();
  if (!existsSync(path)) {
    if (configCache?.path === path) configCache = null;
    return {};
  }
  ensureConfigFileMode(path);
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
  ensureConfigDir();
  const path = getConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: CONFIG_FILE_MODE });
  ensureConfigFileMode(path);
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

// ─── Inbound Attachment Config ────────────────────────────────────────────────

export type AttachmentStorage = "local" | "s3" | "none";

export interface InboundAttachmentStorageConfig {
  /** Where to store attachment files: local fs, S3, or skip. Default: "local" */
  attachment_storage: AttachmentStorage;
  /** S3 bucket name (required when attachment_storage = "s3") */
  s3_bucket?: string;
  /** S3 key prefix (default: "emails") */
  s3_prefix?: string;
  /** S3 region (default: us-east-1) */
  s3_region?: string;
}

/**
 * Default inbound mailbox store (SES receipt rules -> S3). Resolved from config,
 * env, then a local default. Production operators should configure this
 * explicitly for their own AWS account.
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
 * AWS profile to use for SES + inbound S3 operations so the operator does not
 * pass --profile every time.
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

export interface BrandsightAuth {
  apiKey: string;
  apiSecret: string;
  customerId: string;
}

export function getBrandsightAuth(): BrandsightAuth | undefined {
  const config = loadConfig();
  const apiKey = (config["brandsight_api_key"] as string | undefined)
    ?? process.env["BRANDSIGHT_API_KEY"];
  const apiSecret = (config["brandsight_api_secret"] as string | undefined)
    ?? process.env["BRANDSIGHT_API_SECRET"];
  const customerId = (config["brandsight_customer_id"] as string | undefined)
    ?? process.env["BRANDSIGHT_CUSTOMER_ID"];
  if (!apiKey || !apiSecret || !customerId) return undefined;
  return { apiKey, apiSecret, customerId };
}

export function getInboundAttachmentStorageConfig(): InboundAttachmentStorageConfig {
  const config = loadConfig();
  const configuredStorage = config["attachment_storage"] as AttachmentStorage | undefined;
  const configuredBucket = config["attachment_s3_bucket"] as string | undefined;
  const inboundBucket = (config["inbound_s3_bucket"] as string | undefined)
    ?? process.env["EMAILS_INBOUND_S3_BUCKET"];
  // Mode-based (no self_hosted/remote/hybrid or *_DATABASE_URL env heuristic).
  //   local  -> attachments live on the local filesystem by default.
  //   self_hosted -> the server owns attachments; the thin client never keeps them on the
  //             local filesystem — it uses S3 when a bucket is configured, else none
  //             (an explicit "local"/"s3" is coerced to that safe pair).
  const selfHosted = getEmailsMode() === "self_hosted";
  const selfHostedStorage: AttachmentStorage = configuredBucket || inboundBucket ? "s3" : "none";
  const effectiveStorage = selfHosted
    ? (configuredStorage === "local" || configuredStorage === "s3" ? selfHostedStorage : configuredStorage)
    : configuredStorage;
  return {
    attachment_storage: effectiveStorage ?? (selfHosted ? selfHostedStorage : "local"),
    s3_bucket: configuredBucket ?? (selfHosted ? inboundBucket : undefined),
    s3_prefix: (config["attachment_s3_prefix"] as string | undefined)
      ?? "emails",
    s3_region: (config["attachment_s3_region"] as string | undefined)
      ?? "us-east-1",
  };
}
