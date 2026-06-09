import { afterEach, describe, expect, it, mock } from "bun:test";
import { EmailsClient } from "./src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

describe("EmailsClient", () => {
  it("normalizes the server URL and sends JSON requests", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";

    installFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method ?? "GET";
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "provider-1",
        name: "dev",
        type: "sandbox",
        active: true,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "http://localhost:3900/" });
    const provider = await client.addProvider({ name: "dev", type: "sandbox" });

    expect(seenUrl).toBe("http://localhost:3900/api/providers");
    expect(seenMethod).toBe("POST");
    expect(JSON.parse(seenBody)).toEqual({ name: "dev", type: "sandbox" });
    expect(provider.id).toBe("provider-1");
  });

  it("serializes query parameters", async () => {
    let seenUrl = "";

    installFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.listEmails({ status: "sent", limit: 5 });

    expect(seenUrl).toBe("https://emails.example/api/emails?status=sent&limit=5");
  });

  it("serializes paging for bounded list surfaces", async () => {
    const seenUrls: string[] = [];

    installFetch((url) => {
      seenUrls.push(url);
      return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.listProviders({ limit: 2, offset: 4 });
    await client.listDomains({ provider_id: "provider 1", limit: 5, offset: 10 });
    await client.listDomains("legacy-provider");
    await client.listAddresses({ provider_id: "provider 1", limit: 7, offset: 8 });
    await client.listContacts({ suppressed: true, limit: 5, offset: 1 });
    await client.listGroups({ limit: 5, offset: 10 });
    await client.listSequences({ limit: 5, offset: 10 });
    await client.listEnrollments("seq 1", { status: "active", limit: 3, offset: 6 });
    await client.listSandboxEmails({ provider_id: "provider 1", limit: 3, offset: 4 });
    await client.listInboundEmails({ provider_id: "provider 1", to: "me@example.com", unread: true, limit: 3, offset: 4 });
    await client.listWarmingSchedules({ status: "active", limit: 3, offset: 4 });

    expect(seenUrls).toEqual([
      "https://emails.example/api/providers?limit=2&offset=4",
      "https://emails.example/api/domains?provider_id=provider+1&limit=5&offset=10",
      "https://emails.example/api/domains?provider_id=legacy-provider",
      "https://emails.example/api/addresses?provider_id=provider+1&limit=7&offset=8",
      "https://emails.example/api/contacts?suppressed=true&limit=5&offset=1",
      "https://emails.example/api/groups?limit=5&offset=10",
      "https://emails.example/api/sequences?limit=5&offset=10",
      "https://emails.example/api/sequences/seq%201/enrollments?status=active&limit=3&offset=6",
      "https://emails.example/api/sandbox?provider_id=provider+1&limit=3&offset=4",
      "https://emails.example/api/inbound?provider_id=provider+1&to=me%40example.com&unread=true&limit=3&offset=4",
      "https://emails.example/api/warming?status=active&limit=3&offset=4",
    ]);
  });

  it("serializes scheduled list paging and keeps the legacy status argument", async () => {
    const seenUrls: string[] = [];

    installFetch((url) => {
      seenUrls.push(url);
      return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.listScheduled({ status: "pending", limit: 5, offset: 10 });
    await client.listScheduled("sent");

    expect(seenUrls).toEqual([
      "https://emails.example/api/scheduled?status=pending&limit=5&offset=10",
      "https://emails.example/api/scheduled?status=sent",
    ]);
  });

  it("serializes template list paging and detail lookup", async () => {
    const seenUrls: string[] = [];

    installFetch((url) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.listTemplates({ limit: 5, offset: 10 });
    await client.getTemplate("welcome email");
    await client.removeTemplate("welcome/email");

    expect(seenUrls).toEqual([
      "https://emails.example/api/templates?limit=5&offset=10",
      "https://emails.example/api/templates/welcome%20email",
      "https://emails.example/api/templates/welcome%2Femail",
    ]);
  });

  it("serializes event list filters and detail lookup", async () => {
    const seenUrls: string[] = [];

    installFetch((url) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.listEvents({
      provider_id: "provider-1",
      type: "clicked",
      until: "2026-01-01T00:00:00.000Z",
      limit: 5,
      offset: 10,
    });
    await client.getEvent("event 1");

    expect(seenUrls).toEqual([
      "https://emails.example/api/events?provider_id=provider-1&type=clicked&until=2026-01-01T00%3A00%3A00.000Z&limit=5&offset=10",
      "https://emails.example/api/events/event%201",
    ]);
  });

  it("serializes group member list paging and detail lookup", async () => {
    const seenUrls: string[] = [];

    installFetch((url) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.listGroupMembers("group 1", { limit: 5, offset: 10 });
    await client.getGroupMember("group 1", "alice@example.com");

    expect(seenUrls).toEqual([
      "https://emails.example/api/groups/group%201/members?limit=5&offset=10",
      "https://emails.example/api/groups/group%201/members/alice%40example.com",
    ]);
  });

  it("serializes group and sequence refs as URL path segments", async () => {
    const seenUrls: string[] = [];

    installFetch((url) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.addGroupMember("group / one", { email: "alice@example.com" });
    await client.removeGroupMember("group / one", "alice@example.com");
    await client.deleteGroup("group / one");
    await client.listSequenceSteps("seq / one");
    await client.addSequenceStep("seq / one", { step_number: 1, delay_hours: 0, template_name: "welcome" });
    await client.enrollContact("seq / one", { contact_email: "alice@example.com" });
    await client.unenrollContact("seq / one", "alice@example.com");
    await client.deleteSequence("seq / one");

    expect(seenUrls).toEqual([
      "https://emails.example/api/groups/group%20%2F%20one/members",
      "https://emails.example/api/groups/group%20%2F%20one/members/alice%40example.com",
      "https://emails.example/api/groups/group%20%2F%20one",
      "https://emails.example/api/sequences/seq%20%2F%20one/steps",
      "https://emails.example/api/sequences/seq%20%2F%20one/steps",
      "https://emails.example/api/sequences/seq%20%2F%20one/enroll",
      "https://emails.example/api/sequences/seq%20%2F%20one/enrollments/alice%40example.com",
      "https://emails.example/api/sequences/seq%20%2F%20one",
    ]);
  });

  it("serializes warming domain refs as URL path segments", async () => {
    const seenUrls: string[] = [];

    installFetch((url) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.getWarmingStatus("warm domain");
    await client.updateWarmingStatus("warm domain", "paused");
    await client.deleteWarmingSchedule("warm domain");

    expect(seenUrls).toEqual([
      "https://emails.example/api/warming/warm%20domain",
      "https://emails.example/api/warming/warm%20domain",
      "https://emails.example/api/warming/warm%20domain",
    ]);
  });

  it("serializes export filters and paging params", async () => {
    const seenUrls: string[] = [];

    installFetch((url) => {
      seenUrls.push(url);
      return new Response("", { headers: { "Content-Type": "text/plain" } });
    });

    const client = new EmailsClient({ serverUrl: "https://emails.example" });
    await client.exportEmails("json", {
      provider_id: "provider 1",
      from_address: "ops@example.com",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T00:00:00.000Z",
      limit: 25,
      offset: 50,
    });
    await client.exportEvents("csv", {
      provider_id: "provider 1",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T00:00:00.000Z",
      limit: 25,
      offset: 50,
    });

    expect(seenUrls).toEqual([
      "https://emails.example/api/export/emails?format=json&provider_id=provider+1&from_address=ops%40example.com&since=2026-01-01T00%3A00%3A00.000Z&until=2026-01-02T00%3A00%3A00.000Z&limit=25&offset=50",
      "https://emails.example/api/export/events?format=csv&provider_id=provider+1&since=2026-01-01T00%3A00%3A00.000Z&until=2026-01-02T00%3A00%3A00.000Z&limit=25&offset=50",
    ]);
  });

  it("throws API error messages from JSON responses", async () => {
    installFetch(() => new Response(JSON.stringify({ error: "no provider" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));

    const client = new EmailsClient({ serverUrl: "https://emails.example" });

    await expect(client.listProviders()).rejects.toThrow("no provider");
  });
});
