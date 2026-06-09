import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import {
  countAddressesForReadiness,
  createAddress,
  findAddressesByEmail,
  getAddress,
  getAddressByEmail,
  listAddressEmails,
  listActiveAddressCountsByDomain,
  listActiveAddressEmails,
  getPreferredActiveAddressEmail,
  listAddresses,
  listAddressesByProviderIds,
  listAddressesForReadiness,
  listUsableSendingAddresses,
  updateAddress,
  deleteAddress,
  markVerified,
} from "./addresses.js";
import { createDomain, updateDnsStatus } from "./domains.js";
import { setAddressProvisioning } from "./provisioning.js";
import { AddressNotFoundError } from "../types/index.js";

let providerId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("createAddress", () => {
  it("creates an address with verified=false", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    expect(a.id).toHaveLength(36);
    expect(a.email).toBe("test@example.com");
    expect(a.provider_id).toBe(providerId);
    expect(a.verified).toBe(false);
    expect(a.display_name).toBeNull();
  });

  it("stores display_name when provided", () => {
    const a = createAddress({ provider_id: providerId, email: "no-reply@example.com", display_name: "No Reply" });
    expect(a.display_name).toBe("No Reply");
  });
});

describe("getAddress", () => {
  it("retrieves address by id", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    const found = getAddress(a.id);
    expect(found?.id).toBe(a.id);
  });

  it("returns null for unknown id", () => {
    expect(getAddress("nonexistent")).toBeNull();
  });
});

describe("getAddressByEmail", () => {
  it("finds address by provider and email", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    const found = getAddressByEmail(providerId, "test@example.com");
    expect(found?.id).toBe(a.id);
  });

  it("returns null for unknown email", () => {
    expect(getAddressByEmail(providerId, "unknown@example.com")).toBeNull();
  });
});

describe("findAddressesByEmail", () => {
  it("finds addresses case-insensitively across providers", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    const first = createAddress({ provider_id: providerId, email: "Ops@Example.com" });
    const second = createAddress({ provider_id: p2.id, email: "ops@example.com" });

    const matches = findAddressesByEmail("OPS@example.COM");
    expect(matches.map((address) => address.id).sort()).toEqual([first.id, second.id].sort());
  });
});

describe("listAddresses", () => {
  it("lists all addresses", () => {
    createAddress({ provider_id: providerId, email: "a@example.com" });
    createAddress({ provider_id: providerId, email: "b@example.com" });
    expect(listAddresses().length).toBe(2);
  });

  it("filters by provider_id", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createAddress({ provider_id: providerId, email: "a@example.com" });
    createAddress({ provider_id: p2.id, email: "b@example.com" });
    expect(listAddresses(providerId).length).toBe(1);
    expect(listAddresses(p2.id).length).toBe(1);
  });

  it("paginates addresses before row hydration", () => {
    for (let i = 0; i < 5; i++) {
      createAddress({ provider_id: providerId, email: `page-${i}@example.com` });
    }

    expect(listAddresses(providerId, undefined, { limit: 2 })).toHaveLength(2);
    expect(listAddresses(providerId, undefined, { limit: 2, offset: 2 })).toHaveLength(2);
  });

  it("lists addresses for multiple providers in one query", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    const first = createAddress({ provider_id: providerId, email: "first@example.com" });
    const second = createAddress({ provider_id: p2.id, email: "second@example.com" });
    createAddress({ provider_id: createProvider({ name: "Unrelated", type: "sandbox" }).id, email: "unrelated@example.com" });

    const addresses = listAddressesByProviderIds([providerId, p2.id, providerId]);

    expect(addresses.map((address) => address.id).sort()).toEqual([first.id, second.id].sort());
    expect(listAddressesByProviderIds([])).toEqual([]);
  });
});

describe("listAddressEmails", () => {
  it("lists email strings without hydrating full address rows", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createAddress({ provider_id: providerId, email: "first@example.com" });
    createAddress({ provider_id: p2.id, email: "second@example.com" });

    expect(listAddressEmails(undefined).sort()).toEqual(["first@example.com", "second@example.com"]);
    expect(listAddressEmails(p2.id)).toEqual(["second@example.com"]);
  });
});

describe("listActiveAddressEmails", () => {
  it("lists active email strings and supports provider filtering", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createAddress({ provider_id: providerId, email: "first@example.com" });
    const suspended = createAddress({ provider_id: providerId, email: "suspended@example.com" });
    createAddress({ provider_id: p2.id, email: "second@example.com" });
    getDatabase().run("UPDATE addresses SET status = 'suspended' WHERE id = ?", [suspended.id]);

    expect(listActiveAddressEmails(undefined).sort()).toEqual(["first@example.com", "second@example.com"]);
    expect(listActiveAddressEmails(providerId)).toEqual(["first@example.com"]);
  });
});

describe("listActiveAddressCountsByDomain", () => {
  it("groups active address counts by normalized domain", () => {
    createAddress({ provider_id: providerId, email: "first@example.com" });
    createAddress({ provider_id: providerId, email: "second@Example.com" });
    const suspended = createAddress({ provider_id: providerId, email: "suspended@example.com" });
    createAddress({ provider_id: providerId, email: "ops@other.com" });
    getDatabase().run("UPDATE addresses SET status = 'suspended' WHERE id = ?", [suspended.id]);

    const counts = listActiveAddressCountsByDomain();

    expect(counts.get("example.com")).toBe(2);
    expect(counts.get("other.com")).toBe(1);
  });
});

