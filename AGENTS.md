# AGENTS.md — @hasna/emails

This file guides AI coding agents working with `@hasna/emails` — an email management CLI, MCP server, and library supporting Resend, AWS SES, and Gmail.

## What This Package Does

`@hasna/emails` manages the full email lifecycle locally:
- **Send** transactional emails via Resend, SES, or Gmail
- **Receive** inbound emails via SMTP listener or webhooks
- **Track** delivery events, opens, clicks, replies
- **Manage** domains, addresses, templates, contacts, sequences
- **Serve** a local dashboard and REST API

All local data is stored in `~/.hasna/emails/emails.db` by default. Existing
`~/.emails` data is migrated forward automatically. Use `HASNA_EMAILS_DB_PATH`
or `EMAILS_DB_PATH` for isolated tests and smoke runs.

## MCP Setup (Recommended for AI Agents)

Install the MCP server into Claude Code:
```bash
emails mcp --claude
emails mcp --claude --dry-run   # show the exact install command without mutating config
```

This gives you 100+ MCP tools plus orientation resources for agents.

## Key MCP Tools for Common Tasks

### Send an email
```
send_email(from, to, subject, html?, text?, provider_id?, template?, template_vars?, attachments?, unsubscribe_url?, idempotency_key?)
```

### Manage providers
```
list_providers()                          → see configured providers
add_provider(name, type, ...)             → add resend/ses/gmail/sandbox
update_provider(id, ...)                  → update credentials
```

### Domain management
```
add_domain(provider_id, domain)           → register domain with provider
get_dns_records(domain)                   → get DKIM/SPF/DMARC records
verify_domain(domain)                     → re-check DNS status
create_warming_schedule(domain, target)   → start gradual volume ramp-up
get_warming_status(domain)                → check today's limit
```

### Email operations
```
list_emails(limit?, status?, since?)      → browse sent emails
search_emails(query, limit?)              → full-text search
get_email(id)                             → get email details
get_email_content(id)                     → get full HTML/text body
list_replies(email_id)                    → get all replies to a sent email
```

### Contacts & suppression
```
list_contacts(suppressed?)                → browse contacts
suppress_contact(email)                   → add to suppression list
unsuppress_contact(email)                 → remove from suppression list
```

### Templates
```
add_template(name, subject_template, html_template?, text_template?)
list_templates()
send_email(template=name, template_vars={key:val}, ...)  → send with template
```

### Sequences (drip campaigns)
```
create_sequence(name, description?)
add_sequence_step(sequence_id, step_number, delay_hours, template_name)
enroll_contact(sequence_id, contact_email)
list_enrollments(sequence_id?)
```

### Inbox / inbound emails
```
list_inbound_emails(limit?, provider_id?)
get_inbound_email(id)
prepare_inbox(email, provider_id?, create_missing?)
wait_for_code(email, timeout_seconds?)
list_usable_from_addresses(send?, receive?)
```

### Analytics & diagnostics
```
get_analytics(period?)                    → daily volume, top recipients, hourly distribution
get_stats(period?)                        → delivery/bounce/complaint rates
run_doctor(live?)                        → diagnostic check; live=true validates provider credentials remotely
```

### Sandbox (development)
```
add_provider(name, type="sandbox")        → capture emails locally (never send)
list_sandbox_emails(provider_id?)        → browse captured emails
clear_sandbox_emails()                    → wipe sandbox
```

### Export
```
export_emails(format?, provider_id?, since?, until?, limit?, offset?)  → CSV or JSON
export_events(format?, provider_id?, since?, until?, limit?, offset?)  → CSV or JSON
```

### Agent orientation resources
```
emails://agent/context     → redacted operating context and next commands
emails://status            → provider/inbox/source health snapshot
emails://domains           → domain readiness and provisioning context
emails://addresses         → enriched address, owner, and receive state
emails://recent-errors     → latest provisioning/source errors
```

## Workflows

### First-time setup
```
1. add_provider(name="my-resend", type="resend", api_key="re_xxx")
2. add_domain(provider_id=<id>, domain="example.com")
3. get_dns_records("example.com") → configure in DNS registrar
4. verify_domain("example.com") → check status
5. send_email(from="hello@example.com", to="test@test.com", subject="Test", text="Hello!")
```

