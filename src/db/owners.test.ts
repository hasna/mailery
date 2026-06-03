import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import { createAddress } from "./addresses.js";
import {
  createOwner, getOwner, getOwnerByName, listOwners,
  assignAddressOwner, getAddressOwnership, listAddressesByOwner,
} from "./owners.js";

let providerId: string;
beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  providerId = createProvider({ name: "ses", type: "ses" }).id;
});
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("owners", () => {
  it("registers a human and an agent owner", () => {
    const human = createOwner({ type: "human", name: "Andrei", contact_email: "andrei@hasna.com" });
    const agent = createOwner({ type: "agent", name: "Tiberius", external_id: "agent-503a" });
    expect(human.type).toBe("human");
    expect(agent.type).toBe("agent");
    expect(getOwner(human.id)!.contact_email).toBe("andrei@hasna.com");
    expect(getOwnerByName("Tiberius")!.id).toBe(agent.id);
    expect(listOwners("agent").map((o) => o.name)).toContain("Tiberius");
  });

  it("rejects an invalid owner type", () => {
    expect(() => createOwner({ type: "robot" as never, name: "X" })).toThrow();
  });
});

describe("assignAddressOwner — human-owned must be agent-administered", () => {
  it("agent-owned address is self-administered (administrator = owner)", () => {
    const agent = createOwner({ type: "agent", name: "Caesar" });
    const a = createAddress({ provider_id: providerId, email: "ops@x.com" });
    assignAddressOwner(a.id, agent.id);
    const own = getAddressOwnership(a.id)!;
    expect(own.owner_id).toBe(agent.id);
    expect(own.administrator_id).toBe(agent.id); // self-administered
  });

  it("human-owned address requires an agent administrator", () => {
    const human = createOwner({ type: "human", name: "Andrei" });
    const agent = createOwner({ type: "agent", name: "Tiberius" });
    const a = createAddress({ provider_id: providerId, email: "andrei@x.com" });
    // missing administrator → throws
    expect(() => assignAddressOwner(a.id, human.id)).toThrow(/human-owned.*agent administrator/i);
    // administrator must be an agent, not a human
    expect(() => assignAddressOwner(a.id, human.id, human.id)).toThrow(/administrator must be an agent/i);
    // valid: human owner + agent administrator
    assignAddressOwner(a.id, human.id, agent.id);
    const own = getAddressOwnership(a.id)!;
    expect(own.owner_id).toBe(human.id);
    expect(own.administrator_id).toBe(agent.id);
  });

  it("lists addresses by owner and by administrator", () => {
    const human = createOwner({ type: "human", name: "H" });
    const agent = createOwner({ type: "agent", name: "A" });
    const a1 = createAddress({ provider_id: providerId, email: "h1@x.com" });
    const a2 = createAddress({ provider_id: providerId, email: "h2@x.com" });
    assignAddressOwner(a1.id, human.id, agent.id);
    assignAddressOwner(a2.id, agent.id);
    expect(listAddressesByOwner(human.id).map((a) => a.email)).toEqual(["h1@x.com"]);
    // agent administers both (a1 as admin, a2 as owner=self-admin)
    expect(listAddressesByOwner(agent.id, "administrator").map((a) => a.email).sort()).toEqual(["h1@x.com", "h2@x.com"]);
  });

  it("throws when owner does not exist", () => {
    const a = createAddress({ provider_id: providerId, email: "z@x.com" });
    expect(() => assignAddressOwner(a.id, "nonexistent")).toThrow(/owner not found/i);
  });
});

describe("assignAddressOwner — anti-hijack", () => {
  it("refuses to reassign an address already owned by another owner", () => {
    const a1 = createOwner({ type: "agent", name: "Galba" });
    const a2 = createOwner({ type: "agent", name: "Vitellius" });
    const addr = createAddress({ provider_id: providerId, email: "shared@x.com" });
    assignAddressOwner(addr.id, a1.id);
    expect(() => assignAddressOwner(addr.id, a2.id)).toThrow(/already owned/i);
    // re-assigning to the same owner stays allowed (idempotent)
    expect(() => assignAddressOwner(addr.id, a1.id)).not.toThrow();
  });
});
