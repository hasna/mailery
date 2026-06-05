import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("agent documentation contract", () => {
  it("keeps AGENTS.md aligned with current agent-facing surfaces", () => {
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");

    expect(agents).toContain("~/.hasna/emails/emails.db");
    expect(agents).toContain("HASNA_EMAILS_DB_PATH");
    expect(agents).toContain("100+ MCP tools");
    expect(agents).toContain("prepare_inbox");
    expect(agents).toContain("wait_for_code");
    expect(agents).toContain("list_usable_from_addresses");
    expect(agents).toContain("emails://agent/context");
    expect(agents).toContain("emails://recent-errors");
    expect(agents).not.toContain("59 MCP tools");
    expect(agents).not.toContain("mcp/index.ts               # MCP server (59 tools)");
  });
});
