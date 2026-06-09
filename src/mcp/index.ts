#!/usr/bin/env bun
/**
 * emails MCP server entry point.
 */
import pkg from "../../package.json" with { type: "json" };

function printHelp(): void {
  console.log(`Usage: emails-mcp [options]

Runs the @hasna/emails MCP server (stdio by default).

Options:
      --http         Serve MCP over Streamable HTTP on 127.0.0.1
  -p, --port <port>  HTTP port (default: MCP_HTTP_PORT or 8816)
  -V, --version      output the version number
  -h, --help         display help for command

Environment:
  MCP_HTTP=1         Enable HTTP mode
  MCP_HTTP_PORT      Override default HTTP port (8816)`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}

async function main(): Promise<void> {
  const { isStdioMode, resolveHttpPort } = await import("./options.js");
  if (isStdioMode(args)) {
    const [{ StdioServerTransport }, { buildServer }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("./server.js"),
    ]);
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }
  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  const { startHttpServer } = await import("./http.js");
  startHttpServer({ port: resolveHttpPort(args) });
  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
