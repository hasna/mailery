import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createAddress } from "../db/addresses.js";
import { createOwner, assignAddressOwner } from "../db/owners.js";
import { createProvider } from "../db/providers.js";
import { getAddressOwnershipDetail, listEnrichedAddresses, resolveAddressRef } from "./address-ownership.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("address ownership enrichment", () => {
  it("hydrates provider, owner, and administrator for the selected address list", () => {
    const includedProvider = createProvider({ name: "included", type: "sandbox" });
    const otherProvider = createProvider({ name: "other", type: "sandbox" });
    const human = createOwner({ type: "human", name: "human-user" });
    const agent = createOwner({ type: "agent", name: "agent-admin" });
    const otherOwner = createOwner({ type: "agent", name: "other-owner" });
    const included = createAddress({ provider_id: includedProvider.id, email: "human@example.com" });
    const unrelated = createAddress({ provider_id: otherProvider.id, email: "other@example.com" });
    assignAddressOwner(included.id, human.id, agent.id);
    assignAddressOwner(unrelated.id, otherOwner.id);

    const addresses = listEnrichedAddresses(includedProvider.id);

    expect(addresses).toHaveLength(1);
    expect(addresses[0]).toMatchObject({
      id: included.id,
      email: "human@example.com",
      provider_name: "included",
      owner: { id: human.id, name: "human-user" },
      administrator: { id: agent.id, name: "agent-admin" },
    });
  });

  it("hydrates single-address details without selecting provider credentials", () => {
    const provider = createProvider({
      name: "secret-provider",
      type: "resend",
      api_key: "re_secret",
      access_key: "access-secret",
      secret_key: "secret-secret",
      oauth_client_secret: "oauth-secret",
      oauth_refresh_token: "refresh-secret",
    });
    const owner = createOwner({ type: "agent", name: "ops-agent" });
    const address = createAddress({ provider_id: provider.id, email: "ops@example.com" });
    assignAddressOwner(address.id, owner.id);

    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      const detail = getAddressOwnershipDetail(address.id, db);

      expect(detail.address.provider_name).toBe("secret-provider");
      expect(detail.address.owner?.name).toBe("ops-agent");
    } finally {
      db.query = originalQuery;
    }

    const providerQueries = queries.filter((sql) => sql.includes("FROM providers"));
    expect(providerQueries.length).toBeGreaterThan(0);
    expect(providerQueries.join("\n")).not.toContain("SELECT *");
    expect(providerQueries.join("\n")).not.toMatch(/\b(api_key|access_key|secret_key|oauth_client_secret|oauth_refresh_token|oauth_access_token)\b/);
  });

  it("resolves exact address ids with one address lookup", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const address = createAddress({ provider_id: provider.id, email: "direct@example.com" });
    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      expect(resolveAddressRef(address.id, db).email).toBe("direct@example.com");
    } finally {
      db.query = originalQuery;
    }

    expect(queries.filter((sql) => sql.includes("SELECT * FROM addresses WHERE id = ?"))).toHaveLength(1);
  });
});
