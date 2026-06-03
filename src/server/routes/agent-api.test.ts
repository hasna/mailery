import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createAddress } from "../../db/addresses.js";
import { createOwner, assignAddressOwner } from "../../db/owners.js";
import { createSendKey } from "../../db/send-keys.js";
import { storeInboundEmail } from "../../db/inbound.js";
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
    const res = (await call(req("/api/v1/addresses")))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.name).toBe("Trajan");
    expect(body.owned.map((a: { email: string }) => a.email)).toContain("trajan@x.com");
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
    storeInboundEmail({ provider_id: null, message_id: "<a@x>", from_address: "ext@x.com", to_addresses: ["trajan@x.com"], cc_addresses: [], subject: "mine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    storeInboundEmail({ provider_id: null, message_id: "<b@x>", from_address: "ext@x.com", to_addresses: ["stranger@x.com"], cc_addresses: [], subject: "notmine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    const res = (await call(req("/api/v1/inbox")))!;
    const body = await res.json();
    expect(body.map((m: { subject: string }) => m.subject)).toEqual(["mine"]);
  });

  it("reads one inbound email and marks it read; forbids others", async () => {
    const mine = storeInboundEmail({ provider_id: null, message_id: "<a@x>", from_address: "ext@x.com", to_addresses: ["trajan@x.com"], cc_addresses: [], subject: "mine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    const other = storeInboundEmail({ provider_id: null, message_id: "<b@x>", from_address: "ext@x.com", to_addresses: ["stranger@x.com"], cc_addresses: [], subject: "notmine", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1, received_at: new Date().toISOString() });
    const res = (await call(req(`/api/v1/inbox/${mine.id}`)))!;
    expect(res.status).toBe(200);
    expect((await res.json()).is_read).toBe(true);
    const forb = (await call(req(`/api/v1/inbox/${other.id}`)))!;
    expect(forb.status).toBe(403);
  });
});
