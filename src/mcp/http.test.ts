import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("@hasna/connectors", () => ({
  runConnectorOperation: mock(async (operationArgs: { operation: string }) => ({
    connector: "gmail",
    operation: operationArgs.operation,
    success: true,
    stdout: "[]",
    stderr: "",
    exitCode: 0,
    data: [],
  })),
}));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { buildServer } = await import("./server.js");
const { DEFAULT_MCP_HTTP_PORT, MCP_NAME, startHttpServer } = await import("./http.js");
const { closeDatabase, getDatabase, resetDatabase } = await import("../db/database.js");
const { createProvider } = await import("../db/providers.js");
const { createAddress, markVerified } = await import("../db/addresses.js");
const { createDomain, updateDnsStatus } = await import("../db/domains.js");
const { createOwner } = await import("../db/owners.js");
const { setAddressProvisioning, setDomainProvisioning } = await import("../db/provisioning.js");
const { storeInboundEmail, getInboundEmail } = await import("../db/inbound.js");
const { storeSandboxEmail } = await import("../db/sandbox.js");
const { createWarmingSchedule } = await import("../db/warming.js");
const { createTemplate } = await import("../db/templates.js");
const { upsertContact } = await import("../db/contacts.js");
const { createScheduledEmail } = await import("../db/scheduled.js");
const { createGroup, addMember } = await import("../db/groups.js");
const { createSequence, enroll } = await import("../db/sequences.js");
const { createAlias } = await import("../db/aliases.js");
const { createSendKey } = await import("../db/send-keys.js");
const { createEmail } = await import("../db/emails.js");
const { saveTriage } = await import("../db/triage.js");

