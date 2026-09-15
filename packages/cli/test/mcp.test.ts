// Unit tests for the MCP stdio server: JSON-RPC dispatch, the tool manifest,
// and tool -> SDK wiring (via a routing fake fetch injected into the SDK client).

import { describe, expect, test } from "bun:test";
import { MaileryClient, MCP_TOOLS, callTool, handleMcpMessage } from "@hasna/mailery-sdk-internal";
import { routeFetch, type FetchCall, type RouteHandler } from "./support.js";

function client(route: RouteHandler, calls: FetchCall[] = []): MaileryClient {
  return new MaileryClient({ baseUrl: "http://mailery.test", apiKey: "ml_key", fetch: routeFetch(route, calls), retries: 0 });
}

describe("protocol", () => {
  test("initialize echoes the protocol version and advertises the tools capability", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, client(() => ({})));
    expect(res!.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mailery" },
    });
  });

  test("notifications/initialized produces no response", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, client(() => ({})));
    expect(res).toBeNull();
  });

  test("tools/list returns exactly the twenty-one documented tools", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, client(() => ({})));
    const names = (res!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "add_wallet_funds",
      "buy_domain",
      "create_mailbox",
      "create_webhook",
      "generate_digest",
      "get_billing_status",
      "get_domain_status",
      "get_message_events",
      "list_changes",
      "list_digests",
      "list_inbox",
      "list_mailboxes",
      "list_suppressions",
      "list_webhooks",
      "read_message",
      "search_domains",
      "send_email",
      "send_email_batch",
      "submit_feedback",
      "test_webhook",
      "update_message",
    ].sort());
    // Manifest and dispatcher agree.
    expect(MCP_TOOLS).toHaveLength(21);
  });

  test("every pure-read tool carries readOnlyHint; flag updates are marked non-destructive", () => {
    const readOnly = MCP_TOOLS.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual([
      "get_billing_status",
      "get_domain_status",
      "get_message_events",
      "list_changes",
      "list_digests",
      "list_inbox",
      "list_mailboxes",
      "list_suppressions",
      "list_webhooks",
      "read_message",
      "search_domains",
    ]);
    expect(MCP_TOOLS.find((t) => t.name === "update_message")!.annotations?.destructiveHint).toBe(false);
    expect(MCP_TOOLS.find((t) => t.name === "test_webhook")!.annotations?.destructiveHint).toBe(false);
    // Mutating-but-additive tools stay unannotated (spec default applies).
    expect(MCP_TOOLS.find((t) => t.name === "generate_digest")!.annotations?.destructiveHint).toBeUndefined();
  });

  test("an unknown method with an id returns JSON-RPC method-not-found", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/nope" }, client(() => ({})));
    expect(res!.error!.code).toBe(-32601);
  });
});

