# PLAN — Automated Domain → Email Address Provisioning (open-emails)

> Status: PLANNED (2026-06-02). Owner: agents. Companion plan: `open-domains/docs/PLAN-PROVISIONING.md`.
> This plan turns open-emails into a system that **gives users and agents real email addresses on
> domains we own**, fully automatically: buy/verify the domain, wire DNS through Cloudflare, set up
> SES sending + receiving, create addresses, wait until everything is live, and validate by sending
> mail back and forth.

## 1. Goal

Single command / MCP call / daemon action:

```
emails provision --domain ours.com --addresses andrew,team,hello \
  --send ses --receive ses-s3 --buy-if-needed --wait
```

…that ends with three working mailboxes that can **send and receive** real email, with DNS managed
in Cloudflare regardless of where the domain was bought.

## 2. What already exists (do NOT rebuild)

| Capability | Location | Notes |
|---|---|---|
| SES domain identity + Easy DKIM + send | `src/providers/ses.ts` | SESv2. `addDomain`, `getDnsRecords`, `send`. |
| SES inbound → S3 receipt rules | `src/lib/aws-inbound.ts` | SES **v1** (receipt rules only there). Bucket + rule set + rule. |
| S3 → SQLite inbound sync | `src/lib/s3-sync.ts`, `inbox sync-s3` | Parses raw MIME from S3. |
| Cloudflare DNS auto-publish (DKIM/SPF/DMARC/MX) | `src/lib/cloudflare-dns.ts` `setupEmailDns()` | Via `@hasna/connectors`. |
| Resend send + domain | `src/providers/resend.ts` | Send-only + domain create/verify. |
| Gmail inbound sync | `src/lib/gmail-sync.ts` | Existing working path (143k msgs synced). |
| Partial orchestration | `src/mcp/tools/infrastructure.ts` | `setup_domain_for_email`, `setup_cloudflare_dns`, `setup_ses_inbound`. |
| Address / domain / provider DB | `src/db/{addresses,domains,providers}.ts` | Schema exists; needs extension (§5). |
| Cross-repo link | imports `@hasna/domains` | r53 buy/zone functions already imported. |

**Critical gap:** `setup_domain_for_email` currently creates a **Route53 hosted zone** and writes DNS
there. New rule: **DNS is ALWAYS Cloudflare.** This flow must be refactored to delegate NS to
Cloudflare and publish records via `cloudflare-dns.ts` (§6, T-E2).

## 3. Provider capability matrix (2026 — from research)

