/**
 * AWS SES inbound email setup — S3 bucket + receipt rules.
 *
 * Creates the AWS infrastructure needed to receive email:
 *   1. S3 bucket with SES PutObject policy
 *   2. SES receipt rule set (creates if none active)
 *   3. SES receipt rule: domain → S3 with prefix inbound/{domain}/
 *
 * Uses SES v1 (not SESv2) because receipt rules are only in v1.
 * Uses @aws-sdk/client-s3 for bucket creation (already a dep via s3 config).
 */

import type { S3Client } from "@aws-sdk/client-s3";
import type { SESClient } from "@aws-sdk/client-ses";

export interface InboundSetupOptions {
  domain: string;
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
  /** If true, also catch subdomains via wildcard */
  catchAll?: boolean;
}

export interface InboundSetupResult {
  bucket: string;
  bucket_created: boolean;
  rule_set: string;
  rule_set_created: boolean;
  rule_name: string;
  rule_created: boolean;
  s3_prefix: string;
  mx_record: string;
}

type S3Sdk = typeof import("@aws-sdk/client-s3");
type SesSdk = typeof import("@aws-sdk/client-ses");

let s3SdkPromise: Promise<S3Sdk> | undefined;
let sesSdkPromise: Promise<SesSdk> | undefined;

function loadS3Sdk(): Promise<S3Sdk> {
  s3SdkPromise ??= import("@aws-sdk/client-s3");
  return s3SdkPromise;
}

function loadSesSdk(): Promise<SesSdk> {
  sesSdkPromise ??= import("@aws-sdk/client-ses");
  return sesSdkPromise;
}

async function makeClients(opts: InboundSetupOptions) {
  const region = opts.region || process.env["AWS_REGION"] || "us-east-1";
  const credentials = opts.accessKeyId && opts.secretAccessKey
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
    : undefined;
  const [s3Sdk, sesSdk] = await Promise.all([loadS3Sdk(), loadSesSdk()]);
  const { S3Client } = s3Sdk;
  const { SESClient } = sesSdk;
  return {
    ses: new SESClient({ region, credentials }),
    s3: new S3Client({ region, credentials }),
    region,
    s3Sdk,
    sesSdk,
  };
}

/**
 * Create S3 bucket with SES delivery policy.
 * Safe to call if bucket already exists (checks first).
 */
async function ensureS3Bucket(s3: S3Client, s3Sdk: S3Sdk, bucket: string, region: string): Promise<boolean> {
  const {
    CreateBucketCommand,
    HeadBucketCommand,
    PutBucketEncryptionCommand,
    PutBucketVersioningCommand,
    PutPublicAccessBlockCommand,
  } = s3Sdk;

  // Check if already exists
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return false; // already exists
  } catch {
    // Doesn't exist — create it
  }

  await s3.send(new CreateBucketCommand({
    Bucket: bucket,
    ...(region !== "us-east-1" ? {
      CreateBucketConfiguration: { LocationConstraint: region as never },
    } : {}),
  }));

  // Block public access
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }));

  // Enable versioning
  await s3.send(new PutBucketVersioningCommand({
    Bucket: bucket,
    VersioningConfiguration: { Status: "Enabled" },
  }));

  // Enable SSE encryption
  await s3.send(new PutBucketEncryptionCommand({
    Bucket: bucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
    },
  }));

  return true; // created
}

/**
 * Build the SES inbound bucket policy.
 *
 * The grant Resource MUST cover the shared inbound base (e.g. `inbound/*`), NOT
 * the single per-domain prefix. `PutBucketPolicy` REPLACES the whole policy, so
 * a per-domain Resource means every `domain adopt` clobbers the previous
 * domain's grant — only the last-adopted domain can receive; all others bounce
 * with "recipient error" because SES can't write their objects. Granting the
 * shared base makes the policy identical for every domain → idempotent, no
 * clobbering.
 *
 * The aws:SourceAccount condition must be the REAL account id — a literal "*"
 * with StringEquals never matches, which denies SES
 * (InvalidS3ConfigurationException). When the account id is unknown, omit the
 * condition entirely (SES can still write). Pure + testable.
 */