describe("listAddressesForReadiness", () => {
  it("filters, counts, and paginates address readiness candidates in SQL", () => {
    const db = getDatabase();
    const otherProvider = createProvider({ name: "Other", type: "ses" });

    const sendDomain = createDomain(providerId, "send.example.com");
    updateDnsStatus(sendDomain.id, "verified", "verified", "pending");

    const suspended = markVerified(createAddress({ provider_id: providerId, email: "suspended@example.com" }).id);
    db.run("UPDATE addresses SET status = 'suspended', created_at = ? WHERE id = ?", ["2026-01-04T00:00:00.000Z", suspended.id]);

    const domainSender = createAddress({ provider_id: providerId, email: "domain@send.example.com" });
    db.run("UPDATE addresses SET created_at = ? WHERE id = ?", ["2026-01-03T00:00:00.000Z", domainSender.id]);

    const verified = markVerified(createAddress({ provider_id: providerId, email: "verified@example.net" }).id);
    db.run("UPDATE addresses SET created_at = ? WHERE id = ?", ["2026-01-02T00:00:00.000Z", verified.id]);

    const receiveOnly = createAddress({ provider_id: providerId, email: "receive@example.net" });
    setAddressProvisioning(receiveOnly.id, { provisioning_status: "ready" });
    db.run("UPDATE addresses SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", receiveOnly.id]);

    markVerified(createAddress({ provider_id: otherProvider.id, email: "other@example.net" }).id);

    expect(countAddressesForReadiness({ provider_id: providerId })).toBe(2);
    expect(countAddressesForReadiness({ provider_id: providerId, send: true })).toBe(2);
    expect(countAddressesForReadiness({ provider_id: providerId, receive: true })).toBe(0);
    expect(countAddressesForReadiness({ provider_id: providerId, receive: true, include_unverified: true })).toBe(1);
    expect(listAddressesForReadiness({ provider_id: providerId, limit: 1, offset: 1 }).map((address) => address.email))
      .toEqual(["verified@example.net"]);
    expect(listAddressesForReadiness({ provider_id: providerId, receive: true, include_unverified: true }).map((address) => address.email))
      .toEqual(["receive@example.net"]);
  });
});

describe("getPreferredActiveAddressEmail", () => {
  it("prefers verified active senders and applies provider/domain filters", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createAddress({ provider_id: providerId, email: "fallback@example.com" });
    const verified = createAddress({ provider_id: providerId, email: "verified@example.com" });
    markVerified(verified.id);
    const suspended = createAddress({ provider_id: providerId, email: "suspended@example.com" });
    markVerified(suspended.id);
    createAddress({ provider_id: p2.id, email: "other@example.net" });
    getDatabase().run("UPDATE addresses SET status = 'suspended' WHERE id = ?", [suspended.id]);

    expect(getPreferredActiveAddressEmail()).toBe("verified@example.com");
    expect(getPreferredActiveAddressEmail({ provider_id: p2.id })).toBe("other@example.net");
    expect(getPreferredActiveAddressEmail({ domain: "example.com" })).toBe("verified@example.com");
    expect(getPreferredActiveAddressEmail({ domain: "missing.com" })).toBeNull();
  });
});

describe("listUsableSendingAddresses", () => {
  it("returns verified non-suspended addresses only", () => {
    const usable = createAddress({ provider_id: providerId, email: "usable@example.com" });
    markVerified(usable.id);
    const suspended = createAddress({ provider_id: providerId, email: "suspended@example.com" });
    markVerified(suspended.id);
    const pending = createAddress({ provider_id: providerId, email: "pending@example.com" });
    getDatabase().run("UPDATE addresses SET status = 'suspended' WHERE id = ?", [suspended.id]);

    const addresses = listUsableSendingAddresses();
    expect(addresses.map((address) => address.email)).toEqual(["usable@example.com"]);
    expect(addresses.some((address) => address.id === pending.id)).toBe(false);
  });

  it("can limit usable sender rows before hydration", () => {
    for (let i = 0; i < 5; i++) {
      const address = createAddress({ provider_id: providerId, email: `usable-${i}@example.com` });
      markVerified(address.id);
    }

    expect(listUsableSendingAddresses(undefined, { limit: 3 })).toHaveLength(3);
  });
});

describe("updateAddress", () => {
  it("updates display_name", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    const updated = updateAddress(a.id, { display_name: "Updated" });
    expect(updated.display_name).toBe("Updated");
  });

  it("updates verified status", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    const updated = updateAddress(a.id, { verified: true });
    expect(updated.verified).toBe(true);
  });

  it("throws AddressNotFoundError for unknown id", () => {
    expect(() => updateAddress("nonexistent", { verified: true })).toThrow(AddressNotFoundError);
  });
});

describe("deleteAddress", () => {
  it("deletes an address", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    expect(deleteAddress(a.id)).toBe(true);
    expect(getAddress(a.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteAddress("nonexistent")).toBe(false);
  });
});

describe("markVerified", () => {
  it("marks address as verified", () => {
    const a = createAddress({ provider_id: providerId, email: "test@example.com" });
    expect(a.verified).toBe(false);
    const updated = markVerified(a.id);
    expect(updated.verified).toBe(true);
  });

  it("throws AddressNotFoundError for unknown id", () => {
    expect(() => markVerified("nonexistent")).toThrow(AddressNotFoundError);
  });
});
