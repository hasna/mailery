# Emails on operator-owned AWS

This Terraform root configuration deploys the Emails self-hosted service into
an AWS account controlled by the operator. It contains no maintainer account,
hostname, role, control plane, billing integration, fleet resource, or hosted
service endpoint.

The default is deliberately dormant and unreachable:

- API and inbound-worker desired counts are zero;
- NAT gateways are disabled;
- public and private client endpoints are disabled;
- SES receiving is disabled and no receipt rule set is activated;
- secret values never pass through Terraform;
- the image must be supplied as an immutable digest.

An apply still creates billable RDS infrastructure. “Dormant” means no running
application, mail cutover, NAT, or client exposure; it does not mean free.

## Runtime contract

Task definitions use image-native Bun entrypoints because the runtime image
ships source without installing its package bin links:

```text
bun src/server/index.ts
bun src/server/index.ts ingest-worker
bun src/cli/index.tsx db migrate

EMAILS_MODE=self_hosted
EMAILS_DATABASE_URL=<Secrets Manager injection>
EMAILS_API_SIGNING_KEY=<Secrets Manager injection>
EMAILS_SEND_PROVIDER=ses
EMAILS_INGEST_QUEUE_URL=<worker only>
EMAILS_INGEST_S3_BUCKET=<worker only>
EMAILS_DATABASE_CA_FILE=/opt/emails/certs/aws-rds-global-bundle.pem
# Optional paired bootstrap guard (API task only):
EMAILS_PRIMARY_SUPER_ADMIN_EMAIL=<operator-pinned lowercase email>
EMAILS_PRIMARY_SUPER_ADMIN_BOOTSTRAP_KID=<authorized non-secret API-key identifier>
NODE_EXTRA_CA_CERTS=/opt/emails/certs/aws-rds-global-bundle.pem
```

The user-facing CLI remains `emails`; the native commands above prevent ECS
from depending on bin links that are absent from the image.

The module does not configure a remote vendor URL. Clients connect only to an
operator-enabled HTTPS endpoint and authenticate with an API key created by the
operator after migrations.

## Architecture

```text
operator private clients                    optional Internet clients
          | HTTPS + client SG                         | HTTPS
          v                                           v
 internal ALB + operator cert               WAF rate limit + public ALB
          | HTTP, SG-isolated                         |
          +---------------- ECS API ------------------+
                                |
                         private RDS PostgreSQL

Internet mail -> SES receipt rule (manual activation)
              -> KMS-encrypted S3 raw MIME
              -> KMS-encrypted SNS -> SQS -> ECS worker -> PostgreSQL
                                                |
                                                +-> DLQ on processing failures
```

Client credentials are never sent to a plaintext client endpoint. TLS
terminates at the ALB. The ALB-to-task hop is isolated by paired security-group
rules and is not reachable from client networks directly.

## Cost decisions

A default apply creates a private Multi-AZ RDS instance, KMS key, empty S3/SQS
resources, Secrets Manager containers, logs, alarms, and ECS definitions. Before
applying, estimate the chosen region and instance class.

Additional opt-in costs include:

- one NAT gateway per AZ after `enable_nat_gateway = true`;
- a private or public ALB and its access-log storage;
- WAF for every public endpoint;
- Fargate API and worker tasks;
- SES, SQS/SNS, S3, KMS, and CloudWatch usage.

`single_nat_gateway = true` reduces cost but removes AZ-local egress resilience.
`db_multi_az = false` is intended only for non-production deployments.

## Prerequisites

- Terraform `>= 1.10, < 2.0`.
- Operator-controlled AWS SSO or role credentials; never static keys in files.
- An operator-owned, encrypted, versioned S3 state bucket.
- An operator-built image pinned as `repository@sha256:<digest>`.
- An operator SNS alarm topic with a confirmed destination before tasks start.
- Confirm every alarm-topic subscription is `Confirmed`, not
  `PendingConfirmation`, and send a test notification before setting either ECS
  desired count above zero.
