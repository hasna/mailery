import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "../../db/database.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { getConfigValue } from "../../lib/config.js";
import { redactSecrets } from "../../lib/redaction.js";
import { registerCloudCommands } from "./cloud.js";

let originalHome: string | undefined;
let originalDbPath: string | undefined;
let tmpHome: string;

function makeProgram(logs: string[], data: { value?: unknown }, deps: Parameters<typeof registerCloudCommands>[2]) {
  const program = new Command();
  program.exitOverride();
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  registerCloudCommands(program, (payload, formatted) => {
    data.value = payload;
    if (formatted) logs.push(String(formatted));
  }, deps);
  return program;
}

async function runCloudCommand(args: string[], deps: Parameters<typeof registerCloudCommands>[2]) {
  const logs: string[] = [];
  const data: { value?: unknown } = {};
  const originalLog = console.log;
  try {
    const program = makeProgram(logs, data, deps);
    await program.parseAsync(["node", "mailery", ...args]);
    return { out: logs.join("\n"), data: data.value };
  } finally {
    console.log = originalLog;
  }
}

beforeEach(() => {
  originalHome = process.env["HOME"];
  originalDbPath = process.env["EMAILS_DB_PATH"];
  tmpHome = mkdtempSync(join(tmpdir(), "mailery-cloud-command-"));
  process.env["HOME"] = tmpHome;
  process.env["EMAILS_DB_PATH"] = join(tmpHome, "mailery.db");
  closeDatabase();
});

