# mailery

**Email identity for agents.** One npm package — CLI, MCP server, and SDK — gives an agent
a managed, deliverable email identity: signup, subscribe, buy a domain, send, and
receive. Every command is a thin call to the mailery.co API; there is **no local
server, no self-host mode, ever**.

Two steps intentionally happen in a browser — everything else is terminal-only: a
one-time **email-verification** click (confirm it from the terminal with
`mailery verify`) and the **Stripe Checkout** page for `subscribe`.

**The Free plan is real and needs no subscription**: every verified account gets
1 agent identity on a shared subdomain and **3,000 emails/mo** — signup →
verify → `keys create` → `mailboxes create` → `send` all work in the first
minutes, no card. Paid plans add **custom domains**, more mailboxes, per-domain
DMARC reports & policy management, and higher limits. On the paid path, *your
own domain* is not a first-60-seconds
step: the first `domains buy` is gated by an anti-fraud cooling-off (a settled
payment on file **and** a ~7-day account age — see the heads-up below).

- CLI **and** MCP server in one binary (`mailery` and `mailery mcp`).
- Agent-first UX: non-interactive flags for everything, a `--json` envelope on
  every command, meaningful exit codes, and errors that tell you the next command.
- Public client package; every secret stays server-side.

## Install the CLI and MCP executable

```sh
npm i -g @hasna/mailery     # or: bun add -g @hasna/mailery
mailery --help
```

## Install the SDK in a project

Global installation only exposes the executable; it does not add an importable
project dependency. Install the same package locally before using the SDK
subpath:

```sh
npm install @hasna/mailery
```

```ts
import { MaileryClient } from "@hasna/mailery/sdk";
```

Requires Node 18+ (or Bun). The hosted API is the default
(`https://mailery.co`); tests can point at a different API origin with
`MAILERY_BASE_URL`.

## Quickstart — Free plan (signup → verify → key → shared mailbox → send)

No subscription, no card. The Free plan is 1 mailbox on the shared subdomain
(`shared_domain` in `GET /api/v1`, e.g. `agents.mailery.co`),
3,000 emails/mo, 0 custom domains.

```sh
# 1. create an account — session token is printed ONCE (store it securely)
mailery signup --email you@example.com --password 'StrongPass!42' --json
# Store the returned token:
export MAILERY_SESSION_TOKEN='sess_...'

# 2. verify your email — signup emails a one-time link; open it once in a browser
#    (it lands on a plain confirmation page). Confirm from the terminal any time with
#    `mailery verify` (add --resend to re-issue the link). In production,
#    verification is required before you can mint keys or subscribe.
#
#    AGENTS: skip the manual status check and use `--poll`. It waits (bounded)
#    for that single human click, then prints a fresh session token:
mailery verify --poll --json
# -> {"ok":true,"data":{"verified":true,"token":"sess_..."}}
# Store it: export MAILERY_SESSION_TOKEN='sess_...'
# Defaults: --timeout 600s (max 1800), --interval 15s (keep >= 15s: the server
# rate-limits polling at 5/min/IP).

# 3. mint an API key — no subscribe needed; printed ONCE (store it securely)
mailery keys create --scopes full --json
# Store the returned key:
export MAILERY_API_KEY='ml_...'

# 4. your free identity: one mailbox on the shared subdomain
mailery mailboxes create yourbot@agents.mailery.co --json

# 5. send (metered: 3,000/mo on the Free plan) and receive
mailery send --from yourbot@agents.mailery.co --to human@example.com --subject "hi" --text "sent by an agent"
mailery inbox --json
mailery inbox --watch          # stream new messages as they arrive
mailery read <message-id> --json
```

## Upgrade path — your own domain (subscribe → buy → send)

Custom domains, more mailboxes, per-domain DMARC reports & policy management,
and higher send limits are paid-tier features (`pro` / `scale`).

```sh
# 1. subscribe to a paid identity tier — plan is `pro` or `scale` ("starter" is
#    NOT a plan). Prints a Stripe Checkout URL, opens the browser when
#    interactive, then polls until the entitlement is active (--no-wait skips).
mailery subscribe pro

# 2. get a working, deliverable identity in ONE command:
#    purchase -> zone -> mail DNS -> verification -> ready-to-send
mailery billing add-funds 25 --yes --idempotency-key <stable-key>  # domains are paid from a prepaid wallet
mailery domains search agent-mail.com --json      # check availability
mailery domains buy agent-mail.com                # fetch and show the signed quote; no purchase
mailery domains buy agent-mail.com --yes --max-price-cents <quoted-cents> --currency <quoted-currency> --idempotency-key <suggested-key>

# 3. a mailbox on that domain, then send (--from an address, or --mailbox <id>)
mailery mailboxes create bot@agent-mail.com --json
mailery send --from bot@agent-mail.com --to human@example.com --subject "hi" --text "sent by an agent"
```

