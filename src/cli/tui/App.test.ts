import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender, type TestRendererSetup } from "@opentui/react/test-utils";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createDomain } from "../../db/domains.js";
import { createAddress, markVerified } from "../../db/addresses.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { getSettings, setSetting } from "./data.js";

let autoPullCalls = 0;
let autoPullWaiter: Promise<void> | null = null;
mock.module("./autopull.js", () => ({
  autoPull: mock(async () => {
    autoPullCalls += 1;
    if (autoPullWaiter) await autoPullWaiter;
    return { pulled: 0, ok: true, configured: true };
  }),
}));

const { App } = await import("./App.js");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let savedHome: string | undefined;
let tmpHome: string;
let providerId: string;
let setup: TestRendererSetup | null = null;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["EMAILS_TUI_DISABLE_THEME_PROBE"] = "1";
  savedHome = process.env["HOME"];
  tmpHome = mkdtempSync(join(tmpdir(), "emails-tui-"));
  process.env["HOME"] = tmpHome;
  resetDatabase();
  providerId = createProvider({ name: "sandbox", type: "sandbox", active: true }).id;
  const address = createAddress({ provider_id: providerId, email: "ops@example.com" });
  markVerified(address.id);
  setSetting("autoPull", false);
  autoPullCalls = 0;
  autoPullWaiter = null;
});

afterEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (setup) {
    await act(async () => {
      setup?.renderer.destroy();
      await setup?.flush();
    });
  }
  setup = null;
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_TUI_DISABLE_THEME_PROBE"];
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("emails ui App", () => {
  function seedMessage(subject: string, received_at: string, to = "ops@example.com") {
    return storeInboundEmail({
      provider_id: null,
      message_id: `<${subject}@example.com>`,
      from_address: "sender@example.com",
      to_addresses: [to],
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

  const withAct = async (fn: () => void | Promise<void>) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    await act(fn);
  };
  const flush = async () => {
    await withAct(async () => {
      await setup?.flush();
    });
  };

  async function renderApp(props?: { initialMailbox?: string }, size?: { width?: number; height?: number }) {
    await withAct(async () => {
      setup = await testRender(React.createElement(App, props), {
        width: size?.width ?? 100,
        height: size?.height ?? 30,
        exitOnCtrlC: false,
        consoleMode: "disabled",
        openConsoleOnError: false,
        useMouse: true,
        enableMouseMovement: true,
      });
    });
    await flush();
    return setup;
  }

  const frame = () => setup?.captureCharFrame() ?? "";
  const type = async (text: string) => {
    await withAct(async () => {
      await setup?.mockInput.typeText(text);
    });
    await flush();
  };
  const key = async (name: "up" | "down" | "left" | "right") => {
    await withAct(async () => {
      setup?.mockInput.pressArrow(name);
    });
    await flush();
  };
  const tab = async () => {
    await withAct(async () => {
      setup?.mockInput.pressTab();
    });
    await flush();
  };
  const escape = async () => {
    await withAct(async () => {
      setup?.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    await flush();
  };
  const enter = async () => {
    await withAct(async () => {
      setup?.mockInput.pressEnter();
    });
    await flush();
  };
  const resize = async (width: number, height: number) => {
    await withAct(async () => {
      setup?.resize(width, height);
    });
    await flush();
  };
  const click = async (x: number, y: number) => {
    await withAct(async () => {
      await setup?.mockMouse.click(x, y);
    });
    await flush();
  };

  it("starts on a simple home screen and opens Inbox from there", async () => {
    seedMessage("hello inbox", "2026-01-01T10:00:00.000Z");
    await renderApp();

    expect(frame()).toContain("emails ui");
    expect(frame()).toContain("Choose");
    expect(frame()).toContain("Inbox");
    expect(frame()).toContain("Compose");
    expect(frame()).toContain("Domains");
    expect(frame()).toContain("Profiles");
    expect(frame()).toContain("Settings");

    await type("l");

    expect(frame()).toContain("Inbox: All inboxes");
    expect(frame()).toContain("hello inbox");
  });

  it("uses a two-column dashboard on wide terminals and collapses after resize", async () => {
    seedMessage("wide message", "2026-01-01T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" }, { width: 132, height: 32 });

    expect(frame()).toContain("MAIL");
    expect(frame()).toContain("WORKSPACE");
    expect(frame()).not.toContain("NAVIGATION");
    expect(frame()).not.toContain("FOLDERS");
    expect(frame()).toContain("Inbox: All inboxes");
    expect(frame()).toContain("wide message");

    await resize(78, 26);

    expect(frame()).toContain("1 Inbox  2 Compose  3 Domains  4 Profiles  5 Settings");
    expect(frame()).toContain("Inbox: All inboxes");
    expect(frame()).not.toContain("WORKSPACE");
  });

  it("keeps large sidebar counts inside the navigation border", async () => {
    for (let i = 0; i < 1000; i++) {
      seedMessage(`bulk-${i}`, `2026-01-01T10:${String(i % 60).padStart(2, "0")}:00.000Z`);
    }
    await renderApp({ initialMailbox: "inbox" }, { width: 132, height: 32 });

    const inboxLine = frame().split("\n").find((line) => line.includes("1  Inbox") && line.includes("1,000"));

    expect(inboxLine).toBeTruthy();
    expect(inboxLine).toMatch(/1\s+Inbox\s+1,000\s*│/);
  });

  it("opens compose with an editable From field defaulted from configured addresses", async () => {
    await renderApp({ initialMailbox: "inbox" });

    await type("c");

    expect(frame()).toContain("New message");
    expect(frame()).toContain("from");
    expect(frame()).toContain("ops@example.com");
    expect(frame()).toContain("edit From/To/Subject/Body");

    await tab();
    await tab();
    await tab();
    await type("+");

    expect(frame()).toContain("ops@example.com+");
  });

  it("honors Default From over the selected inbox address", async () => {
    const sales = createAddress({ provider_id: providerId, email: "sales@example.com" });
    markVerified(sales.id);
    const team = createAddress({ provider_id: providerId, email: "team@example.com" });
    markVerified(team.id);
    setSetting("defaultFrom", "team@example.com");
    seedMessage("sales message", "2026-01-02T10:00:00.000Z", "sales@example.com");
    await renderApp({ initialMailbox: "inbox" });

    await type("a");
    await key("down");
    await key("down");
    await enter();
    await type("c");

    expect(frame()).toContain("New message");
    expect(frame()).toContain("team@example.com");
    expect(frame()).not.toContain("sales@example.com|");
  });

  it("returns to Inbox when compose is cancelled from Inbox", async () => {
    seedMessage("inbox message", "2026-01-02T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });

    await type("c");
    expect(frame()).toContain("New message");

    await escape();

    expect(frame()).toContain("Inbox: All inboxes");
    expect(frame()).toContain("inbox message");
    expect(frame()).not.toContain("Choose");
  });

  it("advances from recipient to subject to body with Enter", async () => {
    await renderApp({ initialMailbox: "inbox" });

    await type("c");
    await type("client@example.com");
    await enter();
    await type("Quarterly update");
    await enter();
    await type("Body line");

    expect(frame()).toContain("client@example.com");
    expect(frame()).toContain("Quarterly update");
    expect(frame()).toContain("Body line");
    expect(frame()).not.toContain("Quarterly updateBody line");
  });

  it("moves selection with down and up arrow keys", async () => {
    seedMessage("older message", "2026-01-01T10:00:00.000Z");
    seedMessage("newer message", "2026-01-02T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });

    await key("down");
    await type("l");
    expect(frame()).toContain("older message");

    await type("q");
    await key("up");
    await type("l");
    expect(frame()).toContain("newer message");
  });

  it("filters Inbox by selected email address", async () => {
    const sales = createAddress({ provider_id: providerId, email: "sales@example.com" });
    markVerified(sales.id);
    seedMessage("ops message", "2026-01-01T10:00:00.000Z", "ops@example.com");
    seedMessage("sales message", "2026-01-02T10:00:00.000Z", "sales@example.com");
    await renderApp({ initialMailbox: "inbox" });

    expect(frame()).toContain("Inbox: All inboxes");
    expect(frame()).toContain("ops message");
    expect(frame()).toContain("sales message");

    await type("a");
    expect(frame()).toContain("Choose Address");
    expect(frame()).toContain("All inboxes");
    expect(frame()).toContain("sales@example.com");

    await key("down");
    await key("down");
    await enter();

    expect(frame()).toContain("Inbox: sales@example.com");
    expect(frame()).toContain("sales message");
    expect(frame()).not.toContain("ops message");
  });

  it("searches the address picker before applying an address", async () => {
    const sales = createAddress({ provider_id: providerId, email: "sales@example.com" });
    markVerified(sales.id);
    seedMessage("ops message", "2026-01-01T10:00:00.000Z", "ops@example.com");
    seedMessage("sales message", "2026-01-02T10:00:00.000Z", "sales@example.com");
    await renderApp({ initialMailbox: "inbox" });

    await type("a");
    await type("sales");

    expect(frame()).toContain("Choose Address");
    expect(frame()).toContain("Search sales|");
    expect(frame()).toContain("sales@example.com");

    await enter();

    expect(frame()).toContain("Inbox: sales@example.com");
    expect(frame()).toContain("sales message");
    expect(frame()).not.toContain("ops message");
  });

  it("opens a domains screen with address and email counts", async () => {
    createDomain(providerId, "elyratelier.com");
    const sales = createAddress({ provider_id: providerId, email: "sales@elyratelier.com" });
    markVerified(sales.id);
    seedMessage("domain inbox", "2026-01-02T10:00:00.000Z", "sales@elyratelier.com");
    await renderApp({ initialMailbox: "inbox" }, { width: 160, height: 34 });

    await type("d");

    expect(frame()).toContain("Domains");
    expect(frame()).toContain("Domain overview");
    expect(frame()).toContain("elyratelier.com");
    expect(frame()).toContain("1 address");
    expect(frame()).toContain("1 emails");
    expect(frame()).toContain("receive only");
  });

  it("clicking Inbox resets to the unified inbox", async () => {
    const sales = createAddress({ provider_id: providerId, email: "sales@example.com" });
    markVerified(sales.id);
    seedMessage("ops message", "2026-01-01T10:00:00.000Z", "ops@example.com");
    seedMessage("sales message", "2026-01-02T10:00:00.000Z", "sales@example.com");
    await renderApp({ initialMailbox: "inbox" }, { width: 132, height: 32 });

    await type("a");
    await key("down");
    await key("down");
    await enter();
    expect(frame()).toContain("Inbox: sales@example.com");
    expect(frame()).not.toContain("ops message");

    await click(5, 6);

    expect(frame()).toContain("Inbox: All inboxes");
    expect(frame()).toContain("ops message");
    expect(frame()).toContain("sales message");
  });

  it("pages and changes sort order in Inbox", async () => {
    for (let i = 0; i < 55; i++) {
      seedMessage(`msg-${String(i).padStart(2, "0")}`, `2026-01-01T10:${String(i).padStart(2, "0")}:00.000Z`);
    }
    await renderApp({ initialMailbox: "inbox" }, { width: 132, height: 32 });

    expect(frame()).toContain("page 1+");
    expect(frame()).toContain("newest first");
    expect(frame()).toContain("msg-54");

    await type("n");

    expect(frame()).toContain("page 2");
    expect(frame()).toContain("msg-04");

    await type("N");
    await type("o");

    expect(frame()).toContain("page 1+");
    expect(frame()).toContain("oldest first");
    expect(frame()).toContain("msg-00");
  });

  it("opens a searchable command palette and runs the selected action", async () => {
    await renderApp({ initialMailbox: "inbox" });

    await type(":");
    expect(frame()).toContain("Command palette");
    expect(frame()).toContain("Open Inbox");

    await type("x");
    await type("q");
    expect(frame()).toContain("Command palette");
    expect(frame()).toContain("> xq|");

    await escape();
    await type(":");
    await type("prof");
    expect(frame()).toContain("Profiles");

    await enter();
    expect(frame()).toContain("Configured accounts");
    expect(frame()).toContain("sandbox");
  });

  it("opens settings as an editable dialog", async () => {
    seedMessage("settings background", "2026-01-01T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });

    expect(getSettings().autoPull).toBe(false);

    await type(",");

    expect(frame()).toContain("Settings");
    expect(frame()).toContain("Enter or click edits the selected value.");
    expect(frame()).toContain("Auto-pull inbound");
    expect(frame()).toContain("Inbox: All inboxes");

    await enter();

    expect(getSettings().autoPull).toBe(true);
    expect(frame()).toContain("autoPull: on");

    await escape();

    expect(frame()).not.toContain("Enter or click edits the selected value.");
    expect(frame()).toContain("settings background");
  });

  it("opens settings dialog from the sidebar", async () => {
    await renderApp({ initialMailbox: "inbox" }, { width: 132, height: 32 });

    await click(5, 16);

    expect(frame()).toContain("Enter or click edits the selected value.");
    expect(frame()).toContain("Default folder");
  });

  it("keeps the selected address stable when refresh reorders address choices", async () => {
    const sales = createAddress({ provider_id: providerId, email: "sales@example.com" });
    markVerified(sales.id);
    seedMessage("sales message", "2026-01-02T10:00:00.000Z", "sales@example.com");
    await renderApp({ initialMailbox: "inbox" });

    await type("a");
    await key("down");
    await key("down");
    await enter();
    expect(frame()).toContain("Inbox: sales@example.com");

    const aaa = createAddress({ provider_id: providerId, email: "aaa@example.com" });
    markVerified(aaa.id);
    await type("g");

    expect(frame()).toContain("Inbox: sales@example.com");
    expect(frame()).toContain("sales message");
  });

  it("remains responsive on startup when auto-pull is enabled", async () => {
    setSetting("autoPull", true);
    await renderApp({ initialMailbox: "inbox" });

    await type("c");

    expect(frame()).toContain("New message");
    expect(autoPullCalls).toBe(0);
  });

  it("local refresh keeps selection and does not run the pull engine", async () => {
    seedMessage("older message", "2026-01-01T10:00:00.000Z");
    seedMessage("newer message", "2026-01-02T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });

    await key("down");
    await type("g");
    await enter();

    expect(frame()).toContain("older message");
    expect(autoPullCalls).toBe(0);
  });

  it("explicit pull is on Shift-G", async () => {
    await renderApp({ initialMailbox: "inbox" });

    await type("G");

    expect(autoPullCalls).toBe(1);
  });

  it("ignores overlapping explicit pulls", async () => {
    let release!: () => void;
    autoPullWaiter = new Promise<void>((resolve) => { release = resolve; });
    await renderApp({ initialMailbox: "inbox" });

    await type("G");
    await type("G");

    expect(autoPullCalls).toBe(1);
    await withAct(async () => {
      release();
    });
    await flush();
  });

  it("opens sidebar destinations with mouse clicks on wide terminals", async () => {
    await renderApp({ initialMailbox: "inbox" }, { width: 132, height: 32 });

    await click(5, 13);

    expect(frame()).toContain("New message");
    expect(frame()).toContain("from");
    expect(frame()).toContain("to");
  });

  it("opens the address dialog and applies an address with mouse clicks", async () => {
    const sales = createAddress({ provider_id: providerId, email: "sales@example.com" });
    markVerified(sales.id);
    seedMessage("sales message", "2026-01-02T10:00:00.000Z", "sales@example.com");
    await renderApp({ initialMailbox: "inbox" });

    await type("a");
    expect(frame()).toContain("Choose Address");

    await click(28, 15);

    expect(frame()).toContain("Inbox: sales@example.com");
    expect(frame()).toContain("sales message");
  });

  it("opens a message row with a mouse click", async () => {
    seedMessage("clickable message", "2026-01-02T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });

    await click(5, 6);

    expect(frame()).toContain("Message reader");
    expect(frame()).toContain("clickable message");
  });
});
