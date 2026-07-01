import { describe, expect, it } from "bun:test";
import {
  addSelfHostedInboundLabel,
  clearSelfHostedInboundEmails,
  deleteSelfHostedInboundEmail,
  getSelfHostedInboundAttachmentPaths,
  getSelfHostedInboxStatus,
  getSelfHostedMailboxStatus,
  getLatestSelfHostedInboundEmail,
  listSelfHostedInboundEmailSummariesForOwner,
  listSelfHostedSourceSummaries,
  listSelfHostedInboundEmailSummaries,
  listSelfHostedVerificationCodeCandidates,
  removeSelfHostedInboundLabel,
  selfHostedInboundEmailBelongsToOwner,
  setSelfHostedInboundArchived,
  setSelfHostedInboundRead,
  setSelfHostedInboundStarred,
} from "./self-hosted-inbound.js";

function inboundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "email_12345678",
    provider_id: "provider_123",
    message_id: "<message@example.com>",
    in_reply_to_email_id: null,
    provider_thread_id: null,
    thread_id: null,
    provider_history_id: null,
    provider_internal_date: null,
    label_ids_json: JSON.stringify(["billing"]),
    raw_s3_url: "s3://mailery-inbound/raw/email_12345678.eml",
    metadata_s3_url: null,
    from_address: "sender@example.com",
    to_addresses: JSON.stringify(["ops@example.com"]),
    cc_addresses: JSON.stringify([]),
    subject: "Remote contract",
    text_body: "Open https://example.com/read",
    html_body: null,
    attachments_json: JSON.stringify([{ filename: "invoice.pdf", content_type: "application/pdf", size: 2048 }]),
    attachment_paths: JSON.stringify([{ filename: "invoice.pdf", content_type: "application/pdf", size: 2048, s3_url: "s3://mailery-inbound/attachments/invoice.pdf" }]),
    headers_json: JSON.stringify({ "Message-ID": "<message@example.com>" }),
    raw_size: 512,
    is_read: 0,
    read_at: null,
    is_archived: 0,
    is_starred: 1,
    is_sent: 0,
    received_at: "2026-07-01T09:00:00.000Z",
    created_at: "2026-07-01T09:00:01.000Z",
    ...overrides,
  };
}

