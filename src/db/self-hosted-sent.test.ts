import { afterEach, describe, expect, it } from "bun:test";
import {
  createSelfHostedSendAttempt,
  createSelfHostedSentEmail,
} from "./self-hosted-sent.js";

type Call = { kind: "run" | "all"; sql: string; params: unknown[] };

function fakeRemote(calls: Call[]) {
  return {
    async run(sql: string, ...params: unknown[]) {
      calls.push({ kind: "run", sql, params });
      return { changes: 1 };
    },
    async all(sql: string, ...params: unknown[]) {
      calls.push({ kind: "all", sql, params });
      if (sql.includes("INSERT INTO email_send_attempts")) {
        return [{
          id: params[0],
          provider_id: params[1],
          status: "pending",
          email_id: null,
          provider_message_id: null,
        }];
      }
      if (sql.includes("INSERT INTO emails")) {
        return [{
          id: params[0],
          provider_id: params[1],
          provider_message_id: params[2],
          from_address: params[3],
          to_addresses: params[4],
          cc_addresses: params[5],
          bcc_addresses: params[6],
          reply_to: params[7],
          subject: params[8],
          status: "sent",
          has_attachments: false,
          attachment_count: 0,
          tags: "{}",
          idempotency_key: params[13],
          sent_at: params[14],
          created_at: params[15],
          updated_at: params[16],
        }];
      }
      return [];
    },
    async close() {},
  };
}

afterEach(() => {
  delete process.env["MAILERY_MODE"];
  delete process.env["HASNA_EMAILS_DATABASE_URL"];
});

describe("self-hosted sent ledger", () => {
  it("creates a pending RDS attempt before the final sent email row is linked", async () => {
    process.env["MAILERY_MODE"] = "self_hosted";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://mailery.example.invalid/db";
    const calls: Call[] = [];
    const remote = fakeRemote(calls);

    const sendOpts = {
      from: "sender@example.com",
      to: "receiver@example.com",
      subject: "hello",
      text: "body",
      idempotency_key: "idem-1",
    };
    const attempt = await createSelfHostedSendAttempt("provider_1", sendOpts, remote);
    const email = await createSelfHostedSentEmail("provider_1", sendOpts, "provider-msg-1", attempt.id, remote);

    expect(attempt.status).toBe("pending");
    expect(email.provider_message_id).toBe("provider-msg-1");
    expect(calls.some((call) => call.sql.includes("INSERT INTO email_send_attempts"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("INSERT INTO emails"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("SET status = 'sent'"))).toBe(true);
  });
});
