import { describe, it, expect } from "bun:test";
import {
  DOMAIN_FLOW,
  ADDRESS_FLOW,
  domainActionFor,
  domainNext,
  addressActionFor,
  addressNext,
  isDomainTerminal,
  isAddressTerminal,
  domainHappyPath,
  addressHappyPath,
  type DomainState,
  type AddressState,
} from "./state-machine.js";

describe("domain state machine", () => {
  it("walks the full happy path requested -> ready", () => {
    const path: DomainState[] = [];
    let state: DomainState | null = "requested";
    while (state && !isDomainTerminal(state)) {
      path.push(state);
      state = domainNext(state);
    }
    path.push("ready");
    expect(path).toEqual([
      "requested",
      "registered",
      "cf_zone_ready",
      "ns_delegated",
      "ns_propagated",
      "ses_identity_created",
      "dns_published",
      "verified",
      "inbound_ready",
      "ready",
    ]);
  });

  it("domainHappyPath() returns the canonical ordered sequence", () => {
    expect(domainHappyPath()).toEqual([
      "requested",
      "registered",
      "cf_zone_ready",
      "ns_delegated",
      "ns_propagated",
      "ses_identity_created",
      "dns_published",
      "verified",
      "inbound_ready",
      "ready",
    ]);
  });

  it("every non-terminal state has exactly one action and one next", () => {
    for (const state of Object.keys(DOMAIN_FLOW) as DomainState[]) {
      expect(typeof domainActionFor(state)).toBe("string");
      expect(domainNext(state)).not.toBeNull();
    }
  });

  it("maps states to the expected orchestrator actions", () => {
    expect(domainActionFor("requested")).toBe("buy_or_skip");
    expect(domainActionFor("registered")).toBe("create_cf_zone");
    expect(domainActionFor("cf_zone_ready")).toBe("delegate_ns");
    expect(domainActionFor("ns_delegated")).toBe("check_ns_propagation");
    expect(domainActionFor("ns_propagated")).toBe("create_ses_identity");
    expect(domainActionFor("ses_identity_created")).toBe("publish_dns");
    expect(domainActionFor("dns_published")).toBe("check_ses_verification");
    expect(domainActionFor("verified")).toBe("setup_inbound");
    expect(domainActionFor("inbound_ready")).toBe("finalize");
  });

  it("terminal states have no action and no next", () => {
    expect(isDomainTerminal("ready")).toBe(true);
    expect(isDomainTerminal("failed")).toBe(true);
    expect(domainNext("ready")).toBeNull();
    expect(domainNext("failed")).toBeNull();
    expect(domainActionFor("ready")).toBeNull();
    expect(domainActionFor("failed")).toBeNull();
  });

  it("non-terminal states are not terminal", () => {
    expect(isDomainTerminal("requested")).toBe(false);
    expect(isDomainTerminal("verifying" as DomainState)).toBe(false);
  });
});

describe("address state machine", () => {
  it("walks the full happy path requested -> ready", () => {
    const path: AddressState[] = [];
    let state: AddressState | null = "requested";
    while (state && !isAddressTerminal(state)) {
      path.push(state);
      state = addressNext(state);
    }
    path.push("ready");
    expect(path).toEqual(["requested", "receive_wired", "ready"]);
  });

  it("addressHappyPath() returns the canonical sequence", () => {
    expect(addressHappyPath()).toEqual(["requested", "receive_wired", "ready"]);
  });

  it("maps states to expected actions", () => {
    expect(addressActionFor("requested")).toBe("wire_receive");
    expect(addressActionFor("receive_wired")).toBe("validate_roundtrip");
  });

  it("terminal states have no action / next", () => {
    expect(isAddressTerminal("ready")).toBe(true);
    expect(isAddressTerminal("failed")).toBe(true);
    expect(addressNext("ready")).toBeNull();
    expect(addressActionFor("failed")).toBeNull();
  });

  it("every non-terminal address state has an action and next", () => {
    for (const state of Object.keys(ADDRESS_FLOW) as AddressState[]) {
      expect(typeof addressActionFor(state)).toBe("string");
      expect(addressNext(state)).not.toBeNull();
    }
  });
});
