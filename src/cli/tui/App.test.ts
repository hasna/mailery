import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender, type TestRendererSetup } from "@opentui/react/test-utils";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createDomain } from "../../db/domains.js";
import { createAddress, markVerified } from "../../db/addresses.js";
import { getInboundEmail, storeInboundEmail } from "../../db/inbound.js";
import { setAddressProvisioning } from "../../db/provisioning.js";
import { getSettings, setSetting } from "./data.js";

let autoPullCalls = 0;
let autoPullWaiter: Promise<void> | null = null;
let autoPullResult = { pulled: 0, ok: true, configured: true };
mock.module("./autopull.js", () => ({
  autoPull: mock(async () => {
    autoPullCalls += 1;
    if (autoPullWaiter) await autoPullWaiter;
    return autoPullResult;
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
  autoPullResult = { pulled: 0, ok: true, configured: true };
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

  it("starts directly in the unified Inbox", async () => {
    seedMessage("hello inbox", "2026-01-01T10:00:00.000Z");
    await renderApp();

    expect(frame()).toContain("emails ui");
    expect(frame().split("\n")[0]).not.toContain("Inbox: All inboxes");
    expect(frame()).toContain("Inbox: All inboxes");
    expect(frame()).toContain("hello inbox");
    expect(frame()).toContain("Compose");
    expect(frame()).toContain("Domains");
    expect(frame()).toContain("Profiles");
    expect(frame()).toContain("Settings");
    expect(frame()).not.toContain("Dashboard");
    expect(frame()).not.toContain("Mailbox overview");
  });

  it("does not reload the initial mailbox twice on startup", async () => {
    seedMessage("single startup load", "2026-01-01T10:00:00.000Z");
    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      await renderApp({ initialMailbox: "inbox" });

      expect(frame()).toContain("single startup load");
      const mailboxPageQueries = queries.filter((sql) => sql.includes("substr(text_body, 1, 140) AS snippet"));
      expect(mailboxPageQueries).toHaveLength(1);
    } finally {
      db.query = originalQuery;
    }
  });

  it("uses a two-column inbox shell on wide terminals and collapses after resize", async () => {
    seedMessage("wide message", "2026-01-01T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" }, { width: 132, height: 32 });

    expect(frame()).toContain("MAIL");
    expect(frame()).toContain("WORKSPACE");
    expect(frame()).not.toContain("NAVIGATION");
    expect(frame()).not.toContain("FOLDERS");
    expect(frame()).toContain("Inbox: All inboxes");
    expect(frame()).toContain("wide message");
    expect(frame()).not.toContain("Preview");

    await resize(78, 26);

    expect(frame()).toContain("1 Inbox  2 Compose  3 Domains  4 Profiles  5 Settings");
    expect(frame()).not.toContain("Settings  ·");
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

  it("opens inbox messages without reloading the mailbox page", async () => {
    seedMessage("open fast", "2026-01-01T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });
    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      await enter();

      expect(frame()).toContain("body for open fast");
      expect(queries.some((sql) => sql.includes("substr(text_body, 1, 140) AS snippet"))).toBe(false);
      expect(queries.some((sql) => sql.includes("SELECT COUNT(*) FROM inbound_emails"))).toBe(false);
    } finally {
      db.query = originalQuery;
    }
  });

  it("toggles inbox flags without reloading the mailbox page", async () => {
    const seeded = seedMessage("flag fast", "2026-01-01T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });
    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      await type("s");
      await type("u");

      const updated = getInboundEmail(seeded.id, db);
      expect(updated?.is_starred).toBe(true);
      expect(updated?.is_read).toBe(true);
      expect(frame()).toContain("0 unread");
      expect(queries.some((sql) => sql.includes("substr(text_body, 1, 140) AS snippet"))).toBe(false);
      expect(queries.some((sql) => sql.includes("SELECT COUNT(*) FROM inbound_emails"))).toBe(false);
    } finally {
      db.query = originalQuery;
    }
  });

  it("archives inbox messages without reloading the mailbox page", async () => {
    const seeded = seedMessage("archive fast", "2026-01-01T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });
    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      await type("e");

      const updated = getInboundEmail(seeded.id, db);
      expect(updated?.is_archived).toBe(true);
      expect(frame()).toContain("0 inbox");
      expect(frame()).not.toContain("archive fast");
      expect(queries.some((sql) => sql.includes("substr(text_body, 1, 140) AS snippet"))).toBe(false);
      expect(queries.some((sql) => sql.includes("SELECT COUNT(*) FROM inbound_emails"))).toBe(false);
    } finally {
      db.query = originalQuery;
    }
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

  it("does not compute global counts after switching to a non-empty address inbox", async () => {
    const sales = createAddress({ provider_id: providerId, email: "sales@example.com" });
    markVerified(sales.id);
    seedMessage("ops message", "2026-01-01T10:00:00.000Z", "ops@example.com");
    seedMessage("sales message", "2026-01-02T10:00:00.000Z", "sales@example.com");
    await renderApp({ initialMailbox: "inbox" });

    await type("a");
    await key("down");
    await key("down");

    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      await enter();

      expect(frame()).toContain("Inbox: sales@example.com");
      expect(frame()).toContain("sales message");
      expect(queries.some((sql) => sql.includes("(SELECT COUNT(*) FROM inbound_emails WHERE is_sent = 0 AND is_archived = 0) AS inbox"))).toBe(false);
      expect(queries.some((sql) => sql.includes("FROM inbound_recipients"))).toBe(true);
    } finally {
      db.query = originalQuery;
    }
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

  it("applies a searched address outside the initial bounded list with keyboard", async () => {
    const target = createAddress({ provider_id: providerId, email: "target@example.com" });
    markVerified(target.id);
    for (let i = 0; i < 205; i++) {
      createAddress({ provider_id: providerId, email: `filler-${String(i).padStart(3, "0")}@example.com` });
    }
    const db = getDatabase();
    db.run("UPDATE addresses SET created_at = ? WHERE email LIKE 'filler-%@example.com'", ["2026-01-02T00:00:00.000Z"]);
    db.run("UPDATE addresses SET created_at = ? WHERE email = ?", ["2026-01-01T00:00:00.000Z", "target@example.com"]);
    seedMessage("ops message", "2026-01-01T10:00:00.000Z", "ops@example.com");
    await renderApp({ initialMailbox: "inbox" });

    seedMessage("target message", "2026-01-02T10:00:00.000Z", "target@example.com");
    await type("a");
    await type("target");

    expect(frame()).toContain("Choose Address");
    expect(frame()).toContain("target@example.com");

    await enter();

    expect(frame()).toContain("Inbox: target@example.com");
    expect(frame()).toContain("target message");
    expect(frame()).not.toContain("ops message");
  });

  it("keeps a default inbox address outside the initial bounded list", async () => {
    const target = createAddress({ provider_id: providerId, email: "target-default@example.com" });
    markVerified(target.id);
    for (let i = 0; i < 205; i++) {
      createAddress({ provider_id: providerId, email: `default-filler-${String(i).padStart(3, "0")}@example.com` });
    }
    const db = getDatabase();
    db.run("UPDATE addresses SET created_at = ? WHERE email LIKE 'default-filler-%@example.com'", ["2026-01-02T00:00:00.000Z"]);
    db.run("UPDATE addresses SET created_at = ? WHERE email = ?", ["2026-01-01T00:00:00.000Z", "target-default@example.com"]);
    setSetting("defaultAddress", "target-default@example.com");
    seedMessage("ops message", "2026-01-01T10:00:00.000Z", "ops@example.com");
    seedMessage("target default message", "2026-01-02T10:00:00.000Z", "target-default@example.com");

    await renderApp({ initialMailbox: "inbox" });

    expect(frame()).toContain("Inbox: target-default@example.com");
    expect(frame()).toContain("target default message");
    expect(frame()).not.toContain("ops message");

    await type("g");

    expect(frame()).toContain("Inbox: target-default@example.com");
    expect(frame()).toContain("target default message");
    expect(frame()).not.toContain("ops message");
  });

  it("opens a domains screen with address and email counts", async () => {
    const domain = createDomain(providerId, "elyratelier.com");
    const sales = createAddress({ provider_id: providerId, email: "sales@elyratelier.com" });
    markVerified(sales.id);
    setAddressProvisioning(sales.id, { domain_id: domain.id, provisioning_status: "ready" });
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

  it("opens profiles as an account datatable", async () => {
    createDomain(providerId, "acme.com");
    const sales = createAddress({ provider_id: providerId, email: "sales@acme.com" });
    markVerified(sales.id);
    await renderApp({ initialMailbox: "inbox" }, { width: 160, height: 34 });

    await type("p");

    expect(frame()).toContain("Profiles");
    expect(frame()).toContain("Profile overview");
    expect(frame()).toContain("Provider");
    expect(frame()).toContain("Status");
    expect(frame()).toContain("Domains");
    expect(frame()).toContain("Addresses");
    expect(frame()).toContain("Keys / ownership");
    expect(frame()).toContain("sandbox");
    expect(frame()).toContain("active");
    expect(frame()).toContain("acme.com");
    expect(frame()).toContain("2 addr");
    expect(frame()).not.toContain("SANDBOX");
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

  it("opens settings as an editable page", async () => {
    seedMessage("settings background", "2026-01-01T10:00:00.000Z");
    await renderApp({ initialMailbox: "inbox" });

    expect(getSettings().autoPull).toBe(false);

    await type(",");

    expect(frame()).toContain("Settings");
    expect(frame()).toContain("Settings overview");
    expect(frame()).toContain("Enter or click edits the selected value.");
    expect(frame()).toContain("Auto-pull inbound");
    expect(frame()).toContain("Value");

    await enter();

    expect(getSettings().autoPull).toBe(true);
    expect(frame()).toContain("autoPull: on");

    await escape();

    expect(frame()).not.toContain("Enter or click edits the selected value.");
    expect(frame()).toContain("settings background");
  });

  it("opens settings page from the sidebar", async () => {
    await renderApp({ initialMailbox: "inbox" }, { width: 132, height: 32 });

    await click(5, 16);

    expect(frame()).toContain("Settings overview");
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

  it("does not restart local refresh timers when refresh updates address choices", async () => {
    const originalSetInterval = globalThis.setInterval;
    let localReloadIntervals = 0;
    globalThis.setInterval = ((...args: Parameters<typeof globalThis.setInterval>) => {
      if (args[1] === 30000) localReloadIntervals++;
      return originalSetInterval(...args);
    }) as typeof globalThis.setInterval;

    try {
      await renderApp({ initialMailbox: "inbox" });
      const afterRender = localReloadIntervals;
      expect(afterRender).toBe(1);

      const extra = createAddress({ provider_id: providerId, email: "fresh@example.com" });
      markVerified(extra.id);
      await type("g");

      expect(localReloadIntervals).toBe(afterRender);
      expect(frame()).toContain("refreshed");
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
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

  it("does not run a local refresh while a pull is in flight", async () => {
    let release!: () => void;
    autoPullWaiter = new Promise<void>((resolve) => { release = resolve; });
    autoPullResult = { pulled: 1, ok: true, configured: true };
    await renderApp({ initialMailbox: "inbox" });

    await type("G");
    seedMessage("arrived during pull", "2026-01-03T10:00:00.000Z");
    await type("g");

    expect(autoPullCalls).toBe(1);
    expect(frame()).toContain("pull running; refresh after");
    expect(frame()).not.toContain("arrived during pull");

    await withAct(async () => {
      release();
    });
    await flush();

    expect(frame()).toContain("arrived during pull");
  });

  it("skips timer refresh while a pull is in flight", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalDateNow = Date.now;
    const localRefreshCallbacks: Array<() => void> = [];
    let release!: () => void;
    autoPullWaiter = new Promise<void>((resolve) => { release = resolve; });
    globalThis.setInterval = ((...args: Parameters<typeof globalThis.setInterval>) => {
      if (args[1] === 30000) localRefreshCallbacks.push(() => { (args[0] as () => void)(); });
      return originalSetInterval(...args);
    }) as typeof globalThis.setInterval;

    try {
      await renderApp({ initialMailbox: "inbox" });
      expect(localRefreshCallbacks).toHaveLength(1);

      await type("G");
      seedMessage("timer skipped during pull", "2026-01-04T10:00:00.000Z");
      Date.now = () => originalDateNow() + 10_000;
      await withAct(async () => {
        localRefreshCallbacks[0]?.();
      });
      await flush();

      expect(frame()).not.toContain("timer skipped during pull");

      await withAct(async () => {
        release();
      });
      await flush();

      expect(frame()).toContain("timer skipped during pull");
    } finally {
      Date.now = originalDateNow;
      globalThis.setInterval = originalSetInterval;
    }
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
