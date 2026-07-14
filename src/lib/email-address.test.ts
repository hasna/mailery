import { describe, it, expect } from "bun:test";
import { canonicalSender } from "./email-address.js";

describe("canonicalSender", () => {
  it("parses a bare address (lowercased)", () => {
    expect(canonicalSender("Ops@Example.com")).toBe("ops@example.com");
  });

  it("parses a single display-name angle-addr", () => {
    expect(canonicalSender("Ops Team <ops@example.com>")).toBe("ops@example.com");
  });

  it("REJECTS a double angle-addr spoof (the exploit)", () => {
    // Two angle-addrs: clients disagree on which is the real From, so deny.
    expect(canonicalSender("x <attacker@evil.com> <ceo@corp.com>")).toBeNull();
    expect(canonicalSender("<a@x.com><b@y.com>")).toBeNull();
  });

  it("a display name that looks like an email is cosmetic — real addr still parsed", () => {
    // The authorized address is the bracketed one (attacker's own); the display
    // text is not an address. This is inherent to email and not an auth bypass.
    expect(canonicalSender("ceo@corp.com <attacker@evil.com>")).toBe("attacker@evil.com");
  });

  it("rejects stray brackets / malformed", () => {
    expect(canonicalSender("a@x.com>")).toBeNull();
    expect(canonicalSender("<a@x.com")).toBeNull();
    expect(canonicalSender("a@b@c.com")).toBeNull();
    expect(canonicalSender("no-at-sign")).toBeNull();
    expect(canonicalSender("two addrs a@x.com")).toBeNull();
    expect(canonicalSender("a@x.com (comment)")).toBeNull();
    expect(canonicalSender("a@x.com, b@y.com")).toBeNull();
    expect(canonicalSender("a..b@example.com")).toBeNull();
    expect(canonicalSender("a@-bad.example")).toBeNull();
    expect(canonicalSender("")).toBeNull();
  });
});
