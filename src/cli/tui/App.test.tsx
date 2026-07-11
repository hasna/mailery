/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { testRender, useRenderer, type TestRendererSetup } from "@opentui/solid";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onCleanup } from "solid-js";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createAddress, markVerified } from "../../db/addresses.js";
import { createDomain } from "../../db/domains.js";
import { saveEmailAgentRun } from "../../db/email-agents.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { createProvider } from "../../db/providers.js";
import { setSetting } from "./data.js";
import { registerS3Source } from "../../lib/s3-sync.js";
import { App } from "./App.js";
import { resolveAddressChoice } from "../tui-solid/context/emails-state.js";
import { resetMailDataSource } from "../../lib/mail-data-source.js";

let autoPullCalls = 0;
let autoPullResult = { pulled: 2, ok: true, configured: true, reason: undefined as string | undefined };
mock.module("./autopull.js", () => ({
  autoPull: mock(async () => {
    autoPullCalls += 1;
    return autoPullResult;
  }),
}));

let savedHome: string | undefined;
let tmpHome = "";
let providerId = "";
let setup: TestRendererSetup | null = null;

function Harness(props: { initialMailbox?: "inbox" | "unread" | "starred" | "sent" | "archived" | "spam" | "trash" }) {
  const renderer = useRenderer();
  const keymap = createDefaultOpenTuiKeymap(renderer);
  onCleanup(() => keymap.clearPendingSequence());
  return (
    <KeymapProvider keymap={keymap}>
      <App initialMailbox={props.initialMailbox} />
    </KeymapProvider>
  );
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["EMAILS_TUI_DISABLE_THEME_PROBE"] = "1";
  process.env["EMAILS_TUI_CLIPBOARD_DRY_RUN"] = "1";
  savedHome = process.env["HOME"];
  tmpHome = mkdtempSync(join(tmpdir(), "emails-solid-tui-"));
  process.env["HOME"] = tmpHome;
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  resetMailDataSource();
  resetDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
  const address = createAddress({ provider_id: providerId, email: "ops@example.com" });
  markVerified(address.id);
  setSetting("autoPull", false);
  setSetting("defaultAddress", null);
  autoPullCalls = 0;
  autoPullResult = { pulled: 2, ok: true, configured: true, reason: undefined };
});

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
  closeDatabase();
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  resetMailDataSource();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_TUI_DISABLE_THEME_PROBE"];
  delete process.env["EMAILS_TUI_CLIPBOARD_DRY_RUN"];
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function seedMessage(
  subject: string,
  received_at = "2026-01-01T10:00:00.000Z",
  to = "ops@example.com",
  labels: string[] = [],
  attachments: Array<{ filename: string; content_type: string; size: number; local_path?: string; s3_url?: string }> = [],
) {
  return storeInboundEmail({
    provider_id: providerId,
    message_id: `<${subject}@example.com>`,
    from_address: `Sender ${subject} <sender-${subject.replace(/\s+/g, "-")}@example.com>`,
    to_addresses: [to],
    cc_addresses: [],
    subject,
    text_body: `# ${subject}\n\nbody for ${subject}\n\nhttps://example.com/${encodeURIComponent(subject)}`,
    html_body: null,
    attachments: attachments.map(({ filename, content_type, size }) => ({ filename, content_type, size })),
    attachment_paths: attachments.flatMap((attachment) => attachment.local_path || attachment.s3_url ? [{
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
      ...(attachment.local_path ? { local_path: attachment.local_path } : {}),
      ...(attachment.s3_url ? { s3_url: attachment.s3_url } : {}),
    }] : []),
    label_ids: labels,
    headers: {},
    raw_size: 1,
    received_at,
  });
}

async function renderApp(initialMailbox?: "inbox" | "unread" | "starred" | "sent" | "archived" | "spam" | "trash") {
  setup = await testRender(() => <Harness initialMailbox={initialMailbox} />, {
    width: 120,
    height: 32,
    exitOnCtrlC: false,
    consoleMode: "disabled",
    openConsoleOnError: false,
    kittyKeyboard: true,
    useMouse: true,
    enableMouseMovement: true,
  });
  await setup.flush();
  await Bun.sleep(0);
  await setup.flush();
  return setup;
}

function frame(): string {
  return setup?.captureCharFrame() ?? "";
}

async function flush() {
  await setup?.flush();
}

async function click(x: number, y: number) {
  await setup?.mockMouse.click(x, y);
  await flush();
}

async function clickText(text: string, occurrence = 0) {
  const lines = frame().split("\n");
  let seen = 0;
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(text);
    if (x < 0) continue;
    if (seen++ !== occurrence) continue;
    await click(Math.max(0, x), y);
    return;
  }
  throw new Error(`Text not found: ${text}\n${frame()}`);
}

