// Self-hosted-ONLY: every `emails inbox` read/write routes to the operator
// `/v1/messages` API, so these tests drive the REAL commands against an
// out-of-process /v1 stub (see src/test-support/v1-stub.ts). There is no local
// SQLite island anymore; a handful of ingestion/diagnostic subcommands are
// server-only and fail closed with a clear message.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import {
  storeInboundEmail,
  listInboundEmails,
  getInboundEmail,
  type InboundEmail,
} from "../../db/inbound.js";
import { registerInboxCommands } from "./inbox.js";

let stub: V1Stub;
let seq = 0;

type SeedOverrides = Partial<Parameters<typeof storeInboundEmail>[0]>;

// Seed through the REAL inbound repo (POST /v1/messages). Call AFTER applyEnv().
function seedEmail(overrides: SeedOverrides = {}): InboundEmail {
  seq += 1;
  return storeInboundEmail({
    provider_id: null,
    message_id: `msg-${seq}`,
    in_reply_to_email_id: null,
    from_address: `sender${seq}@example.com`,
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject: `Subject ${seq}`,
    text_body: `Body content ${seq}`,
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 100,
    received_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    ...overrides,
  });
}

// A raw /v1 message row for stub.seed({ messages }) when a test needs precise
// flags (is_read/is_starred/labels/direction) the repo write cannot express.
function msgRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: crypto.randomUUID(),
    direction: "inbound",
    from_addr: `sender${seq}@example.com`,
    to_addrs: ["me@example.com"],
    cc_addrs: [],
    subject: `Subject ${seq}`,
    body_text: `Body ${seq}`,
    body_html: null,
    message_id: `mid-${seq}`,
    received_at: at,
    created_at: at,
    is_read: false,
    is_starred: false,
    labels: [],
    status: "received",
    ...overrides,
  };
}

async function runInboxCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerInboxCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

// For BLOCK tests: override process.exit to throw and capture console.error so we
// can assert the exit code and the exact server-only message.
async function runInboxCommandExpectingExit(args: string[]) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runInboxCommand(args);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

// Attachment download failures exercise process.exit(1). Run these new
// security-boundary assertions in an isolated CLI process so one test can
// never replace or restore another test file's global process.exit hook.
async function runInboxSubprocessExpectingExit(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

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
  process.exitCode = 0;
});

// ─── inbound repo round-trip (POST/GET /v1/messages) ─────────────────────────

describe("inbound repo over /v1", () => {
  it("returns seeded received emails newest-first", () => {
    seedEmail({ subject: "oldest", received_at: "2026-03-18T10:00:00.000Z" });
    seedEmail({ subject: "middle", received_at: "2026-03-19T10:00:00.000Z" });
    seedEmail({ subject: "newest", received_at: "2026-03-20T10:00:00.000Z" });

    const emails = listInboundEmails();
    expect(emails.map((e) => e.subject)).toEqual(["newest", "middle", "oldest"]);
  });

  it("respects the limit option", () => {
    for (let i = 0; i < 10; i++) seedEmail({ received_at: `2026-03-${String(10 + i).padStart(2, "0")}T10:00:00.000Z` });
    expect(listInboundEmails({ limit: 3 })).toHaveLength(3);
  });

  it("filters by recipient address and by recipient domain", () => {
    seedEmail({ subject: "to-primary", to_addresses: ["el@example.com"] });
    seedEmail({ subject: "to-secondary", to_addresses: ["ap@example.net"] });
    seedEmail({ subject: "to-display", to_addresses: ['"Display Name" <display@example.com>'] });

    expect(listInboundEmails({ recipients: ["el@example.com"] }).map((e) => e.subject)).toEqual(["to-primary"]);
    expect(listInboundEmails({ recipients: ["display@example.com"] }).map((e) => e.subject)).toEqual(["to-display"]);
    expect(listInboundEmails({ recipientDomains: ["EXAMPLE.COM"] }).map((e) => e.subject).sort()).toEqual(["to-display", "to-primary"]);
    expect(listInboundEmails({ recipientDomains: ["example.net"] }).map((e) => e.subject)).toEqual(["to-secondary"]);
  });

  it("filters by since date", () => {
    seedEmail({ subject: "before", received_at: "2026-03-17T10:00:00.000Z" });
    seedEmail({ subject: "on", received_at: "2026-03-19T10:00:00.000Z" });
    seedEmail({ subject: "after", received_at: "2026-03-20T10:00:00.000Z" });

    const cutoff = "2026-03-19T00:00:00.000Z";
    const emails = listInboundEmails({ since: cutoff });
    expect(emails.map((e) => e.subject)).toEqual(["after", "on"]);
    for (const e of emails) expect(new Date(e.received_at) >= new Date(cutoff)).toBe(true);
  });

  it("returns an empty array when there is no mail", () => {
    expect(listInboundEmails()).toHaveLength(0);
  });

  it("round-trips a single email by id", () => {
    const email = seedEmail({ subject: "round trip", text_body: "hello body" });
    const fetched = getInboundEmail(email.id);
    expect(fetched?.subject).toBe("round trip");
    expect(fetched?.text_body).toBe("hello body");
  });
});

