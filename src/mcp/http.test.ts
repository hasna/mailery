import { afterEach, describe, expect, it, mock } from "bun:test";

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

const servers: Array<ReturnType<typeof startHttpServer>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
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
});

describe("emails-mcp buildServer", () => {
  it("registers tools for stdio and HTTP modes", () => {
    const server = buildServer();
    expect(server).toBeTruthy();
  });
});
