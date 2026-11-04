// Display preferences only. Authentication and remote client configuration remain
// environment-only. Never read historical config files or the credentials file.
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MaileryError } from "@hasna/mailery-sdk-internal";
import type { Env } from "./client.js";
import type { DisplayLanguage } from "./checkout-country-copy.js";

export type PreferenceError = "preferences_read" | "preferences_invalid" | "preferences_write" | "preferences_path";

function failure(code: PreferenceError): MaileryError {
  // A fixed code is translated at the CLI boundary; never echo file contents,
  // paths, parser errors, or underlying filesystem errors into the output.
  return new MaileryError(code, { code });
}

/** Matches the installed Hasna appConfigDir convention, without a credential resolver. */
export function languagePreferencePath(env: Env): string | undefined {
  for (const key of ["HASNA_CONFIG_HOME", "HASNA_HOME", "HOME"] as const) {
    const value = env[key]?.trim();
    if (value && !isAbsolute(value)) throw failure("preferences_path");
  }
  const root = env.HASNA_CONFIG_HOME?.trim();
  if (root) return join(root, "mailery", "preferences.json");
  const home = env.HASNA_HOME?.trim() || (env.HOME?.trim() ? join(env.HOME.trim(), ".hasna") : undefined);
  return home ? join(home, "mailery", "config", "preferences.json") : undefined;
}

export async function readLanguagePreference(env: Env): Promise<DisplayLanguage | undefined> {
  const path = languagePreferencePath(env);
  if (!path) return undefined;
  let text: string;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw failure("preferences_invalid");
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof MaileryError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw failure("preferences_read");
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !["en", "ro"].includes(value.language)) throw failure("preferences_invalid");
    return value.language;
  } catch {
    throw failure("preferences_invalid");
  }
}

export async function saveLanguagePreference(env: Env, language: DisplayLanguage): Promise<void> {
  const path = languagePreferencePath(env);
  if (!path) throw failure("preferences_path");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify({ language })}\n`;
  try {
    // Validate an existing preference before replacing it. A malformed or
    // unreadable file is never silently overwritten. Atomic replacement keeps
    // the preceding preference intact until the new bytes have been fsynced.
    await readLanguagePreference(env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    if (await readFile(temporary, "utf8") !== text) throw failure("preferences_write");
    await rename(temporary, path);
    if (await readFile(path, "utf8") !== text) throw failure("preferences_write");
  } catch {
    // A failed rename may leave the new temporary preference. A post-rename
    // read failure is uncertain, so never claim that saving succeeded.
    throw failure("preferences_write");
  }
}
