import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAddress } from "../db/addresses.js";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createDomain } from "../db/domains.js";
import { createProvider } from "../db/providers.js";
import { listAddressesByOwner } from "../db/owners.js";
import { setAddressProvisioning, setDomainProvisioning } from "../db/provisioning.js";
import {
  BrowserPlanCapacityError,
  BrowserPlanConflictError,
  BrowserPlanInputError,
  assertBrowserPlanAddressCapacity,
  listBrowserPlanAddresses,
  reserveBrowserPlanAddress,
  validateBrowserPlanAddress,
} from "./browserplan.js";

let providerId: string;
let domainId: string;
let tmp: string;
let identityStorePath: string;

function writeIdentities(identities: unknown[]): void {
  writeFileSync(identityStorePath, JSON.stringify({ version: 1, identities }, null, 2));
}

function createReadyAddress(email: string, createdAt: string): string {
  const address = createAddress({ provider_id: providerId, email }, getDatabase());
  setAddressProvisioning(address.id, {
    domain_id: domainId,
    receive_strategy: "ses-s3",
    provisioning_status: "ready",
  });
  getDatabase().run("UPDATE addresses SET created_at = ?, updated_at = ? WHERE id = ?", [createdAt, createdAt, address.id]);
  return address.id;
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "ses", type: "ses" }).id;
  domainId = createDomain(providerId, "example.com").id;
  setDomainProvisioning(domainId, { provisioning_status: "ready", send_provider: "ses" });
  tmp = mkdtempSync(join(tmpdir(), "mailery-browserplan-"));
  identityStorePath = join(tmp, "identities.json");
  writeIdentities([]);
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  rmSync(tmp, { recursive: true, force: true });
});

describe("BrowserPlan address lookup", () => {
  it("lists receive-ready addresses for the requested machine with fallback identity names", () => {
    createReadyAddress("alice.signup@example.com", "2026-01-02T00:00:00.000Z");
    createReadyAddress("backup@example.com", "2026-01-01T00:00:00.000Z");
    const unready = createAddress({ provider_id: providerId, email: "pending@example.com" }, getDatabase());
    setAddressProvisioning(unready.id, { domain_id: domainId, receive_strategy: "ses-s3", provisioning_status: "requested" });

    const result = listBrowserPlanAddresses({ machineId: "machine003", target: 2, identityStorePath });

    expect(result.machine_id).toBe("machine003");
    expect(result.ready_addresses).toBe(2);
    expect(listBrowserPlanAddresses({ machineId: "machine003", target: 2, limit: 1, identityStorePath })).toMatchObject({
      total_addresses: 3,
      ready_addresses: 2,
      gap_to_target_ready: 0,
    });
    expect(result.gap_to_target_ready).toBe(0);
    expect(result.addresses.map((address) => address.email)).toEqual(["alice.signup@example.com", "backup@example.com"]);
    expect(result.addresses[0]!.identity).toMatchObject({
      source: "fallback",
      first_name: "Alice",
      tentative: true,
    });
  });

  it("preserves open-identities metadata when an address email already maps to an identity", () => {
    createReadyAddress("profile@example.com", "2026-01-01T00:00:00.000Z");
    writeIdentities([
      {
        id: "oid_profile",
        kind: "agent",
        fullName: "Profile Agent",
        displayName: "Profile",
        identifier: "agent:profile",
        emails: [{ address: "profile@example.com", primary: true }],
      },
    ]);

    const result = listBrowserPlanAddresses({ machineId: "machine003", identityStorePath });

    expect(result.identity_linked_ready_addresses).toBe(1);
    expect(result.addresses[0]!.identity).toMatchObject({
      source: "open-identities",
      id: "oid_profile",
      external_id: "oid_profile",
      identifier: "agent:profile",
      display_name: "Profile",
      tentative: false,
    });
  });

  it("validates address presence and receive readiness", () => {
    createReadyAddress("ready@example.com", "2026-01-01T00:00:00.000Z");
    const pending = createAddress({ provider_id: providerId, email: "pending@example.com" }, getDatabase());
    setAddressProvisioning(pending.id, { domain_id: domainId, receive_strategy: "ses-s3", provisioning_status: "requested" });

    expect(validateBrowserPlanAddress({ machineId: "machine003", email: "ready@example.com", identityStorePath })).toMatchObject({
      found: true,
      valid: true,
      reason: null,
    });
    expect(validateBrowserPlanAddress({ machineId: "machine003", email: "pending@example.com", identityStorePath })).toMatchObject({
      found: true,
      valid: false,
      reason: "address_not_receive_ready",
    });
  });
});

