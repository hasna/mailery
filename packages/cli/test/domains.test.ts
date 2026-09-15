// Bring-your-own-domain lifecycle verbs (launch lane L09 part 2, M09-005):
// add, setup, dns, verify, enable-inbound, enable-outbound, disable, and the
// wallet-charged renew. Each maps to one /api/v1/domains operation; the tests
// pin the request shape (nothing sent that was not asked for), the consent
// gates (nothing POSTed without them), and the envelope/exit-code contract.

import { describe, expect, test } from "bun:test";
import { buildProgram, runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut, type FetchCall } from "./support.js";

const API_KEY = { MAILERY_API_KEY: "ml_key" };

test("domain status exposes the actual warm-up recipient cap in text and JSON", async () => {
  const warmup = { status: "warming", day: "2026-09-13", ramp_day: 1, total_ramp_days: 15,
    daily_recipient_limit: 50, reserved_recipients: 12, remaining_recipients: 38,
    resolved_recipients: 10, bounce_rate: 0, complaint_rate: 0, resets_at: "2026-09-14T00:00:00.000Z" };
  const h = makeHarness({ env: API_KEY, route: () => ({ body: { domain: "agent-mail.com", domain_record: domainRecord({ warmup }) } }) });
  await runCli(argv("domains", "status", "agent-mail.com"), h.deps);
  expect(h.exitCode()).toBe(0);
  expect(h.out()).toContain("12/50 recipient slots used; 38 remaining");
  const j = makeHarness({ env: API_KEY, route: () => ({ body: { domain: "agent-mail.com", domain_record: domainRecord({ warmup }) } }) });
  await runCli(argv("domains", "status", "agent-mail.com", "--json"), j.deps);
  expect((parseJsonOut(j.out()).data as any).domain_record.warmup).toEqual(warmup);
});
const ID = "0190a1b2-0000-7000-8000-000000000001";

function domainRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    domain: "agent-mail.com",
    kind: "tenant_domain",
    status: "pending",
    provider: "ses",
    readiness: { ownership: "ready", dns: "pending", inbound: "not_requested", outbound: "pending", dmarc: "pending", events: "ready", billing: "ready" },
    enabled: { inbound: false, outbound: false },
    ...overrides,
  };
}

const DNS_ROWS = [
  { id: "r1", type: "TXT", name: "_amazonses.agent-mail.com", value: "token", ttl: 300, priority: null, purpose: "ses-verification", status: "pending", provider: "ses" },
  { id: "r2", type: "MX", name: "agent-mail.com", value: "inbound-smtp.us-east-1.amazonaws.com", ttl: 300, priority: 10, purpose: "inbound-mx", status: "verified", provider: "ses" },
];

const QUOTE = { token: "signed_quote", domain: "agent-mail.com", quoted_price_cents: 1500, currency: "usd", expires_at: "2030-01-01T00:00:00Z", idempotency_key_required: true };

function postsTo(calls: FetchCall[], path: string): FetchCall | undefined {
  return calls.find((c) => c.method === "POST" && c.path === path);
}

describe("domains add", () => {
  test("posts only the flags that were passed and prints the next step", async () => {
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === "/api/v1/domains" && c.method === "POST" ? { status: 201, body: domainRecord() } : undefined });
    await runCli(argv("domains", "add", "agent-mail.com", "--mailbox-id", "mb_1", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(h.exitCode()).toBe(0);
    expect(env.ok).toBe(true);
    expect((env.data as { id: string }).id).toBe(ID);
    const post = postsTo(h.calls, "/api/v1/domains")!;
    expect(post.body).toEqual({ domain: "agent-mail.com", mailboxId: "mb_1" });
    expect(post.headers["idempotency-key"] ?? post.headers["Idempotency-Key"]).toBeUndefined();
  });

  test("text mode names the id and points at setup then verify", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ status: 201, body: domainRecord() }) });
    await runCli(argv("domains", "add", "agent-mail.com", "--catch-all"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain(`Added agent-mail.com (${ID}).`);
    expect(h.out()).toContain("mailery domains setup agent-mail.com");
    expect(h.out()).toContain(`mailery domains verify ${ID}`);
    expect(postsTo(h.calls, "/api/v1/domains")!.body).toEqual({ domain: "agent-mail.com", catchAll: true });
  });
});

