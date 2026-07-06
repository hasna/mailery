import { healthPayload } from "@hasna/mcp-harness";
import { handleMcpHttpRequest as harnessHandleMcpHttpRequest } from "@hasna/mcp-harness/bun";
import { DEFAULT_MCP_HTTP_PORT, isHttpMode, isStdioMode, MCP_NAME, resolveHttpPort } from "./options.js";

export { DEFAULT_MCP_HTTP_PORT, isHttpMode, isStdioMode, MCP_NAME, resolveHttpPort };

// mailery MCP HTTP transport — hand-wired onto `@hasna/mcp-harness` (the
// hand-rolled `WebStandardStreamableHTTPServerTransport` wiring + health
// payload shape are now shared). Public API (`handleMcpHttpRequest`,
// `startHttpServer`, the exported constants) is unchanged so `server/index.ts`
// and the existing tests keep working untouched, and `./server.js` stays a
// dynamic import so `--help`/`--version` and the health check never pull in
// the full tool graph.
export async function handleMcpHttpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json(healthPayload(MCP_NAME));
  }

  if (url.pathname === "/mcp") {
    const { buildServer } = await import("./server.js");
    return harnessHandleMcpHttpRequest(req, buildServer);
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
