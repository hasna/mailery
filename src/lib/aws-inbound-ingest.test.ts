import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { setS3SendHandler, resetS3SendHandler, type S3Command } from "../test-support/aws-s3-mock.js";

// ── SDK mocks (intercept the orchestrator's dynamic imports) ──────────────────
// Mutable fixtures the mocks read, so tests can vary existing bucket state.
let existingNotification: Record<string, unknown> = {};
let existingBucketPolicy: string | undefined;
let sqsCalls: Array<{ type: string; input: Record<string, unknown> }> = [];
let s3Calls: Array<{ type: string; input: Record<string, unknown> }> = [];

function cmd(type: string) {
  return class {
    input: Record<string, unknown>;
    __type = type;
    constructor(input: Record<string, unknown>) { this.input = input; }
  };
}

// SQS is mocked only by this file, so an inline mock.module is safe. The S3 mock is
// SHARED (src/test-support/aws-s3-mock.ts) because a sibling test file also drives
// "@aws-sdk/client-s3" through a dynamic import and bun's process-global module mock
// caches the first-resolved namespace — see that module's header. We install this
// file's S3 `send` behavior via setS3SendHandler in beforeEach below.
mock.module("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    async send(c: { __type: string; input: Record<string, unknown> }) {
      sqsCalls.push({ type: c.__type, input: c.input });
      if (c.__type === "GetQueueUrl") {
        const e = new Error("nonexistent"); (e as Error).name = "QueueDoesNotExist"; throw e; // force create
      }
      if (c.__type === "CreateQueue") return { QueueUrl: `https://sqs.us-east-1.amazonaws.com/638389534677/${c.input["QueueName"]}` };
      if (c.__type === "GetQueueAttributes") {
        const name = String(c.input["QueueUrl"]).split("/").pop();
        return { Attributes: { QueueArn: `arn:aws:sqs:us-east-1:638389534677:${name}` } };
      }
      return {};
    }
  },
  CreateQueueCommand: cmd("CreateQueue"),
  GetQueueUrlCommand: cmd("GetQueueUrl"),
  GetQueueAttributesCommand: cmd("GetQueueAttributes"),
  SetQueueAttributesCommand: cmd("SetQueueAttributes"),
}));

const {
  prefixesOverlap,
  buildIngestQueueStatement,
  buildQueueConsumerStatement,
  buildBucketReaderStatement,
  mergePolicyStatements,
  mergeBucketNotification,
  ensureInboundIngestPipeline,
  INGEST_NOTIFICATION_ID,
} = await import("./aws-inbound-ingest.js");

beforeEach(() => {
  existingNotification = {};
  existingBucketPolicy = undefined;
  sqsCalls = [];
  s3Calls = [];
  // Install this file's S3 send behavior on the shared mock (see aws-s3-mock.ts).
  setS3SendHandler((c: S3Command) => {
    s3Calls.push({ type: c.__type, input: c.input });
    if (c.__type === "GetBucketNotificationConfiguration") return existingNotification;
    if (c.__type === "GetBucketPolicy") {
      if (existingBucketPolicy === undefined) {
        const e = new Error("no policy"); (e as Error).name = "NoSuchBucketPolicy"; throw e;
      }
      return { Policy: existingBucketPolicy };
    }
    return {};
  });
});

afterEach(() => resetS3SendHandler());

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("prefixesOverlap", () => {
  it("detects containment either direction and disjoint", () => {
    expect(prefixesOverlap("inbound/", "inbound/x.com/")).toBe(true);
    expect(prefixesOverlap("inbound/x.com/", "inbound/")).toBe(true);
    expect(prefixesOverlap("inbound/", "")).toBe(true); // "" matches everything
    expect(prefixesOverlap("inbound/", "outbound/")).toBe(false);
  });
});

