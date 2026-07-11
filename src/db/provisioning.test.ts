import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase, getDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import { createDomain, getDomain } from "./domains.js";
import { createAddress } from "./addresses.js";
import {
  setDomainProvisioning,
  getDomainProvisioning,
  listDomainProvisioningById,
  listDomainProvisioningByIds,
  setAddressProvisioning,
  getAddressProvisioning,
  listAddressProvisioningById,
  listAddressProvisioningByIds,
  listAddressProvisioningByDomain,
  listAddressProvisioningByDomains,
  listAddressProvisioningForDomain,
  listReadyAddressCountsByDomain,
  listReadyAddressCountsByDomains,
  recordProvisioningEvent,
  listProvisioningEvents,
  claimDueDomains,
  claimDueAddresses,
  getProvisioningWorkSummary,
} from "./provisioning.js";

let providerId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "ses" });
  providerId = p.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("migration 19 — provisioning columns", () => {
  it("domains have provisioning defaults (dns_provider=cloudflare, status=none)", () => {
    const d = createDomain(providerId, "example.com");
    const p = getDomainProvisioning(d.id)!;
    expect(p.provisioning_status).toBe("none");
    expect(p.dns_provider).toBe("cloudflare");
    expect(p.nameservers).toEqual([]);
    expect(p.cf_zone_id).toBeNull();
    expect(p.next_check_at).toBeNull();
  });

  it("addresses have provisioning defaults", () => {
    const a = createAddress({ provider_id: providerId, email: "andrew@example.com" });
    const p = getAddressProvisioning(a.id)!;
    expect(p.provisioning_status).toBe("none");
    expect(p.receive_strategy).toBeNull();
    expect(p.domain_id).toBeNull();
  });

  it("provisioning_events table exists and is empty", () => {
    const db = getDatabase();
    const row = db.query("SELECT COUNT(*) as n FROM provisioning_events").get() as { n: number };
    expect(row.n).toBe(0);
  });
});

