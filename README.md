# @hasna/mailery

Mailery is an email management CLI + MCP server - send, receive, sync, and manage email via Resend, AWS SES, and Gmail.

[![npm](https://img.shields.io/npm/v/@hasna/mailery)](https://www.npmjs.com/package/@hasna/mailery)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/mailery
```

## Quick Start

```bash
# Add a provider (SES, Resend, or Gmail)
mailery provider add --type ses --region us-east-1 --access-key ... --secret-key ...
mailery provider add-gmail   # requires: connectors auth gmail

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

# Sync Gmail inbox (full content — HTML + attachments)
mailery inbox sync --all

# Check sent email log
mailery email list

# Sync email data to remote PostgreSQL storage
mailery storage push
```

## Mailery UI (`mailery ui`)

A full-screen OpenTUI mail client with a responsive dashboard shell. Wide
terminals use a two-column admin layout with persistent navigation, mailbox
metrics, operations health, folders, actions, and a focused workspace. Inbox on
wide terminals uses a split message list + preview reader. Narrow terminals collapse to
a compact single-column view with the same Inbox, Compose, Domains, and
Settings dialog. Inbox starts at all addresses and can be filtered to one email
address when needed; configured inboxes show their provider/account context in
the inbox picker. Live read-state, local refresh, background auto-pull, and
an `auto`/`light`/`dark` color theme keep the mailbox current and readable
across terminals.

```bash
mailery ui
mailery ui --mailbox unread
```

The app uses visible buttons and the Shortcuts command palette for actions.
Inbox filtering is handled by the Inboxes dialog, which lists all inboxes and
configured/observed recipient addresses. Sidebar labels filter mailbox content,
and Gmail-style Categories show Primary, Social, Promotions, Updates, and
Forums separately from custom labels. Reader shows attachments with size/type.
Composer writes **markdown** rendered to HTML on send. Settings opens as a
simple menu dialog for sync, defaults, and display controls. Folders:
Inbox · Unread · Starred · Sent · Archived · Spam · Trash.

## Command Structure

```
mailery ui                # Mailbox UI - inbox, compose, domains, settings
mailery provider          # add/list/remove/sync providers (ses, resend, gmail)
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
mailery inbox             # inbound: sync, list, read/star/archive/label, watch (real-time)
mailery template          # email templates
mailery contact           # contacts (suppression list)
mailery group             # recipient groups
mailery sequence          # drip sequences
mailery schedule          # scheduled emails: list, cancel, run
mailery triage            # AI triage: classify, prioritize, draft replies
mailery storage           # sync to/from remote PostgreSQL storage: push, pull, migrate
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
mailery inbox show <id>           # detail path for one inbound email
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
send keys, inbound read-state, real-time sync, agent context, source-aware inbox
status, ownership lookup/assignment/transfer audit, and verification-code
waiting.

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

# Read-state / organize (works for SES-S3, SMTP, and Gmail mail)
mailery inbox list --unread            # filters: --unread/--read/--starred/--archived/--label <l>
mailery inbox latest ops@example.com --json
mailery inbox wait ops@example.com --timeout 120
mailery inbox wait-code ops@example.com --from openai --timeout 120
mailery inbox sync-status --json       # S3, realtime, and Gmail status
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

Canonical production storage is the `emails` database on
`hasna-xyz-infra-apps-prod-postgres`. The runtime secret lives at
`hasna/xyz/opensource/emails/prod/rds`; load it into the canonical env var
without printing or committing the connection string.

```bash
# Configure RDS/PostgreSQL
export HASNA_EMAILS_DATABASE_URL="postgres://..."

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
