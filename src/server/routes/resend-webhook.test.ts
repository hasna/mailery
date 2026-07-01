import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { listInboundEmails } from "../../db/inbound.js";
import { handleResendWebhook } from "./resend-webhook.js";

beforeEach(() => { process.env["EMAILS_DB_PATH"] = ":memory:"; resetDatabase(); createProvider({ name: "Resend", type: "resend", active: true }); });
afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["RESEND_WEBHOOK_SECRET"];
  delete process.env["MAILERY_MODE"];
  delete process.env["HASNA_EMAILS_DATABASE_URL"];
});

function post(body: unknown): Request {
  return new Request("http://x/webhook/resend-inbound", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const inboundEvent = {
  type: "inbound.email.received",
  created_at: "2026-06-03T10:00:00.000Z",
  data: { email_id: "re_123", from: "alice@ext.com", to: ["ops@mine.com"], subject: "Hello via Resend", text: "hi there", html: "<p>hi there</p>", headers: {} },
};

describe("resend inbound webhook", () => {
  it("returns null for other paths", async () => {
    expect(await handleResendWebhook(new Request("http://x/api/x", { method: "POST" }), "/api/x", "POST")).toBeNull();
  });

  it("stores an inbound Resend email", async () => {
    const res = (await handleResendWebhook(post(inboundEvent), "/webhook/resend-inbound", "POST"))!;
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBeTruthy();
    const inbox = listInboundEmails({}, getDatabase());
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toBe("Hello via Resend");
    expect(inbox[0]!.from_address).toBe("alice@ext.com");
  });

  it("does not store Resend inbound email locally in self-hosted mode", async () => {
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://self-hosted-test";

    const res = (await handleResendWebhook(post(inboundEvent), "/webhook/resend-inbound", "POST"))!;

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("disabled in self_hosted mode"),
    });
    expect(listInboundEmails({}, getDatabase())).toHaveLength(0);
  });

  it("ignores non-inbound events", async () => {
    const res = (await handleResendWebhook(post({ type: "email.sent", data: {} }), "/webhook/resend-inbound", "POST"))!;
    expect((await res.json()).ignored).toBeTruthy();
    expect(listInboundEmails({}, getDatabase())).toHaveLength(0);
  });

  it("rejects a bad signature when a secret is configured", async () => {
    process.env["RESEND_WEBHOOK_SECRET"] = "shh";
    const res = (await handleResendWebhook(post(inboundEvent), "/webhook/resend-inbound", "POST"))!;
    expect(res.status).toBe(401);
    expect(listInboundEmails({}, getDatabase())).toHaveLength(0);
  });
});
