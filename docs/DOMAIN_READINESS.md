# Mailery Domain Readiness

Mailery is a multi-domain mail aggregator and sender. A Mailery install can
manage many domains, and each domain has its own ownership, inbound, outbound,
DNS, provider, and safety state. No single DMARC, DKIM, SPF, MX, or SES setting
makes the whole app ready or not ready.

This document is the canonical OSS contract for domain readiness. Platform
wrappers such as Mailery Cloud can add tenant, billing, and provider automation
on top of this contract, but they must not weaken the per-domain rules.

## Deployment Modes

Mailery has three user-visible modes.

| Mode | Owner | Source of truth | Local storage role |
| --- | --- | --- | --- |
| `local` | User machine | Local SQLite/files | Durable source of truth |
| `self_hosted` | User or organization | User-owned PostgreSQL/S3/provider state | Runtime cache only |
| `cloud` | Mailery Cloud SaaS | Mailery Cloud API/RDS/S3/provider state | Optional cache/pull target |

`remote` and `hybrid` are legacy vocabulary and must not be used in new user
interfaces for deployment mode. Compatibility code may continue accepting those
values as aliases, but user-facing docs and CLI output should say `local`,
`self_hosted`, and `cloud`.

The lower-level storage sync mode is separate:

- `HASNA_EMAILS_STORAGE_MODE=remote` means PostgreSQL is the source of truth and
  local SQLite is a runtime cache.
- `HASNA_EMAILS_STORAGE_MODE=hybrid` means local SQLite remains source of truth
  and sync happens only when the operator runs explicit storage sync commands.

## Domain Types

Every domain belongs to exactly one operational scope.

| Type | Example | Meaning |
| --- | --- | --- |
| System domain | `mailery.co` | Platform-owned mail for signup, login, billing, alerts, and system notifications. |
| Tenant domain | `example.com` in Mailery Cloud | A customer or user domain managed by the SaaS control plane. |
| Self-hosted domain | `example.com` in a user AWS account | A user-owned domain managed by the OSS package against user-owned infrastructure. |
| Local-only domain | `example.test` or imported mail | A local development or imported-mail domain with no provider readiness guarantee. |

System domains must never be treated as a fallback sender for tenant domains.
Tenant domains must never be allowed to send as another tenant or as the system
domain. Self-hosted domains must not depend on Mailery Cloud to function.

## Lifecycle

The canonical lifecycle is per domain:

```text
added -> ownership_verified -> inbound_ready -> outbound_ready -> monitored -> restricted
```

`suspended` is a terminal or administrative state that can replace
`restricted` when the domain must be fully disabled.

The states mean:

| State | Meaning |
| --- | --- |
| `added` | The domain row exists, but Mailery has not proven ownership or provider readiness. |
| `ownership_verified` | The operator or platform has proved control over the domain through DNS, provider identity, or explicit trusted configuration. |
| `inbound_ready` | Mail for the domain can be received through the configured inbound provider and stored in the active source of truth. |
| `outbound_ready` | Mailery may send with `From:` addresses on this domain through the configured provider. |
| `monitored` | Real outbound data is flowing and bounce, complaint, delivery, and authentication signals are being observed. |
| `restricted` | The domain can still exist and receive mail, but one or more risky operations are disabled. |
| `suspended` | The domain is disabled for both sending and operational changes until manual or automated remediation. |

Inbound and outbound readiness are independent. A domain can aggregate inbound
mail without being allowed to send. A send-only domain can send without moving
root MX to Mailery, as long as provider and authentication requirements are met.

## Readiness Signals

Mailery should store and report these signals per domain.

| Signal | Scope | Required for |
| --- | --- | --- |
| Ownership verification | Domain | Inbound and outbound setup beyond local-only/imported use |
| MX routing | Domain | Inbound readiness when Mailery receives mail for the domain |
| Provider inbound route | Domain/provider | Inbound readiness |
| DKIM verification | Domain/provider | Outbound readiness |
| SPF or custom MAIL FROM alignment | Domain/provider | Outbound readiness |
| DMARC record | Domain | Monitoring and production-grade outbound posture |
| SES/account production access | Provider/account | Real SaaS or self-hosted SES outbound at scale |
| Bounce/complaint/reject events | Domain/provider | Monitored state and restriction automation |
| Billing/subscription | Tenant/platform | SaaS outbound and hosted resource usage only |

DMARC is intentionally listed as a domain signal, not an app signal. It should
not block local mail viewing, self-hosted inbound aggregation, or SaaS inbound
aggregation. It matters when Mailery sends from that domain and wants a
production-grade sender posture.

## Mode-Specific Rules

### Local

