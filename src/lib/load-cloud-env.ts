// Auto-load the staged self-hosted flip creds.
//
// The fleet client-flip stages HASNA_MAILERY_API_URL + HASNA_MAILERY_API_KEY in
// ~/.hasna/cloud/mailery.env (a 0600 file). Most machines invoke `mailery` via a
// bare bun-bin shim (no wrapper, no sourced env), so those creds never reach the
// process. This loader makes the staged file the flip signal: when present and
// cloud creds are not already set (and the mode is not explicitly `local`), it
// exports them into process.env so the CLI/MCP route to the self-hosted /v1 API.
//
// It is intentionally conservative and reversible:
//   • never overrides creds already in the environment,
//   • never overrides an explicit MAILERY_MODE/HASNA_EMAILS_MODE=local (rollback),
//   • only ever sets the two HASNA_MAILERY_API_* keys,
//   • never throws (a bad/absent file must not break startup),
//   • the secret value is only placed in process.env — never logged.
// Rollback = rename ~/.hasna/cloud/mailery.env, or run with MAILERY_MODE=local.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ALLOWED_KEYS = new Set(["HASNA_MAILERY_API_URL", "HASNA_MAILERY_API_KEY"]);

export function loadStagedCloudEnv(): void {
  try {
    if (process.env["HASNA_MAILERY_API_URL"] && process.env["HASNA_MAILERY_API_KEY"]) return;
    // Explicit local mode via ANY recognized mode signal is the reversible
    // rollback: it must suppress the staged-file autoload so the CLI/MCP stay on
    // the local SQLite store. This mirrors the local-mode detection in
    // resolveCloudConfig() (db/cloud-store.ts), which honors the STANDARD-named
    // HASNA_MAILERY_STORAGE_MODE plus the MAILERY_MODE/HASNA_EMAILS_* aliases.
    const modeCandidates = [
      process.env["HASNA_MAILERY_STORAGE_MODE"],
      process.env["MAILERY_STORAGE_MODE"],
      process.env["HASNA_MAILERY_MODE"],
      process.env["MAILERY_MODE"],
      process.env["HASNA_EMAILS_STORAGE_MODE"],
      process.env["EMAILS_STORAGE_MODE"],
      process.env["HASNA_EMAILS_MODE"],
    ];
    for (const candidate of modeCandidates) {
      if ((candidate ?? "").trim().toLowerCase() === "local") return;
    }

    const file = process.env["HASNA_MAILERY_ENV_FILE"] || join(homedir(), ".hasna", "cloud", "mailery.env");
    if (!existsSync(file)) return;

    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
      const eq = withoutExport.indexOf("=");
      if (eq <= 0) continue;
      const key = withoutExport.slice(0, eq).trim();
      if (!ALLOWED_KEYS.has(key) || process.env[key]) continue;
      let value = withoutExport.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) process.env[key] = value;
    }
  } catch {
    // Never fail startup on env autoload.
  }
}
