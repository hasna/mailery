import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer, DEFAULT_MCP_HTTP_PORT, MCP_NAME } from "./server.js";

export { DEFAULT_MCP_HTTP_PORT, MCP_NAME };

export function isHttpMode(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes("--http") || process.env["MCP_HTTP"] === "1";
}

export function isStdioMode(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes("--stdio") || process.env["MCP_STDIO"] === "1";
}

export function resolveHttpPort(argv: string[] = process.argv.slice(2)): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      const raw = argv[i + 1];
      if (!raw) throw new Error(`Invalid port: ${raw ?? ""}`);
      return parsePort(raw, "port");
    }
  }

  const fromEnv = process.env["MCP_HTTP_PORT"];
  if (fromEnv) return parsePort(fromEnv, "MCP_HTTP_PORT");
  return DEFAULT_MCP_HTTP_PORT;
}

function parsePort(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return value;
}

export async function handleMcpHttpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ status: "ok", name: MCP_NAME });
  }

  if (url.pathname === "/mcp") {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
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