describe("tools/call → SDK", () => {
  test("search_domains returns availability without price components", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_domains", arguments: { domain: "x.com" } } },
      client((c) => c.path === "/api/v1/domains/availability" ? { body: { domain: "x.com", available: true, quoted_price_cents: 1500, quoted_price: 15 } } : undefined),
    );
    const result = res!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload.domain).toBe("x.com");
    expect(payload.available).toBe(true);
    expect(payload.quoted_price_cents).toBeUndefined();
    expect(payload.quoted_price).toBeUndefined();
    expect(payload.currency).toBeUndefined();
  });

  test("send_email forwards fields and normalizes a scalar `to` to an array", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("send_email", { mailboxId: "mb1", to: "a@b.com", subject: "hi", text: "yo" }, client((c) => c.path === "/api/v1/messages/send" ? { status: 202, body: { id: "m1", status: "sent", attachments: [] } } : undefined, calls));
    expect(res.isError).toBeUndefined();
    expect((calls[0]!.body as { to: string[] }).to).toEqual(["a@b.com"]);
  });

  test("send_email without mailboxId is an isError result (no throw)", async () => {
    const res = await callTool("send_email", { to: "a@b.com" }, client(() => ({})));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("mailboxId");
  });

  // ── launch lane L04: attachments, threading, headers, idempotency, batch ──

  test("send_email forwards attachments, threading and headers to the server", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("send_email", {
      mailboxId: "mb1",
      to: "a@b.com",
      subject: "Re: quote",
      text: "reply",
      inReplyTo: "<parent@x.test>",
      references: ["<root@x.test>"],
      headers: { "X-Campaign": "spring" },
      attachments: [{ filename: "a.txt", contentType: "text/plain", content: "aGk=" }, { attachmentId: "att-1" }],
    }, client((c) => c.path === "/api/v1/messages/send" ? { status: 202, body: { id: "m1", status: "sent", attachments: [] } } : undefined, calls));
    expect(res.isError).toBeUndefined();
    const body = calls[0]!.body as Record<string, any>;
    expect(body.inReplyTo).toBe("<parent@x.test>");
    expect(body.references).toEqual(["<root@x.test>"]);
    expect(body.headers).toEqual({ "X-Campaign": "spring" });
    expect(body.attachments).toEqual([
      { filename: "a.txt", contentType: "text/plain", content: "aGk=", attachmentId: undefined },
      { filename: undefined, contentType: undefined, content: undefined, attachmentId: "att-1" },
    ]);
  });

  test("send_email sends the caller's idempotency key as a header and invents none without it", async () => {
    const withKey: FetchCall[] = [];
    await callTool("send_email", { mailboxId: "mb1", to: "a@b.com", text: "hi", idempotencyKey: "agent-run-7-msg-1" },
      client(() => ({ status: 202, body: { id: "m1", attachments: [] } }), withKey));
    expect(withKey[0]!.headers["idempotency-key"]).toBe("agent-run-7-msg-1");

    const without: FetchCall[] = [];
    await callTool("send_email", { mailboxId: "mb1", to: "a@b.com", text: "hi" },
      client(() => ({ status: 202, body: { id: "m2", attachments: [] } }), without));
    expect(without[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  test("send_email rejects malformed attachments/headers locally, before any request", async () => {
    const calls: FetchCall[] = [];
    const badAttachments = await callTool("send_email", { mailboxId: "mb1", to: "a@b.com", attachments: "nope" }, client(() => ({}), calls));
    expect(badAttachments.isError).toBe(true);
    expect(badAttachments.content[0]!.text).toContain("attachments must be an array");
    const badHeaders = await callTool("send_email", { mailboxId: "mb1", to: "a@b.com", headers: ["X-A"] }, client(() => ({}), calls));
    expect(badHeaders.isError).toBe(true);
    expect(badHeaders.content[0]!.text).toContain("headers must be an object");
    expect(calls).toHaveLength(0);
  });

  test("get_domain_status reads the hosted warm-up envelope and requires a domain", async () => {
    const calls: FetchCall[] = [];
    const c = client(call => call.path === "/api/v1/domains/status" ? { body: { domain_record: { warmup: { remaining_recipients: 38 } } } } : undefined, calls);
    const result = await callTool("get_domain_status", { domain: "agent-mail.com" }, c);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).domain_record.warmup.remaining_recipients).toBe(38);
    expect(calls[0]!.method).toBe("GET");
    const missing = await callTool("get_domain_status", {}, c);
    expect(missing.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("send_email_batch posts every message, keeping each item's own idempotency key", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("send_email_batch", {
      messages: [
        { mailboxId: "mb1", to: "a@b.com", text: "one", idempotencyKey: "k-1" },
        { mailboxId: "mb1", to: ["c@d.com"], text: "two" },
      ],
    }, client((c) => c.path === "/api/v1/messages/send/batch"
      ? { body: { count: 2, sent: 2, failed: 0, results: [], metering: { unit: "monthly_allowance", messages: 2, credits_charged: 0, refunded: 0, retained: 2 } } }
      : undefined, calls));
    expect(res.isError).toBeUndefined();
    const body = calls[0]!.body as { messages: Array<{ to: string[]; idempotencyKey?: string }> };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.idempotencyKey).toBe("k-1");
    expect(body.messages[1]!.to).toEqual(["c@d.com"]);
    expect(body.messages[1]!.idempotencyKey).toBeUndefined();
  });

  test("send_email_batch validates the list locally: empty, over cap, and a bad item", async () => {
    const calls: FetchCall[] = [];
    expect((await callTool("send_email_batch", { messages: [] }, client(() => ({}), calls))).isError).toBe(true);
    expect((await callTool("send_email_batch", { messages: Array.from({ length: 101 }, () => ({ mailboxId: "mb1", to: "a@b.com" })) }, client(() => ({}), calls))).isError).toBe(true);
    const badItem = await callTool("send_email_batch", { messages: [{ to: "a@b.com" }] }, client(() => ({}), calls));
    expect(badItem.isError).toBe(true);
    expect(badItem.content[0]!.text).toContain("messages[0]");
    expect(calls).toHaveLength(0);
  });

  test("get_message_events reads one message's delivery timeline", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("get_message_events", { id: "m1", limit: 25 },
      client((c) => c.path === "/api/v1/messages/m1/events"
        ? { body: { data: [{ id: "e1", message_id: "m1", type: "delivered", recipients: ["a@b.com"], occurred_at: "2026-09-10T12:00:00.000Z" }], message_id: "m1", status: "sent", sent_at: null, last_event_at: "2026-09-10T12:00:00.000Z" } }
        : undefined, calls));
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.query.limit).toBe("25");
    const payload = JSON.parse(res.content[0]!.text) as { status: string; data: Array<{ type: string }> };
    expect(payload.status).toBe("sent");
    expect(payload.data[0]!.type).toBe("delivered");
  });

  test("get_message_events without an id is an isError result", async () => {
    const res = await callTool("get_message_events", {}, client(() => ({})));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("id is required");
  });

  test("buy_domain purchases + provisions the domain and returns the result", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool(
      "buy_domain",
      { domain: "x.com", maxPriceCents: 1500, currency: "usd", idempotencyKey: "idem_mcp_test" },
      client((c) => {
        if (c.path === "/api/v1/domains/availability") return { body: { domain: "x.com", available: true, purchase_quote: { token: "fresh_quote", domain: "x.com", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true } } };
        if (c.path === "/api/v1/domains/purchase" && c.method === "POST") return { body: { domain: "x.com", ownership_ready: true, resumed: false } };
        return undefined;
      }, calls),
    );
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0]!.text) as { ownership_ready: boolean };
    expect(payload.ownership_ready).toBe(true);
    const purchase = calls.find((c) => c.path === "/api/v1/domains/purchase");
    expect(purchase).toBeDefined();
    expect(purchase!.headers["idempotency-key"]).toBe("idem_mcp_test");
    expect(purchase!.body).toMatchObject({ quoteToken: "fresh_quote", maxPriceCents: 1500, currency: "usd" });
  });

  test("buy_domain rejects a fresh quote above the explicit maximum without POSTing", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool(
      "buy_domain",
      { domain: "x.com", maxPriceCents: 1499, currency: "usd", idempotencyKey: "idem_mcp_bound" },
      client((c) => c.path === "/api/v1/domains/availability"
        ? { body: { domain: "x.com", available: true, purchase_quote: { token: "fresh_quote", domain: "x.com", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true } } }
        : undefined, calls),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("price_limit_exceeded");
    expect(calls.some((call) => call.path === "/api/v1/domains/purchase")).toBe(false);
  });

  test("a server error becomes an isError result carrying the code and status", async () => {
    const res = await callTool("get_billing_status", {}, client(() => ({ status: 402, body: { error: { code: "billing_required", message: "pay up" } } })));
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0]!.text) as { code: string; status: number };
    expect(payload.code).toBe("billing_required");
    expect(payload.status).toBe(402);
  });

  test("submit_feedback passes the message through", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("submit_feedback", { message: "nice", kind: "praise" }, client((c) => c.path === "/api/v1/feedback" ? { body: { feedback: { id: "fb1", kind: "praise", message: "nice", status: "new" } } } : undefined, calls));
    expect(res.isError).toBeUndefined();
    expect((calls[0]!.body as { message: string }).message).toBe("nice");
  });

  test("list_mailboxes dispatches a bare GET and returns the mailbox array (send_email chaining)", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("list_mailboxes", {}, client((c) =>
      c.path === "/api/v1/mailboxes" ? { body: { data: [{ id: "mb_1", email: "agent@x.com", provider: "hosted", status: "active" }] } } : undefined, calls));
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/api/v1/mailboxes");
    const payload = JSON.parse(res.content[0]!.text) as Array<{ id: string; email: string }>;
    expect(payload[0]!.id).toBe("mb_1");
    expect(payload[0]!.email).toBe("agent@x.com");
  });

  test("list_changes forwards watermark params and surfaces cursor + state for polling", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool(
      "list_changes",
      { since: "2026-08-01T00:00:00Z", limit: 25 },
      client((c) => c.path === "/api/v1/messages/changes"
        ? { body: { data: [{ id: "m_9" }], next_cursor: "cur2", server_time: "2026-08-02T00:00:00.000Z", state: "c3RhdGU" } }
        : undefined, calls),
    );
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.query.since).toBe("2026-08-01T00:00:00Z");
    expect(calls[0]!.query.limit).toBe("25");
    const payload = JSON.parse(res.content[0]!.text) as { data: Array<{ id: string }>; nextCursor?: string; serverTime?: string; state?: string };
    expect(payload.data[0]!.id).toBe("m_9");
    expect(payload.nextCursor).toBe("cur2");
    expect(payload.state).toBe("c3RhdGU");
  });

  test("list_changes continues from an opaque cursor", async () => {
    const calls: FetchCall[] = [];
    await callTool(
      "list_changes",
      { cursor: "cur2" },
      client((c) => c.path === "/api/v1/messages/changes" ? { body: { data: [], next_cursor: null, state: "c3RhdGU" } } : undefined, calls),
    );
    expect(calls[0]!.query.cursor).toBe("cur2");
    expect(calls[0]!.query.since).toBeUndefined();
  });

  test("update_message PATCHes only the flags provided", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool(
      "update_message",
      { id: "m_1", isRead: true, isStarred: true },
      client((c) => c.path === "/api/v1/messages/m_1" && c.method === "PATCH" ? { body: { id: "m_1", isRead: true, isStarred: true, attachments: [] } } : undefined, calls),
    );
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ isRead: true, isStarred: true });
  });

  test("update_message without any flag is an isError result (no throw)", async () => {
    const res = await callTool("update_message", { id: "m_1" }, client(() => ({})));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("flag");
  });

  test("generate_digest defaults to today's window when omitted", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("generate_digest", {}, client((c) => c.path === "/api/v1/digests/generate" ? { body: { id: "d_1", window: "today", summary: "3 urgent threads" } } : undefined, calls));
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ window: "today" });
    const payload = JSON.parse(res.content[0]!.text) as { window: string; summary: string };
    expect(payload.window).toBe("today");
  });

  test("generate_digest forwards an explicit window", async () => {
    const calls: FetchCall[] = [];
    await callTool("generate_digest", { window: "last_7_days" }, client(() => ({ body: { id: "d_2", window: "last_7_days" } }), calls));
    expect(calls[0]!.body).toEqual({ window: "last_7_days" });
  });

  test("generate_digest rejects an unknown window without POSTing (no accidental credit spend)", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("generate_digest", { window: "fortnight" }, client(() => ({ body: {} }), calls));
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).code).toBe("bad_request");
    expect(calls).toHaveLength(0);
  });

  test("list_digests forwards limit and returns the digest rows", async () => {
    const calls: FetchCall[] = [];
    const res = await callTool("list_digests", { limit: 5 }, client((c) => c.path === "/api/v1/digests" ? { body: { data: [{ id: "d_1", window: "today", summary: "hi" }] } } : undefined, calls));
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.query.limit).toBe("5");
    const payload = JSON.parse(res.content[0]!.text) as Array<{ id: string; window: string }>;
    expect(payload[0]!.id).toBe("d_1");
  });
});