export function buildSesBucketPolicy(bucket: string, prefix: string, accountId?: string): object {
  // Shared base = the top-level folder of the prefix (e.g. "inbound" from
  // "inbound/elyratelier.com/"); fall back to the whole bucket if there is none.
  const base = prefix.split("/")[0];
  const resource = base ? `arn:aws:s3:::${bucket}/${base}/*` : `arn:aws:s3:::${bucket}/*`;
  const statement: Record<string, unknown> = {
    Sid: "AllowSESPuts",
    Effect: "Allow",
    Principal: { Service: "ses.amazonaws.com" },
    Action: "s3:PutObject",
    Resource: resource,
  };
  if (accountId) statement["Condition"] = { StringEquals: { "aws:SourceAccount": accountId } };
  return { Version: "2012-10-17", Statement: [statement] };
}

async function attachSesBucketPolicy(s3: S3Client, s3Sdk: S3Sdk, bucket: string, prefix: string, accountId?: string): Promise<void> {
  const { PutBucketPolicyCommand } = s3Sdk;
  await s3.send(new PutBucketPolicyCommand({
    Bucket: bucket,
    Policy: JSON.stringify(buildSesBucketPolicy(bucket, prefix, accountId)),
  }));
}

/**
 * Ensure an active SES receipt rule set exists.
 * Returns { name, created }.
 */
async function ensureReceiptRuleSet(ses: SESClient, sesSdk: SesSdk): Promise<{ name: string; created: boolean }> {
  const {
    CreateReceiptRuleSetCommand,
    DescribeActiveReceiptRuleSetCommand,
    ListReceiptRuleSetsCommand,
    SetActiveReceiptRuleSetCommand,
  } = sesSdk;

  // Check for active rule set
  try {
    const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
    if (active.Metadata?.Name) {
      return { name: active.Metadata.Name, created: false };
    }
  } catch { /* no active rule set */ }

  // Check existing rule sets
  const list = await ses.send(new ListReceiptRuleSetsCommand({}));
  const existing = list.RuleSets?.[0];
  if (existing?.Name) {
    await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: existing.Name }));
    return { name: existing.Name, created: false };
  }

  // Create new rule set
  const name = "emails-inbound";
  await ses.send(new CreateReceiptRuleSetCommand({ RuleSetName: name }));
  await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: name }));
  return { name, created: true };
}

/**
 * Full setup: S3 bucket + SES receipt rule for the domain.
 */
export async function setupInboundEmail(opts: InboundSetupOptions): Promise<InboundSetupResult> {
  const { ses, s3, region, s3Sdk, sesSdk } = await makeClients(opts);
  const prefix = opts.prefix ?? `inbound/${opts.domain}/`;

  // Resolve the account id so the SES bucket policy condition is correct.
  let accountId = process.env["AWS_ACCOUNT_ID"];
  if (!accountId) {
    try {
      const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      const credentials = opts.accessKeyId && opts.secretAccessKey
        ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
        : undefined;
      const sts = new STSClient({ region, credentials });
      const id = await sts.send(new GetCallerIdentityCommand({}));
      accountId = id.Account;
    } catch {
      // leave undefined — policy will omit the condition
    }
  }

  // 1. S3 bucket
  const bucketCreated = await ensureS3Bucket(s3, s3Sdk, opts.bucket, region);
  await attachSesBucketPolicy(s3, s3Sdk, opts.bucket, prefix, accountId);

  // 2. Receipt rule set
  const ruleSet = await ensureReceiptRuleSet(ses, sesSdk);

  // 3. Receipt rule: domain → S3
  const { CreateReceiptRuleCommand } = sesSdk;
  const ruleName = `inbound-${opts.domain.replace(/\./g, "-")}`;
  let ruleCreated = false;
  try {
    await ses.send(new CreateReceiptRuleCommand({
      RuleSetName: ruleSet.name,
      Rule: {
        Name: ruleName,
        Enabled: true,
        Recipients: opts.catchAll
          ? [opts.domain, `.${opts.domain}`]
          : [opts.domain],
        Actions: [
          {
            S3Action: {
              BucketName: opts.bucket,
              ObjectKeyPrefix: prefix,
            },
          },
        ],
        ScanEnabled: true,
      },
    }));
    ruleCreated = true;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AlreadyExistsException") {
      ruleCreated = false;
    } else {
      throw e;
    }
  }

  return {
    bucket: opts.bucket,
    bucket_created: bucketCreated,
    rule_set: ruleSet.name,
    rule_set_created: ruleSet.created,
    rule_name: ruleName,
    rule_created: ruleCreated,
    s3_prefix: prefix,
    // MX record needed to route incoming email to SES
    mx_record: `10 inbound-smtp.${region}.amazonaws.com`,
  };
}