// ─── inbox list ──────────────────────────────────────────────────────────────

describe("inbox list", () => {
  it("lists inbox mail newest-first", async () => {
    seedEmail({ subject: "A", received_at: "2026-01-01T00:00:00.000Z" });
    seedEmail({ subject: "B", received_at: "2026-01-02T00:00:00.000Z" });
    seedEmail({ subject: "C", received_at: "2026-01-03T00:00:00.000Z" });

    const { data, out } = await runInboxCommand(["inbox", "list"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["C", "B", "A"]);
    expect(out).toContain("Mailbox inbox");
  });

  it("respects --limit", async () => {
    for (let i = 1; i <= 5; i++) seedEmail({ subject: `L${i}`, received_at: `2026-01-0${i}T00:00:00.000Z` });
    const { data } = await runInboxCommand(["inbox", "list", "--limit", "2"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["L5", "L4"]);
  });

  it("filters by --to address and by --to domain", async () => {
    seedEmail({ subject: "el", to_addresses: ["el@elyratelier.com"] });
    seedEmail({ subject: "ap", to_addresses: ["ap@example.net"] });

    const byAddress = await runInboxCommand(["inbox", "list", "--to", "el@elyratelier.com"]);
    expect((byAddress.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["el"]);

    const byDomain = await runInboxCommand(["inbox", "list", "--to", "elyratelier.com"]);
    expect((byDomain.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["el"]);
  });

  it("filters --since by timestamp instant across offset timezones", async () => {
    seedEmail({ subject: "before cutoff", received_at: "2026-07-11T23:59:59+00:00" });
    seedEmail({ subject: "offset after cutoff", received_at: "2026-07-11T23:30:00-02:00" });

    const { data } = await runInboxCommand(["inbox", "list", "--since", "2026-07-12T00:00:00.000Z"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["offset after cutoff"]);
  });

  it("shows only starred mail with --starred", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "plain", is_starred: false }),
      msgRow({ subject: "flagged", is_starred: true }),
    ] });

    const { data } = await runInboxCommand(["inbox", "list", "--starred"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["flagged"]);
  });

  it("shows only unread mail with --unread", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "read", is_read: true }),
      msgRow({ subject: "unread", is_read: false }),
    ] });

    const { data } = await runInboxCommand(["inbox", "list", "--unread"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["unread"]);
  });

  it("hides archived mail by default and shows it under --folder archived", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "normal" }),
      msgRow({ subject: "filed", labels: ["archived"] }),
    ] });

    const inbox = await runInboxCommand(["inbox", "list"]);
    expect((inbox.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["normal"]);

    const archived = await runInboxCommand(["inbox", "list", "--folder", "archived"]);
    expect((archived.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["filed"]);
  });

  it("lists outbound mail under --folder sent", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "received" }),
      msgRow({ subject: "outbound", direction: "outbound", labels: ["sent"] }),
    ] });

    const { data } = await runInboxCommand(["inbox", "list", "--folder", "sent"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["outbound"]);
  });

  it("filters by --label", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "tagged", labels: ["work"] }),
      msgRow({ subject: "untagged", labels: [] }),
    ] });

    const { data } = await runInboxCommand(["inbox", "list", "--label", "work"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["tagged"]);
  });

  it("reports no mail when the mailbox is empty", async () => {
    const { data, out } = await runInboxCommand(["inbox", "list"]);
    expect(data).toEqual([]);
    expect(out).toContain("No mail found");
  });
});

