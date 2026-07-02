import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import { createAddress } from "./addresses.js";
import { createProvider } from "./providers.js";
import { setAddressProvisioning, setDomainProvisioning } from "./provisioning.js";
import {
  countUsableDomains,
  createDomain,
  findDomainsByName,
  getDomain,
  getDomainByName,
  listDomains,
  listDomainsByProviderIds,
  listUsableDomains,
  updateDomain,
  updateDomainReadiness,
  deleteDomain,
  updateDnsStatus,
} from "./domains.js";
import { DomainNotFoundError } from "../types/index.js";

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

describe("createDomain", () => {
  it("creates a domain with pending statuses", () => {
    const d = createDomain(providerId, "example.com");
    expect(d.id).toHaveLength(36);
    expect(d.domain).toBe("example.com");
    expect(d.provider_id).toBe(providerId);
    expect(d.dkim_status).toBe("pending");
    expect(d.spf_status).toBe("pending");
    expect(d.dmarc_status).toBe("pending");
    expect(d.domain_type).toBe("self_hosted");
    expect(d.source_of_truth).toBe("local");
    expect(d.ownership_status).toBe("pending");
    expect(d.inbound_status).toBe("pending");
    expect(d.outbound_status).toBe("pending");
    expect(d.monitoring_status).toBe("none");
    expect(d.dns_records).toEqual({});
    expect(d.provider_metadata).toEqual({});
    expect(d.verified_at).toBeNull();
  });
});

describe("getDomain", () => {
  it("retrieves domain by id", () => {
    const d = createDomain(providerId, "example.com");
    const found = getDomain(d.id);
    expect(found?.id).toBe(d.id);
    expect(found?.domain).toBe("example.com");
  });

  it("returns null for unknown id", () => {
    expect(getDomain("nonexistent")).toBeNull();
  });
});

describe("getDomainByName", () => {
  it("finds domain by provider and name", () => {
    const d = createDomain(providerId, "example.com");
    const found = getDomainByName(providerId, "example.com");
    expect(found?.id).toBe(d.id);
  });

  it("finds domain by provider and name case-insensitively", () => {
    const d = createDomain(providerId, "Example.com");
    const found = getDomainByName(providerId, "EXAMPLE.COM");
    expect(found?.id).toBe(d.id);
  });

  it("returns null for unknown domain", () => {
    expect(getDomainByName(providerId, "unknown.com")).toBeNull();
  });
});

describe("findDomainsByName", () => {
  it("finds domains case-insensitively across providers", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    const first = createDomain(providerId, "Example.com");
    const second = createDomain(p2.id, "example.com");

    const matches = findDomainsByName("EXAMPLE.COM");
    expect(matches.map((domain) => domain.id).sort()).toEqual([first.id, second.id].sort());
  });
});

describe("listDomains", () => {
  it("lists all domains", () => {
    createDomain(providerId, "a.com");
    createDomain(providerId, "b.com");
    const list = listDomains();
    expect(list.length).toBe(2);
  });

  it("filters by provider_id", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    createDomain(providerId, "a.com");
    createDomain(p2.id, "b.com");
    expect(listDomains(providerId).length).toBe(1);
    expect(listDomains(p2.id).length).toBe(1);
  });

  it("paginates domains before row hydration", () => {
    for (let i = 0; i < 5; i++) {
      createDomain(providerId, `page-${i}.com`);
    }

    expect(listDomains(providerId, undefined, { limit: 2 })).toHaveLength(2);
    expect(listDomains(providerId, undefined, { limit: 2, offset: 2 })).toHaveLength(2);
  });

  it("lists domains for multiple providers in one query", () => {
    const p2 = createProvider({ name: "Other", type: "ses" });
    const first = createDomain(providerId, "first.example.com");
    const second = createDomain(p2.id, "second.example.com");
    createDomain(createProvider({ name: "Unrelated", type: "sandbox" }).id, "unrelated.example.com");

    const domains = listDomainsByProviderIds([providerId, p2.id, providerId]);

    expect(domains.map((domain) => domain.id).sort()).toEqual([first.id, second.id].sort());
    expect(listDomainsByProviderIds([])).toEqual([]);
  });
});

