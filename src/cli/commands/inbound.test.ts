import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase, uuid } from "../../db/database.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { registerInboundCommands } from "./inbound.js";

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const providerId = uuid();
  db.run(`INSERT INTO providers (id, name, type, active) VALUES (?, 'Sandbox Test', 'sandbox', 1)`, [providerId]);
  return { db, providerId };
}

async function runInboundCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerInboundCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeEach(() => {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("inbound count command", () => {
  it("counts received mail without imported SENT rows", async () => {
    const { db, providerId } = setupDb();
    storeInboundEmail({
      provider_id: providerId,
      message_id: "received-inbound-count",
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Received",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);
    storeInboundEmail({
      provider_id: providerId,
      message_id: "sent-inbound-count",
      from_address: "me@example.com",
      to_addresses: ["client@example.com"],
      cc_addresses: [],
      subject: "Sent",
      text_body: "body",
      html_body: null,
      attachments: [],
      label_ids: ["SENT"],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    }, db);

    const { data, out } = await runInboundCommand(["inbound", "count"]);

    expect(data).toEqual({ count: 1 });
    expect(out).toContain("1 inbound email(s) received");
  });
});

describe("inbound show command", () => {
  it("renders HTML bodies as readable text", async () => {
    const { db, providerId } = setupDb();
    const email = storeInboundEmail({
      provider_id: providerId,
      message_id: "html-inbound-show",
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "HTML inbound",
      text_body: null,
      html_body: '<p>Hello <strong>there</strong> &amp; welcome</p><p><a href="https://example.com">docs</a></p>',
      attachments: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    }, db);

    const { out } = await runInboundCommand(["inbound", "show", email.id]);

    expect(out).toContain("Hello there & welcome");
    expect(out).toContain("docs (https://example.com)");
    expect(out).not.toContain("<strong>");
    expect(out).not.toContain("&amp;");
  });
});

describe("inbound list command", () => {
  it("falls back to the default page size for invalid limits", async () => {
    const { db, providerId } = setupDb();
    for (const messageId of ["first-invalid-limit", "second-invalid-limit"]) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: messageId,
        from_address: "sender@example.com",
        to_addresses: ["me@example.com"],
        cc_addresses: [],
        subject: messageId,
        text_body: "body",
        html_body: null,
        attachments: [],
        headers: {},
        raw_size: 100,
        received_at: "2026-06-04T11:29:09.000Z",
      }, db);
    }

    const { data, out } = await runInboundCommand(["inbound", "list", "--limit", "-1"]);

    expect(data).toHaveLength(2);
    expect(out).toContain("first-invalid-limit");
    expect(out).toContain("second-invalid-limit");
  });

  it("paginates inbound summaries with offset", async () => {
    const { db, providerId } = setupDb();
    for (let i = 1; i <= 4; i++) {
      storeInboundEmail({
        provider_id: providerId,
        message_id: `offset-page-${i}`,
        from_address: "sender@example.com",
        to_addresses: ["me@example.com"],
        cc_addresses: [],
        subject: `Offset page ${i}`,
        text_body: `body ${i}`,
        html_body: `<p>body ${i}</p>`,
        attachments: [],
        headers: { "x-page": String(i) },
        raw_size: 100,
        received_at: `2026-06-04T11:0${i}:00.000Z`,
      }, db);
    }

    const { data, out } = await runInboundCommand(["inbound", "list", "--limit", "2", "--offset", "1"]);
    const emails = data as Array<Record<string, unknown>>;

    expect(emails.map((email) => email.subject)).toEqual([
      "Offset page 3",
      "Offset page 2",
    ]);
    expect(emails[0]).not.toHaveProperty("text_body");
    expect(emails[0]).not.toHaveProperty("html_body");
    expect(emails[0]).not.toHaveProperty("headers");
    expect(out).toContain("Offset page 3");
    expect(out).toContain("Offset page 2");
    expect(out).not.toContain("Offset page 4");
    expect(out).not.toContain("Offset page 1");
  });
});
