import { describe, expect, it } from "bun:test";
import { getClaudeMcpInstallCommand, getClaudeMcpRemoveCommand, getCodexMcpConfig, getGeminiMcpConfig } from "./mcp-install.js";

describe("MCP install metadata", () => {
  it("registers Claude Code with an explicitly stdio-bound server command", () => {
    expect(getClaudeMcpInstallCommand()).toEqual({
      command: "claude",
      args: ["mcp", "add", "--transport", "stdio", "--scope", "user", "emails", "--", "emails-mcp", "--stdio"],
      shell: "claude mcp add --transport stdio --scope user emails -- emails-mcp --stdio",
    });
  });

  it("builds the stable Claude Code removal command", () => {
    expect(getClaudeMcpRemoveCommand()).toEqual({
      command: "claude",
      args: ["mcp", "remove", "emails"],
      shell: "claude mcp remove emails",
    });
  });

  it("registers Codex with an explicitly stdio-bound server command", () => {
    expect(getCodexMcpConfig()).toBe(`[mcp_servers.emails]
command = "emails-mcp"
args = ["--stdio"]
`);
  });

  it("registers Gemini with an explicitly stdio-bound server command", () => {
    expect(getGeminiMcpConfig()).toEqual({ mcpServers: { emails: { command: "emails-mcp", args: ["--stdio"] } } });
  });
});