### Bulk campaign
```
1. add_template(name="welcome", subject_template="Welcome {{name}}!", html_template="<h1>Hi {{name}}</h1>")
2. batch_send(recipients=[{email, vars},...], template_name="welcome", from_address="hello@example.com")
```

### Drip sequence
```
1. create_sequence(name="onboarding")
2. add_sequence_step(sequence_id, step_number=1, delay_hours=0, template_name="welcome")
3. add_sequence_step(sequence_id, step_number=2, delay_hours=72, template_name="followup")
4. enroll_contact(sequence_id, contact_email="user@example.com")
# Run `emails scheduler start` or the daemon/reconciler flow to process due steps
```

### Dev/test (never send real emails)
```
1. add_provider(name="dev", type="sandbox")
2. send_email(provider_id=<sandbox-id>, ...) → captured locally
3. list_sandbox_emails() → inspect what would have been sent
```

## Important Constraints

1. **DB location**: Default is `~/.hasna/emails/emails.db`; old `~/.emails` data is auto-migrated. Use `HASNA_EMAILS_DB_PATH` or `EMAILS_DB_PATH` for testing.
2. **Provider credentials**: Never expose credentials in code — they're stored in the local DB. When listing providers, credentials are automatically redacted (`"***"`).
3. **Domain warming**: If a warming schedule is active for a domain, `send_email` will block at the daily limit. Use `get_warming_status(domain)` first.
4. **Suppression**: Always check `list_contacts(suppressed=true)` before bulk sends.
5. **Attachment limits**: Max 25MB per attachment, max 10 attachments.
6. **Server binding**: `emails serve` defaults to `127.0.0.1:3900` (localhost only). Use `--host 0.0.0.0` to expose externally.

## Development

```bash
bun install          # install dependencies
bun test             # run tests (EMAILS_DB_PATH=:memory: for isolation)
bun run build        # build all bundles
bun run dev:cli      # run CLI in dev mode
bun run dev:mcp      # run MCP server in dev mode
bun run dev:serve    # run HTTP server in dev mode
```

## Project Structure

```
src/
├── cli/
│   ├── index.tsx              # thin orchestrator (~65 lines)
│   ├── utils.ts               # shared helpers
│   ├── tui/                   # OpenTUI emails ui dashboard
│   └── commands/              # modular command files
│       ├── send.ts            # send, log, search, show, replies, conversation
│       ├── provider.ts        # provider CRUD
│       ├── domain.ts          # domain + warming commands
│       ├── sequences.ts       # drip campaigns
│       ├── inbound.ts         # SMTP + inbound email management
│       └── ...                # provider/domain/inbox/address/provision/etc.
├── db/                        # SQLite CRUD modules
│   ├── database.ts            # migrations + schema + legacy path migration
│   ├── emails.ts, providers.ts, domains.ts, ...
│   ├── sequences.ts, warming.ts, inbound.ts, sandbox.ts
│   └── *.test.ts
├── lib/                       # business logic
│   ├── send.ts                # sendWithFailover wrapper
│   ├── sync.ts                # pull events from providers
│   ├── warming.ts             # schedule generation + limit checks
│   ├── tracking.ts            # open/click pixel injection
│   ├── inbound.ts             # MIME parsing + SMTP server
│   ├── email-verify.ts        # MX + SMTP probe verification
│   ├── address-ownership.ts   # owner/admin address tenancy helpers
│   ├── agent-context.ts       # redacted agent orientation snapshots
│   └── ...
├── providers/                 # provider adapters
│   ├── resend.ts, ses.ts, gmail.ts, sandbox.ts
│   └── interface.ts           # ProviderAdapter interface
├── mcp/                       # MCP server, modular tools, and resources
├── server/serve.ts            # HTTP server + REST API
└── index.ts                   # library exports
```

## Adding New Features

The codebase follows these patterns:
- **New DB table**: Add migration in `db/database.ts`, new CRUD file in `db/`, add `ensureTable`/`ensureIndex` in `ensureSchema`
- **New CLI command**: Add to appropriate `cli/commands/*.ts` file
- **New MCP tool**: Add `server.tool(...)` in `mcp/index.ts` before the Start section
- **New REST endpoint**: Add route in `server/serve.ts`
- **New library export**: Add to `src/index.ts`

Test: `EMAILS_DB_PATH=:memory: bun test` — must stay at 0 failures.
