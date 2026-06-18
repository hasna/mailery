import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { listEmailAgentRuns } from "../../db/email-agents.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { registerStatusCommands } from "./status.js";

async function runStatusCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  let formatted = "";
  registerStatusCommands(program, (payload, text) => {
    data = payload;
    formatted = text;
  });
  await program.parseAsync(["node", "mailery", ...args]);
  return { data, formatted };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

function seedInbound() {
  return storeInboundEmail({
    provider_id: null,
    message_id: "agent-cli-test",
    in_reply_to_email_id: null,
    from_address: "sender@example.com",
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject: "CLI agent test",
    text_body: "Body",
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 10,
    received_at: "2026-06-16T10:00:00.000Z",
  });
}

describe("managed agent CLI commands", () => {
  it("lists and enables managed agents", async () => {
    const list = await runStatusCommand(["agent", "list"]);
    expect(list.formatted).toContain("Managed email agent defaults");
    expect(list.formatted).toContain("default provider: groq");
    expect(list.formatted).toContain("default Groq model: llama-3.3-70b-versatile");
    expect(list.formatted).toContain("Groq credential: missing");
    expect(list.formatted).toContain("Categorizer");
    expect(list.formatted).toContain("enabled: no");
    expect(list.formatted).toContain("provider: groq");

    const defaults = await runStatusCommand(["agent", "defaults"]);
    expect(defaults.formatted).toContain("prompt boundary: mailery-managed-email-agent-v1");

    const enabled = await runStatusCommand(["agent", "enable", "labeler", "--always-on", "--skip-network"]);
    expect(enabled.formatted).toContain("Labeler");
    expect(enabled.formatted).toContain("enabled: yes");
    expect(enabled.formatted).toContain("always on: yes");
    expect(enabled.formatted).toContain("network tools: no");
    expect(enabled.formatted).toContain("credential: missing");
  });

  it("records skipped runs without requiring AI credentials when an agent is disabled", async () => {
    const email = seedInbound();
    const run = await runStatusCommand(["agent", "run", "categorizer", "--limit", "1"]);

    expect(run.formatted).toContain("categorizer skipped");
    expect(run.formatted).toContain(email.id.slice(0, 8));
    expect(listEmailAgentRuns({ agent_key: "categorizer" }, getDatabase())).toHaveLength(1);

    const runs = await runStatusCommand(["agent", "runs", "--agent", "categorizer"]);
    expect(runs.formatted).toContain("categorizer skipped");
  });

  it("generates a local inbox digest from the agent CLI", async () => {
    seedInbound();
    const digest = await runStatusCommand(["agent", "digest", "today", "--local"]);

    expect(digest.formatted).toContain("Today digest");
    expect(digest.formatted).toContain("Summary:");
    expect(digest.formatted).toContain("provider: local local-mailery-digest");
    expect(digest.data).toMatchObject({ period: "today", provider: "local", status: "ok" });
  });
});
