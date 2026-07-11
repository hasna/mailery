import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { getConfigValue } from "../../lib/config.js";
import { listS3Sources } from "../../lib/s3-sync.js";

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

beforeEach(() => {
  previousHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "emails-aws-command-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
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

});
