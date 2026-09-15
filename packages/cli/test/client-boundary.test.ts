import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildClient } from "../src/client.js";

describe("public client boundary", () => {
  test("constructing a client leaves the filesystem untouched", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mailery-client-boundary-"));
    const configPath = join(configDir, "config.json");
    const contents = JSON.stringify({ legacy: true });
    writeFileSync(configPath, contents);

    try {
      buildClient({
        env: { MAILERY_CONFIG_DIR: configDir, MAILERY_API_KEY: "test-api-key" },
        stdout: () => {},
        stderr: () => {},
        setExitCode: () => {},
      });

      expect(existsSync(configPath)).toBe(true);
      expect(readFileSync(configPath, "utf8")).toBe(contents);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("public CLI source has no filesystem, database, or provider client path", () => {
    const sourceDir = new URL("../src/", import.meta.url);
    const source = readdirSync(sourceDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(new URL(name, sourceDir), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/from ["']node:fs["']/);
    expect(source).not.toMatch(/from ["']postgres["']/);
    expect(source).not.toContain("@aws-sdk/");
    expect(source).not.toContain("../db/");
    expect(source).not.toContain("../adapters/");
  });
});