const servers: Array<ReturnType<typeof startHttpServer>> = [];

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("emails-mcp HTTP transport", () => {
  it("exposes health and serves MCP over Streamable HTTP", async () => {
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", name: MCP_NAME });

    const client = new Client({ name: "emails-mcp-http-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });

      const tools = await client.listTools(undefined, { timeout: 10_000 });
      expect(tools.tools.some((tool) => tool.name === "list_groups")).toBe(true);
      for (const name of [
        "prepare_inbox",
        "wait_for_code",
        "list_usable_from_addresses",
        "provision_address",
        "get_address_owner",
        "set_address_owner",
        "transfer_address_owner",
        "unassign_address_owner",
        "list_address_owner_history",
      ]) {
        expect(tools.tools.some((tool) => tool.name === name)).toBe(true);
      }

      const resources = await client.listResources(undefined, { timeout: 10_000 });
      for (const uri of ["emails://agent/context", "emails://agent/context/full", "emails://status", "emails://domains", "emails://addresses", "emails://recent-errors"]) {
        expect(resources.resources.some((resource) => resource.uri === uri)).toBe(true);
      }
      const status = await client.readResource({ uri: "emails://status" }, { timeout: 10_000 });
      expect(status.contents[0]?.mimeType).toBe("application/json");

      const groups = await client.callTool(
        { name: "list_groups", arguments: {} },
        undefined,
        { timeout: 10_000 },
      );
      expect(groups.content[0]?.type).toBe("text");
    } finally {
      await client.close();
    }
  });

  it("uses the assigned default port constant", () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8861);
  });

  it("advertises bounded schemas for expensive MCP tool inputs", async () => {
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-schema-bounds-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const tools = await client.listTools(undefined, { timeout: 10_000 });
      const props = (name: string) => {
        const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, { default?: unknown; maximum?: number; description?: string }> } | undefined;
        return schema?.properties ?? {};
      };

      expect(props("list_emails").limit?.maximum).toBe(1000);
      expect(props("search_emails").limit?.maximum).toBe(1000);
      expect(props("search_emails").offset?.description).toContain("Pagination offset");
      expect(props("triage_batch").limit?.maximum).toBe(100);
      expect(props("list_triaged").offset?.default).toBe(0);
      expect(props("sync_s3_inbox").limit?.maximum).toBe(10000);
      expect(props("provision_address").timeout_seconds?.maximum).toBe(300);
      expect(props("provision_address").interval_seconds?.maximum).toBe(60);
      expect(props("register_domain").duration_years?.maximum).toBe(10);
      expect(props("get_latest_inbound_email").limit?.description).toContain("latest returns one");
      expect(props("list_replies").limit?.maximum).toBe(100);
    } finally {
      await client.close();
    }
  });

  it("redacts provider credentials in MCP tool results", async () => {
    createProvider({
      name: "secret-ses",
      type: "ses",
      access_key: "AKIA_MCP_SHOULD_NOT_LEAK",
      secret_key: "MCP_SECRET_SHOULD_NOT_LEAK",
      region: "us-east-1",
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-redaction-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool({ name: "list_providers", arguments: {} }, undefined, { timeout: 10_000 });
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).not.toContain('"access_key"');
      expect(text).not.toContain('"secret_key"');
      expect(text).not.toContain('"oauth_refresh_token"');
      expect(text).toContain('"cli_equivalent": "mailery provider list --json"');
      expect(text).not.toContain("AKIA_MCP_SHOULD_NOT_LEAK");
      expect(text).not.toContain("MCP_SECRET_SHOULD_NOT_LEAK");
    } finally {
      await client.close();
    }
  });

  it("redacts sensitive config values in MCP tool results", async () => {
    const originalHome = process.env["HOME"];
    const tmpHome = mkdtempSync(join(tmpdir(), "emails-mcp-config-"));
    process.env["HOME"] = tmpHome;

    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-config-redaction-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const callText = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
        return result.content[0]?.type === "text" ? result.content[0].text : "";
      };

      const setText = await callText("set_config", { key: "cloudflare_api_token", value: "MCP_CONFIG_SECRET" });
      expect(setText).toContain('"cloudflare_api_token": "***"');
      expect(setText).not.toContain("MCP_CONFIG_SECRET");

      const getText = await callText("get_config", { key: "cloudflare_api_token" });
      expect(getText).toContain('"cloudflare_api_token": "***"');
      expect(getText).not.toContain("MCP_CONFIG_SECRET");

      const listText = await callText("list_config", {});
      expect(listText).toContain('"cloudflare_api_token": "***"');
      expect(listText).not.toContain("MCP_CONFIG_SECRET");
    } finally {
      await client.close();
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns one-time send key tokens while keeping listed keys redacted", async () => {
    const owner = createOwner({ type: "agent", name: "mcp-sendkey-agent" });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-sendkey-token-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const created = await client.callTool(
        { name: "create_send_key", arguments: { owner_id: owner.id, label: "mcp" } },
        undefined,
        { timeout: 10_000 },
      );
      const createdText = created.content[0]?.type === "text" ? created.content[0].text : "";
      const parsed = JSON.parse(createdText) as { token: string; id: string; key_hash?: string };
      expect(parsed.token).toStartWith("esk_");
      expect(parsed.key_hash).toBeUndefined();
      expect(createdText).not.toContain('"token": "***"');

      const listed = await client.callTool(
        { name: "list_send_keys", arguments: { owner_id: owner.id } },
        undefined,
        { timeout: 10_000 },
      );
      const listedText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
      expect(listedText).toContain(parsed.id);
      expect(listedText).not.toContain(parsed.token);
      expect(listedText).not.toContain("key_hash");
    } finally {
      await client.close();
    }
  });

  it("paginates provider listing through MCP", async () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const provider = createProvider({ name: `provider-${i}`, type: "sandbox" });
      db.run("UPDATE providers SET created_at = ? WHERE id = ?", [`2026-01-0${i}T00:00:00.000Z`, provider.id]);
    }
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-provider-paging-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "list_providers", arguments: { limit: 2, offset: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { providers: Array<{ name: string }>; limit: number; offset: number };

      expect(parsed.providers.map((provider) => provider.name)).toEqual(["provider-3", "provider-2"]);
      expect(parsed.limit).toBe(2);
      expect(parsed.offset).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("paginates sent-email list and search through MCP without idempotency keys", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "sent-provider", type: "sandbox" });
    for (let i = 0; i < 4; i++) {
      const email = createEmail(provider.id, {
        from: "ops@example.com",
        to: `target-${i}@example.com`,
        subject: `MCP searchable sent ${i}`,
        text: "body",
        idempotency_key: `mcp-secret-${i}`,
      });
      db.run("UPDATE emails SET sent_at = ?, created_at = ?, updated_at = ? WHERE id = ?", [
        `2026-01-01T00:0${i}:00.000Z`,
        `2026-01-01T00:0${i}:00.000Z`,
        `2026-01-01T00:0${i}:00.000Z`,
        email.id,
      ]);
    }

    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-sent-paging-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const callRows = async (name: string, args: Record<string, unknown>): Promise<{ items: Array<Record<string, unknown>>; cli_equivalent: string }> => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return JSON.parse(text) as { items: Array<Record<string, unknown>>; cli_equivalent: string };
      };

      const listed = await callRows("list_emails", { limit: 2, offset: 1 });
      expect(listed.items.map((row) => row.subject)).toEqual(["MCP searchable sent 2", "MCP searchable sent 1"]);
      expect(listed.cli_equivalent).toContain("--limit 2 --offset 1");
      expect(listed.items[0]).not.toHaveProperty("idempotency_key");
      expect(JSON.stringify(listed)).not.toContain("mcp-secret");

      const searched = await callRows("search_emails", { query: "searchable", limit: 2, offset: 1 });
      expect(searched.items.map((row) => row.subject)).toEqual(["MCP searchable sent 2", "MCP searchable sent 1"]);
      expect(searched.cli_equivalent).toContain("--limit 2 --offset 1");
      expect(searched.items[0]).not.toHaveProperty("idempotency_key");
      expect(JSON.stringify(searched)).not.toContain("mcp-secret");
    } finally {
      await client.close();
    }
  });

  it("paginates triage listing through MCP", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "triage-provider", type: "sandbox" });
    for (let i = 0; i < 4; i++) {
      const email = createEmail(provider.id, {
        from: "ops@example.com",
        to: `triaged-${i}@example.com`,
        subject: `MCP triage ${i}`,
        text: "body",
      });
      const triage = saveTriage({
        email_id: email.id,
        label: "fyi",
        priority: 3,
        summary: `MCP summary ${i}`,
        draft_reply: `MCP large draft ${i} `.repeat(500),
      });
      db.run("UPDATE email_triage SET triaged_at = ?, created_at = ? WHERE id = ?", [
        `2026-01-01T00:0${i}:00.000Z`,
        `2026-01-01T00:0${i}:00.000Z`,
        triage.id,
      ]);
    }

    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-triage-paging-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "list_triaged", arguments: { limit: 2, offset: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as Array<Record<string, unknown>> | { items: Array<Record<string, unknown>> };
      const rows = Array.isArray(parsed) ? parsed : parsed.items;

      expect(rows.map((row) => row.summary)).toEqual(["MCP summary 2", "MCP summary 1"]);
      expect(rows[0]).not.toHaveProperty("draft_reply");
      expect(JSON.stringify(rows)).not.toContain("MCP large draft");
    } finally {
      await client.close();
    }
  });

  it("returns lean template summaries through MCP list_templates and full details through get_template", async () => {
    createTemplate({
      name: "mcp-template-summary",
      subject_template: "MCP template summary",
      html_template: `<main>${"MCP template hidden html ".repeat(200)}</main>`,
      text_template: "MCP template hidden text ".repeat(200),
    });

    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-template-summary-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const listResult = await client.callTool(
        { name: "list_templates", arguments: { limit: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const listText = listResult.content[0]?.type === "text" ? listResult.content[0].text : "";
      const listed = JSON.parse(listText) as { items: Array<Record<string, unknown>>; cli_equivalent: string };
      const [row] = listed.items;

      expect(row?.name).toBe("mcp-template-summary");
      expect(row?.has_html_template).toBe(true);
      expect(row?.has_text_template).toBe(true);
      expect(row).not.toHaveProperty("html_template");
      expect(row).not.toHaveProperty("text_template");
      expect(JSON.stringify(listed)).not.toContain("MCP template hidden");
      expect(listed.cli_equivalent).toBe("mailery template list --limit 1 --json");

      const detailResult = await client.callTool(
        { name: "get_template", arguments: { name_or_id: "mcp-template-summary" } },
        undefined,
        { timeout: 10_000 },
      );
      const detailText = detailResult.content[0]?.type === "text" ? detailResult.content[0].text : "";
      const detail = JSON.parse(detailText) as Record<string, unknown>;

      expect(detail.name).toBe("mcp-template-summary");
      expect(String(detail.html_template)).toContain("MCP template hidden html");
      expect(String(detail.text_template)).toContain("MCP template hidden text");
      expect(detail.cli_equivalent).toBe("mailery template show mcp-template-summary --json");
    } finally {
      await client.close();
    }
  });

  it("returns lean scheduled-email summaries through MCP list_scheduled", async () => {
    const provider = createProvider({ name: "scheduled-summary-provider", type: "sandbox" });
    createScheduledEmail({
      provider_id: provider.id,
      from_address: "ops@example.com",
      to_addresses: ["scheduled-summary@example.com"],
      subject: "MCP scheduled summary",
      html: `<p>${"MCP hidden html ".repeat(200)}</p>`,
      text_body: "MCP hidden text ".repeat(200),
      attachments_json: [{ filename: "payload.txt", content: "MCP hidden attachment".repeat(100) }],
      template_name: "welcome",
      template_vars: { hidden: "MCP hidden vars".repeat(100) },
      scheduled_at: "2030-01-01T00:00:00.000Z",
    });

    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-scheduled-summary-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "list_scheduled", arguments: { limit: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { items: Array<Record<string, unknown>>; cli_equivalent: string };
      const [row] = parsed.items;

      expect(row?.subject).toBe("MCP scheduled summary");
      expect(row?.template_name).toBe("welcome");
      expect(row).not.toHaveProperty("html");
      expect(row).not.toHaveProperty("text_body");
      expect(row).not.toHaveProperty("attachments_json");
      expect(row).not.toHaveProperty("template_vars");
      expect(JSON.stringify(parsed)).not.toContain("MCP hidden");
      expect(parsed.cli_equivalent).toBe("mailery schedule list --limit 1 --json");
    } finally {
      await client.close();
    }
  });

  it("returns lean group-member summaries through MCP list_group_members and full vars through get_group_member", async () => {
    const group = createGroup("mcp-member-summary");
    addMember(group.id, "alice@example.com", "Alice", { hidden: "MCP hidden group vars ".repeat(100) });

    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-group-member-summary-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const listResult = await client.callTool(
        { name: "list_group_members", arguments: { group_name: group.name, limit: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const listText = listResult.content[0]?.type === "text" ? listResult.content[0].text : "";
      const listed = JSON.parse(listText) as { items: Array<Record<string, unknown>>; cli_equivalent: string };
      const [row] = listed.items;

      expect(row?.email).toBe("alice@example.com");
      expect(row).not.toHaveProperty("vars");
      expect(JSON.stringify(listed)).not.toContain("MCP hidden group vars");
      expect(listed.cli_equivalent).toBe("mailery group members mcp-member-summary --limit 1 --json");

      const detailResult = await client.callTool(
        { name: "get_group_member", arguments: { group_name: group.name, email: "alice@example.com" } },
        undefined,
        { timeout: 10_000 },
      );
      const detailText = detailResult.content[0]?.type === "text" ? detailResult.content[0].text : "";
      const detail = JSON.parse(detailText) as Record<string, unknown>;

      expect(detail.email).toBe("alice@example.com");
      expect(detail.vars).toEqual({ hidden: "MCP hidden group vars ".repeat(100) });
    } finally {
      await client.close();
    }
  });

  it("applies default pagination to MCP list tools when limit is omitted", async () => {
    const provider = createProvider({ name: "default-page-provider", type: "sandbox" });
    const owner = createOwner({ type: "agent", name: "default-page-agent" });
    const memberGroup = createGroup("default-page-members");
    const enrollmentSequence = createSequence({ name: "default-page-enrollments" });
    const sentEmail = createEmail(provider.id, {
      from: "from@example.com",
      to: "reply-target@example.com",
      subject: "Reply target",
      text: "body",
    }, "default-page-replies");

    for (let i = 1; i <= 101; i++) {
      const suffix = String(i).padStart(3, "0");
      createTemplate({ name: `default-template-${suffix}`, subject_template: `Subject ${suffix}` });
      upsertContact(`contact-${suffix}@example.com`);
      createScheduledEmail({
        provider_id: provider.id,
        from_address: "from@example.com",
        to_addresses: [`to-${suffix}@example.com`],
        subject: `Scheduled ${suffix}`,
        scheduled_at: `2026-01-${String(Math.min(i, 28)).padStart(2, "0")}T00:00:00.000Z`,
      });
      createGroup(`default-page-group-${suffix}`);
      addMember(memberGroup.id, `member-${suffix}@example.com`);
      createSequence({ name: `default-page-sequence-${suffix}` });
      enroll({ sequence_id: enrollmentSequence.id, contact_email: `enrolled-${suffix}@example.com` });
      createDomain(provider.id, `default-domain-${suffix}.example.com`);
      createAddress({ provider_id: provider.id, email: `address-${suffix}@example.com` });
      createAlias(`alias-${suffix}@example.com`, `target-${suffix}@example.com`);
      createSendKey(owner.id, `key-${suffix}`);
      storeInboundEmail({
        provider_id: provider.id,
        message_id: `reply-${suffix}`,
        in_reply_to_email_id: sentEmail.id,
        from_address: `reply-${suffix}@example.com`,
        to_addresses: ["from@example.com"],
        cc_addresses: [],
        subject: `Reply ${suffix}`,
        text_body: `Reply body ${suffix}`,
        html_body: null,
        attachments: [],
        attachment_paths: [],
        headers: {},
        raw_size: 100,
        received_at: `2026-02-${String(Math.min(i, 28)).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-default-paging-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const callJson = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return JSON.parse(text) as T;
      };

      expect((await callJson<{ items: unknown[] }>("list_templates")).items.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_contacts")).items.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_scheduled")).items.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_groups")).items.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_group_members", { group_name: memberGroup.name })).items.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_sequences")).items.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_enrollments", { sequence_id: enrollmentSequence.name })).items.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_domains")).items.length).toBe(100);
      expect((await callJson<{ addresses: unknown[] }>("list_addresses")).addresses.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_aliases")).items.length).toBe(100);
      expect((await callJson<{ items: unknown[] }>("list_send_keys")).items.length).toBe(100);
      const replies = await callJson<{ replies: unknown[]; count: number; limit: number; offset: number; truncated: boolean }>(
        "list_replies",
        { email_id: sentEmail.id },
      );
      expect(replies.replies.length).toBe(20);
      expect(replies.count).toBe(101);
      expect(replies.limit).toBe(20);
      expect(replies.offset).toBe(0);
      expect(replies.truncated).toBe(true);
      expect(replies.replies[0]).not.toHaveProperty("text_body");
      expect(replies.replies[0]).not.toHaveProperty("html_body");
      expect(replies.replies[0]).not.toHaveProperty("headers");
    } finally {
      await client.close();
    }
  });

  it("returns MCP ambiguity errors for short reply and batch provider IDs", async () => {
    const db = getDatabase();
    const providerId1 = "abc11111-1111-1111-1111-111111111111";
    const providerId2 = "abc22222-2222-2222-2222-222222222222";
    const emailId1 = "mail1111-1111-1111-1111-111111111111";
    const emailId2 = "mail2222-2222-2222-2222-222222222222";
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [providerId1, "provider-one", "sandbox"]);
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [providerId2, "provider-two", "sandbox"]);
    for (const [id, subject] of [[emailId1, "First"], [emailId2, "Second"]] as Array<[string, string]>) {
      db.run(
        `INSERT INTO emails
          (id, provider_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, status, sent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          providerId1,
          "ops@example.com",
          JSON.stringify(["user@example.com"]),
          "[]",
          "[]",
          subject,
          "sent",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ],
      );
    }
    createTemplate({
      name: "mcp-batch-ambiguous-provider",
      subject_template: "Hi {{email}}",
      text_template: "Hello {{email}}",
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-ambiguous-id-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const replies = await client.callTool(
        { name: "list_replies", arguments: { email_id: "mail" } },
        undefined,
        { timeout: 10_000 },
      );
      const repliesText = replies.content[0]?.type === "text" ? replies.content[0].text : "";
      expect(replies.isError).toBe(true);
      expect(repliesText).toContain("Ambiguous ID 'mail' in table 'emails'");

      const batch = await client.callTool(
        {
          name: "batch_send",
          arguments: {
            provider_id: "abc",
            template_name: "mcp-batch-ambiguous-provider",
            from_address: "ops@example.com",
            recipients: [{ email: "user@example.com" }],
          },
        },
        undefined,
        { timeout: 10_000 },
      );
      const batchText = batch.content[0]?.type === "text" ? batch.content[0].text : "";
      expect(batch.isError).toBe(true);
      expect(batchText).toContain("Ambiguous ID 'abc' in table 'providers'");
    } finally {
      await client.close();
    }
  });

  it("returns structured MCP errors with CLI fix commands", async () => {
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-error-contract-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "remove_provider", arguments: { provider_id: "missing" } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as {
        error: { code: string; fix_command: string; fix_commands: string[]; retryable: boolean };
        cli_equivalent: string;
      };
      expect(parsed.error.code).toBe("not_found");
      expect(parsed.error.fix_command).toBe("mailery provider list --json");
      expect(parsed.error.fix_commands).toContain("mailery provider add --help");
      expect(parsed.error.retryable).toBe(false);
      expect(parsed.cli_equivalent).toBe("mailery provider remove missing --yes --json");
    } finally {
      await client.close();
    }
  });

  it("sets and reads address ownership through MCP tools", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    createAddress({ provider_id: provider.id, email: "owner@example.com" });
    createOwner({ type: "agent", name: "mcp-agent" });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-ownership-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const assigned = await client.callTool(
        { name: "set_address_owner", arguments: { address: "owner@example.com", owner: "mcp-agent" } },
        undefined,
        { timeout: 10_000 },
      );
      const assignedText = assigned.content[0]?.type === "text" ? assigned.content[0].text : "";
      expect(assignedText).toContain('"cli_equivalent": "mailery address set-owner owner@example.com --owner mcp-agent --json"');

      const owner = await client.callTool(
        { name: "get_address_owner", arguments: { address: "owner@example.com" } },
        undefined,
        { timeout: 10_000 },
      );
      const ownerText = owner.content[0]?.type === "text" ? owner.content[0].text : "";
      expect(ownerText).toContain('"name": "mcp-agent"');
      expect(ownerText).toContain('"cli_equivalent": "mailery address owner owner@example.com --json"');
    } finally {
      await client.close();
    }
  });

  it("prepare_inbox finds exact addresses across providers without creating new rows", async () => {
    const first = createProvider({ name: "first", type: "sandbox", active: true });
    const second = createProvider({ name: "second", type: "sandbox", active: true });
    createAddress({ provider_id: first.id, email: "agent@example.com" });
    createAddress({ provider_id: second.id, email: "Agent@Example.com" });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-prepare-inbox-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "prepare_inbox", arguments: { email: "AGENT@example.COM", owner: "agent-owner" } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as {
        email: string;
        created: boolean;
        addresses: Array<{ address: { email: string; provider_id: string } }>;
        blockers: string[];
      };

      expect(parsed.email).toBe("agent@example.com");
      expect(parsed.created).toBe(false);
      expect(parsed.addresses.map((item) => item.address.provider_id).sort()).toEqual([first.id, second.id].sort());
      expect(parsed.blockers).toContain("Address exists on multiple providers; assign ownership by address ID.");
    } finally {
      await client.close();
    }
  });

  it("returns scoped provisioning status for an exact domain", async () => {
    const provider = createProvider({ name: "ses", type: "ses", region: "us-east-1" });
    const first = createDomain(provider.id, "first.example.com");
    const second = createDomain(provider.id, "second.example.com");
    setDomainProvisioning(first.id, { provisioning_status: "ready", send_provider: "ses" });
    setDomainProvisioning(second.id, { provisioning_status: "ready", send_provider: "ses" });
    const firstAddress = createAddress({ provider_id: provider.id, email: "ops@first.example.com" });
    const secondAddress = createAddress({ provider_id: provider.id, email: "ops@second.example.com" });
    setAddressProvisioning(firstAddress.id, { domain_id: first.id, receive_strategy: "ses-s3", provisioning_status: "ready" });
    setAddressProvisioning(secondAddress.id, { domain_id: second.id, receive_strategy: "ses-s3", provisioning_status: "ready" });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-provision-status-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "provision_status", arguments: { domain: "FIRST.EXAMPLE.COM" } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { items: Array<{ domain: string; addresses: Array<{ email: string }> }> };

      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]?.domain).toBe("first.example.com");
      expect(parsed.items[0]?.addresses.map((row) => row.email)).toEqual(["ops@first.example.com"]);
      expect(text).not.toContain("ops@second.example.com");
    } finally {
      await client.close();
    }
  });

  it("filters usable from-addresses by provider without leaking other provider rows", async () => {
    const firstProvider = createProvider({ name: "first-ses", type: "ses", region: "us-east-1" });
    const secondProvider = createProvider({ name: "second-ses", type: "ses", region: "us-east-1" });
    const firstDomain = createDomain(firstProvider.id, "first.example.com");
    const secondDomain = createDomain(secondProvider.id, "second.example.com");
    const firstAddress = markVerified(createAddress({ provider_id: firstProvider.id, email: "ops@first.example.com" }).id);
    const secondAddress = markVerified(createAddress({ provider_id: secondProvider.id, email: "ops@second.example.com" }).id);
    setDomainProvisioning(firstDomain.id, { provisioning_status: "ready", send_provider: "ses" });
    setDomainProvisioning(secondDomain.id, { provisioning_status: "ready", send_provider: "ses" });
    setAddressProvisioning(firstAddress.id, { domain_id: firstDomain.id, receive_strategy: "ses-s3", provisioning_status: "ready" });
    setAddressProvisioning(secondAddress.id, { domain_id: secondDomain.id, receive_strategy: "ses-s3", provisioning_status: "ready" });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-usable-from-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "list_usable_from_addresses", arguments: { provider_id: firstProvider.id, receive: true } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { addresses: Array<{ email: string; provider_id: string }> };

      expect(parsed.addresses.map((address) => address.email)).toEqual(["ops@first.example.com"]);
      expect(parsed.addresses[0]?.provider_id).toBe(firstProvider.id);
      expect(text).not.toContain("ops@second.example.com");
    } finally {
      await client.close();
    }
  });

  it("filters usable domains by provider and includes batched provider names", async () => {
    const firstProvider = createProvider({ name: "first-ses", type: "ses", region: "us-east-1" });
    const secondProvider = createProvider({ name: "second-ses", type: "ses", region: "us-east-1" });
    const firstDomain = createDomain(firstProvider.id, "first.example.com");
    const secondDomain = createDomain(secondProvider.id, "second.example.com");
    updateDnsStatus(firstDomain.id, "verified", "verified", "verified");
    updateDnsStatus(secondDomain.id, "verified", "verified", "verified");
    setDomainProvisioning(firstDomain.id, { provisioning_status: "ready", send_provider: "ses" });
    setDomainProvisioning(secondDomain.id, { provisioning_status: "ready", send_provider: "ses" });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-usable-domains-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "list_usable_domains", arguments: { provider_id: firstProvider.id, send: true } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { domains: Array<{ domain: string; provider_id: string; provider_name: string | null }> };

      expect(parsed.domains).toHaveLength(1);
      expect(parsed.domains[0]?.domain).toBe("first.example.com");
      expect(parsed.domains[0]?.provider_id).toBe(firstProvider.id);
      expect(parsed.domains[0]?.provider_name).toBe("first-ses");
      expect(text).not.toContain("second.example.com");
    } finally {
      await client.close();
    }
  });

  it("paginates usable domains and from-addresses after filtering", async () => {
    const provider = createProvider({ name: "ses", type: "ses", region: "us-east-1" });
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const domain = createDomain(provider.id, `usable-${i}.example.com`);
      updateDnsStatus(domain.id, "verified", "verified", "verified");
      setDomainProvisioning(domain.id, { provisioning_status: "ready", send_provider: "ses" });
      db.run("UPDATE domains SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, domain.id]);

      const address = markVerified(createAddress({ provider_id: provider.id, email: `ops-${i}@usable-${i}.example.com` }).id);
      setAddressProvisioning(address.id, { domain_id: domain.id, receive_strategy: "ses-s3", provisioning_status: "ready" });
      db.run("UPDATE addresses SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, address.id]);
    }

    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-usable-paging-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const domainResult = await client.callTool(
        { name: "list_usable_domains", arguments: { provider_id: provider.id, send: true, limit: 2, offset: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const domainText = domainResult.content[0]?.type === "text" ? domainResult.content[0].text : "";
      const domainParsed = JSON.parse(domainText) as { domains: Array<{ domain: string }>; total: number; limit: number; offset: number; truncated: boolean };

      expect(domainParsed.domains.map((domain) => domain.domain)).toEqual(["usable-3.example.com", "usable-2.example.com"]);
      expect(domainParsed.total).toBe(4);
      expect(domainParsed.limit).toBe(2);
      expect(domainParsed.offset).toBe(1);
      expect(domainParsed.truncated).toBe(true);

      const addressResult = await client.callTool(
        { name: "list_usable_from_addresses", arguments: { provider_id: provider.id, receive: true, limit: 2, offset: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const addressText = addressResult.content[0]?.type === "text" ? addressResult.content[0].text : "";
      const addressParsed = JSON.parse(addressText) as { addresses: Array<{ email: string }>; total: number; limit: number; offset: number; truncated: boolean };

      expect(addressParsed.addresses.map((address) => address.email)).toEqual(["ops-3@usable-3.example.com", "ops-2@usable-2.example.com"]);
      expect(addressParsed.total).toBe(4);
      expect(addressParsed.limit).toBe(2);
      expect(addressParsed.offset).toBe(1);
      expect(addressParsed.truncated).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("paginates warming schedules", async () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const schedule = createWarmingSchedule({ domain: `warm-${i}.example.com`, target_daily_volume: 100 });
      db.run("UPDATE warming_schedules SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, schedule.id]);
    }
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-warming-paging-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "list_warming_schedules", arguments: { limit: 2, offset: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { schedules: Array<{ domain: string }>; limit: number; offset: number; truncated: boolean };

      expect(parsed.schedules.map((schedule) => schedule.domain)).toEqual(["warm-3.example.com", "warm-2.example.com"]);
      expect(parsed.limit).toBe(2);
      expect(parsed.offset).toBe(1);
      expect(parsed.truncated).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("gets the latest inbound email with filters before applying the result limit", async () => {
    const provider = createProvider({ name: "gmail", type: "gmail", active: true });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "recent-noise",
      in_reply_to_email_id: null,
      from_address: "updates@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Recent noise",
      text_body: "recent noise body ".repeat(1000),
      html_body: `<p>${"recent noise html ".repeat(1000)}</p>`,
      attachments: [],
      attachment_paths: [],
      headers: { "x-debug": "recent-noise" },
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "older-target",
      in_reply_to_email_id: null,
      from_address: "security@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Target login alert",
      text_body: "latest target body ".repeat(1000),
      html_body: `<p>${"latest target html ".repeat(1000)}</p>`,
      attachments: [],
      attachment_paths: [],
      headers: { "x-debug": "latest-target" },
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-latest-inbound-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "get_latest_inbound_email", arguments: { address: "me@example.com", from: "security", subject: "target", limit: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { email: Record<string, unknown> | null };

      expect(parsed.email?.subject).toBe("Target login alert");
      expect(parsed.email?.from_address).toBe("security@example.com");
      expect(parsed.email).not.toHaveProperty("text_body");
      expect(parsed.email).not.toHaveProperty("html_body");
      expect(parsed.email).not.toHaveProperty("headers");
      expect(text).not.toContain("latest target body");
      expect(text).not.toContain("latest target html");
      expect(text).not.toContain("latest-target");
    } finally {
      await client.close();
    }
  });

  it("waits for inbound email summaries without body or header payloads", async () => {
    const provider = createProvider({ name: "gmail", type: "gmail", active: true });
    const email = storeInboundEmail({
      provider_id: provider.id,
      message_id: "wait-summary-row",
      in_reply_to_email_id: null,
      from_address: "security@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Wait summary alert",
      text_body: "wait summary body ".repeat(1000),
      html_body: `<p>${"wait summary html ".repeat(1000)}</p>`,
      attachments: [],
      attachment_paths: [],
      headers: { "x-debug": "wait-header-secret" },
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-wait-inbound-summary-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "wait_for_email", arguments: { address: "me@example.com", from: "security", refresh: false, timeout_seconds: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { email: Record<string, unknown> | null };

      expect(parsed.email?.id).toBe(email.id);
      expect(parsed.email?.subject).toBe("Wait summary alert");
      expect(parsed.email).not.toHaveProperty("text_body");
      expect(parsed.email).not.toHaveProperty("html_body");
      expect(parsed.email).not.toHaveProperty("headers");
      expect(text).not.toContain("wait summary body");
      expect(text).not.toContain("wait summary html");
      expect(text).not.toContain("wait-header-secret");
    } finally {
      await client.close();
    }
  });

  it("wait_for_code ignores Gmail SENT rows", async () => {
    const provider = createProvider({ name: "gmail", type: "gmail", active: true });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "incoming-code",
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
    });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "sent-code",
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
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-wait-code-sent-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "wait_for_code", arguments: { address: "me@example.com", from: "openai", refresh: false, timeout_seconds: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { code: string | null };

      expect(parsed.code).toBe("492255");
    } finally {
      await client.close();
    }
  });

  it("lists inbound email summaries without body or header payloads", async () => {
    const provider = createProvider({ name: "gmail", type: "gmail", active: true });
    const email = storeInboundEmail({
      provider_id: provider.id,
      message_id: "summary-row",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Summary row",
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      attachments: [],
      attachment_paths: [],
      headers: { "x-debug": "large" },
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "summary-older-row",
      in_reply_to_email_id: null,
      from_address: "older@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Older summary row",
      text_body: "older large body ".repeat(1000),
      html_body: `<p>${"older large html ".repeat(1000)}</p>`,
      attachments: [],
      attachment_paths: [],
      headers: { "x-debug": "older-large" },
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "summary-sent-row",
      in_reply_to_email_id: null,
      from_address: "me@example.com",
      to_addresses: ["sender@example.com"],
      cc_addresses: [],
      subject: "Summary sent row",
      text_body: "sent body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      label_ids: ["SENT"],
      raw_size: 100,
      received_at: "2026-06-04T11:31:09.000Z",
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-inbound-summary-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "list_inbound_emails", arguments: { provider_id: provider.id, limit: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { items: Array<Record<string, unknown>>; limit: number; offset: number; truncated: boolean };

      expect(parsed.items).toHaveLength(1);
      expect(parsed.limit).toBe(1);
      expect(parsed.offset).toBe(0);
      expect(parsed.truncated).toBe(true);
      expect(parsed.items[0]?.id).toBe(email.id);
      expect(parsed.items[0]?.subject).toBe("Summary row");
      expect(parsed.items[0]).not.toHaveProperty("text_body");
      expect(parsed.items[0]).not.toHaveProperty("html_body");
      expect(parsed.items[0]).not.toHaveProperty("headers");
      expect(text).not.toContain("Summary sent row");
    } finally {
      await client.close();
    }
  });

  it("returns paged inbound search summaries with truncation metadata", async () => {
    const provider = createProvider({ name: "gmail", type: "gmail", active: true });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "search-recent-match",
      in_reply_to_email_id: null,
      from_address: "alerts@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Needle alert",
      text_body: "large needle body ".repeat(1000),
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: { "x-debug": "search-recent" },
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "search-older-match",
      in_reply_to_email_id: null,
      from_address: "alerts@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Older needle alert",
      text_body: "older large needle body ".repeat(1000),
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: { "x-debug": "search-older" },
      raw_size: 100,
      received_at: "2026-06-04T11:29:09.000Z",
    });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "search-noise",
      in_reply_to_email_id: null,
      from_address: "updates@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Plain update",
      text_body: "body",
      html_body: null,
      attachments: [],
      attachment_paths: [],
      headers: {},
      raw_size: 100,
      received_at: "2026-06-04T11:31:09.000Z",
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-search-summary-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "search_inbound", arguments: { provider_id: provider.id, query: "needle", limit: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { items: Array<Record<string, unknown>>; limit: number; offset: number; truncated: boolean };

      expect(parsed.items).toHaveLength(1);
      expect(parsed.limit).toBe(1);
      expect(parsed.offset).toBe(0);
      expect(parsed.truncated).toBe(true);
      expect(parsed.items[0]?.subject).toBe("Needle alert");
      expect(parsed.items[0]).not.toHaveProperty("text_body");
      expect(parsed.items[0]).not.toHaveProperty("html_body");
      expect(parsed.items[0]).not.toHaveProperty("headers");
      expect(text).not.toContain("Plain update");
    } finally {
      await client.close();
    }
  });

  it("returns inbound mutation summaries without body or header payloads", async () => {
    const provider = createProvider({ name: "gmail", type: "gmail", active: true });
    const email = storeInboundEmail({
      provider_id: provider.id,
      message_id: "mutation-summary-row",
      in_reply_to_email_id: null,
      from_address: "sender@example.com",
      to_addresses: ["me@example.com"],
      cc_addresses: [],
      subject: "Mutation summary row",
      text_body: "large body ".repeat(1000),
      html_body: `<p>${"large html ".repeat(1000)}</p>`,
      attachments: [],
      attachment_paths: [],
      headers: { "x-debug": "large" },
      raw_size: 100,
      received_at: "2026-06-04T11:30:09.000Z",
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-mutation-summary-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "mark_email_read", arguments: { email_id: email.id } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as Record<string, unknown>;

      expect(parsed.id).toBe(email.id);
      expect(parsed.is_read).toBe(true);
      expect(parsed).not.toHaveProperty("text_body");
      expect(parsed).not.toHaveProperty("html_body");
      expect(parsed).not.toHaveProperty("headers");
      expect(getInboundEmail(email.id)?.is_read).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("lists sandbox email summaries without body or header payloads", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const email = storeSandboxEmail({
      provider_id: provider.id,
      from_address: "sender@example.com",
      to_addresses: ["recipient@example.com"],
      cc_addresses: [],
      bcc_addresses: [],
      reply_to: null,
      subject: "Sandbox summary row",
      html: `<p>${"large html ".repeat(1000)}</p>`,
      text_body: "large body ".repeat(1000),
      attachments: [],
      headers: { "x-debug": "large" },
    });
    const server = startHttpServer({ port: 0, log: () => {} });
    servers.push(server);

    const client = new Client({ name: "emails-mcp-sandbox-summary-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));

    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool(
        { name: "list_sandbox_emails", arguments: { provider_id: provider.id, limit: 1 } },
        undefined,
        { timeout: 10_000 },
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const parsed = JSON.parse(text) as { items: Array<Record<string, unknown>> };

      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]?.id).toBe(email.id);
      expect(parsed.items[0]?.subject).toBe("Sandbox summary row");
      expect(parsed.items[0]).not.toHaveProperty("html");
      expect(parsed.items[0]).not.toHaveProperty("text_body");
      expect(parsed.items[0]).not.toHaveProperty("headers");
    } finally {
      await client.close();
    }
  });
});

describe("emails-mcp buildServer", () => {
  it("registers tools for stdio and HTTP modes", () => {
    const server = buildServer();
    expect(server).toBeTruthy();
    const tools = Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});
    expect(tools).toContain("extract_inbound_email_links");
  });
});
