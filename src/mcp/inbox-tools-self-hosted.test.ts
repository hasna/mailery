import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase, uuid } from "../db/database.js";
import { storeInboundEmail } from "../db/inbound.js";
import { setSelfHostedInboundRemoteFactoryForTest } from "../db/self-hosted-inbound.js";

let current = inboundRow();
const runs: Array<{ sql: string; params: unknown[] }> = [];

function inboundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "remote_email_123456",
    provider_id: "remote_provider",
    message_id: "remote-message",
    in_reply_to_email_id: null,
    provider_thread_id: null,
    thread_id: null,
    provider_history_id: null,
    provider_internal_date: null,
    label_ids_json: JSON.stringify([]),
    raw_s3_url: "s3://remote-bucket/raw/message.eml",
    metadata_s3_url: null,
    from_address: "remote@example.com",
    to_addresses: JSON.stringify(["agent@example.com"]),
    cc_addresses: JSON.stringify([]),
    subject: "Remote self-hosted mail",
    text_body: "Use code 123456",
    html_body: null,
    attachments_json: JSON.stringify([{ filename: "invoice.pdf", content_type: "application/pdf", size: 12 }]),
    attachment_paths: JSON.stringify([{ filename: "invoice.pdf", content_type: "application/pdf", size: 12, s3_url: "s3://remote-bucket/attachments/invoice.pdf" }]),
    headers_json: JSON.stringify({}),
    raw_size: 100,
    is_read: 0,
    read_at: null,
    is_archived: 0,
    is_starred: 0,
    is_sent: 0,
    received_at: "2026-07-01T10:00:00.000Z",
    created_at: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

const fakeRemote = {
  all: async (sql: string, ...params: unknown[]) => {
    if (sql.includes("SELECT id FROM inbound_emails")) return [{ id: current.id }];
    if (sql.includes("SELECT attachment_paths FROM inbound_emails")) return [{ attachment_paths: current.attachment_paths }];
    if (sql.includes("WITH active AS")) {
      return [{
        id: current.id,
        from_address: current.from_address,
        subject: current.subject,
        text_body: current.text_body,
        html_body: current.html_body,
        received_at: current.received_at,
      }];
    }
    if (sql.includes("FROM inbound_emails")) return [current];
    return [];
  },
  run: async (sql: string, ...params: unknown[]) => {
    runs.push({ sql, params });
    if (sql.includes("UPDATE inbound_emails SET is_read")) {
      current = inboundRow({ ...current, is_read: params[0], read_at: params[1] });
    }
    return { changes: 1 };
  },
  close: async () => undefined,
};

const { runInboxTool } = await import("./tools/inbox-impl.js");

async function toolJson(name: Parameters<typeof runInboxTool>[0], input: Record<string, unknown>) {
  const result = await runInboxTool(name, input);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  process.env["MAILERY_MODE"] = "self_hosted";
  process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://self-hosted-test";
  process.env["EMAILS_DB_PATH"] = ":memory:";
  current = inboundRow();
  runs.length = 0;
  setSelfHostedInboundRemoteFactoryForTest(() => fakeRemote);
  resetDatabase();
  const db = getDatabase();
  const localProvider = uuid();
  db.run("INSERT INTO providers (id, name, type, active) VALUES (?, 'Local', 'ses', 1)", [localProvider]);
  storeInboundEmail({
    provider_id: localProvider,
    message_id: "poison-local",
    in_reply_to_email_id: null,
    from_address: "local@example.com",
    to_addresses: ["agent@example.com"],
    cc_addresses: [],
    subject: "POISON LOCAL MAIL",
    text_body: "This local row must not appear in self-hosted MCP results.",
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 1,
    received_at: "2026-07-01T09:00:00.000Z",
  }, db);
});

afterEach(() => {
  setSelfHostedInboundRemoteFactoryForTest(null);
  closeDatabase();
  delete process.env["MAILERY_MODE"];
  delete process.env["HASNA_EMAILS_DATABASE_URL"];
  delete process.env["EMAILS_DB_PATH"];
});

describe("MCP inbox tools in self-hosted mode", () => {
  it("reads and mutates the remote source of truth instead of local SQLite", async () => {
    const list = await toolJson("list_inbound_emails", { limit: 10 });
    expect((list.items as Array<{ subject: string }>).map((item) => item.subject)).toEqual(["Remote self-hosted mail"]);

    const email = await toolJson("get_inbound_email", { id: "remote_email" });
    expect(email.subject).toBe("Remote self-hosted mail");

    const attachment = await toolJson("get_attachment", { email_id: "remote_email" });
    expect(attachment).toEqual([{ filename: "invoice.pdf", content_type: "application/pdf", size: 12, s3_url: "s3://remote-bucket/attachments/invoice.pdf" }]);

    const code = await toolJson("wait_for_code", {
      address: "agent@example.com",
      refresh: false,
      timeout_seconds: 1,
      interval_seconds: 1,
    });
    expect(code.code).toBe("123456");

    const read = await toolJson("mark_email_read", { email_id: "remote_email" });
    expect(read.is_read).toBe(true);
    expect(runs.some((run) => run.sql.includes("UPDATE mailbox_message_state"))).toBe(true);
  });
});
