import { describe, expect, it } from "bun:test";
import {
  allCommandModules,
  commandModulesFor,
  knownCommandNames,
  remoteStorageRuntimeError,
  requestedCommand,
  routeRootPromptArgs,
  shouldPrintVersionEarly,
} from "./router.js";

describe("CLI router", () => {
  it("keeps version handling narrow and early", () => {
    expect(shouldPrintVersionEarly(["--version"])).toBe(true);
    expect(shouldPrintVersionEarly(["-V"])).toBe(true);
    expect(shouldPrintVersionEarly(["--json", "--version"])).toBe(false);
  });

  it("routes high-use command aliases to narrow module sets", () => {
    const cases: Array<[string[], readonly string[]]> = [
      [["provider", "list"], ["provider", "sync"]],
      [["domains"], ["domain"]],
      [["addresses"], ["address"]],
      [["show", "abc"], ["email-log"]],
      [["conversation", "abc"], ["email-log"]],
      [["pull"], ["sync"]],
      [["mcp", "--claude"], ["serve"]],
      [["template", "list"], ["templates"]],
      [["contacts", "list"], ["contacts"]],
      [["schedule", "list"], ["misc"]],
      [["links", "abc123"], ["inbox"]],
      [["ask", "latest"], ["status"]],
      [["project-panel"], ["status"]],
      [["logs"], ["daemon"]],
      [["cloud", "status"], ["cloud"]],
    ];

    for (const [args, modules] of cases) {
      expect([...commandModulesFor(args)]).toEqual(modules);
    }
  });

  it("routes every known root command away from the all-module fallback", () => {
    for (const command of [...knownCommandNames].sort()) {
      expect([...commandModulesFor([command])], command).not.toEqual([...allCommandModules]);
    }
  });

  it("keeps unknown one-word commands as commander errors but routes natural language prompts", () => {
    expect(requestedCommand(["--json", "extract", "links"])).toBe("extract");
    expect([...commandModulesFor(["definitely-not-a-command"])]).toEqual([...allCommandModules]);
    expect(routeRootPromptArgs(["definitely-not-a-command"])).toEqual(["definitely-not-a-command"]);
    expect(routeRootPromptArgs(["--json", "extract", "links", "from", "latest", "email"])).toEqual([
      "--json",
      "agent",
      "extract",
      "links",
      "from",
      "latest",
      "email",
    ]);
    expect(routeRootPromptArgs(["links", "from", "latest", "email"])).toEqual(["agent", "links", "from", "latest", "email"]);
    expect(routeRootPromptArgs(["links", "abc123"])).toEqual(["links", "abc123"]);
    expect(routeRootPromptArgs(["--help"])).toEqual(["--help"]);
  });

  it("blocks runtime commands when remote storage mode is requested", () => {
    const previous = process.env["HASNA_EMAILS_STORAGE_MODE"];
    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";
    try {
      expect(remoteStorageRuntimeError(["storage", "status"])).toBeNull();
      expect(remoteStorageRuntimeError(["--json", "storage", "pull"])).toBeNull();
      expect(remoteStorageRuntimeError(["--json", "mcp", "--claude", "--dry-run"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--codex"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--gemini"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--codex", "--gemini"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--claude", "--codex", "--dry-run"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--claude"])).toContain("remote source-of-truth runtime");
      expect(remoteStorageRuntimeError(["mcp", "--claude", "--codex"])).toContain("remote source-of-truth runtime");
      expect(remoteStorageRuntimeError(["mcp", "--uninstall", "--gemini"])).toContain("remote source-of-truth runtime");
      expect(remoteStorageRuntimeError(["cloud", "status"])).toBeNull();
      expect(remoteStorageRuntimeError(["inbox", "list"])).toContain("remote source-of-truth runtime");
      expect(remoteStorageRuntimeError(["send", "--help"])).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["HASNA_EMAILS_STORAGE_MODE"];
      else process.env["HASNA_EMAILS_STORAGE_MODE"] = previous;
    }
  });
});
