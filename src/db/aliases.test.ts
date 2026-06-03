import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import {
  createAlias, createCatchAll, removeAlias, getAlias,
  listAliases, resolveAlias, CATCH_ALL,
  setGlobalCatchAll, ensureDefaultCatchAll,
} from "./aliases.js";

beforeEach(() => { process.env["EMAILS_DB_PATH"] = ":memory:"; resetDatabase(); });
afterEach(() => { closeDatabase(); delete process.env["EMAILS_DB_PATH"]; });

describe("aliases", () => {
  it("creates an alias and resolves it to its target", () => {
    const a = createAlias("hello@acme.com", "ops@acme.com");
    expect(a.domain).toBe("acme.com");
    expect(a.local_part).toBe("hello");
    expect(a.target_address).toBe("ops@acme.com");
    expect(resolveAlias("hello@acme.com")).toBe("ops@acme.com");
  });

  it("is case-insensitive on the recipient", () => {
    createAlias("Hello@Acme.com", "ops@acme.com");
    expect(resolveAlias("HELLO@ACME.COM")).toBe("ops@acme.com");
  });

  it("returns null when nothing matches", () => {
    expect(resolveAlias("nobody@acme.com")).toBeNull();
  });

  it("rejects an alias without a local part", () => {
    expect(() => createAlias("acme.com", "ops@acme.com")).toThrow();
  });

  it("upserts on duplicate (domain, local_part)", () => {
    createAlias("hello@acme.com", "a@acme.com");
    createAlias("hello@acme.com", "b@acme.com");
    expect(resolveAlias("hello@acme.com")).toBe("b@acme.com");
    expect(listAliases("acme.com")).toHaveLength(1);
  });
});

describe("catch-all", () => {
  it("routes any unmatched recipient on the domain", () => {
    createCatchAll("acme.com", "inbox@acme.com");
    expect(resolveAlias("whatever@acme.com")).toBe("inbox@acme.com");
    expect(resolveAlias("random123@acme.com")).toBe("inbox@acme.com");
  });

  it("a specific alias wins over the catch-all", () => {
    createCatchAll("acme.com", "inbox@acme.com");
    createAlias("sales@acme.com", "sales-team@acme.com");
    expect(resolveAlias("sales@acme.com")).toBe("sales-team@acme.com");
    expect(resolveAlias("other@acme.com")).toBe("inbox@acme.com");
  });

  it("catch-all only affects its own domain", () => {
    createCatchAll("acme.com", "inbox@acme.com");
    expect(resolveAlias("x@other.com")).toBeNull();
  });

  it("catch-all uses the sentinel local_part", () => {
    const c = createCatchAll("acme.com", "inbox@acme.com");
    expect(c.local_part).toBe(CATCH_ALL);
  });
});

describe("list / remove", () => {
  it("lists all and per-domain, and removes by id", () => {
    const a = createAlias("a@x.com", "t@x.com");
    createCatchAll("y.com", "t@y.com");
    // exclude the default protected global catch-all that's always seeded
    expect(listAliases().filter((x) => x.domain !== "*")).toHaveLength(2);
    expect(listAliases("x.com")).toHaveLength(1);
    expect(removeAlias(a.id)).toBe(true);
    expect(getAlias(a.id)).toBeNull();
    expect(resolveAlias("a@x.com")).toBeNull();
  });
});

describe("global catch-all (protected, all domains)", () => {
  it("resolves any domain when no specific/domain match", () => {
    setGlobalCatchAll("inbox@hq.com");
    expect(resolveAlias("anything@whatever.com")).toBe("inbox@hq.com");
    expect(resolveAlias("x@another.org")).toBe("inbox@hq.com");
  });

  it("precedence: specific > domain catch-all > global", () => {
    setGlobalCatchAll("global@hq.com");
    createCatchAll("acme.com", "acme-inbox@hq.com");
    createAlias("ceo@acme.com", "ceo@hq.com");
    expect(resolveAlias("ceo@acme.com")).toBe("ceo@hq.com");        // specific
    expect(resolveAlias("random@acme.com")).toBe("acme-inbox@hq.com"); // domain catch-all
    expect(resolveAlias("x@other.com")).toBe("global@hq.com");       // global
  });

  it("the protected global catch-all cannot be deleted", () => {
    const g = setGlobalCatchAll("inbox@hq.com");
    expect(g.protected).toBe(true);
    expect(() => removeAlias(g.id)).toThrow(/protected/i);
  });

  it("ensureDefaultCatchAll is idempotent and protected", () => {
    const a = ensureDefaultCatchAll();
    const b = ensureDefaultCatchAll();
    expect(a.id).toBe(b.id);
    expect(a.protected).toBe(true);
    expect(listAliases().filter((x) => x.domain === "*")).toHaveLength(1);
  });
});
