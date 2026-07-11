# Domain readiness

Emails supports two deployment modes:

- `local`: SQLite and local files are authoritative.
- `self_hosted`: the operator's Postgres, S3, queues and provider accounts are authoritative.

Provider integrations are capabilities, not deployment modes. AWS SES/S3/SNS/SQS,
Route53, Cloudflare and Resend always use credentials supplied by the operator
and communicate directly with those providers. Additional mailbox providers are
not supported as provider backends.

A sending domain is ready only after ownership, DKIM and SPF evidence is valid.
Inbound readiness additionally requires an active provider route and durable
source such as SES to S3/SQS. DNS mutations require an explicit plan or dry run;
Emails never purchases a domain or changes MX records implicitly.

Useful checks:

```bash
emails domain check example.com
emails provision domain example.com --provider <provider> --dry-run
emails domain verify example.com
```

Self-hosted API clients must explicitly configure `EMAILS_MODE=self_hosted`,
`EMAILS_SELF_HOSTED_URL`, and `EMAILS_SELF_HOSTED_API_KEY`. No endpoint, account,
database, bucket or secret path is supplied by the package.
