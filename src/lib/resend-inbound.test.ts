import { describe, it, expect } from "bun:test";
import { isResendInboundEvent, parseResendInboundEvent, verifyResendWebhook } from "./resend-inbound.js";

describe("isResendInboundEvent", () => {
  it("recognizes email.received", () => {
    expect(isResendInboundEvent({ type: "email.received" })).toBe(true);
    expect(isResendInboundEvent({ type: "email.sent" })).toBe(false);
  });
});

describe("parseResendInboundEvent", () => {
  it("maps the webhook payload to our inbound shape", () => {
    const parsed = parseResendInboundEvent({
      type: "email.received",
      created_at: "2026-06-03T00:00:00Z",
      data: { email_id: "re_123", from: "a@x.com", to: ["andrew@ours.com"], subject: "Hi", text: "body", headers: { "X-T": "1" } },
    });
    expect(parsed.provider_message_id).toBe("re_123");
    expect(parsed.from_address).toBe("a@x.com");
    expect(parsed.to_addresses).toEqual(["andrew@ours.com"]);
    expect(parsed.subject).toBe("Hi");
    expect(parsed.text_body).toBe("body");
    expect(parsed.received_at).toBe("2026-06-03T00:00:00Z");
  });
  it("coerces single to-address to an array and defaults subject", () => {
    const p = parseResendInboundEvent({ type: "email.received", data: { to: "x@y.com" } });
    expect(p.to_addresses).toEqual(["x@y.com"]);
    expect(p.subject).toBe("(no subject)");
  });
  it("throws on non-inbound events", () => {
    expect(() => parseResendInboundEvent({ type: "email.delivered" })).toThrow(/Not a Resend inbound/);
  });
});

describe("verifyResendWebhook", () => {
  it("delegates to the provided verifier", () => {
    expect(verifyResendWebhook("body", { "svix-id": "x" }, "whsec_1", () => true)).toBe(true);
    expect(verifyResendWebhook("body", {}, "whsec_1", () => false)).toBe(false);
  });
  it("requires a secret and a verifier", () => {
    expect(() => verifyResendWebhook("b", {}, "", () => true)).toThrow(/secret is required/);
    expect(() => verifyResendWebhook("b", {}, "whsec_1")).toThrow(/Svix verifier/);
  });
});