describe("buildIngestQueueStatement", () => {
  it("scopes S3 send to the bucket ARN and adds SourceAccount when known", () => {
    const s = buildIngestQueueStatement("arn:q", "arn:aws:s3:::b", "638389534677") as Record<string, unknown>;
    expect(s["Principal"]).toEqual({ Service: "s3.amazonaws.com" });
    expect(s["Action"]).toBe("sqs:SendMessage");
    expect((s["Condition"] as Record<string, unknown>)["ArnLike"]).toEqual({ "aws:SourceArn": "arn:aws:s3:::b" });
    expect((s["Condition"] as Record<string, unknown>)["StringEquals"]).toEqual({ "aws:SourceAccount": "638389534677" });
  });
  it("omits SourceAccount when unknown", () => {
    const s = buildIngestQueueStatement("arn:q", "arn:aws:s3:::b") as Record<string, unknown>;
    expect((s["Condition"] as Record<string, unknown>)["StringEquals"]).toBeUndefined();
  });
});

describe("cross-account grant statements", () => {
  it("consumer statement grants receive/delete to the role", () => {
    const s = buildQueueConsumerStatement("arn:q", "arn:aws:iam::123456789012:role/emails-prod-task") as Record<string, unknown>;
    expect(s["Principal"]).toEqual({ AWS: "arn:aws:iam::123456789012:role/emails-prod-task" });
    expect(s["Action"]).toContain("sqs:ReceiveMessage");
    expect(s["Action"]).toContain("sqs:DeleteMessage");
  });
  it("reader statement grants GetObject on the shared base prefix", () => {
    const s = buildBucketReaderStatement("b", "inbound/hasna.com/", "arn:role") as Record<string, unknown>;
    expect(s["Resource"]).toBe("arn:aws:s3:::b/inbound/*");
    expect(s["Action"]).toEqual(["s3:GetObject"]);
  });
});

describe("mergePolicyStatements", () => {
  it("replaces our Sids and preserves foreign statements (e.g. SES PutObject)", () => {
    const existing = JSON.stringify({ Version: "2012-10-17", Statement: [
      { Sid: "AllowSESPuts", Effect: "Allow", Principal: { Service: "ses.amazonaws.com" }, Action: "s3:PutObject" },
      { Sid: "AllowCrossAccountInboundRead", Effect: "Allow", Note: "stale" },
    ] });
    const merged = mergePolicyStatements(existing, [buildBucketReaderStatement("b", "inbound/", "arn:role")]) as { Statement: Array<Record<string, unknown>> };
    const sids = merged.Statement.map((s) => s["Sid"]);
    expect(sids).toContain("AllowSESPuts"); // preserved
    expect(sids.filter((x) => x === "AllowCrossAccountInboundRead").length).toBe(1); // replaced, not duplicated
    const reader = merged.Statement.find((s) => s["Sid"] === "AllowCrossAccountInboundRead")!;
    expect(reader["Note"]).toBeUndefined(); // it's OUR fresh statement, not the stale one
  });
  it("tolerates a missing/malformed existing policy", () => {
    expect((mergePolicyStatements(undefined, [{ Sid: "X" }]) as { Statement: unknown[] }).Statement.length).toBe(1);
    expect((mergePolicyStatements("{not json", [{ Sid: "X" }]) as { Statement: unknown[] }).Statement.length).toBe(1);
  });
});

describe("mergeBucketNotification", () => {
  it("adds our config and drops a narrower overlapping ObjectCreated queue config", () => {
    const existing = { QueueConfigurations: [
      { Id: "realtime-grumpy", QueueArn: "arn:other", Events: ["s3:ObjectCreated:*"], Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "inbound/grumpypicklerocket.com/" }] } } },
    ] };
    const { config, removedIds } = mergeBucketNotification(existing, "inbound/", "arn:ours");
    expect(removedIds).toContain("realtime-grumpy");
    const q = config.QueueConfigurations!;
    expect(q.length).toBe(1);
    expect(q[0]!.Id).toBe(INGEST_NOTIFICATION_ID);
    expect(q[0]!.QueueArn).toBe("arn:ours");
  });
  it("preserves a non-overlapping config and Topic configs", () => {
    const existing = {
      QueueConfigurations: [{ Id: "other", QueueArn: "arn:x", Events: ["s3:ObjectCreated:*"], Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "archive/" }] } } }],
      TopicConfigurations: [{ Id: "t1" }],
    };
    const { config, removedIds } = mergeBucketNotification(existing, "inbound/", "arn:ours");
    expect(removedIds).toEqual([]);
    expect(config.QueueConfigurations!.map((c) => c.Id).sort()).toEqual(["other", INGEST_NOTIFICATION_ID].sort());
    expect(config.TopicConfigurations).toEqual([{ Id: "t1" }]);
  });
});

