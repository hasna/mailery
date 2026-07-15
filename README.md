# @hasna/emails

Open-source email infrastructure for local SQLite workflows and operator-owned self-hosted deployments, with a CLI, MCP server, library, dashboard, Resend, AWS SES, and Cloudflare-routed inbound mail.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

Emails is built for the Bun runtime. Install Bun 1.3 or newer, then install the
CLI with Bun.

```bash
bun install -g @hasna/emails
```

## Deployment modes

Emails has exactly two modes: `local` and `self_hosted`. Local mode keeps SQLite, files, and credentials on the current machine. Self-hosted mode connects to an Emails service deployed in user-owned infrastructure. Provider integrations always use user-supplied credentials; the package has no hosted account or control-plane service.

## Quick Start

```bash
# Add a provider (SES or Resend). Prefer an AWS profile locally or the
# deployment IAM role in self-hosted AWS; avoid storing long-lived AWS keys.
AWS_PROFILE=emails-operator emails provider add --name production-ses --type ses --region us-east-1
emails provider add --name production-resend --type resend --api-key ...

# Set up a domain (buy + DNS + SES in one command)
emails domain setup example.com --provider <id> --email you@example.com ...

# Or connect a domain you already own without buying it
emails domains connect example.com --provider <id> --source-of-truth local --dry-run
emails domains connect example.com --provider <id> --source-of-truth postgres --dns-provider route53 --no-register-provider

# Or configure DNS for an existing domain via Cloudflare
emails domain setup-cloudflare example.com --provider <id>

# Check public DNS before changing inbound routing
emails domain check example.com

# SES send-only setup preserves existing MX, such as Google Workspace
emails provision domain example.com --provider <ses-id> --dry-run

# Send an email
emails send --from you@example.com --to them@example.com --subject "Hi" --body "Hello"

# Pull inbound mail from SES/S3 or Cloudflare-routed storage
emails inbox source add-s3 --bucket <bucket> --prefix inbound/example.com/ --provider <provider-id>
emails inbox sync-s3 --bucket <bucket> --prefix inbound/example.com/

# Inspect mailbox folders and ingestion sources
emails inbox mailboxes
emails inbox sources
emails inbox list --folder unread --source provider:<id>

# Check sent email log
emails email list

# Operate a self-hosted PostgreSQL service
EMAILS_MODE=self_hosted EMAILS_DATABASE_URL=postgres://... EMAILS_API_SIGNING_KEY=... emails db migrate
EMAILS_MODE=self_hosted EMAILS_DATABASE_URL=postgres://... EMAILS_API_SIGNING_KEY=... emails self-hosted key create
```

## Domain Modes

Emails is a multi-domain aggregator. Every domain is tracked independently, so
DNS, inbound, outbound, and safety state belong to the domain, not to the app as
a whole.

Use these setup paths:

| Mode | Who owns the mail source of truth | Domain setup path |
| --- | --- | --- |
| `local` | The local SQLite/files install | `emails domains add` or `emails domains connect --source-of-truth local`; DNS checks are advisory unless using a real send/receive provider. |
| `self_hosted` | Your PostgreSQL/S3/SES or equivalent infrastructure | `emails domains connect --source-of-truth postgres`, then publish the returned DNS tasks and enable inbound/outbound when evidence is ready. |

Authentication records are required only for the capability you enable:

- Inbound aggregation needs an inbound route, usually MX plus SES/S3 or another
  configured source.
- Outbound sending needs ownership verification plus DKIM and SPF/custom MAIL
  FROM alignment for the selected provider.
- DMARC is per sending domain. It does not block local viewing or inbound
  aggregation, but it should be present before production sending and monitored
  before moving from `p=none` to stricter policies.

Self-hosted clients must set `EMAILS_MODE=self_hosted`,
`EMAILS_SELF_HOSTED_URL`, and `EMAILS_SELF_HOSTED_API_KEY`. The service uses
`EMAILS_DATABASE_URL` and `EMAILS_API_SIGNING_KEY`; Postgres is authoritative
and there is no hybrid SQLite synchronization mode.

