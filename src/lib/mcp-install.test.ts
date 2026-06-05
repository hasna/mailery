import { describe, expect, it } from "bun:test";
import { getClaudeMcpInstallCommand, getClaudeMcpRemoveCommand, getCodexMcpConfig, getGeminiMcpConfig } from "./mcp-install.js";

describe("MCP install metadata", () => {
  it("builds stable Claude Code install and removal commands", () => {
    expect(getClaudeMcpInstallCommand()).toEqual({
      command: "claude",
      args: ["mcp", "add", "--transport", "stdio", "--scope", "user", "emails", "--", "emails-mcp"],
      shell: "claude mcp add --transport stdio --scope user emails -- emails-mcp",
    });
    expect(getClaudeMcpRemoveCommand()).toEqual({
      command: "claude",
      args: ["mcp", "remove", "emails"],
      shell: "claude mcp remove emails",
    });
  });

  it("builds stable Codex and Gemini snippets", () => {
    expect(getCodexMcpConfig()).toContain("[mcp_servers.emails]");
    expect(getCodexMcpConfig()).toContain('command = "emails-mcp"');
    expect(getGeminiMcpConfig()).toEqual({ mcpServers: { emails: { command: "emails-mcp", args: [] } } });
  });
});
