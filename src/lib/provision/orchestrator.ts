/**
 * Provisioning orchestrator — executes ONE state transition for a domain or
 * address. The transition graph is pure (state-machine.ts); the side effects
 * (buy domain, create Cloudflare zone, publish DNS, verify SES, set up inbound)
 * are injected via the `DomainDeps` / `AddressDeps` interfaces so this module is
 * fully unit-testable and the real adapters can be wired incrementally.
 *
 * Policy implemented here (kept out of the pure state machine):
 *   - Polling actions (check_ns_propagation, check_ses_verification,
 *     validate_roundtrip) stay in place and reschedule when not yet ready.
 *   - A thrown error reschedules with a retry interval (stays in state).
 *   - An error marked `{ fatal: true }` transitions the entity to `failed`.
 */

import type { Database } from "../../db/database.js";
import { getDomain } from "../../db/domains.js";
import { getAddress } from "../../db/addresses.js";
import {
  getDomainProvisioning,
  setDomainProvisioning,
  getAddressProvisioning,
  setAddressProvisioning,
  recordProvisioningEvent,
  type DomainProvisioning,
  type AddressProvisioning,
} from "../../db/provisioning.js";
import {
  domainActionFor,
  domainNext,
  isDomainTerminal,
  addressActionFor,
  addressNext,
  isAddressTerminal,
  type DomainState,
  type DomainAction,
  type AddressState,
  type AddressAction,
} from "./state-machine.js";

// ─── Dependency interfaces (the side-effecting work) ────────────────────────

export interface DomainCtx {
  id: string;
  domain: string;
  provisioning: DomainProvisioning;
}

export interface DomainDeps {
  buyOrSkip(ctx: DomainCtx): Promise<{ registrar: string | null }>;
  createCfZone(ctx: DomainCtx): Promise<{ zoneId: string; nameservers: string[] }>;
  delegateNs(ctx: DomainCtx): Promise<void>;
  checkNsPropagation(ctx: DomainCtx): Promise<{ propagated: boolean }>;
  createSesIdentity(ctx: DomainCtx): Promise<{ dkimTokens: string[]; mailFromDomain: string }>;
  publishDns(ctx: DomainCtx): Promise<{ recordsPublished: number }>;
  checkSesVerification(ctx: DomainCtx): Promise<{ verified: boolean }>;
  setupInbound(ctx: DomainCtx): Promise<{ bucket: string; mxRecord: string }>;
}

export interface AddressCtx {
  id: string;
  email: string;
  provisioning: AddressProvisioning;
}

export interface AddressDeps {
  wireReceive(ctx: AddressCtx): Promise<{ routingRuleId: string | null }>;
  validateRoundtrip(ctx: AddressCtx): Promise<{ validated: boolean }>;
}

export interface AdvanceOptions {
  now?: string;
  pollIntervalSec?: number;
  retryIntervalSec?: number;
  db?: Database;
}

export interface AdvanceResult<S extends string, A extends string> {
  id: string;
  from: S;
  to: S;
  action: A | null;
  advanced: boolean;
  polledNotReady?: boolean;
  error?: string;
}


