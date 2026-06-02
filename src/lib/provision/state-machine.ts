/**
 * Provisioning state machine — PURE transitions, no I/O.
 *
 * Each non-terminal state maps to exactly one orchestrator action and exactly
 * one successor state. The orchestrator (which DOES perform I/O) calls
 * `domainActionFor(state)` to learn what to do, performs it, and on success
 * moves the entity to `domainNext(state)`. Failure handling (retry-in-place vs
 * transition to `failed`) is daemon/orchestrator policy and lives outside this
 * module so the transition graph stays trivially testable.
 *
 * DNS is always Cloudflare — the `delegate_ns` action points the registrar's
 * nameservers at the Cloudflare zone created in `create_cf_zone`.
 */

// ─── Domain ─────────────────────────────────────────────────────────────────

export type DomainState =
  | "requested"
  | "registered"
  | "cf_zone_ready"
  | "ns_delegated"
  | "ns_propagated"
  | "ses_identity_created"
  | "dns_published"
  | "verified"
  | "inbound_ready"
  | "ready"
  | "failed";

export type DomainAction =
  | "buy_or_skip"
  | "create_cf_zone"
  | "delegate_ns"
  | "check_ns_propagation"
  | "create_ses_identity"
  | "publish_dns"
  | "check_ses_verification"
  | "setup_inbound"
  | "finalize";

interface DomainStep {
  action: DomainAction;
  next: DomainState;
}

/** Ordered, non-terminal domain steps. Object insertion order IS the happy path. */
export const DOMAIN_FLOW: Record<Exclude<DomainState, "ready" | "failed">, DomainStep> = {
  requested: { action: "buy_or_skip", next: "registered" },
  registered: { action: "create_cf_zone", next: "cf_zone_ready" },
  cf_zone_ready: { action: "delegate_ns", next: "ns_delegated" },
  ns_delegated: { action: "check_ns_propagation", next: "ns_propagated" },
  ns_propagated: { action: "create_ses_identity", next: "ses_identity_created" },
  ses_identity_created: { action: "publish_dns", next: "dns_published" },
  dns_published: { action: "check_ses_verification", next: "verified" },
  verified: { action: "setup_inbound", next: "inbound_ready" },
  inbound_ready: { action: "finalize", next: "ready" },
};

const DOMAIN_TERMINAL = new Set<DomainState>(["ready", "failed"]);

export function isDomainTerminal(state: DomainState): boolean {
  return DOMAIN_TERMINAL.has(state);
}

export function domainActionFor(state: DomainState): DomainAction | null {
  if (isDomainTerminal(state)) return null;
  return DOMAIN_FLOW[state as keyof typeof DOMAIN_FLOW]?.action ?? null;
}

export function domainNext(state: DomainState): DomainState | null {
  if (isDomainTerminal(state)) return null;
  return DOMAIN_FLOW[state as keyof typeof DOMAIN_FLOW]?.next ?? null;
}

/** Canonical happy-path sequence including the terminal `ready`. */
export function domainHappyPath(): DomainState[] {
  return [...(Object.keys(DOMAIN_FLOW) as DomainState[]), "ready"];
}

// ─── Address ────────────────────────────────────────────────────────────────

export type AddressState = "requested" | "receive_wired" | "ready" | "failed";

export type AddressAction = "wire_receive" | "validate_roundtrip";

interface AddressStep {
  action: AddressAction;
  next: AddressState;
}

export const ADDRESS_FLOW: Record<Exclude<AddressState, "ready" | "failed">, AddressStep> = {
  requested: { action: "wire_receive", next: "receive_wired" },
  receive_wired: { action: "validate_roundtrip", next: "ready" },
};

const ADDRESS_TERMINAL = new Set<AddressState>(["ready", "failed"]);

export function isAddressTerminal(state: AddressState): boolean {
  return ADDRESS_TERMINAL.has(state);
}

export function addressActionFor(state: AddressState): AddressAction | null {
  if (isAddressTerminal(state)) return null;
  return ADDRESS_FLOW[state as keyof typeof ADDRESS_FLOW]?.action ?? null;
}

export function addressNext(state: AddressState): AddressState | null {
  if (isAddressTerminal(state)) return null;
  return ADDRESS_FLOW[state as keyof typeof ADDRESS_FLOW]?.next ?? null;
}

export function addressHappyPath(): AddressState[] {
  return [...(Object.keys(ADDRESS_FLOW) as AddressState[]), "ready"];
}
