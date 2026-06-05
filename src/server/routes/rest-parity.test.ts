import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAddress } from "../../db/addresses.js";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createDomain } from "../../db/domains.js";
import { createEmail } from "../../db/emails.js";
import { createEvent } from "../../db/events.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { createProvider } from "../../db/providers.js";
import { storeSandboxEmail } from "../../db/sandbox.js";
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
    storeInboundEmail({
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
    expect(providers[0]?.api_key).toBe("***");
    expect(JSON.stringify(providers)).not.toContain("REST_PARITY_SECRET");

    const domains = await json<Array<{ id: string; domain: string }>>(`/api/domains?provider_id=${provider.id}`);
    expect(domains).toEqual([{ ...domain, verified_at: null }]);

    const addresses = await json<Array<{ id: string; email: string }>>(`/api/addresses?provider_id=${provider.id}`);
    expect(addresses[0]).toMatchObject({ id: address.id, email: "ops@example.com" });

    const emails = await json<Array<{ id: string; subject: string }>>(`/api/emails?provider_id=${provider.id}`);
    expect(emails[0]).toMatchObject({ id: email.id, subject: "REST smoke" });

    const inbound = await json<Array<{ subject: string }>>("/api/inbound?to=ops@example.com");
    expect(inbound[0]?.subject).toBe("Inbound smoke");

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
    expect(await json<Array<{ name: string }>>("/api/templates")).toContainEqual(expect.objectContaining({ name: "welcome" }));

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
});
