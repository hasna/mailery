import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createEmail } from "../../db/emails.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { createProvider } from "../../db/providers.js";
import { createAddress, markVerified } from "../../db/addresses.js";
import { setConfigValue } from "../../lib/config.js";
import { registerEmailLogCommands } from "./email-log.js";

function setupDb() {
  resetDatabase();
  process.env["EMAILS_DB_PATH"] = ":memory:";
  const db = getDatabase();
  const provider = createProvider({ name: "sandbox", type: "sandbox" }, db);
  const sent = createEmail(provider.id, {
    from: "agent@example.com",
    to: "person@example.com",
    subject: "Original subject",
    text: "Original body",
  }, "provider-message-id", db);
  return { db, provider, sent };
}

function seedReply(emailId: string, index: number) {
  return storeInboundEmail({
    provider_id: null,
    message_id: `<reply-${index}@example.com>`,
    in_reply_to_email_id: emailId,
    from_address: `reply${index}@example.com`,
    to_addresses: ["agent@example.com"],
    cc_addresses: [],
    subject: `Reply ${index}`,
    text_body: `Large reply body ${index} `.repeat(200),
    html_body: `<p>${"Large HTML ".repeat(100)}</p>`,
    attachments: [],
    attachment_paths: [],
    headers: { "x-test": `reply-${index}` },
    raw_size: 1024 + index,
    received_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }, getDatabase());
}

async function runEmailLogCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  let formatted = "";
  const consoleLines: string[] = [];
  const originalLog = console.log;
  registerEmailLogCommands(program, (payload, text) => {
    data = payload;
    formatted = text;
  });
  console.log = (...values: unknown[]) => {
    consoleLines.push(values.map(String).join(" "));
  };
  try {
    await program.parseAsync(["node", "emails", ...args]);
  } finally {
    console.log = originalLog;
  }
  return { data, formatted, consoleOutput: consoleLines.join("\n") };
}

