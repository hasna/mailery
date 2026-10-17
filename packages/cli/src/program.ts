// mailery — the mailery.co CLI. Every command maps to a
// server-side operation over the /api/v1 surface via @hasna/mailery-sdk-internal. There
// is NO local-server mode. Agent-first UX: non-interactive flags for
// everything, a `--json` envelope, meaningful exit codes, and actionable hints.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { basename as pathBasename } from "node:path";
import { Command } from "commander";
import { MaileryError, type MaileryClient, type MaileryTenantDomain, type MaileryInboundUsage } from "@hasna/mailery-sdk-internal";
import { buildClient, resolveBaseUrl, type CliDeps } from "./client.js";
import { runMcpServer } from "./mcp.js";
import { RESETUP_PAUSES_SENDING, fail, ok, printJson, run, toCliError } from "./output.js";
import { withPublicDomainAvailability } from "./pricing.js";
import { VERSION } from "./version.js";

function inboundUsageLines(usage?: MaileryInboundUsage): string[] {
  if (!usage) return [];
  const state = { within_allowance: "within allowance", near_allowance: "near allowance", overage: "using credits", paused: "receiving paused" }[usage.status];
  return [`inbound: ${usage.received}/${usage.monthly_included} included; ${usage.remaining_included} remaining; ${usage.charged_credits} overage credits; ${state}${usage.metering_active ? "" : " (test mode)"}; resets ${usage.resets_at}`];
}

// ─── deps ────────────────────────────────────────────────────────────────────

async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* opening a browser is best-effort; the URL is always printed too */
  }
}

export function resolveDeps(partial: Partial<CliDeps> = {}): CliDeps {
  return {
    env: partial.env ?? process.env,
    fetch: partial.fetch,
    stdout: partial.stdout ?? ((chunk) => void process.stdout.write(chunk)),
    stderr: partial.stderr ?? ((chunk) => void process.stderr.write(chunk)),
    setExitCode: partial.setExitCode ?? ((code) => { process.exitCode = code; }),
    writeFile: partial.writeFile ?? fsWriteFile,
    readFile: partial.readFile ?? (async (path: string) => new Uint8Array(await fsReadFile(path))),
    sleep: partial.sleep,
    openBrowser: partial.openBrowser ?? defaultOpenBrowser,
    interactive: partial.interactive ?? Boolean(process.stdout.isTTY),
    readStdin: partial.readStdin ?? defaultReadStdin,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function jsonOf(cmd: Command, deps: CliDeps): boolean {
  return Boolean((cmd.optsWithGlobals() as { json?: boolean }).json) || deps.env.MAILERY_JSON === "1";
}

function leaf(parent: Command, nameAndArgs: string, description: string): Command {
  return parent.command(nameAndArgs).description(description).option("--json", "Emit a machine-readable JSON envelope");
}

/** Dollars-and-cents money for human output; undefined reads as $0.00. */
function formatUsdCents(cents: number | undefined | null): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

/**
 * Parse a dollar amount ("25", "25.00", "25.5") into integer cents. Returns
 * undefined for anything else — a money argument is never coerced.
 */
function parseUsdAmountToCents(value: string): number | undefined {
  const trimmed = String(value ?? "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : undefined;
}

/** "on"/"off" (and their common synonyms) to a boolean; undefined when unset or unrecognized. */
function parseOnOff(value: string | undefined): boolean | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["on", "true", "yes", "enable", "enabled"].includes(normalized)) return true;
  if (["off", "false", "no", "disable", "disabled"].includes(normalized)) return false;
  return undefined;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((v) => v.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** commander collector for repeatable flags (--attach, --header). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface SendFlags {
  mailbox?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string;
  attach?: string[];
  attachId?: string[];
  inReplyTo?: string;
  references?: string;
  header?: string[];
  idempotencyKey?: string;
}

/**
 * Parse repeated `--header 'Name: value'` flags. The SERVER owns the
 * allowlist — the CLI only splits on the first colon and refuses obvious
 * nonsense, so a header the server would reject fails there with the real
 * reason instead of being silently dropped here.
 */
function parseHeaderFlags(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of values) {
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new Error(`--header must be 'Name: value' (got ${JSON.stringify(entry)})`);
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!name || !value) throw new Error(`--header must be 'Name: value' (got ${JSON.stringify(entry)})`);
    headers[name] = value;
  }
  return headers;
}

/**
 * Read `--attach <path>` files into base64 attachments and turn
 * `--attach-id <id>` into by-reference entries. Local paths are read here (the
 * CLI is the only layer that can see the filesystem); size and count limits
 * are the server's, so an oversize set fails once, with the server's numbers.
 */
async function loadAttachments(
  deps: CliDeps,
  paths: string[] | undefined,
  ids: string[] | undefined,
): Promise<Array<{ filename?: string; content?: string; attachmentId?: string }>> {
  const out: Array<{ filename?: string; content?: string; attachmentId?: string }> = [];
  for (const path of paths ?? []) {
    if (!deps.readFile) throw new Error("no file reader available for --attach");
    const bytes = await deps.readFile(path);
    out.push({ filename: pathBasename(path), content: Buffer.from(bytes).toString("base64") });
  }
  for (const id of ids ?? []) out.push({ attachmentId: id });
  return out;
}

async function sleep(deps: CliDeps, ms: number): Promise<void> {
  if (deps.sleep) return deps.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEntitled(overview: { subscriptions?: Array<{ status?: string }>; balance?: number }): boolean {
  const sub = overview.subscriptions?.some((s) => s.status === "active" || s.status === "trialing");
  return Boolean(sub) || (overview.balance ?? 0) > 0;
}

// ─── account export (page walk) ──────────────────────────────────────────────

/** Server ceiling for `GET /api/v1/account/export?limit=` (docs/API.md "Account Lifecycle"). */
const ACCOUNT_EXPORT_MAX_PAGE_SIZE = 1000;
/** Hard stop against a server that never returns a null cursor. */
const ACCOUNT_EXPORT_MAX_PAGES = 100_000;

interface AccountExportPage {
  export_version?: number;
  generated_at?: string;
  tenant?: Record<string, unknown> | null;
  mailboxes?: unknown[];
  messages?: { data?: unknown[]; next_cursor?: string | null; nextCursor?: string | null };
  [key: string]: unknown;
}

interface AccountExportDocument extends AccountExportPage {
  export_version: number;
  generated_at: string;
  pages: number;
  messages: { data: unknown[]; next_cursor: null; nextCursor: null };
}

/**
 * Walk `messages.next_cursor` until it is null and assemble ONE document: the
 * small collections come back in full on every page (the last page wins, they
 * are identical), messages are concatenated. The export route is owner-session
 * only and never billing-gated, so a paid-up or lapsed account can always get
 * its data out.
 */
async function collectAccountExport(
  client: ReturnType<typeof buildClient>,
  pageSize: number,
  progress?: (line: string) => void,
): Promise<AccountExportDocument> {
  let cursor: string | undefined;
  let pages = 0;
  let last: AccountExportPage | undefined;
  const messages: unknown[] = [];
  do {
    const page = await client.exportAccount({ limit: pageSize, cursor }) as AccountExportPage;
    pages += 1;
    last = page;
    const data = Array.isArray(page.messages?.data) ? page.messages.data : [];
    messages.push(...data);
    const next = page.messages?.next_cursor ?? page.messages?.nextCursor ?? null;
    if (progress) progress(`page ${pages}: ${data.length} message(s)${next ? ", more to fetch" : ""}`);
    if (!next) break;
    if (next === cursor) throw new Error("account export returned the same cursor twice; aborting instead of looping");
    if (pages >= ACCOUNT_EXPORT_MAX_PAGES) throw new Error(`account export exceeded ${ACCOUNT_EXPORT_MAX_PAGES} pages; contact support@mailery.co for an out-of-band export`);
    cursor = next;
  } while (cursor);
  const { messages: _dropped, ...rest } = last ?? {};
  return {
    ...rest,
    export_version: typeof last?.export_version === "number" ? last.export_version : 1,
    generated_at: typeof last?.generated_at === "string" ? last.generated_at : new Date().toISOString(),
    pages,
    messages: { data: messages, next_cursor: null, nextCursor: null },
  };
}

function defaultExportFilename(tenant: Record<string, unknown> | null | undefined, now: Date): string {
  const raw = typeof tenant?.slug === "string" && tenant.slug ? tenant.slug : typeof tenant?.id === "string" ? tenant.id : "account";
  const label = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "z");
  return `mailery-export-${label}-${stamp}.json`;
}

// ─── domains: shared presentation ───────────────────────────────────────────

const DOMAIN_READINESS_AXES = ["ownership", "dns", "inbound", "outbound", "dmarc"] as const;

/** The lifecycle record every domain verb returns, read defensively: the SDK types it as an open record. */
function asDomainRecord(result: Record<string, unknown>, fallbackId: string): MaileryTenantDomain {
  return { ...result, id: String(result.id ?? fallbackId), domain: String(result.domain ?? "") };
}

function domainReadiness(record: MaileryTenantDomain): Record<string, unknown> {
  return (record.readiness ?? {}) as Record<string, unknown>;
}

function domainEnabled(record: MaileryTenantDomain): Record<string, unknown> {
  return (record.enabled ?? {}) as Record<string, unknown>;
}

/** Readiness axes and enabled flags of a domain, as human lines (no id line — callers lead with their own). */
function domainStateLines(record: MaileryTenantDomain): string[] {
  const readiness = domainReadiness(record);
  const enabled = domainEnabled(record);
  return [
    `status:    ${String(record.status ?? "unknown")}`,
    `readiness: ${DOMAIN_READINESS_AXES.map((axis) => `${axis} ${String(readiness[axis] ?? "unknown")}`).join(", ")}`,
    `enabled:   inbound ${enabled.inbound ? "yes" : "no"}, outbound ${enabled.outbound ? "yes" : "no"}`,
    ...(record.warmup ? [`warm-up:   ${record.warmup.status}; ${record.warmup.reserved_recipients}/${record.warmup.daily_recipient_limit} recipient slots used; ${record.warmup.remaining_recipients} remaining; resets ${record.warmup.resets_at}`] : []),
  ];
}

/** The single most useful next command for a domain in its current state. */
function domainNextStep(record: MaileryTenantDomain): string {
  const readiness = domainReadiness(record);
  const enabled = domainEnabled(record);
  const id = record.id;
  const domain = record.domain || "<domain>";
  if (readiness.dns !== "ready") return `DNS is not verified yet: \`mailery domains dns ${id}\` lists what is still to publish; re-run \`mailery domains verify ${id}\` once it has propagated.`;
  if (readiness.outbound === "ready" && !enabled.outbound) return `Outbound is ready: run \`mailery domains enable-outbound ${id}\`.`;
  if (!enabled.inbound) {
    // Mirrors the server's enable-inbound preconditions (ownership + DNS
    // verified, inbound requested and not blocked) rather than waiting for the
    // inbound axis to read ready: in live mode it only does so AFTER
    // enable-inbound has provisioned Mailery's routing, so a hint that waits
    // for it would never suggest the verb that gets there.
    if (readiness.inbound === "blocked") return `Inbound was planned without MX consent: re-run \`mailery domains setup ${domain} --inbound --mx-migration-consent\`, publish the MX record, then verify and enable again. ${RESETUP_PAUSES_SENDING}`;
    if ((readiness.inbound === "pending" || readiness.inbound === "ready") && readiness.ownership === "ready") {
      return `Inbound is requested and DNS is verified: run \`mailery domains enable-inbound ${id}\` (it provisions Mailery's inbound routing; the MX record must be published).`;
    }
  }
  if (enabled.outbound) return `Ready to send: \`mailery mailboxes create <name>@${record.domain}\`.`;
  return `Outbound readiness is ${String(readiness.outbound ?? "unknown")}; re-run \`mailery domains verify ${id}\` later.`;
}

/** The tenant's own lifecycle record for a domain name, or undefined when the tenant does not hold it. */
async function tenantDomainRecord(client: MaileryClient, domain: string): Promise<MaileryTenantDomain | undefined> {
  const status = await client.getDomainStatus(domain);
  const record = status.domain_record;
  return record && typeof record === "object" ? asDomainRecord(record as Record<string, unknown>, "") : undefined;
}

/** One DNS record as a human line: TYPE name [priority] value  ttl  [status] purpose. */
function dnsRecordLine(record: Record<string, unknown>): string {
  const priority = record.priority === null || record.priority === undefined ? "" : `${String(record.priority)} `;
  return `${String(record.type ?? "?")}  ${String(record.name ?? "")}  ${priority}${String(record.value ?? "")}  ttl ${String(record.ttl ?? "-")}  [${String(record.status ?? "?")}] ${String(record.purpose ?? "")}`.trimEnd();
}

/** DNS records as human lines, ending with the publish-then-verify next step. */
function dnsRecordLines(id: string, records: Array<Record<string, unknown>>): string[] {
  if (!records.length) return ["(no DNS records planned yet)", "Run `mailery domains setup <domain>` to plan them."];
  const outstanding = records.filter((r) => r.status !== "verified" && r.status !== "ignored").length;
  return [
    ...records.map(dnsRecordLine),
    outstanding
      ? `${outstanding} record(s) still to publish or propagate. Publish them at your DNS host, then run \`mailery domains verify ${id}\`.`
      : "All records verified.",
  ];
}

// ─── domains: paid-operation consent ────────────────────────────────────────

interface PaidDomainConsentOptions {
  yes?: boolean;
  maxPriceCents?: string;
  currency: string;
  idempotencyKey?: string;
}

interface PaidDomainAuthorization {
  quoteToken: string;
  maxPriceCents: number;
  currency: string;
  idempotencyKey: string;
}

/**
 * Binding quote/confirm gate shared by every verb that can spend on a domain
 * (`domains buy`, `domains setup --buy`). It first fetches a signed quote from
 * the hosted API, surfaces its exact price and currency, and only then
 * evaluates caller consent. `--yes` alone is intentionally insufficient: the
 * maximum and the currency bind non-interactive authorization to the signed
 * amount being submitted, and the caller-stable idempotency key binds every
 * retry to one charge. Whenever consent is incomplete it emits the failure
 * envelope and returns undefined, so nothing is ever POSTed without it; it
 * also returns undefined after reporting the tenant's own record when the
 * name is no longer quotable because this tenant already holds it.
 */
async function authorizePaidDomainOperation(
  deps: CliDeps,
  json: boolean,
  client: MaileryClient,
  domain: string,
  opts: PaidDomainConsentOptions,
  retry: { command: string; keyPrefix: string },
): Promise<PaidDomainAuthorization | undefined> {
  const availability = await client.searchDomains(domain);
  const quote = availability.purchase_quote;
  if (!availability.available || !quote?.token || !Number.isSafeInteger(quote.quoted_price_cents) || quote.quoted_price_cents <= 0 || !quote.currency) {
    // A retry after an attempt the registrar accepted (or that timed out after
    // acceptance) sees the name as taken, and no quote can be minted for a
    // taken name — so the server's same-key idempotent replay is unreachable
    // from here. The truthful answer is then the tenant's own record: the
    // domain is already on this tenant, nothing is bought and nothing charged
    // by this call. Only a name the tenant does NOT hold is "not purchasable".
    const owned = await tenantDomainRecord(client, domain);
    if (owned) {
      ok(deps, json, owned, [
        `${domain} is already on this tenant (${owned.id}): purchase ${String(owned.purchase_status ?? "n/a")}. Nothing to buy and nothing charged by this call.`,
        ...domainStateLines(owned),
        owned.purchase_status === "registering"
          ? `The registrar has not confirmed the earlier attempt yet: re-run \`mailery domains status ${domain}\` until purchase reads registered.`
          : domainNextStep(owned),
      ]);
      return undefined;
    }
    fail(deps, json, { code: "domain_not_purchasable", message: `${domain} is not available for purchase` });
    return undefined;
  }
  const quoteDetails = { quoted_price_cents: quote.quoted_price_cents, currency: quote.currency.toLowerCase() };
  const suggestedIdempotencyKey = opts.idempotencyKey ?? `${retry.keyPrefix}:${domain}:${randomUUID()}`;
  if (!opts.yes || opts.maxPriceCents === undefined) {
    fail(deps, json, {
      code: "price_confirmation_required",
      message: `${domain} is quoted at ${quoteDetails.quoted_price_cents} ${quoteDetails.currency} cents; purchase requires --yes and --max-price-cents`,
      details: { ...quoteDetails, suggested_idempotency_key: suggestedIdempotencyKey },
      hint: `Review the quote, then run \`${retry.command} --yes --max-price-cents ${quoteDetails.quoted_price_cents} --currency ${quoteDetails.currency} --idempotency-key ${suggestedIdempotencyKey}\`.`,
    });
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(opts.maxPriceCents)) {
    fail(deps, json, {
      code: "invalid_price_limit",
      message: `--max-price-cents must be a positive integer; ${domain} is quoted at ${quoteDetails.quoted_price_cents} ${quoteDetails.currency} cents`,
      details: quoteDetails,
    });
    return undefined;
  }
  const maxPriceCents = Number(opts.maxPriceCents);
  if (!Number.isSafeInteger(maxPriceCents)) {
    fail(deps, json, { code: "invalid_price_limit", message: "--max-price-cents is outside the supported integer range", details: quoteDetails });
    return undefined;
  }
  const expectedCurrency = opts.currency.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(expectedCurrency)) {
    fail(deps, json, { code: "invalid_currency", message: "--currency must be a three-letter currency code", details: quoteDetails });
    return undefined;
  }
  if (quoteDetails.currency !== expectedCurrency) {
    fail(deps, json, {
      code: "quote_currency_mismatch",
      message: `quote currency ${quoteDetails.currency} does not match authorized currency ${expectedCurrency}`,
      details: { ...quoteDetails, expected_currency: expectedCurrency },
    });
    return undefined;
  }
  if (quoteDetails.quoted_price_cents > maxPriceCents) {
    fail(deps, json, {
      code: "price_limit_exceeded",
      message: `quoted price ${quoteDetails.quoted_price_cents} ${quoteDetails.currency} cents exceeds authorized maximum ${maxPriceCents}`,
      details: { ...quoteDetails, max_price_cents: maxPriceCents },
    });
    return undefined;
  }
  if (!opts.idempotencyKey) {
    fail(deps, json, {
      code: "idempotency_key_required",
      message: "--idempotency-key is required for paid domain execution",
      details: { ...quoteDetails, suggested_idempotency_key: suggestedIdempotencyKey },
      hint: `Retry with --idempotency-key ${suggestedIdempotencyKey}; keep that exact key for every retry of this authorization.`,
    });
    return undefined;
  }
  return { quoteToken: quote.token, maxPriceCents, currency: expectedCurrency, idempotencyKey: opts.idempotencyKey };
}

