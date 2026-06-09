import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createAddress } from "../../db/addresses.js";
import { createOwner, assignAddressOwner } from "../../db/owners.js";
import { createSendKey } from "../../db/send-keys.js";
import { getInboundEmail, storeInboundEmail } from "../../db/inbound.js";
import { handle } from "./agent-api.js";

let providerId: string;
let token: string;
let ownerId: string;

function req(path: string, method = "GET", body?: unknown, auth = token): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers["authorization"] = `Bearer ${auth}`;
  return new Request(`http://x${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const call = (r: Request) => handle(r, new URL(r.url), new URL(r.url).pathname, r.method);

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox" }).id;
  const agent = createOwner({ type: "agent", name: "Trajan" });
  ownerId = agent.id;
  const a = createAddress({ provider_id: providerId, email: "trajan@x.com" });
  assignAddressOwner(a.id, agent.id);
  token = createSendKey(agent.id).token;
});
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("agent-api auth", () => {
  it("rejects requests with no/invalid key", async () => {
    expect((await call(req("/api/v1/addresses", "GET", undefined, "")))!.status).toBe(401);
    expect((await call(req("/api/v1/addresses", "GET", undefined, "esk_bogus")))!.status).toBe(401);
  });

  it("returns null for non-v1 paths", async () => {
    expect(await call(req("/api/providers"))).toBeNull();
  });
});

describe("agent-api addresses + provisioning", () => {
  it("lists the caller's addresses", async () => {
    const human = createOwner({ type: "human", name: "Nerva" });
    const delegated = createAddress({ provider_id: providerId, email: "delegated@x.com" });
    assignAddressOwner(delegated.id, human.id, ownerId);

    const res = (await call(req("/api/v1/addresses")))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.name).toBe("Trajan");
    expect(body.owned.map((a: { email: string }) => a.email)).toContain("trajan@x.com");
    expect(body.administered.map((a: { email: string }) => a.email)).toEqual(["delegated@x.com"]);
    expect(body.administered.map((a: { email: string }) => a.email)).not.toContain("trajan@x.com");
  });

  it("paginates the caller's owned and administered address lists", async () => {
    const db = getDatabase();
    db.run("UPDATE addresses SET created_at = ? WHERE email = ?", ["2026-01-01T00:00:00.000Z", "trajan@x.com"]);
    for (let i = 1; i <= 3; i++) {
      const address = createAddress({ provider_id: providerId, email: `owned-${i}@x.com` });
      assignAddressOwner(address.id, ownerId);
      db.run("UPDATE addresses SET created_at = ? WHERE id = ?", [`2026-01-0${i + 1}T00:00:00.000Z`, address.id]);
    }
    const human = createOwner({ type: "human", name: "Hadrian" });
    for (let i = 1; i <= 3; i++) {
      const address = createAddress({ provider_id: providerId, email: `delegated-${i}@x.com` });
      assignAddressOwner(address.id, human.id, ownerId);
      db.run("UPDATE addresses SET created_at = ? WHERE id = ?", [`2026-02-0${i}T00:00:00.000Z`, address.id]);
    }

    const res = (await call(req("/api/v1/addresses?limit=2&offset=1")))!;
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.owned.map((a: { email: string }) => a.email)).toEqual(["owned-2@x.com", "owned-1@x.com"]);
    expect(body.administered.map((a: { email: string }) => a.email)).toEqual(["delegated-2@x.com", "delegated-1@x.com"]);
  });

  it("provisions a new address owned by the caller", async () => {
    const res = (await call(req("/api/v1/provision/address", "POST", { email: "new@x.com", provider_id: providerId })))!;
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe("new@x.com");
    expect(body.owner_id).toBe(ownerId);
    // Now visible in the caller's scope
    const list = await (await call(req("/api/v1/addresses")))!.json();
    expect(list.owned.map((a: { email: string }) => a.email)).toContain("new@x.com");
  });
});

describe("agent-api send", () => {
  it("sends from an owned address", async () => {
    const res = (await call(req("/api/v1/send", "POST", { from: "trajan@x.com", to: "y@x.com", subject: "hi", text: "yo", provider_id: providerId })))!;
    expect(res.status).toBe(201);
    expect((await res.json()).message_id).toBeTruthy();
  });

  it("forbids sending from an address the caller does not own", async () => {
    createAddress({ provider_id: providerId, email: "victim@x.com" });
    const res = (await call(req("/api/v1/send", "POST", { from: "victim@x.com", to: "y@x.com", subject: "hi", text: "yo", provider_id: providerId })))!;
    expect(res.status).toBe(403);
  });

  it("validates required fields", async () => {
    const res = (await call(req("/api/v1/send", "POST", { to: "y@x.com", subject: "hi" })))!;
    expect(res.status).toBe(400);
  });
});

describe("agent-api inbox", () => {
  it("only returns mail addressed to the caller's addresses", async () => {
    storeInboundEmail({ provider_id: null, message_id: "<a@x>", from_address: "ext@x.com", to_addresses: ['"Trajan" <trajan@x.com>'], cc_addresses: [], subject: "mine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    storeInboundEmail({ provider_id: null, message_id: "<b@x>", from_address: "ext@x.com", to_addresses: ["stranger@x.com"], cc_addresses: [], subject: "notmine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    const res = (await call(req("/api/v1/inbox")))!;
    const body = await res.json();
    expect(body.map((m: { subject: string }) => m.subject)).toEqual(["mine"]);
  });

  it("paginates the caller's scoped inbox", async () => {
    storeInboundEmail({ provider_id: null, message_id: "<old@x>", from_address: "ext@x.com", to_addresses: ["trajan@x.com"], cc_addresses: [], subject: "old", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-06-04T11:28:09.000Z" });
    storeInboundEmail({ provider_id: null, message_id: "<middle@x>", from_address: "ext@x.com", to_addresses: ["trajan@x.com"], cc_addresses: [], subject: "middle", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-06-04T11:29:09.000Z" });
    storeInboundEmail({ provider_id: null, message_id: "<new@x>", from_address: "ext@x.com", to_addresses: ["trajan@x.com"], cc_addresses: [], subject: "new", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-06-04T11:30:09.000Z" });

    const res = (await call(req("/api/v1/inbox?limit=1&offset=1")))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((m: { subject: string }) => m.subject)).toEqual(["middle"]);
  });

  it("filters the caller's scoped inbox before applying the result limit", async () => {
    storeInboundEmail({ provider_id: null, message_id: "<recent@x>", from_address: "updates@x.com", to_addresses: ["trajan@x.com"], cc_addresses: [], subject: "recent noise", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-06-04T11:30:09.000Z" });
    storeInboundEmail({ provider_id: null, message_id: "<target@x>", from_address: "security@x.com", to_addresses: ["trajan@x.com"], cc_addresses: [], subject: "target login alert", text_body: "needle body", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-06-04T11:29:09.000Z" });

    const res = (await call(req("/api/v1/inbox?limit=1&search=needle&from=security&subject=target")))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((m: { subject: string }) => m.subject)).toEqual(["target login alert"]);
  });

  it("scopes inbox in SQL even when the owner has many controlled addresses", async () => {
    for (let i = 0; i < 250; i++) {
      const address = createAddress({ provider_id: providerId, email: `bulk-${i}@x.com` });
      assignAddressOwner(address.id, ownerId);
    }
    storeInboundEmail({ provider_id: null, message_id: "<bulk-target@x>", from_address: "ext@x.com", to_addresses: ["bulk-249@x.com"], cc_addresses: [], subject: "bulk owned", text_body: "needle", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-06-04T11:31:09.000Z" });
    storeInboundEmail({ provider_id: null, message_id: "<bulk-other@x>", from_address: "ext@x.com", to_addresses: ["bulk-249@other.com"], cc_addresses: [], subject: "bulk other", text_body: "needle", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: "2026-06-04T11:32:09.000Z" });

    const res = (await call(req("/api/v1/inbox?search=needle&limit=1")))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((m: { subject: string }) => m.subject)).toEqual(["bulk owned"]);
  });

  it("reads one inbound email and marks it read; forbids others", async () => {
    const mine = storeInboundEmail({ provider_id: null, message_id: "<a@x>", from_address: "ext@x.com", to_addresses: ['"Trajan" <trajan@x.com>'], cc_addresses: [], subject: "mine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    const other = storeInboundEmail({ provider_id: null, message_id: "<b@x>", from_address: "ext@x.com", to_addresses: ["stranger@x.com"], cc_addresses: [], subject: "notmine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    const res = (await call(req(`/api/v1/inbox/${mine.id}`)))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is_read).toBe(true);
    expect(body.read_at).toBeTruthy();
    const forb = (await call(req(`/api/v1/inbox/${other.id}`)))!;
    expect(forb.status).toBe(403);
    expect(getInboundEmail(other.id)?.is_read).toBe(false);
  });

  it("rejects ambiguous inbox read IDs before ownership checks", async () => {
    const db = getDatabase();
    const ids = [
      "mail1111-1111-1111-1111-111111111111",
      "mail2222-2222-2222-2222-222222222222",
    ];
    for (const [index, id] of ids.entries()) {
      db.run(
        `INSERT INTO inbound_emails
          (id, message_id, from_address, to_addresses, cc_addresses, subject, text_body, html_body, attachments_json, attachment_paths, headers_json, raw_size, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          `<ambiguous-${index}@x>`,
          "ext@x.com",
          JSON.stringify(["trajan@x.com"]),
          "[]",
          `ambiguous ${index}`,
          "body",
          null,
          "[]",
          "[]",
          "{}",
          1,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ],
      );
    }

    const res = (await call(req("/api/v1/inbox/mail")))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Ambiguous ID 'mail' in table 'inbound_emails'. Use a longer prefix or full ID.",
    });
  });
});