- For private clients: an explicit private hostname, an ACM certificate in this
  account and region, and one or more approved client security groups.
- For public clients: an explicit hostname and ACM certificate or an
  operator-owned Route53 zone for certificate creation.
- For SES receiving: a supported receiving region and a deliberate raw-MIME
  retention period.

## 1. Initialize without implicit state ownership

Copy the examples to protected, ignored files:

```bash
cp examples/backend.hcl.example /secure/path/emails.backend.hcl
cp examples/minimal.tfvars.example /secure/path/emails.tfvars
terraform init -backend-config=/secure/path/emails.backend.hcl
terraform plan -var-file=/secure/path/emails.tfvars -out=/secure/path/emails.tfplan
```

The S3 backend uses native lock files, which is why Terraform 1.10 or newer is
required. The provider also uses `allowed_account_ids`; a credential for any
account other than `expected_account_id` fails before resource operations.

Review the plan through the operator’s approval process. The repository never
runs apply, migration, mail cutover, or DNS changes automatically.

## 2. Bootstrap database roles and secrets

RDS generates its master credential in Secrets Manager. Its output ARN is for
controlled bootstrap only and is never injected into application tasks.

Temporarily allow an SSM-managed administration host through
`database_admin_security_group_ids`, then create separate roles:

```sql
CREATE ROLE emails_migrator LOGIN;
CREATE ROLE emails_app LOGIN;

ALTER DATABASE emails OWNER TO emails_migrator;
ALTER SCHEMA public OWNER TO emails_migrator;

GRANT CONNECT ON DATABASE emails TO emails_app;
GRANT USAGE ON SCHEMA public TO emails_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO emails_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO emails_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emails_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO emails_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emails_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO emails_app;
```

Generate passwords outside Terraform and store TLS PostgreSQL URLs in:

- `migration_database_url_secret_arn` for the schema owner;
- `database_url_secret_arn` for the DML application role.

Populate `api_signing_key_secret_arn` with at least 32 high-entropy characters.
Both PostgreSQL URLs must use `sslmode=verify-full`. The canonical image pins
the Amazon RDS global CA bundle at
`/opt/emails/certs/aws-rds-global-bundle.pem`; every task definition points the
product TLS resolver and Node at that file. RDS also enforces `rds.force_ssl=1`,
so plaintext connections fail. The module contains no secret-version resources
because plaintext would remain in Terraform state.

To prepare the one-time primary super-admin bootstrap, set both
`primary_super_admin_email` and `primary_super_admin_bootstrap_kid`. The module
rejects a half-configured pair and does not hardcode an operator identity. The
KID is a non-secret identifier for one already provisioned API key; keep the
corresponding token in the approved secret store and never put it in Terraform,
task environment variables, plans, or logs. After the bootstrap call succeeds,
prove the same call is idempotent and that a different KID is denied.

Remove temporary database-administration ingress after bootstrap.

## 3. Migrate before starting services

Set `enable_nat_gateway = true` while desired counts remain zero. The private
migration task needs egress to pull its image, read Secrets Manager, and publish
logs.

Before migration 0016, discover and inventory every old API, worker, ingest,
backfill, scheduled, and one-off writer across ECS services, tasks, schedules,
and external processes. Drain and stop all of them. Run only a
new-code-compatible migrator through 0016, require exit code zero, and verify the
migration ledger before starting anything. Start only tenant-aware new-code writers
after the ledger check passes.

Migration 0017 and the 1.2.4 attachment-provenance activation add a second,
forward-only gate with controlled downtime. Disable automatic rollback, save a
queue/DLQ snapshot and cutoff, scale the old ingest worker to zero, wait until
both its running count and SQS in-flight count are zero, then scale the old API
to zero. Only after both incompatible services are stopped may an isolated 1.2.4
migration task apply 0017 and a second 1.2.4 `db status --json` task prove
`pending: []`, the exact ledger ID, and valid checksums. Start only the 1.2.4
worker, drain/reconcile the SQS buffer, and require the aggregate-only
`inbound-provenance-audit --since <cutoff>` to exit zero before the API. The
audit runs from the worker task definition because that definition carries the
deployment-owned canonical bucket. The executable, evidence-producing commands
are in `docs/DEPLOYMENT_CUTOVER.md`.

