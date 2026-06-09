import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { resolveId } from "./helpers.js";

describe("mcp/helpers resolveId", () => {
  beforeEach(() => {
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env["EMAILS_DB_PATH"];
  });

  it("returns full id for exact match", () => {
    const db = getDatabase();
    const id = "abc11111-1111-1111-1111-111111111111";
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id, "p1", "sandbox"]);

    expect(resolveId("providers", id)).toBe(id);
  });

  it("throws table-aware not-found error", () => {
    expect(() => resolveId("providers", "missing")).toThrow(
      "Could not resolve ID 'missing' in table 'providers'.",
    );
  });

  it("throws ambiguous error with candidate IDs", () => {
    const db = getDatabase();
    const id1 = "abc11111-1111-1111-1111-111111111111";
    const id2 = "abc22222-2222-2222-2222-222222222222";
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id1, "p1", "sandbox"]);
    db.run("INSERT INTO providers (id, name, type) VALUES (?, ?, ?)", [id2, "p2", "sandbox"]);

    const err = (() => {
      try {
        resolveId("providers", "abc");
      } catch (error) {
        return String((error as Error).message);
      }
      return "";
    })();

    expect(err).toContain("Ambiguous ID 'abc' in table 'providers'");
    expect(err).toContain(id1);
    expect(err).toContain(id2);
  });
});
