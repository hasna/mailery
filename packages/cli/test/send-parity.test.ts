// CLI surface for launch lane L04: attachments, threading, custom headers, a
// caller-supplied idempotency key, batch send, and the delivery-events
// command. No network, no filesystem — the routing fake `fetch` and the
// harness's in-memory files stand in.
//
// The point of these tests is the WIRE: what the CLI actually puts in the
// request body and headers. The server owns every limit and the header
// allowlist, so the CLI is only asserted to pass the caller's intent through
// faithfully — and, for the idempotency key, to pass through exactly what the
// caller supplied and nothing it invented.

import { describe, expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut } from "./support.js";

const KEY_ENV = { MAILERY_API_KEY: "ml_key" };
const SEND_OK = { id: "m1", status: "sent", mode: "live", attachments: [] };

function sendHarness(options: { files?: Record<string, string | Uint8Array>; stdin?: string; body?: unknown } = {}) {
  return makeHarness({
    ...options,
    env: KEY_ENV,
    route: (c) => (c.path === "/api/v1/messages/send" ? { status: 202, body: options.body ?? SEND_OK } : undefined),
  });
}

describe("send: attachments", () => {
  test("--attach reads the file and sends it as base64 with its basename", async () => {
    const bytes = new TextEncoder().encode("report contents");
    const h = sendHarness({ files: { "/tmp/reports/q3.pdf": bytes } });
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi", "--attach", "/tmp/reports/q3.pdf", "--json"), h.deps);
    expect(h.exitCode()).toBe(0);
    const sent = h.calls[0]!.body as { attachments: Array<{ filename: string; content: string }> };
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0]!.filename).toBe("q3.pdf");
    expect(Buffer.from(sent.attachments[0]!.content, "base64").toString()).toBe("report contents");
  });

  test("--attach is repeatable and --attach-id sends a by-reference entry, in order", async () => {
    const h = sendHarness({ files: { "a.txt": "A", "b.txt": "B" } });
    await runCli(argv(
      "send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi",
      "--attach", "a.txt", "--attach", "b.txt", "--attach-id", "att-123", "--json",
    ), h.deps);
    const sent = h.calls[0]!.body as { attachments: Array<Record<string, string>> };
    expect(sent.attachments.map((a) => a.filename ?? a.attachmentId)).toEqual(["a.txt", "b.txt", "att-123"]);
    expect(sent.attachments[2]!.attachmentId).toBe("att-123");
  });

  test("a missing --attach file fails the command instead of sending a partial message", async () => {
    const h = sendHarness({ files: {} });
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi", "--attach", "nope.pdf", "--json"), h.deps);
    expect(h.exitCode()).toBe(1);
    expect(parseJsonOut(h.out()).error!.message).toContain("nope.pdf");
    expect(h.calls).toHaveLength(0);
  });

  test("no attachment flags means no attachments field at all", async () => {
    const h = sendHarness();
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi", "--json"), h.deps);
    expect((h.calls[0]!.body as Record<string, unknown>).attachments).toBeUndefined();
  });
});

describe("send: threading and headers", () => {
  test("--in-reply-to and --references reach the server unmodified", async () => {
    const h = sendHarness();
    await runCli(argv(
      "send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi",
      "--in-reply-to", "<parent@x.test>", "--references", "<root@x.test>,<parent@x.test>", "--json",
    ), h.deps);
    const sent = h.calls[0]!.body as { inReplyTo: string; references: string[] };
    expect(sent.inReplyTo).toBe("<parent@x.test>");
    expect(sent.references).toEqual(["<root@x.test>", "<parent@x.test>"]);
  });

  test("--header is repeatable and splits on the FIRST colon only", async () => {
    const h = sendHarness();
    await runCli(argv(
      "send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi",
      "--header", "X-Campaign: spring-2026",
      "--header", "List-Unsubscribe: <https://example.com/u?id=1>",
      "--json",
    ), h.deps);
    expect((h.calls[0]!.body as { headers: Record<string, string> }).headers).toEqual({
      "X-Campaign": "spring-2026",
      "List-Unsubscribe": "<https://example.com/u?id=1>",
    });
  });

  test("a malformed --header is a usage error before any request", async () => {
    const h = sendHarness();
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi", "--header", "no-colon", "--json"), h.deps);
    expect(h.exitCode()).toBe(1);
    expect(parseJsonOut(h.out()).error!.code).toBe("cli_usage_error");
    expect(h.calls).toHaveLength(0);
  });
});

