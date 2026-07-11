import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAddress } from "../../db/addresses.js";
import { suppressContact, upsertContact } from "../../db/contacts.js";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createDomain, updateDnsStatus, updateDomainReadiness } from "../../db/domains.js";
import { saveEmailAgentRun } from "../../db/email-agents.js";
import { createEmail } from "../../db/emails.js";
import { createEvent } from "../../db/events.js";
import { addMember, createGroup } from "../../db/groups.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { createProvider } from "../../db/providers.js";
import { createScheduledEmail, markSent } from "../../db/scheduled.js";
import { storeSandboxEmail } from "../../db/sandbox.js";
import { createSequence, enroll, unenroll } from "../../db/sequences.js";
import { createTemplate } from "../../db/templates.js";
import { saveTriage } from "../../db/triage.js";
import { createWarmingSchedule, updateWarmingStatus } from "../../db/warming.js";
import { handleApiRequest } from "../api-routes.js";

async function call(path: string, init?: RequestInit): Promise<Response> {
  const req = new Request(`http://127.0.0.1:3900${path}`, init);
  const url = new URL(req.url);
  const response = await handleApiRequest(req, url, url.pathname, req.method);
  if (!response) throw new Error(`No route handled ${req.method} ${path}`);
  return response;
}

async function json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return await response.json() as T;
}