Before draining any writer, apply with
`enable_automatic_deployment_rollback = false`. Keep automatic rollback disabled
through 0016 and the first tenant-aware API and worker activation. During this
sealed cutover, a failed deployment is roll-forward-only because an ECS rollback
could otherwise restore an unknown pre-tenancy task definition.

Use these outputs to run one Fargate migration task:

- `ecs_cluster_name`;
- `migration_task_definition_arn`;
- `private_subnet_ids`;
- `ecs_task_security_group_id`.

Require exit code zero and inspect `/ecs/<name>/migration`. Run an isolated
one-shot API task and verify `/ready` from inside the VPC before setting
`migrations_complete = true`.

## 4. Choose an HTTPS client endpoint

No client endpoint exists by default.

### Private HTTPS

```hcl
enable_private_endpoint           = true
private_service_domain            = "emails.internal.example.com"
private_certificate_arn           = "arn:aws:acm:REGION:ACCOUNT:certificate/ID"
private_client_security_group_ids = ["sg-operator-vpn-clients"]

# Optional private Route53 alias:
create_private_route53_record = true
private_hosted_zone_id         = "OPERATOR_PRIVATE_ZONE_ID"
```

The internal ALB has no HTTP listener. Port 443 accepts traffic only from the
listed security groups. `private_api_url` is always HTTPS.

### Public HTTPS

```hcl
enable_public_endpoint = true
service_domain         = "emails.example.com"
certificate_arn        = "arn:aws:acm:REGION:ACCOUNT:certificate/ID"

# Or create and DNS-validate in an operator-owned Route53 zone:
create_certificate     = true
hosted_zone_id         = "OPERATOR_PUBLIC_ZONE_ID"
create_route53_records = true

public_rate_limit_per_5_minutes = 2000
```

Public activation always creates and associates WAF rate limiting and enables
ALB access logging. Port 80 is closed rather than redirected so credentials
cannot be sent to a plaintext listener. Review the rate threshold, log retention, privacy,
organizational WAF rules, and abuse controls before exposure.

To remove either endpoint, first set `alb_deletion_protection = false` and apply
that change. Archive and deliberately empty the access-log bucket according to
the retention policy before disabling the last endpoint; Terraform will not
silently destroy non-empty logs.

## 5. Activate with deployment rollback

Set:

```hcl
secrets_ready                        = true
migrations_complete                  = true
enable_nat_gateway                   = true
enable_automatic_deployment_rollback = false
alarm_notification_topic_arn         = "arn:aws:sns:REGION:ACCOUNT:operator-alerts"
email_domain                         = "example.com"
api_desired_count                    = 2
```

The ECS service requires 100% minimum healthy capacity, enables deployment
circuit-breaker rollback, and makes Terraform wait for steady state with bounded
timeouts. The health probe uses image-native Bun against `/ready`.

After 0016 commits, never configure circuit-breaker or operator rollback to a
pre-tenancy or otherwise unscoped image. A prior digest is eligible only when it
is known to be tenant-aware and compatible with the migrated schema. Otherwise,
roll forward to a corrected tenant-aware image, or execute an operator-reviewed
explicit schema recovery plan while every writer remains stopped.

After migration 0017 commits, 1.2.3 is never an eligible task restart,
scale-out, automatic rollback, or operator rollback target. Recovery is a
compatible roll-forward using a reviewed 1.2.4-or-newer image that recognizes
the 0017 ledger. Start the compatible worker from zero, rerun the post-fence
provenance audit, then start the API. Preserve the ledger row and keep
`enable_automatic_deployment_rollback = false` until both 1.2.4 services and
the complete cutover evidence pass.