Local mode is the OSS default. Local SQLite and files are the source of truth.
Domain readiness is advisory unless the user configures a real sending or
receiving provider.

Local mode may:

- import, browse, and search mail;
- sync from configured sources;
- use local/test send providers when explicitly configured;
- show DNS and authentication checks for real domains.

Local mode must not:

- silently claim a domain is production-ready;
- send through a real provider without provider credentials and per-domain
  outbound readiness;
- require Mailery Cloud.

### Self-Hosted

Self-hosted mode uses user-owned infrastructure. PostgreSQL owns rows for
mailboxes, messages, domains, providers, send state, and operational state. S3
owns raw inbound MIME and optional attachment materialization. Local SQLite is a
runtime cache only when `HASNA_EMAILS_STORAGE_MODE=remote`.

Self-hosted mode may use AWS RDS/S3/SES, but the OSS contract is not
AWS-exclusive. AWS-specific helpers are implementation details for SES/S3
operators.

Self-hosted mode must:

- verify each domain independently;
- store inbound and outbound readiness in the self-hosted source of truth;
- fail closed before sending from a domain that is not outbound-ready;
- report whether local state is a cache or source of truth;
- avoid storing operator-specific secret names, bucket names, or account IDs in
  public defaults.

### Cloud

Cloud mode uses Mailery Cloud as the source of truth. The OSS CLI is a client of
the hosted API. SaaS-specific concerns such as tenant isolation, subscription
state, Stripe billing, hosted credits, platform SES production access, and
platform-owned domains belong in the private platform wrapper.

Cloud mode must:

- keep `mailery.co` system mail separate from tenant domains;
- expose per-tenant domain readiness through API/CLI;
- block tenant outbound sending until the tenant domain is outbound-ready and
  the tenant has the required billing/credit state;
- allow inbound aggregation to be ready before outbound sending is ready;
- keep `mail_mode=test` or equivalent provider-safe behavior until platform SES
  production access and real-send checks pass.

## Sending Guard

Every outbound send path should use a single domain guard before provider send:

```text
resolve From domain
load active mode
load domain provider state
require ownership_verified
require outbound_ready
require provider/account send capability
require SaaS billing/credits only in cloud mode
send or fail closed with the exact missing requirement
```

The guard must reject:

- sending as an unknown domain;
- sending as a domain owned by a different tenant/provider scope;
- sending as the platform system domain from tenant context;
- sending with DKIM/SPF/custom MAIL FROM missing when the provider requires it;
- sending through SES when the active account is sandboxed and the target flow
  requires production access.

## DNS And Authentication

The DNS checker should report records and readiness per domain:

- MX for inbound routing;
- DKIM records for the selected provider;
- SPF and custom MAIL FROM records for the selected provider;
- DMARC policy and reporting destination;
- provider-specific verification records;
- current DNS authority and whether Mailery is allowed to apply changes.

The checker should support two modes:

- plan mode: generate records and risks without modifying DNS;
- apply mode: modify DNS only when the operator explicitly configured an
  authorized DNS provider.

DMARC rollout should be staged per sending domain:

```text
p=none with rua -> monitor alignment and events -> p=quarantine -> p=reject
```

Mailery should recommend `p=none` for initial setup and should not move to
`quarantine` or `reject` until the domain has clean real-send data.

## CLI And API Contract

The OSS CLI should converge on these user-facing verbs:

```bash
mailery domains add example.com
mailery domains list
mailery domains status example.com --json
mailery domains dns example.com --json
mailery domains verify example.com
mailery domains enable-inbound example.com
mailery domains enable-outbound example.com
mailery domains disable-outbound example.com
```

Existing singular commands such as `mailery domain check` may remain as
compatibility aliases, but new docs and machine-readable examples should prefer
the plural `domains` surface.

JSON output should include:

- `mode`;
- `domain`;
- `domain_type`;
- `source_of_truth`;
- `ownership_status`;
- `inbound_ready`;
- `outbound_ready`;
- `monitoring_status`;
- `restricted`;
- `provider`;
- `dns_records`;
- `missing_requirements`;
- `next_actions`.

## Completion Criteria

The domain-readiness implementation is complete when:

- local, self-hosted, and cloud vocabulary is consistent in docs and CLI output;
- the OSS package can represent many domains with independent lifecycle state;
- inbound and outbound readiness are independent;
- all real send paths use the same fail-closed domain guard;
- self-hosted mode proves local storage is cache-only when configured as remote
  source of truth;
- Mailery Cloud can layer tenant and billing gates on top without forking the
  OSS readiness semantics;
- tests cover DNS parsing, lifecycle transitions, send guard failures, and
  source-of-truth behavior without requiring live secrets.