// ─── verify --poll (machine bootstrap) ──────────────────────────────────────

const VERIFY_POLL_DEFAULT_TIMEOUT_S = 600; // 10 minutes
const VERIFY_POLL_MAX_TIMEOUT_S = 1800; // 30 minutes
const VERIFY_POLL_MIN_INTERVAL_S = 5;
// Default cadence stays under the server's hard 5/min/IP poll limit (4/min).
const VERIFY_POLL_DEFAULT_INTERVAL_S = 15;

async function runVerifyPoll(
  deps: CliDeps,
  json: boolean,
  opts: { email?: string; timeout: string; interval: string },
): Promise<void> {
  const sessionToken = deps.env.MAILERY_SESSION_TOKEN?.trim() || undefined;
  const apiKey = deps.env.MAILERY_API_KEY?.trim() || undefined;

  // Fail fast instead of spinning anonymously: the server answers a uniform
  // `pending` to callers with no live matching session, so credential-less
  // polling can never succeed.
  if (!sessionToken && !apiKey) {
    fail(deps, json, {
      code: "cli_usage_error",
      message: "verify --poll needs a session token (MAILERY_SESSION_TOKEN from signup/login)",
      hint: "Run `mailery signup --email <you> --password <pw>` (or `mailery login`), then re-run `mailery verify --poll`. An API key alone also works — it implies the account is already verified.",
    });
    return;
  }

  // API-key-only environments are already verified: keys are minted
  // post-verification server-side. Report and exit without polling.
  if (!sessionToken && apiKey) {
    const client = buildClient(deps);
    const me = await client.me();
    if (!me.user) {
      ok(deps, json, { verified: true, via: me.auth.via }, "Authenticated via API key — email already verified.");
      return;
    }
  }

  const client = buildClient(deps, { preferSession: true });
  let email = opts.email?.trim();
  if (!email) {
    const me = await client.me();
    email = me.user?.email;
  }
  if (!email) {
    fail(deps, json, { code: "cli_usage_error", message: "could not resolve the account email; pass --email <email>", hint: "`mailery verify --poll --email <the signup address>`." });
    return;
  }

  const timeoutSec = Math.max(1, Number(opts.timeout) || VERIFY_POLL_DEFAULT_TIMEOUT_S);
  if (timeoutSec > VERIFY_POLL_MAX_TIMEOUT_S) {
    fail(deps, json, {
      code: "cli_usage_error",
      message: `--timeout cannot exceed ${VERIFY_POLL_MAX_TIMEOUT_S} seconds (${VERIFY_POLL_MAX_TIMEOUT_S / 60} minutes)`,
      hint: `Re-run with --timeout ${VERIFY_POLL_MAX_TIMEOUT_S} or less.`,
    });
    return;
  }
  const intervalSec = Math.max(VERIFY_POLL_MIN_INTERVAL_S, Number(opts.interval) || VERIFY_POLL_DEFAULT_INTERVAL_S);
  const intervalMs = intervalSec * 1000;
  const deadline = Date.now() + timeoutSec * 1000;

  if (!json) deps.stderr(`Waiting for email verification of ${email} (up to ${timeoutSec}s, checking every ${intervalSec}s). Open the emailed link to verify.\n`);
  for (;;) {
    const result = await client.pollVerification(email);
    if (result.status === "verified") {
      if (!json) deps.stderr("Email verified.\n");
      ok(deps, json, { verified: true, token: result.token }, [
        `Email verified (${email}).`,
        `Session token (shown once): ${result.token}`,
        `Store it securely: export MAILERY_SESSION_TOKEN='${result.token}'`,
        "Next: `mailery keys create --scopes full`, then `mailery mailboxes create <name>@<shared-domain>`.",
      ]);
      return;
    }
    if (Date.now() + intervalMs >= deadline) {
      fail(deps, json, {
        code: "verification_poll_timeout",
        message: `email ${email} was not verified within ${timeoutSec}s`,
        hint: "Open the verification link we emailed you (a one-time browser step), then re-run `mailery verify --poll`. Lost it? `mailery verify --resend`.",
      });
      return;
    }
    if (!json) deps.stderr(".");
    await sleep(deps, intervalMs);
  }
}