After both API and worker complete a tenant-aware deployment and the checks below
pass, set `enable_automatic_deployment_rollback = true` in a separate reviewed
apply. From that point, ECS may automatically restore only the verified
tenant-aware completed deployment. Re-disable the gate before any future
schema-sealing migration whose previous binaries would be incompatible.
Terraform rejects enabling the gate before `migrations_complete`; setting it
true is the operator's explicit acknowledgement that the previous completed API
and worker deployment is tenant-aware and schema-compatible.

After apply, prove all of the following:

1. the live task definition contains the approved image digest;
2. desired and running counts match;
3. `/ready` succeeds through the selected HTTPS endpoint;
4. unauthenticated API calls fail;
5. an operator-created API key succeeds;
6. alarms and ALB access logs arrive at their destinations.

After the gate is re-enabled, keep the previous tenant-aware known-good digest
and ECS task-definition revision. To roll back, restore that compatible prior
`container_image` digest, review the plan, apply it, and repeat the six checks.
Exercise this compatible-image rollback in staging after the first tenant-aware
production deployment. Do not deregister eligible task definitions until the
observation window and rollback drill are complete.

## 6. SES sending

`send_provider` is deliberately restricted to `ses`. Setting `email_domain`
creates the SES identity and DKIM tokens; Route53 publication remains opt-in.
The API task role can send only through that exact identity.

Before production sending:

1. verify identity and DKIM;
2. publish SPF, DMARC, and a deliberate MAIL FROM policy;
3. obtain SES production access and review quotas;
4. configure bounce, complaint, and suppression operations;
5. prove an authenticated API send reaches a controlled external inbox.

Infrastructure permission alone is not delivery proof.

## 7. SES receiving and retention

Receiving requires an explicit privacy/cost decision:

```hcl
enable_ses_inbound                = true
email_domain                      = "example.com"
inbound_recipients                = ["example.com"]
inbound_object_retention_days     = 30
worker_desired_count              = 1
```

Terraform creates a rule set and store-and-notify rule but never activates the
account-global receipt rule set. Before manual activation:

1. prove SES can write encrypted raw MIME to S3;
2. prove the SNS/SQS notification reaches the worker;
3. prove a valid message appears once in PostgreSQL and through the HTTPS API;
4. prove processing errors remain visible and redrive to the DLQ;
5. document and test a DLQ replay procedure;
6. confirm the raw-MIME expiration and noncurrent-version retention satisfy
   privacy, legal, recovery, and cost requirements;
7. verify existing MX records are not serving another provider.

The worker deletes successful and duplicate notifications. It also treats
notifications without an S3 object key as terminal “skipped” messages and
deletes them; those do not reach the DLQ. Fetch, parse, or database errors remain
on SQS and move to the DLQ after `sqs_max_receive_count` attempts. Raw MIME in S3
is the recovery source.

Activate `ses_receipt_rule_set_name` and publish `ses_inbound_mx_value` only in a
separate approved mail-routing cutover. Disabling Terraform later does not undo
DNS or an already active SES rule set.

## Validation without AWS credentials

```bash
terraform init -backend=false -lockfile=readonly
terraform fmt -check -recursive
terraform validate
terraform test -no-color
./tests/static_contract.sh
```

The repository CI runs exactly these checks with read-only repository permission,
no OIDC permission, no AWS credentials, and a mocked AWS provider. Tests cover
dormant defaults, decoded task commands/environments, hard-failing safety input,
private TLS, public WAF/logging, SES retention, and activation gates.

AWS references: [SES S3 delivery and encryption](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html),
[SES receiving permissions](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-permissions.html),
[encrypted SNS to SQS delivery](https://docs.aws.amazon.com/sns/latest/dg/sns-enable-encryption-for-topic-sqs-queue-subscriptions.html),
[ECS task-role trust hardening](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html),
and [ALB access-log bucket policy](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html).
