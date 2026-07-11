import { describe, expect, it } from "bun:test";
import {
  allCommandModules,
  commandModulesFor,
  knownCommandNames,
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
      [["logs"], ["daemon"]],
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
    expect(routeRootPromptArgs(["--json", "extract", "links", "from", "latest", "email"])).toEqual(["--json", "extract", "links", "from", "latest", "email"]);
    expect(routeRootPromptArgs(["links", "from", "latest", "email"])).toEqual(["links", "from", "latest", "email"]);
    expect(routeRootPromptArgs(["links", "abc123"])).toEqual(["links", "abc123"]);
    expect(routeRootPromptArgs(["--help"])).toEqual(["--help"]);
  });
});
