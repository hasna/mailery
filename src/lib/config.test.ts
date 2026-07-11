import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, rmSync, existsSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadConfig, saveConfig, getConfigValue, setConfigValue,
  getDefaultProviderId, getFailoverProviderIds, getInboundAttachmentStorageConfig,
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

beforeEach(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.HOME = TMP_HOME;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
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

  it("stores config in a private directory and file", () => {
    saveConfig({ resend_api_key: "secret-key" });
    const dirMode = statSync(join(TMP_HOME, ".hasna", "emails")).mode & 0o777;
    const fileMode = statSync(join(TMP_HOME, ".hasna", "emails", "config.json")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("repairs loose permissions when loading an existing config", () => {
    const dir = join(TMP_HOME, ".hasna", "emails");
    const configPath = join(dir, "config.json");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(configPath, JSON.stringify({ resend_api_key: "secret-key" }), { mode: 0o644 });
    chmodSync(dir, 0o755);
    chmodSync(configPath, 0o644);

    expect(loadConfig()["resend_api_key"]).toBe("secret-key");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
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

  it("getInboundAttachmentStorageConfig defaults local attachment storage", () => {
    expect(getInboundAttachmentStorageConfig()).toMatchObject({
      attachment_storage: "local",
      s3_region: "us-east-1",
      s3_prefix: "emails",
    });
  });

  it("getInboundAttachmentStorageConfig defaults self-hosted attachments to S3 when a bucket is configured", () => {
    const previousMode = process.env["EMAILS_MODE"];
    try {
      process.env["EMAILS_MODE"] = "self_hosted";
      setConfigValue("inbound_s3_bucket", "self-hosted-inbound");

      expect(getInboundAttachmentStorageConfig()).toMatchObject({
        attachment_storage: "s3",
        s3_bucket: "self-hosted-inbound",
        s3_region: "us-east-1",
        s3_prefix: "emails",
      });
    } finally {
      if (previousMode === undefined) delete process.env["EMAILS_MODE"];
      else process.env["EMAILS_MODE"] = previousMode;
    }
  });

  it("getInboundAttachmentStorageConfig avoids local attachment files in self-hosted mode without a bucket", () => {
    const previousMode = process.env["EMAILS_MODE"];
    try {
      process.env["EMAILS_MODE"] = "self_hosted";

      expect(getInboundAttachmentStorageConfig()).toMatchObject({
        attachment_storage: "none",
        s3_region: "us-east-1",
        s3_prefix: "emails",
      });
    } finally {
      if (previousMode === undefined) delete process.env["EMAILS_MODE"];
      else process.env["EMAILS_MODE"] = previousMode;
    }
  });

  it("getInboundAttachmentStorageConfig does not allow explicit local attachment storage in self-hosted mode", () => {
    const previousMode = process.env["EMAILS_MODE"];
    try {
      process.env["EMAILS_MODE"] = "self_hosted";
      setConfigValue("attachment_storage", "local");
      setConfigValue("attachment_s3_bucket", "self-hosted-attachments");

      expect(getInboundAttachmentStorageConfig()).toMatchObject({
        attachment_storage: "s3",
        s3_bucket: "self-hosted-attachments",
      });
    } finally {
      if (previousMode === undefined) delete process.env["EMAILS_MODE"];
      else process.env["EMAILS_MODE"] = previousMode;
    }
  });

  it("does not export concrete self-hosted infrastructure defaults in the OSS package", () => {
    expect(CANONICAL_OPEN_EMAILS_S3_BUCKET).toBeNull();
    expect(CANONICAL_OPEN_EMAILS_S3_REGION).toBe("us-east-1");
    expect(CANONICAL_OPEN_EMAILS_SECRET_PATHS).toEqual({
      env: null,
      aws: null,
      s3: null,
      rds: null,
    });
    expect(CANONICAL_OPEN_EMAILS_RDS_CLUSTER).toBeNull();
    expect(CANONICAL_OPEN_EMAILS_RDS_DATABASE).toBeNull();
    expect(CANONICAL_OPEN_EMAILS_RDS_SECRET_PATH).toBeNull();
    expect(getCanonicalOpenEmailsRdsConfig()).toEqual({
      cluster: null,
      database: null,
      runtimePath: null,
      env: "HASNA_EMAILS_DATABASE_URL",
      fallbackEnv: "EMAILS_DATABASE_URL",
    });
  });

  it("getInboundAttachmentStorageConfig fails closed for explicit S3 storage without a bucket in self-hosted mode", () => {
    const previousMode = process.env["EMAILS_MODE"];
    try {
      process.env["EMAILS_MODE"] = "self_hosted";
      setConfigValue("attachment_storage", "s3");

      expect(getInboundAttachmentStorageConfig()).toMatchObject({
        attachment_storage: "none",
        s3_region: "us-east-1",
        s3_prefix: "emails",
      });
    } finally {
      if (previousMode === undefined) delete process.env["EMAILS_MODE"];
      else process.env["EMAILS_MODE"] = previousMode;
    }
  });

  it("getInboundAttachmentStorageConfig reads explicit inbound attachment overrides", () => {
    setConfigValue("attachment_storage", "s3");
    setConfigValue("attachment_s3_bucket", "attachments");
    setConfigValue("attachment_s3_region", "eu-west-1");
    setConfigValue("attachment_s3_prefix", "mail");

    expect(getInboundAttachmentStorageConfig()).toMatchObject({
      attachment_storage: "s3",
      s3_bucket: "attachments",
      s3_region: "eu-west-1",
      s3_prefix: "mail",
    });
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