Already own the domain? Connect it instead of buying — nothing is charged,
and Mailery never touches your DNS unless you pass a consent flag:

```sh
mailery domains setup agent-mail.com --address bot --inbound --mx-migration-consent --json
#   -> the DNS records to publish (TXT/CNAME for sending, MX for inbound); publish them at your DNS host
mailery domains verify <id>                       # re-check until dns/outbound read "ready"
mailery domains enable-outbound <id>              # then enable-inbound <id> for receiving
mailery mailboxes create bot@agent-mail.com      # --address only PLANS the address; this creates it
```

`domains dns <id>` lists the records and which are verified; `domains disable <id>`
pauses a domain and the enable verbs lift that pause again (a restriction Mailery
imposed returns `domain_restricted` instead). Re-running `domains setup` on a
domain that already sends re-plans it and pauses sending until `verify` and
`enable-outbound` are run again. Every verb also takes `--json`.

> **Heads-up on the first domain purchase.** `domains buy` starts a paid purchase, so
> a tenant's FIRST purchase is gated by an anti-fraud cooling-off: it requires a
> settled (captured) payment on file **and** an account older than
> `MAILERY_DOMAIN_PURCHASE_MIN_ACCOUNT_AGE_DAYS` (default 7 days). Until both are
> true the command returns `settled_funds_required` with a hint telling you what
> to do (complete `subscribe`, then let the account age). This is not the "first
> 60 seconds" step — it is the deliverable-identity step you reach once the
> account is established. `domains buy` is otherwise entirely server-side and
> **resumable**: if it is interrupted, re-run the same command and it continues
> from where it left off.
>
> **Domains are paid from a prepaid wallet.** Add funds first
> (`mailery billing add-funds 25 --yes --idempotency-key <key>`, minimum $10);
> the exact quoted all-in price is debited before anything is registered. A
> wallet that cannot cover the quote returns `wallet_insufficient_funds` with
> the shortfall and registers nothing. Check it with `mailery billing wallet`.

## Authentication model

**Credentials are NEVER stored in config files.** All authentication happens through
environment variables for security.

1. `signup` / `login` (email + password) → a **session token**, printed ONCE.
   Store it securely: `export MAILERY_SESSION_TOKEN='sess_...'` or use a secret manager.
2. `keys create --scopes …` mints a scoped **API key**, printed ONCE.
   Store it securely: `export MAILERY_API_KEY='ml_...'` or use a secret manager.
3. `keys revoke --all` is the **break-glass** escape hatch: it revokes every API
   key and works with password auth alone —
   `mailery keys revoke --all --email you@example.com --password '…'` — even
   when no usable key or session is in the environment.

The CLI does not persist config, credentials, base URLs, email context, cache,
or mail data. It reads runtime state from environment variables only:
`MAILERY_API_KEY`, `MAILERY_SESSION_TOKEN`, `MAILERY_BASE_URL`. Client
construction and command startup do not inspect, create, modify, or delete
local config files; any historical files are left untouched.

## Commands

