// Tests for agent-loop ergonomics: inbox cursor pagination (--cursor +
// nextCursor/has_more in the JSON envelope) and the attachments download
// command. No network, no filesystem — a routing fake `fetch` and an injected
// file writer stand in for the server and disk.

import { describe, expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut, type Harness } from "./support.js";

function harness(...args: Parameters<typeof makeHarness>): Harness {
  return makeHarness(...args);
}

const MSG = { id: "m1", direction: "inbound", fromAddress: "a@b.com", subject: "hi" };
const ATT = { id: "att1", filename: "report.pdf", contentType: "application/pdf", sizeBytes: 4 };

describe("inbox cursor pagination", () => {
  test("--cursor forwards the page cursor to GET /api/v1/messages", async () => {
    const h = harness({
      route: (c) => (c.path === "/api/v1/messages" ? { body: { data: [], next_cursor: null } } : undefined),
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("inbox", "--cursor", "cur_abc123", "--json"), h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.query.cursor).toBe("cur_abc123");
    expect(h.exitCode()).toBe(0);
  });

  test("--json exposes nextCursor and has_more so scripts can loop", async () => {
    const h = harness({
      route: (c) => (c.path === "/api/v1/messages"
        ? { body: { data: [MSG], next_cursor: "cur_page2" } }
        : undefined),
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("inbox", "--json"), h.deps);
    const data = parseJsonOut(h.out()).data as { data?: unknown[]; nextCursor?: string | null; has_more?: boolean };
    expect(data.nextCursor).toBe("cur_page2");
    expect(data.has_more).toBe(true);
    expect(data.data).toHaveLength(1);
  });

  test("a last page reports has_more false with a null cursor", async () => {
    const h = harness({
      route: (c) => (c.path === "/api/v1/messages" ? { body: { data: [MSG], next_cursor: null } } : undefined),
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("inbox", "--json"), h.deps);
    const data = parseJsonOut(h.out()).data as { nextCursor?: string | null; has_more?: boolean };
    expect(data.nextCursor).toBeNull();
    expect(data.has_more).toBe(false);
  });

  test("text mode names the exact follow-up command when another page exists", async () => {
    const h = harness({
      route: (c) => (c.path === "/api/v1/messages" ? { body: { data: [MSG], next_cursor: "cur_page2" } } : undefined),
      env: { MAILERY_API_KEY: "ml_key" },
    });
    await runCli(argv("inbox"), h.deps);
    expect(h.out()).toContain("m1");
    expect(h.out()).toContain("mailery inbox --cursor cur_page2");
  });

  test("--cursor combined with --watch is a usage error before any request", async () => {
    const h = harness({ route: () => ({}), env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("inbox", "--cursor", "cur_abc", "--watch", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("cli_usage_error");
    expect(h.calls).toHaveLength(0);
  });
});

describe("attachments download", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

  function binaryFetch(recorded: Array<{ path: string; method: string }>) {
    return async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      recorded.push({ path: url.pathname, method: (init?.method ?? "GET").toUpperCase() });
      if (url.pathname === "/api/v1/messages/msg1/attachments") {
        return Response.json({ data: [ATT] });
      }
      if (url.pathname === "/api/v1/attachments/att1/download") {
        return new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
    };
  }

  test("without an attachment id, lists the message's attachments as metadata", async () => {
    const recorded: Array<{ path: string; method: string }> = [];
    const h = harness({ fetch: binaryFetch(recorded), env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("attachments", "download", "msg1", "--json"), h.deps);
    const envelope = parseJsonOut(h.out());
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data)).toBe(true);
    expect((envelope.data as Array<{ id: string }>)[0]!.id).toBe("att1");
    // No binary was fetched — only the metadata listing.
    expect(recorded.map((r) => r.path)).toEqual(["/api/v1/messages/msg1/attachments"]);
  });

  test("happy path: downloads bytes and writes them to the attachment filename", async () => {
    const written: Array<{ path: string; data: Uint8Array }> = [];
    const h = harness({ fetch: binaryFetch([]), env: { MAILERY_API_KEY: "ml_key" } });
    h.deps.writeFile = async (path, data) => { written.push({ path, data }); };
    await runCli(argv("attachments", "download", "msg1", "att1", "--json"), h.deps);
    const envelope = parseJsonOut(h.out());
    expect(envelope.ok).toBe(true);
    const data = envelope.data as { message_id: string; attachment_id: string; filename: string; output: string; size_bytes: number; content_type: string };
    expect(data.message_id).toBe("msg1");
    expect(data.attachment_id).toBe("att1");
    expect(data.filename).toBe("report.pdf");
    expect(data.output).toBe("report.pdf");
    expect(data.size_bytes).toBe(4);
    expect(data.content_type).toBe("application/pdf");
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe("report.pdf");
    expect(Array.from(written[0]!.data)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(h.exitCode()).toBe(0);
  });

  test("--output - streams the raw binary to stdout only (envelope goes to stderr)", async () => {
    const stdoutBytes: Uint8Array[] = [];
    const h = harness({ fetch: binaryFetch([]), env: { MAILERY_API_KEY: "ml_key" } });
    h.deps.stdout = (chunk) => { if (typeof chunk !== "string") stdoutBytes.push(chunk); };
    await runCli(argv("attachments", "download", "msg1", "att1", "--output", "-", "--json"), h.deps);
    // Stdout carries exactly the attachment bytes and nothing else.
    expect(stdoutBytes).toHaveLength(1);
    expect(Array.from(stdoutBytes[0]!)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(h.out()).toBe("");
    // The machine-readable envelope is still available, on stderr.
    expect(h.err()).toContain('"ok": true');
  });

  test("an attachment id not on the message fails with a list-form hint and never downloads", async () => {
    const recorded: Array<{ path: string; method: string }> = [];
    const h = harness({ fetch: binaryFetch(recorded), env: { MAILERY_API_KEY: "ml_key" } });
    await runCli(argv("attachments", "download", "msg1", "att_missing", "--json"), h.deps);
    const envelope = parseJsonOut(h.out());
    expect(envelope.ok).toBe(false);
    expect(envelope.error!.code).toBe("attachment_not_found");
    expect(envelope.error!.hint).toContain("attachments download msg1");
    // Only the metadata listing happened; no download call.
    expect(recorded.map((r) => r.path)).toEqual(["/api/v1/messages/msg1/attachments"]);
  });
});
