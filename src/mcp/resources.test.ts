import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createAddress } from "../db/addresses.js";
import { createDomain, updateDnsStatus } from "../db/domains.js";
import { createProvider } from "../db/providers.js";
import { setAddressProvisioning, setDomainProvisioning } from "../db/provisioning.js";
import { addressesResourcePayload, agentContextResourcePayload, domainsResourcePayload, recentErrorsResourcePayload } from "./resources.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("MCP resource payloads", () => {
  it("builds domain readiness with grouped ready-address counts", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const domain = updateDnsStatus(createDomain(provider.id, "example.com").id, "verified", "verified", "verified");
    const ready = createAddress({ provider_id: provider.id, email: "ready@example.com" });
    setAddressProvisioning(ready.id, { domain_id: domain.id, provisioning_status: "ready" });

    const db = getDatabase();
    const timestamp = new Date().toISOString();
    db.run("BEGIN");
    try {
      for (let i = 0; i < 10025; i++) {
        db.run(
          `INSERT INTO addresses (id, provider_id, email, display_name, verified, domain_id, provisioning_status, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 0, ?, 'ready', ?, ?)`,
          [`bulk-address-${i}`, provider.id, `bulk-${i}@example.com`, `domain-${i}`, timestamp, timestamp],
        );
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    const payload = domainsResourcePayload(db) as { domains: Array<{ id: string; readiness: { ready_addresses: number; receive_ready: boolean } }> };
    const found = payload.domains.find((candidate) => candidate.id === domain.id);
    expect(found?.readiness.ready_addresses).toBe(1);
    expect(found?.readiness.receive_ready).toBe(true);
  });

  it("bounds domain and address orientation resources", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    for (let i = 0; i < 55; i++) {
      createDomain(provider.id, `domain-${i}.example.com`);
    }
    for (let i = 0; i < 105; i++) {
      createAddress({ provider_id: provider.id, email: `addr-${i}@example.com` });
    }

    const domainPayload = domainsResourcePayload(getDatabase()) as {
      domains: unknown[];
      total: number;
      limit: number;
      truncated: boolean;
    };
    expect(domainPayload.domains).toHaveLength(50);
    expect(domainPayload.total).toBe(55);
    expect(domainPayload.limit).toBe(50);
    expect(domainPayload.truncated).toBe(true);

    const addressPayload = await addressesResourcePayload(getDatabase()) as {
      addresses: unknown[];
      total: number;
      limit: number;
      truncated: boolean;
    };
    expect(addressPayload.addresses).toHaveLength(100);
    expect(addressPayload.total).toBe(105);
    expect(addressPayload.limit).toBe(100);
    expect(addressPayload.truncated).toBe(true);
  });

  it("keeps the agent context resource compact with samples and full-context command", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    for (let i = 0; i < 8; i++) {
      const domain = createDomain(provider.id, `ready-${i}.example.com`);
      updateDnsStatus(domain.id, "verified", "verified", "verified");
      setDomainProvisioning(domain.id, { provisioning_status: "ready" });
      const address = createAddress({ provider_id: provider.id, email: `ready-${i}@example.com` });
      getDatabase().run("UPDATE addresses SET verified = 1 WHERE id = ?", [address.id]);
      setAddressProvisioning(address.id, { domain_id: domain.id, provisioning_status: "ready" });
    }

    const payload = await agentContextResourcePayload(getDatabase()) as {
      status: { domains: { usable: unknown[] }; addresses: { usable_from: unknown[] } };
      limits: { samples: number };
      truncated: { domains: boolean; addresses: boolean };
      full_context_resource: string;
      full_context_cli: string;
    };

    expect(payload.limits.samples).toBe(5);
    expect(payload.status.domains.usable).toHaveLength(5);
    expect(payload.status.addresses.usable_from).toHaveLength(5);
    expect(payload.truncated).toEqual({ domains: true, addresses: true });
    expect(payload.full_context_resource).toBe("emails://agent/context/full");
    expect(payload.full_context_cli).toBe("mailery agent context --json");
  });

  it("returns only failed provisioning rows for recent errors", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const failedDomain = createDomain(provider.id, "failed.example.com");
    setDomainProvisioning(failedDomain.id, { provisioning_status: "failed", last_error: "DNS failed" });
    const okDomain = createDomain(provider.id, "ok.example.com");
    setDomainProvisioning(okDomain.id, { provisioning_status: "ready" });
    const failedAddress = createAddress({ provider_id: provider.id, email: "failed@example.com" });
    setAddressProvisioning(failedAddress.id, { provisioning_status: "failed", last_error: "route failed" });
    const okAddress = createAddress({ provider_id: provider.id, email: "ok@example.com" });
    setAddressProvisioning(okAddress.id, { provisioning_status: "ready" });

    const payload = recentErrorsResourcePayload(getDatabase()) as { errors: Array<{ component: string; entity?: string; message: string }> };
    expect(payload.errors).toEqual([
      {
        component: "domain-provisioning",
        entity: "failed.example.com",
        message: "DNS failed",
        fix_command: "mailery provision status failed.example.com",
      },
      {
        component: "address-provisioning",
        entity: "failed@example.com",
        message: "route failed",
        fix_command: "mailery doctor delivery failed@example.com",
      },
    ]);
  });

  it("bounds recent provisioning errors per component", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    for (let i = 0; i < 55; i++) {
      const domain = createDomain(provider.id, `failed-${i}.example.com`);
      setDomainProvisioning(domain.id, { provisioning_status: "failed", last_error: `DNS failed ${i}` });
      const address = createAddress({ provider_id: provider.id, email: `failed-${i}@example.com` });
      setAddressProvisioning(address.id, { provisioning_status: "failed", last_error: `route failed ${i}` });
    }

    const payload = recentErrorsResourcePayload(getDatabase()) as {
      errors: Array<{ component: string }>;
      limits: { per_component: number };
      truncated: boolean;
      truncated_components: { domain_provisioning: boolean; address_provisioning: boolean };
    };
    expect(payload.limits.per_component).toBe(50);
    expect(payload.truncated).toBe(true);
    expect(payload.truncated_components).toEqual({
      domain_provisioning: true,
      address_provisioning: true,
    });
    expect(payload.errors.filter((error) => error.component === "domain-provisioning")).toHaveLength(50);
    expect(payload.errors.filter((error) => error.component === "address-provisioning")).toHaveLength(50);
  });
});