// ─── inbox search ────────────────────────────────────────────────────────────

describe("inbox search", () => {
  it("matches subject/body substrings", async () => {
    seedEmail({ subject: "Alpha needle", text_body: "body" });
    seedEmail({ subject: "Beta plain", text_body: "unrelated" });

    const { data } = await runInboxCommand(["inbox", "search", "needle"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["Alpha needle"]);
  });

  it("filters before applying the result limit", async () => {
    seedEmail({ subject: "Recent plain", received_at: "2026-06-04T11:30:09.000Z" });
    seedEmail({ subject: "Older match", received_at: "2026-06-04T11:29:09.000Z" });

    const { data } = await runInboxCommand(["inbox", "search", "match", "--limit", "1"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["Older match"]);
  });

  it("paginates results newest-first with offset", async () => {
    for (let i = 1; i <= 4; i++) {
      seedEmail({ subject: `needle ${i}`, received_at: `2026-06-04T11:0${i}:00.000Z` });
    }
    seedEmail({ subject: "Newest plain", received_at: "2026-06-04T11:09:00.000Z" });

    const { data } = await runInboxCommand(["inbox", "search", "needle", "--limit", "2", "--offset", "1"]);
    expect((data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["needle 3", "needle 2"]);
  });
});

// ─── inbox read ──────────────────────────────────────────────────────────────

describe("inbox read", () => {
  it("renders markdown-ish bodies as readable text", async () => {
    const email = seedEmail({
      subject: "Rendered body",
      text_body: "# Heading\n\n- **hello**\n- [docs](https://example.com/start)",
    });

    const { out } = await runInboxCommand(["inbox", "read", email.id, "--keep-unread"]);
    expect(out).toContain("Heading");
    expect(out).toContain("- hello");
    expect(out).toContain("docs (https://example.com/start)");
    expect(out).not.toContain("**hello**");
  });

  it("resolves a partial (8-char) id", async () => {
    const email = seedEmail({ subject: "By prefix" });
    const { data } = await runInboxCommand(["inbox", "read", email.id.slice(0, 8), "--keep-unread"]);
    expect((data as { subject: string }).subject).toBe("By prefix");
  });

  it("marks the email read by default", async () => {
    const email = seedEmail({ subject: "Mark on open" });
    const { data } = await runInboxCommand(["inbox", "read", email.id]);
    expect((data as { is_read: boolean }).is_read).toBe(true);
    expect(getInboundEmail(email.id)?.is_read).toBe(true);
  });

  it("keeps the email unread with --keep-unread", async () => {
    const email = seedEmail({ subject: "Stay unread" });
    await runInboxCommand(["inbox", "read", email.id, "--keep-unread"]);
    expect(getInboundEmail(email.id)?.is_read).toBe(false);
  });

  it("shows self-hosted attachments as metadata-only (no local download)", async () => {
    const email = seedEmail({
      subject: "With attachment",
      attachments: [{ filename: "invoice.pdf", content_type: "application/pdf", size: 2048 }],
    });

    const { out } = await runInboxCommand(["inbox", "read", email.id, "--keep-unread"]);
    expect(out).toContain("metadata only; no local download in self_hosted mode");
    expect(out).not.toContain("emails inbox sync to download");
  });
});

// ─── inbox mark-read / star / archive / label ────────────────────────────────

describe("inbox mark-read", () => {
  it("marks read and returns a summary without body/header payloads", async () => {
    const email = seedEmail({
      subject: "Mark read summary",
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      headers: { "x-large": "header" },
    });

    const { data, out } = await runInboxCommand(["inbox", "mark-read", email.id]);
    const row = data as Record<string, unknown>;
    expect(out).toContain("Marked read");
    expect(row.id).toBe(email.id);
    expect(row.is_read).toBe(true);
    expect(row).not.toHaveProperty("text_body");
    expect(row).not.toHaveProperty("html_body");
    expect(row).not.toHaveProperty("headers");
    expect(getInboundEmail(email.id)?.is_read).toBe(true);
  });

  it("marks unread with --unread", async () => {
    await stub.seed({ messages: [msgRow({ id: "11111111-1111-4111-8111-111111111111", subject: "Was read", is_read: true })] });
    await runInboxCommand(["inbox", "mark-read", "11111111-1111-4111-8111-111111111111", "--unread"]);
    expect(getInboundEmail("11111111-1111-4111-8111-111111111111")?.is_read).toBe(false);
  });
});

describe("inbox star", () => {
  it("stars and unstars an email (round-trips through --starred)", async () => {
    const email = seedEmail({ subject: "Star me" });

    const starred = await runInboxCommand(["inbox", "star", email.id]);
    expect(starred.out).toContain("Starred");
    const listed = await runInboxCommand(["inbox", "list", "--starred"]);
    expect((listed.data as Array<{ subject: string }>).map((e) => e.subject)).toEqual(["Star me"]);

    const unstarred = await runInboxCommand(["inbox", "star", email.id, "--undo"]);
    expect(unstarred.out).toContain("Unstarred");
    expect(getInboundEmail(email.id)?.is_starred).toBe(false);
  });
});

describe("inbox archive", () => {
  it("archives an email through the /v1 API", async () => {
    const email = seedEmail({ subject: "Archive me" });

    const { out } = await runInboxCommand(["inbox", "archive", email.id]);
    expect(out).toContain("Archived");
    expect(out).toContain("Archive me");

    const row = (await stub.list("messages")).find((m) => m["id"] === email.id);
    expect(row?.["archived"]).toBe(true);
  });
});

describe("inbox label", () => {
  it("PATCHes an add-label request through the /v1 API", async () => {
    const email = seedEmail({ subject: "Label me" });

    const { out } = await runInboxCommand(["inbox", "label", email.id, "urgent"]);
    expect(out).toContain("label");

    const row = (await stub.list("messages")).find((m) => m["id"] === email.id);
    // The server (and now the stub) rebuild the labels column from add_label —
    // a raw add_label field is not persisted, the label lands in `labels`.
    expect(row?.["labels"]).toContain("urgent");
  });
});

// ─── inbox counts / status ───────────────────────────────────────────────────

describe("inbox unread-count", () => {
  it("returns the total unread count from /v1 counts", async () => {
    await stub.seed({ messages: [
      msgRow({ is_read: false }),
      msgRow({ is_read: false }),
      msgRow({ is_read: false }),
      msgRow({ is_read: true }),
      msgRow({ direction: "outbound", labels: ["sent"] }),
    ] });

    const { data, out } = await runInboxCommand(["inbox", "unread-count"]);
    expect(data).toEqual({ unread: 3 });
    expect(out).toBe("3");
  });
});

describe("inbox mailboxes", () => {
  it("reports folder counts from /v1 counts", async () => {
    await stub.seed({ messages: [
      msgRow({}),
      msgRow({}),
      msgRow({ labels: ["archived"] }),
      msgRow({ direction: "outbound", labels: ["sent"] }),
    ] });

    const { data } = await runInboxCommand(["inbox", "mailboxes"]);
    const counts = (data as { counts: { inbox: number; sent: number; archived: number } }).counts;
    expect(counts.inbox).toBe(2);
    expect(counts.sent).toBe(1);
    expect(counts.archived).toBe(1);
  });
});

describe("inbox sources", () => {
  it("exposes the single self-hosted source with its counts", async () => {
    await stub.seed({ messages: [msgRow({ is_read: false }), msgRow({ is_read: true })] });

    const { data } = await runInboxCommand(["inbox", "sources"]);
    const sources = data as Array<{ id: string; unread: number; counts: { inbox: number } }>;
    expect(sources.map((s) => s.id)).toEqual(["self_hosted"]);
    expect(sources[0]?.counts.inbox).toBe(2);
    expect(sources[0]?.unread).toBe(1);
  });
});

describe("inbox status / sync-status", () => {
  it("derives inbox status from the /v1 counts endpoint", async () => {
    await stub.seed({ messages: [
      msgRow({ subject: "in-unread", received_at: "2026-07-01T00:00:00.000Z", is_read: false }),
      msgRow({ subject: "in-read", received_at: "2026-07-02T00:00:00.000Z", is_read: true }),
      msgRow({ subject: "arch", received_at: "2026-07-03T00:00:00.000Z", labels: ["archived"] }),
      msgRow({ subject: "sent", received_at: "2026-07-04T00:00:00.000Z", direction: "outbound", labels: ["sent"] }),
    ] });

    const { data, out } = await runInboxCommand(["inbox", "status"]);
    expect(data).toMatchObject({
      total: 3,
      unread: 1,
      latest_received_at: "2026-07-03T00:00:00.000Z",
    });
    expect(out).toContain("Inbox sync status");
  });

  it("reports source-aware sync status from the /v1 counts endpoint", async () => {
    await stub.seed({ messages: [
      msgRow({ received_at: "2026-07-01T00:00:00.000Z", is_read: false }),
      msgRow({ received_at: "2026-07-02T00:00:00.000Z", is_read: true }),
      msgRow({ received_at: "2026-07-03T00:00:00.000Z", labels: ["archived"] }),
      msgRow({ received_at: "2026-07-04T00:00:00.000Z", direction: "outbound", labels: ["sent"] }),
    ] });

    const { data } = await runInboxCommand(["inbox", "sync-status"]);
    expect(data).toMatchObject({
      inbox: { total: 3, unread: 1 },
      mailboxes: { counts: { inbox: 2, sent: 1, archived: 1 } },
      sources: { total: 1, legacy: 0, orphaned: 0 },
    });
  });
});

// ─── inbox code / wait-code / latest / wait ──────────────────────────────────

describe("inbox code", () => {
  it("prints the newest matching verification code, ignoring sent mail", async () => {
    seedEmail({
      from_address: '"ChatGPT" <noreply@tm.openai.com>',
      subject: "Your temporary ChatGPT verification code",
      text_body: "Enter this temporary verification code to continue:\n\n492255",
      received_at: "2026-06-04T11:29:09.000Z",
    });
    seedEmail({
      from_address: '"ChatGPT" <noreply@tm.openai.com>',
      subject: "Your temporary ChatGPT verification code",
      text_body: "Enter this temporary verification code to continue:\n\n999999",
      received_at: "2026-06-04T11:30:09.000Z",
      label_ids: ["SENT"],
    });

    const { out, data } = await runInboxCommand(["inbox", "code", "me@example.com", "--no-refresh", "--from", "openai"]);
    expect(out).toBe("492255");
    expect(data).toMatchObject({ code: "492255", confidence: "high" });
  });

  it("wait-code returns immediately when a match already exists", async () => {
    seedEmail({
      from_address: "security@example.com",
      subject: "Verification code",
      text_body: "Your code is 123456",
      received_at: "2026-06-04T11:29:09.000Z",
    });

    const { out, data } = await runInboxCommand(["inbox", "wait-code", "me@example.com", "--no-refresh", "--timeout", "1"]);
    expect(out).toBe("123456");
    expect(data).toMatchObject({ code: "123456", confidence: "high" });
  });

  it("supports the top-level `code` alias", async () => {
    seedEmail({
      from_address: "security@example.com",
      subject: "Login code",
      text_body: "Your code is 654321",
      received_at: "2026-06-04T11:29:09.000Z",
    });

    const { out } = await runInboxCommand(["code", "me@example.com", "--no-refresh"]);
    expect(out).toBe("654321");
  });
});

describe("inbox latest / wait", () => {
  it("latest returns the newest matching email", async () => {
    seedEmail({ subject: "Older", received_at: "2026-06-04T11:00:00.000Z" });
    seedEmail({ subject: "Latest local mail", received_at: "2026-06-04T11:29:09.000Z" });

    const { out, data } = await runInboxCommand(["inbox", "latest", "me@example.com"]);
    expect(out).toContain("Latest local mail");
    expect(data).toMatchObject({ subject: "Latest local mail" });
  });

  it("latest applies from and subject filters", async () => {
    seedEmail({
      from_address: "updates@example.com",
      subject: "Recent noise",
      received_at: "2026-06-04T11:30:09.000Z",
    });
    seedEmail({
      from_address: "security@example.com",
      subject: "Target login alert",
      received_at: "2026-06-04T11:29:09.000Z",
    });

    const { data } = await runInboxCommand([
      "inbox", "latest", "me@example.com", "--from", "security", "--subject", "target", "--limit", "1",
    ]);
    expect(data).toMatchObject({ subject: "Target login alert", from_address: "security@example.com" });
  });

  it("wait returns the latest email when one is already present", async () => {
    seedEmail({ subject: "Awaited", received_at: "2026-06-04T11:29:09.000Z" });

    const { data } = await runInboxCommand(["inbox", "wait", "me@example.com", "--no-refresh", "--timeout", "1"]);
    expect(data).toMatchObject({ subject: "Awaited" });
  });
});

// ─── inbox links ─────────────────────────────────────────────────────────────

describe("inbox links", () => {
  it("extracts links via the subcommand and the top-level alias", async () => {
    const email = seedEmail({
      subject: "Links please",
      text_body: "Plain link https://plain.example/path.",
      html_body: `<p>Open <a href="https://Example.com/docs?x=1&amp;y=2">Docs</a></p>`,
    });

    const viaInbox = await runInboxCommand(["inbox", "links", email.id.slice(0, 8)]);
    expect(viaInbox.out).toContain("Links for");
    expect(viaInbox.out).toContain("https://Example.com/docs?x=1&y=2");
    expect(viaInbox.out).toContain("https://plain.example/path");
    expect((viaInbox.data as { links: unknown[] }).links).toHaveLength(2);

    const viaAlias = await runInboxCommand(["links", email.id]);
    expect((viaAlias.data as { links: Array<{ normalized_url: string }> }).links.map((l) => l.normalized_url)).toEqual([
      "https://example.com/docs?x=1&y=2",
      "https://plain.example/path",
    ]);
  });

  it("keeps mailto links out unless --all is passed", async () => {
    const email = seedEmail({
      subject: "Mailto",
      text_body: "mailto:ops@example.com and https://example.com",
    });

    const normal = await runInboxCommand(["inbox", "links", email.id]);
    expect((normal.data as { links: Array<{ normalized_url: string }> }).links.map((l) => l.normalized_url)).toEqual([
      "https://example.com/",
    ]);

    const all = await runInboxCommand(["inbox", "links", email.id, "--all"]);
    expect((all.data as { links: Array<{ normalized_url: string }> }).links.map((l) => l.normalized_url)).toEqual([
      "mailto:ops@example.com",
      "https://example.com/",
    ]);
  });
});

// ─── inbox attachment ────────────────────────────────────────────────────────

describe("inbox attachment", () => {
  it("lists attachment metadata (no local paths in self-hosted mode)", async () => {
    const email = seedEmail({
      subject: "Has attachments",
      attachments: [
        { filename: "invoice.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "notes.txt", content_type: "text/plain", size: 12 },
      ],
    });

    const { data, out } = await runInboxCommand(["inbox", "attachment", email.id.slice(0, 8), "--filename", "invoice.pdf"]);
    expect(data).toEqual([
      { filename: "invoice.pdf", content_type: "application/pdf", size: 2048, openable: false },
    ]);
    expect(out).toContain("2 KB");
    expect(out).toContain("not downloaded");
  });

  it("downloads a validated attachment to a collision-proof mode-0600 file", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [{
          filename: "../invoice.txt",
          content_type: "text/plain",
          size: 5,
          content_base64: "aGVsbG8=",
        }],
      })] });
      const { data } = await runInboxCommand([
        "inbox", "attachment", id, "--download", "--index", "0", "--output-dir", dir, "--max-bytes", "16",
      ]);
      const [saved] = data as Array<{ path: string; sha256: string; bytes: number }>;
      expect(saved).toMatchObject({
        bytes: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      });
      expect(saved.path.startsWith(`${dir}/`)).toBe(true);
      expect(readFileSync(saved.path, "utf8")).toBe("hello");
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires an explicit single index before creating any download file", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "one.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
          { filename: "two.txt", content_type: "text/plain", size: 3, content_base64: "dHdv" },
        ],
      })] });
      const result = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id, "--download", "--output-dir", dir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--index");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires the exact full message id for an attachment download", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "one.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
        ],
      })] });
      const result = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id.slice(0, 8), "--download", "--index", "0", "--output-dir", dir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("exact full message id");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a missing explicit index selection without creating any file", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "one.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
        ],
      })] });
      const result = await runInboxSubprocessExpectingExit([
        "inbox", "attachment", id, "--download", "--index", "7", "--output-dir", dir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No stored attachment metadata");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downloads the explicitly selected duplicate filename index only", async () => {
    const id = crypto.randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-attachment-"));
    try {
      await stub.seed({ messages: [msgRow({
        id,
        attachments: [
          { filename: "same.txt", content_type: "text/plain", size: 3, content_base64: "b25l" },
          { filename: "same.txt", content_type: "text/plain", size: 3, content_base64: "dHdv" },
        ],
      })] });
      const { data } = await runInboxCommand([
        "inbox", "attachment", id, "--download", "--index", "1", "--filename", "same.txt", "--output-dir", dir,
      ]);
      const saved = data as Array<{ index: number; path: string }>;
      expect(saved.map((item) => item.index)).toEqual([1]);
      expect(saved.map((item) => readFileSync(item.path, "utf8"))).toEqual(["two"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── inbox delete / clear ────────────────────────────────────────────────────

describe("inbox delete / clear", () => {
  it("deletes a single email through the /v1 API", async () => {
    const email = seedEmail({ subject: "Delete me" });
    await runInboxCommand(["inbox", "delete", email.id, "--yes"]);
    expect(getInboundEmail(email.id)).toBeNull();
  });

  it("clears the inbox through the /v1 API", async () => {
    seedEmail({ subject: "one" });
    seedEmail({ subject: "two" });
    seedEmail({ subject: "three" });

    await runInboxCommand(["inbox", "clear", "--yes"]);
    expect(listInboundEmails()).toHaveLength(0);
  });
});

// ─── server-only subcommands (fail closed) ───────────────────────────────────

describe("inbox open blocks in the self-hosted client", () => {
  it("fails closed pointing at `inbox read`", async () => {
    const result = await runInboxCommandExpectingExit(["inbox", "open", "abc123"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("emails inbox open is not available in the self-hosted client");
    expect(result.stderr).toContain("emails inbox read <id>");
  });
});

describe("inbox unread-count --by-address blocks in the self-hosted client", () => {
  it("fails closed pointing at the total unread count", async () => {
    const result = await runInboxCommandExpectingExit(["inbox", "unread-count", "--by-address"]);
    expect(result.error).toBe("process.exit:1");
    expect(result.stderr).toContain("inbox unread-count --by-address");
    expect(result.stderr).toContain("not available in the self-hosted client");
    expect(result.stderr).toContain("emails inbox unread-count");
  });
});

describe("server-only ingestion/diagnostic subcommands", () => {
  const cases: Array<{ label: string; args: string[]; command: string }> = [
    { label: "explain", args: ["inbox", "explain", "31f40200"], command: "emails inbox explain" },
    { label: "source list", args: ["inbox", "source", "list"], command: "emails inbox source list" },
    { label: "source add-s3", args: ["inbox", "source", "add-s3", "--bucket", "mail-bucket"], command: "emails inbox source add-s3" },
    { label: "source retire", args: ["inbox", "source", "retire", "s3-mail-bucket"], command: "emails inbox source retire" },
    { label: "sync-s3", args: ["inbox", "sync-s3", "--bucket", "mail-bucket", "--limit", "1"], command: "emails inbox sync-s3" },
    { label: "setup-realtime", args: ["inbox", "setup-realtime", "example.com"], command: "emails inbox setup-realtime" },
    { label: "realtime-status", args: ["inbox", "realtime-status"], command: "emails inbox realtime-status" },
    { label: "watch", args: ["inbox", "watch", "--once"], command: "emails inbox watch" },
    { label: "listen", args: ["inbox", "listen", "--port", "2526"], command: "emails inbox listen" },
  ];

  for (const { label, args, command } of cases) {
    it(`${label} fails closed with a server-only message`, async () => {
      const result = await runInboxCommandExpectingExit(args);
      expect(result.error).toBe("process.exit:1");
      expect(result.stderr).toContain(command);
      expect(result.stderr).toContain("is not available in the self-hosted client");
      expect(result.stderr).toContain("it runs on the self-hosted server");
    });
  }
});