// ─── program ─────────────────────────────────────────────────────────────────

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program
    .name("mailery")
    .description("Email identity for agents — mailery.co CLI + MCP server. No local runtime.")
    .version(VERSION)
    .option("--json", "Emit a machine-readable JSON envelope");
  program.configureOutput({ writeOut: deps.stdout, writeErr: () => {} });

  // ── auth ──
  const signup = leaf(program, "signup", "Create an account (email + password); return a session token once; save it in env or a secret manager");
  signup
    .requiredOption("--email <email>", "Account email")
    .requiredOption("--password <password>", "Account password")
    .option("--name <name>", "Display name")
    .option("--invite-code <code>", "Invite code (when signup is invite-gated)");
  signup.action(async () => {
    const json = jsonOf(signup, deps);
    const opts = signup.opts<{ email: string; password: string; name?: string; inviteCode?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps, { preferSession: true });
      const result = await client.signup({ email: opts.email, password: opts.password, name: opts.name, inviteCode: opts.inviteCode });
      ok(deps, json, { user: result.user, tenant: result.tenant, token: result.token }, [
        `Signed up as ${result.user.email} (tenant ${result.tenant.slug}).`,
        `Session token (shown once): ${result.token}`,
        `Store it securely: export MAILERY_SESSION_TOKEN='${result.token}'`,
        result.user.emailVerifiedAt ? "" : "Verify your email: open the one-time link we just sent (a browser step), then confirm from the terminal with `mailery verify`.",
        "You're on the Free plan: 1 mailbox on the shared subdomain + 3,000 emails/mo — no subscription needed.",
        "Next: `mailery keys create --scopes full`, then `mailery mailboxes create <name>@<shared-domain>`.",
        "Custom domains and higher limits: `mailery subscribe pro`.",
      ].filter(Boolean));
    });
  });

  const login = leaf(program, "login", "Log in (email + password); return a session token once; save it in env or a secret manager");
  login.requiredOption("--email <email>", "Account email").requiredOption("--password <password>", "Account password");
  login.action(async () => {
    const json = jsonOf(login, deps);
    const opts = login.opts<{ email: string; password: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps, { preferSession: true });
      const result = await client.login({ email: opts.email, password: opts.password });
      ok(deps, json, { user: result.user, tenant: result.tenant, token: result.token }, [
        `Logged in as ${result.user.email} (tenant ${result.tenant.slug}).`,
        `Session token (shown once): ${result.token}`,
        `Store it securely: export MAILERY_SESSION_TOKEN='${result.token}'`,
      ]);
    });
  });

  const logout = leaf(program, "logout", "Revoke the current session token (API keys stay valid until revoked); no local state is stored");
  logout.action(async () => {
    const json = jsonOf(logout, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps, { preferSession: true });
      try {
        await client.logout();
      } catch (error) {
        // An invalid token is already effectively revoked. Transport and
        // server failures leave revocation unknown, so surface them instead of
        // falsely reporting success.
        if (!(error instanceof MaileryError && error.status === 401)) throw error;
      }
      ok(deps, json, { ok: true }, "Session revoked. Unset MAILERY_SESSION_TOKEN and MAILERY_API_KEY to log out completely.");
    });
  });

  const whoami = leaf(program, "whoami", "Show the current identity, tenant, and auth scopes");
  whoami.action(async () => {
    const json = jsonOf(whoami, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const me = await client.me();
      ok(deps, json, me, [
        `email:  ${me.user?.email ?? "(api key — no user)"}`,
        `tenant: ${me.tenant?.slug ?? me.tenant?.id ?? "(none)"}`,
        `auth:   ${me.auth.via} [${me.auth.scopes.join(", ")}]`,
      ]);
    });
  });

  // ── email verification ──
  // Email verification IS a one-time browser step (the link we email on signup;
  // there is no code/OTP endpoint). This command makes that step observable and
  // pollable FROM THE TERMINAL: it reports whether the account is verified yet
  // and, with --resend, re-issues the link. An agent can loop `verify` until it
  // exits 0, so the only human action is a single click.
  //
  // --poll closes the machine-bootstrap loop entirely: it waits for that human
  // click (bounded timeout) and then prints a fresh login-equivalent session
  // token, so an agent can go signup → verify --poll → keys create with zero
  // browser steps of its own. The server only issues that session to a live
  // session for the SAME account — anonymous polling always answers pending.
  const verify = leaf(program, "verify", "Check email-verification status from the terminal; --resend re-issues the (browser) link; --poll waits for the click and mints a session");
  verify.option("--resend", "Re-send the verification email instead of only checking status");
  verify.option("--poll", "Wait for the emailed link to be clicked (bounded timeout), then print a fresh session token (machine bootstrap)");
  verify.option("--email <email>", "Account email to poll (defaults to the session identity)");
  verify.option("--timeout <seconds>", "--poll: max seconds to wait before giving up (default 600, max 1800)", "600");
  verify.option("--interval <seconds>", "--poll: seconds between checks (default 15; keep >= 15 to stay under the server's 5/min/IP limit)", "15");
  verify.action(async () => {
    const json = jsonOf(verify, deps);
    const opts = verify.opts<{ resend?: boolean; poll?: boolean; email?: string; timeout: string; interval: string }>();
    await run(deps, json, async () => {
      if (opts.poll && opts.resend) {
        fail(deps, json, { code: "cli_usage_error", message: "--poll and --resend cannot be combined", hint: "Use --resend to re-issue the link, or --poll to wait for an already-sent link to be clicked." });
        return;
      }
      if (opts.poll) {
        await runVerifyPoll(deps, json, opts);
        return;
      }
      // Accept either credential: post-signup you have only a session; a minted
      // API key implies an already-verified account. `--resend` is session-only
      // server-side and surfaces an auth hint if no session is present.
      const client = buildClient(deps);
      if (opts.resend) {
        const res = await client.resendVerification();
        if (res.verified) { ok(deps, json, { verified: true, resent: false }, "Email already verified — nothing to send."); return; }
        ok(deps, json, { verified: false, resent: true }, [
          "Verification email re-sent.",
          "Open the link we emailed you (a one-time browser step), then re-run `mailery verify`.",
        ]);
        return;
      }
      const me = await client.me();
      // API-key auth has no user, and a key can only be minted AFTER the email
      // is verified — so an authenticated key implies a verified account.
      if (!me.user) { ok(deps, json, { verified: true, via: me.auth.via }, "Authenticated via API key — email already verified."); return; }
      if (me.user.emailVerifiedAt) { ok(deps, json, { verified: true, verifiedAt: me.user.emailVerifiedAt }, `Email verified (${me.user.emailVerifiedAt}).`); return; }
      fail(deps, json, {
        code: "email_verification_required",
        message: `email ${me.user.email} is not verified yet`,
        hint: "Open the verification link we emailed you (a one-time browser step), then re-run `mailery verify`. Lost it? `mailery verify --resend`.",
      });
    });
  });

  // ── account (export + deletion; owner session only) ──
  // The data-subject rights the privacy policy describes (GDPR Art. 20 and
  // 17) must be reachable from the terminal, not only from a raw HTTP call.
  // Both verbs authenticate with the SESSION token: API keys cannot export or
  // delete a workspace, and neither verb is billing-gated server-side.
  const account = program.command("account").description("Export or permanently delete the whole account (owner session only; never billing-gated)");

  const accountExport = leaf(account, "export", "Write a JSON export of the account (profile, mailboxes, labels, domains, keys metadata, subscriptions, credits, every message with bodies and attachment metadata) to a file");
  accountExport
    .option("--output <path>", "Where to write the export; `-` streams the document to stdout (default: mailery-export-<tenant>-<timestamp>.json in the current directory)")
    .option("--page-size <n>", `Messages fetched per request (1-${ACCOUNT_EXPORT_MAX_PAGE_SIZE}, default ${ACCOUNT_EXPORT_MAX_PAGE_SIZE})`);
  accountExport.action(async () => {
    const json = jsonOf(accountExport, deps);
    const opts = accountExport.opts<{ output?: string; pageSize?: string }>();
    await run(deps, json, async () => {
      const toStdout = opts.output === "-";
      if (toStdout && json) {
        fail(deps, json, {
          code: "cli_usage_error",
          message: "--output - writes the export document itself to stdout; it cannot be wrapped in the --json envelope",
          hint: "Drop --json, or write the export to a file (`--output <path>`) and keep --json for the summary envelope.",
        });
        return;
      }
      const pageSize = opts.pageSize === undefined ? ACCOUNT_EXPORT_MAX_PAGE_SIZE : Number(opts.pageSize);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > ACCOUNT_EXPORT_MAX_PAGE_SIZE) {
        fail(deps, json, { code: "cli_usage_error", message: `--page-size must be an integer between 1 and ${ACCOUNT_EXPORT_MAX_PAGE_SIZE}` });
        return;
      }
      const client = buildClient(deps, { preferSession: true });
      const document = await collectAccountExport(client, pageSize, json ? undefined : (line) => deps.stderr(`${line}\n`));
      const messageCount = document.messages.data.length;
      const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      if (toStdout) {
        deps.stdout(bytes.toString("utf8"));
        return;
      }
      const path = opts.output?.trim() || defaultExportFilename(document.tenant, new Date());
      const writeFile = deps.writeFile ?? fsWriteFile;
      await writeFile(path, bytes);
      const summary = {
        path,
        bytes: bytes.byteLength,
        export_version: document.export_version,
        generated_at: document.generated_at,
        pages: document.pages,
        messages: messageCount,
        mailboxes: Array.isArray(document.mailboxes) ? document.mailboxes.length : 0,
        attachments: document.messages.data.reduce<number>((sum, message) => sum + ((message as { attachments?: unknown[] }).attachments?.length ?? 0), 0),
      };
      ok(deps, json, summary, [
        `Exported ${messageCount} message(s) across ${document.pages} page(s) to ${path} (${bytes.byteLength} bytes).`,
        summary.attachments > 0
          ? `Attachment bytes are not embedded: fetch each message's attachments[].download_url (or \`mailery attachments download <messageId>\`) while the account still exists.`
          : "",
        "Digests, feedback, the suppression list, security audit entries and raw received-mail copies are not part of this export (see docs: Account Lifecycle).",
      ].filter(Boolean));
    });
  });

  const accountDelete = leaf(account, "delete", "Permanently delete the account and everything in it (irreversible); requires the owner password and the account email typed as confirmation");
  accountDelete
    .requiredOption("--password <password>", "The owner's current password (re-authentication is required server-side)")
    .requiredOption("--confirm-email <email>", "Type the account's email address exactly; the command refuses on mismatch");
  accountDelete.action(async () => {
    const json = jsonOf(accountDelete, deps);
    const opts = accountDelete.opts<{ password: string; confirmEmail: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps, { preferSession: true });
      const me = await client.me();
      const accountEmail = me.user?.email?.trim().toLowerCase();
      if (!accountEmail) {
        fail(deps, json, {
          code: "session_required",
          message: "account deletion needs an owner session token, not an API key",
          hint: "Run `mailery login --email <you> --password <pw>`, export MAILERY_SESSION_TOKEN, then re-run `mailery account delete`.",
        });
        return;
      }
      const typed = opts.confirmEmail.trim().toLowerCase();
      if (typed !== accountEmail) {
        fail(deps, json, {
          code: "confirmation_mismatch",
          message: `--confirm-email does not match the account email (${accountEmail}); nothing was deleted`,
          hint: `Re-run with --confirm-email ${accountEmail} to delete this account, or check MAILERY_SESSION_TOKEN belongs to the account you meant.`,
        });
        return;
      }
      const result = await client.deleteAccount({ password: opts.password });
      ok(deps, json, { ...result, email: accountEmail, tenant: me.tenant?.slug ?? me.tenant?.id ?? null }, [
        `Account ${accountEmail}${me.tenant?.slug ? ` (tenant ${me.tenant.slug})` : ""} deleted. Every session and API key is revoked.`,
        "Unset MAILERY_SESSION_TOKEN and MAILERY_API_KEY. Billing records held by the payment processor, a small security audit record of the deletion, and backups until they age out remain (see the privacy policy).",
      ]);
    });
  });

  // ── keys ──
  const keys = program.command("keys").description("Manage tenant API keys");

  const keysCreate = leaf(keys, "create", "Mint a scoped API key; return it once; save it in env or a secret manager");
  keysCreate
    .option("--scopes <scopes>", "Comma-separated scopes (full, mail_read, mail_write, billing_read)")
    .option("--name <name>", "Human label for the key");
  keysCreate.action(async () => {
    const json = jsonOf(keysCreate, deps);
    const opts = keysCreate.opts<{ scopes?: string; name?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps, { preferSession: true });
      const result = await client.createKey({ name: opts.name, scopes: splitList(opts.scopes) });
      ok(deps, json, { ...result, key: result.key }, [
        `API key created (id ${result.api_key.id}, scopes ${result.api_key.scopes.join(", ")}).`,
        `Key (shown once): ${result.key}`,
        `Store it securely: export MAILERY_API_KEY='${result.key}'`,
        "This key is shown ONCE. Store it in your secret manager or shell profile.",
      ]);
    });
  });

  const keysList = leaf(keys, "list", "List tenant API keys (metadata only)");
  keysList.action(async () => {
    const json = jsonOf(keysList, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps, { preferSession: true });
      const rows = await client.listKeys();
      ok(deps, json, rows, rows.length
        ? rows.map((k) => `${k.id}  ${k.prefix}…  [${k.scopes.join(", ")}]  ${k.revokedAt ? "revoked" : "active"}`)
        : ["(no keys)"]);
    });
  });

  const keysRevoke = leaf(keys, "revoke [id]", "Revoke one API key, or --all keys (break-glass: works with password auth alone)");
  keysRevoke
    .option("--all", "Revoke EVERY API key for the tenant")
    .option("--email <email>", "Break-glass: email for password auth when no session token is in env")
    .option("--password <password>", "Break-glass: password for password auth when no session token is in env");
  keysRevoke.action(async (id: string | undefined) => {
    const json = jsonOf(keysRevoke, deps);
    const opts = keysRevoke.opts<{ all?: boolean; email?: string; password?: string }>();
    await run(deps, json, async () => {
      if (opts.all) {
        let sessionToken = deps.env.MAILERY_SESSION_TOKEN;
        // Break-glass: with just email+password and no usable key/session, log in
        // to obtain a session, then revoke everything.
        if (opts.email && opts.password) {
          const authClient = buildClient(deps, { preferSession: true });
          const res = await authClient.login({ email: opts.email, password: opts.password });
          sessionToken = res.token;
        }
        const client = buildClient(deps, { preferSession: true, sessionToken: sessionToken || undefined });
        let result: { ok: boolean; revoked?: number; method?: string };
        try {
          result = await client.revokeAllKeys();
        } catch (err) {
          // The dedicated /keys/revoke-all route is not live yet (pivot D-3);
          // fall back to enumerate-then-revoke, which the escape hatch needs.
          if (err instanceof MaileryError && (err.status === 404 || err.status === 501 || err.code === "not_yet_available")) {
            const all = await client.listKeys();
            const active = all.filter((k) => !k.revokedAt);
            for (const k of active) await client.revokeKey(k.id);
            result = { ok: true, revoked: active.length, method: "enumerate" };
          } else {
            throw err;
          }
        }
        ok(deps, json, result, `Revoked ${result.revoked ?? "all"} API key(s). Unset MAILERY_API_KEY to complete logout.`);
        return;
      }
      if (!id) {
        fail(deps, json, { code: "cli_usage_error", message: "provide an API key id, or pass --all", hint: "`mailery keys revoke <id>` or `mailery keys revoke --all`" });
        return;
      }
      const client = buildClient(deps, { preferSession: true });
      const res = await client.revokeKey(id);
      ok(deps, json, res, `Revoked key ${id}.`);
    });
  });

  // ── billing ──
  const subscribe = leaf(program, "subscribe <plan>", "Start a subscription (plan: pro or scale): open Stripe Checkout and wait until the entitlement is active");
  subscribe
    .option("--no-wait", "Print the checkout URL and exit without polling for entitlement")
    .option("--idempotency-key <key>", "Stable purchase key; reuse it after failure or timeout (a fresh key starts a deliberate new purchase)")
    .option("--resume", "Only poll entitlement; do not open another Checkout session")
    .option("--timeout <seconds>", "Max seconds to wait for entitlement", "300")
    .option("--interval <seconds>", "Entitlement poll interval in seconds", "3");
  subscribe.action(async (plan: string) => {
    const json = jsonOf(subscribe, deps);
    const opts = subscribe.opts<{ wait: boolean; timeout: string; interval: string; idempotencyKey?: string; resume?: boolean }>();
    await run(deps, json, async () => {
      const client = buildClient(deps, { preferSession: true });
      if (opts.resume && (!opts.wait || opts.idempotencyKey)) {
        throw new MaileryError("--resume only polls entitlement; use it without --no-wait or --idempotency-key", { code: "cli_usage_error" });
      }
      const url = opts.resume ? undefined : await client.createCheckout({ kind: "subscription", plan, idempotencyKey: opts.idempotencyKey });
      if (url && deps.interactive) deps.openBrowser?.(url);
      if (!opts.wait) {
        ok(deps, json, { plan, checkout_url: url, waited: false }, [`Checkout URL: ${url}`, "Complete payment in the browser; run `mailery subscribe "+plan+" --resume` to poll without opening Checkout."]);
        return;
      }
      if (!json) deps.stderr(`${url ? `Checkout URL: ${url}\n` : ""}Waiting for entitlement`);
      const timeoutMs = Math.max(1, Number(opts.timeout) || 300) * 1000;
      const intervalMs = Math.max(1, Number(opts.interval) || 3) * 1000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const overview = await client.getBillingStatus();
        if (isEntitled(overview)) {
          if (!json) deps.stderr(" active\n");
          ok(deps, json, { plan, checkout_url: url, waited: true, entitled: true, balance: overview.balance, subscriptions: overview.subscriptions }, `Subscription active. Balance: ${overview.balance}.`);
          return;
        }
        if (Date.now() + intervalMs >= deadline) {
          if (!json) deps.stderr(" timed out\n");
          fail(deps, json, { code: "entitlement_timeout", message: `entitlement not active within ${Math.round(timeoutMs / 1000)}s`, hint: "Complete the Stripe Checkout in the browser, then run `mailery subscribe <plan> --resume` to resume polling without creating Checkout, or check `mailery billing status`." });
          return;
        }
        if (!json) deps.stderr(".");
        await sleep(deps, intervalMs);
      }
    });
  });

  const billing = program.command("billing").description("Billing, prepaid wallet, and usage");
  const billingStatus = leaf(billing, "status", "Show credit balance, prepaid wallet, plans, subscriptions, and recent ledger");
  billingStatus.action(async () => {
    const json = jsonOf(billingStatus, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const overview = await client.getBillingStatus();
      ok(deps, json, overview, [
        `balance: ${overview.balance} credits`,
        ...inboundUsageLines(overview.inbound_usage),
        `wallet: ${formatUsdCents(overview.wallet?.balance_cents)}`,
        `subscriptions: ${(overview.subscriptions ?? []).map((s) => `${s.plan ?? "?"}:${s.status}`).join(", ") || "(none)"}`,
      ]);
    });
  });

  // ── prepaid wallet (launch lane L07) ──
  // The wallet is the USD balance domain purchases and renewals are charged
  // against. It is reported separately from send credits on purpose: they are
  // different currencies with different economics.
  const billingWallet = leaf(billing, "wallet", "Show the prepaid wallet balance domain purchases and renewals are charged against");
  billingWallet.option("--limit <n>", "Wallet transactions to show (1-100, default 20)");
  billingWallet.action(async () => {
    const json = jsonOf(billingWallet, deps);
    const opts = billingWallet.opts<{ limit?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const wallet = await client.getWallet({ limit: opts.limit ? Number(opts.limit) : undefined });
      ok(deps, json, wallet, [
        `wallet balance: ${formatUsdCents(wallet.balance_cents)}`,
        ...(wallet.transactions ?? []).slice(0, 10).map((t) => `  ${t.created_at}  ${t.delta_cents > 0 ? "+" : ""}${formatUsdCents(t.delta_cents)}  ${t.reason} (=${formatUsdCents(t.balance_after_cents)})`),
      ]);
    });
  });

  const billingAddFunds = leaf(billing, "add-funds <amount>", "Add funds to the prepaid wallet (amount in dollars, e.g. 25 or 25.00; minimum 10)");
  billingAddFunds.option("--yes", "Confirm the top-up may spend money (required; non-interactive)");
  billingAddFunds.option("--idempotency-key <key>", "Caller-stable key so a retried top-up replays the same checkout instead of opening a second one");
  billingAddFunds.action(async (amount: string) => {
    const json = jsonOf(billingAddFunds, deps);
    const opts = billingAddFunds.opts<{ yes?: boolean; idempotencyKey?: string }>();
    await run(deps, json, async () => {
      const amountCents = parseUsdAmountToCents(amount);
      if (amountCents === undefined) {
        fail(deps, json, {
          code: "invalid_amount",
          message: `"${amount}" is not a dollar amount; pass e.g. 25 or 25.00`,
          hint: "Presets: 10, 25, 50, 100.",
        });
        return;
      }
      if (amountCents < 1000) {
        fail(deps, json, {
          code: "wallet_topup_below_minimum",
          message: "the minimum wallet top-up is $10.00",
          details: { amount_cents: amountCents, minimum_cents: 1000, presets_cents: [1000, 2500, 5000, 10000] },
        });
        return;
      }
      const suggestedIdempotencyKey = opts.idempotencyKey ?? `mailery-cli-wallet-topup:${amountCents}:${randomUUID()}`;
      // A top-up opens a payable Stripe Checkout, so consent is explicit and
      // the key binds the retry — same discipline as `domains buy`.
      if (!opts.yes) {
        fail(deps, json, {
          code: "topup_confirmation_required",
          message: `adding ${formatUsdCents(amountCents)} to the prepaid wallet requires --yes`,
          details: { amount_cents: amountCents, suggested_idempotency_key: suggestedIdempotencyKey },
          hint: `Run \`mailery billing add-funds ${amount} --yes --idempotency-key ${suggestedIdempotencyKey}\`.`,
        });
        return;
      }
      if (!opts.idempotencyKey) {
        fail(deps, json, {
          code: "idempotency_key_required",
          message: "--idempotency-key is required for a wallet top-up",
          details: { amount_cents: amountCents, suggested_idempotency_key: suggestedIdempotencyKey },
          hint: `Retry with --idempotency-key ${suggestedIdempotencyKey}; keep that exact key for every retry of this top-up.`,
        });
        return;
      }
      const client = buildClient(deps, { preferSession: true });
      const result = await client.topUpWallet({ amountCents, idempotencyKey: opts.idempotencyKey });
      if (deps.interactive && result.url) deps.openBrowser?.(result.url);
      ok(deps, json, result, [
        `Top-up of ${formatUsdCents(amountCents)} started.`,
        `Checkout URL: ${result.url}`,
        "Funds land in the wallet once the payment completes; check `mailery billing wallet`.",
      ]);
    });
  });

  const usage = leaf(program, "usage", "Show inbound allowance, credit balance, and the recent credit ledger");
  usage.action(async () => {
    const json = jsonOf(usage, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.getUsage();
      ok(deps, json, result, [
        `balance: ${result.balance} credits`,
        ...inboundUsageLines(result.inbound_usage),
        ...(result.ledger ?? []).slice(0, 10).map((l) => `  ${l.createdAt}  ${l.delta > 0 ? "+" : ""}${l.delta}  ${l.reason} (=${l.balanceAfter})`),
      ]);
    });
  });

  // ── domains ──
  const domains = program.command("domains").description("Search, buy or connect, verify, enable, and inspect sending domains");

  const domainsSearch = leaf(domains, "search <query>", "Check domain availability");
  domainsSearch.action(async (query: string) => {
    const json = jsonOf(domainsSearch, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const availability = withPublicDomainAvailability(await client.searchDomains(query));
      ok(deps, json, availability,
        `${availability.domain}: ${availability.available ? "available" : "unavailable"}${availability.premium ? " (premium)" : ""}`);
    });
  });

  const domainsBuy = leaf(domains, "buy <domain>", "Quote, confirm, purchase, and provision a domain into a ready-to-send identity");
  domainsBuy.option("--yes", "Confirm the quoted purchase may spend money (required; non-interactive)");
  domainsBuy.option("--max-price-cents <cents>", "Maximum all-in price authorized, in the expected currency's minor units");
  domainsBuy.option("--currency <currency>", "Expected three-letter quote currency", "usd");
  domainsBuy.option("--idempotency-key <key>", "Required caller-stable idempotency key for this paid operation");
  domainsBuy.action(async (domain: string) => {
    const json = jsonOf(domainsBuy, deps);
    const opts = domainsBuy.opts<{ yes?: boolean; maxPriceCents?: string; currency: string; idempotencyKey?: string }>();
    await run(deps, json, async () => {
      // Binding quote/confirm flow (see authorizePaidDomainOperation): nothing
      // is POSTed until the signed quote, the price ceiling, the currency and
      // the caller-stable idempotency key all line up.
      const client = buildClient(deps);
      const authorization = await authorizePaidDomainOperation(deps, json, client, domain, opts, {
        command: `mailery domains buy ${domain}`,
        keyPrefix: "mailery-cli-domain-purchase",
      });
      if (!authorization) return;
      const result = await client.purchaseDomain({ domain, ...authorization });
      const readyToSend = result.outbound_enabled === true;
      ok(deps, json, result, readyToSend
        ? `Domain ${domain} is ready to send.`
        : `Domain ${domain} purchased (ownership ${result.ownership_ready ? "ready" : "pending"}); outbound not yet enabled — request a fresh quote before retrying.`);
    });
  });

  const domainsList = leaf(domains, "list", "List the tenant's domains");
  domainsList.action(async () => {
    const json = jsonOf(domainsList, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const rows = await client.listDomains();
      ok(deps, json, rows, rows.length ? rows.map((d) => `${d.id}  ${d.domain}  ${String((d as { status?: string }).status ?? "")}`) : ["(no domains)"]);
    });
  });

  // ── bring-your-own-domain lifecycle (launch lane L09 part 2, M09-005) ──
  // Every verb below wraps one /api/v1/domains operation the SDK already
  // exposes, taking only the fields the public contract (docs/openapi.json
  // DomainSetupRequest) documents — provider names and DNS-authority knobs stay
  // internal. Nothing here spends unless `setup --buy` is combined with the
  // same quote/confirm consent `domains buy` requires, and nothing changes DNS
  // or nameservers unless the matching consent flag is passed explicitly: the
  // server fails closed without them and this CLI never sets them by default.
  const domainsAdd = leaf(domains, "add <domain>", "Register a domain you already own as a lifecycle record; publishes nothing and changes no DNS");
  domainsAdd
    .option("--mailbox-id <id>", "Default mailbox that receives inbound mail for the domain")
    .option("--catch-all", "Route unmatched recipients on the domain to that mailbox");
  domainsAdd.action(async (domain: string) => {
    const json = jsonOf(domainsAdd, deps);
    const opts = domainsAdd.opts<{ mailboxId?: string; catchAll?: boolean }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const record = await client.createDomain({
        domain,
        ...(opts.mailboxId ? { mailboxId: opts.mailboxId } : {}),
        ...(opts.catchAll ? { catchAll: true } : {}),
      });
      ok(deps, json, record, [
        `Added ${record.domain} (${record.id}).`,
        ...domainStateLines(record),
        `Next: \`mailery domains setup ${record.domain}\` plans the DNS records to publish, then \`mailery domains verify ${record.id}\` checks them.`,
      ]);
    });
  });

  const domainsSetup = leaf(domains, "setup <domain>", "Connect a domain you own (or --buy one) and return the DNS records to publish; the MX record and nameservers change only with the explicit consent flags");
  domainsSetup
    .option("--address <local-part>", "Local part of the mailbox you plan on the domain; echoed back as the planned address only — create it with `mailery mailboxes create <local-part>@<domain>` once outbound is enabled")
    .option("--catch-all", "Route unmatched recipients on the domain to its default mailbox (implies --inbound)")
    .option("--inbound", "Plan inbound mail for the domain (adds an MX record to the plan)")
    .option("--mx-migration-consent", "Consent to the MX record: once published, mail for the domain routes to Mailery (required for --inbound/--catch-all to include it)")
    .option("--dns-delegation-consent", "Consent to point the domain's nameservers at Mailery-managed DNS (applies to a domain bought through Mailery)")
    .option("--buy", "Buy the domain first, charged to the prepaid wallet (same quote/confirm consent as `domains buy`)")
    .option("--yes", "With --buy: confirm the quoted purchase may spend money (required; non-interactive)")
    .option("--max-price-cents <cents>", "With --buy: maximum all-in price authorized, in the expected currency's minor units")
    .option("--currency <currency>", "With --buy: expected three-letter quote currency", "usd")
    .option("--idempotency-key <key>", "With --buy: required caller-stable idempotency key for this paid operation")
    .option("--auto-renew", "With --buy: opt in to auto-renew (off by default)");
  domainsSetup.action(async (domain: string) => {
    const json = jsonOf(domainsSetup, deps);
    const opts = domainsSetup.opts<{
      address?: string; catchAll?: boolean; inbound?: boolean; mxMigrationConsent?: boolean; dnsDelegationConsent?: boolean;
      buy?: boolean; yes?: boolean; maxPriceCents?: string; currency: string; idempotencyKey?: string; autoRenew?: boolean;
    }>();
    await run(deps, json, async () => {
      // Purchase-only flags without --buy are a mistake worth stopping: a caller
      // who passed --yes or an idempotency key expected to buy something.
      if (!opts.buy && (opts.yes || opts.maxPriceCents !== undefined || opts.idempotencyKey !== undefined || opts.autoRenew)) {
        fail(deps, json, {
          code: "cli_usage_error",
          message: "--yes, --max-price-cents, --idempotency-key and --auto-renew apply only together with --buy",
          hint: `Connect a domain you own with \`mailery domains setup ${domain}\`; buy it with \`mailery domains setup ${domain} --buy\`.`,
        });
        return;
      }
      // Only flags the caller passed reach the server; a consent that is not
      // explicitly true is never sent at all, so it can never default on.
      const plan = {
        domain,
        ...(opts.address ? { address: opts.address } : {}),
        ...(opts.catchAll ? { catchAll: true } : {}),
        ...(opts.inbound ? { inbound: true } : {}),
        ...(opts.mxMigrationConsent ? { mxMigrationConsent: true } : {}),
        ...(opts.dnsDelegationConsent ? { dnsDelegationConsent: true } : {}),
      };
      const client = buildClient(deps);
      let result: Record<string, unknown>;
      if (opts.buy) {
        const authorization = await authorizePaidDomainOperation(deps, json, client, domain, opts, {
          command: `mailery domains setup ${domain} --buy`,
          keyPrefix: "mailery-cli-domain-setup",
        });
        if (!authorization) return;
        result = await client.setupDomain({ ...plan, buy: true, ...authorization, ...(opts.autoRenew ? { autoRenew: true } : {}) });
      } else {
        result = await client.setupDomain(plan);
      }
      const record = result.domain_record && typeof result.domain_record === "object"
        ? asDomainRecord(result.domain_record as Record<string, unknown>, "")
        : undefined;
      // Persisted records (with verification status) win over the plan's view.
      const records = (Array.isArray(record?.dns_records) ? record!.dns_records : Array.isArray(result.records) ? result.records : []) as Array<Record<string, unknown>>;
      const billing = result.billing as { wallet_debit_cents?: number; wallet_balance_cents?: number } | undefined;
      const mailbox = result.mailbox as { email?: string } | undefined;
      ok(deps, json, result, [
        `${opts.buy ? "Purchase started and setup planned" : "Setup planned"} for ${String(result.domain ?? domain)}${record?.id ? ` (${record.id})` : ""}: ${String(result.status ?? "unknown")}.`,
        ...(result.status === "pending_mx_consent" ? ["Inbound MX was NOT included: re-run with --mx-migration-consent to route the domain's mail to Mailery."] : []),
        ...(mailbox?.email ? [`Planned mailbox: ${mailbox.email} (not created yet: run \`mailery mailboxes create ${mailbox.email}\` after \`mailery domains enable-outbound ${record?.id ?? "<id>"}\`).`] : []),
        ...(billing ? [`charged: ${formatUsdCents(billing.wallet_debit_cents)}  wallet left: ${formatUsdCents(billing.wallet_balance_cents)}`] : []),
        "DNS records:",
        ...(record?.id ? dnsRecordLines(record.id, records) : records.map(dnsRecordLine)),
      ]);
    });
  });

  const domainsDns = leaf(domains, "dns <id>", "List the DNS records Mailery needs for a domain and whether each one is verified yet");
  domainsDns.action(async (id: string) => {
    const json = jsonOf(domainsDns, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const rows = await client.listDomainDns(id);
      ok(deps, json, rows, dnsRecordLines(id, rows));
    });
  });

  const domainsVerify = leaf(domains, "verify <id>", "Re-check the domain's DNS and mail identity and refresh its readiness (run after publishing the records)");
  domainsVerify.action(async (id: string) => {
    const json = jsonOf(domainsVerify, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.verifyDomain(id);
      const record = asDomainRecord(result, id);
      ok(deps, json, result, [
        `Verified ${record.domain || id}.`,
        ...domainStateLines(record),
        domainNextStep(record),
      ]);
    });
  });

  const domainsEnableInbound = leaf(domains, "enable-inbound <id>", "Enable inbound mail for a verified domain: provisions Mailery's receipt routing for it (the MX record must already be published)");
  domainsEnableInbound.action(async (id: string) => {
    const json = jsonOf(domainsEnableInbound, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.enableDomainInbound(id);
      const record = asDomainRecord(result, id);
      ok(deps, json, result, [
        `Inbound enabled for ${record.domain || id}.`,
        ...domainStateLines(record),
        domainNextStep(record),
      ]);
    });
  });

  const domainsEnableOutbound = leaf(domains, "enable-outbound <id>", "Enable outbound sending once the domain's outbound readiness is ready");
  domainsEnableOutbound.action(async (id: string) => {
    const json = jsonOf(domainsEnableOutbound, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.enableDomainOutbound(id);
      const record = asDomainRecord(result, id);
      ok(deps, json, result, [
        `Outbound enabled for ${record.domain || id}.`,
        ...domainStateLines(record),
        domainNextStep(record),
      ]);
    });
  });

  const domainsDisable = leaf(domains, "disable <id>", "Pause inbound and outbound for a domain and withdraw its inbound routing; enable-inbound / enable-outbound lift the pause again");
  domainsDisable.option("--reason <text>", "Reason recorded on the restriction and its audit entry");
  domainsDisable.action(async (id: string) => {
    const json = jsonOf(domainsDisable, deps);
    const opts = domainsDisable.opts<{ reason?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.disableDomain(id, opts.reason);
      const record = asDomainRecord(result, id);
      ok(deps, json, result, [
        `Disabled ${record.domain || id}: inbound and outbound paused.`,
        ...domainStateLines(record),
        `Re-enable with \`mailery domains enable-outbound ${id}\` and \`mailery domains enable-inbound ${id}\` (each re-checks readiness first and lifts this pause).`,
      ]);
    });
  });

  // ── renewals (launch lane L07) ──
  // Renewing spends real money from the prepaid wallet, so it takes the same
  // consent shape as `domains buy`: explicit --yes plus a caller-stable
  // idempotency key that binds every retry to one charge.
  const domainsRenew = leaf(domains, "renew <id>", "Renew a domain purchased through Mailery, charged to the prepaid wallet");
  domainsRenew.option("--yes", "Confirm the renewal may spend wallet funds (required; non-interactive)");
  domainsRenew.option("--auto-renew <state>", "Also set auto-renew (on|off), applied only after the renewal succeeds");
  domainsRenew.option("--idempotency-key <key>", "Required caller-stable idempotency key for this paid operation");
  domainsRenew.action(async (id: string) => {
    const json = jsonOf(domainsRenew, deps);
    const opts = domainsRenew.opts<{ yes?: boolean; autoRenew?: string; idempotencyKey?: string }>();
    await run(deps, json, async () => {
      const suggestedIdempotencyKey = opts.idempotencyKey ?? `mailery-cli-domain-renew:${id}:${randomUUID()}`;
      if (!opts.yes) {
        fail(deps, json, {
          code: "renewal_confirmation_required",
          message: `renewing ${id} spends prepaid wallet funds and requires --yes`,
          details: { suggested_idempotency_key: suggestedIdempotencyKey },
          hint: `Check \`mailery billing wallet\`, then run \`mailery domains renew ${id} --yes --idempotency-key ${suggestedIdempotencyKey}\`.`,
        });
        return;
      }
      if (!opts.idempotencyKey) {
        fail(deps, json, {
          code: "idempotency_key_required",
          message: "--idempotency-key is required for paid domain renewal",
          details: { suggested_idempotency_key: suggestedIdempotencyKey },
          hint: `Retry with --idempotency-key ${suggestedIdempotencyKey}; keep that exact key for every retry of this renewal.`,
        });
        return;
      }
      // Omitted means "leave the opt-in as it is"; an unrecognized value is
      // rejected rather than silently treated as off.
      const explicitAutoRenew = parseOnOff(opts.autoRenew);
      if (opts.autoRenew !== undefined && explicitAutoRenew === undefined) {
        fail(deps, json, { code: "cli_usage_error", message: "--auto-renew must be on or off" });
        return;
      }
      const client = buildClient(deps);
      const result = await client.renewDomain({
        id,
        idempotencyKey: opts.idempotencyKey,
        ...(explicitAutoRenew === undefined ? {} : { autoRenew: explicitAutoRenew }),
      });
      ok(deps, json, result, [
        `Renewed ${result.domain}${result.expires_at ? ` until ${result.expires_at}` : ""}.`,
        `charged: ${formatUsdCents(result.billing?.wallet_debit_cents)}  wallet left: ${formatUsdCents(result.billing?.wallet_balance_cents)}`,
        `auto-renew: ${result.auto_renew ? "on" : "off"}`,
      ]);
    });
  });

  const domainsAutoRenew = leaf(domains, "auto-renew <id> <state>", "Turn auto-renew on or off for a domain (state: on or off). Spends nothing.");
  domainsAutoRenew.action(async (id: string, state: string) => {
    const json = jsonOf(domainsAutoRenew, deps);
    await run(deps, json, async () => {
      const enabled = parseOnOff(state);
      if (enabled === undefined) {
        fail(deps, json, { code: "cli_usage_error", message: "state must be on or off", hint: `mailery domains auto-renew ${id} on` });
        return;
      }
      const client = buildClient(deps);
      const renewal = await client.setDomainAutoRenew(id, enabled);
      ok(deps, json, renewal, [
        `auto-renew for ${renewal.domain}: ${renewal.auto_renew ? "on" : "off"}`,
        renewal.auto_renew
          ? "Auto-renew proceeds only when the prepaid wallet covers the renewal; otherwise Mailery notifies you instead of letting it lapse."
          : "This domain will NOT renew itself.",
      ]);
    });
  });

  const domainsStatus = leaf(domains, "status <domain>", "Show product-level readiness for a domain");
  domainsStatus.action(async (domain: string) => {
    const json = jsonOf(domainsStatus, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const status = await client.getDomainStatus(domain);
      const record = status.domain_record as MaileryTenantDomain | null | undefined;
      ok(deps, json, status, record ? [`${record.domain} (${record.id})`, ...domainStateLines(record)] : undefined);
    });
  });

  // ── mailboxes ──
  const mailboxes = program.command("mailboxes").description("Manage mailboxes");

  const mailboxesCreate = leaf(mailboxes, "create <address>", "Create a mailbox");
  // Omitting --provider creates a HOSTED mailbox (the managed mail plane), which
  // is what `mailery send` needs; `manual` is the aggregation-only backend.
  mailboxesCreate.option("--name <name>", "Display name").option("--provider <provider>", "advanced mailbox backend: hosted (default), manual, or sandbox");
  mailboxesCreate.action(async (address: string) => {
    const json = jsonOf(mailboxesCreate, deps);
    const opts = mailboxesCreate.opts<{ name?: string; provider?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const mailbox = await client.createMailbox({ email: address, name: opts.name, provider: opts.provider });
      ok(deps, json, mailbox, `Mailbox ${mailbox.email} (${mailbox.id}).`);
    });
  });

  const mailboxesList = leaf(mailboxes, "list", "List the tenant's mailboxes");
  mailboxesList.action(async () => {
    const json = jsonOf(mailboxesList, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const rows = await client.listMailboxes();
      ok(deps, json, rows, rows.length ? rows.map((m) => `${m.id}  ${m.email}  ${m.status}`) : ["(no mailboxes)"]);
    });
  });

  const mailboxesDelete = leaf(mailboxes, "delete <id>", "Delete a mailbox (refused while it still holds messages unless --purge)");
  mailboxesDelete.option("--purge", "Also delete the messages the mailbox holds. This cannot be undone.");
  mailboxesDelete.action(async (id: string) => {
    const json = jsonOf(mailboxesDelete, deps);
    const opts = mailboxesDelete.opts<{ purge?: boolean }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.deleteMailbox(id, { purge: opts.purge });
      ok(deps, json, result, `Mailbox ${result.email} deleted${result.purged_messages ? ` with ${result.purged_messages} message(s)` : ""}.`);
    });
  });

  // ── mail ──
  const send = leaf(program, "send", "Send hosted email (flags for headers, attachments, threading; body via --text/--html or piped stdin)");
  send
    .option("--mailbox <id>", "Mailbox id to send from")
    .option("--from <address>", "Sender address; resolved to one of your mailboxes (alternative to --mailbox)")
    .option("--to <recipients>", "Comma-separated recipient addresses")
    .option("--cc <recipients>", "Comma-separated CC addresses")
    .option("--bcc <recipients>", "Comma-separated BCC addresses")
    .option("--subject <subject>", "Subject line")
    .option("--text <text>", "Plain-text body (omit to read from stdin)")
    .option("--html <html>", "HTML body")
    .option("--reply-to <recipients>", "Comma-separated Reply-To addresses")
    .option("--attach <path>", "Attach a local file (repeatable; max 10 files, 10 MiB total)", collect, [])
    .option("--attach-id <id>", "Attach an attachment already stored on your tenant, by id (repeatable)", collect, [])
    .option("--in-reply-to <messageId>", "Message-ID being replied to; threads the reply in the recipient's client")
    .option("--references <messageIds>", "Comma-separated References ancestry of the parent, oldest first")
    .option("--header <name:value>", "Custom header (repeatable; X- headers plus a few standard filing headers)", collect, [])
    .option("--idempotency-key <key>", "YOUR stable key for this send; retrying with it replays the original result instead of sending twice");
  send.action(async () => {
    const json = jsonOf(send, deps);
    const opts = send.opts<SendFlags>();
    await run(deps, json, async () => {
      const to = splitList(opts.to);
      if (!opts.mailbox && !opts.from) { fail(deps, json, { code: "cli_usage_error", message: "one of --mailbox <id> or --from <address> is required", hint: "List mailboxes with `mailery mailboxes list`." }); return; }
      if (!to) { fail(deps, json, { code: "cli_usage_error", message: "--to <recipients> is required" }); return; }
      let headers: Record<string, string> | undefined;
      try {
        headers = parseHeaderFlags(opts.header);
      } catch (err) {
        fail(deps, json, { code: "cli_usage_error", message: err instanceof Error ? err.message : String(err), hint: "Use --header 'X-Campaign: spring-2026'." });
        return;
      }
      const client = buildClient(deps);
      // --mailbox wins; --from is resolved to a mailbox id by matching the
      // sender address against the tenant's mailboxes (case-insensitive).
      let mailboxId = opts.mailbox;
      if (!mailboxId && opts.from) {
        const from = opts.from.trim().toLowerCase();
        const rows = await client.listMailboxes();
        const match = rows.find((m) => String(m.email ?? "").trim().toLowerCase() === from);
        if (!match) {
          fail(deps, json, { code: "cli_usage_error", message: `no mailbox found for --from ${opts.from}`, hint: "List mailboxes with `mailery mailboxes list`, or create one with `mailery mailboxes create <address>`." });
          return;
        }
        mailboxId = match.id;
      }
      if (!mailboxId) { fail(deps, json, { code: "cli_usage_error", message: "one of --mailbox <id> or --from <address> is required" }); return; }
      let text = opts.text;
      // Only read stdin when there is no body AND no file is being attached:
      // `mailery send --attach report.pdf < /dev/null` must not turn an empty
      // pipe into a body, and a piped body is still honoured otherwise.
      if (text === undefined && opts.html === undefined && deps.readStdin) {
        const piped = await deps.readStdin();
        if (piped && piped.trim()) text = piped;
      }
      const attachments = await loadAttachments(deps, opts.attach, opts.attachId);
      const result = await client.send({
        mailboxId,
        to,
        cc: splitList(opts.cc),
        bcc: splitList(opts.bcc),
        subject: opts.subject,
        text,
        html: opts.html,
        replyTo: splitList(opts.replyTo),
        inReplyTo: opts.inReplyTo,
        references: splitList(opts.references),
        headers,
        attachments: attachments.length ? attachments : undefined,
        idempotencyKey: opts.idempotencyKey,
      });
      // Send-status honesty (PLA17-00095): a non-live server records the send
      // as test_sent and never dispatches it — say so instead of implying
      // delivery. Live mode dispatches via SES and reports the real status.
      const modeNote = result.mode && result.mode !== "live"
        ? ` Not dispatched in ${result.mode} mode: recorded with status "${result.status}", no email left Mailery.`
        : "";
      // A replay is called out explicitly: an agent that retried must be able
      // to tell "your retry replayed the first send" from "a second email".
      const replayNote = result.replayed ? " Replayed the original send for this idempotency key; no second email was sent." : "";
      ok(deps, json, result, `Sent message ${result.id} (status ${result.status}${result.mode ? `, mode ${result.mode}` : ""}).${modeNote}${replayNote}`);
    });
  });

  // `mailery send batch --file batch.json` (or piped JSON). The file is either
  // an array of send bodies or `{ "messages": [...] }`; each entry takes the
  // same fields the send flags map to, plus its own idempotencyKey.
  const sendBatch = leaf(send, "batch", "Send up to 100 messages from a JSON file or piped JSON; each entry may carry its own idempotencyKey");
  sendBatch.option("--file <path>", "JSON file: an array of send bodies, or { \"messages\": [...] }. Omit to read the JSON from stdin.");
  sendBatch.action(async () => {
    const json = jsonOf(sendBatch, deps);
    const opts = sendBatch.opts<{ file?: string }>();
    await run(deps, json, async () => {
      let source: string;
      if (opts.file) {
        if (!deps.readFile) { fail(deps, json, { code: "cli_error", message: "no file reader available" }); return; }
        source = Buffer.from(await deps.readFile(opts.file)).toString("utf8");
      } else {
        source = deps.readStdin ? await deps.readStdin() : "";
      }
      if (!source.trim()) {
        fail(deps, json, { code: "cli_usage_error", message: "no batch payload: pass --file <path> or pipe JSON on stdin", hint: 'Example: mailery send batch --file batch.json' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch (err) {
        fail(deps, json, { code: "cli_usage_error", message: `batch payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : (parsed as { messages?: unknown }).messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        fail(deps, json, { code: "cli_usage_error", message: "batch payload must be a non-empty array of send bodies (or { messages: [...] })" });
        return;
      }
      const client = buildClient(deps);
      const result = await client.sendBatch(messages as Parameters<typeof client.sendBatch>[0]);
      ok(deps, json, result, [
        `Batch: ${result.sent} sent, ${result.failed} failed (${result.count} submitted).`,
        `Metering: drew ${result.metering.messages} ${result.metering.unit === "none" ? "unmetered" : result.metering.unit}, kept ${result.metering.retained}, returned ${result.metering.refunded}.`,
        ...result.results.map((row) => row.status === "sent"
          ? `  [${row.index}] sent ${row.message?.id ?? ""}${row.replayed ? " (replayed)" : ""}`
          : `  [${row.index}] failed ${row.error?.code ?? "error"}: ${row.error?.message ?? ""}`),
      ]);
    });
  });

  // ── delivery events ──
  const events = leaf(program, "events <messageId>", "Show one message's delivery timeline (sent/delivered/bounced/complained/rejected) with its current status");
  events.option("--limit <n>", "Max events to return", "100");
  events.action(async (messageId: string) => {
    const json = jsonOf(events, deps);
    const opts = events.opts<{ limit: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const timeline = await client.getMessageEvents(messageId, { limit: Number(opts.limit) || 100 });
      ok(deps, json, timeline, [
        `status: ${timeline.status}${timeline.last_event_at ? ` (last event ${timeline.last_event_at})` : " (no provider events yet)"}`,
        ...timeline.data.map((event) => `  ${event.occurred_at}  ${event.type}${event.reason_code ? `  ${event.reason_code}` : ""}  ${(event.recipients ?? []).join(", ")}`),
      ]);
    });
  });

  const inbox = leaf(program, "inbox", "List inbox messages; --watch to stream new ones as they arrive");
  inbox
    .option("--watch", "Poll and print new messages until interrupted")
    .option("--interval <seconds>", "Watch poll interval in seconds", "10")
    .option("--limit <n>", "Max messages per page", "25")
    .option("--cursor <cursor>", "Page cursor from the previous response's nextCursor (omit on the first call)")
    .option("--group <group>", "Folder/group, e.g. inbox, sent, spam")
    .option("--q <query>", "Full-text search query")
    .option("--mailbox <id>", "Restrict to a mailbox id")
    .option("--direction <direction>", "inbound or outbound");
  inbox.action(async () => {
    const json = jsonOf(inbox, deps);
    const opts = inbox.opts<{ watch?: boolean; interval: string; limit: string; cursor?: string; group?: string; q?: string; mailbox?: string; direction?: string }>();
    await run(deps, json, async () => {
      if (opts.cursor && opts.watch) {
        fail(deps, json, { code: "cli_usage_error", message: "--cursor cannot be combined with --watch", hint: "Page through results with --cursor, or stream live arrivals with --watch." });
        return;
      }
      const client = buildClient(deps);
      const query = {
        group: opts.group,
        q: opts.q,
        mailboxId: opts.mailbox,
        direction: opts.direction as "inbound" | "outbound" | undefined,
        limit: Math.max(1, Number(opts.limit) || 25),
        cursor: opts.cursor,
      };
      const printRow = (m: Record<string, unknown>) => `${String(m.id)}  ${String(m.direction ?? "")}  ${String(m.fromAddress ?? "")}  ${String(m.subject ?? "")}`;
      const page = await client.listInbox(query);
      // Scripts paginate on nextCursor (null = last page); has_more states that
      // explicitly so a loop does not have to null-check.
      const result = { data: page.data, nextCursor: page.nextCursor, has_more: page.nextCursor !== null };
      const humanRows = page.data.length ? page.data.map((m) => printRow(m as Record<string, unknown>)) : ["(inbox empty)"];
      if (!json && page.nextCursor) humanRows.push(`(more pages — rerun with \`mailery inbox --cursor ${page.nextCursor}\`)`);
      ok(deps, json, result, humanRows);
      if (!opts.watch) return;
      const seen = new Set(page.data.map((m) => String((m as { id?: unknown }).id)));
      const intervalMs = Math.max(1, Number(opts.interval) || 10) * 1000;
      for (;;) {
        await sleep(deps, intervalMs);
        const next = await client.listInbox(query);
        const fresh = next.data.filter((m) => !seen.has(String((m as { id?: unknown }).id)));
        for (const m of fresh) {
          seen.add(String((m as { id?: unknown }).id));
          if (json) printJson(deps, { ok: true, data: m });
          else deps.stdout(`${printRow(m as Record<string, unknown>)}\n`);
        }
      }
    });
  });

  const read = leaf(program, "read <id>", "Fetch one full message (bodies + attachments)");
  read.action(async (id: string) => {
    const json = jsonOf(read, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const message = await client.getMessage(id);
      ok(deps, json, message, [
        `subject: ${message.subject}`,
        `from:    ${message.fromAddress}`,
        `to:      ${(message.toAddresses ?? []).join(", ")}`,
        "",
        message.textBody ?? message.cleanMarkdown ?? "(no text body)",
      ]);
    });
  });

  // ── attachments ──
  const attachments = program.command("attachments").description("Inspect and download message attachments");
  const attachmentsDownload = leaf(
    attachments,
    "download <messageId> [attachmentId]",
    "With an attachment id: download its binary to --output ('-' streams raw bytes to stdout; default writes to the attachment's filename in the current directory). Without one: list the message's attachments (metadata only)",
  );
  attachmentsDownload.option("--output <path>", "Output path for the binary; '-' streams raw bytes to stdout (envelope/diagnostics go to stderr so pipes stay pure)");
  attachmentsDownload.action(async (messageId: string, attachmentId: string | undefined) => {
    const json = jsonOf(attachmentsDownload, deps);
    const opts = attachmentsDownload.opts<{ output?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      if (!attachmentId) {
        const rows = await client.listMessageAttachments(messageId);
        ok(deps, json, rows, rows.length
          ? rows.map((a) => `${a.id}  ${a.filename}  ${a.contentType}  ${a.sizeBytes}`)
          : ["(no attachments)"]);
        return;
      }
      // Metadata first: it supplies the default output filename and proves the
      // attachment belongs to this message before any bytes move.
      const rows = await client.listMessageAttachments(messageId);
      const meta = rows.find((a) => a.id === attachmentId);
      if (!meta) {
        fail(deps, json, {
          code: "attachment_not_found",
          message: `attachment ${attachmentId} not found on message ${messageId}`,
          hint: `Run \`mailery attachments download ${messageId}\` to list this message's attachment ids.`,
        });
        return;
      }
      const res = await client.downloadAttachment(attachmentId);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") ?? meta.contentType;
      if (opts.output === "-") {
        // Raw bytes to stdout; every diagnostic — including the JSON envelope —
        // goes to stderr so `> file` and `| cmd` receive only the payload.
        deps.stdout(bytes);
        ok({ ...deps, stdout: deps.stderr }, json, {
          message_id: messageId,
          attachment_id: attachmentId,
          filename: meta.filename,
          content_type: contentType,
          size_bytes: bytes.byteLength,
          output: "-",
        });
        return;
      }
      const outputPath = opts.output ?? (pathBasename(meta.filename || "") || `attachment-${attachmentId}`);
      const writeBytes = deps.writeFile ?? fsWriteFile;
      await writeBytes(outputPath, bytes);
      ok(deps, json, {
        message_id: messageId,
        attachment_id: attachmentId,
        filename: meta.filename,
        content_type: contentType,
        size_bytes: bytes.byteLength,
        output: outputPath,
      }, `Wrote ${bytes.byteLength} bytes to ${outputPath} (${contentType}).`);
    });
  });

  // ── feedback ──
  // ── webhooks ──
  const webhooks = program.command("webhooks").description("Register HTTPS endpoints that receive signed Mailery events (webhooks-first; poll only as a fallback)");

  const webhooksCreate = leaf(webhooks, "create <url>", "Register a webhook endpoint; prints the signing secret once");
  webhooksCreate
    .option("--description <text>", "Human label for the endpoint")
    .option("--events <events>", "Comma-separated event filter (e.g. email.received,email.bounced or email.*); omit for every event")
    .option("--idempotency-key <key>", "Caller-stable key so a retried create replays the same endpoint + secret");
  webhooksCreate.action(async (url: string) => {
    const json = jsonOf(webhooksCreate, deps);
    const opts = webhooksCreate.opts<{ description?: string; events?: string; idempotencyKey?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.createWebhook({ url, description: opts.description, events: splitList(opts.events), idempotencyKey: opts.idempotencyKey });
      ok(deps, json, result, [
        `Webhook ${result.endpoint.id} → ${result.endpoint.url} (${result.endpoint.events?.join(", ") ?? "all events"}).`,
        `Signing secret (shown once): ${result.secret}`,
        "Store it where your receiver verifies the Mailery-Signature header; it is never shown again (rotate-secret issues a new one).",
      ]);
    });
  });

  const webhooksList = leaf(webhooks, "list", "List webhook endpoints (secret prefixes only)");
  webhooksList.action(async () => {
    const json = jsonOf(webhooksList, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const rows = await client.listWebhooks();
      ok(deps, json, rows, rows.length
        ? rows.map((w) => `${w.id}  ${w.url}  [${w.events?.join(", ") ?? "*"}]  ${w.status}${w.failure_count ? ` (${w.failure_count} consecutive failures)` : ""}`)
        : ["(no webhooks)"]);
    });
  });

  const webhooksGet = leaf(webhooks, "get <id>", "Show one webhook endpoint");
  webhooksGet.action(async (id: string) => {
    const json = jsonOf(webhooksGet, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const w = await client.getWebhook(id);
      ok(deps, json, w, [
        `id:       ${w.id}`,
        `url:      ${w.url}`,
        `events:   ${w.events?.join(", ") ?? "* (all)"}`,
        `status:   ${w.status}`,
        `secret:   ${w.secret_prefix}…`,
        `failures: ${w.failure_count}${w.last_failure_at ? ` (last ${w.last_failure_at})` : ""}`,
        `success:  ${w.last_success_at ?? "never"}`,
      ]);
    });
  });

  const webhooksUpdate = leaf(webhooks, "update <id>", "Update url, description, events, or status (active re-enables a disabled/dead endpoint)");
  webhooksUpdate
    .option("--url <url>", "New destination URL")
    .option("--description <text>", "New description")
    .option("--events <events>", "Comma-separated event filter, or `all` for every event")
    .option("--status <status>", "active or disabled");
  webhooksUpdate.action(async (id: string) => {
    const json = jsonOf(webhooksUpdate, deps);
    const opts = webhooksUpdate.opts<{ url?: string; description?: string; events?: string; status?: string }>();
    await run(deps, json, async () => {
      if (opts.url === undefined && opts.description === undefined && opts.events === undefined && opts.status === undefined) {
        fail(deps, json, { code: "cli_usage_error", message: "provide at least one of --url, --description, --events, --status" });
        return;
      }
      if (opts.status !== undefined && opts.status !== "active" && opts.status !== "disabled") {
        fail(deps, json, { code: "cli_usage_error", message: "--status must be active or disabled" });
        return;
      }
      const client = buildClient(deps);
      const patch: { url?: string; description?: string; events?: string[] | null; status?: "active" | "disabled" } = {};
      if (opts.url !== undefined) patch.url = opts.url;
      if (opts.description !== undefined) patch.description = opts.description;
      if (opts.events !== undefined) patch.events = opts.events.trim().toLowerCase() === "all" ? null : (splitList(opts.events) ?? null);
      if (opts.status !== undefined) patch.status = opts.status;
      const w = await client.updateWebhook(id, patch);
      ok(deps, json, w, `Webhook ${w.id} updated (${w.status}; ${w.events?.join(", ") ?? "all events"}).`);
    });
  });

  const webhooksDelete = leaf(webhooks, "delete <id>", "Delete a webhook endpoint and its delivery history");
  webhooksDelete.action(async (id: string) => {
    const json = jsonOf(webhooksDelete, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.deleteWebhook(id);
      ok(deps, json, result, `Webhook ${result.id} deleted.`);
    });
  });

  const webhooksRotate = leaf(webhooks, "rotate-secret <id>", "Issue a new signing secret (the old one stops validating immediately); prints it once");
  webhooksRotate.option("--idempotency-key <key>", "Caller-stable key so a retried rotation replays the same new secret");
  webhooksRotate.action(async (id: string) => {
    const json = jsonOf(webhooksRotate, deps);
    const opts = webhooksRotate.opts<{ idempotencyKey?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.rotateWebhookSecret(id, { idempotencyKey: opts.idempotencyKey });
      ok(deps, json, result, [
        `Webhook ${result.endpoint.id} secret rotated.`,
        `New signing secret (shown once): ${result.secret}`,
        "Update your receiver now — deliveries are already signed with the new secret.",
      ]);
    });
  });

  const webhooksTest = leaf(webhooks, "test <id>", "Queue a webhook.test event for the endpoint");
  webhooksTest.action(async (id: string) => {
    const json = jsonOf(webhooksTest, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.testWebhook(id);
      ok(deps, json, result, [
        `Test event ${result.event_id} queued (delivery ${result.delivery.id}, ${result.delivery.status}).`,
        `Check the outcome: mailery webhooks deliveries ${id}`,
      ]);
    });
  });

  const webhooksDeliveries = leaf(webhooks, "deliveries <id>", "List an endpoint's deliveries, newest first");
  webhooksDeliveries
    .option("--status <status>", "Filter: pending, delivered, failed, or dead")
    .option("--limit <n>", "Page size (1-200, default 50)")
    .option("--cursor <cursor>", "Continue from a previous page's nextCursor");
  webhooksDeliveries.action(async (id: string) => {
    const json = jsonOf(webhooksDeliveries, deps);
    const opts = webhooksDeliveries.opts<{ status?: string; limit?: string; cursor?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const page = await client.listWebhookDeliveries(id, { status: opts.status, limit: opts.limit ? Number(opts.limit) : undefined, cursor: opts.cursor });
      ok(deps, json, page, page.data.length
        ? [
          ...page.data.map((d) => `${d.id}  ${d.event_type}  ${d.status}  attempt ${d.attempt}${d.response_status ? `  HTTP ${d.response_status}` : ""}${d.last_error ? `  ${d.last_error}` : ""}`),
          ...(page.nextCursor ? [`next page: --cursor ${page.nextCursor}`] : []),
        ]
        : ["(no deliveries)"]);
    });
  });

  const webhooksRedeliver = leaf(webhooks, "redeliver <id> <deliveryId>", "Queue a fresh delivery of the same event");
  webhooksRedeliver.action(async (id: string, deliveryId: string) => {
    const json = jsonOf(webhooksRedeliver, deps);
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const delivery = await client.redeliverWebhook(id, deliveryId);
      ok(deps, json, delivery, `Redelivery ${delivery.id} queued for event ${delivery.event_id} (${delivery.event_type}).`);
    });
  });

  // ── suppressions ──
  const suppressions = program.command("suppressions").description("Inspect and clear the addresses hosted send refuses (bounces and spam complaints)");

  const suppressionsList = leaf(suppressions, "list", "List suppressed addresses, newest first");
  suppressionsList
    .option("--reason <reason>", "Filter: bounce, complaint, or manual")
    .option("--email <email>", "Look up one exact address")
    .option("--limit <n>", "Page size (1-200, default 50)")
    .option("--cursor <cursor>", "Continue from a previous page's nextCursor");
  suppressionsList.action(async () => {
    const json = jsonOf(suppressionsList, deps);
    const opts = suppressionsList.opts<{ reason?: string; email?: string; limit?: string; cursor?: string }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const page = await client.listSuppressions({
        reason: opts.reason,
        email: opts.email,
        limit: opts.limit ? Number(opts.limit) : undefined,
        cursor: opts.cursor,
      });
      ok(deps, json, page, page.data.length
        ? [
          ...page.data.map((row) => `${row.id}  ${row.email}  ${row.reason}  ${row.source}  ${row.created_at}`),
          ...(page.nextCursor ? [`next page: --cursor ${page.nextCursor}`] : []),
        ]
        : ["(no suppressions)"]);
    });
  });

  const suppressionsRemove = leaf(suppressions, "remove <id>", "Remove one suppression so the address can receive mail again");
  suppressionsRemove.option("--confirm", "Required for a complaint entry: that recipient reported the last message as spam");
  suppressionsRemove.action(async (id: string) => {
    const json = jsonOf(suppressionsRemove, deps);
    const opts = suppressionsRemove.opts<{ confirm?: boolean }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const result = await client.deleteSuppression(id, { confirm: opts.confirm });
      ok(deps, json, result, `Suppression for ${result.email} (${result.reason}) removed.`);
    });
  });

  const feedback = leaf(program, "feedback <message>", "Send product feedback (never billing-gated)");
  feedback
    .option("--kind <kind>", "bug, idea, question, praise, or other")
    .option("--severity <severity>", "low, medium, high, or critical")
    .option("--url <url>", "Absolute http(s) URL the feedback is about")
    .option("--tag <tag...>", "Tag to attach (repeatable)");
  feedback.action(async (message: string) => {
    const json = jsonOf(feedback, deps);
    const opts = feedback.opts<{ kind?: string; severity?: string; url?: string; tag?: string[] }>();
    await run(deps, json, async () => {
      const client = buildClient(deps);
      const entry = await client.submitFeedback({ message, kind: opts.kind, severity: opts.severity, url: opts.url, tags: opts.tag && opts.tag.length ? opts.tag : undefined });
      ok(deps, json, entry, `Feedback recorded (${entry.id}, ${entry.kind}).`);
    });
  });

  // ── mcp ──
  const mcp = program.command("mcp").description("Run the stdio MCP server (JSON-RPC over stdin/stdout) exposing Mailery tools");
  mcp.action(async () => {
    await runMcpServer(deps);
  });

  return program;
}

function isCommanderError(err: unknown): err is Error & { code?: string; exitCode?: number } {
  return err instanceof Error && typeof (err as { code?: unknown }).code === "string" && (err as unknown as { code: string }).code.startsWith("commander.");
}

function exitOverrideTree(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) exitOverrideTree(child);
}

export async function runCli(argv: string[] = process.argv, partial: Partial<CliDeps> = {}): Promise<void> {
  const deps = resolveDeps(partial);
  const program = buildProgram(deps);
  exitOverrideTree(program);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (isCommanderError(err)) {
      // Help and version are successful terminal states, not errors.
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.code === "commander.help") return;
      const json = deps.env.MAILERY_JSON === "1" || argv.includes("--json");
      const message = err.message || "usage error";
      if (json) printJson(deps, { ok: false, error: { code: "cli_usage_error", message } });
      else deps.stderr(`${message}\n`);
      // Usage errors get exit code 2 (distinct from runtime/API failures = 1).
      deps.setExitCode(2);
      return;
    }
    // Unexpected: surface as a generic CLI error rather than crashing.
    const json = deps.env.MAILERY_JSON === "1" || argv.includes("--json");
    fail(deps, json, toCliError(err));
  }
}
