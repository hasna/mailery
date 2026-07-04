import { describe, expect, it } from "bun:test";
import { MaileryCloudClient, MaileryCloudError } from "./mailery-cloud-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("MaileryCloudClient", () => {
  it("prefixes platform API routes and sends bearer auth", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example/",
      token: "secret-token",
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
        });
        return jsonResponse({ user: null, tenant: null, auth: { via: "api_key", scopes: ["full"] } });
      }) as typeof fetch,
    });

    await client.me();

    expect(calls).toEqual([{ url: "https://mailery.example/api/v1/auth/me", authorization: "Bearer secret-token" }]);
  });

  it("retries retryable platform errors", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      retries: 2,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ error: { code: "busy", message: "try again" } }, { status: 503 });
        return jsonResponse({ data: [] });
      }) as typeof fetch,
    });

    const result = await client.listMailboxes();

    expect(result).toEqual([]);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it("lists messages with cursor pagination metadata", async () => {
    const calls: string[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return jsonResponse({
          data: [{ id: "cloud_msg_1", tenantId: "ten_1", mailboxId: "mbx_1" }],
          next_cursor: "cursor_2",
        });
      }) as typeof fetch,
    });

    const page = await client.listMessagesPage({ group: "inbox", limit: 10, cursor: "cursor_1" });
    const rows = await client.listMessages({ group: "inbox", limit: 10, cursor: "cursor_1" });

    expect(page.nextCursor).toBe("cursor_2");
    expect(rows).toEqual(page.data);
    expect(calls[0]).toBe("https://mailery.example/api/v1/messages?group=inbox&limit=10&cursor=cursor_1");
  });

  it("keeps message tombstones and attachment download links in cloud responses", async () => {
    const calls: string[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/api/v1/messages")) {
          return jsonResponse({
            data: [{ id: "cloud_msg_deleted", tombstone: true, deletedAt: "2026-07-01T10:00:00.000Z" }],
            next_cursor: null,
          });
        }
        if (String(url).includes("/api/v1/messages/tombstones")) {
          return jsonResponse({ data: [{ id: "tomb_1", message_id: "cloud:cloud_msg_deleted", deleted_at: "2026-07-01T10:00:00.000Z" }] });
        }
        return jsonResponse({
          message: {
            id: "cloud_msg_1",
            tenantId: "ten_1",
            mailboxId: "mbx_1",
            classification: { labels: ["Billing"] },
          },
          attachments: [{
            id: "att_1",
            filename: "invoice.pdf",
            contentType: "application/pdf",
            sizeBytes: 2048,
            download_url: "/api/v1/attachments/att_1/download",
          }],
        });
      }) as typeof fetch,
    });

    const page = await client.listMessagesPage();
    const full = await client.getMessage("cloud_msg_1");
    const tombstones = await client.listMessageTombstones({ limit: 25, since: "2026-07-01T00:00:00.000Z" });

    expect(page.data).toEqual([{ id: "cloud_msg_deleted", tombstone: true, deletedAt: "2026-07-01T10:00:00.000Z" }]);
    expect(tombstones).toEqual([{ id: "tomb_1", message_id: "cloud:cloud_msg_deleted", deleted_at: "2026-07-01T10:00:00.000Z" }]);
    expect(full.attachments[0]).toMatchObject({
      id: "att_1",
      filename: "invoice.pdf",
      download_url: "/api/v1/attachments/att_1/download",
    });
    expect(calls).toContain("https://mailery.example/api/v1/messages/tombstones?limit=25&since=2026-07-01T00%3A00%3A00.000Z");
  });

  it("maps platform error envelopes into typed errors", async () => {
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      retries: 0,
      fetchImpl: (async () => jsonResponse({ error: { code: "forbidden", message: "billing_read scope required" } }, { status: 403 })) as typeof fetch,
    });

    try {
      await client.billingOverview();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MaileryCloudError);
      expect((error as MaileryCloudError).status).toBe(403);
      expect((error as MaileryCloudError).code).toBe("forbidden");
      expect(error instanceof Error ? error.message : "").toBe("billing_read scope required");
    }
  });

  it("reads the JMAP changesSince delta feed with an updatedSince watermark", async () => {
    const calls: string[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return jsonResponse({
          data: [{ id: "cloud_msg_2", direction: "inbound", subject: "changed", updatedAt: "2026-07-02T00:00:00.000Z" }],
          next_cursor: "changes_cursor_2",
        });
      }) as typeof fetch,
    });

    const page = await client.listMessageChanges({
      updatedSince: "2026-07-01T00:00:00.000Z",
      mailboxId: "mbx_1",
      cursor: "changes_cursor_1",
      limit: 100,
    });

    expect(page.nextCursor).toBe("changes_cursor_2");
    expect(page.data[0]).toMatchObject({ id: "cloud_msg_2" });
    expect(calls[0]).toBe(
      "https://mailery.example/api/v1/messages/changes?updatedSince=2026-07-01T00%3A00%3A00.000Z&mailboxId=mbx_1&cursor=changes_cursor_1&limit=100",
    );
  });

  it("fetches a thread via GET /messages?threadId", async () => {
    const calls: string[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return jsonResponse({ data: [{ id: "cloud_msg_1", threadId: "thr_1" }], next_cursor: null });
      }) as typeof fetch,
    });

    const page = await client.listThread("thr_1", { limit: 50 });

    expect(page.data[0]).toMatchObject({ id: "cloud_msg_1", threadId: "thr_1" });
    expect(calls[0]).toBe("https://mailery.example/api/v1/messages?threadId=thr_1&limit=50");
  });

  it("scopes list requests by mailbox and direction", async () => {
    const calls: string[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return jsonResponse({ data: [], next_cursor: null });
      }) as typeof fetch,
    });

    await client.listMessagesPage({ group: "sent", mailboxId: "mbx_1", direction: "outbound", limit: 25 });

    expect(calls[0]).toBe("https://mailery.example/api/v1/messages?group=sent&mailboxId=mbx_1&direction=outbound&limit=25");
  });

  it("sends hosted mail and surfaces the provider message id and mode", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
        return jsonResponse({
          id: "cloud_msg_sent",
          tenantId: "ten_1",
          mailboxId: "mbx_1",
          direction: "outbound",
          provider_message_id: "ses-abc-123",
          mode: "live",
        }, { status: 202 });
      }) as typeof fetch,
    });

    const result = await client.sendMessage({ mailboxId: "mbx_1", to: ["dest@ext.com"], subject: "Hi", text: "Body" });

    expect(result.provider_message_id).toBe("ses-abc-123");
    expect(result.mode).toBe("live");
    expect(result.attachments).toEqual([]);
    expect(calls[0]?.url).toBe("https://mailery.example/api/v1/messages/send");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ mailboxId: "mbx_1", to: ["dest@ext.com"], subject: "Hi", text: "Body" });
  });

  it("stars a message via the isStarred flag patch", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
        return jsonResponse({ id: "cloud_msg_1", isStarred: true });
      }) as typeof fetch,
    });

    await client.setMessageStarred("cloud_msg_1", true);

    expect(calls[0]?.url).toBe("https://mailery.example/api/v1/messages/cloud_msg_1");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ isStarred: true });
  });

  it("adds and removes message labels with URL-encoded names", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
        return jsonResponse({
          ok: true,
          labels: [{ id: "lbl_1", name: "Needs Review", color: "#abc", kind: "custom" }],
          label_names: ["Needs Review"],
        });
      }) as typeof fetch,
    });

    const added = await client.addMessageLabel("cloud_msg_1", "Needs Review");
    const removed = await client.removeMessageLabel("cloud_msg_1", "Needs Review");

    expect(added.label_names).toEqual(["Needs Review"]);
    expect(added.labels[0]).toMatchObject({ id: "lbl_1", name: "Needs Review", kind: "custom" });
    expect(removed.ok).toBe(true);
    expect(calls[0]).toMatchObject({ url: "https://mailery.example/api/v1/messages/cloud_msg_1/labels", method: "POST", body: { label: "Needs Review" } });
    expect(calls[1]).toMatchObject({ url: "https://mailery.example/api/v1/messages/cloud_msg_1/labels/Needs%20Review", method: "DELETE" });
  });

  it("normalizes bulk mutation responses (has_more / next_cursor)", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
        return jsonResponse({ ok: true, action: "markRead", affected: 12, matched: 12, has_more: true, next_cursor: "bulk_cursor_2" });
      }) as typeof fetch,
    });

    const result = await client.bulkMessageAction({ action: "markRead", mailboxId: "mbx_1", folder: "inbox" });

    expect(result).toEqual({ ok: true, action: "markRead", affected: 12, matched: 12, hasMore: true, nextCursor: "bulk_cursor_2" });
    expect(calls[0]).toMatchObject({ url: "https://mailery.example/api/v1/messages/bulk", method: "POST", body: { action: "markRead", mailboxId: "mbx_1", folder: "inbox" } });
  });

  it("scopes group counts to a mailbox when requested", async () => {
    const calls: string[] = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return jsonResponse({ inbox: 3, unread: 1 });
      }) as typeof fetch,
    });

    await client.messageGroups({ mailboxId: "mbx_1" });
    await client.messageGroups();

    expect(calls[0]).toBe("https://mailery.example/api/v1/messages/groups?mailboxId=mbx_1");
    expect(calls[1]).toBe("https://mailery.example/api/v1/messages/groups");
  });

  it("sends explicit MX migration consent during cloud domain setup", async () => {
    const calls: Array<{ body?: unknown }> = [];
    const client = new MaileryCloudClient({
      apiUrl: "https://mailery.example",
      token: "t",
      fetchImpl: (async (_url, init) => {
        calls.push({ body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
        return jsonResponse({ domain: "example.com", status: "pending_dns" });
      }) as typeof fetch,
    });

    await client.setupDomain({
      domain: "example.com",
      address: "agent",
      catchAll: true,
      mxMigrationConsent: true,
    });

    expect(calls[0]?.body).toEqual({
      domain: "example.com",
      address: "agent",
      catchAll: true,
      mxMigrationConsent: true,
    });
  });
});