function postJson(path: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("emails serve REST parity smoke", () => {
  it("serves mailbox/source surfaces with source-aware filtering and visible legacy mail", async () => {
    const primary = createProvider({ name: "Primary SES", type: "ses", active: true });
    const secondary = createProvider({ name: "Secondary Resend", type: "resend", active: true });
    storeInboundEmail({
      provider_id: primary.id,
      message_id: "<primary-source@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "primary needle",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-02T10:00:00.000Z",
    });
    storeInboundEmail({
      provider_id: secondary.id,
      message_id: "<secondary-source@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "secondary needle",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-03T10:00:00.000Z",
    });
    storeInboundEmail({
      provider_id: null,
      message_id: "<legacy-source@example.com>",
      from_address: "legacy@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "legacy still visible",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T10:00:00.000Z",
    });

    const sourceId = `provider:${primary.id}`;
    const sources = await json<{ sources: Array<{ id: string; badges: string[]; total: number }> }>("/api/sources");
    expect(sources.sources.find((source) => source.id === sourceId)).toMatchObject({ total: 1 });
    expect(sources.sources.find((source) => source.id === "legacy")?.badges).toContain("legacy");

    const status = await json<{ counts: { inbox: number }; folders: Array<{ id: string; count: number }> }>(`/api/mailboxes?source_id=${encodeURIComponent(sourceId)}`);
    expect(status.counts.inbox).toBe(1);
    expect(status.folders.find((folder) => folder.id === "inbox")?.count).toBe(1);

    const primaryInbox = await json<{ items: Array<{ subject: string }>; source: { sourceId: string } }>(`/api/mailbox/inbox?source_id=${encodeURIComponent(sourceId)}`);
    expect(primaryInbox.source.sourceId).toBe(sourceId);
    expect(primaryInbox.items.map((item) => item.subject)).toEqual(["primary needle"]);

    const sourceSearch = await json<{ items: Array<{ subject: string }> }>(`/api/sources/${encodeURIComponent(sourceId)}/search?q=needle`);
    expect(sourceSearch.items.map((item) => item.subject)).toEqual(["primary needle"]);

    const legacyInbox = await json<{ items: Array<{ subject: string }> }>("/api/mailbox/inbox?source_id=legacy");
    expect(legacyInbox.items.map((item) => item.subject)).toEqual(["legacy still visible"]);
  });

  it("prefers managed agent summaries over legacy triage summaries for inbound detail", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const inboundEmail = storeInboundEmail({
      provider_id: provider.id,
      message_id: "<agent-summary@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "Agent summary source",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 4,
      received_at: "2026-02-03T00:00:00.000Z",
    });
    saveTriage({
      inbound_email_id: inboundEmail.id,
      label: "fyi",
      priority: 1,
      summary: "Legacy triage summary",
      confidence: 0.8,
    });
    saveEmailAgentRun({
      agent_key: "categorizer",
      inbound_email_id: inboundEmail.id,
      provider: "external",
      model: "external-summary",
      status: "ok",
      category: "fyi",
      labels: ["fyi"],
      summary: "Managed agent summary",
      output: {},
      started_at: "2026-02-03T00:00:01.000Z",
      completed_at: "2026-02-03T00:00:02.000Z",
    });

    const detail = await json<{ summary: string | null }>(`/api/inbound/${inboundEmail.id}`);
    expect(detail.summary).toBe("Managed agent summary");
  });

  it("serves a local digest snapshot through the dashboard API", async () => {
    storeInboundEmail({
      provider_id: null,
      message_id: "<digest-api@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "Digest API",
      text_body: "Needs review",
      html_body: null,
      attachments: [],
      label_ids: ["important"],
      headers: {},
      raw_size: 12,
      received_at: new Date().toISOString(),
    });

    const digest = await json<{ period: string; provider: string; status: string; summary: string; message_count: number }>("/api/digest?period=today");
    expect(digest).toMatchObject({ period: "today", provider: "local", status: "ok" });
    expect(digest.summary).toContain("1 inbound message");
    expect(digest.message_count).toBe(1);
  });

  it("serves core dashboard APIs without leaking provider credentials", async () => {
    const provider = createProvider({
      name: "sandbox",
      type: "sandbox",
      api_key: "REST_PARITY_SECRET",
      active: true,
    });
    const domain = createDomain(provider.id, "example.com");
    const address = createAddress({ provider_id: provider.id, email: "ops@example.com" });
    const email = createEmail(provider.id, {
      from: "ops@example.com",
      to: "user@example.com",
      subject: "REST smoke",
      text: "hello",
    }, "rest-msg");
    createEvent({
      email_id: email.id,
      provider_id: provider.id,
      type: "delivered",
      recipient: "user@example.com",
      occurred_at: "2026-02-01T00:00:00.000Z",
    });
    const inboundEmail = storeInboundEmail({
      provider_id: provider.id,
      message_id: "<inbound@example.com>",
      from_address: "user@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "Inbound smoke",
      text_body: "reply",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 10,
      received_at: "2026-02-02T00:00:00.000Z",
    });
    saveTriage({
      inbound_email_id: inboundEmail.id,
      label: "fyi",
      priority: 2,
      summary: "REST inbound summary",
      confidence: 0.8,
    });
    storeSandboxEmail({
      provider_id: provider.id,
      from_address: "ops@example.com",
      to_addresses: ["user@example.com"],
      cc_addresses: [],
      bcc_addresses: [],
      reply_to: null,
      subject: "Sandbox smoke",
      html: null,
      text_body: "hello",
      attachments: [],
      headers: {},
    });

    const providers = await json<Array<Record<string, unknown>>>("/api/providers");
    expect(providers[0]).not.toHaveProperty("api_key");
    expect(providers[0]).not.toHaveProperty("access_key");
    expect(providers[0]).not.toHaveProperty("secret_key");
    expect(providers[0]).not.toHaveProperty("oauth_refresh_token");
    expect(JSON.stringify(providers)).not.toContain("REST_PARITY_SECRET");

    const domains = await json<Array<{ id: string; domain: string }>>(`/api/domains?provider_id=${provider.id}`);
    expect(domains).toEqual([{ ...domain, verified_at: null }]);

    const addresses = await json<Array<{ id: string; email: string }>>(`/api/addresses?provider_id=${provider.id}`);
    expect(addresses[0]).toMatchObject({ id: address.id, email: "ops@example.com" });

    const emails = await json<Array<{ id: string; subject: string }>>(`/api/emails?provider_id=${provider.id}`);
    expect(emails[0]).toMatchObject({ id: email.id, subject: "REST smoke" });

    const inbound = await json<Array<{ subject: string }>>("/api/inbound?to=ops@example.com");
    expect(inbound[0]?.subject).toBe("Inbound smoke");
    const inboundDetail = await json<{ summary: string | null; text_body: string | null }>(`/api/inbound/${inboundEmail.id}`);
    expect(inboundDetail.summary).toBe("REST inbound summary");
    expect(inboundDetail.text_body).toBe("reply");

    const events = await json<Array<{ type: string }>>(`/api/events?provider_id=${provider.id}&type=delivered`);
    expect(events[0]?.type).toBe("delivered");

    expect(await json("/api/stats")).toBeTruthy();
    expect(await json("/api/analytics")).toBeTruthy();

    const template = await json<{ name: string }>("/api/templates", postJson("/api/templates", {
      name: "welcome",
      subject_template: "Welcome {{name}}",
      text_template: "Hi {{name}}",
    }));
    expect(template.name).toBe("welcome");
    const templates = await json<Array<Record<string, unknown>>>("/api/templates");
    const listedTemplate = templates.find((item) => item.name === "welcome");
    expect(listedTemplate).toMatchObject({ name: "welcome", has_text_template: true });
    expect(listedTemplate).not.toHaveProperty("html_template");
    expect(listedTemplate).not.toHaveProperty("text_template");

    const templateDetail = await json<Record<string, unknown>>("/api/templates/welcome");
    expect(templateDetail.name).toBe("welcome");
    expect(templateDetail.text_template).toBe("Hi {{name}}");

    await json(`/api/contacts/${encodeURIComponent("user@example.com")}/suppress`, { method: "POST" });
    expect(await json<Array<{ email: string; suppressed: boolean }>>("/api/contacts?suppressed=true"))
      .toContainEqual(expect.objectContaining({ email: "user@example.com", suppressed: true }));

    const sequence = await json<{ id: string; name: string }>("/api/sequences", postJson("/api/sequences", { name: "onboarding" }));
    await json(`/api/sequences/${sequence.id}/steps`, postJson(`/api/sequences/${sequence.id}/steps`, {
      step_number: 1,
      delay_hours: 0,
      template_name: "welcome",
    }));
    await json(`/api/sequences/${sequence.id}/enroll`, postJson(`/api/sequences/${sequence.id}/enroll`, {
      contact_email: "user@example.com",
    }));
    expect(await json<Array<{ contact_email: string }>>(`/api/sequences/${sequence.id}/enrollments`))
      .toContainEqual(expect.objectContaining({ contact_email: "user@example.com" }));

    expect(await json<Array<{ subject: string }>>(`/api/sandbox?provider_id=${provider.id}`))
      .toContainEqual(expect.objectContaining({ subject: "Sandbox smoke" }));

    const exportedEmails = await json<Array<{ id: string }>>(`/api/export/emails?format=json&provider_id=${provider.id}`);
    expect(exportedEmails.map((item) => item.id)).toContain(email.id);
  });

  it("rejects unresolved or ambiguous REST provider filters instead of returning empty pages", async () => {
    const db = getDatabase();
    const id1 = "abc11111-1111-1111-1111-111111111111";
    const id2 = "abc22222-2222-2222-2222-222222222222";
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id1, "provider-one", "sandbox"]);
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id2, "provider-two", "sandbox"]);
    createDomain(id1, "strict-provider.example.com");

    const valid = await json<Array<{ provider_id: string; domain: string }>>("/api/domains?provider_id=abc11111");
    expect(valid).toEqual([expect.objectContaining({ provider_id: id1, domain: "strict-provider.example.com" })]);

    const ambiguous = await call("/api/domains?provider_id=abc");
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toEqual({
      error: "Ambiguous ID 'abc' in table 'providers'. Use a longer prefix or full ID.",
    });

    const missingEmailFilter = await call("/api/emails?provider_id=missing-provider");
    expect(missingEmailFilter.status).toBe(400);
    expect(await missingEmailFilter.json()).toEqual({
      error: "Could not resolve ID 'missing-provider' in table 'providers'.",
    });

    const missingExportFilter = await call("/api/export/emails?provider_id=missing-provider");
    expect(missingExportFilter.status).toBe(400);

    const missingInboundFilter = await call("/api/inbound?provider_id=missing-provider");
    expect(missingInboundFilter.status).toBe(400);
  });

  it("paginates REST exports before serializing response bodies", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const older = createEmail(provider.id, {
      from: "ops@example.com",
      to: "older@example.com",
      subject: "Older export",
      text: "hello",
    });
    const newer = createEmail(provider.id, {
      from: "ops@example.com",
      to: "newer@example.com",
      subject: "Newer export",
      text: "hello",
    });
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", older.id]);
    db.run("UPDATE emails SET sent_at = ? WHERE id = ?", ["2026-02-01T00:00:00.000Z", newer.id]);
    const oldEvent = createEvent({
      email_id: older.id,
      provider_id: provider.id,
      type: "delivered",
      recipient: "older@example.com",
      occurred_at: "2026-01-01T00:00:00.000Z",
    });
    const newEvent = createEvent({
      email_id: newer.id,
      provider_id: provider.id,
      type: "delivered",
      recipient: "newer@example.com",
      occurred_at: "2026-02-01T00:00:00.000Z",
    });

    const exportedEmails = await json<Array<{ id: string }>>(`/api/export/emails?format=json&provider_id=${provider.id}&limit=1&offset=1`);
    expect(exportedEmails.map((item) => item.id)).toEqual([older.id]);

    const exportedEvents = await json<Array<{ id: string }>>(`/api/export/events?format=json&provider_id=${provider.id}&until=2026-01-15T00%3A00%3A00.000Z&limit=10`);
    expect(exportedEvents.map((item) => item.id)).toEqual([oldEvent.id]);
    expect(exportedEvents.map((item) => item.id)).not.toContain(newEvent.id);
  });

  it("paginates REST event history with offset and until filters", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const oldest = createEvent({
      provider_id: provider.id,
      type: "delivered",
      recipient: "oldest@example.com",
      occurred_at: "2026-01-01T00:00:00.000Z",
    });
    const middle = createEvent({
      provider_id: provider.id,
      type: "opened",
      recipient: "middle@example.com",
      metadata: { user_agent: "REST hidden event metadata ".repeat(100) },
      occurred_at: "2026-02-01T00:00:00.000Z",
    });
    const newest = createEvent({
      provider_id: provider.id,
      type: "clicked",
      recipient: "newest@example.com",
      occurred_at: "2026-03-01T00:00:00.000Z",
    });

    const page = await json<Array<Record<string, unknown>>>(`/api/events?provider_id=${provider.id}&limit=1&offset=1`);
    expect(page.map((item) => item.id)).toEqual([middle.id]);
    expect(page[0]).not.toHaveProperty("metadata");
    expect(JSON.stringify(page)).not.toContain("REST hidden event metadata");

    const detail = await json<Record<string, unknown>>(`/api/events/${middle.id}`);
    expect(detail.metadata).toEqual({ user_agent: "REST hidden event metadata ".repeat(100) });

    const olderPage = await json<Array<{ id: string }>>(`/api/events?provider_id=${provider.id}&until=2026-01-15T00%3A00%3A00.000Z&limit=10`);
    expect(olderPage.map((item) => item.id)).toEqual([oldest.id]);
    expect(olderPage.map((item) => item.id)).not.toContain(middle.id);
    expect(olderPage.map((item) => item.id)).not.toContain(newest.id);
  });

  it("filters REST sent email APIs by canonical sender", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const kept = createEmail(provider.id, {
      from: '"Ops Team" <ops@example.com>',
      to: "kept@example.com",
      subject: "REST kept",
      text: "hello",
    });
    createEmail(provider.id, {
      from: "other@example.com",
      to: "other@example.com",
      subject: "REST other",
      text: "hello",
    });

    const listed = await json<Array<{ id: string }>>("/api/emails?from=ops@example.com");
    expect(listed.map((item) => item.id)).toEqual([kept.id]);

    const exported = await json<Array<{ id: string }>>("/api/export/emails?format=json&from_address=Ops%20Team%20%3Cops%40example.com%3E");
    expect(exported.map((item) => item.id)).toEqual([kept.id]);
  });

  it("paginates REST sent email search and omits idempotency keys from browse payloads", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const db = getDatabase();
    for (let i = 0; i < 4; i++) {
      const email = createEmail(provider.id, {
        from: "ops@example.com",
        to: `user-${i}@example.com`,
        subject: `REST searchable ${i}`,
        text: "hello",
        idempotency_key: `rest-secret-${i}`,
      });
      db.run("UPDATE emails SET sent_at = ?, created_at = ?, updated_at = ? WHERE id = ?", [
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        email.id,
      ]);
    }

    const listed = await json<Array<Record<string, unknown>>>("/api/emails?limit=2&offset=1");
    expect(listed.map((item) => item.subject)).toEqual(["REST searchable 2", "REST searchable 1"]);
    expect(listed[0]).not.toHaveProperty("idempotency_key");
    expect(JSON.stringify(listed)).not.toContain("rest-secret");

    const searched = await json<Array<Record<string, unknown>>>("/api/emails/search?q=searchable&limit=2&offset=1");
    expect(searched.map((item) => item.subject)).toEqual(["REST searchable 2", "REST searchable 1"]);
    expect(searched[0]).not.toHaveProperty("idempotency_key");
    expect(JSON.stringify(searched)).not.toContain("rest-secret");
  });

  it("normalizes bad REST list limits before calling data APIs", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    for (let i = 0; i < 3; i++) {
      const email = createEmail(provider.id, {
        from: "ops@example.com",
        to: `user-${i}@example.com`,
        subject: `REST limit ${i}`,
        text: "hello",
      });
      saveTriage({ email_id: email.id, label: "fyi", priority: 3 });
      storeInboundEmail({
        provider_id: provider.id,
        message_id: `<limit-${i}@example.com>`,
        from_address: `user-${i}@example.com`,
        to_addresses: ["ops@example.com"],
        cc_addresses: [],
        subject: `Inbound limit ${i}`,
        text_body: "reply",
        html_body: null,
        attachments: [],
        headers: {},
        raw_size: 10,
        received_at: `2026-02-0${i + 1}T00:00:00.000Z`,
      });
    }

    expect(await json<Array<unknown>>("/api/emails?limit=0")).toHaveLength(1);
    expect(await json<Array<unknown>>("/api/emails?limit=bad")).toHaveLength(3);
    expect(await json<Array<unknown>>("/api/inbound?limit=0")).toHaveLength(1);
  });

  it("paginates inbound REST results after recipient filtering", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "<inbound-old@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "Inbound old",
      text_body: "reply",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 10,
      received_at: "2026-02-01T00:00:00.000Z",
    });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "<inbound-mid@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "Inbound mid",
      text_body: "reply",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 10,
      received_at: "2026-02-02T00:00:00.000Z",
    });
    storeInboundEmail({
      provider_id: provider.id,
      message_id: "<inbound-new@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["other@example.com"],
      cc_addresses: [],
      subject: "Inbound other",
      text_body: "reply",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 10,
      received_at: "2026-02-03T00:00:00.000Z",
    });

    const page = await json<Array<{ subject: string; to_addresses: string[] }>>("/api/inbound?to=ops@example.com&limit=1&offset=1");

    expect(page.map((email) => email.subject)).toEqual(["Inbound old"]);
    expect(page.every((email) => email.to_addresses.includes("ops@example.com"))).toBe(true);
  });

  it("paginates sandbox REST results after provider filtering", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const other = createProvider({ name: "other", type: "sandbox", active: true });
    for (const [providerId, subject, createdAt] of [
      [provider.id, "Sandbox old", "2026-02-01T00:00:00.000Z"],
      [provider.id, "Sandbox mid", "2026-02-02T00:00:00.000Z"],
      [provider.id, "Sandbox new", "2026-02-03T00:00:00.000Z"],
      [other.id, "Sandbox other", "2026-02-04T00:00:00.000Z"],
    ] as Array<[string, string, string]>) {
      const email = storeSandboxEmail({
        provider_id: providerId,
        from_address: "ops@example.com",
        to_addresses: ["user@example.com"],
        cc_addresses: [],
        bcc_addresses: [],
        reply_to: null,
        subject,
        html: null,
        text_body: "hello",
        attachments: [],
        headers: {},
      });
      db.run("UPDATE sandbox_emails SET created_at = ? WHERE id = ?", [createdAt, email.id]);
    }

    const page = await json<Array<Record<string, unknown>>>(`/api/sandbox?provider_id=${provider.id}&limit=1&offset=1`);

    expect(page).toHaveLength(1);
    expect(page[0]?.provider_id).toBe(provider.id);
    expect(page[0]?.subject).toBe("Sandbox mid");
    expect(page[0]).not.toHaveProperty("html");
    expect(page[0]).not.toHaveProperty("text_body");
    expect(page[0]).not.toHaveProperty("headers");
  });

  it("paginates enriched addresses before returning REST results", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const other = createProvider({ name: "other", type: "sandbox", active: true });
    for (let i = 0; i < 5; i++) {
      createAddress({ provider_id: provider.id, email: `ops-${i}@example.com` });
    }
    createAddress({ provider_id: other.id, email: "other@example.com" });

    const page = await json<Array<{ email: string; provider_id: string }>>(`/api/addresses?provider_id=${provider.id}&limit=2&offset=1`);

    expect(page).toHaveLength(2);
    expect(page.every((address) => address.provider_id === provider.id)).toBe(true);
    expect(page.map((address) => address.email)).not.toContain("other@example.com");
  });

  it("paginates domains before returning REST results", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    const other = createProvider({ name: "other", type: "sandbox", active: true });
    for (let i = 0; i < 5; i++) {
      createDomain(provider.id, `domain-${i}.example.com`);
    }
    createDomain(other.id, "other.example.com");

    const page = await json<Array<{ domain: string; provider_id: string }>>(`/api/domains?provider_id=${provider.id}&limit=2&offset=1`);

    expect(page).toHaveLength(2);
    expect(page.every((domain) => domain.provider_id === provider.id)).toBe(true);
    expect(page.map((domain) => domain.domain)).not.toContain("other.example.com");
  });

  it("serves typed domain readiness summaries and mutations", async () => {
    const previousMode = process.env["EMAILS_MODE"];
    process.env["EMAILS_MODE"] = "local";
    try {
      const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
      const domain = createDomain(provider.id, "readiness.example.com");
      updateDnsStatus(domain.id, "verified", "verified", "pending");
      updateDomainReadiness(domain.id, { inbound_status: "ready", outbound_status: "ready" });

      const list = await json<Array<{ id: string; readiness: { send_ready: boolean; receive_ready: boolean; outbound_ready: boolean }; provider: { name: string } }>>(`/api/domains/readiness?provider_id=${provider.id}`);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: domain.id,
        provider: { name: "sandbox" },
        readiness: { send_ready: true, receive_ready: true, outbound_ready: true },
      });

      const detail = await json<{ id: string; dns: { missing_records: string[] } }>(`/api/domains/${domain.id}/readiness`);
      expect(detail.id).toBe(domain.id);
      expect(detail.dns.missing_records).toContain("DMARC");

      const disabled = await json<{ outbound_status: string; readiness: { outbound_ready: boolean; restricted: boolean } }>(
        `/api/domains/${domain.id}/readiness`,
        postJson(`/api/domains/${domain.id}/readiness`, { outbound_status: "disabled" }),
      );
      expect(disabled.outbound_status).toBe("disabled");
      expect(disabled.readiness.outbound_ready).toBe(false);
      expect(disabled.readiness.restricted).toBe(true);

      const invalid = await call(`/api/domains/${domain.id}/readiness`, postJson(`/api/domains/${domain.id}/readiness`, { outbound_status: "bogus" }));
      expect(invalid.status).toBe(400);
    } finally {
      if (previousMode === undefined) delete process.env["EMAILS_MODE"];
      else process.env["EMAILS_MODE"] = previousMode;
    }
  });

  it("defaults REST collection endpoints to bounded pages", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });

    for (let i = 0; i < 101; i++) {
      createAddress({ provider_id: provider.id, email: `default-address-${i}@example.com` });
      createDomain(provider.id, `default-domain-${i}.example.com`);
      upsertContact(`default-contact-${i}@example.com`);
      createTemplate({ name: `default-template-${i}`, subject_template: `Template ${i}` });
      createGroup(`default-group-${i}`);
      createScheduledEmail({
        provider_id: provider.id,
        from_address: "ops@example.com",
        to_addresses: [`default-scheduled-${i}@example.com`],
        subject: `Default scheduled ${i}`,
        scheduled_at: `2030-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
      createSequence({ name: `default-sequence-${i}` });
    }

    const members = createGroup("default-member-page");
    for (let i = 0; i < 101; i++) {
      addMember(members.id, `default-member-${i}@example.com`);
    }

    const enrollments = createSequence({ name: "default-enrollment-page" });
    for (let i = 0; i < 101; i++) {
      enroll({ sequence_id: enrollments.id, contact_email: `default-enrollment-${i}@example.com` });
    }

    for (let i = 0; i < 51; i++) {
      createWarmingSchedule({ domain: `default-warm-${i}.example.com`, target_daily_volume: 100 });
    }

    expect(await json<Array<unknown>>(`/api/addresses?provider_id=${provider.id}`)).toHaveLength(100);
    expect(await json<Array<unknown>>(`/api/domains?provider_id=${provider.id}`)).toHaveLength(100);
    expect(await json<Array<unknown>>("/api/contacts")).toHaveLength(100);
    expect(await json<Array<unknown>>("/api/templates")).toHaveLength(100);
    expect(await json<Array<unknown>>("/api/groups")).toHaveLength(100);
    expect(await json<Array<unknown>>(`/api/groups/${members.id}/members`)).toHaveLength(100);
    expect(await json<Array<unknown>>("/api/scheduled")).toHaveLength(100);
    expect(await json<Array<unknown>>("/api/sequences")).toHaveLength(100);
    expect(await json<Array<unknown>>(`/api/sequences/${enrollments.id}/enrollments`)).toHaveLength(100);
    expect(await json<Array<unknown>>("/api/warming")).toHaveLength(50);
  });

  it("paginates contacts after REST suppression filtering", async () => {
    for (let i = 0; i < 5; i++) {
      suppressContact(`suppressed-${i}@example.com`);
    }
    upsertContact("active@example.com");

    const page = await json<Array<{ email: string; suppressed: boolean }>>("/api/contacts?suppressed=true&limit=2&offset=1");

    expect(page).toHaveLength(2);
    expect(page.every((contact) => contact.suppressed)).toBe(true);
    expect(page.map((contact) => contact.email)).not.toContain("active@example.com");
  });

  it("paginates templates before returning REST results", async () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      const template = createTemplate({
        name: `template-${i}`,
        subject_template: `Template ${i}`,
        html_template: `<main>${`REST template hidden html ${i} `.repeat(100)}</main>`,
        text_template: `REST template hidden text ${i} `.repeat(100),
      });
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE templates SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, template.id]);
    }

    const page = await json<Array<Record<string, unknown>>>("/api/templates?limit=2&offset=1");

    expect(page.map((template) => template.name)).toEqual(["template-3", "template-2"]);
    expect(page[0]).not.toHaveProperty("html_template");
    expect(page[0]).not.toHaveProperty("text_template");
    expect(JSON.stringify(page)).not.toContain("REST template hidden");
  });

  it("paginates scheduled emails after REST status filtering", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox", active: true });
    for (let i = 0; i < 5; i++) {
      createScheduledEmail({
        provider_id: provider.id,
        from_address: "ops@example.com",
        to_addresses: [`pending-${i}@example.com`],
        subject: `Pending ${i}`,
        html: `<p>${`REST hidden html ${i} `.repeat(100)}</p>`,
        text_body: `REST hidden text ${i} `.repeat(100),
        attachments_json: [{ filename: `hidden-${i}.txt`, content: `REST hidden attachment ${i}`.repeat(100) }],
        template_vars: { hidden: `REST hidden vars ${i}`.repeat(100) },
        scheduled_at: `2030-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const sent = createScheduledEmail({
      provider_id: provider.id,
      from_address: "ops@example.com",
      to_addresses: ["sent@example.com"],
      subject: "Sent",
      scheduled_at: "2030-01-01T12:00:00.000Z",
    });
    markSent(sent.id);

    const page = await json<Array<Record<string, unknown>>>("/api/scheduled?status=pending&limit=2&offset=1");

    expect(page).toHaveLength(2);
    expect(page.every((email) => email.status === "pending")).toBe(true);
    expect(page.map((email) => email.subject)).not.toContain("Sent");
    expect(page[0]).not.toHaveProperty("html");
    expect(page[0]).not.toHaveProperty("text_body");
    expect(page[0]).not.toHaveProperty("attachments_json");
    expect(page[0]).not.toHaveProperty("template_vars");
    expect(JSON.stringify(page)).not.toContain("REST hidden");
  });

  it("paginates warming schedules after REST status filtering", async () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const schedule = createWarmingSchedule({ domain: `warm-${i}.example.com`, target_daily_volume: 100 });
      db.run("UPDATE warming_schedules SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, schedule.id]);
    }
    updateWarmingStatus("warm-4.example.com", "paused");

    const page = await json<Array<{ domain: string; status: string }>>("/api/warming?status=active&limit=2&offset=1");

    expect(page.map((schedule) => schedule.domain)).toEqual(["warm-2.example.com", "warm-1.example.com"]);
    expect(page.every((schedule) => schedule.status === "active")).toBe(true);
  });

  it("paginates groups before returning REST results", async () => {
    createGroup("gamma");
    createGroup("alpha");
    createGroup("delta");
    createGroup("beta");

    const page = await json<Array<{ name: string }>>("/api/groups?limit=2&offset=1");

    expect(page.map((group) => group.name)).toEqual(["beta", "delta"]);
  });

  it("paginates group members before returning REST results", async () => {
    const group = createGroup("rest-members");
    addMember(group.id, "dave@example.com");
    addMember(group.id, "charlie@example.com");
    addMember(group.id, "alice@example.com");
    addMember(group.id, "bob@example.com", "Bob", { hidden: "REST hidden group vars ".repeat(100) });

    const page = await json<Array<Record<string, unknown>>>("/api/groups/rest-members/members?limit=2&offset=1");

    expect(page.map((member) => member.email)).toEqual([
      "bob@example.com",
      "charlie@example.com",
    ]);
    expect(page[0]).not.toHaveProperty("vars");
    expect(JSON.stringify(page)).not.toContain("REST hidden group vars");

    const detail = await json<Record<string, unknown>>("/api/groups/rest-members/members/bob%40example.com");
    expect(detail.vars).toEqual({ hidden: "REST hidden group vars ".repeat(100) });
  });

  it("resolves encoded group names in REST member routes", async () => {
    const group = createGroup("rest members/name");
    addMember(group.id, "alice@example.com", "Alice", { role: "ops" });
    const encoded = encodeURIComponent(group.name);

    const members = await json<Array<{ email: string }>>(`/api/groups/${encoded}/members`);
    expect(members.map((member) => member.email)).toEqual(["alice@example.com"]);

    const detail = await json<Record<string, unknown>>(`/api/groups/${encoded}/members/alice%40example.com`);
    expect(detail).toMatchObject({ email: "alice@example.com", vars: { role: "ops" } });
  });

  it("paginates sequences before returning REST results", async () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      const sequence = createSequence({ name: `sequence-${i}` });
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE sequences SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, sequence.id]);
    }

    const page = await json<Array<{ name: string }>>("/api/sequences?limit=2&offset=1");

    expect(page.map((sequence) => sequence.name)).toEqual(["sequence-3", "sequence-2"]);
  });

  it("paginates sequence enrollments after REST sequence and status filtering", async () => {
    const db = getDatabase();
    const sequence = createSequence({ name: "rest-enrollment-page" });
    const other = createSequence({ name: "rest-other-enrollment-page" });
    for (let i = 0; i < 5; i++) {
      const email = `active-${i}@example.com`;
      enroll({ sequence_id: sequence.id, contact_email: email });
      db.run(
        "UPDATE sequence_enrollments SET enrolled_at = ? WHERE sequence_id = ? AND contact_email = ?",
        [`2026-01-0${i + 1}T00:00:00.000Z`, sequence.id, email],
      );
    }
    enroll({ sequence_id: sequence.id, contact_email: "cancelled@example.com" });
    unenroll(sequence.id, "cancelled@example.com");
    db.run(
      "UPDATE sequence_enrollments SET enrolled_at = ? WHERE sequence_id = ? AND contact_email = ?",
      ["2026-01-10T00:00:00.000Z", sequence.id, "cancelled@example.com"],
    );
    enroll({ sequence_id: other.id, contact_email: "other@example.com" });
    db.run(
      "UPDATE sequence_enrollments SET enrolled_at = ? WHERE sequence_id = ? AND contact_email = ?",
      ["2026-01-11T00:00:00.000Z", other.id, "other@example.com"],
    );

    const page = await json<Array<{ contact_email: string; sequence_id: string; status: string }>>(
      `/api/sequences/${sequence.id}/enrollments?status=active&limit=2&offset=1`,
    );

    expect(page.map((enrollment) => enrollment.contact_email)).toEqual([
      "active-3@example.com",
      "active-2@example.com",
    ]);
    expect(page.every((enrollment) => enrollment.sequence_id === sequence.id)).toBe(true);
    expect(page.every((enrollment) => enrollment.status === "active")).toBe(true);
  });

  it("resolves encoded sequence names in REST sequence routes", async () => {
    const sequence = createSequence({ name: "rest sequence/name" });
    enroll({ sequence_id: sequence.id, contact_email: "alice@example.com" });
    const encoded = encodeURIComponent(sequence.name);

    const enrollments = await json<Array<{ contact_email: string; sequence_id: string }>>(
      `/api/sequences/${encoded}/enrollments`,
    );

    expect(enrollments).toContainEqual(expect.objectContaining({
      contact_email: "alice@example.com",
      sequence_id: sequence.id,
    }));
  });
});
