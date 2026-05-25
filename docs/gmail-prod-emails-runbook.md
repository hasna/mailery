# Gmail prod-emails Archive Runbook

This runbook covers the production Gmail archive path that syncs Gmail profiles
through `@hasna/connectors`, stores messages in `@hasna/emails`, and archives
raw MIME, metadata, manifests, and attachments in `s3://prod-emails`.

## Archive Layout

For each Gmail profile and message ID:

```text
s3://prod-emails/gmail/<profile>/raw/<message-id>.eml
s3://prod-emails/gmail/<profile>/metadata/<message-id>.json
s3://prod-emails/gmail/<profile>/manifests/<message-id>.json
s3://prod-emails/gmail/<profile>/attachments/<message-id>/<filename>
```

Profiles and message IDs are normalized for S3 key safety. The manifest links
the raw MIME object, metadata object, and any archived attachments.

## Initial Full Sync

Use an explicit AWS profile for production runs:

```bash
AWS_PROFILE=hasna emails inbox sync \
  --all-profiles \
  --all \
  --archive-s3 prod-emails \
  --label INBOX \
  --limit 100
```

This discovers Gmail connector profiles via `connectors` and creates one active
`Gmail (<profile>)` provider per profile in `emails`.

## Incremental Sync

Run the same command without `--all` for normal scheduled batches:

```bash
AWS_PROFILE=hasna emails inbox sync \
  --all-profiles \
  --archive-s3 prod-emails \
  --label INBOX \
  --limit 100
```

The local database deduplicates by provider/message ID. Gmail history IDs are
stored on inbound rows and can be used by future history-based resumable sync
jobs.

## Verify an Archived Message

```bash
emails inbox archive-verify \
  --aws-profile hasna \
  --bucket prod-emails \
  --profile maximstaris \
  --message-id <gmail-message-id> \
  --attachment invoice.pdf
```

The command checks for raw MIME, metadata, manifest, and any expected attachment
objects. It exits non-zero when required objects are missing.

## Migrate the Legacy Maxim Bucket

First run a dry run:

```bash
emails inbox archive-migrate \
  --aws-profile hasna \
  --source-bucket hasna-mail-maximstaris \
  --target-bucket prod-emails \
  --source-prefix "" \
  --target-prefix legacy/maximstaris \
  --dry-run
```

Then run the copy:

```bash
emails inbox archive-migrate \
  --aws-profile hasna \
  --source-bucket hasna-mail-maximstaris \
  --target-bucket prod-emails \
  --source-prefix "" \
  --target-prefix legacy/maximstaris
```

After migration, compare object counts in AWS:

```bash
aws s3 ls s3://hasna-mail-maximstaris --recursive --profile hasna | wc -l
aws s3 ls s3://prod-emails/legacy/maximstaris --recursive --profile hasna | wc -l
```

## Operational Checks

1. `connectors status` should show authenticated Gmail profiles.
2. `emails inbox status` should show recent `last_synced_at` values per Gmail
   provider.
3. Spot-check a recently synced message with `emails inbox archive-verify`.
4. Keep S3 bucket versioning/encryption enabled on `prod-emails`.
