# @hasna/mailery

Mailery is an email management CLI + MCP server - send, receive, sync, and manage email via Resend, AWS SES, and Cloudflare-routed inbound mail.

[![npm](https://img.shields.io/npm/v/@hasna/mailery)](https://www.npmjs.com/package/@hasna/mailery)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

Mailery is built for the Bun runtime. Install Bun 1.3 or newer before installing
the CLI with npm.

```bash
npm install -g @hasna/mailery
```

## Open Core And Cloud

Users install the open-source package: `@hasna/mailery`.

Mailery stays local-first by default: local SQLite, local provider credentials,
local MCP, and optional self-hosted PostgreSQL sync. Mailery Cloud is an opt-in
hosted source of truth at `https://mailery.co`; the same public CLI can sign up,
create an agent API key, create a billing link, create hosted mailboxes, read
hosted messages, generate hosted digests, and pull cloud mail into local SQLite.

The SaaS control plane is private Hasna Tools infrastructure. End users and
open-source contributors should not install or depend on private Hasna Tools
platform packages.

`@hasna/emails` is compatibility-only during the rename period. New installs and
docs should use `@hasna/mailery`; the compatibility name is expected to be
retired after migration.

## Quick Start

```bash
# Add a provider (SES or Resend)
mailery provider add --name production-ses --type ses --region us-east-1 --access-key ... --secret-key ...
mailery provider add --name production-resend --type resend --api-key ...

# Set up a domain (buy + DNS + SES in one command)
mailery domain setup example.com --provider <id> --email you@example.com ...

# Or configure DNS for an existing domain via Cloudflare
mailery domain setup-cloudflare example.com --provider <id>

# Check public DNS before changing inbound routing
mailery domain check example.com

# SES send-only setup preserves existing MX, such as Google Workspace
mailery provision domain example.com --provider <ses-id> --dry-run

# Send an email
mailery send --from you@example.com --to them@example.com --subject "Hi" --body "Hello"

# Pull inbound mail from SES/S3 or Cloudflare-routed storage
mailery inbox source add-s3 --bucket <bucket> --prefix inbound/example.com/ --provider <provider-id>
mailery inbox sync-s3 --bucket <bucket> --prefix inbound/example.com/

# Inspect mailbox folders and ingestion sources
mailery inbox mailboxes
mailery inbox sources
mailery inbox list --folder unread --source provider:<id>

# Check sent email log
mailery email list

# Sync email data to self-hosted PostgreSQL storage
mailery storage push
```

## Mailery Cloud

Cloud commands are non-interactive enough for agents and CI. Use `--no-open`
when creating billing links from a headless environment.

```bash
# Show the hosted service status
mailery cloud --api-url https://mailery.co status

# Create or log into a hosted account, generate an agent API key, and create a
# hosted billing link without opening a browser
mailery cloud setup \
  --api-url https://mailery.co \
  --email you@example.com \
  --password "$MAILERY_PASSWORD" \
  --api-key-name "Agent CLI" \
  --scope mail_read mail_write billing_read \
  --billing \
  --no-open

# Hosted mailbox and message workflow
mailery cloud mailbox add agent@example.com --provider manual
mailery cloud messages list --limit 20
mailery cloud messages pull --limit 20
mailery inbox list --limit 20

# Billing and domains
mailery cloud billing overview
mailery cloud billing subscribe --plan starter --no-open
mailery cloud domain available example-agent-mail.com
mailery cloud domain setup example-agent-mail.com --address agent --catch-all
```

The starter SaaS plan is currently `$10/month` and grants hosted credits. Domain
setup can return DNS records in safe planning mode before any domain purchase or
MX migration is performed.

## Mailery UI (`mailery ui`)

A full-screen OpenTUI mail client with a responsive dashboard shell. Wide
terminals use a two-column admin layout with persistent navigation, mailbox
metrics, operations health, folders, actions, and a focused workspace. Inbox on
wide terminals uses a split message list + preview reader. Narrow terminals collapse to
a compact single-column view with the same Inbox, Compose, Domains, and
Settings dialog. Inbox starts at all addresses and can be filtered to one email
address when needed. Mailbox source status is exposed through CLI/API/MCP
surfaces without treating provider credentials as inboxes. Live read-state,
local refresh, background auto-pull, and an `auto`/`light`/`dark` color theme
keep the mailbox current and readable across terminals.

```bash
mailery ui
mailery ui --mailbox unread
```

The app uses visible buttons and the Shortcuts command palette for actions.
Mailbox filtering is handled by the mailbox dialog, which lists all mailboxes
and configured/observed recipient addresses. Sidebar labels filter mailbox
content, and Gmail-style Categories show Primary, Social, Promotions, Updates,
and Forums separately from custom labels. Reader shows
attachments with size/type. Composer writes **markdown** rendered to HTML on
send. Settings opens as a simple menu dialog for sync, defaults, and display
controls. Folders: Inbox · Unread · Starred · Sent · Archived · Spam · Trash.

## Command Structure

```
mailery ui                # Mailbox UI - inbox, compose, domains, settings
mailery provider          # provider credentials/capabilities (ses, resend, sandbox)
mailery domain            # add/verify/buy/setup/dns/check domains
mailery address           # manage sender addresses (add, suspend, activate, quota)
mailery status            # redacted system status + next useful actions
mailery agent context     # agent-oriented context snapshot and workflows
mailery daemon            # background queue/realtime status and restart guidance
mailery logs tail         # local daemon/sync/inbound/scheduler log tails
mailery owner             # tenancy: register human/agent owners
mailery alias             # per-domain aliases + catch-all routing
mailery forwarding        # app-level forwarding for locally received/synced mail
mailery sendkey           # scoped send keys (restrict an agent to its own addresses)
mailery send              # send an email
mailery reply / forward   # reply (in-thread) or forward a sent/inbound email
mailery email             # sent email: list, search, show, replies, conversation
mailery inbox             # mailbox folders, sources, sync, read/star/archive/label, watch
mailery template          # email templates
mailery contact           # contacts (suppression list)
mailery group             # recipient groups
mailery sequence          # drip sequences
mailery schedule          # scheduled emails: list, cancel, run
mailery triage            # AI triage: classify, prioritize, draft replies
mailery storage           # sync to/from self-hosted PostgreSQL storage: push, pull, migrate
mailery cloud             # optional Mailery Cloud signup/login/billing/mailbox/message/digest/domain workflow
mailery aws               # AWS setup: SES receipt rules, S3 inbound bucket
mailery config            # configuration (key=value)
mailery stats             # delivery statistics (--inbox for received mail)
mailery analytics         # email analytics
mailery doctor            # system diagnostics
mailery doctor delivery   # diagnose missing inbound mail for one address
mailery serve             # HTTP server + dashboard + authenticated /api/v1
mailery mcp               # install MCP server
```

### Compact Output and Gradual Disclosure

Mailery CLI commands are compact by default so agent terminals do not fill with
large records. List and status commands show essential fields, bounded row
counts, and hints for the next detail command. Use these flags when you need
more:

```bash
mailery address list              # compact table
mailery address list --verbose    # expanded owner/admin/quota rows
mailery domain status --verbose   # includes per-domain issue and fix lines
mailery provider list --limit 50  # explicit larger page
mailery contact list --suppressed # compact filtered contact list
mailery template show <name>      # detail path for template bodies
mailery sequence show <name>      # detail path for steps/enrollments
mailery forwarding list --source ops@example.com
mailery agent context             # compact agent context summary
mailery agent context --verbose   # full redacted context snapshot
mailery agent context --json      # full machine-readable context
mailery config list --verbose     # full redacted config values
mailery config keys --verbose     # include examples for every key
mailery email show <id>           # detail path for one sent email
mailery inbox read <id>           # detail path for one inbound email
```

`--json` remains the machine-readable path. Broad MCP list tools default to
their existing bounded summary page size for compatibility; use each tool's
`limit`/`offset` inputs or the matching detail tool/resource for larger or full
records. `emails://agent/context` is sampled for orientation; use
`emails://agent/context/full` for the full redacted MCP resource.

## Tenancy, aliases & scoped send keys

Every address can have an **owner** that is a human or an agent. A human-owned
address must be administered by an agent (the agent operates it on the human's
behalf); agent-owned addresses are self-administered.

```bash
# Register owners and assign an address (human-owned, agent-administered)
mailery owner register Morgan --type human --email morgan@example.com
mailery owner register Atlas  --type agent
mailery provision address morgan@example.com --provider <ses-id> --owner Morgan --administrator Atlas
mailery address owner morgan@example.com
mailery address set-owner morgan@example.com --owner Morgan --administrator Atlas
mailery address transfer-owner morgan@example.com --owner Atlas --reason "handoff" --yes
mailery address unassign-owner morgan@example.com --reason "retired" --yes
mailery address owner-history morgan@example.com

# Scoped send keys — an agent can only send from addresses it owns/administers
mailery sendkey create Atlas --label ci        # prints the esk_... token ONCE
mailery sendkey check  Atlas morgan@example.com # authorized
mailery sendkey list / revoke <id>

# Per-domain aliases + catch-all
mailery alias add support@example.com ops@example.com
mailery alias catch-all example.com inbox@example.com   # *@example.com -> inbox@
mailery alias global inbox@example.com                  # protected global catch-all (ALL domains)
mailery alias resolve anything@example.com              # show where it routes

# App-level forwarding: forwards only mail already received or synced locally.
# Use provider-native forwarding when the mailbox provider owns root MX.
mailery forwarding explain support@example.com
mailery forwarding add support@example.com archive@example.net --provider <provider-id>
mailery forwarding run --provider <provider-id>            # future mail only
mailery forwarding run --provider <provider-id> --backfill # intentionally include older synced mail

# Address lifecycle
mailery address provision ops@example.com --provider <ses-id> --owner Atlas
mailery address suggest --domain example.com
mailery address suspend <id>     # block sending from this address
mailery address activate <id>
mailery address quota <id> 200   # max 200 sends/day (use 'none' to clear)
```

## DNS and inbound safety

`mailery domain check <domain>` detects common root MX owners, including Google
Workspace, Microsoft 365, Cloudflare Email Routing, Zoho, Proton, and AWS SES.
SES send-only provisioning does not require changing root MX and is the safest
path when an existing mailbox provider already receives mail.

Publishing SES inbound MX is only for domains that should receive through
SES/S3. Commands that can add SES inbound MX refuse to proceed when public MX
already belongs to another provider. `--force-mx-switch` is available for
intentional migrations after confirming mailbox ownership can move.

## MCP Server

100+ tools for AI agents — send/read mail, provisioning, tenancy, aliases, scoped
send keys, inbound read-state, real-time sync, agent context, source-aware
mailbox status, ownership lookup/assignment/transfer audit, and
verification-code waiting.

Terminology used by the CLI, REST API, MCP tools, and TUI:

- **Provider**: credentials and capability, such as SES send rights, Resend API access, or a sandbox.
- **Source**: an ingestion stream that brings mail into local storage, such as `provider:<id>`, `s3:<bucket>`, Cloudflare-routed inbound storage, `legacy`, or `orphaned:<id>`.
- **Mailbox**: the user-visible scope being browsed, such as all mail, one address, or one domain.
- **Folder**: a mailbox view such as `inbox`, `unread`, `sent`, `starred`, `archived`, `spam`, or `trash`.

Useful source-aware surfaces:

```bash
mailery inbox sources --json
mailery inbox mailboxes --source provider:<id> --json
mailery inbox search invoice --folder sent --source provider:<id> --json
curl 'localhost:3900/api/sources'
curl 'localhost:3900/api/mailboxes?source_id=legacy'
```

```bash
mailery-mcp
```

## REST API

`mailery serve` exposes a dashboard plus two API surfaces:

- **Dashboard / management API** under `/api/*` (providers, domains, addresses, emails, stats).
- **Authenticated programmatic API** under `/api/v1/*` for agents/apps, keyed on a
  scoped send key (`Authorization: Bearer esk_…`). Every call is scoped to the
  key owner's addresses, so one caller can't act as another tenant:

```bash
mailery serve   # or: mailery-serve   (HOST=0.0.0.0 to allow other machines)

curl -H "Authorization: Bearer $ESK" localhost:3900/api/v1/addresses
curl -H "Authorization: Bearer $ESK" -X POST localhost:3900/api/v1/provision/address -d '{"email":"ops@example.com"}'
curl -H "Authorization: Bearer $ESK" -X POST localhost:3900/api/v1/send -d '{"from":"ops@example.com","to":"x@y.com","subject":"hi","text":"yo"}'
curl -H "Authorization: Bearer $ESK" 'localhost:3900/api/v1/inbox?limit=50&offset=0&search=invoice'  # scoped, paginated inbox
```

## Library API

Import the stable local API from `@hasna/mailery`. The public entrypoint covers
provider/domain/address CRUD, sending, inbound storage and listing, templates,
contacts and suppression, sequences, exports, ownership helpers, and scoped send
keys.

```ts
import {
  sendWithFailover,
  createProvider,
  createAddress,
  storeInboundEmail,
  createTemplate,
  suppressContact,
  createSequence,
  exportEmailsJson,
  createOwner,
  setAddressOwnerByRef,
  createSendKey,
} from "@hasna/mailery";
```

## Inbound Email (AWS SES -> S3)

```bash
# Set up S3 bucket + SES receipt rules
mailery aws setup-inbound --domain example.com --bucket my-emails

# Pull received emails on demand
mailery inbox sync-s3 --bucket my-emails --prefix inbound/example.com/

# Read-state / organize (works for SES-S3, SMTP, Cloudflare-routed, and legacy imported mail)
mailery inbox list --unread            # filters: --unread/--read/--starred/--archived/--label <l>
mailery inbox latest ops@example.com --json
mailery inbox wait ops@example.com --timeout 120
mailery inbox wait-code ops@example.com --from openai --timeout 120
mailery inbox sync-status --json       # S3 and realtime status
mailery inbox explain <id>             # route/owner/readiness trace
mailery inbox read <id>                # opening marks it read
mailery inbox star|archive|label <id>  # --undo / --remove to reverse
```

### Real-time inbound (no manual sync)

Push delivery so mail lands automatically. `setup-realtime` wires SES → SNS → SQS
(and attaches the topic to the receipt rule); `watch` long-polls and auto-syncs:

```bash
mailery inbox setup-realtime example.com   # creates SNS topic + SQS queue, saves the queue URL
mailery inbox watch                        # auto-delivers new mail in real-time (--once to poll once)
```

Alternatively, point an SNS HTTP subscription at `POST /webhook/ses-inbound` on
`mailery serve` auto-confirms the subscription and syncs on each notification.

## Storage Sync (PostgreSQL)

Mailery is local-first. The public OSS default is local SQLite and files under
`~/.hasna/emails/`, with no remote dependency. Self-hosted storage is opt-in,
and uses the `emails` slug for database URL compatibility: use
`HASNA_EMAILS_DATABASE_URL`, not `HASNA_MAILERY_DATABASE_URL`.

For managed or self-hosted PostgreSQL, set `HASNA_EMAILS_DATABASE_URL` to the
database connection string without printing or committing it. Self-hosted
installs can use the fallback `EMAILS_DATABASE_URL`.

Mailery modes:

- `local` - all reads/writes stay in local SQLite/files.
- `self_hosted` - user/org-owned infrastructure. Local remains the fast/offline
  store, while explicit
  `mailery storage push`, `mailery storage pull`, or `mailery storage sync --force`
  mirrors state to self-hosted PostgreSQL. For Hasna, this means AWS RDS plus
  SES/S3, not Mailery SaaS.
- `cloud` - Hasna-operated Mailery Cloud SaaS at `https://mailery.co`.

Deprecated `remote` and `hybrid` values are accepted as aliases only for the
deployment mode (`MAILERY_MODE`, `HASNA_EMAILS_MODE`, or legacy config keys) and
map to `self_hosted`. The lower-level storage sync mode remains separate:
`HASNA_EMAILS_STORAGE_MODE=hybrid` means local runtime plus explicit PostgreSQL
sync, while `HASNA_EMAILS_STORAGE_MODE=remote` is still reserved until a true
remote source-of-truth runtime exists.

```bash
# Configure RDS/PostgreSQL
export HASNA_EMAILS_DATABASE_URL="postgres://..."
# Optional self-hosted fallback:
# export EMAILS_DATABASE_URL="postgres://..."

# Optional explicit mode; default is local without a DB URL, self_hosted with one.
export MAILERY_MODE=self_hosted

# Check config and sync history
mailery storage status

# Push local SQLite → RDS
mailery storage push

# Pull RDS → local
mailery storage pull
```

Storage internals are intentionally kept off the default library entrypoint. Import
them from the explicit subpath when building storage tooling:

```ts
import { getStorageStatus, storagePush, storagePull } from "@hasna/mailery/storage";
```

## Data

Stored in `~/.hasna/emails/` (SQLite + attachments).

## HTTP mode

Shared Streamable HTTP transport for multi-agent sessions (stdio remains the default):

```bash
mailery-mcp --http              # http://127.0.0.1:8861/mcp
MCP_HTTP=1 mailery-mcp          # same
mailery-mcp --http --port 8861  # explicit port
```

- Health: `GET http://127.0.0.1:8861/health` -> `{"status":"ok","name":"mailery"}`
- Override port with `MCP_HTTP_PORT` or `--port`

## License

Apache-2.0 — see [LICENSE](LICENSE)
