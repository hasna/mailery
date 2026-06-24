import { beforeEach, afterEach, describe, expect, it, mock } from "bun:test";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import {
  configureCliRuntime,
  MAX_CLI_PAGE_LIMIT,
  parseCliListPage,
  parseCliNonNegativeIntOption,
  parseCliPage,
  parseCliPositiveIntOption,
  parseDuration,
  resolveId,
} from "./utils.js";

describe("cli/utils", () => {
  beforeEach(() => {
    process.env["EMAILS_DB_PATH"] = ":memory:";
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env["EMAILS_DB_PATH"];
  });

  it("parseDuration parses common units", () => {
    expect(parseDuration("30s")).toBe(30000);
    expect(parseDuration("5m")).toBe(300000);
    expect(parseDuration("2h")).toBe(7200000);
    expect(parseDuration("bad")).toBe(300000);
  });

  it("parses bounded positive integer options", () => {
    expect(parseCliPositiveIntOption("25", 50)).toBe(25);
    expect(parseCliPositiveIntOption(undefined, 50)).toBe(50);
    expect(parseCliPositiveIntOption("bad", 50)).toBe(50);
    expect(parseCliPositiveIntOption("0", 50)).toBe(50);
    expect(parseCliPositiveIntOption("-5", 50)).toBe(50);
    expect(parseCliPositiveIntOption("5000", 50, 1000)).toBe(1000);
  });

  it("parses non-negative integer options", () => {
    expect(parseCliNonNegativeIntOption("25")).toBe(25);
    expect(parseCliNonNegativeIntOption(undefined)).toBe(0);
    expect(parseCliNonNegativeIntOption("bad", 10)).toBe(10);
    expect(parseCliNonNegativeIntOption("-5", 10)).toBe(10);
  });

  it("parses bounded pagination options", () => {
    expect(parseCliPage({ limit: "25", offset: "2" })).toEqual({ limit: 25, offset: 2 });
    expect(parseCliPage({ limit: "-1", offset: "-2" })).toEqual({ limit: 50, offset: 0 });
    expect(parseCliPage({ limit: "100000", offset: "3" })).toEqual({ limit: MAX_CLI_PAGE_LIMIT, offset: 3 });
    expect(parseCliPage({}, 20, 30)).toEqual({ limit: 20, offset: 0 });
  });

  it("uses compact list pagination only when the user did not request a limit or verbose output", () => {
    const originalArgv = process.argv;
    try {
      configureCliRuntime({ json: false, verbose: false });
      process.argv = ["bun", "mailery", "address", "list"];
      expect(parseCliListPage({})).toEqual({ limit: 20, offset: 0, compact: true });
      expect(parseCliListPage({ limit: "50" })).toEqual({ limit: 20, offset: 0, compact: true });

      process.argv = ["bun", "mailery", "address", "list", "--limit", "50"];
      expect(parseCliListPage({ limit: "50" })).toEqual({ limit: 50, offset: 0, compact: false });

      process.argv = ["bun", "mailery", "address", "list"];
      expect(parseCliListPage({ verbose: true })).toEqual({ limit: 50, offset: 0, compact: false });
      configureCliRuntime({ json: false, verbose: true });
      expect(parseCliListPage({})).toEqual({ limit: 50, offset: 0, compact: false });
    } finally {
      configureCliRuntime({ json: false, verbose: false });
      process.argv = originalArgv;
    }
  });

  it("resolveId prints table-aware guidance when lookup fails", () => {
    const provider = createProvider({ name: "qa", type: "sandbox" });

    const logs: string[] = [];
    const errorSpy = mock((msg: unknown) => {
      logs.push(String(msg));
    });
    const exitSpy = mock((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const originalError = console.error;
    const originalExit = process.exit;
    (console as unknown as { error: typeof errorSpy }).error = errorSpy;
    (process as unknown as { exit: typeof exitSpy }).exit = exitSpy;

    try {
      expect(() => resolveId("providers", provider.id.slice(0, 6))).not.toThrow();

      expect(() => resolveId("providers", "missing-prefix")).toThrow("exit:1");
      expect(logs.join("\n")).toContain("table 'providers'");
      expect(logs.join("\n")).toContain("Could not resolve ID 'missing-prefix'");
    } finally {
      (console as unknown as { error: typeof originalError }).error = originalError;
      (process as unknown as { exit: typeof originalExit }).exit = originalExit;
    }
  });
});
