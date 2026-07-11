import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

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
  "@hasna/domains",
  "@modelcontextprotocol/sdk",
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
const externalPackages = [
  ...alwaysExternal,
  ...nativePackages,
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