async function key(name: string, options?: { ctrl?: boolean; shift?: boolean }) {
  if (name === "enter" || name === "return") setup?.mockInput.pressEnter(options);
  else if (name === "escape") setup?.mockInput.pressEscape(options);
  else if (name === "tab") setup?.mockInput.pressTab(options);
  else if (name === "up" || name === "down" || name === "left" || name === "right") setup?.mockInput.pressArrow(name, options);
  else if (name === "pageup") setup?.mockInput.pressKey("\x1B[5~", options);
  else if (name === "pagedown") setup?.mockInput.pressKey("\x1B[6~", options);
  else setup?.mockInput.pressKey(name, options);
  await flush();
}

async function typeText(value: string) {
  await setup?.mockInput.typeText(value);
  await flush();
}

describe("Emails Solid TUI", () => {
  it("resolves a searched-for inbox to its real address, never falling back to All inboxes", () => {
    // Regression: the picker caps the address list (200). An address found by TYPING in the
    // search box but sitting beyond that cap used to make reload() fall back to list[0] =
    // "All inboxes", so selecting it showed every message instead of that inbox.
    expect(resolveAddressChoice("all", []).id).toBe("all");
    expect(resolveAddressChoice("", []).id).toBe("all");

    const inList = resolveAddressChoice("a:ops@example.com", [
      { id: "a:ops@example.com", label: "ops@example.com", address: "ops@example.com", configured: true, observed: false },
    ]);
    expect(inList.address).toBe("ops@example.com");

    // The bug: an id NOT in the candidate list must still resolve to its real address
    // (via the DB), not collapse to "All inboxes".
    const beyondCap = resolveAddressChoice("a:vlado0549196@mbox.contact.bg", []);
    expect(beyondCap.id).toBe("a:vlado0549196@mbox.contact.bg");
    expect(beyondCap.address).toBe("vlado0549196@mbox.contact.bg");
    expect(beyondCap.id).not.toBe("all");
  });

  it("renders the Solid/OpenTUI mailbox with open-aicopilot-style structure", async () => {
    seedMessage("hello inbox", new Date().toISOString(), "long.recipient@example.com");
    await renderApp();

    expect(frame()).toContain("Emails");
    expect(frame()).toContain("Mail");
    expect(frame()).toContain("Labels");
    expect(frame()).toContain("Actions");
    expect(frame()).toContain("hello inbox");
    expect(frame()).toContain("long.recipient@examp");
    expect(frame()).not.toContain("Today");
    expect(frame()).toContain("Newest first");
  });

  it("opens the keymap-backed command palette without printable shortcut conflicts", async () => {
    seedMessage("shortcut safety");
    await renderApp();

    await key("c");
    expect(frame()).not.toContain("Compose\nFrom");

    await key("p", { ctrl: true });
    expect(frame()).toContain("Shortcuts");
    expect(frame()).toContain("Compose");
    expect(frame()).toContain("Filter Mail");
    expect(frame()).toContain("Search Mail");

    await key("down");
    await key("enter");
    expect(frame()).toContain("Compose");
    expect(frame()).toContain("Markdown enabled");
  });

  it("opens messages only on click/enter, not hover-driven selection", async () => {
    seedMessage("first message", "2026-01-01T10:00:00.000Z");
    seedMessage("second message", "2026-01-02T10:00:00.000Z");
    await renderApp();

    await clickText("first message");
    expect(frame()).toContain("first message");
    expect(frame()).not.toContain("From:");

    await key("enter");
    expect(frame()).toContain("From:");
    expect(frame()).toContain("Reply");
    expect(frame()).toContain("Forward");
  });

  it("opens attachment details from the reader", async () => {
    seedMessage("has attachment", "2026-01-01T10:00:00.000Z", "ops@example.com", [], [
      { filename: "invoice.pdf", content_type: "application/pdf", size: 2048, local_path: "/tmp/invoice.pdf" },
    ]);
    await renderApp();

    await key("enter");
    expect(frame()).toContain("1 attachment available");
    expect(frame()).toContain("Attachments");

    await clickText("Attachments");
    expect(frame()).toContain("invoice.pdf");
    expect(frame()).toContain("application/pdf");
    expect(frame()).toContain("2 KB");
    expect(frame()).toContain("file:///tmp/invoice.pdf");
    expect(frame()).toContain("Copy all attachment links");
  });

  it("renders AI summaries below the email body in the reader", async () => {
    const email = seedMessage("summary bottom", "2026-01-01T10:00:00.000Z");
    saveEmailAgentRun({
      agent_key: "categorizer",
      inbound_email_id: email.id,
      provider: "external",
      model: "test",
      status: "ok",
      summary: "AI summary belongs below the email body.",
    });
    await renderApp();

    await key("enter");
    const output = frame();
    const bodyIndex = output.indexOf("body for summary bottom");
    const summaryIndex = output.indexOf("Summary: AI summary belongs below");
    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(bodyIndex);
  });

  it("searches through a dialog and keeps the search visible in the content area", async () => {
    seedMessage("alpha invoice");
    seedMessage("beta newsletter");
    await renderApp();

    await clickText("Search");
    expect(frame()).toContain("Search Mail");
    await typeText("invoice");
    setup?.mockInput.pressEnter();
    await flush();

    expect(frame()).toContain("alpha invoice");
    expect(frame()).not.toContain("beta newsletter");
    expect(frame()).toContain("Search: invoice");
  });

  it("filters from the compact filter dialog and clears filters", async () => {
    seedMessage("alpha invoice");
    seedMessage("beta newsletter");
    await renderApp();

    await clickText("Filter");
    expect(frame()).toContain("Filter Mail");
    expect(frame()).toContain("Unread");
    expect(frame()).toContain("Starred");
    await typeText("invoice");
    setup?.mockInput.pressEnter();
    await flush();

    expect(frame()).toContain("alpha invoice");
    expect(frame()).not.toContain("beta newsletter");
    expect(frame()).toContain("Search: invoice");

    await clickText("Filter");
    await clickText("Clear");
    expect(frame()).toContain("alpha invoice");
    expect(frame()).toContain("beta newslett");
    expect(frame()).not.toContain("Search: invoice");
  });

  it("filters mailbox content from sidebar labels and mail categories", async () => {
    seedMessage("urgent message", "2026-01-03T10:00:00.000Z", "ops@example.com", ["urgent"]);
    seedMessage("updates message", "2026-01-02T10:00:00.000Z", "ops@example.com", ["CATEGORY_UPDATES"]);
    seedMessage("plain message", "2026-01-01T10:00:00.000Z");
    await renderApp();

    expect(frame()).toContain("Categories");
    expect(frame()).toContain("Updates");
    expect(frame()).not.toContain("Category Updates");
    expect(frame()).toContain("Urgent");

    await clickText("Urgent");
    expect(frame()).toContain("Label: Urgent");
    expect(frame()).toContain("urgent message");
    expect(frame()).not.toContain("updates message");
    expect(frame()).not.toContain("plain message");

    await clickText("Inbox");
    expect(frame()).not.toContain("Label: Urgent");

    await clickText("Updates");
    expect(frame()).toContain("Label: Updates");
    expect(frame()).toContain("updates messa");
    expect(frame()).not.toContain("urgent message");
    expect(frame()).not.toContain("plain message");
  });

  it("opens inbox picker, sources, compose, domains dialog, and settings dialog from visible buttons", async () => {
    seedMessage("workspace smoke");
    storeInboundEmail({
      provider_id: providerId,
      message_id: "s3://workspace-source/inbound/msg001",
      raw_s3_url: "s3://workspace-source/inbound/msg001",
      from_address: "source@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "source only",
      text_body: "body",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-05T12:00:00.000Z",
    });
    registerS3Source({ id: "s3-workspace-source", bucket: "workspace-source", prefix: "inbound/", providerId, status: "live", liveSyncEnabled: true });
    createDomain(providerId, "example.com");
    await renderApp();
    expect(frame()).not.toContain("Profiles");

    await clickText("All inboxes");
    expect(frame()).toContain("Inboxes");
    expect(frame()).toContain("ops@example.com");
    // The picker detail is a short status token (the long provider string was clipping
    // the email address); the provider now lives in the Domains view.
    expect(frame()).toContain("configured");
    expect(frame()).not.toContain("Profiles");
    await key("escape");

    await clickText("Sources");
    expect(frame()).toContain("Sources");
    expect(frame()).toContain("workspace-source");
    await clickText("S3 ingestion");
    expect(frame()).toContain("Source: S3 ingestion");
    expect(frame()).toContain("source only");
    expect(frame()).not.toContain("workspace smoke");

    await clickText("Compose");
    expect(frame()).toContain("Compose");
    expect(frame()).toContain("Markdown enabled");
    await typeText("client@example.com");
    await key("tab");
    await typeText("Subject Probe");
    await key("tab");
    await typeText("Body Probe");
    const composeLines = frame().split("\n");
    const subjectLine = composeLines.findIndex((line) => line.includes("Subject Probe"));
    const bodyLine = composeLines.findIndex((line) => line.includes("Body Probe"));
    expect(subjectLine).toBeGreaterThanOrEqual(0);
    expect(bodyLine).toBeGreaterThan(subjectLine);
    await key("escape");

    await clickText("Domains");
    expect(frame()).toContain("Domains");
    expect(frame()).toContain("example.com");
    expect(frame()).toContain("Provider");
    expect(frame()).toContain("Readiness");
    expect(frame()).toContain("Needs DNS");
    expect(frame()).not.toContain("Addr");
    expect(frame()).not.toContain("Needs Dns");
    await key("escape");

    await clickText("Settings");
    expect(frame()).toContain("Settings");
    expect(frame()).toContain("Sync");
    expect(frame()).toContain("Defaults");
    expect(frame()).toContain("Display");

    await clickText("Sync");
    expect(frame()).toContain("Settings / Sync");
    expect(frame()).toContain("Auto-pull inbound");
    await key("escape");

    await clickText("Defaults");
    expect(frame()).toContain("Settings / Defaults");
    expect(frame()).toContain("Default folder");
    expect(frame()).toContain("Default inbox");
    expect(frame()).toContain("Default From");
    await key("escape");

    await clickText("Display");
    expect(frame()).toContain("Settings / Display");
    expect(frame()).toContain("Dim read messages");
    expect(frame()).toContain("Theme");
  });

  it("opens links, raw, and labels dialogs from the reader", async () => {
    seedMessage("links label");
    await renderApp();
    await key("enter");

    await clickText("Links");
    expect(frame()).toContain("Links");
    expect(frame()).toContain("https://example.com");
    expect(frame()).toContain("Open first link");
    await key("escape");

    await clickText("Raw");
    expect(frame()).toContain("Raw Email");
    expect(frame()).toContain("Subject: links label");
    expect(frame()).toContain("Text body");
    await key("escape");

    await clickText("Label", 1);
    expect(frame()).toContain("Labels");
    expect(frame()).toContain("Action Required");
  });

  it("pull now calls autopull and shows a toast", async () => {
    seedMessage("pull smoke");
    await renderApp();

    await clickText("Pull");
    expect(autoPullCalls).toBe(1);
    expect(frame()).toContain("Pull complete");
    const lines = frame().split("\n");
    const toastLine = lines.findIndex((line) => line.includes("Pull complete"));
    expect(toastLine).toBeGreaterThanOrEqual(0);
    expect(toastLine).toBeLessThan(8);
    expect(lines[toastLine]!.indexOf("Pull complete")).toBeGreaterThan(58);
  });

  it("pull now surfaces autopull failures in toast and sidebar state", async () => {
    autoPullResult = { pulled: 0, ok: false, configured: true, reason: "S3 list failed" };
    seedMessage("pull failure");
    await renderApp();

    await clickText("Pull");

    expect(autoPullCalls).toBe(1);
    expect(frame()).toContain("Pull failed");
    expect(frame()).toContain("S3 list failed");
  });

  // The manual Pull affordance triggers LOCAL S3→SQLite ingestion (autoPull). In self_hosted
  // mode the server ingests and the client syncs via the automatic changesSince delta, so
  // Pull is meaningless there — it must render only in local mode (toolbar button AND the
  // "Pull Now" command palette entry). The toolbar row is isolated by the "Digest" line so
  // the empty-state "Pull mail…" copy can't be mistaken for the button.
  const toolbarLine = () => frame().split("\n").find((line) => line.includes("Digest")) ?? "";

  it("shows the Pull toolbar action and command in local mode", async () => {
    seedMessage("local pull");
    await renderApp();

    const toolbar = toolbarLine();
    expect(toolbar).toContain("Digest");
    expect(toolbar).toContain("Pull");

    // The command palette exposes "Pull Now" (filter to it deterministically).
    await key("p", { ctrl: true });
    expect(frame()).toContain("Shortcuts");
    await typeText("Pull");
    expect(frame()).toContain("Pull Now");
  });

  it("hides the Pull toolbar action and command in self_hosted mode", async () => {
    process.env["EMAILS_MODE"] = "self_hosted";
    process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:9";
    process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-only-key";
    resetMailDataSource();
    await renderApp();

    // Self-hosted keeps the other toolbar actions but drops the manual Pull button.
    const toolbar = toolbarLine();
    expect(toolbar).toContain("Digest");
    expect(toolbar).toContain("Newest first");
    expect(toolbar).not.toContain("Pull");

    // The command palette must not expose "Pull Now" in self_hosted mode.
    await key("p", { ctrl: true });
    expect(frame()).toContain("Shortcuts");
    await typeText("Pull");
    expect(frame()).not.toContain("Pull Now");
    expect(frame()).toContain("No matches");
  });
});
