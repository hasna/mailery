import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { redactSecrets } from "../lib/redaction.js";

const ID_ERROR_SUGGESTION_LIMIT = 5;
let jsonOutput = false;

export function configureCliRuntime(opts: { json?: boolean }): void {
  jsonOutput = !!opts.json;
}

function errorCode(message: string): string {
  if (/could not resolve id|not found/i.test(message)) return "not_found";
  if (/requires|missing|required/i.test(message)) return "missing_required_input";
  if (/invalid|must be/i.test(message)) return "invalid_input";
  if (/credential|oauth|auth/i.test(message)) return "auth_error";
  if (/non-interactive|--yes|cancelled/i.test(message)) return "confirmation_required";
  return "error";
}

function fixCommands(message: string): string[] {
  const lower = message.toLowerCase();
  if (lower.includes("provider")) return ["emails provider list --json", "emails provider add --help"];
  if (lower.includes("domain")) return ["emails domain list --json", "emails domain add --help"];
  if (lower.includes("address")) return ["emails address list --json", "emails address provision --help"];
  if (lower.includes("template")) return ["emails template list --json", "emails template add --help"];
  if (lower.includes("sequence")) return ["emails sequence list --json", "emails sequence --help"];
  if (lower.includes("inbound") || lower.includes("inbox")) return ["emails inbox sync-status --json", "emails doctor delivery <address> --json"];
  if (lower.includes("--yes") || lower.includes("destructive")) return ["Re-run the same command with --yes after confirming the target ID"];
  return ["emails status --json", "emails doctor --json"];
}

export function handleError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (jsonOutput) {
    console.error(JSON.stringify(redactSecrets({
      error: {
        message,
        code: errorCode(message),
        fix_commands: fixCommands(message),
      },
    }), null, 2));
  } else {
    console.error(chalk.red(message));
  }
  process.exit(1);
}

export function resolveId(table: string, partialId: string): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) {
    const suggestions = getIdSuggestions(table, partialId);
    const suggestionText = suggestions.length > 0
      ? `\nSimilar IDs in ${table}: ${suggestions.join(", ")}`
      : "";
    handleError(new Error(`Could not resolve ID '${partialId}' in table '${table}'.${suggestionText}`));
  }
  return id;
}

function getIdSuggestions(table: string, partialId: string): string[] {
  const db = getDatabase();
  try {
    const rows = db
      .query(`SELECT id FROM ${table} WHERE id LIKE ? ORDER BY created_at DESC LIMIT ?`)
      .all(`${partialId}%`, ID_ERROR_SUGGESTION_LIMIT) as Array<{ id?: string }>;
    return rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export async function confirmDestructiveAction(message: string, yes?: boolean): Promise<void> {
  if (yes) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Destructive operation blocked in non-interactive mode. Re-run with --yes to confirm.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} Type 'yes' to continue: `)).trim().toLowerCase();
    if (answer !== "yes") {
      throw new Error("Operation cancelled.");
    }
  } finally {
    rl.close();
  }
}

export function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 300000;
  const val = parseInt(match[1]!);
  switch (match[2]) {
    case "s": return val * 1000;
    case "m": return val * 60000;
    case "h": return val * 3600000;
    default: return 300000;
  }
}

export function padRight(str: string, len: number): string {
  const visibleLen = str.replace(/\[[0-9;]*m/g, "").length;
  return str + " ".repeat(Math.max(0, len - visibleLen));
}
