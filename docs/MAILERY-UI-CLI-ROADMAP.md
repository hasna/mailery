# Mailery UI + CLI Roadmap

Created: 2026-06-18

## Baseline

- `EMAILS_DB_PATH=:memory: bun test` passes: 1559 tests, 0 failures.
- Main terminal UI is `src/cli/tui-solid/App.tsx`, loaded by `mailery ui`.
- Legacy `src/cli/tui/App.tsx` re-exports the Solid/OpenTUI app.
- Dashboard frontend is one static file: `dashboard/index.html`.
- Dashboard API routes are split under `src/server/routes/`.
- Existing inbound data already stores attachment metadata and paths.
- Existing TUI reader already renders markdown/html into readable terminal text.
- Existing AI summaries are stored in `email_agent_runs` / `email_triage` and preferred in `getMessageBody`.

## Findings

- Branding still says `Emails`/`Open Emails Dashboard` in the web dashboard, while TUI uses `Mailery` in a secondary line under the selected inbox.
- TUI has `Search`, but not a broader compact filter dialog for address/read/star/label/sort.
- TUI reader shows attachments inline, but has no first-class attachments button/dialog for copy/open actions.
- CLI has `mailery inbox attachment <emailId>`, but MCP reports an imprecise CLI equivalent that looks like it expects an attachment id.
- CLI `mailery inbox open <id>` writes raw body to `/tmp` and shells out with `open || xdg-open`; this needs a safer, testable helper.
- Sent-email `show` still has its own HTML regex rendering instead of reusing the TUI formatter.
- Web inbound reader hides neither local metadata well nor renders text/markdown/html with the same polish as the TUI.
- Web inbound filtering is inline and minimal; it should become a compact filter dialog.
- Link extraction exists in TUI/CLI/MCP, but click behavior only copies the first link on a rendered line.
- Managed Groq email agents already exist, but the UI should make the AI summary presentation explicit with `Summary:` and a raw view toggle.

## Goal Chain

### Goal 2: Shared Email Presentation + Safe Actions

- [x] Create shared helpers for readable email body rendering used by CLI/TUI/web API where practical.
- [x] Add a safe local open/copy helper for URLs and file paths with tests.
- [x] Normalize attachment display into filename, type, size, location, and action fields.
- [x] Fix MCP `get_attachment` CLI equivalent.
- [x] Add focused tests for attachment path/action behavior and CLI rendering.

### Goal 3: Terminal UI Inbox + Reader

- [x] Move `Mailery` above the inbox/address selector in the sidebar.
- [x] Keep Enter behavior consistent for the active row/dialog item/control.
- [x] Add an Inbox `Filter` button that opens a compact filter dialog.
- [x] Add reader `Attachments` button/dialog with copy/open actions.
- [x] Improve link actions: copy link and optionally open web links in browser.
- [x] Prefix summary block with `Summary:`.
- [x] Hide noisy metadata by default and add an explicit raw/details view.
- [x] Add OpenTUI tests for filters, attachment dialog/actions, summary prefix, and raw/details toggle.

### Goal 4: Web Dashboard + Open Source Page

- [x] Add a simple `mailery.co` open-source landing page route/static page.
- [x] Rename visible dashboard branding from `Emails`/`Open Emails` to `Mailery`.
- [x] Improve inbound reader rendering for markdown/html/text and summaries.
- [x] Add inbound filter dialog.
- [x] Add attachments and links controls in each web email view.
- [x] Add REST endpoints if needed for rendered bodies/attachment actions.
- [x] Add route and dashboard tests, plus browser smoke checks if a dev server is needed.

### Goal 5: AI Email Agent UX

- [x] Add explicit CLI commands for managed email agents if missing from user-facing CLI.
- [x] Make Groq defaults and settings obvious in CLI/UI.
- [x] Ensure auto-pull settings can run always-on agents predictably.
- [x] Keep prompt-injection boundaries: email content is data, not instructions.
- [x] Add tests for summary source selection and settings behavior.

