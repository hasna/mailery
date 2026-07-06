import {
  isHttpMode as harnessIsHttpMode,
  isStdioMode as harnessIsStdioMode,
} from "@hasna/mcp-harness";

// mailery MCP transport/mode boilerplate — hand-wired onto `@hasna/mcp-harness`
// (the mode/port primitives live in a single shared package instead of being
// re-implemented per repo). Public API (names, signatures, `-p`/`--port`
// support, error messages) is unchanged so `http.ts`, `server.ts`, the CLI
// entrypoint, and the tests keep working untouched.

export const MCP_NAME = "mailery";
export const DEFAULT_MCP_HTTP_PORT = 8861;

export function isHttpMode(argv: string[] = process.argv.slice(2)): boolean {
  return harnessIsHttpMode(argv, process.env);
}

export function isStdioMode(argv: string[] = process.argv.slice(2)): boolean {
  return harnessIsStdioMode(argv, process.env);
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