function nowIso(opts: AdvanceOptions): string {
  return opts.now ?? new Date().toISOString();
}
function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}
function isFatal(err: unknown): boolean {
  return !!(err && typeof err === "object" && (err as { fatal?: boolean }).fatal === true);
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Domain ─────────────────────────────────────────────────────────────────

export async function advanceDomain(
  id: string,
  deps: DomainDeps,
  opts: AdvanceOptions = {},
): Promise<AdvanceResult<DomainState, DomainAction>> {
  const db = opts.db;
  const now = nowIso(opts);
  const pollInterval = opts.pollIntervalSec ?? 30;
  const retryInterval = opts.retryIntervalSec ?? 60;

  const domain = getDomain(id, db);
  if (!domain) throw new Error(`domain ${id} not found`);
  const provisioning = getDomainProvisioning(id, db)!;
  const state = provisioning.provisioning_status as DomainState;

  if (state === ("none" as DomainState) || isDomainTerminal(state)) {
    return { id, from: state, to: state, action: null, advanced: false };
  }

  const action = domainActionFor(state)!;
  const ctx: DomainCtx = { id, domain: domain.domain, provisioning };

  try {
    const next = domainNext(state)!;
    const data: Record<string, unknown> = { action };

    switch (action) {
      case "buy_or_skip": {
        const r = await deps.buyOrSkip(ctx);
        setDomainProvisioning(id, { registrar: r.registrar, purchase_provider: r.registrar }, db);
        data["registrar"] = r.registrar;
        break;
      }
      case "create_cf_zone": {
        const r = await deps.createCfZone(ctx);
        setDomainProvisioning(id, { cf_zone_id: r.zoneId, nameservers: r.nameservers }, db);
        data["zoneId"] = r.zoneId;
        break;
      }
      case "delegate_ns": {
        await deps.delegateNs(ctx);
        break;
      }
      case "check_ns_propagation": {
        const r = await deps.checkNsPropagation(ctx);
        if (!r.propagated) return reschedule(id, state, action, now, pollInterval, db);
        break;
      }
      case "create_ses_identity": {
        const r = await deps.createSesIdentity(ctx);
        setDomainProvisioning(id, { mail_from_domain: r.mailFromDomain }, db);
        break;
      }
      case "publish_dns": {
        const r = await deps.publishDns(ctx);
        data["recordsPublished"] = r.recordsPublished;
        break;
      }
      case "check_ses_verification": {
        const r = await deps.checkSesVerification(ctx);
        if (!r.verified) return reschedule(id, state, action, now, pollInterval, db);
        break;
      }
      case "setup_inbound": {
        const r = await deps.setupInbound(ctx);
        data["bucket"] = r.bucket;
        break;
      }
      case "finalize":
        break;
    }

    // Success → advance.
    const terminal = isDomainTerminal(next);
    setDomainProvisioning(id, {
      provisioning_status: next,
      last_error: null,
      next_check_at: terminal ? null : now,
    }, db);
    recordProvisioningEvent("domain", id, state, next, data, db);
    return { id, from: state, to: next, action, advanced: true };
  } catch (err) {
    return handleDomainError(id, state, action, err, now, retryInterval, db);
  }
}

function reschedule(
  id: string,
  state: DomainState,
  action: DomainAction,
  now: string,
  intervalSec: number,
  db?: Database,
): AdvanceResult<DomainState, DomainAction> {
  setDomainProvisioning(id, { next_check_at: addSeconds(now, intervalSec) }, db);
  return { id, from: state, to: state, action, advanced: false, polledNotReady: true };
}

function handleDomainError(
  id: string,
  state: DomainState,
  action: DomainAction,
  err: unknown,
  now: string,
  retryInterval: number,
  db?: Database,
): AdvanceResult<DomainState, DomainAction> {
  const message = errMsg(err);
  if (isFatal(err)) {
    setDomainProvisioning(id, { provisioning_status: "failed", last_error: message, next_check_at: null }, db);
    recordProvisioningEvent("domain", id, state, "failed", { action, error: message }, db);
    return { id, from: state, to: "failed", action, advanced: false, error: message };
  }
  setDomainProvisioning(id, { last_error: message, next_check_at: addSeconds(now, retryInterval) }, db);
  return { id, from: state, to: state, action, advanced: false, error: message };
}

// ─── Address ────────────────────────────────────────────────────────────────

export async function advanceAddress(
  id: string,
  deps: AddressDeps,
  opts: AdvanceOptions = {},
): Promise<AdvanceResult<AddressState, AddressAction>> {
  const db = opts.db;
  const now = nowIso(opts);
  const pollInterval = opts.pollIntervalSec ?? 30;
  const retryInterval = opts.retryIntervalSec ?? 60;

  const address = getAddress(id, db);
  if (!address) throw new Error(`address ${id} not found`);
  const provisioning = getAddressProvisioning(id, db)!;
  const state = provisioning.provisioning_status as AddressState;

  if (state === ("none" as AddressState) || isAddressTerminal(state)) {
    return { id, from: state, to: state, action: null, advanced: false };
  }

  const action = addressActionFor(state)!;
  const ctx: AddressCtx = { id, email: address.email, provisioning };

  try {
    const next = addressNext(state)!;
    const data: Record<string, unknown> = { action };

    if (action === "wire_receive") {
      const r = await deps.wireReceive(ctx);
      setAddressProvisioning(id, { routing_rule_id: r.routingRuleId }, db);
    } else if (action === "validate_roundtrip") {
      const r = await deps.validateRoundtrip(ctx);
      if (!r.validated) {
        setAddressProvisioning(id, { next_check_at: addSeconds(now, pollInterval) }, db);
        return { id, from: state, to: state, action, advanced: false, polledNotReady: true };
      }
      setAddressProvisioning(id, { last_validated_at: now }, db);
    }

    const terminal = isAddressTerminal(next);
    setAddressProvisioning(id, {
      provisioning_status: next,
      last_error: null,
      next_check_at: terminal ? null : now,
    }, db);
    recordProvisioningEvent("address", id, state, next, data, db);
    return { id, from: state, to: next, action, advanced: true };
  } catch (err) {
    const message = errMsg(err);
    if (isFatal(err)) {
      setAddressProvisioning(id, { provisioning_status: "failed", last_error: message, next_check_at: null }, db);
      recordProvisioningEvent("address", id, state, "failed", { action, error: message }, db);
      return { id, from: state, to: "failed", action, advanced: false, error: message };
    }
    setAddressProvisioning(id, { last_error: message, next_check_at: addSeconds(now, retryInterval) }, db);
    return { id, from: state, to: state, action, advanced: false, error: message };
  }
}
