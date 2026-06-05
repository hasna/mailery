import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

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
const { closeDatabase, resetDatabase } = await import("../db/database.js");
const { createProvider } = await import("../db/providers.js");
const { createAddress } = await import("../db/addresses.js");
const { createOwner } = await import("../db/owners.js");

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
      for (const uri of ["emails://agent/context", "emails://status", "emails://domains", "emails://addresses", "emails://recent-errors"]) {
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
      expect(text).toContain('"access_key": "***"');
      expect(text).toContain('"secret_key": "***"');
      expect(text).not.toContain("AKIA_MCP_SHOULD_NOT_LEAK");
      expect(text).not.toContain("MCP_SECRET_SHOULD_NOT_LEAK");
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
      expect(assignedText).toContain('"cli_equivalent": "emails address set-owner owner@example.com --owner mcp-agent --json"');

      const owner = await client.callTool(
        { name: "get_address_owner", arguments: { address: "owner@example.com" } },
        undefined,
        { timeout: 10_000 },
      );
      const ownerText = owner.content[0]?.type === "text" ? owner.content[0].text : "";
      expect(ownerText).toContain('"name": "mcp-agent"');
      expect(ownerText).toContain('"cli_equivalent": "emails address owner owner@example.com --json"');
    } finally {
      await client.close();
    }
  });
});

describe("emails-mcp buildServer", () => {
  it("registers tools for stdio and HTTP modes", () => {
    const server = buildServer();
    expect(server).toBeTruthy();
  });
});
