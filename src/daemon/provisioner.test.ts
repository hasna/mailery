import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createDomain } from "../db/domains.js";
import { createAddress } from "../db/addresses.js";
import {
  setDomainProvisioning,
  getDomainProvisioning,
  setAddressProvisioning,
  getAddressProvisioning,
} from "../db/provisioning.js";
import { reconcileTick } from "./provisioner.js";
import type { DomainDeps, AddressDeps } from "../lib/provision/orchestrator.js";

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

function domainDeps(): DomainDeps {
  return {
    buyOrSkip: async () => ({ registrar: "route53" }),
    createCfZone: async () => ({ zoneId: "z", nameservers: ["a.ns.cloudflare.com"] }),
    delegateNs: async () => {},
    checkNsPropagation: async () => ({ propagated: true }),
    createSesIdentity: async () => ({ dkimTokens: ["1", "2", "3"], mailFromDomain: "mail.x.com" }),
    publishDns: async () => ({ recordsPublished: 5 }),
    checkSesVerification: async () => ({ verified: true }),
    setupInbound: async () => ({ bucket: "b", mxRecord: "mx" }),
  };
}
function addressDeps(): AddressDeps {
  return {
    wireReceive: async () => ({ routingRuleId: "r" }),
    validateRoundtrip: async () => ({ validated: true }),
  };
}

describe("reconcileTick", () => {
  it("advances only entities whose next_check_at is due", async () => {
    const due = createDomain(providerId, "due.com");
    setDomainProvisioning(due.id, { provisioning_status: "requested", next_check_at: "2020-01-01T00:00:00.000Z" });
    const later = createDomain(providerId, "later.com");
    setDomainProvisioning(later.id, { provisioning_status: "requested", next_check_at: "2999-01-01T00:00:00.000Z" });

    const res = await reconcileTick({ domainDeps: domainDeps(), addressDeps: addressDeps() }, { now: "2026-06-02T00:00:00.000Z" });

    expect(res.domainsProcessed).toBe(1);
    expect(getDomainProvisioning(due.id)!.provisioning_status).toBe("registered");
    expect(getDomainProvisioning(later.id)!.provisioning_status).toBe("requested");
  });

  it("processes domains and addresses in one tick", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "requested", next_check_at: "2020-01-01T00:00:00.000Z" });
    const a = createAddress({ provider_id: providerId, email: "a@x.com" });
    setAddressProvisioning(a.id, { provisioning_status: "requested", next_check_at: "2020-01-01T00:00:00.000Z" });

    const res = await reconcileTick({ domainDeps: domainDeps(), addressDeps: addressDeps() }, { now: "2026-06-02T00:00:00.000Z" });
    expect(res.domainsProcessed).toBe(1);
    expect(res.addressesProcessed).toBe(1);
    expect(getAddressProvisioning(a.id)!.provisioning_status).toBe("receive_wired");
  });

  it("drives a domain to ready across repeated ticks (immediate reschedule)", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "requested", next_check_at: "2020-01-01T00:00:00.000Z" });

    // Each advance sets next_check_at = now, so subsequent ticks at the same
    // clock keep picking it up until it reaches a terminal state.
    let guard = 0;
    while (getDomainProvisioning(d.id)!.provisioning_status !== "ready" && guard++ < 30) {
      await reconcileTick({ domainDeps: domainDeps(), addressDeps: addressDeps() }, { now: "2026-06-02T00:00:00.000Z" });
    }
    expect(getDomainProvisioning(d.id)!.provisioning_status).toBe("ready");
  });

  it("returns a summary with counts and errors", async () => {
    const d = createDomain(providerId, "x.com");
    setDomainProvisioning(d.id, { provisioning_status: "registered", next_check_at: "2020-01-01T00:00:00.000Z" });
    const deps = { ...domainDeps(), createCfZone: async () => { throw new Error("boom"); } };
    const res = await reconcileTick({ domainDeps: deps, addressDeps: addressDeps() }, { now: "2026-06-02T00:00:00.000Z" });
    expect(res.errors).toBe(1);
    expect(res.domainsProcessed).toBe(1);
  });

  it("is a no-op when nothing is due", async () => {
    const res = await reconcileTick({ domainDeps: domainDeps(), addressDeps: addressDeps() }, { now: "2026-06-02T00:00:00.000Z" });
    expect(res.domainsProcessed).toBe(0);
    expect(res.addressesProcessed).toBe(0);
  });
});