beforeEach(() => {
  setupDb();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("email log list and search commands", () => {
  it("paginates sent-email lists with offset and omits idempotency keys", async () => {
    const db = getDatabase();
    const provider = db.query("SELECT id FROM providers LIMIT 1").get() as { id: string };
    db.run("UPDATE emails SET sent_at = ?, created_at = ?, updated_at = ?", [
      new Date(Date.UTC(2025, 0, 1)).toISOString(),
      new Date(Date.UTC(2025, 0, 1)).toISOString(),
      new Date(Date.UTC(2025, 0, 1)).toISOString(),
    ]);
    for (let i = 0; i < 3; i++) {
      const email = createEmail(provider.id, {
        from: "agent@example.com",
        to: `person${i}@example.com`,
        subject: `Paged sent ${i}`,
        text: "body",
        idempotency_key: `list-secret-${i}`,
      }, undefined, db);
      db.run("UPDATE emails SET sent_at = ?, created_at = ?, updated_at = ? WHERE id = ?", [
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        email.id,
      ]);
    }

    const { data } = await runEmailLogCommand(["email", "list", "--limit", "2", "--offset", "1"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Paged sent 1", "Paged sent 0"]);
    expect(rows[0]).not.toHaveProperty("idempotency_key");
    expect(JSON.stringify(rows)).not.toContain("list-secret");
  });

  it("paginates sent-email search after filtering and omits idempotency keys", async () => {
    const db = getDatabase();
    const provider = db.query("SELECT id FROM providers LIMIT 1").get() as { id: string };
    for (let i = 0; i < 4; i++) {
      const email = createEmail(provider.id, {
        from: "agent@example.com",
        to: `search${i}@example.com`,
        subject: `Searchable sent ${i}`,
        text: "body",
        idempotency_key: `search-secret-${i}`,
      }, undefined, db);
      db.run("UPDATE emails SET sent_at = ?, created_at = ?, updated_at = ? WHERE id = ?", [
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        email.id,
      ]);
    }

    const { data } = await runEmailLogCommand(["search", "Searchable", "--limit", "2", "--offset", "1"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.subject)).toEqual(["Searchable sent 2", "Searchable sent 1"]);
    expect(rows[0]).not.toHaveProperty("idempotency_key");
    expect(JSON.stringify(rows)).not.toContain("search-secret");
  });
});

describe("email log reply commands", () => {
  it("returns bounded summary replies without body or header payloads", async () => {
    const sent = getDatabase().query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    seedReply(sent.id, 0);
    seedReply(sent.id, 1);
    seedReply(sent.id, 2);

    const { data, formatted } = await runEmailLogCommand(["email", "replies", sent.id, "--limit", "1", "--offset", "1"]);
    const result = data as {
      replies: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    };

    expect(result.total).toBe(3);
    expect(result.limit).toBe(1);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.subject).toBe("Reply 1");
    expect(result.replies[0]).not.toHaveProperty("text_body");
    expect(result.replies[0]).not.toHaveProperty("html_body");
    expect(result.replies[0]).not.toHaveProperty("headers");
    expect(formatted).toContain("1 of 3 replies");
    expect(formatted).toContain("more available");
  });

  it("keeps conversation body rendering paginated", async () => {
    const sent = getDatabase().query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    seedReply(sent.id, 0);
    seedReply(sent.id, 1);

    const { data } = await runEmailLogCommand(["conversation", sent.id, "--limit", "1"]);
    const result = data as {
      replies: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    };

    expect(result.total).toBe(2);
    expect(result.limit).toBe(1);
    expect(result.offset).toBe(0);
    expect(result.has_more).toBe(true);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.text_body).toContain("Large reply body 0");
  });

  it("shows sent-email thread fallback when no thread metadata exists", async () => {
    const sent = getDatabase().query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    seedReply(sent.id, 0);

    const { data, consoleOutput } = await runEmailLogCommand(["email", "thread", sent.id]);
    const result = data as {
      email: Record<string, unknown>;
      replies: Array<Record<string, unknown>>;
      total: number;
    };

    expect(result.email.id).toBe(sent.id);
    expect(result.total).toBe(1);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.subject).toBe("Reply 0");
    expect(consoleOutput).toContain("Thread (2 messages)");
  });
});

describe("email test command", () => {
  it("reports ambiguous configured default provider prefixes", async () => {
    const db = getDatabase();
    const originalHome = process.env["HOME"];
    const tmpHome = mkdtempSync(join(tmpdir(), "emails-log-config-"));
    const originalError = console.error;
    const originalExit = process.exit;
    const errors: string[] = [];
    const errorSpy = mock((msg: unknown) => {
      errors.push(String(msg));
    });
    const exitSpy = mock((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    process.env["HOME"] = tmpHome;
    db.run(
      "INSERT INTO providers (id, name, type, active, created_at, updated_at) VALUES (?, ?, 'sandbox', 1, datetime('now'), datetime('now'))",
      ["abc11111-1111-1111-1111-111111111111", "ambiguous-1"],
    );
    db.run(
      "INSERT INTO providers (id, name, type, active, created_at, updated_at) VALUES (?, ?, 'sandbox', 1, datetime('now'), datetime('now'))",
      ["abc22222-2222-2222-2222-222222222222", "ambiguous-2"],
    );
    setConfigValue("default_provider", "abc");
    (console as unknown as { error: typeof errorSpy }).error = errorSpy;
    (process as unknown as { exit: typeof exitSpy }).exit = exitSpy;

    try {
      await expect(runEmailLogCommand(["test"])).rejects.toThrow("exit:1");
      expect(errors.join("\n")).toContain("Ambiguous ID 'abc' in table 'providers'");
    } finally {
      (console as unknown as { error: typeof originalError }).error = originalError;
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("chooses a default provider address without loading every address twice", async () => {
    const db = getDatabase();
    const provider = db.query("SELECT id FROM providers LIMIT 1").get() as { id: string };
    for (let i = 0; i < 120; i++) {
      createAddress({ provider_id: provider.id, email: `filler-${String(i).padStart(3, "0")}@example.com` }, db);
    }
    const preferred = createAddress({ provider_id: provider.id, email: "preferred@example.com" }, db);
    markVerified(preferred.id, db);

    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      const result = await runEmailLogCommand(["test", provider.id]);

      expect(result.consoleOutput).toContain("Test email sent to preferred@example.com");
      expect(result.consoleOutput).toContain("From: preferred@example.com");
    } finally {
      db.query = originalQuery;
    }

    expect(queries.some((sql) => sql.includes("ORDER BY verified DESC, created_at DESC"))).toBe(true);
    expect(queries.some((sql) => sql.includes("FROM addresses WHERE provider_id = ? ORDER BY created_at DESC"))).toBe(false);
  });
});
