/**
 * Integration test — exercises the full open-emails flow using sandbox provider.
 * Tests that CLI/DB/MCP layers work together correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase } from "./db/database.js";
import { createProvider, getProvider } from "./db/providers.js";
import { createEmail, getEmail, listEmails } from "./db/emails.js";
import { createEvent } from "./db/events.js";
import { createDomain, getDomainByName } from "./db/domains.js";
import { createAddress } from "./db/addresses.js";
import { SandboxAdapter } from "./providers/sandbox.js";
import { listSandboxEmails, clearSandboxEmails } from "./db/sandbox.js";
import { upsertContact, listContacts, isContactSuppressed } from "./db/contacts.js";
import { createTemplate, renderTemplate } from "./db/templates.js";
import { createSequence, addStep, enroll, getDueEnrollments, advanceEnrollment, listEnrollments } from "./db/sequences.js";
import { createWarmingSchedule, getWarmingSchedule } from "./db/warming.js";
import { getTodayLimit, generateWarmingPlan } from "./lib/warming.js";
import { storeInboundEmail, listReplies, getReplyCount } from "./db/inbound.js";
import { sendWithFailover } from "./lib/send.js";
import { getLocalStats } from "./lib/stats.js";
import { getAnalytics } from "./lib/analytics.js";
import { exportEmailsJson, exportEventsCsv } from "./lib/export.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  getDatabase(); // trigger migrations
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("full send flow (sandbox provider)", () => {
  it("creates sandbox provider, sends email, captures in sandbox", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "dev", type: "sandbox" }, db);
    expect(provider.type).toBe("sandbox");

    const adapter = new SandboxAdapter(provider);
    const msgId = await adapter.sendEmail({
      from: "hello@example.com",
      to: "user@test.com",
      subject: "Integration test",
      text: "Hello from integration test",
    });

    expect(msgId).toBeTruthy();
    const captured = listSandboxEmails();
    expect(captured.length).toBe(1);
    expect(captured[0]!.subject).toBe("Integration test");
    expect(captured[0]!.from_address).toBe("hello@example.com");
  });

  it("sendWithFailover uses sandbox provider", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "dev", type: "sandbox" }, db);
    const { messageId, providerId, usedFailover } = await sendWithFailover(provider.id, {
      from: "a@example.com",
      to: "b@test.com",
      subject: "Failover test",
      text: "Testing",
    }, db);
    expect(messageId).toBeTruthy();
    expect(providerId).toBe(provider.id);
    expect(usedFailover).toBe(false);
  });

  it("clears sandbox emails", () => {
    const db = getDatabase();
    const p = createProvider({ name: "dev", type: "sandbox" }, db);
    const adapter = new SandboxAdapter(p);
    // Manually insert via DB since sendEmail is async
    db.run(`INSERT INTO sandbox_emails (id, provider_id, from_address, to_addresses, cc_addresses, subject) VALUES ('s1', ?, 'a@b.com', '[]', '[]', 'Test')`, [p.id]);
    expect(listSandboxEmails()).length > 0;
    clearSandboxEmails(undefined, db);
    expect(listSandboxEmails().length).toBe(0);
  });
});

describe("contacts + suppression flow", () => {
  it("auto-suppresses contact after 3 bounces", () => {
    const db = getDatabase();
    const { incrementBounceCount } = require("./db/contacts.js");
    upsertContact("bouncy@test.com", db);
    expect(isContactSuppressed("bouncy@test.com", db)).toBe(false);
    incrementBounceCount("bouncy@test.com", db);
    incrementBounceCount("bouncy@test.com", db);
    incrementBounceCount("bouncy@test.com", db);
    expect(isContactSuppressed("bouncy@test.com", db)).toBe(true);
  });
});

describe("template rendering", () => {
  it("renders template with variables", () => {
    const db = getDatabase();
    createTemplate({ name: "welcome", subject_template: "Hello {{name}}!", html_template: "<p>Hi {{name}}</p>" }, db);
    const rendered = renderTemplate("Hello {{name}}!", { name: "Alice" });
    expect(rendered).toBe("Hello Alice!");
  });
});

describe("sequence enrollment flow", () => {
  it("enrolls contact, advance through steps, completes", () => {
    const db = getDatabase();
    createTemplate({ name: "step1", subject_template: "Step 1", text_template: "Content 1" }, db);
    createTemplate({ name: "step2", subject_template: "Step 2", text_template: "Content 2" }, db);
    const seq = createSequence({ name: "test-seq" }, db);
    addStep({ sequence_id: seq.id, step_number: 1, delay_hours: 0, template_name: "step1" }, db);
    addStep({ sequence_id: seq.id, step_number: 2, delay_hours: 24, template_name: "step2" }, db);

    const enrollment = enroll({ sequence_id: seq.id, contact_email: "user@test.com" }, db);
    expect(enrollment.status).toBe("active");
    expect(enrollment.current_step).toBe(0);

    const advanced = advanceEnrollment(enrollment.id, db);
    expect(advanced?.current_step).toBe(1);
    expect(advanced?.status).toBe("active");

    const completed = advanceEnrollment(enrollment.id, db);
    expect(completed?.status).toBe("completed");
  });
});

describe("warming schedule flow", () => {
  it("generates plan and returns today's limit on day 1", () => {
    const today = new Date().toISOString().slice(0, 10);
    const plan = generateWarmingPlan(10000);
    expect(plan[0]!.day).toBe(1);
    expect(plan[0]!.limit).toBe(50);
    expect(plan[plan.length - 1]!.limit).toBe(10000);

    const schedule = {
      id: "w1", domain: "example.com", provider_id: null,
      target_daily_volume: 10000, start_date: today,
      status: "active" as const, created_at: today, updated_at: today,
    };
    expect(getTodayLimit(schedule)).toBe(50);
  });
});

describe("reply tracking flow", () => {
  it("links inbound email to sent email via In-Reply-To header", () => {
    const db = getDatabase();
    // Insert a provider and sent email
    const pId = "p-integ-1";
    db.run(`INSERT INTO providers (id, name, type) VALUES (?, 'test', 'sandbox')`, [pId]);
    const eId = "e-integ-1";
    db.run(`INSERT INTO emails (id, provider_id, provider_message_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, status, sent_at, created_at, updated_at) VALUES (?, ?, 'msgid-integ-1', 'a@b.com', '[]', '[]', '[]', 'Hi', 'sent', datetime('now'), datetime('now'), datetime('now'))`, [eId, pId]);

    const inbound = storeInboundEmail({
      provider_id: null, message_id: null, in_reply_to_email_id: null,
      from_address: "user@test.com", to_addresses: ["a@b.com"], cc_addresses: [],
      subject: "Re: Hi", text_body: "Thanks!", html_body: null,
      attachments: [], headers: { "In-Reply-To": "<msgid-integ-1>" },
      raw_size: 100, received_at: new Date().toISOString(),
    }, db);

    expect(inbound.in_reply_to_email_id).toBe(eId);
    expect(getReplyCount(eId, db)).toBe(1);
    expect(listReplies(eId, db).length).toBe(1);
  });
});

describe("documented agent workflow smoke", () => {
  it("covers setup, sandbox capture, inbound browsing, analytics, stats, and exports", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "dev", type: "sandbox" }, db);
    const domain = createDomain(provider.id, "example.com", db);
    const address = createAddress({ provider_id: provider.id, email: "hello@example.com" }, db);

    const sent = await sendWithFailover(provider.id, {
      from: address.email,
      to: "user@example.net",
      subject: "Workflow smoke",
      text: "hello",
    }, db);
    expect(sent.providerId).toBe(provider.id);
    expect(listSandboxEmails(provider.id, 10, db)).toHaveLength(1);

    const email = createEmail(provider.id, {
      from: address.email,
      to: "user@example.net",
      subject: "Workflow smoke",
      text: "hello",
    }, sent.messageId, db);
    createEvent({
      email_id: email.id,
      provider_id: provider.id,
      type: "delivered",
      recipient: "user@example.net",
      occurred_at: new Date().toISOString(),
    }, db);
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "<workflow-inbound@example.net>",
      from_address: "user@example.net",
      to_addresses: [address.email],
      cc_addresses: [],
      subject: "Re: Workflow smoke",
      text_body: "thanks",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 20,
      received_at: new Date().toISOString(),
    }, db);

    expect(getProvider(provider.id, db)?.name).toBe("dev");
    expect(getDomainByName(provider.id, domain.domain, db)?.id).toBe(domain.id);
    expect(getLocalStats(provider.id, "30d", db).sent).toBeGreaterThan(0);
    expect(getAnalytics(provider.id, "30d", db).dailyVolume.length).toBeGreaterThan(0);
    expect(exportEmailsJson({ provider_id: provider.id }, db)).toContain("Workflow smoke");
    expect(exportEventsCsv({ provider_id: provider.id }, db)).toContain("delivered");
  });
});
