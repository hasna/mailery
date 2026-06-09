/**
 * Tests for inbox CLI commands — tests the underlying DB/sync logic
 * exercised by `emails inbox` subcommands.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase, closeDatabase, uuid, getDataDir } from "../../db/database.js";
import { storeInboundEmail, listInboundEmails, getInboundEmail, getInboundCount, clearInboundEmails } from "../../db/inbound.js";
import { getGmailSyncState, updateLastSynced, setGmailSyncState } from "../../db/gmail-sync-state.js";
import { createAddress } from "../../db/addresses.js";
import { createDomain } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { setAddressProvisioning, setDomainProvisioning } from "../../db/provisioning.js";
import { saveConfig } from "../../lib/config.js";

// ─── Mock @hasna/connectors before any gmail-sync imports ─────────────────────

const DATE = "Fri, 20 Mar 2026 10:00:00 +0000";
let mockListMsgs: { id: string; subject?: string; from?: string }[] = [];

const mockRun = mock(async (operationArgs: {
  operation: string;
  input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
}) => {
  const { operation, input } = operationArgs;
  if (operation === "messages.list") {
    const data = mockListMsgs.map((m) => ({ id: m.id, from: m.from ?? "a@b.com", subject: m.subject ?? "S", date: DATE }));
    return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
  }
  if (operation === "messages.read" || operation === "messages.get") {
    const id = String(input?.args?.[0] ?? "x");
    const m = mockListMsgs.find((x) => x.id === id);
    const data = { id, from: m?.from ?? "a@b.com", to: "me@b.com", subject: m?.subject ?? "S", date: DATE, body: "body", htmlBody: "<p>body</p>", size: 100 };
    return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
  }
  return { connector: "gmail", operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
});

mock.module("@hasna/connectors", () => ({ runConnectorOperation: mockRun }));

const mockAutoPull = mock(async () => ({ pulled: 0, ok: true, configured: true }));
mock.module("../tui/autopull.js", () => ({ autoPull: mockAutoPull }));

const { syncGmailInbox } = await import("../../lib/gmail-sync.js");
const { registerInboxCommands } = await import("./inbox.js");
const { Command } = await import("commander");

const TMP_HOME = join("/tmp", `emails-inbox-test-${process.pid}`);
const origHome = process.env["HOME"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Gmail Test', 'gmail', 1)`, [providerId]);
  return { db, providerId };
}

function seedInboundEmails(providerId: string, count: number) {
  const db = getDatabase();
  const emails = [];
  for (let i = 0; i < count; i++) {
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: `msg-${i}`,
      in_reply_to_email_id: null,
      from_address: `sender${i}@example.com`,
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: `Test Subject ${i}`,
      text_body: `Body content for email ${i}`,
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: new Date(2026, 2, 20 - i).toISOString(),
    }, db);
    emails.push(email);
  }
  return emails;
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

beforeEach(() => {
  mockListMsgs = [];
  mockAutoPull.mockReset();
  mockAutoPull.mockImplementation(async () => ({ pulled: 0, ok: true, configured: true }));
  mockRun.mockReset();
  mockRun.mockImplementation(async (operationArgs: {
    operation: string;
    input?: Record<string, unknown> & { args?: Array<string | number | boolean> };
  }) => {
    const { operation, input } = operationArgs;
    if (operation === "messages.list") {
      const data = mockListMsgs.map((m) => ({ id: m.id, from: m.from ?? "a@b.com", subject: m.subject ?? "S", date: DATE }));
      return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    if (operation === "messages.read" || operation === "messages.get") {
      const id = String(input?.args?.[0] ?? "x");
      const m = mockListMsgs.find((x) => x.id === id);
      const data = { id, from: m?.from ?? "a@b.com", to: "me@b.com", subject: m?.subject ?? "S", date: DATE, body: "body", htmlBody: "<p>body</p>", size: 100 };
      return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    if (operation === "attachments.list") {
      const data = [{ attachmentId: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 12 }];
      return { connector: "gmail", operation, success: true, stdout: JSON.stringify(data), stderr: "", exitCode: 0, data };
    }
    if (operation === "attachments.download") {
      const outputDir = typeof input?.dir === "string" ? input.dir : undefined;
      if (outputDir) {
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, "invoice.pdf"), "pdf-data");
      }
      return { connector: "gmail", operation, success: true, stdout: "", stderr: "", exitCode: 0, data: [] };
    }
    return { connector: "gmail", operation, success: true, stdout: "[]", stderr: "", exitCode: 0, data: [] };
  });
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  if (origHome !== undefined) process.env["HOME"] = origHome;
  else delete process.env["HOME"];
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
});

// ─── inbox list (listInboundEmails) ──────────────────────────────────────────

describe("inbox list — listInboundEmails", () => {
  it("returns all synced emails", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 3);

    const emails = listInboundEmails({ provider_id: providerId });
    expect(emails).toHaveLength(3);
  });

  it("respects limit option", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 10);

    const emails = listInboundEmails({ provider_id: providerId, limit: 3 });
    expect(emails).toHaveLength(3);
  });

  it("filters by provider_id", () => {
    const { db, providerId } = setupDb();
    seedInboundEmails(providerId, 2);

    // Create a second provider and seed it
    const otherId = uuid();
    db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Other', 'gmail', 1)`, [otherId]);
    storeInboundEmail({
      provider_id: otherId,
      message_id: "other-msg",
      in_reply_to_email_id: null,
      from_address: "other@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Other email",
      text_body: "Other body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 50,
      received_at: new Date().toISOString(),
    }, db);

    const emails = listInboundEmails({ provider_id: providerId });
    expect(emails.every(e => e.provider_id === providerId)).toBe(true);
    expect(emails).toHaveLength(2);
  });

  it("filters by recipient address and by recipient domain (backs `inbox list --to`)", () => {
    const { db, providerId } = setupDb();
    const mk = (subject: string, to: string[]) => storeInboundEmail({
      provider_id: providerId, message_id: `<${subject}@x>`, in_reply_to_email_id: null,
      from_address: "openai@ext.com", to_addresses: to, cc_addresses: [], subject,
      text_body: "b", html_body: null, attachments: [], attachment_paths: [], headers: {},
      raw_size: 1, received_at: new Date().toISOString(),
    }, db);
    mk("to-elyra", ["el@elyratelier.com"]);
    mk("to-holy", ["ap@holypaper.com"]);
    mk("to-display", ['"Display Name" <display@elyratelier.com>']);

    // exact address
    expect(listInboundEmails({ recipients: ["el@elyratelier.com"] }, db).map((e) => e.subject)).toEqual(["to-elyra"]);
    expect(listInboundEmails({ recipients: ["display@elyratelier.com"] }, db).map((e) => e.subject)).toEqual(["to-display"]);
    // bare domain (catch-all routing) — case-insensitive
    expect(listInboundEmails({ recipientDomains: ["ELYRATELIER.COM"] }, db).map((e) => e.subject).sort()).toEqual(["to-display", "to-elyra"]);
    expect(listInboundEmails({ recipientDomains: ["holypaper.com"] }, db).map((e) => e.subject)).toEqual(["to-holy"]);
  });

  it("filters by since date", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 5); // emails dated Mar 20, 19, 18, 17, 16

    // Only emails from Mar 19 onward (2 emails: idx 0 = Mar 20, idx 1 = Mar 19)
    const cutoff = new Date(2026, 2, 19).toISOString();
    const emails = listInboundEmails({ provider_id: providerId, since: cutoff });
    expect(emails.length).toBeLessThanOrEqual(2);
    for (const e of emails) {
      expect(new Date(e.received_at) >= new Date(cutoff)).toBe(true);
    }
  });

  it("returns empty array when no emails", () => {
    setupDb();
    const emails = listInboundEmails();
    expect(emails).toHaveLength(0);
  });

  it("explains display-name recipients as normalized addresses", async () => {
    const { db, providerId } = setupDb();
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "display-explain",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ['"Me" <me@example.com>'],
      cc_addresses: [],
      subject: "Display explain",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { out } = await runInboxCommand(["inbox", "explain", email.id]);

    expect(out).toContain("To:       me@example.com");
  });

  it("explains only matching address and domain configuration", async () => {
    const { db, providerId } = setupDb();
    const targetDomain = createDomain(providerId, "example.com", db);
    const targetAddress = createAddress({ provider_id: providerId, email: "me@example.com" }, db);
    const sameDomainAddress = createAddress({ provider_id: providerId, email: "other@example.com" }, db);
    setDomainProvisioning(targetDomain.id, { provisioning_status: "ready" }, db);
    setAddressProvisioning(targetAddress.id, { domain_id: targetDomain.id, provisioning_status: "ready" }, db);
    setAddressProvisioning(sameDomainAddress.id, { domain_id: targetDomain.id, provisioning_status: "ready" }, db);

    const otherProvider = createProvider({ name: "Other", type: "ses" }, db);
    const otherDomain = createDomain(otherProvider.id, "other.com", db);
    const otherAddress = createAddress({ provider_id: otherProvider.id, email: "other@other.com" }, db);
    setDomainProvisioning(otherDomain.id, { provisioning_status: "ready" }, db);
    setAddressProvisioning(otherAddress.id, { domain_id: otherDomain.id, provisioning_status: "ready" }, db);

    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "scoped-explain",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ['"Me" <ME@example.com>'],
      cc_addresses: [],
      subject: "Scoped explain",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    let resultData: unknown;
    let out = "";
    try {
      const result = await runInboxCommand(["inbox", "explain", email.id]);
      resultData = result.data;
      out = result.out;
    } finally {
      db.query = originalQuery;
    }
    const data = resultData;
    const result = data as {
      recipients: Array<{
        recipient: string;
        configured_addresses: Array<{
          id: string;
          provider_name: string | null;
          provisioning: { domain_id: string | null; provisioning_status: string } | null;
        }>;
        domains: Array<{
          id: string;
          provider_name: string | null;
          readiness: { ready_addresses: number; receive_ready: boolean };
        }>;
      }>;
    };

    const recipient = result.recipients[0]!;
    expect(recipient.recipient).toBe("me@example.com");
    expect(recipient.configured_addresses.map((address) => address.id)).toEqual([targetAddress.id]);
    expect(recipient.configured_addresses[0]?.provider_name).toBe("Gmail Test");
    expect(recipient.configured_addresses[0]?.provisioning?.domain_id).toBe(targetDomain.id);
    expect(recipient.domains.map((domain) => domain.id)).toEqual([targetDomain.id]);
    expect(recipient.domains[0]?.provider_name).toBe("Gmail Test");
    expect(recipient.domains[0]?.readiness.ready_addresses).toBe(2);
    expect(recipient.domains[0]?.readiness.receive_ready).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(otherAddress.id);
    expect(serialized).not.toContain(otherDomain.id);
    expect(out).toContain(targetAddress.id.slice(0, 8));
    expect(out).not.toContain(otherAddress.id.slice(0, 8));

    const providerQueries = queries.filter((sql) => sql.includes("FROM providers"));
    expect(providerQueries.join("\n")).not.toContain("SELECT *");
    expect(providerQueries.join("\n")).not.toMatch(/\b(api_key|access_key|secret_key|oauth_client_secret|oauth_refresh_token|oauth_access_token)\b/);
    const inboundQueries = queries.filter((sql) => sql.includes("FROM inbound_emails"));
    expect(inboundQueries.join("\n")).not.toContain("SELECT *");
    expect(inboundQueries.join("\n")).not.toMatch(/\b(text_body|html_body|headers_json)\b/);
    expect(queries.some((sql) => sql.includes("FROM address_ownership_events"))).toBe(false);
    expect(queries.some((sql) => sql.includes("FROM addresses") && sql.includes("WHERE id IN ("))).toBe(true);
    expect(queries.some((sql) => sql.includes("FROM domains") && sql.includes("WHERE id IN ("))).toBe(true);
    expect(queries.some((sql) => sql.includes("COUNT(*)") && sql.includes("domain_id IN ("))).toBe(true);
  });
});

// ─── archive migration command contract ──────────────────────────────────────

describe("inbox archive-migrate contract", () => {
  it("supports bounded continuation-token resumes and target-region clients", () => {
    const source = readFileSync(join(import.meta.dir, "inbox.ts"), "utf8");
    expect(source).toContain('.option("--continuation-token <token>"');
    expect(source).toContain("continuationToken: opts.continuationToken");
    expect(source).toContain("targetRegion !== opts.region");
    expect(source).toContain("getDefaultGmailArchiveS3Region()");
  });

  it("does not resolve archive config defaults during command registration", () => {
    const source = readFileSync(join(import.meta.dir, "inbox.ts"), "utf8");
    expect(source).not.toContain('from "../../lib/config.js"');
    expect(source).not.toContain("const defaultGmailArchiveBucket = getDefaultGmailArchiveS3Bucket()");
    expect(source).not.toContain("const defaultGmailArchiveRegion = getDefaultGmailArchiveS3Region()");
    expect(source).toContain('import("../../lib/config.js")');
  });
});

// ─── inbox search (local filter) ─────────────────────────────────────────────

describe("inbox search — local filter", () => {
  it("filters by subject substring", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 5);

    const q = "subject 2".toLowerCase();
    const all = listInboundEmails({ provider_id: providerId, limit: 100 });
    const results = all.filter(e => e.subject.toLowerCase().includes(q));
    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toContain("2");
  });

  it("filters by from_address", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 5);

    const q = "sender3@example.com";
    const all = listInboundEmails({ provider_id: providerId, limit: 100 });
    const results = all.filter(e => e.from_address.toLowerCase().includes(q));
    expect(results).toHaveLength(1);
    expect(results[0]!.from_address).toBe("sender3@example.com");
  });

  it("filters by body text", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 5);

    const q = "body content for email 4";
    const all = listInboundEmails({ provider_id: providerId, limit: 100 });
    const results = all.filter(e => (e.text_body ?? "").toLowerCase().includes(q));
    expect(results).toHaveLength(1);
    expect(results[0]!.text_body).toContain("4");
  });

  it("returns empty for no match", () => {
    const { providerId } = setupDb();
    seedInboundEmails(providerId, 3);

    const q = "zzz-no-match-zzz";
    const all = listInboundEmails({ provider_id: providerId, limit: 100 });
    const results = all.filter(e => e.subject.toLowerCase().includes(q) || e.from_address.toLowerCase().includes(q));
    expect(results).toHaveLength(0);
  });

  it("searches before applying the result limit", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "recent-unrelated",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["recent@example.com"],
      cc_addresses: [],
      subject: "Recent unrelated",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "older-match",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["target@example.com"],
      cc_addresses: [],
      subject: "Older match",
      text_body: "contains needle",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { data } = await runInboxCommand(["inbox", "search", "needle", "--limit", "1"]);

    expect((data as Array<{ subject: string }>).map((email) => email.subject)).toEqual(["Older match"]);
  });

  it("paginates local search results with offset after filtering", async () => {
    const { db, providerId } = setupDb();
    for (let i = 1; i <= 4; i++) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: `paged-search-${i}`,
        in_reply_to_email_id: null,
        from_address: "sender@example.com",
        to_addresses: ["target@example.com"],
        cc_addresses: [],
        subject: `Paged needle ${i}`,
        text_body: "contains needle",
        html_body: null,
        attachments: [],
        attachment_paths: [],
        headers: {},
        raw_size: 100,
        received_at: `2026-06-04T11:0${i}:00.000Z`,
      }, db);
    }
    storeInboundEmail({
      provider_id: providerId,
      message_id: "paged-search-unrelated",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["target@example.com"],
      cc_addresses: [],
      subject: "Newest unrelated",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:05:00.000Z",
    }, db);

    const { data } = await runInboxCommand(["inbox", "search", "needle", "--limit", "2", "--offset", "1"]);
    const emails = data as Array<Record<string, unknown>>;

    expect(emails.map((email) => email.subject)).toEqual([
      "Paged needle 3",
      "Paged needle 2",
    ]);
    expect(emails[0]).not.toHaveProperty("text_body");
    expect(emails[0]).not.toHaveProperty("html_body");
    expect(emails[0]).not.toHaveProperty("headers");
  });

  it("caps remote Gmail search limit before calling the connector", async () => {
    setupDb();

    await runInboxCommand(["inbox", "search", "needle", "--remote", "--limit", "100000"]);

    const listCall = mockRun.mock.calls.find((call) => call[0]?.operation === "messages.list");
    expect(listCall?.[0]?.input).toMatchObject({ query: "needle", max: 1000 });
  });
});

describe("inbox code", () => {
  it("prints the newest matching verification code only", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "openai-code",
      in_reply_to_email_id: null,
      from_address: '"ChatGPT" <noreply@tm.openai.com>',
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Your temporary ChatGPT verification code",
      text_body: "Enter this temporary verification code to continue:\n\n492255",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "openai-sent-code",
      in_reply_to_email_id: null,
      from_address: '"ChatGPT" <noreply@tm.openai.com>',
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Your temporary ChatGPT verification code",
      text_body: "Enter this temporary verification code to continue:\n\n999999",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      label_ids: ["SENT"],
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);

    const { out, data } = await runInboxCommand(["inbox", "code", "me@example.com", "--no-refresh", "--from", "openai"]);

    expect(out).toBe("492255");
    expect(data).toMatchObject({ code: "492255", confidence: "high" });
  });

  it("wait-code reuses code extraction and returns immediately when a match exists", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "code-now",
      in_reply_to_email_id: null,
      from_address: "security@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Verification code",
      text_body: "Your code is 123456",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { out, data } = await runInboxCommand(["inbox", "wait-code", "me@example.com", "--no-refresh", "--timeout", "1"]);

    expect(out).toBe("123456");
    expect(data).toMatchObject({ code: "123456", confidence: "high" });
  });

  it("wait-code checks local mail before refreshing", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "code-local-first",
      in_reply_to_email_id: null,
      from_address: "security@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Verification code",
      text_body: "Your code is 456789",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { out, data } = await runInboxCommand(["inbox", "wait-code", "me@example.com", "--timeout", "1"]);

    expect(out).toBe("456789");
    expect(data).toMatchObject({ code: "456789", confidence: "high" });
    expect(mockAutoPull).toHaveBeenCalledTimes(0);
  });

  it("latest returns the newest matching local email", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "latest-now",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Latest local mail",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { out, data } = await runInboxCommand(["inbox", "latest", "me@example.com"]);

    expect(out).toContain("Latest local mail");
    expect(data).toMatchObject({ subject: "Latest local mail" });
  });

  it("latest applies from and subject filters before the result limit", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "recent-noise",
      in_reply_to_email_id: null,
      from_address: "updates@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Recent noise",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "older-target",
      in_reply_to_email_id: null,
      from_address: "security@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Target login alert",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { data } = await runInboxCommand([
      "inbox",
      "latest",
      "me@example.com",
      "--from",
      "security",
      "--subject",
      "target",
      "--limit",
      "1",
    ]);

    expect(data).toMatchObject({ subject: "Target login alert", from_address: "security@example.com" });
  });

  it("unread-count groups unread messages by recipient address", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "unread-one",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["one@example.com"],
      cc_addresses: [],
      subject: "Unread one",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "unread-two",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["two@example.com"],
      cc_addresses: [],
      subject: "Unread two",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "unread-display",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ['"One" <one@example.com>'],
      cc_addresses: [],
      subject: "Unread display",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:31:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "sent-one",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["one@example.com"],
      cc_addresses: [],
      subject: "Sent one",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      label_ids: ["SENT"],
      raw_size: 100,
      received_at: "2026-06-04T11:32:09.000Z",
    }, db);

    const { data, out } = await runInboxCommand(["inbox", "unread-count", "--by-address"]);

    expect(out).toContain("one@example.com");
    expect(out).toContain("two@example.com");
    expect(data).toEqual([
      { address: "one@example.com", unread: 2 },
      { address: "two@example.com", unread: 1 },
    ]);
  });

  it("unread-count by address paginates grouped results in SQL", async () => {
    const { db, providerId } = setupDb();
    const counts = new Map([
      ["alpha@example.com", 4],
      ["bravo@example.com", 3],
      ["charlie@example.com", 2],
      ["delta@example.com", 1],
    ]);
    for (const [address, count] of counts) {
      for (let i = 0; i < count; i++) {
        storeInboundEmail({
          provider_id: providerId,
          message_id: `unread-page-${address}-${i}`,
          in_reply_to_email_id: null,
          from_address: "sender@example.com",
          to_addresses: [i === 0 ? `"${address}" <${address}>` : address],
          cc_addresses: [],
          subject: `Unread page ${address} ${i}`,
          text_body: "body",
          html_body: null,
          attachments: [],
          attachment_paths: [],
          headers: {},
          raw_size: 100,
          received_at: `2026-06-04T11:${String(20 + i).padStart(2, "0")}:09.000Z`,
        }, db);
      }
    }

    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    let data: unknown;
    try {
      data = (await runInboxCommand(["inbox", "unread-count", "--by-address", "--limit", "2", "--offset", "1"])).data;
    } finally {
      db.query = originalQuery;
    }

    expect(data).toEqual([
      { address: "bravo@example.com", unread: 3 },
      { address: "charlie@example.com", unread: 2 },
    ]);
    const unreadQuery = queries.find((sql) => sql.includes("inbound_recipients") && sql.includes("COUNT(*) AS unread"));
    expect(unreadQuery).toBeTruthy();
    expect(unreadQuery ?? "").toContain("GROUP BY");
    expect(unreadQuery ?? "").toContain("LIMIT ? OFFSET ?");
  });

  it("realtime-status reports received inbox mail without synced SENT rows", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "received-status",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Received status",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "sent-status",
      in_reply_to_email_id: null,
      from_address: "me@example.com",
      to_addresses: ["client@example.com"],
      cc_addresses: [],
      subject: "Sent status",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      label_ids: ["SENT"],
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);

    const { data, out } = await runInboxCommand(["inbox", "realtime-status"]);

    expect(data).toMatchObject({
      total_inbound_emails: 1,
      unread_inbound_emails: 1,
      last_received_at: "2026-06-04T11:29:09.000Z",
    });
    expect(out).toContain("1 total, 1 unread");
    expect(out).toContain("2026-06-04T11:29:09.000Z");
    expect(out).not.toContain("2026-06-04T11:30:09.000Z");
  });

  it("mark-read returns a summary without body or header payloads", async () => {
    const { db, providerId } = setupDb();
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "mark-read-summary",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Mark read summary",
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      attachments: [],
      attachment_paths: [],
      headers: { "x-large": "header" },
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { data, out } = await runInboxCommand(["inbox", "mark-read", email.id]);
    const row = data as Record<string, unknown>;

    expect(out).toContain("Marked read");
    expect(row.id).toBe(email.id);
    expect(row.is_read).toBe(true);
    expect(row).not.toHaveProperty("text_body");
    expect(row).not.toHaveProperty("html_body");
    expect(row).not.toHaveProperty("headers");
    expect(getInboundEmail(email.id, db)?.is_read).toBe(true);
  });
});

describe("inbox attachment", () => {
  it("lists attachment paths by partial inbound id and filename", async () => {
    const { db, providerId } = setupDb();
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "attachment-row",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Has attachments",
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      attachments: [
        { filename: "invoice.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "notes.txt", content_type: "text/plain", size: 12 },
      ],
      attachment_paths: [
        { filename: "invoice.pdf", content_type: "application/pdf", size: 2048, local_path: "/tmp/invoice.pdf" },
        { filename: "notes.txt", content_type: "text/plain", size: 12, local_path: "/tmp/notes.txt" },
      ],
      headers: { "x-large": "header" },
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { data } = await runInboxCommand(["inbox", "attachment", email.id.slice(0, 8), "--filename", "invoice.pdf"]);

    expect(data).toEqual([
      { filename: "invoice.pdf", content_type: "application/pdf", size: 2048, local_path: "/tmp/invoice.pdf" },
    ]);
  });
});

// ─── inbox sync (via syncGmailInbox) ─────────────────────────────────────────

describe("inbox sync — syncGmailInbox", () => {
  it("defaults invalid sync limits before calling the Gmail connector", async () => {
    setupDb();

    await runInboxCommand(["inbox", "sync", "--limit", "not-a-number", "--concurrency", "not-a-number"]);

    const listCall = mockRun.mock.calls.find((call) => call[0]?.operation === "messages.list");
    expect(listCall?.[0]?.input).toMatchObject({ max: 50 });
  });

  it("caps oversized sync limits before calling the Gmail connector", async () => {
    setupDb();

    await runInboxCommand(["inbox", "sync", "--limit", "100000"]);

    const listCall = mockRun.mock.calls.find((call) => call[0]?.operation === "messages.list");
    expect(listCall?.[0]?.input).toMatchObject({ max: 1000 });
  });

  it("stores downloaded attachments as local_path when S3 storage is disabled", async () => {
    const { db, providerId } = setupDb();
    mkdirSync(TMP_HOME, { recursive: true });
    process.env["HOME"] = TMP_HOME;
    saveConfig({
      gmail_attachment_storage: "local",
    });
    mockListMsgs = [{ id: "gmail-att-1", subject: "Attachment Test", from: "a@test.com" }];

    const result = await syncGmailInbox({ providerId, db });

    expect(result.synced).toBe(1);
    expect(result.attachments_saved).toBe(1);
    expect(result.errors).toHaveLength(0);

    const stored = listInboundEmails({ provider_id: providerId }, db);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.attachment_paths).toEqual([
      {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size: 8,
        local_path: join(getDataDir(), "attachments", stored[0]!.id, "invoice.pdf"),
      },
    ]);
  });

  it("syncs messages and they appear in listInboundEmails", async () => {
    const { db, providerId } = setupDb();
    mockListMsgs = [{ id: "cli-msg1", subject: "CLI Test 1", from: "a@test.com" }, { id: "cli-msg2", subject: "CLI Test 2", from: "b@test.com" }];
    const result = await syncGmailInbox({ providerId, db });
    expect(result.synced).toBe(2);
    const stored = listInboundEmails({ provider_id: providerId });
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.subject).sort()).toEqual(["CLI Test 1", "CLI Test 2"]);
  });

  it("getInboundCount reflects synced messages", async () => {
    const { db, providerId } = setupDb();
    mockListMsgs = [{ id: "m1" }, { id: "m2" }];
    await syncGmailInbox({ providerId, db });
    expect(getInboundCount(providerId, db)).toBe(2);
  });

  it("getInboundEmail retrieves synced message by id", async () => {
    const { db, providerId } = setupDb();
    mockListMsgs = [{ id: "m1" }];
    await syncGmailInbox({ providerId, db });
    const emails = listInboundEmails({ provider_id: providerId }, db);
    const fetched = getInboundEmail(emails[0]!.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.message_id).toBe(emails[0]!.message_id);
  });

  it("clearInboundEmails removes synced messages", async () => {
    const { db, providerId } = setupDb();
    mockListMsgs = [{ id: "m1" }, { id: "m2" }];
    await syncGmailInbox({ providerId, db });
    expect(getInboundCount(providerId, db)).toBe(2);
    clearInboundEmails(providerId, db);
    expect(getInboundCount(providerId, db)).toBe(0);
  });
});

// ─── inbox status (getGmailSyncState / updateLastSynced) ─────────────────────

describe("inbox status — sync state tracking", () => {
  it("returns null state before any sync", () => {
    const { providerId } = setupDb();
    const state = getGmailSyncState(providerId);
    expect(state).toBeNull();
  });

  it("updateLastSynced sets last_synced_at", () => {
    const { db, providerId } = setupDb();
    const before = new Date().toISOString();
    updateLastSynced(providerId, "msg-xyz", db);
    const state = getGmailSyncState(providerId, db);
    expect(state).not.toBeNull();
    expect(new Date(state!.last_synced_at!).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(state!.last_message_id).toBe("msg-xyz");
  });

  it("setGmailSyncState updates existing state", () => {
    const { db, providerId } = setupDb();
    updateLastSynced(providerId, "first-msg", db);

    setGmailSyncState(providerId, { history_id: "12345" }, db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.history_id).toBe("12345");
    expect(state!.last_message_id).toBe("first-msg"); // preserved
  });

  it("clears next_page_token on updateLastSynced", () => {
    const { db, providerId } = setupDb();
    setGmailSyncState(providerId, { next_page_token: "tok123" }, db);
    updateLastSynced(providerId, undefined, db);
    const state = getGmailSyncState(providerId, db);
    expect(state!.next_page_token).toBeNull();
  });
});
