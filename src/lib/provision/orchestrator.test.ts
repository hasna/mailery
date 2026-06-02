import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createDomain } from "../../db/domains.js";
import { createAddress } from "../../db/addresses.js";
import {
  setDomainProvisioning,
  getDomainProvisioning,
  setAddressProvisioning,
  getAddressProvisioning,
  listProvisioningEvents,
} from "../../db/provisioning.js";
import { advanceDomain, advanceAddress, type DomainDeps, type AddressDeps } from "./orchestrator.js";

let providerId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "ses", type: "ses" }).id;
});
afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

function happyDomainDeps(overrides: Partial<DomainDeps> = {}): DomainDeps {
  return {
    buyOrSkip: async () => ({ registrar: "route53" }),
    createCfZone: async () => ({ zoneId: "zone1", nameservers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"] }),
    delegateNs: async () => {},
    checkNsPropagation: async () => ({ propagated: true }),
    createSesIdentity: async () => ({ dkimTokens: ["t1", "t2", "t3"], mailFromDomain: "mail.x.com" }),
    publishDns: async () => ({ recordsPublished: 5 }),
    checkSesVerification: async () => ({ verified: true }),
    setupInbound: async () => ({ bucket: "b", mxRecord: "inbound-smtp.us-east-1.amazonaws.com" }),
    ...overrides,
  };
}

describe("advanceDomain — single transitions", () => {
  it("advances requested -> registered and records an event", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "requested", next_check_at: "2020-01-01T00:00:00.000Z" });
    const res = await advanceDomain(d.id, happyDomainDeps(), { now: "2026-06-02T00:00:00.000Z" });
    expect(res.advanced).toBe(true);
    expect(res.from).toBe("requested");
    expect(res.to).toBe("registered");
    expect(getDomainProvisioning(d.id)!.provisioning_status).toBe("registered");
    expect(getDomainProvisioning(d.id)!.registrar).toBe("route53");
    const events = listProvisioningEvents("domain", d.id);
    expect(events.at(-1)!.to_state).toBe("registered");
  });

  it("persists zone id + nameservers on create_cf_zone", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "registered", next_check_at: "2020-01-01T00:00:00.000Z" });
    await advanceDomain(d.id, happyDomainDeps(), { now: "2026-06-02T00:00:00.000Z" });
    const p = getDomainProvisioning(d.id)!;
    expect(p.provisioning_status).toBe("cf_zone_ready");
    expect(p.cf_zone_id).toBe("zone1");
    expect(p.nameservers).toEqual(["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
  });

  it("stays in place when a polling action is not ready and reschedules", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "ns_delegated", next_check_at: "2020-01-01T00:00:00.000Z" });
    const deps = happyDomainDeps({ checkNsPropagation: async () => ({ propagated: false }) });
    const res = await advanceDomain(d.id, deps, { now: "2026-06-02T00:00:00.000Z", pollIntervalSec: 30 });
    expect(res.advanced).toBe(false);
    expect(res.polledNotReady).toBe(true);
    const p = getDomainProvisioning(d.id)!;
    expect(p.provisioning_status).toBe("ns_delegated");
    expect(p.next_check_at! > "2026-06-02T00:00:00.000Z").toBe(true);
  });

  it("advances through a polling action once it is ready", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "dns_published", next_check_at: "2020-01-01T00:00:00.000Z" });
    const res = await advanceDomain(d.id, happyDomainDeps(), { now: "2026-06-02T00:00:00.000Z" });
    expect(res.to).toBe("verified");
  });

  it("records error and reschedules on a non-fatal failure (stays in state)", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "registered", next_check_at: "2020-01-01T00:00:00.000Z" });
    const deps = happyDomainDeps({ createCfZone: async () => { throw new Error("cf down"); } });
    const res = await advanceDomain(d.id, deps, { now: "2026-06-02T00:00:00.000Z", retryIntervalSec: 60 });
    expect(res.advanced).toBe(false);
    expect(res.error).toContain("cf down");
    const p = getDomainProvisioning(d.id)!;
    expect(p.provisioning_status).toBe("registered"); // unchanged
    expect(p.last_error).toContain("cf down");
    expect(p.next_check_at! > "2026-06-02T00:00:00.000Z").toBe(true);
  });

  it("transitions to failed on a fatal error", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "requested", next_check_at: "2020-01-01T00:00:00.000Z" });
    const fatal = Object.assign(new Error("domain taken"), { fatal: true });
    const deps = happyDomainDeps({ buyOrSkip: async () => { throw fatal; } });
    const res = await advanceDomain(d.id, deps, { now: "2026-06-02T00:00:00.000Z" });
    expect(res.to).toBe("failed");
    const p = getDomainProvisioning(d.id)!;
    expect(p.provisioning_status).toBe("failed");
    expect(p.next_check_at).toBeNull();
  });

  it("is a no-op for terminal states", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "ready" });
    const res = await advanceDomain(d.id, happyDomainDeps(), { now: "2026-06-02T00:00:00.000Z" });
    expect(res.advanced).toBe(false);
    expect(res.action).toBeNull();
  });

  it("drives the full happy path requested -> ready", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "requested", next_check_at: "2020-01-01T00:00:00.000Z" });
    const deps = happyDomainDeps();
    let guard = 0;
    while (getDomainProvisioning(d.id)!.provisioning_status !== "ready" && guard++ < 20) {
      await advanceDomain(d.id, deps, { now: "2026-06-02T00:00:00.000Z" });
    }
    expect(getDomainProvisioning(d.id)!.provisioning_status).toBe("ready");
    expect(getDomainProvisioning(d.id)!.next_check_at).toBeNull();
  });
});

describe("advanceAddress", () => {
  function addrDeps(overrides: Partial<AddressDeps> = {}): AddressDeps {
    return {
      wireReceive: async () => ({ routingRuleId: "rule1" }),
      validateRoundtrip: async () => ({ validated: true }),
      ...overrides,
    };
  }

  it("wires receive then validates to ready", async () => {
    const a = createAddress({ provider_id: providerId, email: "andrew@x.com" });
    setAddressProvisioning(a.id, { provisioning_status: "requested", next_check_at: "2020-01-01T00:00:00.000Z" });
    await advanceAddress(a.id, addrDeps(), { now: "2026-06-02T00:00:00.000Z" });
    expect(getAddressProvisioning(a.id)!.provisioning_status).toBe("receive_wired");
    expect(getAddressProvisioning(a.id)!.routing_rule_id).toBe("rule1");
    const res = await advanceAddress(a.id, addrDeps(), { now: "2026-06-02T00:00:00.000Z" });
    expect(res.to).toBe("ready");
    expect(getAddressProvisioning(a.id)!.last_validated_at).not.toBeNull();
  });

  it("stays in receive_wired while validation is not yet passing", async () => {
    const a = createAddress({ provider_id: providerId, email: "andrew@x.com" });
    setAddressProvisioning(a.id, { provisioning_status: "receive_wired", next_check_at: "2020-01-01T00:00:00.000Z" });
    const res = await advanceAddress(a.id, addrDeps({ validateRoundtrip: async () => ({ validated: false }) }), {
      now: "2026-06-02T00:00:00.000Z",
    });
    expect(res.polledNotReady).toBe(true);
    expect(getAddressProvisioning(a.id)!.provisioning_status).toBe("receive_wired");
  });
});
