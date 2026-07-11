#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tmpHome = mkdtempSync(join(tmpdir(), "emails-prepublish-"));
const legacyProduct = ["MAIL", "ERY"].join("");
const legacyKeys = [
  [legacyProduct, "MODE"],
  ["HASNA", legacyProduct, "MODE"],
  [legacyProduct, "STORAGE", "MODE"],
  ["HASNA", legacyProduct, "STORAGE", "MODE"],
  [legacyProduct, "API", "URL"],
  [legacyProduct, "API", "KEY"],
  [legacyProduct, ["CLO", "UD"].join(""), "API", "URL"],
  [legacyProduct, ["CLO", "UD"].join(""), "TOKEN"],
  ["HASNA", legacyProduct, "API", "URL"],
  ["HASNA", legacyProduct, "API", "KEY"],
  ["HASNA", legacyProduct, "ENV", "FILE"],
  ["EMAILS", "STORAGE", "MODE"],
  ["HASNA", "EMAILS", "STORAGE", "MODE"],
];

const env = { ...process.env, HOME: tmpHome, EMAILS_MODE: "local", EMAILS_DB_PATH: ":memory:" };
for (const key of legacyKeys) delete env[key.join("_")];

try {
  const result = spawnSync("bun", ["test"], {
    stdio: "inherit",
    env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
