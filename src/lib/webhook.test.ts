import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { parseResendWebhook, parseSesWebhook, createWebhookServer } from "./webhook.js";
import { closeDatabase, resetDatabase } from "../db/database.js";

// ─── createWebhookServer helpers ─────────────────────────────────────────────

function randomPort(): number {
  return 19877 + (Math.random() * 100 | 0);
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── createWebhookServer tests ────────────────────────────────────────────────

describe("webhook module startup contract", () => {
  it("keeps DB persistence and console coloring lazy until a request is handled", () => {
    const source = readFileSync(`${import.meta.dir}/webhook.ts`, "utf8");
    const staticImports = [...source.matchAll(/^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm)]
      .map((match) => match[1]);

    expect(staticImports).not.toContain("../db/database.js");
    expect(staticImports).not.toContain("../db/events.js");
    expect(staticImports).not.toContain("chalk");
    expect(source).toContain('import("../db/database.js")');
    expect(source).toContain('import("../db/events.js")');
    expect(source).toContain('import("chalk")');
  });
});

describe("createWebhookServer", () => {
  let server: ReturnType<typeof createWebhookServer>;
  let port: number;
  let base: string;

  beforeEach(() => {
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
    port = randomPort();
    server = createWebhookServer(port);
    base = `http://localhost:${port}`;
  });

  afterEach(() => {
    server.stop(true);
    closeDatabase();
    delete process.env["EMAILS_DB_PATH"];
  });

  it("returns 404 for unknown path", async () => {
    const res = await post(`${base}/webhook/unknown`, { type: "email.delivered" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${base}/webhook/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 405 for non-POST request", async () => {
    const res = await fetch(`${base}/webhook/resend`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("accepts a valid Resend delivered payload and returns 200", async () => {
    const payload = {
      type: "email.delivered",
      data: {
        email_id: "resend-evt-001",
        to: ["user@example.com"],
        created_at: "2025-01-15T10:00:00Z",
      },
    };
    const res = await post(`${base}/webhook/resend`, payload);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("accepts a valid SES Delivery payload and returns 200", async () => {
    const payload = {
      notificationType: "Delivery",
      mail: {
        messageId: "ses-msg-webhook-001",
        destination: ["user@example.com"],
        timestamp: "2025-01-15T10:00:00Z",
      },
    };
    const res = await post(`${base}/webhook/ses`, payload);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("returns 200 with 'Unrecognized event type' for unknown Resend type", async () => {
    const res = await post(`${base}/webhook/resend`, { type: "email.unknown", data: {} });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Unrecognized");
  });

  it("returns 200 with 'Unrecognized event type' for unknown SES notification type", async () => {
    const res = await post(`${base}/webhook/ses`, { notificationType: "Unknown", mail: {} });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Unrecognized");
  });

  it("uses provided providerId when constructing the server", async () => {
    server.stop(true);
    closeDatabase();
    resetDatabase();
    const p2 = randomPort() + 50;
    const s2 = createWebhookServer(p2, "my-provider-id");
    try {
      const payload = {
        type: "email.delivered",
        data: {
          email_id: "resend-evt-pid",
          to: ["x@example.com"],
          created_at: "2025-01-15T10:00:00Z",
        },
      };
      // The upsertEvent call will fail silently (no provider in DB) — but server responds 200
      const res = await post(`http://localhost:${p2}/webhook/resend`, payload);
      expect(res.status).toBe(200);
    } finally {
      s2.stop(true);
    }
  });

  it("server stops cleanly after test", async () => {
    // Verify server is running first
    const res = await post(`${base}/webhook/resend`, {
      type: "email.delivered",
      data: { email_id: "stop-test", to: ["a@b.com"], created_at: new Date().toISOString() },
    });
    expect(res.status).toBe(200);
    // server.stop() is called in afterEach — no assertion needed here,
    // but we ensure no unhandled error is thrown
    expect(() => server.stop(true)).not.toThrow();
  });
});

describe("parseResendWebhook", () => {
  it("parses email.delivered event", () => {
    const body = {
      type: "email.delivered",
      data: {
        email_id: "evt-123",
        to: ["user@example.com"],
        created_at: "2025-01-15T10:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBe("user@example.com");
    expect(event!.provider_event_id).toBe("evt-123");
    expect(event!.occurred_at).toBe("2025-01-15T10:00:00Z");
  });

  it("parses email.bounced event", () => {
    const body = {
      type: "email.bounced",
      data: {
        email_id: "evt-456",
        to: "bounce@example.com",
        created_at: "2025-01-15T11:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("bounced");
    expect(event!.recipient).toBe("bounce@example.com");
  });

  it("parses email.complained event", () => {
    const body = {
      type: "email.complained",
      data: {
        email_id: "evt-789",
        to: ["complainer@example.com"],
        created_at: "2025-01-15T12:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("complained");
  });

  it("parses email.opened event", () => {
    const body = {
      type: "email.opened",
      data: {
        email_id: "evt-open",
        to: ["reader@example.com"],
        created_at: "2025-01-15T13:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("opened");
  });

  it("parses email.clicked event", () => {
    const body = {
      type: "email.clicked",
      data: {
        email_id: "evt-click",
        to: ["clicker@example.com"],
        created_at: "2025-01-15T14:00:00Z",
      },
    };
    const event = parseResendWebhook(body);
    expect(event!.type).toBe("clicked");
  });

  it("returns null for unknown event type", () => {
    const body = { type: "email.unknown", data: {} };
    expect(parseResendWebhook(body)).toBeNull();
  });

  it("returns null for completely unrecognized payload", () => {
    const body = { something: "else" };
    expect(parseResendWebhook(body)).toBeNull();
  });

  it("handles missing data gracefully", () => {
    const body = { type: "email.delivered" };
    const event = parseResendWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBeUndefined();
  });
});

describe("parseSesWebhook", () => {
  it("parses Delivery notification", () => {
    const body = {
      notificationType: "Delivery",
      mail: {
        messageId: "ses-msg-123",
        destination: ["user@example.com"],
        timestamp: "2025-01-15T10:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBe("user@example.com");
    expect(event!.provider_message_id).toBe("ses-msg-123");
    expect(event!.occurred_at).toBe("2025-01-15T10:00:00Z");
  });

  it("parses Bounce notification", () => {
    const body = {
      notificationType: "Bounce",
      mail: {
        messageId: "ses-msg-456",
        destination: ["bounce@example.com"],
        timestamp: "2025-01-15T11:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event!.type).toBe("bounced");
    expect(event!.recipient).toBe("bounce@example.com");
  });

  it("parses Complaint notification", () => {
    const body = {
      notificationType: "Complaint",
      mail: {
        messageId: "ses-msg-789",
        destination: ["complainer@example.com"],
        timestamp: "2025-01-15T12:00:00Z",
      },
    };
    const event = parseSesWebhook(body);
    expect(event!.type).toBe("complained");
  });

  it("returns null for unknown notification type", () => {
    const body = { notificationType: "Unknown", mail: {} };
    expect(parseSesWebhook(body)).toBeNull();
  });

  it("returns null for missing notificationType", () => {
    const body = { mail: { messageId: "test" } };
    expect(parseSesWebhook(body)).toBeNull();
  });

  it("handles missing mail fields gracefully", () => {
    const body = { notificationType: "Delivery" };
    const event = parseSesWebhook(body);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("delivered");
    expect(event!.recipient).toBeUndefined();
  });
});

// ─── verifyResendSignature ────────────────────────────────────────────────────

describe("verifyResendSignature", () => {
  it("returns false when svix headers are missing", async () => {
    const { verifyResendSignature } = await import("./webhook.js");
    const result = await verifyResendSignature('{"type":"test"}', {}, "whsec_test");
    expect(result).toBe(false);
  });

  it("returns false when timestamp is too old (> 5 min)", async () => {
    const { verifyResendSignature } = await import("./webhook.js");
    const oldTs = Math.floor(Date.now() / 1000) - 400; // 400s ago
    const result = await verifyResendSignature('{}', {
      "svix-id": "msg_123",
      "svix-timestamp": String(oldTs),
      "svix-signature": "v1,fakesig",
    }, "whsec_dGVzdA==");
    expect(result).toBe(false);
  });

  it("returns false with wrong secret", async () => {
    const { verifyResendSignature } = await import("./webhook.js");
    const ts = Math.floor(Date.now() / 1000);
    const result = await verifyResendSignature('{}', {
      "svix-id": "msg_123",
      "svix-timestamp": String(ts),
      "svix-signature": "v1,wrongsignature==",
    }, "whsec_dGVzdA==");
    expect(result).toBe(false);
  });
});

// ─── verifySnsStructure ───────────────────────────────────────────────────────

describe("verifySnsStructure", () => {
  it("returns true for valid SNS Notification", async () => {
    const { verifySnsStructure } = await import("./webhook.js");
    // Use dynamic require to avoid circular import issues
    const result = verifySnsStructure({ Type: "Notification", TopicArn: "arn:aws:sns:us-east-1:123:topic" });
    expect(result).toBe(true);
  });

  it("returns true for payload without Type (direct SES format)", async () => {
    const { verifySnsStructure } = await import("./webhook.js");
    const result = verifySnsStructure({ notificationType: "Delivery", mail: {} });
    expect(result).toBe(true);
  });

  it("returns false when TopicArn is not from amazonaws.com", async () => {
    const { verifySnsStructure } = await import("./webhook.js");
    const result = verifySnsStructure({ Type: "Notification", TopicArn: "arn:evil:attacker:topic" });
    expect(result).toBe(false);
  });

  it("returns false for invalid Type", async () => {
    const { verifySnsStructure } = await import("./webhook.js");
    const result = verifySnsStructure({ Type: "RandomUnknownType" });
    expect(result).toBe(false);
  });
});
