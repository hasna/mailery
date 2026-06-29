#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const forbiddenMarkers = [
  ["@hasna", "cloud"].join("/"),
  ["@hasna", "wallets"].join("/"),
  ["open", "cloud"].join("-"),
  ["cloud", "mcp"].join("-"),
  ["cloud", "tool"].join("-"),
  ["register", "Cloud", "Commands"].join(""),
  [".hasna", "cloud"].join("/"),
  ["HASNA", "CLOUD", ""].join("_"),
  ["HASNA", "RDS"].join("_"),
  ["cloud", "setup"].join(" "),
  ["cloud", "sync"].join(" "),
];

const root = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "open-emails-pack-scan-"));
const packDir = join(tempRoot, "pack");
const extractDir = join(tempRoot, "extract");
mkdirSync(packDir);
mkdirSync(extractDir);

const packOutput = execFileSync("npm", [
  "pack",
  "--json",
  "--ignore-scripts",
  "--dry-run=false",
  "--pack-destination",
  packDir,
], {
  cwd: root,
  env: { ...process.env, ["npm" + "_config_dry_run"]: "false" },
  encoding: "utf8",
});
const [packInfo] = JSON.parse(packOutput);
if (!packInfo?.filename) {
  throw new Error("npm pack did not return a tarball filename");
}

const tarball = join(packDir, packInfo.filename);

try {
  execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "ignore" });
  const packageDir = join(extractDir, "package");
  const findings = [];

  for (const file of packInfo.files ?? []) {
    const relativePath = file.path;
    if (!/\.(json|md|ts|tsx|js|mjs|cjs|yml|yaml|toml|lock)$/.test(relativePath)) continue;
    const path = join(packageDir, relativePath);
    if (!existsSync(path)) continue;

    const text = readFileSync(path, "utf8");
    for (const marker of forbiddenMarkers) {
      if (text.includes(marker)) {
        findings.push(`${relativePath} contains ${marker}`);
      }
    }
  }

  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`${basename(tarball)} has no retired cloud runtime references`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