afterEach(() => {
  closeDatabase();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalDbPath === undefined) delete process.env["EMAILS_DB_PATH"];
  else process.env["EMAILS_DB_PATH"] = originalDbPath;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("cloud command", () => {
  it("logs in with an API key without printing it", async () => {
    const result = await runCloudCommand([
      "cloud",
      "--api-url",
      "https://mailery.test",
      "login",
      "--api-key",
      "mly_secret_test",
    ], {
      createClient: (opts) => ({
        me: async () => ({
          user: null,
          tenant: { id: "ten_1", name: "Test Tenant", slug: "test", plan: "starter", stripeCustomerId: null, createdAt: "", updatedAt: "" },
          auth: { via: "api_key", scopes: ["full"] },
        }),
        health: async () => ({ version: "x", service: "mailery-cloud" }),
        signup: async () => ({ token: "" }),
        login: async () => ({ token: "" }),
        logout: async () => ({ ok: true }),
        billingOverview: async () => ({ balance: 0, plans: {}, credit_packs: {}, subscriptions: [], ledger: [] }),
        createCheckout: async () => ({ url: "" }),
        createPortal: async () => ({ url: "" }),
        listMailboxes: async () => [],
        createMailbox: async () => { throw new Error("unused"); },
        messageGroups: async () => ({}),
        listMessages: async () => [],
        createMessage: async () => { throw new Error("unused"); },
        getMessage: async () => { throw new Error("unused"); },
        parseMessage: async () => ({}),
        listDigests: async () => [],
        generateDigest: async () => { throw new Error("unused"); },
        listApiKeys: async () => [],
        createApiKey: async () => { throw new Error("unused"); },
        revokeApiKey: async () => ({ ok: true }),
        checkDomainAvailability: async () => { throw new Error("unused"); },
        setupDomain: async () => { throw new Error("unused"); },
        getApiUrl: () => opts.apiUrl ?? "",
        setToken: () => {},
        request: async () => ({} as never),
      }),
    });

    expect(result.out).toContain("Test Tenant");
    expect(result.out).not.toContain("mly_secret_test");
    expect(getConfigValue("cloud_api_url")).toBe("https://mailery.test");
    expect(getConfigValue("cloud_api_key")).toBe("mly_secret_test");
  });

  it("does not emit password-login session tokens in command payloads", async () => {
    const result = await runCloudCommand(["cloud", "login", "--email", "agent@example.com", "--password", "pw"], {
      createClient: () => ({
        login: async () => ({ token: "session_secret_value" }),
        me: async () => ({
          user: { id: "usr_1", email: "agent@example.com", name: null, tenantId: "ten_1", role: "owner", isPlatformAdmin: false },
          tenant: { id: "ten_1", name: "Agent Tenant", slug: "agent", plan: "starter", stripeCustomerId: null, createdAt: "", updatedAt: "" },
          auth: { via: "session", scopes: ["full"] },
        }),
      } as never),
    });

    expect(JSON.stringify(result.data)).not.toContain("session_secret_value");
    expect(result.out).not.toContain("session_secret_value");
    expect(getConfigValue("cloud_session_token")).toBe("session_secret_value");
  });

  it("bootstraps agent setup with signup, API key creation, and billing link", async () => {
    const calls: unknown[] = [];
    const result = await runCloudCommand([
      "cloud",
      "setup",
      "--email",
      "agent@example.com",
      "--password",
      "pw",
      "--name",
      "Agent",
      "--api-key-name",
      "Agent CLI",
      "--scope",
      "mail_read",
      "mail_write",
      "--billing",
      "--no-open",
    ], {
      createClient: () => ({
        signup: async (input) => {
          calls.push({ signup: input });
          return { token: "session_secret_value" };
        },
        me: async () => ({
          user: { id: "usr_1", email: "agent@example.com", name: "Agent", tenantId: "ten_1", role: "owner", isPlatformAdmin: false },
          tenant: { id: "ten_1", name: "Agent Tenant", slug: "agent", plan: "starter", stripeCustomerId: null, createdAt: "", updatedAt: "" },
          auth: { via: "session", scopes: ["full"] },
        }),
        createApiKey: async (input) => {
          calls.push({ createApiKey: input });
          return {
            key: "mly_secret_once",
            api_key: {
              id: "key_1",
              name: "Agent CLI",
              prefix: "mly_live_abcd",
              scopes: ["mail_read", "mail_write"],
              lastUsedAt: null,
              revokedAt: null,
              createdAt: "2026-06-30T10:00:00.000Z",
            },
          };
        },
        createCheckout: async (input) => {
          calls.push({ createCheckout: input });
          return { url: "https://checkout.stripe.test/session" };
        },
      } as never),
    });

    expect(calls).toEqual([
      { signup: { email: "agent@example.com", password: "pw", name: "Agent" } },
      { createCheckout: { kind: "subscription", plan: "starter" } },
      { createApiKey: { name: "Agent CLI", scopes: ["mail_read", "mail_write"] } },
    ]);
    const redacted = redactSecrets(result.data);
    expect(result.out).toContain("Mailery Cloud setup complete");
    expect(result.out).toContain("mly_secret_once");
    expect(result.out).toContain("https://checkout.stripe.test/session");
    expect(result.out).not.toContain("session_secret_value");
    expect(JSON.stringify(result.data)).not.toContain("session_secret_value");
    expect(JSON.stringify(redacted)).toContain("mly_secret_once");
    expect((result.data as { agent_auth?: { key?: string } }).agent_auth?.key).toBe("mly_secret_once");
    expect(getConfigValue("cloud_session_token")).toBe("session_secret_value");
  });

  it("uses configured cloud_api_url when --api-url is omitted", async () => {
    await runCloudCommand(["cloud", "use", "https://staging.mailery.test"], {});
    let seenApiUrl = "";
    const result = await runCloudCommand(["cloud", "status"], {
      createClient: (opts) => {
        seenApiUrl = opts.apiUrl ?? "";
        return {
          health: async () => ({ version: "1", service: "mailery-cloud" }),
        } as never;
      },
    });

    expect(seenApiUrl).toBe("https://staging.mailery.test");
    expect(result.out).toContain("https://staging.mailery.test");
  });

  it("creates a subscription checkout link and can suppress browser opening", async () => {
    const result = await runCloudCommand(["cloud", "billing", "subscribe", "--plan", "starter", "--no-open"], {
      createClient: () => ({
        createCheckout: async (input) => {
          expect(input).toEqual({ kind: "subscription", plan: "starter" });
          return { url: "https://checkout.stripe.test/session" };
        },
      } as never),
    });

    expect(result.out).toContain("https://checkout.stripe.test/session");
    expect(result.out).toContain("Browser open disabled");
  });

  it("lists API keys without printing secret material", async () => {
    const result = await runCloudCommand(["cloud", "api-keys", "list"], {
      createClient: () => ({
        listApiKeys: async () => [{
          id: "key_123456789",
          name: "Agent CLI",
          prefix: "mly_live_abcd",
          scopes: ["mail_read", "mail_write"],
          lastUsedAt: null,
          revokedAt: null,
          createdAt: "2026-06-30T10:00:00.000Z",
          key: "mly_secret_list_leak",
        } as never],
      } as never),
    });

    expect(result.out).toContain("Agent CLI");
    expect(result.out).toContain("mly_live_abcd");
    expect(result.out).not.toContain("secret");
    expect(JSON.stringify(result.data)).not.toContain("mly_secret_list_leak");
  });

  it("does not open billing links by default in non-TTY command runs", async () => {
    let opened = 0;
    const result = await runCloudCommand(["cloud", "billing", "subscribe"], {
      createClient: () => ({
        createCheckout: async () => ({ url: "https://checkout.stripe.test/session" }),
      } as never),
      openUrl: () => {
        opened += 1;
        return { ok: true, method: "test" };
      },
    });

    expect(opened).toBe(0);
    expect(result.out).toContain("Browser open disabled");
  });

  it("creates an API key and prints the generated secret once", async () => {
    const result = await runCloudCommand(["cloud", "api-keys", "create", "--name", "Agent CLI", "--scope", "mail_read", "mail_write"], {
      createClient: () => ({
        createApiKey: async (input) => {
          expect(input).toEqual({ name: "Agent CLI", scopes: ["mail_read", "mail_write"] });
          return {
            key: "mly_secret_once",
            api_key: {
              id: "key_1",
              name: "Agent CLI",
              prefix: "mly_live_abcd",
              scopes: ["mail_read", "mail_write"],
              lastUsedAt: null,
              revokedAt: null,
              createdAt: "2026-06-30T10:00:00.000Z",
            },
          };
        },
      } as never),
    });

    expect(result.out).toContain("mly_secret_once");
    expect(result.out.match(/mly_secret_once/g)?.length).toBe(1);
    expect(result.out).toContain("This secret is shown once");
  });

  it("revokes a cloud API key", async () => {
    let revokedId = "";
    const result = await runCloudCommand(["cloud", "api-keys", "revoke", "key_1"], {
      createClient: () => ({
        revokeApiKey: async (id) => {
          revokedId = id;
          return { ok: true };
        },
      } as never),
    });

    expect(revokedId).toBe("key_1");
    expect(result.out).toContain("Revoked API key key_1");
  });

  it("uploads local inbox messages to a cloud mailbox", async () => {
    const stored = storeInboundEmail({
      provider_id: null,
      message_id: "local-1",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["agent@example.com"],
      cc_addresses: [],
      subject: "Local message",
      text_body: "hello",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 5,
      received_at: "2026-06-30T10:00:00.000Z",
    });
    const uploads: unknown[] = [];

    const result = await runCloudCommand(["cloud", "messages", "upload-local", "--mailbox-id", "mbx_1", "--limit", "1"], {
      createClient: () => ({
        createMessage: async (input) => {
          uploads.push(input);
          return {
            id: "msg_1",
            tenantId: "ten_1",
            mailboxId: input.mailboxId,
            direction: "inbound",
            status: "synced",
            subject: input.subject ?? "",
            fromAddress: input.fromAddress ?? "",
            toAddresses: input.toAddresses ?? [],
            ccAddresses: [],
            receivedAt: input.receivedAt ?? null,
            sentAt: null,
            textBody: input.textBody ?? null,
            htmlBody: null,
            cleanMarkdown: null,
            summary: null,
            parserModel: null,
            classification: {},
            importanceScore: 0,
            isRead: false,
            isImportant: false,
            isSpam: false,
            isTrash: false,
            isArchived: false,
            createdAt: "2026-06-30T10:00:00.000Z",
            updatedAt: "2026-06-30T10:00:00.000Z",
            attachments: [],
          };
        },
      } as never),
    });

    expect(stored.subject).toBe("Local message");
    expect(uploads).toEqual([expect.objectContaining({
      mailboxId: "mbx_1",
      subject: "Local message",
      fromAddress: "sender@example.com",
      toAddresses: ["agent@example.com"],
      externalId: "local-1",
    })]);
    expect(result.out).toContain("Uploaded 1 local message");
  });

  it("preserves read, archive, spam, trash, and folder state when pulling cloud messages", async () => {
    await runCloudCommand(["cloud", "messages", "pull", "--limit", "1"], {
      createClient: () => ({
        listMessages: async () => [{
          id: "cloud_msg_1",
          tenantId: "ten_1",
          mailboxId: "mbx_cloud",
          direction: "inbound",
          status: "stored",
          subject: "Cloud trash",
          fromAddress: "sender@example.com",
          toAddresses: ["agent@example.com"],
          ccAddresses: [],
          receivedAt: "2026-06-30T10:00:00.000Z",
          sentAt: null,
          textBody: "cloud body",
          htmlBody: null,
          cleanMarkdown: null,
          summary: null,
          parserModel: null,
          classification: {},
          importanceScore: 0,
          isRead: true,
          isImportant: true,
          isSpam: false,
          isTrash: true,
          isArchived: true,
          createdAt: "2026-06-30T10:00:00.000Z",
          updatedAt: "2026-06-30T10:00:00.000Z",
        }],
        getMessage: async () => ({
          id: "cloud_msg_1",
          tenantId: "ten_1",
          mailboxId: "mbx_cloud",
          direction: "inbound",
          status: "stored",
          subject: "Cloud trash",
          fromAddress: "sender@example.com",
          toAddresses: ["agent@example.com"],
          ccAddresses: [],
          receivedAt: "2026-06-30T10:00:00.000Z",
          sentAt: null,
          textBody: "cloud body",
          htmlBody: null,
          cleanMarkdown: null,
          summary: null,
          parserModel: null,
          classification: {},
          importanceScore: 0,
          isRead: true,
          isImportant: true,
          isSpam: false,
          isTrash: true,
          isArchived: true,
          createdAt: "2026-06-30T10:00:00.000Z",
          updatedAt: "2026-06-30T10:00:00.000Z",
          attachments: [],
        }),
      } as never),
    });

    const db = getDatabase();
    const inbound = db.query(
      "SELECT is_read, is_archived, is_starred, is_spam, is_trash FROM inbound_emails WHERE message_id = ?",
    ).get("cloud:cloud_msg_1") as { is_read: number; is_archived: number; is_starred: number; is_spam: number; is_trash: number };
    const state = db.query(
      "SELECT is_read, is_archived, is_starred, is_spam, is_trash, folder_id FROM mailbox_message_state LIMIT 1",
    ).get() as { is_read: number; is_archived: number; is_starred: number; is_spam: number; is_trash: number; folder_id: string };

    expect(inbound).toEqual({ is_read: 1, is_archived: 1, is_starred: 1, is_spam: 0, is_trash: 1 });
    expect(state).toEqual({
      is_read: 1,
      is_archived: 1,
      is_starred: 1,
      is_spam: 0,
      is_trash: 1,
      folder_id: "folder:mbx:agent@example.com:trash",
    });
  });
});