describe("domains setup (connect)", () => {
  const setupBody = {
    domain: "agent-mail.com",
    status: "planned",
    records: DNS_ROWS.map(({ type, name, value, ttl, priority, purpose }) => ({ type, name, value, ttl, priority, purpose, status: "required" })),
    domain_record: domainRecord({ dns_records: DNS_ROWS }),
    mailbox: { email: "bot@agent-mail.com", provider: "ses", status: "pending_domain_verification" },
  };

  test("sends no consent flag that was not passed, and no idempotency key", async () => {
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === "/api/v1/domains/setup" ? { body: setupBody } : undefined });
    await runCli(argv("domains", "setup", "agent-mail.com", "--address", "bot", "--inbound", "--json"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(parseJsonOut(h.out()).ok).toBe(true);
    const post = postsTo(h.calls, "/api/v1/domains/setup")!;
    expect(post.body).toEqual({ domain: "agent-mail.com", address: "bot", inbound: true });
    expect(post.headers["idempotency-key"] ?? post.headers["Idempotency-Key"]).toBeUndefined();
    // No availability lookup: connecting a domain you own never quotes.
    expect(h.calls.some((c) => c.path === "/api/v1/domains/availability")).toBe(false);
  });

  test("forwards every explicit consent flag as true, and only the public-contract fields", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: setupBody }) });
    await runCli(argv("domains", "setup", "agent-mail.com", "--catch-all", "--mx-migration-consent", "--dns-delegation-consent", "--json"), h.deps);
    expect(postsTo(h.calls, "/api/v1/domains/setup")!.body).toEqual({
      domain: "agent-mail.com",
      catchAll: true,
      mxMigrationConsent: true,
      dnsDelegationConsent: true,
    });
  });

  test("the DNS-authority knobs the public contract keeps internal are not CLI flags", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: setupBody }) });
    await runCli(argv("domains", "setup", "agent-mail.com", "--dns-authority-consent", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("cli_usage_error");
    expect(h.exitCode()).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  test("text mode prints the persisted DNS records, the planned mailbox and the verify step", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: setupBody }) });
    await runCli(argv("domains", "setup", "agent-mail.com", "--address", "bot"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain(`Setup planned for agent-mail.com (${ID}): planned.`);
    // The server only ECHOES the planned address (nothing creates the mailbox),
    // so the line says what still has to happen.
    expect(h.out()).toContain(`Planned mailbox: bot@agent-mail.com (not created yet: run \`mailery mailboxes create bot@agent-mail.com\` after \`mailery domains enable-outbound ${ID}\`).`);
    expect(h.out()).toContain("TXT  _amazonses.agent-mail.com  token  ttl 300  [pending] ses-verification");
    expect(h.out()).toContain("MX  agent-mail.com  10 inbound-smtp.us-east-1.amazonaws.com");
    expect(h.out()).toContain(`1 record(s) still to publish or propagate. Publish them at your DNS host, then run \`mailery domains verify ${ID}\`.`);
  });

  test("--address never advertises a mailbox the server does not create (the docs reference derives this text)", () => {
    const setup = buildProgram(makeHarness().deps).commands.find((c) => c.name() === "domains")!.commands.find((c) => c.name() === "setup")!;
    const address = setup.options.find((o) => o.flags.startsWith("--address"))!;
    expect(address.description).toContain("mailery mailboxes create");
    expect(address.description).not.toMatch(/created once|is created|creates a mailbox/i);
  });

  test("says so when the server withheld the MX record for lack of consent", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: { ...setupBody, status: "pending_mx_consent" } }) });
    await runCli(argv("domains", "setup", "agent-mail.com", "--inbound"), h.deps);
    expect(h.out()).toContain("Inbound MX was NOT included: re-run with --mx-migration-consent");
  });

  test("refuses purchase-only flags without --buy and never calls the server", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: setupBody }) });
    await runCli(argv("domains", "setup", "agent-mail.com", "--yes", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("cli_usage_error");
    expect(env.error!.message).toContain("--buy");
    expect(h.exitCode()).toBe(1);
    expect(h.calls).toHaveLength(0);
  });
});