describe("setDomainProvisioning / getDomainProvisioning", () => {
  it("updates and reads back provisioning fields", () => {
    const d = createDomain(providerId, "example.com");
    setDomainProvisioning(d.id, {
      provisioning_status: "verifying",
      purchase_provider: "route53",
      send_provider: "ses",
      cf_zone_id: "zone123",
      registrar: "route53",
      nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"],
      mail_from_domain: "mail.example.com",
      next_check_at: "2026-06-02T00:00:00.000Z",
    });
    const p = getDomainProvisioning(d.id)!;
    expect(p.provisioning_status).toBe("verifying");
    expect(p.purchase_provider).toBe("route53");
    expect(p.send_provider).toBe("ses");
    expect(p.cf_zone_id).toBe("zone123");
    expect(p.nameservers).toEqual(["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
    expect(p.mail_from_domain).toBe("mail.example.com");
    // dns_provider stays cloudflare even when not set
    expect(p.dns_provider).toBe("cloudflare");
  });

  it("records last_error and clears it", () => {
    const d = createDomain(providerId, "example.com");
    setDomainProvisioning(d.id, { last_error: "boom" });
    expect(getDomainProvisioning(d.id)!.last_error).toBe("boom");
    setDomainProvisioning(d.id, { last_error: null });
    expect(getDomainProvisioning(d.id)!.last_error).toBeNull();
  });

  it("lists domain provisioning by id in one read", () => {
    const d = createDomain(providerId, "example.com");
    setDomainProvisioning(d.id, { provisioning_status: "ready", nameservers: ["a.ns.example"] });

    const byId = listDomainProvisioningById();

    expect(byId.get(d.id)).toMatchObject({
      provisioning_status: "ready",
      nameservers: ["a.ns.example"],
    });
  });

  it("lists domain provisioning for selected ids only", () => {
    const first = createDomain(providerId, "first.example.com");
    const second = createDomain(providerId, "second.example.com");
    createDomain(providerId, "other.example.com");
    setDomainProvisioning(first.id, { provisioning_status: "ready", send_provider: "ses" });
    setDomainProvisioning(second.id, { provisioning_status: "failed", last_error: "boom" });

    const byId = listDomainProvisioningByIds([first.id, second.id, first.id]);

    expect([...byId.keys()].sort()).toEqual([first.id, second.id].sort());
    expect(byId.get(first.id)).toMatchObject({ provisioning_status: "ready", send_provider: "ses" });
    expect(byId.get(second.id)).toMatchObject({ provisioning_status: "failed", last_error: "boom" });
    expect(listDomainProvisioningByIds([]).size).toBe(0);
  });
});

describe("setAddressProvisioning / getAddressProvisioning", () => {
  it("updates and reads back address provisioning fields", () => {
    const dom = createDomain(providerId, "example.com");
    const a = createAddress({ provider_id: providerId, email: "andrew@example.com" });
    setAddressProvisioning(a.id, {
      domain_id: dom.id,
      receive_strategy: "ses-s3",
      forward_to: "me@example.net",
      routing_rule_id: "rule1",
      provisioning_status: "validating",
      next_check_at: "2026-06-02T00:00:00.000Z",
    });
    const p = getAddressProvisioning(a.id)!;
    expect(p.domain_id).toBe(dom.id);
    expect(p.receive_strategy).toBe("ses-s3");
    expect(p.forward_to).toBe("me@example.net");
    expect(p.routing_rule_id).toBe("rule1");
    expect(p.provisioning_status).toBe("validating");
  });

  it("lists address provisioning by id in one read", () => {
    const dom = createDomain(providerId, "example.com");
    const a = createAddress({ provider_id: providerId, email: "andrew@example.com" });
    setAddressProvisioning(a.id, { domain_id: dom.id, provisioning_status: "ready" });

    const byId = listAddressProvisioningById();

    expect(byId.get(a.id)).toMatchObject({
      domain_id: dom.id,
      provisioning_status: "ready",
    });
  });

  it("lists address provisioning for selected ids only", () => {
    const dom = createDomain(providerId, "example.com");
    const first = createAddress({ provider_id: providerId, email: "first@example.com" });
    const second = createAddress({ provider_id: providerId, email: "second@example.com" });
    createAddress({ provider_id: providerId, email: "other@example.com" });
    setAddressProvisioning(first.id, { domain_id: dom.id, provisioning_status: "ready" });
    setAddressProvisioning(second.id, { domain_id: dom.id, provisioning_status: "validating" });

    const byId = listAddressProvisioningByIds([first.id, second.id, first.id]);

    expect([...byId.keys()].sort()).toEqual([first.id, second.id].sort());
    expect(byId.get(first.id)).toMatchObject({ domain_id: dom.id, provisioning_status: "ready" });
    expect(byId.get(second.id)).toMatchObject({ domain_id: dom.id, provisioning_status: "validating" });
    expect(listAddressProvisioningByIds([]).size).toBe(0);
  });

  it("groups address provisioning rows by domain", () => {
    const first = createDomain(providerId, "first.example.com");
    const second = createDomain(providerId, "second.example.com");
    const one = createAddress({ provider_id: providerId, email: "one@first.example.com" });
    const two = createAddress({ provider_id: providerId, email: "two@first.example.com" });
    const other = createAddress({ provider_id: providerId, email: "one@second.example.com" });
    const loose = createAddress({ provider_id: providerId, email: "loose@example.com" });

    setAddressProvisioning(one.id, { domain_id: first.id, provisioning_status: "ready" });
    setAddressProvisioning(two.id, { domain_id: first.id, provisioning_status: "validating" });
    setAddressProvisioning(other.id, { domain_id: second.id, provisioning_status: "ready" });
    setAddressProvisioning(loose.id, { provisioning_status: "ready" });

    const byDomain = listAddressProvisioningByDomain();

    expect((byDomain.get(first.id) ?? []).map((row) => row.email).sort()).toEqual([
      "one@first.example.com",
      "two@first.example.com",
    ]);
    expect(byDomain.get(second.id)?.[0]).toMatchObject({
      email: "one@second.example.com",
      provisioning: { domain_id: second.id, provisioning_status: "ready" },
    });
    expect(byDomain.has(loose.id)).toBe(false);
  });

  it("groups address provisioning for selected domains only", () => {
    const first = createDomain(providerId, "first.example.com");
    const second = createDomain(providerId, "second.example.com");
    const third = createDomain(providerId, "third.example.com");
    const one = createAddress({ provider_id: providerId, email: "one@first.example.com" });
    const two = createAddress({ provider_id: providerId, email: "two@first.example.com" });
    const other = createAddress({ provider_id: providerId, email: "one@second.example.com" });
    const excluded = createAddress({ provider_id: providerId, email: "one@third.example.com" });
    const loose = createAddress({ provider_id: providerId, email: "loose@example.com" });

    setAddressProvisioning(one.id, { domain_id: first.id, provisioning_status: "ready" });
    setAddressProvisioning(two.id, { domain_id: first.id, provisioning_status: "validating" });
    setAddressProvisioning(other.id, { domain_id: second.id, provisioning_status: "ready" });
    setAddressProvisioning(excluded.id, { domain_id: third.id, provisioning_status: "ready" });
    setAddressProvisioning(loose.id, { provisioning_status: "ready" });

    const byDomain = listAddressProvisioningByDomains([first.id, second.id, first.id]);

    expect((byDomain.get(first.id) ?? []).map((row) => row.email).sort()).toEqual([
      "one@first.example.com",
      "two@first.example.com",
    ]);
    expect(byDomain.get(second.id)?.map((row) => row.email)).toEqual(["one@second.example.com"]);
    expect(byDomain.has(third.id)).toBe(false);
    expect(listAddressProvisioningByDomains([]).size).toBe(0);
  });

  it("lists address provisioning for one domain", () => {
    const first = createDomain(providerId, "first.example.com");
    const second = createDomain(providerId, "second.example.com");
    const one = createAddress({ provider_id: providerId, email: "one@first.example.com" });
    const two = createAddress({ provider_id: providerId, email: "two@first.example.com" });
    const other = createAddress({ provider_id: providerId, email: "one@second.example.com" });
    const loose = createAddress({ provider_id: providerId, email: "loose@example.com" });

    setAddressProvisioning(one.id, { domain_id: first.id, provisioning_status: "ready" });
    setAddressProvisioning(two.id, { domain_id: first.id, provisioning_status: "validating" });
    setAddressProvisioning(other.id, { domain_id: second.id, provisioning_status: "ready" });
    setAddressProvisioning(loose.id, { provisioning_status: "ready" });

    const rows = listAddressProvisioningForDomain(first.id);

    expect(rows.map((row) => row.email).sort()).toEqual([
      "one@first.example.com",
      "two@first.example.com",
    ]);
    expect(rows.some((row) => row.email === "one@second.example.com")).toBe(false);
    expect(rows.some((row) => row.email === "loose@example.com")).toBe(false);
  });
});

describe("provisioning aggregate helpers", () => {
  it("groups ready address counts by domain in one read", () => {
    const first = createDomain(providerId, "first.example.com");
    const second = createDomain(providerId, "second.example.com");
    const readyOne = createAddress({ provider_id: providerId, email: "one@first.example.com" });
    const readyTwo = createAddress({ provider_id: providerId, email: "two@first.example.com" });
    const pending = createAddress({ provider_id: providerId, email: "pending@first.example.com" });
    const readyOther = createAddress({ provider_id: providerId, email: "one@second.example.com" });
    const noDomain = createAddress({ provider_id: providerId, email: "loose@example.com" });

    setAddressProvisioning(readyOne.id, { domain_id: first.id, provisioning_status: "ready" });
    setAddressProvisioning(readyTwo.id, { domain_id: first.id, provisioning_status: "ready" });
    setAddressProvisioning(pending.id, { domain_id: first.id, provisioning_status: "validating" });
    setAddressProvisioning(readyOther.id, { domain_id: second.id, provisioning_status: "ready" });
    setAddressProvisioning(noDomain.id, { provisioning_status: "ready" });

    const counts = listReadyAddressCountsByDomain();

    expect(counts.get(first.id)).toBe(2);
    expect(counts.get(second.id)).toBe(1);
    expect(counts.has(noDomain.id)).toBe(false);
  });

  it("groups ready address counts for selected domains only", () => {
    const first = createDomain(providerId, "first.example.com");
    const second = createDomain(providerId, "second.example.com");
    const third = createDomain(providerId, "third.example.com");
    const readyOne = createAddress({ provider_id: providerId, email: "one@first.example.com" });
    const readyTwo = createAddress({ provider_id: providerId, email: "two@first.example.com" });
    const readyOther = createAddress({ provider_id: providerId, email: "one@second.example.com" });
    const excluded = createAddress({ provider_id: providerId, email: "one@third.example.com" });

    setAddressProvisioning(readyOne.id, { domain_id: first.id, provisioning_status: "ready" });
    setAddressProvisioning(readyTwo.id, { domain_id: first.id, provisioning_status: "ready" });
    setAddressProvisioning(readyOther.id, { domain_id: second.id, provisioning_status: "ready" });
    setAddressProvisioning(excluded.id, { domain_id: third.id, provisioning_status: "ready" });

    const counts = listReadyAddressCountsByDomains([first.id, second.id, first.id]);

    expect(counts.get(first.id)).toBe(2);
    expect(counts.get(second.id)).toBe(1);
    expect(counts.has(third.id)).toBe(false);
    expect(listReadyAddressCountsByDomains([]).size).toBe(0);
  });

  it("summarizes due and failed provisioning work without loading entities", () => {
    const past = "2020-01-01T00:00:00.000Z";
    const future = "2999-01-01T00:00:00.000Z";
    const asOf = "2026-06-02T00:00:00.000Z";

    const dueDomain = createDomain(providerId, "due.example.com");
    setDomainProvisioning(dueDomain.id, { provisioning_status: "verifying", next_check_at: past });
    const futureDomain = createDomain(providerId, "future.example.com");
    setDomainProvisioning(futureDomain.id, { provisioning_status: "verifying", next_check_at: future });
    const failedDomain = createDomain(providerId, "failed.example.com");
    setDomainProvisioning(failedDomain.id, { provisioning_status: "failed", next_check_at: past });

    const dueAddress = createAddress({ provider_id: providerId, email: "due@example.com" });
    setAddressProvisioning(dueAddress.id, { provisioning_status: "validating", next_check_at: past });
    const futureAddress = createAddress({ provider_id: providerId, email: "future@example.com" });
    setAddressProvisioning(futureAddress.id, { provisioning_status: "validating", next_check_at: future });
    const failedAddress = createAddress({ provider_id: providerId, email: "failed@example.com" });
    setAddressProvisioning(failedAddress.id, { provisioning_status: "failed", next_check_at: past });

    expect(getProvisioningWorkSummary(asOf)).toEqual({
      due_domains: 1,
      due_addresses: 1,
      failed_domains: 1,
      failed_addresses: 1,
    });
  });
});

describe("provisioning_events audit", () => {
  it("records and lists events in order", () => {
    const d = createDomain(providerId, "example.com");
    recordProvisioningEvent("domain", d.id, "requested", "purchasing", { provider: "route53" });
    recordProvisioningEvent("domain", d.id, "purchasing", "registered", {});
    const events = listProvisioningEvents("domain", d.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.to_state).toBe("purchasing");
    expect(events[0]!.detail.provider).toBe("route53");
    expect(events[1]!.from_state).toBe("purchasing");
    expect(events[1]!.to_state).toBe("registered");
  });
});

describe("claimDueDomains / claimDueAddresses (daemon queue)", () => {
  it("returns only non-terminal entities whose next_check_at <= now", () => {
    const past = "2020-01-01T00:00:00.000Z";
    const future = "2999-01-01T00:00:00.000Z";

    const due = createDomain(providerId, "due.com");
    setDomainProvisioning(due.id, { provisioning_status: "verifying", next_check_at: past });

    const notYet = createDomain(providerId, "notyet.com");
    setDomainProvisioning(notYet.id, { provisioning_status: "verifying", next_check_at: future });

    const done = createDomain(providerId, "done.com");
    setDomainProvisioning(done.id, { provisioning_status: "ready", next_check_at: past });

    const none = createDomain(providerId, "none.com"); // status 'none', never scheduled
    void none;

    const claimed = claimDueDomains("2026-06-02T00:00:00.000Z");
    const names = claimed.map((d) => getDomain(d.id)!.domain);
    expect(names).toContain("due.com");
    expect(names).not.toContain("notyet.com");
    expect(names).not.toContain("done.com");
    expect(names).not.toContain("none.com");
  });

  it("claimDueAddresses respects next_check_at and terminal status", () => {
    const past = "2020-01-01T00:00:00.000Z";
    const a = createAddress({ provider_id: providerId, email: "due@example.com" });
    setAddressProvisioning(a.id, { provisioning_status: "validating", next_check_at: past });
    const b = createAddress({ provider_id: providerId, email: "ready@example.com" });
    setAddressProvisioning(b.id, { provisioning_status: "ready", next_check_at: past });

    const claimed = claimDueAddresses("2026-06-02T00:00:00.000Z");
    const ids = claimed.map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});