import { createAlias, createCatchAll } from "../../db/aliases.js";

describe("agent-api — provisioning anti-hijack + alias inbox", () => {
  it("409s when provisioning an address another owner already owns", async () => {
    // second owner + key
    const { createOwner } = await import("../../db/owners.js");
    const { createSendKey } = await import("../../db/send-keys.js");
    const other = createOwner({ type: "agent", name: "Nerva" });
    const otherToken = createSendKey(other.id).token;
    // Trajan (default token) owns trajan@x.com already (from beforeEach)
    const res = (await call(req("/api/v1/provision/address", "POST", { email: "trajan@x.com", provider_id: providerId }, otherToken)))!;
    expect(res.status).toBe(409);
  });

  it("surfaces alias- and catch-all-routed mail in /api/v1/inbox", async () => {
    // alias support@x.com -> trajan@x.com (Trajan owns trajan@x.com)
    createAlias("support@x.com", "trajan@x.com");
    createCatchAll("z.com", "trajan@x.com");
    storeInboundEmail({ provider_id: null, message_id: "<s@x>", from_address: "e@e.com", to_addresses: ["support@x.com"], cc_addresses: [], subject: "via-alias", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    storeInboundEmail({ provider_id: null, message_id: "<c@z>", from_address: "e@e.com", to_addresses: ["anything@z.com"], cc_addresses: [], subject: "via-catchall", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    storeInboundEmail({ provider_id: null, message_id: "<n@n>", from_address: "e@e.com", to_addresses: ["stranger@q.com"], cc_addresses: [], subject: "not-mine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    const body = await (await call(req("/api/v1/inbox")))!.json();
    const subs = body.map((m: { subject: string }) => m.subject).sort();
    expect(subs).toContain("via-alias");
    expect(subs).toContain("via-catchall");
    expect(subs).not.toContain("not-mine");
  });
});
