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

import {
  SESClient,
  CreateReceiptRuleSetCommand,
  SetActiveReceiptRuleSetCommand,
  ListReceiptRuleSetsCommand,
  CreateReceiptRuleCommand,
  DescribeActiveReceiptRuleSetCommand,
} from "@aws-sdk/client-ses";
import {
  S3Client,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  HeadBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketVersioningCommand,
  PutBucketEncryptionCommand,
} from "@aws-sdk/client-s3";

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

function makeClients(opts: InboundSetupOptions) {
  const region = opts.region || process.env["AWS_REGION"] || "us-east-1";
  const credentials = opts.accessKeyId && opts.secretAccessKey
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
    : undefined;
  return {
    ses: new SESClient({ region, credentials }),
    s3: new S3Client({ region, credentials }),
    region,
  };
}

/**
 * Create S3 bucket with SES delivery policy.
 * Safe to call if bucket already exists (checks first).
 */
async function ensureS3Bucket(s3: S3Client, bucket: string, region: string): Promise<boolean> {
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
 * Attach SES delivery policy to bucket.
 * Allows SES to PutObject into the bucket.
 */
async function attachSesBucketPolicy(s3: S3Client, bucket: string, prefix: string): Promise<void> {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowSESPuts",
        Effect: "Allow",
        Principal: { Service: "ses.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::${bucket}/${prefix}*`,
        Condition: {
          StringEquals: { "AWS:SourceAccount": process.env["AWS_ACCOUNT_ID"] || "*" },
        },
      },
    ],
  };

  await s3.send(new PutBucketPolicyCommand({
    Bucket: bucket,
    Policy: JSON.stringify(policy),
  }));
}

/**
 * Ensure an active SES receipt rule set exists.
 * Returns { name, created }.
 */
async function ensureReceiptRuleSet(ses: SESClient): Promise<{ name: string; created: boolean }> {
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
  const { ses, s3, region } = makeClients(opts);
  const prefix = opts.prefix ?? `inbound/${opts.domain}/`;

  // 1. S3 bucket
  const bucketCreated = await ensureS3Bucket(s3, opts.bucket, region);
  await attachSesBucketPolicy(s3, opts.bucket, prefix);

  // 2. Receipt rule set
  const ruleSet = await ensureReceiptRuleSet(ses);

  // 3. Receipt rule: domain → S3
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