describe("BrowserPlan address reservation", () => {
  it("reserves one ready address for an identity and returns the same reservation on retry", () => {
    createReadyAddress("first@example.com", "2026-01-02T00:00:00.000Z");
    createReadyAddress("second@example.com", "2026-01-01T00:00:00.000Z");

    const first = reserveBrowserPlanAddress({
      machineId: "machine003",
      identityStorePath,
      identity: {
        id: "oid_browserplan",
        identifier: "agent:browserplan",
        name: "BrowserPlan Agent",
        email: "browserplan@example.com",
        kind: "agent",
      },
    });
    const retry = reserveBrowserPlanAddress({
      machineId: "machine003",
      identityStorePath,
      identity: {
        id: "oid_browserplan",
        identifier: "agent:browserplan",
        name: "BrowserPlan Agent",
        email: "browserplan@example.com",
        kind: "agent",
      },
    });

    expect(first.existing_reservation).toBe(false);
    expect(retry.existing_reservation).toBe(true);
    expect(retry.address.email).toBe(first.address.email);
    expect(listAddressesByOwner(first.owner.id)).toHaveLength(1);
  });

  it("requires a stable identity reference and a valid identity kind", () => {
    createReadyAddress("first@example.com", "2026-01-01T00:00:00.000Z");

    expect(() => reserveBrowserPlanAddress({
      machineId: "machine003",
      identityStorePath,
      identity: { name: "Missing Ref", kind: "agent" },
    })).toThrow(BrowserPlanInputError);

    expect(() => reserveBrowserPlanAddress({
      machineId: "machine003",
      identityStorePath,
      identity: { id: "oid_bad_kind", name: "Bad Kind", kind: "service" },
    })).toThrow(BrowserPlanInputError);
  });

  it("refuses to reserve an address mapped to a different open-identities record", () => {
    createReadyAddress("profile@example.com", "2026-01-01T00:00:00.000Z");
    writeIdentities([
      {
        id: "oid_profile",
        kind: "agent",
        fullName: "Profile Agent",
        identifier: "agent:profile",
        emails: [{ address: "profile@example.com", primary: true }],
      },
    ]);

    expect(() => reserveBrowserPlanAddress({
      machineId: "machine003",
      email: "profile@example.com",
      identityStorePath,
      identity: { id: "oid_other", identifier: "agent:other", name: "Other", kind: "agent" },
    })).toThrow(BrowserPlanConflictError);
  });

  it("auto-pick skips addresses mapped to other open-identities records", () => {
    createReadyAddress("claimed@example.com", "2026-01-02T00:00:00.000Z");
    createReadyAddress("fallback@example.com", "2026-01-01T00:00:00.000Z");
    writeIdentities([
      {
        id: "oid_claimed",
        kind: "agent",
        fullName: "Claimed Agent",
        identifier: "agent:claimed",
        emails: [{ address: "claimed@example.com", primary: true }],
      },
    ]);

    const result = reserveBrowserPlanAddress({
      machineId: "machine003",
      identityStorePath,
      identity: { id: "oid_target", identifier: "agent:target", name: "Target", kind: "agent" },
    });

    expect(result.address.email).toBe("fallback@example.com");
  });

  it("prevents assigning a second explicit address to the same identity", () => {
    createReadyAddress("first@example.com", "2026-01-02T00:00:00.000Z");
    createReadyAddress("second@example.com", "2026-01-01T00:00:00.000Z");
    const identity = {
      id: "oid_single",
      identifier: "agent:single",
      name: "Single Identity",
      kind: "agent",
    };

    reserveBrowserPlanAddress({ machineId: "machine003", email: "first@example.com", identityStorePath, identity });

    expect(() => reserveBrowserPlanAddress({
      machineId: "machine003",
      email: "second@example.com",
      identityStorePath,
      identity,
    })).toThrow(BrowserPlanConflictError);
  });

  it("does not assign a second address when an existing reservation is no longer ready", () => {
    const firstId = createReadyAddress("first@example.com", "2026-01-02T00:00:00.000Z");
    createReadyAddress("second@example.com", "2026-01-01T00:00:00.000Z");
    const identity = {
      id: "oid_unready_existing",
      identifier: "agent:unready-existing",
      name: "Unready Existing",
      kind: "agent",
    };
    const first = reserveBrowserPlanAddress({ machineId: "machine003", email: "first@example.com", identityStorePath, identity });
    getDatabase().run("UPDATE addresses SET provisioning_status = 'requested' WHERE id = ?", [firstId]);

    const retry = reserveBrowserPlanAddress({ machineId: "machine003", identityStorePath, identity });

    expect(retry.existing_reservation).toBe(true);
    expect(retry.address.email).toBe(first.address.email);
    expect(retry.address.ready).toBe(false);
    expect(listAddressesByOwner(first.owner.id)).toHaveLength(1);
  });

  it("reports a capacity error when a machine has too few ready addresses", () => {
    createReadyAddress("only@example.com", "2026-01-01T00:00:00.000Z");
    const result = listBrowserPlanAddresses({ machineId: "machine001", target: 2, identityStorePath });

    expect(result.gap_to_target_ready).toBe(1);
    expect(() => assertBrowserPlanAddressCapacity(result)).toThrow(BrowserPlanCapacityError);
  });
});
