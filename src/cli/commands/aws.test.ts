import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { getConfigValue } from "../../lib/config.js";
import { listS3Sources } from "../../lib/s3-sync.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";

const mockSesSend = mock(async (_cmd: unknown) => ({}));
const mockS3Send = mock(async (_cmd: unknown) => ({}));

mock.module("@aws-sdk/client-ses", () => ({
  SESClient: class { send = mockSesSend; },
  CreateReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  SetActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  ListReceiptRuleSetsCommand: class { constructor(public input: unknown) {} },
  CreateReceiptRuleCommand: class { constructor(public input: unknown) {} },
  DescribeActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
}));

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mockS3Send; },
  CreateBucketCommand: class { constructor(public input: unknown) {} },
  PutBucketPolicyCommand: class { constructor(public input: unknown) {} },
  PutPublicAccessBlockCommand: class { constructor(public input: unknown) {} },
  PutBucketVersioningCommand: class { constructor(public input: unknown) {} },
  PutBucketEncryptionCommand: class { constructor(public input: unknown) {} },
  HeadBucketCommand: class { constructor(public input: unknown) {} },
}));

const { registerAwsCommands } = await import("./aws.js");

let previousHome: string | undefined;
let tempHome: string | undefined;

async function runAws(args: string[]) {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = ((message?: unknown) => { lines.push(String(message ?? "")); }) as typeof console.log;
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  registerAwsCommands(program, (payload) => { data = payload; });
  try {
    await program.parseAsync(["node", "emails", ...args]);
    return { lines, data };
  } finally {
    console.log = originalLog;
  }
}

async function runAwsExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runAws(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

beforeEach(() => {
  previousHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "emails-aws-command-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  delete process.env["HASNA_EMAILS_DB_PATH"];
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  resetSelfHostedConfigCache();
  resetDatabase();
  mockSesSend.mockReset();
  mockS3Send.mockReset();
  mockS3Send.mockImplementation(async (cmd: unknown) => {
    const name = (cmd as { constructor?: { name?: string } }).constructor?.name ?? "";
    if (name === "HeadBucketCommand") return {};
    return {};
  });
  let sesCalls = 0;
  mockSesSend.mockImplementation(async () => {
    sesCalls++;
    if (sesCalls === 1) throw new Error("NoActiveRuleSet");
    if (sesCalls === 2) return { RuleSets: [] };
    return {};
  });
  delete process.env["AWS_PROFILE"];
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["HASNA_EMAILS_DB_PATH"];
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  resetSelfHostedConfigCache();
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  previousHome = undefined;
  tempHome = undefined;
});

describe("aws setup-inbound command", () => {
  it("persists local S3 source state for refresh and TUI pull", async () => {
    const result = await runAws(["aws", "setup-inbound", "--domain", "example.com", "--bucket", "inbound-bucket", "--profile", "aws-profile"]);

    expect(process.env["AWS_PROFILE"]).toBe("aws-profile");
    expect(getConfigValue("inbound_s3_profile")).toBe("aws-profile");
    expect(getConfigValue("inbound_s3_buckets")).toEqual([{ bucket: "inbound-bucket", region: "us-east-1", providerId: undefined }]);
    expect(listS3Sources()).toEqual([expect.objectContaining({
      bucket: "inbound-bucket",
      prefix: "inbound/example.com/",
      region: "us-east-1",
      status: "live",
      live_sync_enabled: true,
    })]);
    expect(result.lines.join("\n")).toContain("emails inbox sync-s3 --source s3-inbound-bucket-inbound-example.com-");
    expect(result.data).toMatchObject({ source: { id: "s3-inbound-bucket-inbound-example.com-" } });
  });

  it("fails closed in self_hosted mode before reading config or creating a local DB", async () => {
    closeDatabase();
    resetDatabase();
    delete process.env["EMAILS_DB_PATH"];
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:9";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
    resetSelfHostedConfigCache();

    const result = await runAwsExpectingExit(["aws", "setup-inbound", "--domain", "example.com", "--bucket", "inbound-bucket"]);

    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("emails aws setup-inbound");
    expect(result.stderr).toContain("self_hosted API-only mode");
    expect(existsSync(join(tempHome!, ".hasna", "emails", "emails.db"))).toBe(false);
  });

});
