// End-to-end proof that the resource repositories route WRITES to the selfHosted /v1
// API in selfHosted mode (not the local SQLite island) — the write half of the
// split-brain fix. Reads were already routed (see self-hosted-resource-routing.test.ts);
// this covers createOwner, createGroup, and contact suppress/unsuppress, plus
// send-key minting (which POSTs to the bespoke /v1/send-keys/mint endpoint — the
// token/hash are server-minted and only a hash-free key summary reaches the client).
//
// A stateful stub /v1 server runs OUT OF PROCESS (the repo layer's selfHosted client
// is synchronous curl, which cannot reach an in-process Bun.serve). The local DB
// is left empty so a local write could not masquerade as the selfHosted state asserted.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { resetSelfHostedConfigCache } from "./self-hosted-store.js";
import { createOwner, listOwners } from "./owners.js";
import { createGroup, listGroups } from "./groups.js";
import { suppressContact, unsuppressContact, listContacts } from "./contacts.js";
import { createSendKey } from "./send-keys.js";
import { createTemplate, listTemplates, getTemplate, deleteTemplate } from "./templates.js";
import { createSequence, listSequences } from "./sequences.js";

const SERVER_CODE = `
const owners = [];
const groups = [];
const contacts = [];
const templates = [];
const sequences = [];
const sendKeys = [];
let seq = 0;
const nid = (p) => p + (++seq);
const now = "2026-01-01T00:00:00Z";
const server = Bun.serve({ port: 0, async fetch(req) {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const ok = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const body = (m === "POST" || m === "PATCH") ? await req.json().catch(() => ({})) : {};

  if (p === "/v1/owners" && m === "GET") return ok({ items: owners });
  if (p === "/v1/owners" && m === "POST") {
    const o = { id: nid("o"), type: body.type, name: body.name, contact_email: body.contact_email ?? null, external_id: body.external_id ?? null, created_at: now, updated_at: now };
    owners.push(o);
    return ok(o, 201);
  }

  if (p === "/v1/groups" && m === "GET") return ok({ items: groups });
  if (p === "/v1/groups" && m === "POST") {
    const g = { id: nid("g"), name: body.name, description: body.description ?? null, created_at: now, updated_at: now };
    groups.push(g);
    return ok(g, 201);
  }

  if (p === "/v1/contacts" && m === "GET") {
    const email = url.searchParams.get("email");
    const items = email ? contacts.filter((c) => c.email === email) : contacts;
    return ok({ items });
  }
  if (p === "/v1/contacts" && m === "POST") {
    const c = { id: nid("c"), email: body.email, name: body.name ?? null, send_count: 0, bounce_count: 0, complaint_count: 0, last_sent_at: null, suppressed: !!body.suppressed, created_at: now, updated_at: now };
    contacts.push(c);
    return ok(c, 201);
  }
  if (p === "/v1/templates" && m === "GET") return ok({ items: templates });
  if (p === "/v1/templates" && m === "POST") {
    const t = { id: nid("t"), name: body.name, subject_template: body.subject_template, html_template: body.html_template ?? null, text_template: body.text_template ?? null, metadata: body.metadata ?? {}, created_at: now, updated_at: now };
    templates.push(t);
    return ok(t, 201);
  }
  const tm = p.match(/^\\/v1\\/templates\\/([^/]+)$/);
  if (tm && m === "GET") {
    const t = templates.find((x) => x.id === tm[1]);
    return t ? ok(t, 200) : ok({ error: "not found" }, 404);
  }
  if (tm && m === "DELETE") {
    const i = templates.findIndex((x) => x.id === tm[1]);
    if (i < 0) return ok({ error: "not found" }, 404);
    templates.splice(i, 1);
    return ok({ deleted: true, id: tm[1] }, 200);
  }

  if (p === "/v1/sequences" && m === "GET") return ok({ items: sequences });
  if (p === "/v1/sequences" && m === "POST") {
    const s = { id: nid("s"), name: body.name, description: body.description ?? null, status: body.status ?? "active", created_at: now, updated_at: now };
    sequences.push(s);
    return ok(s, 201);
  }

  if (p === "/v1/send-keys" && m === "GET") return ok({ items: sendKeys });
  if (p === "/v1/send-keys/mint" && m === "POST") {
    const k = { id: nid("sk"), owner_id: body.owner_id, prefix: "esk_stubpref", label: body.label ?? null, last_used_at: null, revoked_at: null, created_at: now, updated_at: now };
    sendKeys.push(k);
    return ok({ token: "esk_stub_" + k.id, key: k }, 201);
  }

  const cm = p.match(/^\\/v1\\/contacts\\/([^/]+)$/);
  if (cm && m === "PATCH") {
    const c = contacts.find((x) => x.id === cm[1]);
    if (!c) return ok({ error: "not found" }, 404);
    if ("suppressed" in body) c.suppressed = !!body.suppressed;
    return ok(c, 200);
  }

  return ok({ error: "not found" }, 404);
} });
console.log("PORT " + server.port);
`;

