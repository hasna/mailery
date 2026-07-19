export const EMAILS_MCP_SERVER_NAME = "emails";
export const EMAILS_MCP_COMMAND = "emails-mcp";
const EMAILS_MCP_STDIO_ARG = "--stdio";

export interface McpInstallCommand {
  command: string;
  args: string[];
  shell: string;
}

export function getClaudeMcpInstallCommand(): McpInstallCommand {
  const args = ["mcp", "add", "--transport", "stdio", "--scope", "user", EMAILS_MCP_SERVER_NAME, "--", EMAILS_MCP_COMMAND, EMAILS_MCP_STDIO_ARG];
  return {
    command: "claude",
    args,
    shell: ["claude", ...args].join(" "),
  };
}

export function getClaudeMcpRemoveCommand(): McpInstallCommand {
  const args = ["mcp", "remove", EMAILS_MCP_SERVER_NAME];
  return {
    command: "claude",
    args,
    shell: ["claude", ...args].join(" "),
  };
}

export function getCodexMcpConfig(): string {
  return `[mcp_servers.${EMAILS_MCP_SERVER_NAME}]
command = "${EMAILS_MCP_COMMAND}"
args = ["${EMAILS_MCP_STDIO_ARG}"]
`;
}

export function getGeminiMcpConfig(): { mcpServers: Record<string, { command: string; args: string[] }> } {
  return { mcpServers: { [EMAILS_MCP_SERVER_NAME]: { command: EMAILS_MCP_COMMAND, args: [EMAILS_MCP_STDIO_ARG] } } };
}
