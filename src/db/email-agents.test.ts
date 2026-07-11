import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import { storeInboundEmail } from "./inbound.js";
import {
  ensureEmailAgentSettings,
  getEmailAgentRun,
  listEmailAgentRuns,
  listPendingInboundEmailsForAgent,
  saveEmailAgentRun,
  updateEmailAgentSetting,
} from "./email-agents.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

function seedInbound(messageId = "agent-db-test") {
  return storeInboundEmail({
    provider_id: null,
    message_id: messageId,
    in_reply_to_email_id: null,
    from_address: "Example Sender <sender@example.com>",
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject: "Agent DB test",
    text_body: "Please review https://example.com/report",
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: 10,
    received_at: "2026-06-16T10:00:00.000Z",
  });
}

describe("email agent persistence", () => {
  it("creates default managed agent settings", () => {
    const settings = ensureEmailAgentSettings(getDatabase());

    expect(settings.map((setting) => setting.agent_key).sort()).toEqual(["categorizer", "fraud", "labeler"]);
    expect(settings.every((setting) => setting.provider === "external")).toBe(true);
    expect(settings.every((setting) => !setting.enabled)).toBe(true);
  });

  it("updates enabled and always-on settings", () => {
    const setting = updateEmailAgentSetting("labeler", {
      enabled: true,
      always_on: true,
      model: "external-summary",
      use_network_tools: false,
    }, getDatabase());

    expect(setting.enabled).toBe(true);
    expect(setting.always_on).toBe(true);
    expect(setting.model).toBe("external-summary");
    expect(setting.use_network_tools).toBe(false);
  });

  it("lists pending inbound emails based on missing run ledger rows", () => {
    const email = seedInbound();

    expect(listPendingInboundEmailsForAgent("categorizer", 10, getDatabase()).map((row) => row.id)).toEqual([email.id]);

    saveEmailAgentRun({
      agent_key: "categorizer",
      inbound_email_id: email.id,
      provider: "external",
      model: "test-model",
      status: "ok",
      labels: ["fyi"],
      category: "fyi",
    }, getDatabase());

    expect(listPendingInboundEmailsForAgent("categorizer", 10, getDatabase())).toEqual([]);
  });

  it("upserts one latest run per agent and inbound email", () => {
    const email = seedInbound();
    saveEmailAgentRun({
      agent_key: "fraud",
      inbound_email_id: email.id,
      provider: "external",
      model: "first",
      status: "error",
      error: "temporary",
    }, getDatabase());
    const second = saveEmailAgentRun({
      agent_key: "fraud",
      inbound_email_id: email.id,
      provider: "external",
      model: "second",
      status: "ok",
      labels: ["review-risk"],
      risk_score: 42,
    }, getDatabase());

    expect(second.model).toBe("second");
    expect(second.status).toBe("ok");
    expect(getEmailAgentRun("fraud", email.id, getDatabase())?.risk_score).toBe(42);
    expect(listEmailAgentRuns({ agent_key: "fraud" }, getDatabase())).toHaveLength(1);
  });
});
