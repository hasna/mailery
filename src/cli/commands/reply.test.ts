import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createEmail } from "../../db/emails.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { resolveInboundOrSent } from "./reply.js";

let providerId: string;
beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox" }).id;
});
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("resolveInboundOrSent — reply/forward id resolution", () => {
  it("resolves a SENT email id (regression: previously process.exit via resolveId)", () => {
    const db = getDatabase();
    const sent = createEmail(providerId, { from: "me@x.com", to: "y@x.com", subject: "hi" }, "mid-1", db);
    const r = resolveInboundOrSent(sent.id, db);
    expect(r.sent?.id).toBe(sent.id);
    expect(r.inbound).toBeNull();
    // also by 8-char prefix
    expect(resolveInboundOrSent(sent.id.slice(0, 8), db).sent?.id).toBe(sent.id);
  });

  it("resolves an INBOUND email id", () => {
    const db = getDatabase();
    const inb = storeInboundEmail({
      provider_id: null, message_id: "<a@x>", from_address: "ext@x.com", to_addresses: ["me@x.com"],
      cc_addresses: [], subject: "hi", text_body: "b", html_body: null, attachments: [], headers: {}, raw_size: 1,
      received_at: new Date().toISOString(),
    }, db);
    const r = resolveInboundOrSent(inb.id, db);
    expect(r.inbound?.id).toBe(inb.id);
    expect(r.sent).toBeNull();
  });

  it("returns both null for an unknown id (no process exit)", () => {
    const r = resolveInboundOrSent("does-not-exist", getDatabase());
    expect(r.inbound).toBeNull();
    expect(r.sent).toBeNull();
  });
});