describe("send: idempotency key", () => {
  test("--idempotency-key is sent as the Idempotency-Key header, verbatim", async () => {
    const h = sendHarness();
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi", "--idempotency-key", "agent-run-42-msg-1", "--json"), h.deps);
    expect(h.calls[0]!.headers["idempotency-key"]).toBe("agent-run-42-msg-1");
    // The key travels as a header, not in the body.
    expect((h.calls[0]!.body as Record<string, unknown>).idempotencyKey).toBeUndefined();
  });

  test("WITHOUT the flag no key is sent — the CLI never invents one", async () => {
    const h = sendHarness();
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi", "--json"), h.deps);
    expect(h.calls[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  test("a replayed send says so instead of implying a second email went out", async () => {
    const h = sendHarness({ body: { ...SEND_OK, replayed: true } });
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi", "--idempotency-key", "agent-run-42-msg-1"), h.deps);
    expect(h.out()).toContain("Replayed the original send");
    expect(h.out()).toContain("no second email was sent");
  });
});

describe("send batch", () => {
  const BATCH_RESULT = {
    count: 2,
    sent: 1,
    failed: 1,
    results: [
      { index: 0, status: "sent", idempotency_key: "k0", replayed: false, dispatched: true, message: { id: "m1" } },
      { index: 1, status: "failed", idempotency_key: null, replayed: false, dispatched: false, error: { code: "recipient_suppressed", message: "recipient suppressed: b@example.com" } },
    ],
    metering: { unit: "monthly_allowance", messages: 2, credits_charged: 0, refunded: 1, retained: 1 },
  };

  function batchHarness(options: { files?: Record<string, string>; stdin?: string } = {}) {
    return makeHarness({
      ...options,
      env: KEY_ENV,
      route: (c) => (c.path === "/api/v1/messages/send/batch" ? { body: BATCH_RESULT } : undefined),
    });
  }

  test("--file posts the messages array to the batch route", async () => {
    const payload = JSON.stringify({ messages: [{ mailboxId: "mb1", to: ["a@example.com"], text: "one", idempotencyKey: "k0" }, { mailboxId: "mb1", to: ["b@example.com"], text: "two" }] });
    const h = batchHarness({ files: { "batch.json": payload } });
    await runCli(argv("send", "batch", "--file", "batch.json", "--json"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.calls[0]!.path).toBe("/api/v1/messages/send/batch");
    const sent = h.calls[0]!.body as { messages: Array<{ to: string[]; idempotencyKey?: string }> };
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0]!.idempotencyKey).toBe("k0");
  });

  test("a bare JSON array is accepted as the messages list", async () => {
    const h = batchHarness({ files: { "batch.json": JSON.stringify([{ mailboxId: "mb1", to: ["a@example.com"], text: "one" }]) } });
    await runCli(argv("send", "batch", "--file", "batch.json", "--json"), h.deps);
    expect((h.calls[0]!.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("piped JSON works when --file is omitted", async () => {
    const h = batchHarness({ stdin: JSON.stringify([{ mailboxId: "mb1", to: ["a@example.com"], text: "one" }]) });
    await runCli(argv("send", "batch", "--json"), h.deps);
    expect(h.calls[0]!.path).toBe("/api/v1/messages/send/batch");
  });

  test("text output reports the accounting, not just the count", async () => {
    const h = batchHarness({ files: { "batch.json": JSON.stringify([{ mailboxId: "mb1", to: ["a@example.com"] }, { mailboxId: "mb1", to: ["b@example.com"] }]) } });
    await runCli(argv("send", "batch", "--file", "batch.json"), h.deps);
    expect(h.out()).toContain("1 sent, 1 failed");
    expect(h.out()).toContain("kept 1, returned 1");
    expect(h.out()).toContain("recipient_suppressed");
  });

  test("an empty or unparseable payload is a usage error before any request", async () => {
    const empty = batchHarness({ stdin: "" });
    await runCli(argv("send", "batch", "--json"), empty.deps);
    expect(empty.exitCode()).toBe(1);
    expect(parseJsonOut(empty.out()).error!.code).toBe("cli_usage_error");
    expect(empty.calls).toHaveLength(0);

    const broken = batchHarness({ files: { "batch.json": "{not json" } });
    await runCli(argv("send", "batch", "--file", "batch.json", "--json"), broken.deps);
    expect(broken.exitCode()).toBe(1);
    expect(broken.calls).toHaveLength(0);

    const notList = batchHarness({ files: { "batch.json": JSON.stringify({ messages: [] }) } });
    await runCli(argv("send", "batch", "--file", "batch.json", "--json"), notList.deps);
    expect(notList.exitCode()).toBe(1);
    expect(notList.calls).toHaveLength(0);
  });

  test("`send` with flags still sends a single message (the subcommand does not shadow it)", async () => {
    const h = sendHarness();
    await runCli(argv("send", "--mailbox", "mb1", "--to", "a@example.com", "--text", "hi", "--json"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.calls[0]!.path).toBe("/api/v1/messages/send");
  });
});

describe("events", () => {
  const TIMELINE = {
    data: [
      { id: "e2", message_id: "m1", type: "bounced", reason_code: "Permanent/General", recipients: ["a@example.com"], occurred_at: "2026-09-10T12:05:00.000Z" },
      { id: "e1", message_id: "m1", type: "delivered", reason_code: null, recipients: ["a@example.com"], occurred_at: "2026-09-10T12:00:00.000Z" },
    ],
    message_id: "m1",
    status: "failed",
    sent_at: "2026-09-10T11:59:00.000Z",
    last_event_at: "2026-09-10T12:05:00.000Z",
  };

  test("events <id> reads the message timeline", async () => {
    const h = makeHarness({ env: KEY_ENV, route: (c) => (c.path === "/api/v1/messages/m1/events" ? { body: TIMELINE } : undefined) });
    await runCli(argv("events", "m1", "--json"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(parseJsonOut(h.out()).data).toMatchObject({ status: "failed", last_event_at: "2026-09-10T12:05:00.000Z" });
  });

  test("text output leads with the current status and lists the events newest first", async () => {
    const h = makeHarness({ env: KEY_ENV, route: () => ({ body: TIMELINE }) });
    await runCli(argv("events", "m1"), h.deps);
    const lines = h.out().trim().split("\n");
    expect(lines[0]).toContain("status: failed");
    expect(lines[1]).toContain("bounced");
    expect(lines[1]).toContain("Permanent/General");
    expect(lines[2]).toContain("delivered");
  });

  test("--limit is forwarded as a query parameter", async () => {
    const h = makeHarness({ env: KEY_ENV, route: () => ({ body: { ...TIMELINE, data: [] } }) });
    await runCli(argv("events", "m1", "--limit", "5", "--json"), h.deps);
    expect(h.calls[0]!.query.limit).toBe("5");
  });

  test("a message with no provider feedback yet says so rather than implying delivery", async () => {
    const h = makeHarness({ env: KEY_ENV, route: () => ({ body: { data: [], message_id: "m1", status: "queued", sent_at: null, last_event_at: null } }) });
    await runCli(argv("events", "m1"), h.deps);
    expect(h.out()).toContain("no provider events yet");
  });
});
