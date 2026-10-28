// Output + error formatting for the CLI. Two modes:
//   --json : a single machine-parseable envelope on stdout
//              success -> { "ok": true, "data": <result> }
//              failure -> { "ok": false, "error": { code, message, status?, details?, hint? } }
//   text   : human-friendly lines on stdout; errors + hints on stderr
//
// Exit codes: 0 success · 1 runtime/API error · 2 usage error (commander).

import { MaileryAuthRequiredError, MaileryError, NotYetAvailableError } from "@hasna/mailery-sdk-internal";
import type { CliDeps } from "./client.js";

export interface CliError {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
  hint?: string;
  /** Current public Terms discovered during signup, never inferred consent. */
  terms?: { url: string; version: string };
}

type TextOutput = { stdout: (chunk: string) => void };

export function printJson(deps: TextOutput, payload: unknown): void {
  deps.stdout(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Emit a success result. */
export function ok(deps: TextOutput, json: boolean, data: unknown, humanLines?: string | string[]): void {
  if (json) {
    printJson(deps, { ok: true, data });
    return;
  }
  const lines = humanLines === undefined ? [] : Array.isArray(humanLines) ? humanLines : [humanLines];
  if (lines.length === 0) {
    deps.stdout(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  for (const line of lines) deps.stdout(`${line}\n`);
}

/** Emit a failure result and set exit code 1. */
export function fail(deps: CliDeps, json: boolean, error: CliError): void {
  if (json) {
    printJson(deps, { ok: false, error });
  } else {
    deps.stderr(`error: ${error.message}\n`);
    if (error.terms) deps.stderr(`Terms: ${error.terms.url} (version ${error.terms.version})\n`);
    if (error.hint) deps.stderr(`hint: ${error.hint}\n`);
  }
  deps.setExitCode(1);
}

// Maps common server error codes / statuses to an actionable hint so an agent
// (or human) knows the exact next command to run.
function hintFor(error: MaileryError): string | undefined {
  // A server-supplied hint (error.details.hint) is the most specific next
  // action for this exact failure — prefer it over the generic code map below.
  // Used e.g. by the domain-purchase settled-funds/cooling-off gate.
  const serverHint = (error.details as { hint?: unknown } | undefined)?.hint;
  if (typeof serverHint === "string" && serverHint.trim()) return serverHint;
  if (error instanceof NotYetAvailableError) {
    return "This capability is not live yet (pivot phase P5, behind the billing-containment gate). Use `mailery domains search <domain>` to check availability meanwhile.";
  }
  if (error instanceof MaileryAuthRequiredError) {
    if (error.message.includes("session")) return "Run `mailery login --email <you> --password <pw>` first.";
    return "Run `mailery login` then `mailery keys create --scopes full` to mint an API key.";
  }
  const code = error.code;
  if (code === "invalid_plan") {
    const valid = (error.details as { valid_plans?: unknown } | undefined)?.valid_plans;
    const plans = Array.isArray(valid) && valid.length ? valid.join(" or ") : "pro or scale";
    return `Choose a real paid plan: \`mailery subscribe ${Array.isArray(valid) && valid[0] ? String(valid[0]) : "pro"}\` (valid: ${plans}).`;
  }
  if (code === "send_limit_reached") {
    return "The Free plan's monthly send allowance is used up. Run `mailery subscribe pro` (10,000 emails/mo) for a bigger allowance.";
  }
  if (code === "free_plan_shared_domain_required" || code === "mailbox_quota_exceeded" || code === "domain_quota_exceeded") {
    return "This is beyond the Free plan (1 shared-domain mailbox, 0 custom domains). Run `mailery subscribe pro` to unlock it.";
  }
  if (error.status === 402 || code === "billing_required") {
    return "This feature needs a paid plan. Run `mailery subscribe pro`, then retry. (The Free plan already covers keys, one shared-domain mailbox, and 3,000 sends/mo.)";
  }
  if (error.status === 401 || code === "unauthorized") {
    return "Your credentials are missing or invalid. Run `mailery login`, then `mailery keys create --scopes full`.";
  }
  if (code === "email_verification_required") {
    return "Verify the account email (check the inbox for the verification link) before minting keys or paid actions.";
  }
  if (code === "forbidden" && error.message.includes("scope")) {
    return "The API key is missing a required scope. Mint a new key with `mailery keys create --scopes full` (or mail_write).";
  }
  if (code === "subscription_active") {
    return "Cancel the subscription first in the Stripe customer portal (POST /api/v1/billing/portal returns the link), then re-run `mailery account delete`.";
  }
  if (code === "invalid_password") {
    return "The owner password did not match; nothing was deleted. Re-run `mailery account delete` with the current password.";
  }
  if (code === "sender_domain_not_ready" || code === "sender_domain_not_configured") {
    return "Run `mailery domains buy <domain>` to see the signed quote, then repeat with `--yes --max-price-cents <quoted-cents> --currency <quoted-currency>` before creating a mailbox.";
  }
  // Bring-your-own-domain lifecycle refusals (L09 part 2): each names the
  // verb that moves the domain to the state the refused verb needs.
  if (code === "domain_inbound_not_requested") {
    return `The domain was never set up for inbound mail. Re-run \`mailery domains setup <domain> --inbound --mx-migration-consent\` so an MX record is planned, publish it, then \`mailery domains verify <id>\`, \`mailery domains enable-outbound <id>\` and \`mailery domains enable-inbound <id>\`. ${RESETUP_PAUSES_SENDING}`;
  }
  if (code === "domain_not_inbound_ready") {
    // The server says WHY in details: a blocked axis means setup ran without
    // MX consent (only a re-setup fixes that); otherwise ownership/DNS are not
    // verified yet. Either way the verb that unblocks inbound is enable-inbound
    // itself — in live mode the inbound axis reads ready only after it has
    // provisioned Mailery's routing, so "verify until ready" would loop forever.
    const details = (error.details ?? {}) as { inbound_status?: unknown };
    if (details.inbound_status === "blocked") {
      return `Inbound was planned without MX consent, so no MX record points the domain at Mailery. Re-run \`mailery domains setup <domain> --inbound --mx-migration-consent\`, publish the MX record, then \`mailery domains verify <id>\`, \`mailery domains enable-outbound <id>\` and \`mailery domains enable-inbound <id>\`. ${RESETUP_PAUSES_SENDING}`;
    }
    if (details.inbound_status === "failed" || details.inbound_status === "disabled") {
      return `Inbound readiness is ${String(details.inbound_status)} for this domain. Check \`mailery domains status <domain>\` for the reason and send \`mailery feedback\` with it if the cause is not on your side.`;
    }
    return "Publish every record from `mailery domains dns <id>` at your DNS host and run `mailery domains verify <id>` until ownership and dns read ready, then retry `mailery domains enable-inbound <id>`: it provisions Mailery's inbound routing, and the inbound axis reads ready only after that.";
  }
  if (code === "domain_not_outbound_ready") {
    return "Publish every record from `mailery domains dns <id>` at your DNS host, run `mailery domains verify <id>` until outbound reads ready, then retry.";
  }
  if (code === "domain_restricted") {
    const restriction = (error.details as { restriction?: { reason?: unknown } } | undefined)?.restriction;
    const reason = restriction?.reason ? ` (${String(restriction.reason)})` : "";
    return `Mailery restricted this domain${reason}; the enable verbs lift only a pause you set with \`mailery domains disable\`. Send \`mailery feedback\` naming the domain to ask for a review.`;
  }
  if (code === "domain_dmarc_ramp_blocked") {
    return "DMARC monitoring is blocking the outbound ramp for this domain. Check `mailery domains status <domain>` for the failing policy evidence; the ramp resumes after clean aggregate reports.";
  }
  if (code === "domain_inbound_routing_unavailable") {
    return "Mailery could not provision inbound routing for this domain right now; retry `mailery domains enable-inbound <id>` shortly, and send `mailery feedback` with the details if it persists.";
  }
  return undefined;
}

/**
 * Re-running `domains setup` on a domain that already sends RE-PLANS it: the
 * server resets its status and outbound readiness to pending (and verify never
 * restores the status on its own), so sending stays paused until the records
 * are published, `verify` reads outbound ready and `enable-outbound` is run
 * again. Every hint that prescribes a re-setup says so instead of silently
 * pausing a production sending domain.
 */
export const RESETUP_PAUSES_SENDING = "Note: re-running setup re-plans the domain and pauses sending until you publish the records, run `mailery domains verify <id>` and `mailery domains enable-outbound <id>` again.";

/** Normalize any thrown error into a CliError envelope. */
export function toCliError(err: unknown): CliError {
  if (err instanceof MaileryError) {
    return {
      code: err.code ?? "request_failed",
      message: err.message,
      status: err.status,
      details: err.details,
      hint: hintFor(err),
    };
  }
  if (err instanceof Error) return { code: "cli_error", message: err.message };
  return { code: "cli_error", message: String(err) };
}

/** Retain signup discovery on a later failure, preferring authoritative server Terms. */
export function withTermsDiscovery(error: CliError, fallback: { url: string; version: string }, baseUrl: string): CliError {
  const details = error.details;
  const record = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : undefined;
  const supplied = record?.terms;
  const serverTerms = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? supplied as Record<string, unknown> : undefined;
  let terms = fallback;
  if (typeof serverTerms?.url === "string" && typeof serverTerms.version === "string") {
    try { terms = { url: new URL(serverTerms.url, baseUrl).href, version: serverTerms.version }; } catch { /* Retain the successful preflight if server metadata is malformed. */ }
  }
  return {
    ...error,
    terms,
    // Keep unrelated fields, including non-object details, unchanged. The top-level
    // terms field remains available even when details cannot carry named fields.
    details: record ? { ...record, terms: { ...serverTerms, ...terms } } : details === undefined ? { terms } : details,
  };
}

/** Run an action body, formatting any thrown error as a CliError failure. */
export async function run(deps: CliDeps, json: boolean, fn: () => Promise<void>, mapError?: (error: CliError) => CliError): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const error = toCliError(err);
    fail(deps, json, mapError ? mapError(error) : error);
  }
}
