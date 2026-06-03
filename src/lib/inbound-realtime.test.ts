import { describe, it, expect } from "bun:test";
import { parseSesNotification, watchInboundOnce, type SqsLike } from "./inbound-realtime.js";

// A real SES "Received" notification (the Message field SES publishes to SNS).
const sesNotification = JSON.stringify({
  notificationType: "Received",
  mail: {
    messageId: "abc123messageid",
    source: "alice@external.com",
    destination: ["ops@acme.com"],
  },
  receipt: {
    recipients: ["ops@acme.com"],
    action: { type: "S3", bucketName: "acme-inbound", objectKey: "inbound/acme.com/abc123messageid" },
  },
});

// The same, wrapped in an SNS envelope (what arrives over SQS / HTTP).
const snsEnvelope = JSON.stringify({ Type: "Notification", MessageId: "sns-1", TopicArn: "arn:…", Message: sesNotification });

describe("parseSesNotification", () => {
  it("parses a raw SES notification", () => {
    const r = parseSesNotification(sesNotification);
    expect(r).toEqual({ messageId: "abc123messageid", bucket: "acme-inbound", objectKey: "inbound/acme.com/abc123messageid", recipients: ["ops@acme.com"] });
  });

  it("unwraps an SNS envelope", () => {
    const r = parseSesNotification(snsEnvelope);
    expect(r?.objectKey).toBe("inbound/acme.com/abc123messageid");
    expect(r?.bucket).toBe("acme-inbound");
  });

  it("handles an S3 ObjectCreated event shape", () => {
    const s3event = JSON.stringify({ Records: [{ s3: { bucket: { name: "acme-inbound" }, object: { key: "inbound/acme.com/xyz" } } }] });
    const r = parseSesNotification(s3event);
    expect(r?.bucket).toBe("acme-inbound");
    expect(r?.objectKey).toBe("inbound/acme.com/xyz");
  });

  it("returns null for garbage", () => {
    expect(parseSesNotification("not json")).toBeNull();
    expect(parseSesNotification(JSON.stringify({ hello: "world" }))).toBeNull();
  });
});

describe("watchInboundOnce", () => {
  function fakeSqs(messages: Array<{ ReceiptHandle: string; Body: string }>): { sqs: SqsLike; deleted: string[] } {
    const deleted: string[] = [];
    const sqs: SqsLike = {
      receive: async () => messages,
      deleteMessage: async (handle) => { deleted.push(handle); },
    };
    return { sqs, deleted };
  }

  it("triggers a sync once when messages arrive and deletes them", async () => {
    const { sqs, deleted } = fakeSqs([
      { ReceiptHandle: "h1", Body: snsEnvelope },
      { ReceiptHandle: "h2", Body: snsEnvelope },
    ]);
    let syncs = 0;
    const r = await watchInboundOnce(sqs, "q-url", async () => { syncs++; });
    expect(r.messages).toBe(2);
    expect(r.triggered).toBe(true);
    expect(syncs).toBe(1); // batched: one sync per poll, not per message
    expect(deleted).toEqual(["h1", "h2"]);
  });

  it("does nothing when the queue is empty", async () => {
    const { sqs, deleted } = fakeSqs([]);
    let syncs = 0;
    const r = await watchInboundOnce(sqs, "q-url", async () => { syncs++; });
    expect(r.messages).toBe(0);
    expect(r.triggered).toBe(false);
    expect(syncs).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("does not delete a message if the sync throws (so it is retried)", async () => {
    const { sqs, deleted } = fakeSqs([{ ReceiptHandle: "h1", Body: snsEnvelope }]);
    await expect(watchInboundOnce(sqs, "q-url", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(deleted).toEqual([]);
  });
});

describe("watchInboundOnce — drains backlog before deleting", () => {
  function fakeSqs2(messages: Array<{ ReceiptHandle: string; Body: string }>) {
    const deleted: string[] = [];
    const sqs = { receive: async () => messages, deleteMessage: async (h: string) => { deleted.push(h); } };
    return { sqs, deleted };
  }
  it("repeats sync while it keeps pulling new mail, then deletes", async () => {
    const { sqs, deleted } = fakeSqs2([{ ReceiptHandle: "h1", Body: snsEnvelope }]);
    let calls = 0;
    // simulate a backlog: first 3 scans pull mail, then 0
    const r = await watchInboundOnce(sqs, "q", async () => { calls++; return { synced: calls <= 3 ? 100 : 0 }; });
    expect(calls).toBe(4);        // 3 productive + 1 empty
    expect(r.triggered).toBe(true);
    expect(deleted).toEqual(["h1"]); // deleted only after the full drain
  });
})