After applying migrations, issue client keys on the operator host with
`emails self-hosted key create`. The plaintext token is displayed once and only
its SHA-256 hash plus lifecycle metadata is stored in Postgres. Inspect metadata
with `emails self-hosted key list` and immediately disable a key with
`emails self-hosted key revoke <kid> --reason "rotation"`. The service denies
validly signed but unrecorded keys.

`emails self-hosted key rotate` issues an Emails key while retaining the active
Mailery-era key for rollback. Verify clients on the new key, then explicitly
revoke the old key after the rollback window closes.

## Emails UI (`emails ui`)

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
emails ui
emails ui --mailbox unread
```

The app uses visible buttons and the Shortcuts command palette for actions.
Mailbox filtering is handled by the mailbox dialog, which lists all mailboxes
and configured/observed recipient addresses. Sidebar labels filter mailbox
content, and mail categories show Primary, Social, Promotions, Updates,
and Forums separately from custom labels. Reader shows
attachments with size/type. Composer writes **markdown** rendered to HTML on
send. Settings opens as a simple menu dialog for sync, defaults, and display
controls. Folders: Inbox · Unread · Starred · Sent · Archived · Spam · Trash.

## Command Structure

```
emails ui                # Mailbox UI - inbox, compose, domains, settings
emails provider          # provider credentials/capabilities (ses, resend, sandbox)
emails domain            # add/verify/buy/setup/dns/check domains
emails address           # manage sender addresses (add, suspend, activate, quota)
emails status            # redacted system status + next useful actions
emails agent context     # agent-oriented context snapshot and workflows
emails daemon            # background queue/realtime status and restart guidance
emails logs tail         # local daemon/sync/inbound/scheduler log tails
emails owner             # ownership: register human/agent owners
emails alias             # per-domain aliases + catch-all routing
emails forwarding        # app-level forwarding for locally received/synced mail
emails sendkey           # scoped send keys (restrict an agent to its own addresses)
emails send              # send an email
emails reply / forward   # reply (in-thread) or forward a sent/inbound email
emails email             # sent email: list, search, show, replies, conversation
emails inbox             # mailbox folders, sources, sync, read/star/archive/label, watch
emails template          # email templates
emails contact           # contacts (suppression list)
emails group             # recipient groups
emails sequence          # drip sequences
emails schedule          # scheduled emails: list, cancel, run
emails db                # self-hosted PostgreSQL migration and status commands
emails aws               # AWS setup: SES receipt rules, S3 inbound bucket
emails config            # configuration (key=value)
emails stats             # delivery statistics (--inbox for received mail)
emails analytics         # email analytics
emails doctor            # system diagnostics
emails doctor delivery   # diagnose missing inbound mail for one address
emails serve             # local HTTP server + dashboard + /api management routes
emails mcp               # install MCP server
```

### Compact Output and Gradual Disclosure

Emails CLI commands are compact by default so agent terminals do not fill with
large records. List and status commands show essential fields, bounded row
counts, and hints for the next detail command. Use these flags when you need
more:

```bash
emails address list              # compact table
emails address list --verbose    # expanded owner/admin/quota rows
emails domain status --verbose   # includes per-domain issue and fix lines
emails provider list --limit 50  # explicit larger page
emails contact list --suppressed # compact filtered contact list
emails template show <name>      # detail path for template bodies
emails sequence show <name>      # detail path for steps/enrollments
emails forwarding list --source ops@example.com
emails agent context             # compact agent context summary
emails agent context --verbose   # full redacted context snapshot
emails agent context --json      # full machine-readable context
emails config list --verbose     # full redacted config values
emails config keys --verbose     # include examples for every key
emails email show <id>           # detail path for one sent email
emails inbox read <id>           # detail path for one inbound email
emails inbox attachment <exact-id> --download --index 0 --output-dir ./attachments
```

Attachment byte downloads use descriptor-relative, no-overwrite writes so an
output-directory symlink swap cannot redirect bytes. That secure filesystem
primitive currently requires Linux (`/proc/self/fd`); macOS and other platforms
fail closed before writing a file. Metadata-only attachment reads remain
cross-platform.

`--json` remains the machine-readable path. Broad MCP list tools default to
their existing bounded summary page size for compatibility; use each tool's
`limit`/`offset` inputs or the matching detail tool/resource for larger or full
records. `emails://agent/context` is sampled for orientation; use
`emails://agent/context/full` for the full redacted MCP resource.

