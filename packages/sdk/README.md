# Mailery SDK internals

Zero-dependency TypeScript client for the [mailery.co](https://mailery.co)
`/api/v1` — **email identity for agents**. One import gives an agent (or the human
deploying it) a typed client for the full CLI surface: sign up, log in, mint
scoped API keys, subscribe, send and read real email, manage domains, and file
feedback.

- **Zero runtime dependencies.** Runs anywhere a WHATWG `fetch` exists — Bun,
  Node 18+, Deno, browsers, edge runtimes.
- **Injectable `fetch`.** Point it at the global `fetch`, a custom transport, or
  an in-process server's `app.fetch` for contract tests.
- **Contract-frozen.** Every route the SDK calls is asserted against the
  server's `docs/openapi.json` by a drift test, so the SDK, CLI, and server
  cannot silently diverge.

Internal workspace SDK used to build the public `@hasna/mailery/sdk`
subpath. The server package it talks to is private and not a public install
target.

## Install

```sh
npm install @hasna/mailery
```

This is a project dependency. Use a separate global installation only when the
`mailery` CLI/MCP executable is needed.

## Usage

```ts
import { MaileryClient } from "@hasna/mailery/sdk";

const mailery = new MaileryClient({ baseUrl: "https://mailery.co" });

// 1. Bootstrap: sign up (or log in) — the session token is cached on the client.
const terms = await mailery.getCurrentTerms();
// Show terms.url and terms.version to the customer. Leave acceptance unselected.
// Continue only after their explicit acceptance of this exact version.
await mailery.signup({ email: "agent@example.com", password: "<password>", acceptedTerms: true, termsVersion: terms.version });

// 2. Mint a scoped API key for daily use.
const { key } = await mailery.createKey({ name: "agent", scopes: ["mail_read", "mail_write"] });

// 3. Subscribe, then wait for the entitlement to land after the Stripe redirect.
const countryPolicy = await mailery.getCheckoutCountryPolicy();
// Show the restrictions and obtain the customer declaration before continuing.
const checkoutUrl = await mailery.createCheckout({
  plan: "pro", country: "US", countryBasis: "billing",
  countryPolicyVersion: countryPolicy.version, idempotencyKey: "<stable-purchase-key>",
}); // paid tier: "pro" or "scale"
await mailery.waitForEntitlement({ timeoutMs: 120_000 });

// 4. Run daily on the API key.
const agent = new MaileryClient({ baseUrl: "https://mailery.co", apiKey: key });
await agent.send({ mailboxId: "mb_…", to: ["hi@partner.dev"], subject: "hello", text: "from an agent" });
const inbox = await agent.listInbox({ group: "inbox", limit: 20 });
```

### Constructor options

| Option         | Type                                             | Notes                                                        |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `baseUrl`      | `string` (required)                              | API origin, e.g. `https://mailery.co`. Trailing `/` trimmed. |
| `apiKey`       | `string?`                                        | Tenant API key for the daily surface.                        |
| `sessionToken` | `string?`                                        | Owner session token for owner-only routes (keys, checkout).  |
| `fetch`        | `(input, init?) => Promise<Response>`            | Injectable fetch; defaults to the global `fetch`.            |
| `timeoutMs`    | `number?` (default `20000`)                      | Per-request timeout.                                         |
| `retries`      | `number?` (default `1`)                          | Retries on 408/429/5xx and network errors.                   |
| `sleep`        | `(ms) => Promise<void>`                          | Injectable sleep for deterministic retry/poll tests.         |

Auth routing is automatic: owner-only routes use `sessionToken`; the daily
surface uses `apiKey` (falling back to `sessionToken`). A missing credential
raises `MaileryAuthRequiredError` before any request is made.

## Surface

`health` · `getCurrentTerms` / `getTermsVersion` / `acceptTerms` · `signup` / `login` / `logout` / `me` · `createKey` / `listKeys` /
`revokeKey` / `revokeAllKeys` · `getCheckoutCountryPolicy` / `createCheckout` / `getBillingStatus` /
`getUsage` / `waitForEntitlement` · `send` / `listInbox` / `getMessage` ·
`searchDomains` / `listDomains` / `getDomainStatus` / `purchaseDomain` ·
`listWebhooks` / `createWebhook` / `getWebhook` / `updateWebhook` /
`deleteWebhook` / `rotateWebhookSecret` / `testWebhook` /
`listWebhookDeliveries` / `redeliverWebhook` (plus the receiver-side
`verifyWebhookSignature` / `parseWebhookEvent` helpers on WebCrypto) ·
`submitFeedback` / `listFeedback`.

### Containment-gated surface

- **`purchaseDomain()`** is live (`POST /api/v1/domains/purchase`, pivot phase
  **P5**). It spends real money and is gated by the P4 billing-containment layer:
  a tenant's FIRST purchase requires a settled payment on file and an account
  older than the configured cooling-off window, else it returns
  `403 settled_funds_required` (the error `details.hint` names the next action).
- **`revokeAllKeys()`** is live (`POST /api/v1/keys/revoke-all`, pivot D-3) — the
  password-authenticated break-glass path that revokes every API key.

## Errors

All failures throw a `MaileryError` (`status`, `code`, `retryable`, `details`).
Subclasses: `MaileryAuthRequiredError` (missing credential, no request made),
`MaileryTimeoutError` (`waitForEntitlement` deadline), and
`NotYetAvailableError` (route not shipped yet).

Checkout retries retain the original purchase intent. Supply and persist an explicit `idempotencyKey` in SDK `createCheckout({...})`, or `--idempotency-key` on CLI `subscribe`, for a deliberate purchase. Never change it on timeout or an uncertain outcome. New purchases require all country declaration fields. Omitting those fields can only replay an exact pre-country claim with its original key (including its historical no-header key); it cannot create a new claim. A deliberate identical repeat purchase needs an explicit fresh key. Use `mailery subscribe pro --resume` or `getBillingStatus()` to observe entitlement without opening Checkout.

## Paid purchase declarations and retries

Read `getCheckoutCountryPolicy()` and show its restrictions before asking the customer for their billing or residence country. Free signup and free use do not require a country declaration.

```ts
const policy = await mailery.getCheckoutCountryPolicy();
// Show policy to the customer and obtain their own declaration first.
const purchase = {
  kind: "subscription" as const,
  plan: "pro",
  country: "US",
  countryBasis: "billing" as const,
  countryPolicyVersion: policy.version,
  idempotencyKey: "<stable-purchase-key>",
};
const checkoutUrl = await mailery.createCheckout(purchase);
```

Retain the complete original input on every retry, including its policy version. Never replace the purchase key after a timeout. `topUpWallet()` takes the same country fields plus `amountCents` and a stable `idempotencyKey`. Omit all country fields only when replaying an exact pre-country purchase with its original key and amount. The server refuses a missing historical claim before creating a payable session. The checkout URL still requires the customer's payment action.

MCP clients first call `get_terms` and obtain explicit acceptance before `signup` or `accept_terms`. Before `add_wallet_funds`, call `get_checkout_country_policy`, show its restrictions, and retain the customer's declaration and original policy version.
