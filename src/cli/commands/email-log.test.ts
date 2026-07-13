import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createEmail } from "../../db/emails.js";
import { storeEmailContent } from "../../db/email-content.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { createProvider } from "../../db/providers.js";
import { createAddress, markVerified } from "../../db/addresses.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";
import { setConfigValue } from "../../lib/config.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";
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

async function runEmailLogCommandExpectingExit(args: string[]): Promise<string> {
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exit;
  const errorSpy = mock((msg: unknown) => {
    errors.push(String(msg));
  });
  const exitSpy = mock((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  });
  (console as unknown as { error: typeof errorSpy }).error = errorSpy;
  (process as unknown as { exit: typeof exitSpy }).exit = exitSpy;
  try {
    await expect(runEmailLogCommand(args)).rejects.toThrow("exit:1");
  } finally {
    (console as unknown as { error: typeof originalError }).error = originalError;
    (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  }
  return errors.join("\n");
}

async function withTempHome<T>(prefix: string, fn: (tmpHome: string) => Promise<T>): Promise<T> {
  const originalHome = process.env["HOME"];
  const tmpHome = mkdtempSync(join(tmpdir(), prefix));
  process.env["HOME"] = tmpHome;
  try {
    return await fn(tmpHome);
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

type SelfHostedRow = {
  id: string;
  direction: "inbound" | "outbound";
  from_addr: string;
  to_addrs: string[];
  cc_addrs?: string[];
  subject: string;
  body_text?: string | null;
  body_html?: string | null;
  received_at: string;
  is_read?: boolean;
  is_starred?: boolean;
  labels?: string[];
  attachments?: Array<{ filename: string; content_type: string; size: number }>;
};

const originalFetch = globalThis.fetch;
const MODE_ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;
let originalModeEnv: Partial<Record<typeof MODE_ENV_KEYS[number], string>> = {};

function enableSelfHostedMode(rows: SelfHostedRow[]): { requests: string[] } {
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "https://emails.example.test";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-api-key";
  resetSelfHostedConfigCache();
  resetMailDataSource();
  const requests: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push(`${method} ${target.pathname}${target.search}`);
    if (init?.headers && (init.headers as Record<string, string>)["Authorization"] !== "Bearer test-api-key") {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    if (method === "GET" && target.pathname === "/v1/messages") {
      let filtered = [...rows].sort((a, b) => b.received_at.localeCompare(a.received_at));
      const direction = target.searchParams.get("direction");
      if (direction) filtered = filtered.filter((row) => row.direction === direction);
      const search = target.searchParams.get("search")?.toLowerCase();
      if (search) {
        filtered = filtered.filter((row) =>
          [row.from_addr, row.to_addrs.join(" "), row.subject, row.body_text ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(search),
        );
      }
      const since = target.searchParams.get("since");
      if (since) filtered = filtered.filter((row) => Date.parse(row.received_at) >= Date.parse(since));
      const limit = Number(target.searchParams.get("limit") ?? "500");
      const offset = Number(target.searchParams.get("offset") ?? "0");
      return new Response(JSON.stringify({ messages: filtered.slice(offset, offset + limit) }), { status: 200 });
    }
    const messageMatch = target.pathname.match(/^\/v1\/messages\/([^/]+)$/);
    if (method === "GET" && messageMatch) {
      const id = decodeURIComponent(messageMatch[1]!);
      const row = rows.find((candidate) => candidate.id === id);
      return row
        ? new Response(JSON.stringify({ message: row }), { status: 200 })
        : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;
  return { requests };
}

beforeEach(() => {
  originalModeEnv = {};
  for (const key of MODE_ENV_KEYS) {
    originalModeEnv[key] = process.env[key];
    delete process.env[key];
  }
  setupDb();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  for (const key of MODE_ENV_KEYS) {
    const value = originalModeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  resetSelfHostedConfigCache();
  resetMailDataSource();
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

  it("routes self_hosted sent lists through the API and ignores local sent rows", async () => {
    const { requests } = enableSelfHostedMode([
      {
        id: "srv-out-1",
        direction: "outbound",
        from_addr: "server@example.com",
        to_addrs: ["remote@example.com"],
        subject: "Server sent subject",
        body_text: "server body must not appear in list JSON",
        received_at: "2026-01-02T00:00:00.000Z",
        is_read: true,
      },
    ]);

    const { data, formatted } = await runEmailLogCommand(["email", "list"]);
    const rows = data as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "srv-out-1", subject: "Server sent subject" });
    expect(JSON.stringify(rows)).not.toContain("server body");
    expect(JSON.stringify(rows)).not.toContain("Original subject");
    expect(formatted).toContain("Self-hosted sent mail");
    expect(requests.some((request) => request.startsWith("GET /v1/messages?"))).toBe(true);
    expect(requests.join("\n")).toContain("direction=outbound");
  });

  it("routes top-level self_hosted search through the API instead of local sent search", async () => {
    const { requests } = enableSelfHostedMode([
      {
        id: "srv-out-2",
        direction: "outbound",
        from_addr: "server@example.com",
        to_addrs: ["remote@example.com"],
        subject: "Server searchable subject",
        received_at: "2026-01-03T00:00:00.000Z",
        is_read: true,
      },
    ]);

    const { data } = await runEmailLogCommand(["search", "Original"]);

    expect(data).toEqual([]);
    expect(requests.join("\n")).toContain("direction=outbound");
    expect(requests.join("\n")).toContain("search=Original");
  });

  it("fails closed for unsupported local sent-log filters in self_hosted mode", async () => {
    enableSelfHostedMode([]);
    const errors = await runEmailLogCommandExpectingExit(["log", "--provider", "local-provider"]);

    expect(errors).toContain("does not support local sent-log filter(s): --provider");
  });

  it("fails closed on legacy storage_mode config before reading the local sent log", async () => {
    await withTempHome("emails-log-legacy-mode-", async () => {
      setConfigValue("storage_mode", "remote");

      const errors = await runEmailLogCommandExpectingExit(["log"]);

      expect(errors).toContain("config key 'storage_mode' value 'remote'");
      expect(errors).toContain("removed hosted/legacy runtime");
    });
  });

  it("fails closed on legacy storage_mode config before local export", async () => {
    await withTempHome("emails-export-legacy-mode-", async () => {
      setConfigValue("storage_mode", "remote");

      const errors = await runEmailLogCommandExpectingExit(["export", "emails"]);

      expect(errors).toContain("config key 'storage_mode' value 'remote'");
      expect(errors).toContain("removed hosted/legacy runtime");
    });
  });
});

describe("self_hosted local-only command guards", () => {
  it("fails test/export/webhook commands before opening the default local store", async () => {
    await withTempHome("emails-self-hosted-local-only-", async (tmpHome) => {
      closeDatabase();
      resetDatabase();
      delete process.env["EMAILS_DB_PATH"];
      const { requests } = enableSelfHostedMode([]);

      for (const { args, command, detail } of [
        { args: ["test"], command: "emails test", detail: "Use `emails send" },
        { args: ["export", "emails"], command: "emails export", detail: "server-side export/reporting" },
        { args: ["export", "events"], command: "emails export", detail: "server-side export/reporting" },
        { args: ["webhook", "listen", "--port", "19877"], command: "emails webhook listen", detail: "self-hosted server" },
      ]) {
        const errors = await runEmailLogCommandExpectingExit(args);
        expect(errors).toContain(command);
        expect(errors).toContain("self_hosted API-only mode");
        expect(errors).toContain(detail);
        expect(existsSync(join(tmpHome, ".hasna"))).toBe(false);
      }

      expect(requests).toEqual([]);
    });
  });
});

describe("email show command", () => {
  it("renders stored HTML as readable text", async () => {
    const db = getDatabase();
    const sent = db.query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    storeEmailContent(sent.id, { html: "<p>Hello <strong>there</strong> &amp; welcome</p>" }, db);

    const { consoleOutput } = await runEmailLogCommand(["show", sent.id]);

    expect(consoleOutput).toContain("Hello there & welcome");
    expect(consoleOutput).not.toContain("<strong>");
  });

  it("routes self_hosted show through the API and does not read local sent content", async () => {
    const db = getDatabase();
    const sent = db.query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    storeEmailContent(sent.id, { text: "local body must not appear" }, db);
    const { requests } = enableSelfHostedMode([
      {
        id: "srv-show-1",
        direction: "outbound",
        from_addr: "server@example.com",
        to_addrs: ["remote@example.com"],
        cc_addrs: [],
        subject: "Server show subject",
        body_text: "server show body",
        received_at: "2026-01-04T00:00:00.000Z",
        is_read: true,
      },
    ]);

    const { data, formatted } = await runEmailLogCommand(["email", "show", "srv-show-1"]);
    const shown = data as Record<string, unknown>;

    expect(shown).toMatchObject({ id: "srv-show-1", subject: "Server show subject" });
    expect(formatted).toContain("server show body");
    expect(formatted).not.toContain("local body must not appear");
    expect(requests.join("\n")).toContain("GET /v1/messages?limit=500&offset=0");
    expect(requests.join("\n")).toContain("GET /v1/messages/srv-show-1");
  });

  it("fails self_hosted show against a local-only id instead of falling back to SQLite", async () => {
    const sent = getDatabase().query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    enableSelfHostedMode([]);
    const errors = await runEmailLogCommandExpectingExit(["show", sent.id]);

    expect(errors).toContain(`Email not found: ${sent.id}`);
  });
});

describe("email log reply commands", () => {
  it("fails local-only reply lookup in self_hosted mode before reading local replies", async () => {
    const sent = getDatabase().query("SELECT id FROM emails LIMIT 1").get() as { id: string };
    enableSelfHostedMode([]);
    const errors = await runEmailLogCommandExpectingExit(["replies", sent.id]);

    expect(errors).toContain("local sent-log-only");
    expect(errors).toContain("self_hosted API-only mode");
  });

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