| Command | What it does |
|---|---|
| `signup --email --password [--name] [--invite-code]` | Create an account; returns session token (shown once) |
| `login --email --password` / `logout` | Session lifecycle (tokens in env, not stored) |
| `verify [--resend] [--poll]` | Check email-verification status from the terminal (email link is a one-time browser step). `--poll` waits for that click (default 10 min, max 30; `--email`, `--timeout`, `--interval`) and prints a fresh session token — the machine-bootstrap loop: `signup` → `verify --poll` → `keys create` → `export MAILERY_SESSION_TOKEN=…`/`export MAILERY_API_KEY=…` |
| `whoami` | Current identity, tenant, auth scopes |
| `account export [--output <path>\|-] [--page-size <n>]` | Write a JSON export of the whole account (profile, mailboxes, labels, domains, key metadata, subscriptions, credits, every message with bodies and attachment metadata) to a file, or to stdout with `-`; session token only, never billing-gated |
| `account delete --password <pw> --confirm-email <email>` | Permanently delete the account and everything in it (irreversible); refuses unless the typed email matches the session identity, and while a subscription is still active |
| `keys create --scopes <csv> [--name]` | Mint an API key (shown once; store securely) |
| `keys list` / `keys revoke <id>` / `keys revoke --all` | Manage keys (revoke `--all` = break-glass) |
| `subscribe <plan> [--no-wait]` | Stripe Checkout handoff, then poll entitlement |
| `billing status` / `usage` | Credit balance, inbound allowance/count/status/reset, prepaid wallet, plans, subscriptions, ledger |
| `billing wallet [--limit <n>]` | Prepaid wallet balance and recent wallet transactions (domains are charged to it) |
| `billing add-funds <dollars> --yes --idempotency-key <key>` | Stripe Checkout handoff that adds funds to the wallet (minimum $10; presets 10/25/50/100) |
| `domains search <q>` | Domain availability |
| `domains buy <domain> [--yes --max-price-cents <cents> --currency <code>] --idempotency-key <key>` | Show a binding quote and suggested stable key first; purchase only with price- and currency-bound consent |
| `domains list` / `domains status <domain>` | Inspect domains |
| `domains add <domain> [--mailbox-id <id> --catch-all]` | Register a domain you already own as a lifecycle record; publishes nothing, changes no DNS |
| `domains setup <domain> [--address <local-part> --inbound --mx-migration-consent --dns-delegation-consent]` | Connect a domain you own and get the DNS records to publish. The MX record and nameservers change only with the explicit consent flags; `--address` only plans the mailbox address (create it with `mailboxes create`); `--buy` purchases it first under the same quote/confirm consent as `domains buy` |
| `domains dns <id>` | The DNS records Mailery needs for the domain and whether each one is verified yet |
| `domains verify <id>` | Re-check DNS and the mail identity after publishing records; refreshes readiness and prints the next step |
| `domains enable-inbound <id>` / `domains enable-outbound <id>` | Turn on receiving (provisions Mailery's inbound routing; the MX must be published) or sending once that axis is ready |
| `domains disable <id> [--reason <text>]` | Pause inbound and outbound and withdraw inbound routing; the enable verbs lift the pause (a restriction Mailery imposed returns `domain_restricted`) |
| `domains renew <id> --yes --idempotency-key <key> [--auto-renew on\|off]` | Renew a Mailery-purchased domain, charged to the prepaid wallet |
| `domains auto-renew <id> on\|off` | Auto-renew opt-in; renews only when the wallet covers the quote, otherwise notifies. Charges nothing |
| `mailboxes create <addr> [--provider]` / `mailboxes list` | Manage mailboxes |
| `send (--from <addr> \| --mailbox <id>) --to <csv> [--subject --text --html …]` | Send hosted mail (`--from` resolves an address to your mailbox; body via flags or stdin) |
| `inbox [--watch]` / `read <id>` | Receive |
| `attachments download <messageId> [attachmentId] [--output <path>]` | List a message's attachments (omit the id) or download one (`--output -` streams raw bytes to stdout; default writes to the attachment's filename in the current directory) |
| `webhooks create <url> [--events <csv>] [--description]` | Register an HTTPS endpoint for signed events (secret shown once); webhooks-first, polling is the fallback |
| `webhooks list` / `get <id>` / `update <id> [--url --events --status]` / `delete <id>` | Manage endpoints (`--status active` re-enables a breaker-tripped one) |
| `suppressions list [--reason --email --limit --cursor]` | Addresses hosted send refuses (bounces and spam complaints) |
| `suppressions remove <id> [--confirm]` | Clear one suppression; `--confirm` is required for a spam complaint |
| `mailboxes delete <id> [--purge]` | Delete a mailbox; `--purge` also deletes the mail it holds |
| `webhooks rotate-secret <id>` / `test <id>` / `deliveries <id> [--status]` / `redeliver <id> <deliveryId>` | Rotate the signing secret, queue a test, inspect delivery history, re-queue an event |
| `feedback <message> [--kind --severity --url --tag]` | Product feedback |
| `mcp` | Run the stdio MCP server |

### Output & exit codes

Add `--json` to any command for a single machine-parseable envelope:

```json
{ "ok": true, "data": { /* result */ } }
{ "ok": false, "error": { "code": "billing_required", "message": "…", "status": 402, "hint": "…" } }
```

Exit codes: `0` success · `1` runtime/API error · `2` usage error.

## MCP server

```sh
mailery mcp        # JSON-RPC 2.0 over stdio (newline-delimited)
```

Register it with any MCP client:

```json
{ "mcpServers": { "mailery": { "command": "mailery", "args": ["mcp"],
  "env": { "MAILERY_API_KEY": "ml_…" } } } }
```

Tools: `send_email`, `list_inbox`, `read_message`, `update_message`,
`list_changes`, `list_mailboxes`, `search_domains`, `get_domain_status`, `buy_domain`,
`create_mailbox`, `generate_digest`, `list_digests`, `get_billing_status`,
`create_webhook`, `list_webhooks`, `test_webhook`, `list_suppressions`,
`submit_feedback`.

## License

Apache-2.0. Install and use the public package as `@hasna/mailery`.