describe("listUsableDomains", () => {
  it("filters, counts, and paginates usable domains in SQL", () => {
    const db = getDatabase();
    const otherProvider = createProvider({ name: "Other", type: "ses" });

    const sendOnly = createDomain(providerId, "send.example.com");
    updateDnsStatus(sendOnly.id, "verified", "verified", "pending");
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-04T00:00:00.000Z", sendOnly.id]);

    const receiveByDomain = createDomain(providerId, "receive-domain.example.com");
    setDomainProvisioning(receiveByDomain.id, { provisioning_status: "ready" });
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-03T00:00:00.000Z", receiveByDomain.id]);

    const brokenReceiveByAddress = createDomain(providerId, "broken-receive.example.com");
    updateDnsStatus(brokenReceiveByAddress.id, "failed", "pending", "pending");
    const readyAddress = createAddress({ provider_id: providerId, email: "inbox@broken-receive.example.com" });
    setAddressProvisioning(readyAddress.id, { domain_id: brokenReceiveByAddress.id, provisioning_status: "ready" });
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-02T00:00:00.000Z", brokenReceiveByAddress.id]);

    const brokenDomainOnly = createDomain(providerId, "broken-domain-only.example.com");
    updateDnsStatus(brokenDomainOnly.id, "failed", "pending", "pending");
    setDomainProvisioning(brokenDomainOnly.id, { provisioning_status: "ready" });
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", brokenDomainOnly.id]);

    const otherSend = createDomain(otherProvider.id, "other-send.example.com");
    updateDnsStatus(otherSend.id, "verified", "verified", "pending");
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-05T00:00:00.000Z", otherSend.id]);

    expect(countUsableDomains({ provider_id: providerId })).toBe(3);
    expect(countUsableDomains({ provider_id: providerId, send: true })).toBe(1);
    expect(countUsableDomains({ provider_id: providerId, receive: true })).toBe(2);
    expect(listUsableDomains({ provider_id: providerId, limit: 2, offset: 1 }).map((domain) => domain.domain))
      .toEqual(["receive-domain.example.com", "broken-receive.example.com"]);
    expect(listUsableDomains({ provider_id: providerId, send: true }).map((domain) => domain.domain))
      .toEqual(["send.example.com"]);
    expect(listUsableDomains({ provider_id: providerId, receive: true }).map((domain) => domain.domain))
      .toEqual(["receive-domain.example.com", "broken-receive.example.com"]);
    expect(listUsableDomains({ provider_id: providerId }).map((domain) => domain.domain))
      .not.toContain("broken-domain-only.example.com");
  });
});

describe("updateDomain", () => {
  it("updates dns statuses", () => {
    const d = createDomain(providerId, "example.com");
    const updated = updateDomain(d.id, { dkim_status: "verified", spf_status: "verified" });
    expect(updated.dkim_status).toBe("verified");
    expect(updated.spf_status).toBe("verified");
    expect(updated.dmarc_status).toBe("pending");
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => updateDomain("nonexistent", { dkim_status: "verified" })).toThrow(DomainNotFoundError);
  });
});

describe("updateDomainReadiness", () => {
  it("updates lifecycle fields, snapshots, and verification timestamps", () => {
    const d = createDomain(providerId, "example.com");
    const updated = updateDomainReadiness(d.id, {
      domain_type: "tenant",
      source_of_truth: "cloud",
      ownership_status: "verified",
      inbound_status: "ready",
      outbound_status: "ready",
      monitoring_status: "monitoring",
      dns_records: { dkim: ["selector._domainkey.example.com"] },
      provider_metadata: { provider: "ses", identity: "example.com" },
      last_dns_check_at: "2026-07-02T00:00:00.000Z",
      last_inbound_check_at: "2026-07-02T00:01:00.000Z",
      last_outbound_check_at: "2026-07-02T00:02:00.000Z",
      last_monitored_at: "2026-07-02T00:03:00.000Z",
    });

    expect(updated.domain_type).toBe("tenant");
    expect(updated.source_of_truth).toBe("cloud");
    expect(updated.ownership_status).toBe("verified");
    expect(updated.inbound_status).toBe("ready");
    expect(updated.outbound_status).toBe("ready");
    expect(updated.monitoring_status).toBe("monitoring");
    expect(updated.dns_records).toEqual({ dkim: ["selector._domainkey.example.com"] });
    expect(updated.provider_metadata).toEqual({ provider: "ses", identity: "example.com" });
    expect(updated.last_dns_check_at).toBe("2026-07-02T00:00:00.000Z");
    expect(updated.last_inbound_check_at).toBe("2026-07-02T00:01:00.000Z");
    expect(updated.last_outbound_check_at).toBe("2026-07-02T00:02:00.000Z");
    expect(updated.last_monitored_at).toBe("2026-07-02T00:03:00.000Z");
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => updateDomainReadiness("nonexistent", { inbound_status: "ready" })).toThrow(DomainNotFoundError);
  });
});

describe("deleteDomain", () => {
  it("deletes a domain", () => {
    const d = createDomain(providerId, "example.com");
    expect(deleteDomain(d.id)).toBe(true);
    expect(getDomain(d.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteDomain("nonexistent")).toBe(false);
  });
});

describe("updateDnsStatus", () => {
  it("updates all statuses and sets verified_at when all verified", () => {
    const d = createDomain(providerId, "example.com");
    const updated = updateDnsStatus(d.id, "verified", "verified", "verified");
    expect(updated.dkim_status).toBe("verified");
    expect(updated.spf_status).toBe("verified");
    expect(updated.dmarc_status).toBe("verified");
    expect(updated.verified_at).not.toBeNull();
  });

  it("does not set verified_at if not all verified", () => {
    const d = createDomain(providerId, "example.com");
    const updated = updateDnsStatus(d.id, "verified", "pending", "pending");
    expect(updated.verified_at).toBeNull();
  });

  it("throws DomainNotFoundError for unknown id", () => {
    expect(() => updateDnsStatus("nonexistent", "verified", "verified", "verified")).toThrow(DomainNotFoundError);
  });
});
