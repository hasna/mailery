import { describe, expect, it } from "bun:test";
import { extractVerificationCodes, findVerificationCode } from "./verification-code.js";
import type { InboundEmail } from "../db/inbound.js";

function email(partial: Partial<InboundEmail>): InboundEmail {
  return {
    id: partial.id ?? "id",
    provider_id: null,
    message_id: null,
    in_reply_to_email_id: null,
    provider_thread_id: null,
    thread_id: null,
    provider_history_id: null,
    provider_internal_date: null,
    label_ids: [],
    raw_s3_url: null,
    metadata_s3_url: null,
    from_address: partial.from_address ?? "noreply@example.com",
    to_addresses: partial.to_addresses ?? ["me@example.com"],
    cc_addresses: [],
    subject: partial.subject ?? "Code",
    text_body: partial.text_body ?? "",
    html_body: partial.html_body ?? null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 0,
    is_read: false,
    read_at: null,
    is_archived: false,
    is_starred: false,
    is_sent: false,
    received_at: partial.received_at ?? "2026-06-04T00:00:00.000Z",
    created_at: partial.created_at ?? "2026-06-04T00:00:00.000Z",
  };
}

describe("verification code extraction", () => {
  it("extracts context-backed temporary verification codes", () => {
    expect(extractVerificationCodes("Enter this temporary verification code to continue:\n\n492255")[0]).toBe("492255");
  });

  it("finds the newest matching email and honors filters", () => {
    const match = findVerificationCode([
      email({ id: "old", from_address: "noreply@other.com", text_body: "code 111111", received_at: "2026-06-04T10:00:00.000Z" }),
      email({ id: "new", from_address: "ChatGPT <noreply@tm.openai.com>", subject: "Your temporary ChatGPT verification code", text_body: "Enter this temporary verification code to continue:\n\n958450", received_at: "2026-06-04T11:00:00.000Z" }),
    ], { from: "openai", subject: "verification" });

    expect(match?.code).toBe("958450");
    expect(match?.email.id).toBe("new");
    expect(match?.confidence).toBe("high");
  });
});