| | Buy domain | DNS | Send | Receive / "address" |
|---|---|---|---|---|
| **AWS SES v2** | — | — | ✅ domain identity (any `*@domain` sends) | ✅ receipt rule → S3 (raw MIME, real mailbox). Inbound only in select regions (us-east-1, us-east-2, us-west-2, eu-west-1, …). |
| **AWS Route53 Domains** | ✅ self-serve API (primary) | (hosted zone, but we won't use it) | — | — |
| **Cloudflare** | — | ✅ **always our DNS** | ⚠️ Email Service REST/Worker (paid, verified recipients on free) | ✅ Email Routing: forward-to-destination or Worker. **No mailbox** (forward only). |
| **Resend** | — | (records to publish) | ✅ `POST /emails` | ⚠️ **webhook-only**, no mailbox. New CLI: `resend …`. |
| **GoDaddy retail** | ⚠️ gated (≥10 domains/DDC) | restricted | — | — |
| **Brandsight / GCD** | ❌ enterprise-contract-only | — | — | — |

**Decisions:**
- **Send provider default = SES.** SES domain identity means any address on the domain can send — no per-address object needed.
- **Receive strategies (per address):**
  - `ses-s3` — SES receipt rule → S3 → SQLite. The only **true mailbox** (full raw message stored). Default.
  - `cf-routing` — Cloudflare Email Routing forward to a destination (e.g. a Gmail) or Worker. Free, no stored body unless a Worker persists it.
  - `resend-webhook` — Resend inbound via `email.received` webhook → our HTTP server stores it.
- **No IMAP/POP mailbox exists at any provider** — our SQLite + S3 IS the mailbox. Document this clearly so nobody expects "direct access."

## 4. Architecture — the provisioning state machine

A domain and each address move through an explicit, resumable state machine (persisted in DB so the
daemon can resume after crash/restart):

```
DOMAIN lifecycle:
  requested
    → (buy-if-needed) purchasing        [open-domains: r53 RegisterDomain, poll GetOperationDetail]
    → registered
    → cf_zone_creating                  [Cloudflare: create zone, read NS]
    → ns_delegating                     [registrar: UpdateDomainNameservers → CF NS]
    → ns_propagating                    [poll: resolver returns CF NS]
    → ses_identity_creating             [SESv2 CreateEmailIdentity (Easy DKIM) + MAIL FROM]
    → dns_publishing                    [Cloudflare: DKIM×3 CNAME, SPF TXT, DMARC TXT, MAIL FROM MX+SPF]
    → verifying                         [poll SESv2 GetEmailIdentity until VerifiedForSendingStatus]
    → inbound_setup                     [aws-inbound: S3 bucket + receipt rule set + rule + MX]
    → ready  | failed(reason)

ADDRESS lifecycle (per address on a ready domain):
  requested
    → receive_wiring                    [ses-s3: ensure recipient in receipt rule | cf-routing: rule | resend-webhook: webhook]
    → validating                        [send + receive round-trip probe]
    → ready | failed(reason)
```

Every transition is idempotent and re-entrant. Each state records `attempts`, `last_error`,
`next_check_at`. The **daemon** (§7) simply advances any row whose `next_check_at <= now`.

## 5. Data model changes (`src/db`)

- **`domains`** add: `provisioning_status`, `purchase_provider`, `dns_provider` (always `cloudflare`),
  `send_provider`, `cf_zone_id`, `registrar`, `nameservers_json`, `mail_from_domain`, `last_error`,
  `next_check_at`, `verified_at`.
- **`addresses`** add: `domain_id` (FK), `receive_strategy` (`ses-s3|cf-routing|resend-webhook`),
  `forward_to`, `routing_rule_id`, `provisioning_status`, `last_validated_at`, `last_error`,
  `next_check_at`.
- New table **`provisioning_events`**: append-only audit (`entity_type`, `entity_id`, `from_state`,
  `to_state`, `detail_json`, `created_at`) — powers `emails provision status` and the dashboard.

Add a SQLite migration in `src/db/database.ts` and the matching `pg-migrations.ts` for the remote storage path.

## 6. New / changed code modules

| Module | Purpose |
|---|---|
| `src/lib/provision/state-machine.ts` | Pure transition functions; no I/O. Unit-tested exhaustively. |
| `src/lib/provision/orchestrator.ts` | Executes one transition (calls SES/CF/domains). Idempotent. |
| `src/lib/provision/dns-plan.ts` | Given send/receive strategy, compute the exact record set (DKIM×3, SPF, DMARC, MAIL FROM MX+SPF, inbound MX). One source of truth. |
| `src/lib/cloudflare-routing.ts` | **NEW** — Cloudflare Email Routing: enable zone, add destination, create/list/delete address rules, catch-all, Worker binding. Endpoints from research §B1–B2. |
| `src/lib/cloudflare-dns.ts` | Extend: support **global-key+email** auth (vault has `cloudflare/live/api_key`+`email`, not a scoped token) in addition to `CLOUDFLARE_API_TOKEN`. |
| `src/providers/resend.ts` | Add inbound webhook registration + `email.received` handling; align with new `resend` CLI. |
| `src/lib/aws-inbound.ts` | Extend: add/remove a single recipient to an existing rule (per-address wiring) without recreating the rule set. |
| `src/lib/ses-sandbox.ts` | **NEW** — `PutAccountDetails` to request production access; surface status in `doctor`. |
| `src/cli/commands/provision.ts` | **NEW** — `emails provision`, `emails provision status`, `emails provision retry`, `emails address create --domain`. |
| `src/daemon/provisioner.ts` | **NEW** — long-running reconciler (§7). |
| `src/mcp/tools/infrastructure.ts` | Refactor `setup_domain_for_email` to Cloudflare DNS; add `provision_domain`, `provision_address`, `provision_status` MCP tools. |

## 7. The provisioning daemon

`emails provision daemon` (also `emails daemon` / MCP `provision_daemon_*`):

- Loop every N seconds: load all domains/addresses where `provisioning_status` not in `{ready,failed}`
  and `next_check_at <= now`; advance each one transition via the orchestrator; set `next_check_at`
  with backoff; append a `provisioning_events` row.
- **DNS/verification polling** with exponential backoff (NS propagation and SES DKIM can take minutes).
- **Validation probe** for `ready` candidates: send a unique-token email from the address to a probe
  mailbox (and reverse), then confirm receipt via S3/SQLite (ses-s3), forward target (cf-routing), or
  webhook store (resend-webhook). Only then mark `ready`.
- Crash-safe: state is in DB, so restart resumes mid-flight. Structured logs via `src/lib/logger.ts`.
- Coordinates with the `servers` CLI for lifecycle per workspace rules (no naked long-running procs).
- Emits health to `emails doctor` and the dashboard.

## 8. Live end-to-end test (real domains, real mail)

Gated behind real credentials. Buy **3 real funny 3-word `.com` domains** (availability-checked; buy
first 3 available from the candidate list in `open-domains` plan §8), then per domain create **3
addresses** and send **16 emails back and forth per address** to confirm send+receive.

```
# for each of 3 domains:
emails provision --domain <d> --addresses one,two,three --send ses --receive ses-s3 --buy-if-needed --wait
# round-trip: 16 messages per address (8 out + 8 in), unique token per message, assert all received
emails test roundtrip --domain <d> --addresses one,two,three --count 16
```

Acceptance: 3 domains × 3 addresses × 16 = **144 messages per direction**, 100% delivered & received,
all DNS records present in Cloudflare, SES identity `VerifiedForSendingStatus=true`, inbound MX →
`inbound-smtp.<region>.amazonaws.com`, S3 objects synced into SQLite.

A new `emails test roundtrip` command implements the probe + assertions and is reused by the daemon's
validation step.

## 9. Credentials / wiring gaps to close (from vault audit)

- **Cloudflare:** use `CLOUDFLARE_API_TOKEN`, or `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`
  when global-key auth is required. → task T-E11.
- **AWS:** no creds in shell env; `emails aws status` fails. Wire an AWS profile (SES + Route53Domains
  in us-east-1 for buy/inbound) via config/doctor. → task T-E12.
- **Resend:** set `RESEND_API_KEY` when Resend send/inbound support is needed. → T-E13.
- **SES sandbox:** request production access (`PutAccountDetails`) before live send to external. → T-E14.

## 10. Sequencing (high level)

1. DB migrations + state-machine (pure, fully tested).  2. dns-plan + orchestrator + Cloudflare-DNS
auth fix.  3. cloudflare-routing.ts.  4. Refactor infrastructure.ts to Cloudflare DNS.  5.
provision CLI + MCP tools.  6. daemon.  7. roundtrip test command.  8. credential wiring + SES
sandbox.  9. publish (patch) + `bun install -g` on all machines.  10. **live test on 3 bought
domains.**  Each step ships with tests (TDD) and is published/iterated locally before the next.
