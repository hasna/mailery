import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setS3SendHandler, resetS3SendHandler } from "../test-support/aws-s3-mock.js";

// ─── Mock AWS SDKs ────────────────────────────────────────────────────────────
// SES is mocked inline (this file is the last-loaded of the SES mockers only where
// it matters and its shape is compatible). The S3 mock is SHARED
// (src/test-support/aws-s3-mock.ts) because a sibling file also drives
// "@aws-sdk/client-s3" through a dynamic import and bun's process-global module mock
// caches the first-resolved namespace — see that module's header. We route the
// shared S3 `send` through this file's `mockS3Send` spy (below) so setupMocks() and
// call assertions keep working.

const mockSesSend = mock(async (_cmd: unknown) => ({}));
const mockS3Send = mock(async (_cmd: unknown) => ({}));

mock.module("@aws-sdk/client-ses", () => ({
  SESClient: class { send = mockSesSend; },
  CreateReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  SetActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  ListReceiptRuleSetsCommand: class { constructor(public input: unknown) {} },
  CreateReceiptRuleCommand: class { constructor(public input: unknown) {} },
  DescribeActiveReceiptRuleSetCommand: class { constructor(public input: unknown) {} },
  DescribeReceiptRuleCommand: class { constructor(public input: unknown) {} },
  UpdateReceiptRuleCommand: class { constructor(public input: unknown) {} },
}));

const { setupInboundEmail, buildSesBucketPolicy } = await import("./aws-inbound.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSesSend.mockReset();
  mockS3Send.mockReset();
  // The shared S3 mock delegates to this file's spy so constructor.name dispatch
  // (setupMocks) and any call assertions observe the commands the source sends.
  setS3SendHandler((cmd) => mockS3Send(cmd));
});

afterEach(() => resetS3SendHandler());

function setupMocks(bucketExists = false) {
  mockS3Send.mockImplementation(async (cmd: unknown) => {
    const name = (cmd as { constructor?: { name?: string } })?.constructor?.name ?? "";
    // HeadBucket — throw to indicate bucket doesn't exist (triggers creation path)
    if (!bucketExists && name === "HeadBucketCommand") {
      throw Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" });
    }
    return {};
  });

  let sesCallCount = 0;
  mockSesSend.mockImplementation(async () => {
    sesCallCount++;
    // First call = DescribeActiveReceiptRuleSet — throw to indicate no active set
    if (sesCallCount === 1) throw new Error("NoActiveRuleSet");
    // Second call = ListReceiptRuleSets — return empty
    if (sesCallCount === 2) return { RuleSets: [] };
    // Remaining calls = CreateReceiptRuleSet, SetActive, CreateRule — succeed
    return {};
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildSesBucketPolicy — must not clobber other domains' grants", () => {
  type Pol = { Statement: { Resource: string; Condition?: unknown }[] };

  it("keeps AWS clients behind setup-only dynamic imports", () => {
    const source = readFileSync(join(import.meta.dir, "aws-inbound.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[\s\S]*?from\s+["']@aws-sdk\/client-(?:s3|ses)["'];/m);
    expect(source).toContain('import("@aws-sdk/client-s3")');
    expect(source).toContain('import("@aws-sdk/client-ses")');
  });

  it("grants the shared inbound base, not a single per-domain prefix", () => {
    const pol = buildSesBucketPolicy("buck", "inbound/elyratelier.com/", "111122223333") as Pol;
    // Must cover ALL inbound objects so a later adopt of another domain still works.
    expect(pol.Statement[0]!.Resource).toBe("arn:aws:s3:::buck/inbound/*");
  });

  it("produces an IDENTICAL policy for different domains (idempotent — no clobber)", () => {
    const a = JSON.stringify(buildSesBucketPolicy("buck", "inbound/elyratelier.com/", "111122223333"));
    const b = JSON.stringify(buildSesBucketPolicy("buck", "inbound/droolbowl.com/", "111122223333"));
    // Re-adopting droolbowl must not change the grant that lets elyratelier receive.
    expect(a).toBe(b);
  });

  it("falls back to the whole bucket when prefix has no folder", () => {
    const pol = buildSesBucketPolicy("buck", "", "111122223333") as Pol;
    expect(pol.Statement[0]!.Resource).toBe("arn:aws:s3:::buck/*");
  });

  it("keeps the SourceAccount condition when an account id is given (and omits it otherwise)", () => {
    expect((buildSesBucketPolicy("buck", "inbound/x.com/", "111122223333") as Pol).Statement[0]!.Condition)
      .toEqual({ StringEquals: { "aws:SourceAccount": "111122223333" } });
    expect((buildSesBucketPolicy("buck", "inbound/x.com/") as Pol).Statement[0]!.Condition).toBeUndefined();
  });
});

describe("setupInboundEmail", () => {
  it("creates bucket and receipt rule when neither exists", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "example.com",
      bucket: "my-emails",
      region: "us-east-1",
    });

    expect(result.bucket).toBe("my-emails");
    expect(typeof result.rule_set).toBe("string");
    expect(typeof result.rule_name).toBe("string");
    expect(result.s3_prefix).toContain("inbound/example.com");
    expect(result.mx_record).toContain("inbound-smtp");
    expect(result.mx_record).toContain("us-east-1");
  });

  it("returns correct mx_record format", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "test.com",
      bucket: "test-bucket",
      region: "eu-west-1",
    });

    expect(result.mx_record).toBe("10 inbound-smtp.eu-west-1.amazonaws.com");
  });

  it("uses default prefix inbound/<domain>/", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "example.com",
      bucket: "example-emails",
    });

    expect(result.s3_prefix).toBe("inbound/example.com/");
  });

  it("respects custom prefix", async () => {
    setupMocks(false);

    const result = await setupInboundEmail({
      domain: "example.com",
      bucket: "example-emails",
      prefix: "custom/prefix/",
    });

    expect(result.s3_prefix).toBe("custom/prefix/");
  });

  it("marks bucket_created=false when bucket exists", async () => {
    // HeadBucket succeeds (bucket exists)
    mockS3Send.mockImplementation(async () => ({}));
    mockSesSend.mockImplementation(async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string } };
      if (c?.constructor?.name === "DescribeActiveReceiptRuleSetCommand") throw new Error("no active");
      if (c?.constructor?.name === "ListReceiptRuleSetsCommand") return { RuleSets: [] };
      return {};
    });

    const result = await setupInboundEmail({ domain: "x.com", bucket: "existing-bucket" });
    expect(result.bucket_created).toBe(false);
  });
});
