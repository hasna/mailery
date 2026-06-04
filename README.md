# @hasna/emails

Email management CLI + MCP server — send, receive, sync, and manage email via Resend, AWS SES, and Gmail.

[![npm](https://img.shields.io/npm/v/@hasna/emails)](https://www.npmjs.com/package/@hasna/emails)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/emails
```

## Quick Start

```bash
# Add a provider (SES, Resend, or Gmail)
emails provider add --type ses --region us-east-1 --access-key ... --secret-key ...
emails provider add-gmail   # requires: connectors auth gmail

# Set up a domain (buy + DNS + SES in one command)
emails domain setup example.com --provider <id> --email you@example.com ...

# Or configure DNS for an existing domain via Cloudflare
emails domain setup-cloudflare example.com --provider <id>

# Send an email
emails send --from you@example.com --to them@example.com --subject "Hi" --body "Hello"

# Sync Gmail inbox (full content — HTML + attachments)
emails inbox sync --all

# Check sent email log
emails email list

# Sync email data to RDS PostgreSQL
emails cloud push
```

## Interactive mailbox (`emails interactive`)

A clean, full-screen terminal mail client — a folder tab bar plus one focused
view at a time (message list → reader → composer). Live read-state, and it
**auto-refreshes** from the local store and **auto-pulls** new mail in the
background (draining the real-time SES→SNS→SQS queue, or a dedup-safe S3 sync),
so the inbox stays current without a manual sync.

```bash
emails interactive            # or: emails ui
emails interactive --mailbox unread
```

Keys — list: `↑↓`/`j k` move · `Enter` open · `]`/`[` or `1`–`5` switch folder ·
`r` reply · `c` compose · `p` profiles · `s` star · `e` archive · `u` unread ·
`/` search · `g` refresh local view · `G` pull new mail now · `q` quit. Reader: `j/k` scroll · `J/K` next/prev ·
`Esc` back — shows 📎 attachments with size/type. Composer writes **markdown**
(rendered to HTML on send), `Enter` for blank/new lines · `Tab` next field ·
editable From/To/Subject/Body · `Ctrl-S` send · `Esc` cancel. `p` shows your profiles (accounts) + their
domains/addresses. `,` opens settings, including theme mode (`auto`/`light`/`dark`);
auto detects common terminal background hints and falls back to light. Folders:
Inbox · Unread · Starred · Sent · Archived.

## Command Structure

```
emails interactive       # 📬 Mailbox TUI (alias: emails ui) — markdown compose, attachments, profiles
emails profiles          # your accounts (gmail/ses/resend) + their domains & addresses
emails provider          # add/list/remove/sync providers (ses, resend, gmail)
emails domain            # add/verify/buy/setup/dns/check domains
emails address           # manage sender addresses (add, suspend, activate, quota)
emails owner             # tenancy: register human/agent owners
emails alias             # per-domain aliases + catch-all routing
emails sendkey           # scoped send keys (restrict an agent to its own addresses)
emails send              # send an email
emails reply / forward   # reply (in-thread) or forward a sent/inbound email
emails email             # sent email: list, search, show, replies, conversation
emails inbox             # inbound: sync, list, read/star/archive/label, watch (real-time)
emails template          # email templates
emails contact           # contacts (suppression list)
emails group             # recipient groups
emails sequence          # drip sequences
emails schedule          # scheduled emails: list, cancel, run
emails triage            # AI triage: classify, prioritize, draft replies
emails cloud             # sync to/from cloud (RDS PostgreSQL): push, pull, migrate
emails aws               # AWS setup: SES receipt rules, S3 inbound bucket
emails config            # configuration (key=value)
emails stats             # delivery statistics (--inbox for received mail)
emails analytics         # email analytics
emails doctor            # system diagnostics
emails serve             # HTTP server + dashboard + authenticated /api/v1
emails mcp               # install MCP server
```

## Tenancy, aliases & scoped send keys

Every address can have an **owner** that is a human or an agent. A human-owned
address must be administered by an agent (the agent operates it on the human's
behalf); agent-owned addresses are self-administered.

```bash
# Register owners and assign an address (human-owned, agent-administered)
emails owner register Andrei --type human --email andrei@example.com
emails owner register Atlas  --type agent
emails provision address andrei@example.com --provider <ses-id> --owner Andrei --administrator Atlas

# Scoped send keys — an agent can only send from addresses it owns/administers
emails sendkey create Atlas --label ci        # prints the esk_… token ONCE
emails sendkey check  Atlas andrei@example.com # ✓ authorized
emails sendkey list / revoke <id>

# Per-domain aliases + catch-all
emails alias add support@example.com ops@example.com
emails alias catch-all example.com inbox@example.com   # *@example.com → inbox@
emails alias global inbox@example.com                   # protected global catch-all (ALL domains)
emails alias resolve anything@example.com               # show where it routes

# Address lifecycle
emails address suspend <id>     # block sending from this address
emails address activate <id>
emails address quota <id> 200   # max 200 sends/day (use 'none' to clear)
```

## MCP Server

100+ tools for AI agents — send/read mail, provisioning, tenancy, aliases, scoped
send keys, inbound read-state, and real-time sync.

```bash
emails-mcp
```

## REST API

`emails serve` exposes a dashboard plus two API surfaces:

- **Dashboard / management API** under `/api/*` (providers, domains, addresses, emails, stats).
- **Authenticated programmatic API** under `/api/v1/*` for agents/apps, keyed on a
  scoped send key (`Authorization: Bearer esk_…`). Every call is scoped to the
  key owner's addresses, so one caller can't act as another tenant:

```bash
emails serve   # or: emails-serve   (HOST=0.0.0.0 to allow other machines)

curl -H "Authorization: Bearer $ESK" localhost:3900/api/v1/addresses
curl -H "Authorization: Bearer $ESK" -X POST localhost:3900/api/v1/provision/address -d '{"email":"ops@example.com"}'
curl -H "Authorization: Bearer $ESK" -X POST localhost:3900/api/v1/send -d '{"from":"ops@example.com","to":"x@y.com","subject":"hi","text":"yo"}'
curl -H "Authorization: Bearer $ESK" localhost:3900/api/v1/inbox          # mail to your addresses
```

## Inbound Email (AWS SES → S3)

```bash
# Set up S3 bucket + SES receipt rules
emails aws setup-inbound --domain example.com --bucket my-emails

# Pull received emails on demand
emails inbox sync-s3 --bucket my-emails --prefix inbound/example.com/

# Read-state / organize (works for SES-S3, SMTP, and Gmail mail)
emails inbox list --unread            # filters: --unread/--read/--starred/--archived/--label <l>
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
`emails serve` — it auto-confirms the subscription and syncs on each notification.

## Cloud Sync (PostgreSQL)

```bash
# Configure RDS
emails cloud setup --host <rds-host> --username <user>

# Push local SQLite → RDS
emails cloud push

# Pull RDS → local
emails cloud pull
```

## Data

Stored in `~/.hasna/emails/` (SQLite + attachments).

## HTTP mode

Shared Streamable HTTP transport for multi-agent sessions (stdio remains the default):

```bash
emails-mcp --http              # http://127.0.0.1:8816/mcp
MCP_HTTP=1 emails-mcp          # same
emails-mcp --http --port 8816  # explicit port
```

- Health: `GET http://127.0.0.1:8816/health` → `{"status":"ok","name":"emails"}`
- Override port with `MCP_HTTP_PORT` or `--port`

## License

Apache-2.0 — see [LICENSE](LICENSE)
