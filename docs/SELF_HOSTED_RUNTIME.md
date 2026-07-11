# Self-hosted runtime

Self-hosted means the operator owns the deployment, provider accounts and data.
Emails does not provide or infer a hosted endpoint.

Client configuration:

```bash
export EMAILS_MODE=self_hosted
export EMAILS_SELF_HOSTED_URL="https://emails.example.com"
export EMAILS_SELF_HOSTED_API_KEY="..."
emails inbox list
```

Service configuration:

```bash
export EMAILS_MODE=self_hosted
export EMAILS_DATABASE_URL="postgresql://..."
export EMAILS_API_SIGNING_KEY="..." # 32+ characters
export EMAILS_SEND_PROVIDER=ses     # or resend
export EMAILS_AWS_REGION=us-east-1  # SES; use an IAM role
# export RESEND_API_KEY="..."       # required for Resend
emails db migrate
emails self-hosted key create
emails-serve
```

Run key management on the operator host with the same database and signing-key
environment. `key create` persists only a token hash and metadata and displays
the plaintext token once. `emails self-hosted key list` never shows tokens or
hashes; `emails self-hosted key revoke <kid>` disables a key immediately. The
service rejects signed keys that are absent from its database.

For a rename cutover, run `emails self-hosted key rotate`. It creates a new
Emails application key but deliberately retains the active Mailery-era key.
Move clients, verify reads and sends, keep the old key for the agreed rollback
window, and revoke it explicitly only after rollback is no longer required.

Postgres is authoritative. Local mode uses SQLite. There is no remote, hybrid,
dual-write or synchronization mode between them.

The AWS reference path remains direct and user-owned: SES for sending, S3 for
raw inbound mail and attachments, SNS/SQS with a DLQ for ingestion, Route53 for
DNS, and RDS Postgres for application state. Cloudflare and Resend are optional
direct integrations using credentials supplied by the user. No additional
mailbox-provider import backend is included in this OSS package.

## Production boundary

- Put `emails-serve` behind an HTTPS ALB/reverse proxy. Apply per-key/IP rate
  limits, a 1 MiB request cap, bounded timeouts, and firewall rules; do not
  expose the container or Postgres directly to the internet.
- Use an AWS task/instance role with only the required SES, S3, SQS and SNS
  actions. Local operators should prefer `AWS_PROFILE`; long-lived access keys
  are discouraged.
- Use separate database roles. `emails-migrate` owns DDL; `emails-serve` uses
  the runtime role with table/sequence DML only. The provided Compose init
  script establishes those grants on a new database.
- Self-hosted sends require a durable idempotency key. Inline attachments are
  limited to five, 512 KiB each and 768 KiB total. Scheduled sends are not
  supported by the self-hosted API. Explicit-id bulk mailbox mutations are.
- Resend webhook signatures are mandatory. SES inbound requires a verified AWS
  SNS signature plus exact topic ARN and AWS account allowlists.

## Reproducible dependency pins

The Dockerfile, Compose database image, and CI actions use immutable digests or
commit SHAs. Refresh them in a reviewed dependency update: verify the upstream
tag/release, resolve its current digest/SHA, run the full isolated suite and
Postgres integration job, then record the change in the changelog. Never
silently retag a deployment.
