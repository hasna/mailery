# Mailery Self-Hosted Runtime

Mailery has three deployment modes:

- `local`: local SQLite and local files are the source of truth.
- `self_hosted`: user-owned PostgreSQL, S3, and SES are the source of truth.
- `cloud`: Mailery Cloud API is the source of truth.

In `self_hosted` mode, PostgreSQL owns mailbox, message, label, provider, send,
and state rows. S3 owns raw SES MIME objects and optional attachment objects.
The local SQLite database is only a runtime cache so existing CLI, MCP, server,
and TUI code can keep using the synchronous local store safely.

## Runtime Contract

Configure self-hosted source-of-truth mode with:

```bash
export HASNA_EMAILS_DATABASE_URL='<postgresql-connection-url>'
export MAILERY_MODE=self_hosted
export HASNA_EMAILS_STORAGE_MODE=remote
```

`EMAILS_DATABASE_URL` remains a compatibility fallback. Do not print, commit,
or paste connection strings.

The OSS package ships generic self-hosted placeholders only. Production
operators must provide their own PostgreSQL cluster, database, S3 bucket, SES
identity, and secret path values through environment variables or their private
deployment system. Hasna's internal self-hosted deployment uses AWS RDS, SES,
and S3, but its concrete resource names are intentionally not exported from the
package or shown in public docs.

When `HASNA_EMAILS_STORAGE_MODE=remote`, runtime commands:

1. Pull configured runtime tables from PostgreSQL into the local cache.
2. Execute the requested command against the cache.
3. Flush changed cache tables back to PostgreSQL.

Long-running MCP and HTTP server processes prepare the cache at startup and run
periodic background flushes. `HASNA_EMAILS_STORAGE_MODE=hybrid` keeps the older
explicit sync behavior where local SQLite remains the source and operators run
`mailery storage pull`, `mailery storage push`, or `mailery storage sync --force`
manually.

## Commands

```bash
mailery self-hosted setup
mailery self-hosted status --json
mailery self-hosted migrate
mailery self-hosted migrate-local --json
```

`migrate-local` pushes existing local SQLite rows into self-hosted PostgreSQL.
It does not pull first, because pulling would overwrite the local data being
migrated.

The older storage commands remain available:

```bash
mailery storage status
mailery storage migrate
mailery storage migrate-local
mailery storage pull
mailery storage push
```

## S3 And Attachments

SES inbound writes raw MIME to S3. `mailery inbox sync-s3` records `raw_s3_url`
on inbound rows, stores attachment metadata, and, when configured, stores
attachments in S3 as `s3://` URLs. In source-of-truth mode the S3 materialization
tables are flushed to PostgreSQL after successful sync, so the local cache does
not become the durable owner of raw mail or attachments.