// ── orchestrator ─────────────────────────────────────────────────────────────

function put(type: string) { return s3Calls.find((c) => c.type === type)?.input; }

describe("ensureInboundIngestPipeline — same account", () => {
  it("creates queue+DLQ, sets S3-send-only policy, installs notification, no bucket policy", async () => {
    const r = await ensureInboundIngestPipeline({ bucket: "b", queueName: "emails-prod-ingest", region: "us-east-1", accountId: "638389534677" });
    expect(r.queue_created).toBe(true);
    expect(r.dlq_arn).toContain("emails-prod-ingest-dlq");
    expect(r.notification_installed).toBe(true);
    expect(r.consumer_role_arn).toBeNull();
    expect(r.bucket_reader_granted).toBe(false);
    expect(r.worker_setup).toBeNull();
    // queue policy set with exactly the S3-send statement
    const setPolicy = sqsCalls.find((c) => c.type === "SetQueueAttributes")!;
    const pol = JSON.parse(String((setPolicy.input["Attributes"] as Record<string, string>)["Policy"]));
    expect(pol.Statement.map((s: Record<string, unknown>) => s["Sid"])).toEqual(["AllowS3InboundNotify"]);
    // no bucket policy write in same-account mode
    expect(put("PutBucketPolicy")).toBeUndefined();
    expect(put("PutBucketNotificationConfiguration")).toBeDefined();
  });
});

describe("ensureInboundIngestPipeline — cross account", () => {
  it("grants consumer on queue + reader on bucket (preserving SES), and returns worker setup", async () => {
    existingBucketPolicy = JSON.stringify({ Version: "2012-10-17", Statement: [
      { Sid: "AllowSESPuts", Effect: "Allow", Principal: { Service: "ses.amazonaws.com" }, Action: "s3:PutObject", Resource: "arn:aws:s3:::b/inbound/*" },
    ] });
    const roleArn = "arn:aws:iam::123456789012:role/emails-prod-task";
    const r = await ensureInboundIngestPipeline({
      bucket: "b", queueName: "emails-prod-ingest", region: "us-east-1", accountId: "638389534677", consumerRoleArn: roleArn,
    });
    expect(r.consumer_role_arn).toBe(roleArn);
    expect(r.bucket_reader_granted).toBe(true);
    expect(r.worker_setup?.ecs_env).toEqual({ EMAILS_INGEST_S3_BUCKET: "b", EMAILS_INGEST_QUEUE_URL: r.queue_url });

    // queue policy has BOTH the S3 send and the cross-account consume statements
    const setPolicy = sqsCalls.filter((c) => c.type === "SetQueueAttributes").pop()!;
    const qpol = JSON.parse(String((setPolicy.input["Attributes"] as Record<string, string>)["Policy"]));
    expect(qpol.Statement.map((s: Record<string, unknown>) => s["Sid"]).sort()).toEqual(["AllowCrossAccountConsume", "AllowS3InboundNotify"]);

    // bucket policy PUT preserves SES grant and adds the reader
    const bpolInput = put("PutBucketPolicy")!;
    const bpol = JSON.parse(String(bpolInput["Policy"]));
    const bsids = bpol.Statement.map((s: Record<string, unknown>) => s["Sid"]);
    expect(bsids).toContain("AllowSESPuts");
    expect(bsids).toContain("AllowCrossAccountInboundRead");
  });
});
