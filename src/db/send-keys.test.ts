import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import { createAddress } from "./addresses.js";
import { createOwner, assignAddressOwner } from "./owners.js";
import {
  createSendKey, verifySendKey, listSendKeys, revokeSendKey,
  canOwnerSendFrom, assertSendAuthorized,
} from "./send-keys.js";

let providerId: string;
beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "ses", type: "ses" }).id;
});
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("send keys — issue / verify", () => {
  it("issues a token once and verifies it by hash", () => {
    const agent = createOwner({ type: "agent", name: "Caesar" });
    const { token, key } = createSendKey(agent.id, "ci");
    expect(token).toMatch(/^esk_/);
    expect(key.prefix).toBe(token.slice(0, 12));
    expect(key.label).toBe("ci");
    const v = verifySendKey(token);
    expect(v?.id).toBe(key.id);
    expect(v?.owner_id).toBe(agent.id);
  });

  it("rejects an unknown or malformed token", () => {
    expect(verifySendKey("esk_nope")).toBeNull();
    expect(verifySendKey("garbage")).toBeNull();
  });

  it("revoked keys no longer verify", () => {
    const agent = createOwner({ type: "agent", name: "Nero" });
    const { token, key } = createSendKey(agent.id);
    expect(verifySendKey(token)).not.toBeNull();
    revokeSendKey(key.id);
    expect(verifySendKey(token)).toBeNull();
    expect(listSendKeys(agent.id)[0]!.revoked_at).toBeTruthy();
  });
});

describe("send keys — scope enforcement", () => {
  it("agent can send from an address it owns, not from others", () => {
    const agent = createOwner({ type: "agent", name: "Brutus" });
    const mine = createAddress({ provider_id: providerId, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    createAddress({ provider_id: providerId, email: "other@x.com" });
    expect(canOwnerSendFrom(agent.id, "ops@x.com")).toBe(true);
    expect(canOwnerSendFrom(agent.id, "other@x.com")).toBe(false);
    expect(canOwnerSendFrom(agent.id, "unregistered@x.com")).toBe(false);
  });

  it("agent administering a human-owned address can send from it", () => {
    const human = createOwner({ type: "human", name: "Andrei" });
    const agent = createOwner({ type: "agent", name: "Tiberius" });
    const addr = createAddress({ provider_id: providerId, email: "andrei@x.com" });
    assignAddressOwner(addr.id, human.id, agent.id);
    expect(canOwnerSendFrom(agent.id, "andrei@x.com")).toBe(true);
  });

  it("assertSendAuthorized throws for an out-of-scope from address", () => {
    const agent = createOwner({ type: "agent", name: "Cato" });
    const mine = createAddress({ provider_id: providerId, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    const { token } = createSendKey(agent.id);
    expect(assertSendAuthorized(token, "ops@x.com").id).toBe(agent.id);
    expect(() => assertSendAuthorized(token, "evil@x.com")).toThrow(/not authorized/i);
    expect(() => assertSendAuthorized("esk_bogus", "ops@x.com")).toThrow(/invalid|revoked/i);
  });

  it("assertSendAuthorized accepts a From with a display name", () => {
    const agent = createOwner({ type: "agent", name: "Livia" });
    const mine = createAddress({ provider_id: providerId, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    const { token } = createSendKey(agent.id);
    expect(assertSendAuthorized(token, "Ops Team <ops@x.com>").id).toBe(agent.id);
  });
});

describe("send keys — From-spoofing resistance", () => {
  it("denies a double angle-addr From even if the bracketed addr is owned", () => {
    const agent = createOwner({ type: "agent", name: "Galba" });
    const mine = createAddress({ provider_id: providerId, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    // attacker owns ops@x.com but smuggles victim@y.com as a second angle-addr
    expect(canOwnerSendFrom(agent.id, "x <ops@x.com> <victim@y.com>")).toBe(false);
  });

  it("matches case-insensitively on a clean From", () => {
    const agent = createOwner({ type: "agent", name: "Otho" });
    const mine = createAddress({ provider_id: providerId, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    expect(canOwnerSendFrom(agent.id, "OPS@X.COM")).toBe(true);
    expect(canOwnerSendFrom(agent.id, "Ops Team <Ops@X.com>")).toBe(true);
  });
});
