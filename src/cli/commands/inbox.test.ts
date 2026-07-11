/**
 * Tests for inbox CLI commands — tests the underlying DB/sync logic
 * exercised by `emails inbox` subcommands.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, resetDatabase, closeDatabase, uuid } from "../../db/database.js";
import { storeInboundEmail, listInboundEmails, getInboundEmail } from "../../db/inbound.js";
import { createAddress } from "../../db/addresses.js";
import { createDomain } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { setAddressProvisioning, setDomainProvisioning } from "../../db/provisioning.js";

const mockAutoPull = mock(async () => ({ pulled: 0, ok: true, configured: true }));
mock.module("../tui/autopull.js", () => ({ autoPull: mockAutoPull }));

const { registerInboxCommands } = await import("./inbox.js");
const { Command } = await import("commander");
const { getConfigValue } = await import("../../lib/config.js");

const TMP_HOME = join("/tmp", `emails-inbox-test-${process.pid}`);
const origHome = process.env["HOME"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'SES Test', 'ses', 1)`, [providerId]);
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

beforeEach(() => {
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
  mkdirSync(TMP_HOME, { recursive: true });
  process.env["HOME"] = TMP_HOME;
  mockAutoPull.mockReset();
  mockAutoPull.mockImplementation(async () => ({ pulled: 0, ok: true, configured: true }));
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  process.exitCode = 0;
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
    db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Other', 'ses', 1)`, [otherId]);
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
    mk("to-primary", ["el@example.com"]);
    mk("to-secondary", ["ap@example.net"]);
    mk("to-display", ['"Display Name" <display@example.com>']);

    // exact address
    expect(listInboundEmails({ recipients: ["el@example.com"] }, db).map((e) => e.subject)).toEqual(["to-primary"]);
    expect(listInboundEmails({ recipients: ["display@example.com"] }, db).map((e) => e.subject)).toEqual(["to-display"]);
    // bare domain (catch-all routing) — case-insensitive
    expect(listInboundEmails({ recipientDomains: ["EXAMPLE.COM"] }, db).map((e) => e.subject).sort()).toEqual(["to-display", "to-primary"]);
    expect(listInboundEmails({ recipientDomains: ["example.net"] }, db).map((e) => e.subject)).toEqual(["to-secondary"]);
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

  it("exposes source-aware mailbox status, listing, and search through the CLI", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "source-cli-provider",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "provider needle",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-02T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: null,
      message_id: "source-cli-legacy",
      in_reply_to_email_id: null,
      from_address: "legacy@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "legacy visible",
      text_body: "needle body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-03T10:00:00.000Z",
    }, db);

    const sources = await runInboxCommand(["inbox", "sources"]);
    expect((sources.data as Array<{ id: string; badges: string[] }>).find((source) => source.id === "legacy")?.badges).toContain("legacy");

    const mailboxes = await runInboxCommand(["inbox", "mailboxes", "--source", "legacy"]);
    expect((mailboxes.data as { counts: { inbox: number } }).counts.inbox).toBe(1);

    const legacyList = await runInboxCommand(["inbox", "list", "--source", "legacy"]);
    expect((legacyList.data as Array<{ subject: string }>).map((email) => email.subject)).toEqual(["legacy visible"]);

    const providerSearch = await runInboxCommand(["inbox", "search", "needle", "--source", `provider:${providerId}`]);
    expect((providerSearch.data as Array<{ subject: string }>).map((email) => email.subject)).toEqual(["provider needle"]);
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
    expect(recipient.configured_addresses[0]?.provider_name).toBe("SES Test");
    expect(recipient.configured_addresses[0]?.provisioning?.domain_id).toBe(targetDomain.id);
    expect(recipient.domains.map((domain) => domain.id)).toEqual([targetDomain.id]);
    expect(recipient.domains[0]?.provider_name).toBe("SES Test");
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

describe("inbox links", () => {
  it("extracts links from an inbound email via inbox subcommand and top-level alias", async () => {
    const { db, providerId } = setupDb();
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "links-msg",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Links please",
      text_body: "Plain link https://plain.example/path.",
      html_body: `<p>Open <a href="https://Example.com/docs?x=1&amp;y=2">Docs</a></p>`,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-16T10:00:00.000Z",
    }, db);

    const viaInbox = await runInboxCommand(["inbox", "links", email.id.slice(0, 8)]);
    expect(viaInbox.out).toContain("Links for");
    expect(viaInbox.out).toContain("https://Example.com/docs?x=1&y=2");
    expect(viaInbox.out).toContain("https://plain.example/path");
    expect(viaInbox.out).toContain("text: Docs");
    expect((viaInbox.data as { links: unknown[] }).links).toHaveLength(2);

    const viaAlias = await runInboxCommand(["links", email.id]);
    expect((viaAlias.data as { links: Array<{ normalized_url: string }> }).links.map((link) => link.normalized_url)).toEqual([
      "https://example.com/docs?x=1&y=2",
      "https://plain.example/path",
    ]);
  });

  it("keeps mailto links out unless --all is passed", async () => {
    const { db, providerId } = setupDb();
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "mailto-msg",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Mailto",
      text_body: "mailto:ops@example.com and https://example.com",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-16T10:00:00.000Z",
    }, db);

    const normal = await runInboxCommand(["inbox", "links", email.id]);
    expect((normal.data as { links: Array<{ normalized_url: string }> }).links.map((link) => link.normalized_url)).toEqual(["https://example.com/"]);

    const all = await runInboxCommand(["inbox", "links", email.id, "--all"]);
    expect((all.data as { links: Array<{ normalized_url: string }> }).links.map((link) => link.normalized_url)).toEqual([
      "mailto:ops@example.com",
      "https://example.com/",
    ]);
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

    // Search routes through the seam (subject/from/snippet scope), so match on the
    // subject term; the filter must still run before the result limit is applied.
    const { data } = await runInboxCommand(["inbox", "search", "match", "--limit", "1"]);

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
});

describe("inbox source lifecycle", () => {
	  it("lists and retires S3 sources without deleting local mail", async () => {
    const { db, providerId } = setupDb();
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "source-retire-local",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Source lifecycle local",
      text_body: "still here",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

	    await runInboxCommand(["inbox", "source", "add-s3", "--bucket", "mail-bucket", "--prefix", "inbound/example.com/", "--provider", providerId]);
	    expect(getConfigValue("inbound_s3_buckets")).toEqual([{ bucket: "mail-bucket", region: "us-east-1", providerId }]);
	    const before = await runInboxCommand(["inbox", "source", "list"]);
    expect((before.data as Array<{ type: string; status: string }>).map((source) => `${source.type}:${source.status}`).sort()).toEqual([
      "s3:live",
    ]);

    const s3Source = (before.data as Array<{ id: string; type: string }>).find((source) => source.type === "s3")!;
    await runInboxCommand(["inbox", "source", "retire", s3Source.id]);
    const after = await runInboxCommand(["inbox", "source", "list"]);
    const s3 = (after.data as Array<{ type: string; status: string; live_sync_enabled: boolean }>).find((source) => source.type === "s3")!;

	    expect(s3).toMatchObject({ status: "retired", live_sync_enabled: false });
	    expect(getInboundEmail(email.id, db)?.subject).toBe("Source lifecycle local");
	  });

  it("does not add disabled S3 sources to the refresh bucket list", async () => {
    const { providerId } = setupDb();

    await runInboxCommand([
      "inbox", "source", "add-s3",
      "--bucket", "disabled-bucket",
      "--prefix", "inbound/example.com/",
      "--provider", providerId,
      "--no-live-sync",
    ]);

    expect(getConfigValue("inbound_s3_buckets")).toBeUndefined();
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

describe("inbox read", () => {
  it("renders markdown-ish bodies as readable text", async () => {
    const { db, providerId } = setupDb();
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "read-rendered",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Rendered body",
      text_body: "# Heading\n\n- **hello**\n- [docs](https://example.com/start)",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { out } = await runInboxCommand(["inbox", "read", email.id, "--keep-unread"]);

    expect(out).toContain("Heading");
    expect(out).toContain("- hello");
    expect(out).toContain("docs (https://example.com/start)");
    expect(out).not.toContain("**hello**");
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

    const { data, out } = await runInboxCommand(["inbox", "attachment", email.id.slice(0, 8), "--filename", "invoice.pdf"]);

    expect(data).toEqual([
      {
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size: 2048,
        location: "/tmp/invoice.pdf",
        location_type: "local",
        file_url: "file:///tmp/invoice.pdf",
        openable: true,
      },
    ]);
    expect(out).toContain("2 KB");
    expect(out).toContain("file:///tmp/invoice.pdf");
  });
});
