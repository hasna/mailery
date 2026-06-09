export const MCP_NAME = "emails";
export const DEFAULT_MCP_HTTP_PORT = 8861;

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
