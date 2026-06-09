import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DEFAULT_MCP_HTTP_PORT, isHttpMode, isStdioMode, MCP_NAME, resolveHttpPort } from "./options.js";

export { DEFAULT_MCP_HTTP_PORT, isHttpMode, isStdioMode, MCP_NAME, resolveHttpPort };

export async function handleMcpHttpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ status: "ok", name: MCP_NAME });
  }

  if (url.pathname === "/mcp") {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const { buildServer } = await import("./server.js");
    const server = buildServer();
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  return new Response("Not Found", { status: 404 });
}

export interface StartHttpServerOptions {
  port?: number;
  hostname?: string;
  log?: (message: string) => void;
}

export function startHttpServer(options: StartHttpServerOptions = {}): ReturnType<typeof Bun.serve> {
  const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
  const hostname = options.hostname ?? "127.0.0.1";
  const log = options.log ?? console.error;

  const server = Bun.serve({
    port,
    hostname,
    fetch: handleMcpHttpRequest,
  });

  const address = `http://${hostname}:${server.port}`;
  log(`${MCP_NAME}-mcp HTTP listening on ${address}/mcp (health: ${address}/health)`);
  return server;
}
