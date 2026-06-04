import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { render, cleanup as cleanupInk } from "ink-testing-library";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createAddress, markVerified } from "../../db/addresses.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { setSetting } from "./data.js";

let autoPullCalls = 0;
mock.module("./autopull.js", () => ({
  autoPull: mock(async () => {
    autoPullCalls += 1;
    return { pulled: 0, ok: true, configured: true };
  }),
}));

const { App } = await import("./App.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const arrowDown = "\u001B[B";
const arrowUp = "\u001B[A";

let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  savedHome = process.env["HOME"];
  tmpHome = mkdtempSync(join(tmpdir(), "emails-tui-"));
  process.env["HOME"] = tmpHome;
  resetDatabase();
  const providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
  const address = createAddress({ provider_id: providerId, email: "ops@example.com" });
  markVerified(address.id);
  setSetting("autoPull", false);
  autoPullCalls = 0;
});

afterEach(() => {
  cleanupInk();
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("interactive TUI App", () => {
  function seedMessage(subject: string, received_at: string) {
    return storeInboundEmail({
      provider_id: null,
      message_id: `<${subject}@example.com>`,
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject,
      text_body: `body for ${subject}`,
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at,
    });
  }

  it("opens compose with an editable From field defaulted from configured addresses", async () => {
    const app = render(React.createElement(App, { initialMailbox: "inbox" }));
    await tick();

    app.stdin.write("c");
    await tick();

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("New message");
    expect(frame).toContain("from");
    expect(frame).toContain("ops@example.com");
    expect(frame).toContain("edit From/To/Subject/Body");

    app.stdin.write("\t");
    await tick();
    app.stdin.write("\t");
    await tick();
    app.stdin.write("\t");
    await tick();
    app.stdin.write("+");
    await tick();

    expect(app.lastFrame() ?? "").toContain("ops@example.com+");
  });

  it("advances from recipient to subject to body with Enter", async () => {
    const app = render(React.createElement(App, { initialMailbox: "inbox" }));
    await tick();

    app.stdin.write("c");
    await tick();
    app.stdin.write("client@example.com");
    await tick();
    app.stdin.write("\n");
    await tick();
    app.stdin.write("Quarterly update");
    await tick();
    app.stdin.write("\n");
    await tick();
    app.stdin.write("Body line");
    await tick();

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("client@example.com");
    expect(frame).toContain("Quarterly update");
    expect(frame).toContain("Body line");
    expect(frame).not.toContain("Quarterly updateBody line");
  });

  it("moves selection with down and up arrow keys", async () => {
    seedMessage("older message", "2026-01-01T10:00:00.000Z");
    seedMessage("newer message", "2026-01-02T10:00:00.000Z");
    const app = render(React.createElement(App, { initialMailbox: "inbox" }));
    await tick();

    app.stdin.write(arrowDown);
    await tick();
    app.stdin.write("\n");
    await tick();
    expect(app.lastFrame() ?? "").toContain("older message");

    app.stdin.write("q");
    await tick();
    app.stdin.write(arrowUp);
    await tick();
    app.stdin.write("\n");
    await tick();
    expect(app.lastFrame() ?? "").toContain("newer message");
  });

  it("remains responsive on startup when auto-pull is enabled", async () => {
    setSetting("autoPull", true);
    const app = render(React.createElement(App, { initialMailbox: "inbox" }));
    await tick();

    app.stdin.write("c");
    await tick();

    expect(app.lastFrame() ?? "").toContain("New message");
    expect(autoPullCalls).toBe(0);
  });

  it("local refresh keeps selection and does not run the pull engine", async () => {
    seedMessage("older message", "2026-01-01T10:00:00.000Z");
    seedMessage("newer message", "2026-01-02T10:00:00.000Z");
    const app = render(React.createElement(App, { initialMailbox: "inbox" }));
    await tick();

    app.stdin.write(arrowDown);
    await tick();
    app.stdin.write("g");
    await tick();
    app.stdin.write("\n");
    await tick();

    expect(app.lastFrame() ?? "").toContain("older message");
    expect(autoPullCalls).toBe(0);
  });

  it("explicit pull is on Shift-G", async () => {
    const app = render(React.createElement(App, { initialMailbox: "inbox" }));
    await tick();

    app.stdin.write("G");
    await tick();
    await tick();

    expect(autoPullCalls).toBe(1);
  });
});