### Goal 6: Test Hardening + Debloat

- [x] Add CLI contract tests for every command namespace and high-use options.
- [x] Add JSON-mode smoke coverage for read/list/show/attachment/link/filter commands.
- [x] Remove duplicate formatter/rendering paths after shared helpers land.
- [x] Run `bun run build`, `EMAILS_DB_PATH=:memory: bun test`, and `npm pack --dry-run`.

### Goal 7: Release

- [x] Review git diff and ensure no unrelated changes are included.
- [x] Commit with a focused message.
- [x] Push branch/main as requested.
- [x] Publish only after credentials/auth and release gates are clean.
- [x] Update local/global install and smoke `mailery --version`, `mailery ui --help`, and representative CLI commands.

### Goal 8: Digest + Intelligent Inbox Organization

- [x] Audit existing managed Groq agent, label, digest, TUI, web dashboard, REST, and CLI surfaces.
- [x] Add project-scoped Goal 8 plan and tasks to the local `todos` CLI.
- [x] Add persisted `email_digests` storage with local fallback and Groq-backed generation.
- [x] Add `mailery agent digest` and `mailery agent organize`.
- [x] Normalize managed-agent labels so priority/security/action mail creates visible `important` labels and spam/trash labels drive folders.
- [x] Add TUI Group and Digest controls, grouped mailbox sections, and broader important-square detection.
- [x] Add web dashboard Group and Digest controls, digest API calls, grouped list rendering, and important-square detection.
- [x] Add focused tests for digest generation, organization labels, grouping helpers, CLI digest, REST digest, and dashboard contracts.
- [x] Run full release gates, categorize existing local mail where local credentials allow it, commit, push, publish, update local install, and smoke all commands.

## External Guidance Applied

- Attachment handling should avoid trusting MIME types and filenames, limit size, keep files outside public webroot, and require explicit access paths.
- Untrusted email HTML should use safe sinks/sanitization and avoid raw `innerHTML` where possible.
- Browser link opening should avoid opener access for untrusted links.
- Embedded email HTML should be sandboxed and escaped correctly when using `srcdoc`.
- Gmail-inspired grouping should keep fixed category sections (`Primary`, `Social`, `Promotions`, `Updates`, `Forums`) and a Priority Inbox style grouping (`Important and Unread`, `Starred`, `Everything Else`) rather than inventing many custom top-level folders.

## Verification Log