## Principals, aliases and scoped send keys

Every address can have an **owner** that is a human or an agent. A human-owned
address must be administered by an agent (the agent operates it on the human's
behalf); agent-owned addresses are self-administered.

```bash
# Register owners and assign an address (human-owned, agent-administered)
emails owner register Morgan --type human --email morgan@example.com
emails owner register Atlas  --type agent
emails provision address morgan@example.com --provider <ses-id> --owner Morgan --administrator Atlas
emails address owner morgan@example.com
emails address set-owner morgan@example.com --owner Morgan --administrator Atlas
emails address transfer-owner morgan@example.com --owner Atlas --reason "handoff" --yes
emails address unassign-owner morgan@example.com --reason "retired" --yes
emails address owner-history morgan@example.com

# Scoped send keys — an agent can only send from addresses it owns/administers
emails sendkey create Atlas --label ci        # prints the esk_... token ONCE
emails sendkey check  Atlas morgan@example.com # authorized
emails sendkey list / revoke <id>

# Per-domain aliases + catch-all
emails alias add support@example.com ops@example.com
emails alias catch-all example.com inbox@example.com   # *@example.com -> inbox@
emails alias global inbox@example.com                  # protected global catch-all (ALL domains)
emails alias resolve anything@example.com              # show where it routes

# App-level forwarding: forwards only mail already received or synced locally.
# Use provider-native forwarding when the mailbox provider owns root MX.
emails forwarding explain support@example.com
emails forwarding add support@example.com archive@example.net --provider <provider-id>
emails forwarding run --provider <provider-id>            # future mail only
emails forwarding run --provider <provider-id> --backfill # intentionally include older synced mail

# Address lifecycle
emails address provision ops@example.com --provider <ses-id> --owner Atlas
emails address suggest --domain example.com
emails address suspend <id>     # block sending from this address
emails address activate <id>
emails address quota <id> 200   # max 200 sends/day (use 'none' to clear)
```

## DNS and inbound safety

`emails domain check <domain>` detects common root MX owners, including Google
Workspace, Microsoft 365, Cloudflare Email Routing, Zoho, Proton, and AWS SES.
SES send-only provisioning does not require changing root MX and is the safest
path when an existing mailbox provider already receives mail.

Publishing SES inbound MX is only for domains that should receive through
SES/S3. Commands that can add SES inbound MX refuse to proceed when public MX
already belongs to another provider. `--force-mx-switch` is available for
intentional migrations after confirming mailbox ownership can move.

## MCP Server

