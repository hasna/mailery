import { describe, expect, it } from "bun:test";
import {
  allCommandModules,
  commandModulesFor,
  knownCommandNames,
  remoteStorageRuntimeError,
  requestedCommand,
  routeRootPromptArgs,
  shouldUseSelfHostedRuntimeCacheForArgs,
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
      [["self-hosted", "status"], ["storage"]],
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

  it("supports runtime commands when remote storage mode is requested", () => {
    const previous = process.env["HASNA_EMAILS_STORAGE_MODE"];
    const previousDb = process.env["HASNA_EMAILS_DATABASE_URL"];
    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://runtime";
    try {
      expect(remoteStorageRuntimeError(["storage", "status"])).toBeNull();
      expect(remoteStorageRuntimeError(["--json", "storage", "pull"])).toBeNull();
      expect(remoteStorageRuntimeError(["--json", "mcp", "--claude", "--dry-run"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--codex"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--gemini"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--codex", "--gemini"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--claude", "--codex", "--dry-run"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--claude"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--claude", "--codex"])).toBeNull();
      expect(remoteStorageRuntimeError(["mcp", "--uninstall", "--gemini"])).toBeNull();
      expect(remoteStorageRuntimeError(["cloud", "status"])).toBeNull();
      expect(remoteStorageRuntimeError(["inbox", "list"])).toBeNull();
      expect(remoteStorageRuntimeError(["send", "--help"])).toBeNull();
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "list"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "attachment", "email_123"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "sources"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "mailboxes"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "sync-status"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "mark-read", "email_123"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "archive", "email_123"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "star", "email_123"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "label", "email_123", "work"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "delete", "email_123"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "clear", "--yes"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "wait", "ops@example.com"])).toBe(true);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["storage", "status"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["self-hosted", "check"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["self-hosted", "doctor"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["self-hosted", "migrate-local"])).toBe(false);
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["cloud", "status"])).toBe(false);
      delete process.env["HASNA_EMAILS_DATABASE_URL"];
      expect(shouldUseSelfHostedRuntimeCacheForArgs(["inbox", "list"])).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["HASNA_EMAILS_STORAGE_MODE"];
      else process.env["HASNA_EMAILS_STORAGE_MODE"] = previous;
      if (previousDb === undefined) delete process.env["HASNA_EMAILS_DATABASE_URL"];
      else process.env["HASNA_EMAILS_DATABASE_URL"] = previousDb;
    }
  });
});
