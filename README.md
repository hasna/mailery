# Mailery client

The public Apache-2.0 CLI, MCP server and SDK for [mailery.co](https://mailery.co). This source workspace builds the single public package `@hasna/mailery`.

```sh
bun add @hasna/mailery
```

Use the `mailery` executable or import `MaileryClient` from `@hasna/mailery/sdk`. The client calls the hosted HTTPS API; it does not run a local mail server or access a database/provider account.

- [CLI and MCP usage](packages/cli/README.md)
- [SDK usage](packages/sdk/README.md)
- [Public OpenAPI contract](docs/openapi.json)

## Development

Use Bun 1.3.14 and Node 22.14 or newer. Install the frozen workspace, then run all client checks:

```sh
bun install --frozen-lockfile
bun run publish:check
```

The checks cover source boundaries, types, CLI/MCP/SDK behavior, public API contract, real Node imports, clean packed-package installs and the positive tarball allowlist. The internal SDK workspace is bundled into `@hasna/mailery` and remains private to npm.

## Release

Only `.github/workflows/publish-npm.yml` publishes. It runs on GitHub-hosted runners in the protected `npm-publish` environment and uses npm provenance. Configure the npm trusted publisher for `hasna/mailery`, workflow `publish-npm.yml`, environment `npm-publish`. Protect the main branch and require release review before enabling publication. Before dispatching the workflow into `npm-publish`, the publisher must verify a GO recorded in project-linked Hasna Files from a distinct agent's review of the exact candidate in a fresh context in the publisher's native harness. The GO must bind the commit, tree, package, version, registry, access, distribution tag, workflow revision, and environment. The workflow refuses any other repository or branch.

For an initial package publication that needs bootstrap authentication, the optional protected environment secret `HASNA_NPM_BOOTSTRAP_TOKEN` supplies the approved npm organization credential. Remove it after the trusted publisher is established. Never commit credentials or `.npmrc` authentication settings.

A successful build or packed-file test does not establish publication. Verify the exact registry version's provenance and perform clean executable and SDK installs after publishing.

## 0.2.0

Checkout retries can retain a caller-owned purchase key through SDK `createCheckout({ idempotencyKey })` and CLI `subscribe --idempotency-key`. Keep that key after a timeout or uncertain outcome; a new key starts a deliberate new purchase. Use `subscribe --resume` to check entitlement without creating another Checkout session. Existing SDK string calls and calls without a key remain supported.
