import { afterEach, describe, expect, it } from "bun:test";
import { extractVerificationCodes, findVerificationCode, listVerificationCodeCandidates } from "./verification-code.js";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { setInboundArchived, storeInboundEmail, type InboundEmail } from "../db/inbound.js";

const originalDbPath = process.env["EMAILS_DB_PATH"];

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

function setupDb() {
  closeDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  return getDatabase();
}

afterEach(() => {
  closeDatabase();
  if (originalDbPath === undefined) {
    delete process.env["EMAILS_DB_PATH"];
  } else {
    process.env["EMAILS_DB_PATH"] = originalDbPath;
  }
});

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

  it("loads lean verification candidates from active and archived mailboxes independently", () => {
    const db = setupDb();
    const activeNoise = storeInboundEmail({
      provider_id: null,
      message_id: "active-noise",
      in_reply_to_email_id: null,
      from_address: "updates@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Recent account update",
      text_body: "No code in this newer message",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T12:00:00.000Z",
    }, db);
    const archivedCode = storeInboundEmail({
      provider_id: null,
      message_id: "archived-code",
      in_reply_to_email_id: null,
      from_address: "security@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Verification code",
      text_body: "Your code is 654321",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:00:00.000Z",
    }, db);
    setInboundArchived(archivedCode.id, true, db);
    storeInboundEmail({
      provider_id: null,
      message_id: "sent-code",
      in_reply_to_email_id: null,
      from_address: "me@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Verification code",
      text_body: "Your code is 999999",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      label_ids: ["SENT"],
      raw_size: 100,
      received_at: "2026-06-04T12:30:00.000Z",
    }, db);

    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "query") {
          return (sql: string) => {
            queries.push(sql);
            return target.query(sql);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const candidates = listVerificationCodeCandidates("me@example.com", { limit: 1 }, recordingDb);
    const match = findVerificationCode(candidates);

    expect(candidates.map((candidate) => candidate.id)).toEqual([activeNoise.id, archivedCode.id]);
    expect(match?.code).toBe("654321");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("inbound_recipients");
    expect(queries[0]).toContain("e.is_sent = 0");
    expect(queries[0]).toContain("e.is_archived = ?");
    expect(queries[0]).not.toContain("SELECT * FROM inbound_emails");
  });
});