let proc: Subprocess;
let baseUrl: string;

beforeAll(async () => {
  proc = Bun.spawn(["bun", "-e", SERVER_CODE], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10000;
  while (!buf.includes("\n") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  reader.releaseLock();
  const port = buf.match(/PORT (\d+)/)?.[1];
  if (!port) throw new Error(`stub server did not report a port: ${buf}`);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => proc?.kill());

beforeEach(() => {
  process.env.EMAILS_MODE = "self_hosted";
  process.env.EMAILS_SELF_HOSTED_URL = baseUrl;
  process.env.EMAILS_SELF_HOSTED_API_KEY = "test_key";
  resetSelfHostedConfigCache();
});

afterEach(() => {
  delete process.env.EMAILS_MODE;
  delete process.env.EMAILS_SELF_HOSTED_URL;
  delete process.env.EMAILS_SELF_HOSTED_API_KEY;
  resetSelfHostedConfigCache();
});

describe("resource repos route writes to selfHosted in selfHosted mode", () => {
  test("createOwner POSTs to /v1/owners and appears in selfHosted listOwners", () => {
    const o = createOwner({ type: "agent", name: "Writer Agent" });
    expect(o.id).toStartWith("o");
    expect(o.name).toBe("Writer Agent");
    // The registered owner is now visible via the selfHosted read path (not just a
    // local id that never reaches the selfHosted — the split-brain symptom).
    expect(listOwners().some((x) => x.id === o.id)).toBe(true);
  });

  test("createGroup POSTs to /v1/groups and appears in selfHosted listGroups", () => {
    const g = createGroup("writer-group", "desc");
    expect(g.id).toStartWith("g");
    expect(listGroups().some((x) => x.name === "writer-group")).toBe(true);
  });

  test("suppressContact creates-then-suppresses on the selfHosted and shows in selfHosted list", () => {
    suppressContact("blocked@example.com");
    const suppressed = listContacts({ suppressed: true });
    expect(suppressed.map((c) => c.email)).toContain("blocked@example.com");
    // Idempotent unsuppress flips the same selfHosted record (no duplicate contact).
    unsuppressContact("blocked@example.com");
    expect(listContacts({ suppressed: true }).map((c) => c.email)).not.toContain("blocked@example.com");
    expect(listContacts().filter((c) => c.email === "blocked@example.com")).toHaveLength(1);
  });

  test("createTemplate POSTs to /v1/templates and appears in selfHosted listTemplates", () => {
    const t = createTemplate({ name: "welcome", subject_template: "Hi {{name}}", html_template: "<p>hi</p>" });
    expect(t.id).toStartWith("t");
    expect(t.subject_template).toBe("Hi {{name}}");
    expect(listTemplates().some((x) => x.name === "welcome")).toBe(true);
  });

  test("getTemplate/deleteTemplate route show+remove to selfHosted (by name and id)", () => {
    const t = createTemplate({ name: "farewell", subject_template: "Bye {{name}}" });
    // show by id AND by name both resolve against the selfHosted, not the empty local DB.
    expect(getTemplate(t.id)?.name).toBe("farewell");
    expect(getTemplate("farewell")?.id).toBe(t.id);
    // remove deletes the selfHosted record (resolving name -> id first).
    expect(deleteTemplate("farewell")).toBe(true);
    expect(getTemplate("farewell")).toBeNull();
    expect(listTemplates().some((x) => x.name === "farewell")).toBe(false);
  });

  test("createSequence POSTs to /v1/sequences and appears in selfHosted listSequences", () => {
    const s = createSequence({ name: "onboarding", description: "drip" });
    expect(s.id).toStartWith("s");
    expect(s.status).toBe("active");
    expect(listSequences().some((x) => x.name === "onboarding")).toBe(true);
  });

  test("createSendKey POSTs to /v1/send-keys/mint and returns a hash-free key", () => {
    const owner = createOwner({ type: "agent", name: "Key Owner" });
    const { token, key } = createSendKey(owner.id, "ci");
    // The token is server-minted (routed to the selfHosted, not a local island).
    expect(token).toStartWith("esk_");
    expect(key.owner_id).toBe(owner.id);
    expect(key.label).toBe("ci");
    // The client never receives the secret hash.
    expect(key.key_hash).toBe("");
  });
});
