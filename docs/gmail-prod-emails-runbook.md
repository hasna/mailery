# Gmail hasna-xyz-opensource-emails-prod Archive Runbook

This runbook covers the production Gmail archive path that syncs Gmail profiles
through `@hasna/connectors`, stores messages in `@hasna/emails`, and archives
raw MIME, metadata, manifests, and attachments in
`s3://hasna-xyz-opensource-emails-prod`.

`hasna-xyz-opensource-emails-prod` is the canonical production open-source
email archive bucket. It lives in the `hasna-xyz-infra` AWS account
(`789877399345`) in `us-east-1`. Gmail archive uploads default to `us-east-1`;
keep `gmail_archive_s3_region` set to `us-east-1` if overriding config.

Canonical secret paths for this app are:

```text
hasna/xyz/opensource/emails/prod/env
hasna/xyz/opensource/emails/prod/aws
hasna/xyz/opensource/emails/prod/s3
hasna/xyz/opensource/emails/prod/rds
```

## Resource Mapping

| Legacy resource | Canonical resource |
|---|---|
| `s3://hasna-xyz-prod-emails` | `s3://hasna-xyz-opensource-emails-prod` |
| `s3://hasna-mail-maximstaris` | `s3://hasna-xyz-opensource-emails-prod/legacy/maximstaris/` |
| ad hoc app secrets | `hasna/xyz/opensource/emails/prod/{env,aws,s3,rds}` |
| legacy emails Postgres/RDS targets | `hasna-xyz-infra-apps-prod-postgres` database `emails`, runtime secret `hasna/xyz/opensource/emails/prod/rds` |

## Canonical RDS Storage

Production remote storage uses the `emails` database on the
`hasna-xyz-infra-apps-prod-postgres` RDS instance. The app runtime secret path is
`hasna/xyz/opensource/emails/prod/rds`; load that secret into
`HASNA_EMAILS_DATABASE_URL` for runtime or smoke commands and do not print the
connection string.

Mailery's storage slug is `emails`, so the canonical env contract is:

```text
HASNA_EMAILS_DATABASE_URL      # Hasna runtime database URL
EMAILS_DATABASE_URL            # self-hosted fallback
HASNA_EMAILS_STORAGE_MODE      # local | hybrid | remote
EMAILS_STORAGE_MODE            # self-hosted fallback
HASNA_EMAILS_DB_PATH           # local SQLite override
EMAILS_DB_PATH                 # test/back-compat local SQLite override
```

Mode behavior is local-first: `local` uses SQLite/files only, `hybrid` uses
explicit `emails storage push`, `emails storage pull`, or
`emails storage sync --force` against remote PostgreSQL, and `remote` allows
storage commands but rejects normal runtime commands until the runtime has a
remote source-of-truth adapter. Do not infer `HASNA_MAILERY_*` variables.

Source-of-record evidence from the 2026-06-08 RDS inventory selected
`prod-microservice/emails` as the dump source, with `hasnaxyz-prod-opensource/emails`
as a count-identical parity source. Both sources had 22 public tables and 262
total rows before import. Keep those legacy sources available until canonical
counts, app smoke tests, and rollback-window approval are complete.

The canonical RDS instance is private (`PubliclyAccessible=false`), so database
smoke tests must run from a network path with VPC access, such as an approved SSM
tunnel or app runtime host. From that network path:

```bash
export HASNA_EMAILS_DATABASE_URL="<value from hasna/xyz/opensource/emails/prod/rds>"
emails storage status --json
emails storage migrate
emails storage pull --tables providers,addresses,inbound_emails --json
```

Before cutover, freeze legacy writes or keep a bounded rollback window. Roll back
by restoring the previous app secret/env and reading from the legacy source while
preserving the canonical database for diffing.

### SSM Tunnel Smoke Tests

For workstation smoke tests, open a local port forward through the approved
internal host. This keeps RDS private:

```bash
aws --profile hasna-xyz-infra --region us-east-1 ssm start-session \
  --target <approved-ssm-bastion-instance-id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<private-rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["15432"]}'
```

In another shell, load `hasna/xyz/opensource/emails/prod/rds` into
`HASNA_EMAILS_DATABASE_URL` without printing it, rewrite only the local tunnel
host/port, and set `sslmode=no-verify` for the tunnel. Do not use this rewritten
URL for production runtimes; production runtimes should connect to the real RDS
hostname with the normal secret value.

```bash
emails storage status --json
emails storage migrate
emails storage pull --tables providers,addresses,inbound_emails --json
```

If a peer machine such as `spark01` lacks `session-manager-plugin`, keep the SSM
tunnel on a machine that has the plugin and use an SSH reverse forward for the
smoke session:

```bash
ssh -R 15432:127.0.0.1:15432 spark01
```

Then run the same `emails storage ...` smoke commands on the peer with the
rewritten tunnel URL. Never run `storage push` during connectivity validation.

## Archive Layout

