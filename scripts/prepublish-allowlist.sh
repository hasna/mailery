#!/usr/bin/env bash
# Positive-allowlist prepublish guard for the public packages
# (packages/cli -> @hasna/mailery, packages/sdk -> @hasna/mailery-sdk-internal).
#
# This is the INVERSE of scripts/prepublish-check.sh, which requires the private
# server's build artifacts. These packages must ship ONLY client code: the check
# enforces a positive allowlist and fails on anything else — server code, .env,
# sourcemaps, test files, key material, or secret-like content.
#
# Usage:
#   bash scripts/prepublish-allowlist.sh <package-dir> [--allow-src]
#     --allow-src   also allow src/**/*.ts (the SDK is published source-first;
#                   the CLI ships a bundled dist only and omits this flag)
#
# Wired as each package's `prepublishOnly`, so `npm publish` / `bun publish`
# cannot proceed if the tarball would leak anything it should not.
set -euo pipefail

PKG_ARG="${1:?usage: prepublish-allowlist.sh <package-dir> [--allow-src]}"
ALLOW_SRC=0
if [[ "${2:-}" == "--allow-src" ]]; then ALLOW_SRC=1; fi

PKG_DIR="$(cd "$PKG_ARG" && pwd)"
cd "$PKG_DIR"

PKG_NAME="$(bun -e 'console.log(require("./package.json").name)')"
echo "prepublish-allowlist: $PKG_NAME ($PKG_DIR) allow_src=$ALLOW_SRC"

PACK_JSON="$(mktemp)"
FILES_LIST="$(mktemp)"
trap 'rm -f "$PACK_JSON" "$FILES_LIST"' EXIT

echo "prepublish-allowlist: computing tarball contents (npm pack --dry-run)"
npm pack --dry-run --json --ignore-scripts > "$PACK_JSON"

PKG_NAME="$PKG_NAME" ALLOW_SRC="$ALLOW_SRC" bun -e '
import { readFileSync, writeFileSync } from "node:fs";
const [packPath, filesOut] = process.argv.slice(-2);
const allowSrc = process.env.ALLOW_SRC === "1";
// npm runs the prepare lifecycle script during `npm pack --dry-run
// --ignore-scripts`, so captured stdout can carry child-process output above
// the JSON document. Parse from each candidate top-level start line ({ or [
// at column 0) until one yields a valid document.
const raw = readFileSync(packPath, "utf8");
let pack;
for (let i = 0; i < raw.length; i++) {
  if ((i === 0 || raw[i - 1] === "\n") && (raw[i] === "{" || raw[i] === "[")) {
    try {
      pack = JSON.parse(raw.slice(i));
      break;
    } catch {}
  }
}
if (!pack) throw new Error("no npm pack --json document found in capture");
const first = Array.isArray(pack) ? pack[0] : pack;
const files = (first?.files ?? []).map((f) => f.path).sort();

// Positive allowlist: a packed file MUST match one of these to ship.
const allowed = [
  /^package\.json$/,
  /^README(\.[A-Za-z0-9]+)?$/,
  /^LICENSE(\.[A-Za-z0-9]+)?$/,
  /^NOTICE(\.[A-Za-z0-9]+)?$/,
  /^CHANGELOG(\.[A-Za-z0-9]+)?$/,
  /^dist\/.+/,
];
if (allowSrc) allowed.push(/^src\/(?!.*\.test\.).+\.ts$/);

// Forbidden patterns (defense-in-depth; also produce a precise error message).
const forbidden = [
  [/\.map$/, "sourcemap"],
  [/(^|\/)\.env(\.|$)/, "env file"],
  [/(^|\/)\.env[^/]*$/, "env file"],
  [/\.test\.[cm]?[jt]sx?$/, "test file"],
  [/\.(pem|key|crt|p12|pfx|keystore)$/, "key material"],
  [/(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, "private key"],
  [/(^|\/)(server|adapters|db)\//, "server code"],
  [/(^|\/)lib\//, "server lib code"],
  [/(^|\/)(deploy|drizzle|scripts|dashboard|web)\//, "server/infra directory"],
  [/(^|\/)\.secrets?(\/|$)/, "secrets directory"],
  [/(^|\/)docs\//, "server docs"],
];

const required = ["package.json"];
required.push(allowSrc ? "src/index.ts" : "dist/index.js");
if (process.env.PKG_NAME === "@hasna/mailery") {
  required.push(
    "dist/sdk.js",
    "dist/sdk.d.ts",
    "dist/client.d.ts",
    "dist/endpoints.d.ts",
    "dist/errors.d.ts",
    "dist/types.d.ts",
  );
}
const requireOneOf = [
  [/^README(\.[A-Za-z0-9]+)?$/, "README"],
  [/^LICENSE(\.[A-Za-z0-9]+)?$/, "LICENSE"],
  [/^NOTICE(\.[A-Za-z0-9]+)?$/, "NOTICE"],
];

const problems = [];

// 1. every packed file must be on the allowlist
const notAllowed = files.filter((f) => !allowed.some((re) => re.test(f)));
for (const f of notAllowed) problems.push(`not on allowlist: ${f}`);

// 2. explicit forbidden patterns (clearer message than "not on allowlist")
for (const f of files) {
  for (const [re, why] of forbidden) {
    if (re.test(f)) problems.push(`forbidden (${why}): ${f}`);
  }
}

// 3. required files present
for (const r of required) {
  if (!files.includes(r)) problems.push(`missing required file: ${r}`);
}
for (const [re, label] of requireOneOf) {
  if (!files.some((f) => re.test(f))) problems.push(`missing required file: ${label}`);
}

if (problems.length > 0) {
  console.error("prepublish-allowlist: REJECTED\n  " + problems.join("\n  "));
  console.error("\nPacked files:\n  " + files.join("\n  "));
  process.exit(1);
}
writeFileSync(filesOut, files.join("\n") + "\n");
console.log(`prepublish-allowlist: ${files.length} file(s) all pass the allowlist`);
' "$PACK_JSON" "$FILES_LIST"

echo "prepublish-allowlist: scanning packed file contents for secrets"
mapfile -t PACK_FILES < "$FILES_LIST"
# Split literals so this script never itself trips a secret scanner.
PAT_A='sk-''ant-'
PAT_B='sk-''proj-'
PAT_C='sk_''live_'
PAT_D='rk_''live_'
PAT_E='whsec_'
PAT_F='npm''_[A-Za-z0-9]{20,}'
PAT_G='gh''p_'
PAT_H='gh''o_'
PAT_I='xa''i-'
PAT_J='AK''IA[0-9A-Z]{16}'
PAT_K='-----BEGIN [A-Z ]*PRIVATE KEY-----'
SECRET_PATTERN="${PAT_A}|${PAT_B}|${PAT_C}|${PAT_D}|${PAT_E}|${PAT_F}|${PAT_G}|${PAT_H}|${PAT_I}|${PAT_J}|${PAT_K}"
HITS="$(mktemp)"
trap 'rm -f "$PACK_JSON" "$FILES_LIST" "$HITS"' EXIT
if grep -IEl "$SECRET_PATTERN" -- "${PACK_FILES[@]}" > "$HITS" 2>/dev/null; then
  echo "prepublish-allowlist: REJECTED — secret-like content in packed files:" >&2
  cat "$HITS" >&2
  exit 1
fi

echo "prepublish-allowlist: OK ($PKG_NAME)"