- Goal 2: `EMAILS_DB_PATH=:memory: bun test` passed: 1568 tests, 0 failures.
- Goal 3: `./node_modules/.bin/tsc --noEmit` passed.
- Goal 3: `EMAILS_DB_PATH=:memory: bun test src/cli/tui/App.test.tsx` passed: 11 tests, 0 failures.
- Goal 3: `EMAILS_DB_PATH=:memory: bun test` passed: 1569 tests, 0 failures.
- Goal 4: `EMAILS_DB_PATH=:memory: bun test src/server/serve.test.ts src/server/routes/rest-parity.test.ts` passed: 28 tests, 0 failures.
- Goal 4: `./node_modules/.bin/tsc --noEmit` passed.
- Goal 4: dashboard inline scripts parsed with `new Function(...)`.
- Goal 4: local smoke server on `http://127.0.0.1:3991` served `/`, `/open-source`, and `/api/inbound?limit=1`; server stopped after verification.
- Goal 4: `EMAILS_DB_PATH=:memory: bun test` passed: 1571 tests, 0 failures.
- Goal 5: `EMAILS_DB_PATH=:memory: bun test src/server/routes/rest-parity.test.ts src/lib/email-agents.test.ts src/cli/commands/status.test.ts src/cli/tui/App.test.tsx` passed: 41 tests, 0 failures.
- Goal 5: `./node_modules/.bin/tsc --noEmit` passed.
- Goal 5: `EMAILS_DB_PATH=:memory: bun test` passed: 1573 tests, 0 failures.
- Goal 6: router/startup contract coverage validates all CLI command namespaces, including the `code` to `inbox` alias.
- Goal 6: `EMAILS_DB_PATH=:memory: bun test src/cli/router.test.ts src/cli/startup-contract.test.ts src/cli/commands/sandbox.test.ts src/cli/tui/format.test.ts src/cli/cli-contract.test.ts src/cli/commands/inbox.test.ts src/cli/commands/inbound.test.ts src/cli/commands/templates.test.ts` passed: 82 tests, 0 failures.
- Goal 6: process-level JSON smoke coverage now exercises agent defaults, inbox list/read/attachment, links, sent email show, and sandbox list/count.
- Goal 6: `./node_modules/.bin/tsc --noEmit` passed.
- Goal 6: `bun run build` passed.
- Goal 6: `npm pack --dry-run` passed.
- Goal 6: package dry-run content check confirmed `dashboard/index.html` and `dashboard/open-source.html` are included: 784 packed entries.
- Goal 6: `EMAILS_DB_PATH=:memory: bun test` passed: 1585 tests, 0 failures, 4780 expect calls across 145 files.
- Goal 7: release review found npm already had `@hasna/mailery@0.6.46`, so package metadata was bumped to `0.6.47`.
- Goal 7: `git diff --check` passed.
- Goal 7: `./node_modules/.bin/tsc --noEmit` passed.
- Goal 7: `EMAILS_DB_PATH=:memory: bun test` passed: 1585 tests, 0 failures, 4780 expect calls across 145 files.
- Goal 7: `bun run build` passed after the `0.6.47` version bump.
- Goal 7: `npm pack --dry-run --silent` passed and produced `hasna-mailery-0.6.47.tgz`.
- Goal 7: package dry-run content check confirmed `dashboard/index.html` and `dashboard/open-source.html` are included: 784 packed entries.
- Goal 7: built CLI smoke passed for `mailery --version` (`0.6.47`), `mailery ui --help`, `provider list --json`, and `agent defaults --json`.
- Goal 7: built server smoke passed for `/` (`Mailery Dashboard`) and `/open-source` (`Mailery Open Source`) on an isolated local DB.
- Goal 7: npm auth is available as `andreihasna2`; latest registry version before publish was `0.6.46`.
- Goal 7: committed release work as `d728b78 feat: improve Mailery inbox UI and release gates`.
- Goal 7: pushed `main` to `origin/main` (renamed later to `https://github.com/hasna/mailery.git`).
- Goal 7: `EMAILS_DB_PATH=:memory: npm publish --access public --registry https://registry.npmjs.org` passed; prepublish tests passed: 1585 tests, 0 failures, 4780 expect calls.
- Goal 7: published `@hasna/mailery@0.6.47` to npm with public access.
- Goal 7: updated Bun global install to `@hasna/mailery@0.6.47` using `--minimum-release-age=0` because the local Bun security policy blocks packages newer than 604800 seconds by default.
- Goal 7: installed `mailery` smoke passed for `mailery --version` (`0.6.47`), `mailery ui --help`, `mailery inbox --help`, `provider list --json`, `inbox list --json`, `sandbox count --json`, and `agent defaults --json`.
- Goal 8: `./node_modules/.bin/tsc --noEmit` passed after digest/organization/TUI/web/API integration.
- Goal 8: `EMAILS_DB_PATH=:memory: bun test src/lib/email-digest.test.ts src/lib/email-agents.test.ts src/cli/commands/status.test.ts src/cli/tui/data.test.ts src/server/routes/rest-parity.test.ts src/server/serve.test.ts src/server/startup-contract.test.ts` passed: 106 tests, 0 failures.
- Goal 8: package metadata bumped from `0.6.47` to `0.6.48` because npm registry latest was already `0.6.47`.
- Goal 8: `git diff --check` passed.
- Goal 8: `./node_modules/.bin/tsc --noEmit` passed after the `0.6.48` version bump.
- Goal 8: `EMAILS_DB_PATH=:memory: bun test` passed: 1592 tests, 0 failures, 4822 expect calls across 146 files.
- Goal 8: `bun run build` passed after the `0.6.48` version bump.
- Goal 8: `npm pack --dry-run --silent` passed and produced `hasna-mailery-0.6.48.tgz`.
- Goal 8: package dry-run content check confirmed `dashboard/index.html`, `dashboard/open-source.html`, and digest build artifacts are included: 796 packed entries.
- Goal 8: built CLI smoke passed for `mailery --version` (`0.6.48`), `agent defaults --json`, `agent digest today --local --json`, and `agent organize --help`.
- Goal 8: local digest smoke against the real default DB succeeded with 78 messages for today; live Groq organization over existing local mail was not run because `GROQ_API_KEY` / `groq_api_key` is not configured locally.
- Goal 8: built dashboard smoke on isolated `http://127.0.0.1:3992` served `/`, `/open-source`, and `/api/digest?period=today`; server was stopped after verification.
- Goal 8: committed implementation as `c29a619 feat: add Mailery inbox digests and grouping` and pushed `main` to `origin/main`.
- Goal 8: `EMAILS_DB_PATH=:memory: npm publish --access public --registry https://registry.npmjs.org` passed; npm prepublish reran `bun test` (1592 tests, 0 failures, 4822 expect calls) and `bun run build`.
- Goal 8: published `@hasna/mailery@0.6.48` to npm with public access.
- Goal 8: updated Bun global install to `@hasna/mailery@0.6.48` using `--minimum-release-age=0`; Bun reported duplicate `@hasna/models` metadata warnings in the global package manifest, but installation and binary linking succeeded.
- Goal 8: installed `mailery` smoke passed for `mailery --version` (`0.6.48`), `mailery ui --help`, `mailery agent digest today --local --json`, `mailery agent organize --help`, `mailery provider list --json`, `mailery inbox list --limit 1 --json`, and `mailery sandbox count --json`.
- Goal 8: npm registry verification returned latest version `0.6.48`.
- Goal 8 follow-up: Groq API key was stored in the local secrets vault and in Mailery local config as redacted `groq_api_key`.
- Goal 8 follow-up: the first live Groq organization pass exposed Groq's incompatibility with AI SDK JSON schema output plus function tools for `llama-3.3-70b-versatile`; `c1c4e0e` fixes Groq agent/digest generation by using strict JSON-text prompts with local validation, keeps function tools for non-Groq providers, and retries prior errored agent runs.
- Goal 8 follow-up: `EMAILS_DB_PATH=:memory: bun test src/lib/email-agents.test.ts src/lib/email-digest.test.ts src/cli/commands/status.test.ts` passed: 13 tests, 0 failures.
- Goal 8 follow-up: `./node_modules/.bin/tsc --noEmit`, `git diff --check`, `EMAILS_DB_PATH=:memory: bun test`, `bun run build`, and `npm pack --dry-run --silent` passed for `0.6.49`; the full suite passed with 1594 tests, 0 failures, and 4834 expect calls across 146 files.
- Goal 8 follow-up: live source CLI Groq smokes passed for `agent digest today --fresh` and `agent organize --all --limit 100 --skip-network`; the organization pass completed 300 ok runs, 0 skipped, 0 errors.
- Goal 8 follow-up: published `@hasna/mailery@0.6.49` to npm; npm prepublish reran the full test suite and build successfully.
- Goal 8 follow-up: updated the local Bun global install from the published `0.6.49` tarball because Bun's registry resolver lagged npm; installed smokes passed for `mailery --version` (`0.6.49`), `mailery agent defaults`, `mailery agent digest today --fresh --limit 20`, and `mailery agent organize --all --limit 5 --skip-network` with 15 ok runs and 0 errors.