Gmail archive objects live in the `hasna-xyz-infra` account bucket
`s3://hasna-xyz-opensource-emails-prod`. SES inbound raw MIME delivery is
separate: production SES receipt rules live in the `hasna-studio-alumia` account
and can write to operator-configured inbound buckets such as
`hasna-emails-prod-inbound-638389534677`.

For each Gmail profile and message ID:

```text
s3://hasna-xyz-opensource-emails-prod/gmail/<profile>/raw/<message-id>.eml
s3://hasna-xyz-opensource-emails-prod/gmail/<profile>/metadata/<message-id>.json
s3://hasna-xyz-opensource-emails-prod/gmail/<profile>/manifests/<message-id>.json
s3://hasna-xyz-opensource-emails-prod/gmail/<profile>/attachments/<message-id>/<filename>
```

Profiles and message IDs are normalized for S3 key safety. The manifest links
the raw MIME object, metadata object, and any archived attachments.

## Initial Full Sync

Use an explicit AWS profile for production runs:

```bash
AWS_PROFILE=hasna-xyz-infra AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 emails inbox sync \
  --all-profiles \
  --all \
  --archive-s3 hasna-xyz-opensource-emails-prod \
  --label INBOX \
  --limit 100
```

This discovers Gmail connector profiles via `connectors` and creates one active
`Gmail (<profile>)` provider per profile in `emails`.

## Incremental Sync

Run the same command without `--all` for normal scheduled batches:

```bash
AWS_PROFILE=hasna-xyz-infra AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 emails inbox sync \
  --all-profiles \
  --history \
  --archive-s3 hasna-xyz-opensource-emails-prod \
  --label INBOX \
  --limit 100
```

The first incremental run for a provider falls back to a normal list-based sync
when no Gmail history cursor exists yet. After that, `--history` asks Gmail for
changes since the stored cursor and advances the provider sync state to Gmail's
latest returned history ID. The local database still deduplicates by
provider/message ID.

## Verify an Archived Message

```bash
emails inbox archive-verify \
  --aws-profile hasna-xyz-infra \
  --bucket hasna-xyz-opensource-emails-prod \
  --profile andreihasnacom \
  --message-id <gmail-message-id> \
  --attachment invoice.pdf
```

The command checks for raw MIME, metadata, manifest, and any expected attachment
objects. It exits non-zero when required objects are missing.

## Migrate the Legacy Maxim Bucket

The legacy `hasna-mail-maximstaris` bucket is in the main `hasna` account, while
`hasna-xyz-opensource-emails-prod` is in `hasna-xyz-infra`. Run the migration
with explicit source and target profiles so objects are streamed into the target
account.

First run a dry run:

```bash
emails inbox archive-migrate \
  --source-aws-profile hasna \
  --target-aws-profile hasna-xyz-infra \
  --source-bucket hasna-mail-maximstaris \
  --target-bucket hasna-xyz-opensource-emails-prod \
  --source-prefix "" \
  --target-prefix legacy/maximstaris \
  --region us-east-1 \
  --target-region us-east-1 \
  --dry-run
```

Then run the copy:

```bash
emails inbox archive-migrate \
  --source-aws-profile hasna \
  --target-aws-profile hasna-xyz-infra \
  --source-bucket hasna-mail-maximstaris \
  --target-bucket hasna-xyz-opensource-emails-prod \
  --source-prefix "" \
  --target-prefix legacy/maximstaris \
  --region us-east-1 \
  --target-region us-east-1
```

For large prefixes, run bounded chunks and resume from the printed token:

```bash
emails inbox archive-migrate \
  --source-aws-profile hasna-xyz-infra \
  --target-aws-profile hasna-xyz-infra \
  --source-bucket hasna-xyz-prod-emails \
  --target-bucket hasna-xyz-opensource-emails-prod \
  --source-prefix gmail/andreihasnacom/metadata/ \
  --target-prefix gmail/andreihasnacom/metadata \
  --region us-west-2 \
  --target-region us-east-1 \
  --limit 1000 \
  --continuation-token <next-token>
```

The target profile must be able to `s3:PutObject` and multipart upload into
`arn:aws:s3:::hasna-xyz-opensource-emails-prod/legacy/maximstaris/*`. The
source profile must be able to `s3:ListBucket` and `s3:GetObject` on the legacy
bucket.

After migration, compare object counts in AWS:

```bash
aws s3 ls s3://hasna-mail-maximstaris --recursive --profile hasna | wc -l
aws s3 ls s3://hasna-xyz-opensource-emails-prod/legacy/maximstaris --recursive --profile hasna-xyz-infra --region us-east-1 | wc -l
```

## Operational Checks

1. `connectors status` should show authenticated Gmail profiles.
2. `emails inbox status` should show recent `last_synced_at` values per Gmail
   provider.
3. Spot-check a recently synced message with `emails inbox archive-verify`.
4. Keep S3 bucket versioning/encryption enabled on `hasna-xyz-opensource-emails-prod`.