describe("self-hosted inbound repository", () => {
  it("lists and maps inbound summaries from the remote source of truth", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const remote = {
      all: async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        return [inboundRow()];
      },
      run: async () => undefined,
      close: async () => undefined,
    };

    const rows = await listSelfHostedInboundEmailSummaries({
      provider_id: "provider_123",
      mailbox: "unread",
      search: "contract",
      recipients: ["ops@example.com"],
      label: "Billing",
      limit: 5,
      offset: 2,
    }, remote);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "email_12345678",
      provider_id: "provider_123",
      subject: "Remote contract",
      to_addresses: ["ops@example.com"],
      label_ids: ["billing"],
      is_read: false,
      is_starred: true,
    });
    expect(calls[0]!.sql).toContain("is_read = 0");
    expect(calls[0]!.sql).toContain("provider_id = ?");
    expect(calls[0]!.sql).toContain("LOWER(COALESCE(text_body, '')) LIKE ?");
    expect(calls[0]!.sql).toContain("recipient.address IN (?)");
    expect(calls[0]!.params).toContain("provider_123");
    expect(calls[0]!.params).toContain("%contract%");
    expect(calls[0]!.params).toContain("ops@example.com");
    expect(calls[0]!.params.at(-2)).toBe(5);
    expect(calls[0]!.params.at(-1)).toBe(2);
  });

  it("fails closed for arbitrary source IDs until source metadata is modeled remotely", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const remote = {
      all: async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        return [];
      },
      run: async () => undefined,
      close: async () => undefined,
    };

    const rows = await listSelfHostedInboundEmailSummaries({ sourceId: "source_local_only" }, remote);

    expect(rows).toEqual([]);
    expect(calls[0]!.sql).toContain("0 = 1");
  });

  it("reads the latest message and writes read state to remote tables", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    let current = inboundRow();
    const remote = {
      all: async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT id FROM inbound_emails")) return [{ id: current.id }];
        return [current];
      },
      run: async (sql: string, ...params: unknown[]) => {
        runs.push({ sql, params });
        if (sql.includes("UPDATE inbound_emails")) {
          current = inboundRow({ is_read: params[0], read_at: params[1] });
        }
      },
      close: async () => undefined,
    };

    const latest = await getLatestSelfHostedInboundEmail("ops@example.com", undefined, remote);
    expect(latest).toMatchObject({
      id: "email_12345678",
      text_body: "Open https://example.com/read",
    });

    const updated = await setSelfHostedInboundRead("email_123", true, remote);
    expect(updated.is_read).toBe(true);
    expect(typeof updated.read_at).toBe("string");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.sql).toContain("UPDATE inbound_emails");
    expect(runs[1]!.sql).toContain("UPDATE mailbox_message_state");
  });

  it("reads attachment paths and verification candidates from the remote source of truth", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const remote = {
      all: async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT id FROM inbound_emails")) return [{ id: "email_12345678" }];
        if (sql.includes("SELECT attachment_paths FROM inbound_emails")) {
          return [{ attachment_paths: inboundRow().attachment_paths }];
        }
        if (sql.includes("WITH active AS")) {
          return [{
            id: "email_12345678",
            from_address: "security@example.com",
            subject: "Your verification code",
            text_body: "Use code 123456 to sign in",
            html_body: null,
            received_at: "2026-07-01T09:00:00.000Z",
          }];
        }
        return [];
      },
      run: async () => undefined,
      close: async () => undefined,
    };

    const paths = await getSelfHostedInboundAttachmentPaths("email_123", remote);
    expect(paths).toEqual([
      { filename: "invoice.pdf", content_type: "application/pdf", size: 2048, s3_url: "s3://mailery-inbound/attachments/invoice.pdf" },
    ]);

    const candidates = await listSelfHostedVerificationCodeCandidates("OPS@Example.com", {
      from: "security",
      subject: "verification",
      limit: 5,
    }, remote);
    expect(candidates).toEqual([{
      id: "email_12345678",
      from_address: "security@example.com",
      subject: "Your verification code",
      text_body: "Use code 123456 to sign in",
      html_body: null,
      received_at: "2026-07-01T09:00:00.000Z",
    }]);
    expect(calls.some((call) => call.sql.includes("SELECT attachment_paths FROM inbound_emails"))).toBe(true);
    expect(calls.some((call) => call.params.includes("ops@example.com"))).toBe(true);
  });

  it("lists and authorizes owner-scoped remote inbox reads without local SQLite", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const remote = {
      all: async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT 1 AS ok")) return [{ ok: 1 }];
        return [inboundRow()];
      },
      run: async () => undefined,
      close: async () => undefined,
    };

    const rows = await listSelfHostedInboundEmailSummariesForOwner("owner_123", {
      search: "contract",
      limit: 10,
      offset: 0,
    }, remote);
    const belongs = await selfHostedInboundEmailBelongsToOwner("email_12345678", "owner_123", remote);

    expect(rows).toHaveLength(1);
    expect(belongs).toBe(true);
    expect(calls[0]!.sql).toContain("FROM addresses scoped");
    expect(calls[0]!.sql).toContain("FROM aliases al");
    expect(calls[0]!.params.filter((param) => param === "owner_123")).toHaveLength(6);
    expect(calls[1]!.sql).toContain("SELECT 1 AS ok");
  });

  it("writes archive, star, and label state to remote tables", async () => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    let current = inboundRow();
    const remote = {
      all: async (sql: string, ...params: unknown[]) => {
        if (sql.includes("SELECT id FROM inbound_emails")) return [{ id: current.id }];
        if (sql.includes("SELECT label_ids_json FROM inbound_emails")) return [{ label_ids_json: current.label_ids_json }];
        return [current];
      },
      run: async (sql: string, ...params: unknown[]) => {
        runs.push({ sql, params });
        if (sql.includes("UPDATE inbound_emails SET is_archived")) current = inboundRow({ ...current, is_archived: params[0] });
        if (sql.includes("UPDATE inbound_emails SET is_starred")) current = inboundRow({ ...current, is_starred: params[0] });
        if (sql.includes("UPDATE inbound_emails SET label_ids_json")) current = inboundRow({ ...current, label_ids_json: params[0] });
      },
      close: async () => undefined,
    };

    const archived = await setSelfHostedInboundArchived("email_123", true, remote);
    expect(archived.is_archived).toBe(true);

    const unstarred = await setSelfHostedInboundStarred("email_123", false, remote);
    expect(unstarred.is_starred).toBe(false);

    const labeled = await addSelfHostedInboundLabel("email_123", "Work", remote);
    expect(labeled.label_ids).toEqual(["billing", "Work"]);

    const unlabeled = await removeSelfHostedInboundLabel("email_123", "billing", remote);
    expect(unlabeled.label_ids).toEqual(["Work"]);

    expect(runs.filter((run) => run.sql.includes("UPDATE inbound_emails"))).toHaveLength(4);
    expect(runs.filter((run) => run.sql.includes("UPDATE mailbox_message_state"))).toHaveLength(4);
    expect(runs.some((run) => run.sql.includes("folder:' || mailbox_id || ':archive'"))).toBe(true);
    expect(runs.some((run) => run.sql.includes("labels_json = ?"))).toBe(true);
    expect(runs.filter((run) => run.sql.includes("DELETE FROM inbound_labels"))).toHaveLength(2);
    expect(runs.filter((run) => run.sql.includes("INSERT INTO inbound_labels"))).toHaveLength(3);
  });

  it("deletes inbound mail from the remote source of truth", async () => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    const remote = {
      all: async (sql: string) => {
        if (sql.includes("SELECT id FROM inbound_emails")) return [{ id: "email_12345678" }];
        return [];
      },
      run: async (sql: string, ...params: unknown[]) => {
        runs.push({ sql, params });
        return { changes: 1 };
      },
      close: async () => undefined,
    };

    const deleted = await deleteSelfHostedInboundEmail("email_123", remote);

    expect(deleted).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sql: "DELETE FROM inbound_emails WHERE id = ?",
      params: ["email_12345678"],
    });
  });

  it("builds mailbox and source status from the remote source of truth", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const countFor = (sql: string) => {
      if (sql.includes("COALESCE(is_sent, 0) = 1")) return "1";
      if (sql.includes("COALESCE(is_read, 0) = 0")) return "2";
      if (sql.includes("raw_s3_url LIKE")) return "4";
      if (sql.includes("provider_id = ?")) return "3";
      return "7";
    };
    const remote = {
      all: async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("MAX(received_at)")) return [{ latest: "2026-07-01T09:00:00.000Z" }];
        if (sql.includes("FROM providers p")) return [{ id: "provider_123", name: "SES", type: "ses", active: 1, has_mail: true }];
        if (sql.includes("SELECT DISTINCT raw_s3_url")) return [{ raw_s3_url: "s3://mailery-inbound/raw/email_12345678.eml" }];
        if (sql.includes("LEFT JOIN providers p")) return [];
        if (sql.includes("SELECT COUNT(*) AS count FROM emails")) return [{ count: "1" }];
        if (sql.includes("SELECT COUNT(*) AS count FROM inbound_emails")) return [{ count: countFor(sql) }];
        return [];
      },
      run: async () => undefined,
      close: async () => undefined,
    };

    const mailbox = await getSelfHostedMailboxStatus(undefined, remote);
    expect(mailbox.counts.inbox).toBe(7);
    expect(mailbox.counts.unread).toBe(2);
    expect(mailbox.counts.sent).toBe(2);

    const sources = await listSelfHostedSourceSummaries({ limit: 10 }, remote);
    expect(sources.map((source) => source.id)).toEqual(expect.arrayContaining(["all", "provider:provider_123", "s3:mailery-inbound"]));
    expect(sources.find((source) => source.id === "provider:provider_123")).toMatchObject({
      label: "Provider-tagged stream: SES",
      total: 4,
      unread: 2,
      latestReceivedAt: "2026-07-01T09:00:00.000Z",
    });

    const status = await getSelfHostedInboxStatus(remote);
    expect(status).toMatchObject({
      total: 7,
      unread: 2,
      latest_received_at: "2026-07-01T09:00:00.000Z",
    });
    expect(calls.some((call) => call.sql.includes("FROM inbound_emails"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("FROM providers p"))).toBe(true);
  });

  it("clears remote inbound mail with optional provider scope", async () => {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    const reads: Array<{ sql: string; params: unknown[] }> = [];
    const remote = {
      all: async (sql: string, ...params: unknown[]) => {
        reads.push({ sql, params });
        return [{ count: "3" }];
      },
      run: async (sql: string, ...params: unknown[]) => {
        runs.push({ sql, params });
        return { changes: 3 };
      },
      close: async () => undefined,
    };

    const deleted = await clearSelfHostedInboundEmails("provider_123", remote);

    expect(deleted).toBe(3);
    expect(reads[0]).toMatchObject({
      sql: "SELECT COUNT(*) AS count FROM inbound_emails WHERE provider_id = ?",
      params: ["provider_123"],
    });
    expect(runs[0]).toMatchObject({
      sql: "DELETE FROM inbound_emails WHERE provider_id = ?",
      params: ["provider_123"],
    });
  });
});
