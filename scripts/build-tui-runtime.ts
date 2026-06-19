import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const require = createRequire(import.meta.url);

const nativePackages = [
  "@opentui/core-darwin-x64",
  "@opentui/core-darwin-arm64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-arm64",
  "@opentui/core-win32-x64",
  "@opentui/core-win32-arm64",
];

const alwaysExternal = [
  "@aws-sdk/*",
  "@hasna/connectors",
  "@hasna/contacts",
  "@hasna/domains",
  "@modelcontextprotocol/sdk",
  "googleapis",
  "mailparser",
  "pg",
  "resend",
  "zod",
  "chalk",
  "commander",
  "marked",
  "web-tree-sitter",
  "bun-ffi-structs",
];

function installedPackage(name: string): boolean {
  try {
    require.resolve(`${name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function nativeBundleCandidates(): string[] {
  if (process.platform === "darwin") {
    if (process.arch === "x64") return ["@opentui/core-darwin-x64"];
    if (process.arch === "arm64") return ["@opentui/core-darwin-arm64"];
  }
  if (process.platform === "linux") {
    const suffix = isLinuxMusl() ? "musl" : "";
    if (process.arch === "x64") return [`@opentui/core-linux-x64${suffix ? `-${suffix}` : ""}`];
    if (process.arch === "arm64") return [`@opentui/core-linux-arm64${suffix ? `-${suffix}` : ""}`];
  }
  if (process.platform === "win32") {
    if (process.arch === "x64") return ["@opentui/core-win32-x64"];
    if (process.arch === "arm64") return ["@opentui/core-win32-arm64"];
  }
  return [];
}

function isLinuxMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = typeof process.report?.getReport === "function" ? process.report.getReport() : undefined;
  const glibc = report?.header && "glibcVersionRuntime" in report.header
    ? report.header.glibcVersionRuntime
    : undefined;
  return !glibc;
}

const bundledNative = new Set(nativeBundleCandidates().filter(installedPackage));
const externalPackages = [
  ...alwaysExternal,
  ...nativePackages.filter((name) => !bundledNative.has(name)),
];

const result = await Bun.build({
  entrypoints: ["src/cli/tui/runtime.tsx"],
  outdir: "dist/cli",
  target: "bun",
  naming: "ui-runtime-bundle.[ext]",
  external: externalPackages,
  plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  patchBundledNativeAssetPath();
}

function patchBundledNativeAssetPath(): void {
  const bundlePath = join(process.cwd(), "dist", "cli", "ui-runtime-bundle.js");
  const source = readFileSync(bundlePath, "utf8");
  const needle = `targetLibPath = nativePackage.default;
  if (isBunfsPath(targetLibPath)) {`;
  const replacement = `targetLibPath = nativePackage.default;
  if (typeof targetLibPath === "string" && targetLibPath.startsWith("./")) {
    targetLibPath = fileURLToPath(new URL(targetLibPath, import.meta.url));
  }
  if (isBunfsPath(targetLibPath)) {`;

  if (!source.includes(needle) || source.includes(replacement)) return;
  writeFileSync(bundlePath, source.replace(needle, replacement));
}
