import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { listInboundEmails, storeInboundEmail } from "../db/inbound.js";
import { runInboxTool } from "./tools/inbox-impl.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-hosted-ONLY: inbox tools route through the mail-data-source seam, which in
// self_hosted mode reads/writes the /v1 messages store (no local SQLite). The
// self-hosted serve is a single shared store, so there is no per-provider scoping.

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

function seed(n: number) {
  for (let i = 0; i < n; i++) {
    storeInboundEmail({
      provider_id: null,
      message_id: `mcp-msg-${i}`,
      in_reply_to_email_id: null,
      from_address: `from${i}@example.com`,
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: `MCP Subject ${i}`,
      text_body: `MCP body text number ${i}`,
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 80,
      received_at: new Date(2026, 5, 1, 12, 0, i).toISOString(),
    });
  }
}

function seedOne(overrides: Partial<Parameters<typeof storeInboundEmail>[0]> = {}) {
  return storeInboundEmail({
    provider_id: null,
    message_id: "mcp-action-msg",
    in_reply_to_email_id: null,
    from_address: "from@example.com",
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject: "MCP Action Subject",
    text_body: "MCP action body",
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 80,
    received_at: new Date().toISOString(),
    ...overrides,
  });
}

async function toolJson(name: Parameters<typeof runInboxTool>[0], input: Record<string, unknown>) {
  const result = await runInboxTool(name, input);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

// ─── inbound read primitives over the /v1 message scan ─────────────────────────

describe("inbound search primitives", () => {
  it("matches subject", () => {
    seed(5);
    const results = listInboundEmails({ limit: 100, search: "subject 2" });
    expect(results).toHaveLength(1);
  });

  it("returns empty for no match", () => {
    seed(5);
    const results = listInboundEmails({ limit: 100, search: "zzz-no-match" });
    expect(results).toHaveLength(0);
  });
});

// ─── self_hosted mode: tools route through SelfHostedMailDataSource (/v1) ───────

describe("MCP inbox tools — self_hosted via seam", () => {
  it("list_inbound_emails returns inbox items (body-free) with truncation", async () => {
    seed(3);
    const result = await toolJson("list_inbound_emails", { limit: 1 });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(items[0]).not.toHaveProperty("text_body");
    expect(String(items[0]!.subject)).toContain("MCP Subject");
  });

  it("search_inbound matches subject", async () => {
    seed(5);
    const result = await toolJson("search_inbound", { query: "Subject 2", limit: 10 });
    const items = result.items as Array<{ subject: string }>;
    expect(items.map((item) => item.subject)).toEqual(["MCP Subject 2"]);
  });

  it("get_inbound_email returns the full detail with body", async () => {
    const email = seedOne({ subject: "Detail subject", text_body: "detail body here" });
    const detail = await toolJson("get_inbound_email", { id: email.id });
    expect(detail.id).toBe(email.id);
    expect(detail.subject).toBe("Detail subject");
    expect(detail.text_body).toBe("detail body here");
  });

  it("mark_email_read flips read state and returns a body-free summary", async () => {
    const email = seedOne();
    const result = await toolJson("mark_email_read", { email_id: email.id });
    expect(result.id).toBe(email.id);
    expect(result.is_read).toBe(true);
    expect(result).not.toHaveProperty("text_body");
  });

  it("download_attachment writes one validated file and never returns bytes", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-mcp-attachment-"));
    try {
      await stub.seed({ messages: [{
        id,
        direction: "inbound",
        from_addr: "sender@example.com",
        to_addrs: ["me@example.com"],
        subject: "attachment",
        status: "received",
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        is_read: false,
        is_starred: false,
        labels: [],
        attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 5, content_base64: "aGVsbG8=" }],
      }] });
      const result = await toolJson("download_attachment", { email_id: id, index: 0, output_dir: dir, max_bytes: 16 });
      expect(result).not.toHaveProperty("data");
      expect(result).not.toHaveProperty("content_base64");
      expect(result).toMatchObject({ bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
      expect(readFileSync(String(result.path), "utf8")).toBe("hello");
      expect(statSync(String(result.path)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("download_attachment rejects an abbreviated message id without creating a file", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-mcp-attachment-"));
    try {
      await stub.seed({ messages: [{
        id,
        direction: "inbound",
        from_addr: "sender@example.com",
        to_addrs: ["me@example.com"],
        subject: "attachment",
        status: "received",
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        is_read: false,
        is_starred: false,
        labels: [],
        attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 5, content_base64: "aGVsbG8=" }],
      }] });
      const result = await runInboxTool("download_attachment", {
        email_id: id.slice(0, 8), index: 0, output_dir: dir, max_bytes: 16,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("exact full message id");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mailbox source tools (self-hosted single shared store)", () => {
  it("exposes the self_hosted source, folder counts, and search", async () => {
    storeInboundEmail({
      provider_id: null,
      message_id: "mcp-source-a",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "mcp needle one",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-02T10:00:00.000Z",
    });
    storeInboundEmail({
      provider_id: null,
      message_id: "mcp-source-b",
      in_reply_to_email_id: null,
      from_address: "other@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "unrelated two",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-03T10:00:00.000Z",
    });

    const sources = await toolJson("list_mailbox_sources", {});
    const sourceItems = sources.sources as Array<{ id: string; badges: string[]; total: number }>;
    const selfHosted = sourceItems.find((source) => source.id === "self_hosted");
    expect(selfHosted).toMatchObject({ total: 2 });
    expect(selfHosted?.badges).toContain("self_hosted");

    const status = await toolJson("list_mailboxes", {});
    expect((status.counts as { inbox: number }).inbox).toBe(2);
    expect(status.cli_equivalent).toBe("emails inbox mailboxes --json");

    const search = await toolJson("search_mailbox", { query: "needle" });
    expect((search.items as Array<{ subject: string }>).map((item) => item.subject)).toEqual(["mcp needle one"]);
    expect(search.cli_equivalent).toBe("emails inbox search needle --folder inbox --json");
  });
});
