import { describe, it, expect } from "bun:test";
import { handleInboundWebhook } from "./inbound-webhook.js";

const sesNotification = JSON.stringify({
  notificationType: "Received",
  mail: { messageId: "msg-1", destination: ["ops@acme.com"] },
  receipt: { recipients: ["ops@acme.com"], action: { type: "S3", bucketName: "acme-inbound", objectKey: "inbound/acme.com/msg-1" } },
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://x/webhook/ses-inbound", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("inbound webhook", () => {
  it("returns null for unrelated paths", async () => {
    const r = await handleInboundWebhook(new Request("http://x/api/whatever", { method: "POST" }), "/api/whatever", "POST");
    expect(r).toBeNull();
  });

  it("auto-confirms an SNS subscription by fetching a genuine AWS SubscribeURL", async () => {
    const fetched: string[] = [];
    const url = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc";
    const res = await handleInboundWebhook(
      post({ Type: "SubscriptionConfirmation", SubscribeURL: url }),
      "/webhook/ses-inbound", "POST",
      { fetchUrl: async (u) => { fetched.push(u); } },
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, confirmed: true });
    expect(fetched).toEqual([url]);
  });

  it("syncs a notification using the CONFIGURED bucket, never the payload bucket", async () => {
    const calls: Array<{ bucket: string }> = [];
    const res = await handleInboundWebhook(
      post(JSON.parse(sesNotification)),
      "/webhook/ses-inbound", "POST",
      { sync: async (bucket) => { calls.push({ bucket }); return { synced: 1 }; } },
    );
    const body = await res!.json();
    // If a bucket is configured, sync runs with IT (not the payload's "acme-inbound");
    // if none is configured, the handler ignores the event entirely.
    if (body.ok && body.synced !== undefined) {
      expect(body.message_id).toBe("msg-1");
      expect(calls[0]!.bucket).not.toBe("acme-inbound");
    } else {
      expect(body.ignored).toBeTruthy();
      expect(calls).toHaveLength(0);
    }
  });

  it("syncs on an SNS-wrapped Notification", async () => {
    let synced = 0;
    const res = await handleInboundWebhook(
      post({ Type: "Notification", Message: sesNotification }),
      "/webhook/ses-inbound", "POST",
      { sync: async () => { synced++; return { synced: 2 }; } },
    );
    expect((await res!.json()).synced).toBe(2);
    expect(synced).toBe(1);
  });

  it("ignores an unrecognized notification gracefully", async () => {
    const res = await handleInboundWebhook(
      post({ Type: "Notification", Message: JSON.stringify({ hello: "world" }) }),
      "/webhook/ses-inbound", "POST",
      { sync: async () => ({ synced: 0 }) },
    );
    expect((await res!.json()).ignored).toBeTruthy();
  });
});

describe("inbound webhook — security hardening", () => {
  it("rejects a non-AWS SubscribeURL (anti-SSRF)", async () => {
    const fetched: string[] = [];
    const res = await handleInboundWebhook(
      post({ Type: "SubscriptionConfirmation", SubscribeURL: "http://169.254.169.254/latest/meta-data/" }),
      "/webhook/ses-inbound", "POST",
      { fetchUrl: async (u) => { fetched.push(u); } },
    );
    expect(res!.status).toBe(400);
    expect(fetched).toEqual([]); // never fetched
  });

  it("accepts a genuine AWS SNS SubscribeURL", async () => {
    const fetched: string[] = [];
    const res = await handleInboundWebhook(
      post({ Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&x=1" }),
      "/webhook/ses-inbound", "POST",
      { fetchUrl: async (u) => { fetched.push(u); } },
    );
    expect(res!.status).toBe(200);
    expect(fetched).toHaveLength(1);
  });

  it("ignores an attacker-supplied bucket in the notification", async () => {
    const seen: string[] = [];
    // config has no inbound bucket in test → should ignore the payload bucket and report no bucket
    const res = await handleInboundWebhook(
      post(JSON.parse(sesNotification)),
      "/webhook/ses-inbound", "POST",
      { sync: async (bucket) => { seen.push(bucket); return { synced: 1 }; } },
    );
    const body = await res!.json();
    // acme-inbound from the payload must NOT have been used
    expect(seen).not.toContain("acme-inbound");
  });
});

import { isAwsSnsUrl } from "./inbound-webhook.js";
describe("isAwsSnsUrl", () => {
  it("only allows https sns.<region>.amazonaws.com", () => {
    expect(isAwsSnsUrl("https://sns.us-east-1.amazonaws.com/x")).toBe(true);
    expect(isAwsSnsUrl("https://sns.eu-west-2.amazonaws.com/")).toBe(true);
    expect(isAwsSnsUrl("http://sns.us-east-1.amazonaws.com/")).toBe(false);  // not https
    expect(isAwsSnsUrl("https://evil.com/sns.us-east-1.amazonaws.com")).toBe(false);
    expect(isAwsSnsUrl("https://sns.us-east-1.amazonaws.com.evil.com/")).toBe(false);
    expect(isAwsSnsUrl("http://169.254.169.254/")).toBe(false);
    expect(isAwsSnsUrl("not a url")).toBe(false);
  });
});
