/**
 * Provisioning daemon — the reconciler that drives domains and addresses through
 * their lifecycle until they are `ready` (or `failed`).
 *
 * Crash-safe by design: all state lives in the DB (provisioning columns +
 * provisioning_events). A tick simply claims every entity whose `next_check_at`
 * is due and advances each one transition via the orchestrator, so a restart
 * resumes mid-flight. Failure/retry/backoff policy lives in the orchestrator.
 *
 * `reconcileTick` is the unit of work (one pass); `runDaemon` loops it on an
 * interval. The orchestrator's side effects are injected, so the loop is fully
 * testable with fakes and a fixed clock.
 */

import { claimDueDomains, claimDueAddresses } from "../db/provisioning.js";
import {
  advanceDomain,
  advanceAddress,
  type DomainDeps,
  type AddressDeps,
  type AdvanceOptions,
} from "../lib/provision/orchestrator.js";

export interface ReconcileDeps {
  domainDeps: DomainDeps;
  addressDeps: AddressDeps;
}

export interface ReconcileOptions extends AdvanceOptions {
  /** Cap entities processed per tick (default: unlimited). */
  maxPerTick?: number;
  /** Optional structured logger. */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface ReconcileSummary {
  domainsProcessed: number;
  addressesProcessed: number;
  advanced: number;
  errors: number;
}

export async function reconcileTick(
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const now = opts.now ?? new Date().toISOString();
  const log = opts.log ?? (() => {});
  const summary: ReconcileSummary = { domainsProcessed: 0, addressesProcessed: 0, advanced: 0, errors: 0 };

  const advanceOpts: AdvanceOptions = {
    now,
    pollIntervalSec: opts.pollIntervalSec,
    retryIntervalSec: opts.retryIntervalSec,
  };

  let budget = opts.maxPerTick ?? Infinity;

  for (const { id } of claimDueDomains(now)) {
    if (budget-- <= 0) break;
    summary.domainsProcessed++;
    try {
      const res = await advanceDomain(id, deps.domainDeps, advanceOpts);
      if (res.advanced) summary.advanced++;
      if (res.error) {
        summary.errors++;
        log("domain_error", { id, from: res.from, action: res.action, error: res.error });
      } else {
        log("domain_advanced", { id, from: res.from, to: res.to, advanced: res.advanced });
      }
    } catch (err) {
      summary.errors++;
      log("domain_exception", { id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const { id } of claimDueAddresses(now)) {
    if (budget-- <= 0) break;
    summary.addressesProcessed++;
    try {
      const res = await advanceAddress(id, deps.addressDeps, advanceOpts);
      if (res.advanced) summary.advanced++;
      if (res.error) {
        summary.errors++;
        log("address_error", { id, from: res.from, action: res.action, error: res.error });
      } else {
        log("address_advanced", { id, from: res.from, to: res.to, advanced: res.advanced });
      }
    } catch (err) {
      summary.errors++;
      log("address_exception", { id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return summary;
}

export interface DaemonOptions extends ReconcileOptions {
  /** Seconds between ticks (default: 15). */
  intervalSec?: number;
  /** Stop signal — return true to break the loop after the current tick. */
  shouldStop?: () => boolean;
  /** Injectable sleep (for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Run at most this many ticks then return (default: unlimited). */
  maxTicks?: number;
}

/**
 * Long-running loop. Returns when `shouldStop()` is true or `maxTicks` is hit.
 * In production this runs under the `servers` CLI per workspace conventions.
 */
export async function runDaemon(deps: ReconcileDeps, opts: DaemonOptions = {}): Promise<ReconcileSummary> {
  const intervalSec = opts.intervalSec ?? 15;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shouldStop = opts.shouldStop ?? (() => false);
  const maxTicks = opts.maxTicks ?? Infinity;
  const total: ReconcileSummary = { domainsProcessed: 0, addressesProcessed: 0, advanced: 0, errors: 0 };

  let ticks = 0;
  while (!shouldStop() && ticks < maxTicks) {
    const s = await reconcileTick(deps, opts);
    total.domainsProcessed += s.domainsProcessed;
    total.addressesProcessed += s.addressesProcessed;
    total.advanced += s.advanced;
    total.errors += s.errors;
    ticks++;
    if (shouldStop() || ticks >= maxTicks) break;
    await sleep(intervalSec * 1000);
  }
  return total;
}
