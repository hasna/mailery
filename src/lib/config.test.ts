import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadConfig, saveConfig, getConfigValue, setConfigValue,
  getDefaultProviderId, getFailoverProviderIds, getGmailSyncConfig,
  getDefaultGmailArchiveS3Bucket,
  getDefaultGmailArchiveS3Region,
  getDefaultGmailArchiveS3Prefix,
  CANONICAL_OPEN_EMAILS_S3_BUCKET,
  CANONICAL_OPEN_EMAILS_S3_REGION,
  CANONICAL_OPEN_EMAILS_SECRET_PATHS,
  CANONICAL_OPEN_EMAILS_RDS_CLUSTER,
  CANONICAL_OPEN_EMAILS_RDS_DATABASE,
  CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH,
  getCanonicalOpenEmailsRdsConfig,
} from "./config.js";

// Use a temp dir unique per test run to isolate from real ~/.hasna/emails
const TMP_HOME = join("/tmp", `emails-config-test-${process.pid}`);
const origHome = process.env.HOME;
const origArchiveBucket = process.env["HASNA_EMAILS_ARCHIVE_S3_BUCKET"];
const origArchiveRegion = process.env["HASNA_EMAILS_ARCHIVE_S3_REGION"];
const origArchivePrefix = process.env["HASNA_EMAILS_ARCHIVE_S3_PREFIX"];
const origLegacyArchiveBucket = process.env["EMAILS_ARCHIVE_S3_BUCKET"];
const origLegacyArchiveRegion = process.env["EMAILS_ARCHIVE_S3_REGION"];
const origLegacyArchivePrefix = process.env["EMAILS_ARCHIVE_S3_PREFIX"];