describe("domains setup --buy", () => {
  const availability = { domain: "agent-mail.com", available: true, purchase_quote: QUOTE };

  test("without complete consent exposes the exact quote and never POSTs", async () => {
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === "/api/v1/domains/availability" ? { body: availability } : undefined });
    await runCli(argv("domains", "setup", "agent-mail.com", "--buy", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("price_confirmation_required");
    expect((env.error as { details: { quoted_price_cents: number } }).details.quoted_price_cents).toBe(1500);
    expect(env.error!.hint).toContain("mailery domains setup agent-mail.com --buy --yes --max-price-cents 1500 --currency usd --idempotency-key mailery-cli-domain-setup:agent-mail.com:");
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("rejects a maximum below the quote and never POSTs", async () => {
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === "/api/v1/domains/availability" ? { body: availability } : undefined });
    await runCli(argv("domains", "setup", "agent-mail.com", "--buy", "--yes", "--max-price-cents", "1499", "--idempotency-key", "idem_setup_1", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("price_limit_exceeded");
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("requires the idempotency key even with price-bound consent", async () => {
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === "/api/v1/domains/availability" ? { body: availability } : undefined });
    await runCli(argv("domains", "setup", "agent-mail.com", "--buy", "--yes", "--max-price-cents", "1500", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("idempotency_key_required");
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("posts the signed quote, the bound price and currency, the consent flags and the Idempotency-Key", async () => {
    const h = makeHarness({
      env: API_KEY,
      route: (c) => {
        if (c.path === "/api/v1/domains/availability") return { body: availability };
        if (c.path === "/api/v1/domains/setup" && c.method === "POST") {
          return { body: { domain: "agent-mail.com", status: "purchase_pending", records: [], domain_record: domainRecord(), billing: { quoted_price_cents: 1500, currency: "usd", wallet_debit_cents: 1500, wallet_balance_cents: 1000 } } };
        }
        return undefined;
      },
    });
    await runCli(argv("domains", "setup", "agent-mail.com", "--buy", "--yes", "--max-price-cents", "1500", "--currency", "USD", "--idempotency-key", "idem_setup_1", "--inbound", "--mx-migration-consent", "--auto-renew"), h.deps);
    expect(h.exitCode()).toBe(0);
    const post = postsTo(h.calls, "/api/v1/domains/setup")!;
    expect(post.headers["idempotency-key"] ?? post.headers["Idempotency-Key"]).toBe("idem_setup_1");
    expect(post.body).toEqual({
      domain: "agent-mail.com",
      inbound: true,
      mxMigrationConsent: true,
      buy: true,
      quoteToken: "signed_quote",
      maxPriceCents: 1500,
      currency: "usd",
      autoRenew: true,
    });
    expect(h.out()).toContain("Purchase started and setup planned for agent-mail.com");
    expect(h.out()).toContain("charged: $15.00  wallet left: $10.00");
  });
});

describe("paid retry once the registrar reports the name taken", () => {
  // After a first attempt the registrar accepted (or that timed out after
  // acceptance) the availability probe says "unavailable" and mints no quote,
  // so the server's same-key replay is unreachable from the CLI. The truthful
  // answer is the tenant's own record: already held, nothing charged.
  const unavailable = { domain: "agent-mail.com", available: false, purchase_supported: true };
  const owned = domainRecord({ purchase_status: "registered", readiness: { ownership: "ready", dns: "pending", inbound: "not_requested", outbound: "pending", dmarc: "pending" } });
  const routeOwned = (record: unknown) => (c: FetchCall) => {
    if (c.path === "/api/v1/domains/availability") return { body: unavailable };
    if (c.path === "/api/v1/domains/status") return { body: { domain: "agent-mail.com", domain_record: record } };
    return undefined;
  };
  const retry = ["--yes", "--max-price-cents", "1500", "--currency", "usd", "--idempotency-key", "idem_buy_1"];

  test("domains buy resolves to the tenant's record, POSTs nothing and exits 0", async () => {
    const h = makeHarness({ env: API_KEY, route: routeOwned(owned) });
    await runCli(argv("domains", "buy", "agent-mail.com", ...retry, "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { id: string; purchase_status: string }).purchase_status).toBe("registered");
    expect(h.exitCode()).toBe(0);
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);
    expect(h.calls.find((c) => c.path === "/api/v1/domains/status")!.query.domain).toBe("agent-mail.com");

    const text = makeHarness({ env: API_KEY, route: routeOwned(owned) });
    await runCli(argv("domains", "buy", "agent-mail.com", ...retry), text.deps);
    expect(text.out()).toContain(`agent-mail.com is already on this tenant (${ID}): purchase registered. Nothing to buy and nothing charged by this call.`);
    expect(text.out()).toContain(`mailery domains dns ${ID}`);
  });

  test("setup --buy shares the gate: an ambiguous earlier attempt points at status until the registrar confirms", async () => {
    const h = makeHarness({ env: API_KEY, route: routeOwned(domainRecord({ purchase_status: "registering", readiness: { ownership: "pending", dns: "pending", inbound: "not_requested", outbound: "pending", dmarc: "pending" } })) });
    await runCli(argv("domains", "setup", "agent-mail.com", "--buy", ...retry), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain("purchase registering");
    expect(h.out()).toContain("The registrar has not confirmed the earlier attempt yet: re-run `mailery domains status agent-mail.com` until purchase reads registered.");
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a name this tenant does not hold is still not purchasable", async () => {
    const h = makeHarness({ env: API_KEY, route: routeOwned(null) });
    await runCli(argv("domains", "buy", "agent-mail.com", ...retry, "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("domain_not_purchasable");
    expect(h.exitCode()).toBe(1);
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("domains dns", () => {
  test("lists records with status and the publish-then-verify step", async () => {
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === `/api/v1/domains/${ID}/dns` ? { body: { data: DNS_ROWS } } : undefined });
    await runCli(argv("domains", "dns", ID), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain("TXT  _amazonses.agent-mail.com  token  ttl 300  [pending] ses-verification");
    expect(h.out()).toContain(`then run \`mailery domains verify ${ID}\`.`);
  });

  test("--json returns the bare record array", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: { data: DNS_ROWS } }) });
    await runCli(argv("domains", "dns", ID, "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect(env.data).toEqual(DNS_ROWS);
    expect(h.calls[0]!.method).toBe("GET");
  });

  test("an empty plan says what to run", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: { data: [] } }) });
    await runCli(argv("domains", "dns", ID), h.deps);
    expect(h.out()).toContain("(no DNS records planned yet)");
    expect(h.out()).toContain("mailery domains setup <domain>");
  });
});

describe("domains verify / enable-inbound / enable-outbound / disable", () => {
  test("verify posts and reports readiness with the DNS next step", async () => {
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === `/api/v1/domains/${ID}/verify` && c.method === "POST" ? { body: domainRecord({ dns_records: DNS_ROWS }) } : undefined });
    await runCli(argv("domains", "verify", ID), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain("Verified agent-mail.com.");
    expect(h.out()).toContain("readiness: ownership ready, dns pending, inbound not_requested, outbound pending, dmarc pending");
    expect(h.out()).toContain(`mailery domains dns ${ID}`);
  });

  test("verify points at enable-outbound once outbound is ready", async () => {
    const ready = domainRecord({ readiness: { ownership: "ready", dns: "ready", inbound: "not_requested", outbound: "ready", dmarc: "monitoring" } });
    const h = makeHarness({ env: API_KEY, route: () => ({ body: ready }) });
    await runCli(argv("domains", "verify", ID), h.deps);
    expect(h.out()).toContain(`Outbound is ready: run \`mailery domains enable-outbound ${ID}\`.`);
  });

  test("verify suggests enable-inbound as soon as its preconditions hold, not only once the axis reads ready", async () => {
    // Live mode: the inbound axis stays "pending" until enable-inbound has
    // provisioned Mailery's routing, so waiting for "ready" would never name
    // the verb that gets there.
    const requested = domainRecord({ status: "active", readiness: { ownership: "ready", dns: "ready", inbound: "pending", outbound: "ready", dmarc: "monitoring" }, enabled: { inbound: false, outbound: true } });
    const h = makeHarness({ env: API_KEY, route: () => ({ body: requested }) });
    await runCli(argv("domains", "verify", ID), h.deps);
    expect(h.out()).toContain(`Inbound is requested and DNS is verified: run \`mailery domains enable-inbound ${ID}\``);
  });

  test("verify names the consent re-setup when inbound was planned without MX consent, and warns that it pauses sending", async () => {
    const blocked = domainRecord({ status: "active", readiness: { ownership: "ready", dns: "ready", inbound: "blocked", outbound: "ready", dmarc: "monitoring" }, enabled: { inbound: false, outbound: true } });
    const h = makeHarness({ env: API_KEY, route: () => ({ body: blocked }) });
    await runCli(argv("domains", "verify", ID), h.deps);
    expect(h.out()).toContain("mailery domains setup agent-mail.com --inbound --mx-migration-consent");
    expect(h.out()).toContain("pauses sending");
  });

  test("enable-outbound posts with no body and points at mailbox creation", async () => {
    const enabled = domainRecord({ status: "active", readiness: { ownership: "ready", dns: "ready", inbound: "not_requested", outbound: "ready", dmarc: "monitoring" }, enabled: { inbound: false, outbound: true } });
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === `/api/v1/domains/${ID}/enable-outbound` && c.method === "POST" ? { body: enabled } : undefined });
    await runCli(argv("domains", "enable-outbound", ID, "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { enabled: { outbound: boolean } }).enabled.outbound).toBe(true);
    expect(h.calls[0]!.body).toBeUndefined();
    const text = makeHarness({ env: API_KEY, route: () => ({ body: enabled }) });
    await runCli(argv("domains", "enable-outbound", ID), text.deps);
    expect(text.out()).toContain("Outbound enabled for agent-mail.com.");
    expect(text.out()).toContain("mailery mailboxes create <name>@agent-mail.com");
  });

  test("enable-inbound posts and reports the enabled state", async () => {
    const enabled = domainRecord({ status: "active", readiness: { ownership: "ready", dns: "ready", inbound: "ready", outbound: "ready", dmarc: "monitoring" }, enabled: { inbound: true, outbound: true } });
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === `/api/v1/domains/${ID}/enable-inbound` && c.method === "POST" ? { body: enabled } : undefined });
    await runCli(argv("domains", "enable-inbound", ID), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.out()).toContain("Inbound enabled for agent-mail.com.");
    expect(h.out()).toContain("enabled:   inbound yes, outbound yes");
  });

  test("enable-inbound surfaces the server's readiness refusal with an actionable hint", async () => {
    const h = makeHarness({
      env: API_KEY,
      route: () => ({ status: 409, body: { error: { code: "domain_not_inbound_ready", message: "domain ownership and DNS must be verified before enabling inbound mail", details: { inbound_status: "pending", ownership_status: "ready", dns_status: "pending" } } } }),
    });
    await runCli(argv("domains", "enable-inbound", ID, "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("domain_not_inbound_ready");
    expect(env.error!.status).toBe(409);
    expect(env.error!.hint).toContain("mailery domains dns <id>");
    // The verb that unblocks inbound is enable-inbound itself; "verify until
    // the axis reads ready" would poll forever in live mode.
    expect(env.error!.hint).toContain("retry `mailery domains enable-inbound <id>`");
    expect(env.error!.hint).toContain("reads ready only after that");
    expect(h.exitCode()).toBe(1);
  });

  test("a blocked inbound axis (setup without MX consent) gets the consent re-setup hint with the sending-pause warning", async () => {
    const h = makeHarness({
      env: API_KEY,
      route: () => ({ status: 409, body: { error: { code: "domain_not_inbound_ready", message: "domain inbound readiness must be ready before enabling inbound mail", details: { inbound_status: "blocked" } } } }),
    });
    await runCli(argv("domains", "enable-inbound", ID, "--json"), h.deps);
    const hint = parseJsonOut(h.out()).error!.hint!;
    expect(hint).toContain("--inbound --mx-migration-consent");
    expect(hint).toContain("mailery domains enable-outbound <id>");
    expect(hint).toContain("pauses sending");
  });

  test("an outbound axis that is not ready keeps the verify-until-ready hint (SES verification drives that axis)", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ status: 409, body: { error: { code: "domain_not_outbound_ready", message: "not ready", details: { outbound_status: "pending" } } } }) });
    await runCli(argv("domains", "enable-outbound", ID, "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.hint).toContain("until outbound reads ready, then retry");
  });

  test("a restriction Mailery imposed is reported as such, never as something the enable verbs lift", async () => {
    const h = makeHarness({
      env: API_KEY,
      route: () => ({ status: 409, body: { error: { code: "domain_restricted", message: "domain is restricted by Mailery and cannot be re-enabled by the tenant", details: { restriction_status: "active", restriction: { kind: "domain_suspended", reason: "abuse review", source: "admin" } } } } }),
    });
    await runCli(argv("domains", "enable-outbound", ID, "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.error!.code).toBe("domain_restricted");
    expect(env.error!.hint).toContain("Mailery restricted this domain (abuse review)");
    expect(env.error!.hint).toContain("mailery feedback");
    expect(h.exitCode()).toBe(1);
  });

  test("a domain never set up for inbound gets the setup --inbound hint", async () => {
    const h = makeHarness({
      env: API_KEY,
      route: () => ({ status: 409, body: { error: { code: "domain_inbound_not_requested", message: "domain was not set up for inbound mail" } } }),
    });
    await runCli(argv("domains", "enable-inbound", ID, "--json"), h.deps);
    const hint = parseJsonOut(h.out()).error!.hint!;
    expect(hint).toContain("--inbound --mx-migration-consent");
    // Re-running setup on a sending domain re-plans it (status and outbound
    // readiness back to pending), so the hint must say sending pauses until
    // verify + enable-outbound are run again — not silently prescribe it.
    expect(hint).toContain("pauses sending");
    expect(hint).toContain("mailery domains enable-outbound <id>");
  });

  test("disable posts the reason and explains how to re-enable", async () => {
    const disabled = domainRecord({ status: "restricted", enabled: { inbound: false, outbound: false } });
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === `/api/v1/domains/${ID}/disable` && c.method === "POST" ? { body: disabled } : undefined });
    await runCli(argv("domains", "disable", ID, "--reason", "rotating provider"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.calls[0]!.body).toEqual({ reason: "rotating provider" });
    expect(h.out()).toContain("Disabled agent-mail.com: inbound and outbound paused.");
    expect(h.out()).toContain("status:    restricted");
    expect(h.out()).toContain(`mailery domains enable-outbound ${ID}`);
  });

  test("disable without a reason sends no body", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: domainRecord({ status: "restricted" }) }) });
    await runCli(argv("domains", "disable", ID, "--json"), h.deps);
    expect(parseJsonOut(h.out()).ok).toBe(true);
    expect(h.calls[0]!.body).toBeUndefined();
  });
});

