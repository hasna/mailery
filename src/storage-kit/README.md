# Emails Postgres storage utilities

This is a product-owned fork of the original Hasna storage-kit template. It is
maintained and tested in this repository; it is intentionally not presented as
generated or compatible with `vendor-kit --check`.

## What it is

A canonical Postgres storage kit for self-hosted Emails deployments:

| File            | Purpose                                                              |
| --------------- | ------------------------------------------------------------------- |
| `mode.ts`       | Storage-mode + env resolution (`local` \| `self_hosted`), per the contract |
| `tls.ts`        | The one correct TLS approach (libpq `sslmode` semantics + RDS CA)    |
| `pool.ts`       | `pg.Pool` factory with consistent TLS                                |
| `query.ts`      | Typed query wrapper (`query` / `many` / `get` / `one` / `execute`)   |
| `migrations.ts` | `schema_migrations` ledger with sha256 checksums                     |
| `health.ts`     | `checkHealth` (SELECT 1) and `checkReady` (migrated?) probes         |

## PURE REMOTE (Amendment A1)

Self-hosted mode = reads **and** writes go directly to self_hosted Postgres. This kit
contains **no sync engine, no cache-as-mode, and no merge logic**. In `local`
mode there is no Postgres pool at all; SQLite is authoritative.

## TLS

`tls.ts` accepts libpq-style `sslmode` names with a stricter, fail-closed
verification policy:

- `require` — encrypt and verify the server certificate against the configured
  CA bundle or the runtime trust store; verification is never disabled
- `verify-ca` / `verify-full` — encrypt **and** verify against a CA bundle
  (mandatory; throws if none is available)

The product container includes the Amazon RDS global CA bundle at
`/opt/emails/certs/aws-rds-global-bundle.pem`. The image sets both
`EMAILS_DATABASE_CA_FILE` and `NODE_EXTRA_CA_CERTS` to that path, so RDS works
with certificate verification on first boot. The bundle is fetched from the
[official AWS trust store](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)
during the image build and is locked to the SHA-256 checksum recorded in the
Dockerfile; an unexpected upstream change fails the build instead of silently
changing the trust roots.

Outside the product container, point `EMAILS_DATABASE_CA_FILE`,
`PGSSLROOTCERT`, or `NODE_EXTRA_CA_CERTS` at a vetted CA bundle. An explicit
`caCertPath` supplied to the storage API takes precedence over environment
settings. `sslrootcert` in `EMAILS_DATABASE_URL` is also supported and takes
precedence over environment settings. Client-certificate URL parameters are
rejected because silently dropping or partially applying them would be unsafe.

## Runtime dependency

Requires `pg` (and `@types/pg` for TypeScript during development).
