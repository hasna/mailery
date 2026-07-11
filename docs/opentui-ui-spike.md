# OpenTUI UI Implementation

Date: 2026-06-04

## Scope

`emails ui` has moved from Ink to OpenTUI. The command now creates an
OpenTUI `CliRenderer`, renders through `@opentui/react`, and keeps OpenTUI
core/react packages external in the Bun bundle so native runtime package
resolution works correctly.

The implemented UI covers:

- Home
- Inbox
- Wide inbox split preview
- Address picker
- Reader
- Compose
- Domains
- Settings

## Current OpenTUI Facts

- OpenTUI is a native terminal UI core written in Zig with TypeScript bindings.
- OpenTUI is currently Bun-exclusive; Node and Deno support are still in progress.
- The UI uses `@opentui/core` and `@opentui/react` at `0.3.2`.
- React is pinned to `19.2.0` to satisfy the OpenTUI React peer dependency.
- OpenTUI detects terminal theme mode; `emails ui` uses that for the persisted
  `auto` theme setting and falls back to local terminal environment hints.

References:

- https://opentui.com/
- https://opentui.com/docs/getting-started/
- https://opentui.com/docs/bindings/react/
- https://opentui.com/docs/core-concepts/renderer/
- https://www.termcn.dev/docs/components/opentui

## Implementation Notes

- `src/cli/commands/ui.tsx` owns renderer creation, terminal title setup, and
  shutdown waiting.
- `src/cli/tui/App.tsx` owns OpenTUI keyboard handling, theme detection,
  terminal background control, and renderable layout.
- `src/cli/tui/data.ts` remains the DB-backed data layer for mailbox lists,
  counts, enriched inbox/address choices, domains, settings, compose send, and mutations.
- `src/cli/tui/theme.ts` now exposes hex palettes for OpenTUI `fg`/`bg` colors,
  including dashboard sidebar and metric surfaces.
- `src/cli/tui/App.test.ts` uses `@opentui/react/test-utils` and OpenTUI mock
  keyboard input instead of `ink-testing-library`.
- Explicit Shift-G pulls are serialized through the same busy lock as
  background auto-pull so repeated refreshes do not overlap.
- There is no mature official OpenTUI template gallery to vendor here. The
  current layout stays as owned app code and follows the available OpenTUI
  renderer, React, resize, and theme-mode APIs.

## UX Model

- Startup without `--mailbox` opens Home, not Inbox.
- Wide terminals open as a two-column dashboard: persistent left navigation and
  a right workspace with mailbox metrics, operations health, or the active
  surface.
- Narrow terminals collapse to a single workspace with a compact top nav.
- Inbox is a unified all-address view by default.
- Wide Inbox renders a message list and preview reader side by side.
- Use the mailbox dialog to choose all mail or an exact email address.
- Use CLI/API/MCP source filters to inspect active, legacy, or orphaned ingestion streams.
- Sidebar labels filter the mailbox without mutating message labels.
- Mail categories are listed separately as Primary, Social, Promotions,
  Updates, and Forums.
- Sources carry provider/account provenance in the picker; domain diagnostics
  live in Domains.
- Compose has editable From, To, Subject, and Body fields.
- Settings opens as a compact dialog with Sync, Defaults, and Display submenus
  for auto-pull, dim-read, default folder, default inbox,
  default From, and theme mode.

## Verification

Focused verification should include:

```bash
bun run build
bun test src/cli/tui
bun dist/cli/index.js ui --help
bun dist/cli/index.js interactive
```

`interactive` should remain an unknown command; this internal app intentionally
uses `emails ui` only.