100+ tools for AI agents — send/read mail, provisioning, ownership, aliases, scoped
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
emails inbox sources --json
emails inbox mailboxes --source provider:<id> --json
emails inbox search invoice --folder sent --source provider:<id> --json
curl 'localhost:3900/api/sources'
curl 'localhost:3900/api/mailboxes?source_id=legacy'
```

```bash
emails-mcp
```

## REST API

`emails serve` exposes the local dashboard and management API:

- **Dashboard / management API** under `/api/*` for providers, domains,
  addresses, messages, stats, sources, and mailbox views.
- Scoped send keys remain part of the local send authorization model; there is
  no separate hosted-agent API surface in this OSS server.

```bash
emails serve   # local dashboard on 127.0.0.1
EMAILS_ALLOW_REMOTE=1 emails serve --host 0.0.0.0  # only behind an authenticating proxy/firewall

curl localhost:3900/api/providers
curl localhost:3900/api/sources
curl 'localhost:3900/api/mailboxes?source_id=legacy'
```

## Library API

Import the stable API from `@hasna/emails`. The public entrypoint covers
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
  getDatabase,
  closeDatabase,
  runInTransaction,
  resolvePartialId,
} from "@hasna/emails";

const db = getDatabase();
runInTransaction(db, () => {
  // CRUD helpers accept an optional Database for isolated local workflows.
});
closeDatabase();
```

## Inbound Email (AWS SES -> S3)

```bash
# Set up S3 bucket + SES receipt rules
emails aws setup-inbound --domain example.com --bucket my-emails

# Pull received emails on demand
emails inbox sync-s3 --bucket my-emails --prefix inbound/example.com/

# Read-state / organize (works for SES-S3, SMTP, Cloudflare-routed, and legacy imported mail)
emails inbox list --unread            # filters: --unread/--read/--starred/--archived/--label <l>
emails inbox latest ops@example.com --json
emails inbox wait ops@example.com --timeout 120
emails inbox wait-code ops@example.com --from openai --timeout 120
emails inbox sync-status --json       # S3 and realtime status
emails inbox explain <id>             # route/owner/readiness trace
emails inbox read <id>                # opening marks it read
emails inbox star|archive|label <id>  # --undo / --remove to reverse
```

### Real-time inbound (no manual sync)

Push delivery so mail lands automatically. `setup-realtime` wires SES → SNS → SQS
(and attaches the topic to the receipt rule); `watch` long-polls and auto-syncs:

```bash
emails inbox setup-realtime example.com   # creates SNS topic + SQS queue, saves the queue URL
emails inbox watch                        # auto-delivers new mail in real-time (--once to poll once)
```

Alternatively, point an SNS HTTP subscription at `POST /webhook/ses-inbound` on
`emails serve`. Configure `EMAILS_SNS_TOPIC_ARNS` and
`EMAILS_AWS_ACCOUNT_IDS`; the route verifies the AWS signature and exact
allowlists before it confirms or syncs a notification.

## Self-Hosted Runtime (PostgreSQL/S3/SES)

The server uses operator-owned Postgres and provider accounts. A client must configure `EMAILS_MODE=self_hosted`, `EMAILS_SELF_HOSTED_URL`, and `EMAILS_SELF_HOSTED_API_KEY`. The service requires `EMAILS_DATABASE_URL`, `EMAILS_API_SIGNING_KEY`, and `EMAILS_SEND_PROVIDER=ses|resend`. SES uses the deployment IAM role; Resend uses `RESEND_API_KEY`.

Expose the service through an HTTPS reverse proxy or load balancer with edge
rate limits, the 1 MiB request limit, bounded upstream timeouts, and network
rules that keep Postgres and the container port private. The generated client
rejects remote plaintext HTTP. Self-hosted sends require an idempotency key and
support at most five inline attachments (512 KiB each, 768 KiB total);
scheduled sends are not implemented by the self-hosted API. Mailbox read,
star, archive, label, delete, bulk-by-explicit-id, and authenticated attachment
retrieval are supported.

For an operator retry, reuse the same `emails send --idempotency-key <key>`.
Changing the payload under that key is rejected, and an uncertain provider
outcome must be reconciled before another send.

```bash
export EMAILS_MODE=self_hosted
export EMAILS_SELF_HOSTED_URL="https://emails.example.com"
export EMAILS_SELF_HOSTED_API_KEY="..."

# On the self-hosted server
export EMAILS_DATABASE_URL="postgresql://..."
export EMAILS_API_SIGNING_KEY="..."
export EMAILS_SEND_PROVIDER=ses
emails db migrate
emails-serve
```

There is no hybrid cache or bidirectional database synchronization mode.

## Data

Stored in `~/.hasna/emails/` (SQLite + attachments).

## Transport

The shared Streamable HTTP transport is the default (one process, many agents); pass
`--stdio` for a per-client stdio server:

```bash
emails-mcp                     # http://127.0.0.1:8861/mcp (default)
emails-mcp --port 8861         # explicit port
emails-mcp --stdio             # stdio transport (one server per client)
MCP_STDIO=1 emails-mcp         # same
```

- Health: `GET http://127.0.0.1:8861/health` -> `{"status":"ok","name":"emails"}`
- Override port with `MCP_HTTP_PORT` or `--port`

## License

Apache-2.0 — see [LICENSE](LICENSE)
