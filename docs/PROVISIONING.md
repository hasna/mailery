# Email-address provisioning (open-emails)

Give users and agents **real email addresses on domains we own**, fully
automatically: buy the domain, wire DNS through Cloudflare, set up SES sending +
receiving, create addresses, and verify by sending mail back and forth.

## One command
```
emails provision domain ours.com --provider <ses-id> --add-mx   # SES identity + publish DNS in Cloudflare
emails provision address andrew@ours.com --provider <ses-id> --receive ses-s3
emails address provision andrew@ours.com --provider <ses-id> --receive ses-s3  # address-first alias
emails provision status
```
For buying + delegating first, use `@hasna/domains` (`domains domain buy <name> --wait --dns cloudflare`) or the `setup_domain_for_email` MCP tool (which now buys, creates the Cloudflare zone, delegates NS, registers with SES, and publishes DNS **in Cloudflare**).

Ownership is separate from address creation. Use `emails address owner <email>`
to inspect owner/admin state, `emails address set-owner <email> --owner <owner>`
for initial assignment, and the explicit `transfer-owner`, `unassign-owner`, and
`owner-history` commands when ownership changes need an audit trail.

## The pipeline
1. **Buy** (Route53, `@hasna/domains`) — the only reliable self-serve API.
2. **DNS → always Cloudflare** — create the zone, delegate registrar NS to it.
3. **Send** — SES domain identity (any `*@domain` can send); Resend secondary.
4. **Receive** — one of three ingestion-source strategies (none are IMAP mailboxes):
   - `ses-s3` (default): SES receipt rule → S3 → `emails inbox sync-s3` → SQLite. This is an ingestion source feeding the local mailbox.
   - `cf-routing`: Cloudflare Email Routing forward/Worker (no stored body unless a Worker persists it).
   - `resend-webhook`: Resend `email.received` webhook (no stored mailbox body unless persisted).
5. **Validate** — `emails test roundtrip` sends tokened mail back and forth and confirms receipt.

## There is no IMAP/POP mailbox anywhere
No provider (SES, Cloudflare, Resend) exposes an IMAP/POP inbox. Providers are
credentials/capabilities; sources are ingestion streams. For the `ses-s3`
strategy, SES drops raw MIME into S3 and `emails inbox sync-s3` parses it into
the local mailbox store. Query the synced store with `emails inbox mailboxes`,
`emails inbox sources`, or mailbox list/search commands instead of expecting
direct provider mailbox access.

## State machine + daemon
Domains and addresses move through an explicit, resumable lifecycle
(`src/lib/provision/state-machine.ts`); the reconciler daemon
(`src/daemon/provisioner.ts`) advances any entity whose `next_check_at` is due,
crash-safe because all state lives in the DB.

Useful health checks:

```
emails status
emails daemon status
emails inbox sync-status
emails doctor delivery andrew@ours.com
emails logs tail --component daemon
```

## Credentials (`emails doctor`)
- **AWS** (SES send/inbound, Route53 buy): `AWS_PROFILE` or keys, region us-east-1.
- **Cloudflare** (DNS + Email Routing): `CLOUDFLARE_API_TOKEN` *or*
  `CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL` + `CLOUDFLARE_ACCOUNT_ID`.
- **Resend** (optional): `RESEND_API_KEY`.
- **SES sandbox**: new accounts send only to verified identities (200/day, 1/sec);
  request production access with the `ses-sandbox` helper (PutAccountDetails).

## Proven live
Verified end-to-end: 3 funny `.com` domains bought, DNS in Cloudflare, SES DKIM
verified, 3 addresses/domain, **144/144 emails** sent via the `emails` CLI and
received (SES→S3→SQLite). See `docs/PLAN-PROVISIONING.md` for the architecture.

## AWS account architecture (self-hosted operator example)
| Concern | AWS account | Notes |
|---|---|---|
| **SES** (send + inbound) | Operator mail account | Production access. All domain identities, MAIL FROM, and receipt rules live here; configure S3 with `inbound_s3_bucket` / `inbound_s3_buckets`. |
| **Domain purchase** (Route53 Domains) | Operator registrar account | Run `domains domain buy` with the operator's AWS profile or ambient credentials. |
| **DNS** | Operator Cloudflare account | Always Cloudflare — DKIM/SPF/DMARC/MAIL-FROM/inbound-MX + Email Routing. |
| **Send (secondary)** | Resend | Provider integrated; sends proven. Free plan caps Resend-verified domains at 1. |

`emails config set inbound_s3_bucket <bucket>` makes `emails inbox sync-s3` default to that inbound bucket (no `--bucket` needed). Inbound buckets must block public access and use server-side encryption; keep the versioning policy explicit because raw MIME objects are the mailbox for the `ses-s3` strategy. `emails doctor` reports SES sandbox/production + provisioning creds.

### Integration status (priority: SES, Resend, Cloudflare)
- **SES**: verified + send/receive tested with operator-owned domains.
- **Resend**: ✅ send tested end-to-end (Resend send → our domain → SES inbound).
- **Cloudflare**: ✅ DNS + Email Routing client.