describe("domains renew (wallet-charged)", () => {
  const renewed = { domain: "agent-mail.com", tenant_domain_id: ID, status: "renewed", expires_at: "2027-09-10T00:00:00Z", auto_renew: true, billing: { quoted_price_cents: 1500, currency: "usd", wallet_debit_cents: 1500, wallet_balance_cents: 500 } };

  test("without --yes it refuses, suggests a stable key, and never POSTs", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: renewed }) });
    await runCli(argv("domains", "renew", ID, "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("renewal_confirmation_required");
    expect((env.error as { details: { suggested_idempotency_key: string } }).details.suggested_idempotency_key).toContain(`mailery-cli-domain-renew:${ID}:`);
    expect(env.error!.hint).toContain("mailery billing wallet");
    expect(h.exitCode()).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  test("with --yes but no idempotency key it still refuses and never POSTs", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: renewed }) });
    await runCli(argv("domains", "renew", ID, "--yes", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("idempotency_key_required");
    expect(h.calls).toHaveLength(0);
  });

  test("rejects an unrecognized --auto-renew value before charging", async () => {
    const h = makeHarness({ env: API_KEY, route: () => ({ body: renewed }) });
    await runCli(argv("domains", "renew", ID, "--yes", "--idempotency-key", "idem_renew_1", "--auto-renew", "maybe", "--json"), h.deps);
    expect(parseJsonOut(h.out()).error!.code).toBe("cli_usage_error");
    expect(h.calls).toHaveLength(0);
  });

  test("with full consent it POSTs once with the Idempotency-Key and reports the charge", async () => {
    const h = makeHarness({ env: API_KEY, route: (c) => c.path === `/api/v1/domains/${ID}/renew` && c.method === "POST" ? { body: renewed } : undefined });
    await runCli(argv("domains", "renew", ID, "--yes", "--idempotency-key", "idem_renew_1", "--auto-renew", "on"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.calls).toHaveLength(1);
    const post = h.calls[0]!;
    expect(post.headers["idempotency-key"] ?? post.headers["Idempotency-Key"]).toBe("idem_renew_1");
    expect(post.body).toEqual({ autoRenew: true });
    expect(h.out()).toContain("Renewed agent-mail.com until 2027-09-10T00:00:00Z.");
    expect(h.out()).toContain("charged: $15.00  wallet left: $5.00");
    expect(h.out()).toContain("auto-renew: on");
  });

  test("an insufficient wallet is reported with the server's shortfall hint, exit 1", async () => {
    const h = makeHarness({
      env: API_KEY,
      route: () => ({ status: 402, body: { error: { code: "wallet_insufficient_funds", message: "prepaid wallet cannot cover the renewal", details: { shortfall_cents: 900, hint: "Add funds: mailery billing add-funds 10 --yes --idempotency-key <key>" } } } }),
    });
    await runCli(argv("domains", "renew", ID, "--yes", "--idempotency-key", "idem_renew_1", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.error!.code).toBe("wallet_insufficient_funds");
    expect(env.error!.status).toBe(402);
    expect(env.error!.hint).toContain("mailery billing add-funds");
    expect(h.exitCode()).toBe(1);
  });
});
