// Minimal, zero-dependency MCP (Model Context Protocol) stdio server for
// Mailery. It speaks newline-delimited JSON-RPC 2.0 over stdin/stdout
// (the MCP stdio transport) and exposes the agent-facing subset of the SDK as
// tools. No framework: the protocol surface we need (initialize, tools/list,
// tools/call, ping) is small enough to implement directly, which keeps the
// published CLI free of extra runtime dependencies.

import { handleMcpMessage, type JsonRpcRequest, type JsonRpcResponse } from "@hasna/mailery-sdk-internal";
import { buildClient, type CliDeps } from "./client.js";
import { VERSION } from "./version.js";

/**
 * Run the stdio MCP server: read newline-delimited JSON-RPC from stdin, write
 * newline-delimited responses to stdout. Resolves when stdin closes.
 */
export async function runMcpServer(deps: CliDeps): Promise<void> {
  const client = buildClient(deps);
  const decoder = new TextDecoder();
  let buffer = "";

  function replyError(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  async function processLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      deps.stdout(`${JSON.stringify(replyError(null, -32700, "parse error"))}\n`);
      return;
    }
    const response = await handleMcpMessage(msg, client, { name: "mailery", version: VERSION });
    if (response) deps.stdout(`${JSON.stringify(response)}\n`);
  }

  // Bun/Node: consume the async-iterable stdin stream.
  const stdin = (process.stdin as unknown as AsyncIterable<Uint8Array>);
  for await (const chunk of stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await processLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) await processLine(buffer);
}