beforeEach(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.HOME = TMP_HOME;
  delete process.env["HASNA_EMAILS_ARCHIVE_S3_BUCKET"];
  delete process.env["HASNA_EMAILS_ARCHIVE_S3_REGION"];
  delete process.env["HASNA_EMAILS_ARCHIVE_S3_PREFIX"];
  delete process.env["EMAILS_ARCHIVE_S3_BUCKET"];
  delete process.env["EMAILS_ARCHIVE_S3_REGION"];
  delete process.env["EMAILS_ARCHIVE_S3_PREFIX"];
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origArchiveBucket === undefined) delete process.env["HASNA_EMAILS_ARCHIVE_S3_BUCKET"];
  else process.env["HASNA_EMAILS_ARCHIVE_S3_BUCKET"] = origArchiveBucket;
  if (origArchiveRegion === undefined) delete process.env["HASNA_EMAILS_ARCHIVE_S3_REGION"];
  else process.env["HASNA_EMAILS_ARCHIVE_S3_REGION"] = origArchiveRegion;
  if (origArchivePrefix === undefined) delete process.env["HASNA_EMAILS_ARCHIVE_S3_PREFIX"];
  else process.env["HASNA_EMAILS_ARCHIVE_S3_PREFIX"] = origArchivePrefix;
  if (origLegacyArchiveBucket === undefined) delete process.env["EMAILS_ARCHIVE_S3_BUCKET"];
  else process.env["EMAILS_ARCHIVE_S3_BUCKET"] = origLegacyArchiveBucket;
  if (origLegacyArchiveRegion === undefined) delete process.env["EMAILS_ARCHIVE_S3_REGION"];
  else process.env["EMAILS_ARCHIVE_S3_REGION"] = origLegacyArchiveRegion;
  if (origLegacyArchivePrefix === undefined) delete process.env["EMAILS_ARCHIVE_S3_PREFIX"];
  else process.env["EMAILS_ARCHIVE_S3_PREFIX"] = origLegacyArchivePrefix;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("config", () => {
  it("loadConfig returns empty object when no file exists", () => {
    expect(loadConfig()).toEqual({});
  });

  it("saveConfig creates the file and directory", () => {
    saveConfig({ "my-key": "my-value" });
    expect(existsSync(join(TMP_HOME, ".hasna", "emails", "config.json"))).toBe(true);
  });

  it("loadConfig reads back saved config", () => {
    saveConfig({ "test-key": 42 });
    expect(loadConfig()["test-key"]).toBe(42);
  });

  it("returns a defensive copy when serving cached config", () => {
    saveConfig({ nested: { value: 1 }, buckets: [{ bucket: "a", region: "us-east-1" }] });
    const first = loadConfig() as { nested: { value: number }; buckets: Array<{ bucket: string }> };
    first.nested.value = 2;
    first.buckets[0]!.bucket = "mutated";
    (first as Record<string, unknown>)["new-key"] = "leaked";

    expect(loadConfig()).toEqual({ nested: { value: 1 }, buckets: [{ bucket: "a", region: "us-east-1" }] });
  });

  it("notices external config file changes after a cached read", () => {
    saveConfig({ "test-key": "old" });
    expect(loadConfig()["test-key"]).toBe("old");

    const configPath = join(TMP_HOME, ".hasna", "emails", "config.json");
    writeFileSync(configPath, JSON.stringify({ "test-key": "new", "extra-padding": "changed-size" }, null, 2));

    expect(loadConfig()["test-key"]).toBe("new");
  });

  it("loadConfig returns empty object for malformed JSON", () => {
    const configPath = join(TMP_HOME, ".hasna", "emails", "config.json");
    mkdirSync(join(TMP_HOME, ".hasna", "emails"), { recursive: true });
    writeFileSync(configPath, "{not json", "utf-8");

    expect(loadConfig()).toEqual({});
  });

  it("loadConfig returns empty object for non-object JSON", () => {
    const configPath = join(TMP_HOME, ".hasna", "emails", "config.json");
    mkdirSync(join(TMP_HOME, ".hasna", "emails"), { recursive: true });
    writeFileSync(configPath, "[]", "utf-8");

    expect(loadConfig()).toEqual({});
  });

  it("getConfigValue returns value for existing key", () => {
    saveConfig({ "bounce-alert-threshold": 5 });
    expect(getConfigValue("bounce-alert-threshold")).toBe(5);
  });

  it("getConfigValue returns undefined for missing key", () => {
    expect(getConfigValue("nonexistent")).toBeUndefined();
  });

  it("setConfigValue creates and updates value", () => {
    setConfigValue("my-setting", "hello");
    expect(getConfigValue("my-setting")).toBe("hello");
    setConfigValue("my-setting", "updated");
    expect(getConfigValue("my-setting")).toBe("updated");
  });

  it("getDefaultProviderId returns undefined when not set", () => {
    expect(getDefaultProviderId()).toBeUndefined();
  });

  it("getDefaultProviderId returns set value", () => {
    setConfigValue("default_provider", "prov-abc");
    expect(getDefaultProviderId()).toBe("prov-abc");
  });

  it("getFailoverProviderIds returns empty array when not set", () => {
    expect(getFailoverProviderIds()).toEqual([]);
  });

  it("getFailoverProviderIds parses comma-separated IDs", () => {
    setConfigValue("failover-providers", "id1, id2, id3");
    expect(getFailoverProviderIds()).toEqual(["id1", "id2", "id3"]);
  });

  it("getFailoverProviderIds filters empty strings", () => {
    setConfigValue("failover-providers", "id1,,id2");
    expect(getFailoverProviderIds()).toEqual(["id1", "id2"]);
  });

  it("getGmailSyncConfig defaults Gmail archives to the production bucket region", () => {
    expect(getGmailSyncConfig()).toMatchObject({
      s3_region: "us-east-1",
      archive_s3_region: CANONICAL_OPEN_EMAILS_S3_REGION,
      archive_s3_prefix: "gmail",
    });
    expect(getGmailSyncConfig().archive_s3_bucket).toBeUndefined();
    expect(getDefaultGmailArchiveS3Bucket()).toBe(CANONICAL_OPEN_EMAILS_S3_BUCKET);
    expect(getDefaultGmailArchiveS3Region()).toBe(CANONICAL_OPEN_EMAILS_S3_REGION);
    expect(getDefaultGmailArchiveS3Prefix()).toBe("gmail");
  });

  it("exports canonical Hasna XYZ emails resource paths", () => {
    expect(CANONICAL_OPEN_EMAILS_S3_BUCKET).toBe("hasna-xyz-opensource-emails-prod");
    expect(CANONICAL_OPEN_EMAILS_S3_REGION).toBe("us-east-1");
    expect(CANONICAL_OPEN_EMAILS_SECRET_PATHS).toEqual({
      env: "hasna/xyz/opensource/emails/prod/env",
      aws: "hasna/xyz/opensource/emails/prod/aws",
      s3: "hasna/xyz/opensource/emails/prod/s3",
      rds: "hasna/xyz/opensource/emails/prod/rds",
    });
    expect(CANONICAL_OPEN_EMAILS_RDS_CLUSTER).toBe("hasna-xyz-infra-apps-prod-postgres");
    expect(CANONICAL_OPEN_EMAILS_RDS_DATABASE).toBe("emails");
    expect(CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH).toBe("hasna/xyz/opensource/emails/prod/rds");
    expect(getCanonicalOpenEmailsRdsConfig()).toEqual({
      cluster: "hasna-xyz-infra-apps-prod-postgres",
      database: "emails",
      runtimePath: "hasna/xyz/opensource/emails/prod/rds",
      env: "HASNA_EMAILS_DATABASE_URL",
      fallbackEnv: "EMAILS_DATABASE_URL",
    });
  });

  it("getGmailSyncConfig reads canonical archive env overrides", () => {
    process.env["HASNA_EMAILS_ARCHIVE_S3_BUCKET"] = "override-bucket";
    process.env["HASNA_EMAILS_ARCHIVE_S3_REGION"] = "eu-west-1";
    process.env["HASNA_EMAILS_ARCHIVE_S3_PREFIX"] = "archive";
    try {
      expect(getGmailSyncConfig()).toMatchObject({
        archive_s3_bucket: "override-bucket",
        archive_s3_region: "eu-west-1",
        archive_s3_prefix: "archive",
      });
    } finally {
      delete process.env["HASNA_EMAILS_ARCHIVE_S3_BUCKET"];
      delete process.env["HASNA_EMAILS_ARCHIVE_S3_REGION"];
      delete process.env["HASNA_EMAILS_ARCHIVE_S3_PREFIX"];
    }
  });

  it("getGmailSyncConfig reads explicit Gmail archive region overrides", () => {
    setConfigValue("gmail_archive_s3_region", "eu-central-1");
    expect(getGmailSyncConfig().archive_s3_region).toBe("eu-central-1");
  });
});

import { getInboundBuckets, addInboundBucket } from "./config.js";
describe("inbound buckets (multi-account)", () => {
  it("adds, dedupes, and backfills providerId", () => {
    addInboundBucket("bkt-a", "us-east-1", "prov-a");
    addInboundBucket("bkt-b", "eu-west-1", "prov-b");
    addInboundBucket("bkt-a", "us-east-1");            // dup, keep providerId
    const list = getInboundBuckets();
    const a = list.find((b) => b.bucket === "bkt-a")!;
    const b = list.find((b) => b.bucket === "bkt-b")!;
    expect(a.providerId).toBe("prov-a");
    expect(b.region).toBe("eu-west-1");
    expect(list.filter((x) => x.bucket === "bkt-a")).toHaveLength(1);
  });
});
