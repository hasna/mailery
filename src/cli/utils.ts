import chalk from "../lib/chalk-lite.js";
import { createInterface } from "node:readline/promises";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { redactSecrets } from "../lib/redaction.js";

const ID_ERROR_SUGGESTION_LIMIT = 5;
let jsonOutput = false;
let verboseOutput = false;
let jsonConsolePatched = false;
let structuredJsonEmitted = false;
const jsonStdoutLines: string[] = [];
const jsonStderrLines: string[] = [];
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

export const DEFAULT_CLI_PAGE_LIMIT = 50;
export const MAX_CLI_PAGE_LIMIT = 1000;
export const DEFAULT_COMPACT_CLI_PAGE_LIMIT = 20;

export function configureCliRuntime(opts: { json?: boolean; verbose?: boolean }): void {
  jsonOutput = !!opts.json;
  verboseOutput = !!opts.verbose;
  if (jsonOutput) process.env["EMAILS_JSON_OUTPUT"] = "1";
  if (jsonOutput && !jsonConsolePatched) {
    jsonConsolePatched = true;
    console.log = (...args: unknown[]) => {
      jsonStdoutLines.push(args.map(formatJsonConsoleArg).join(" "));
    };
    console.error = (...args: unknown[]) => {
      jsonStderrLines.push(args.map(formatJsonConsoleArg).join(" "));
    };
    process.once("exit", (code) => {
      if (!jsonOutput || structuredJsonEmitted) return;
      if (jsonStdoutLines.length === 0 && jsonStderrLines.length === 0) return;
      const stderr = jsonStderrLines.join("\n").trim();
      const payload = code && code !== 0
        ? {
            error: {
              message: stderr || `Command failed with exit code ${code}`,
              code: errorCode(stderr || "Command failed"),
              fix_commands: fixCommands(stderr || "Command failed"),
              retryable: false,
            },
            output: jsonStdoutLines,
          }
        : {
            output: jsonStdoutLines,
            errors: jsonStderrLines,
          };
      originalConsoleLog(JSON.stringify(redactSecrets(payload), null, 2));
    });
  }
}

export function isCliJsonOutput(): boolean {
  return jsonOutput;
}

export function isCliVerboseOutput(): boolean {
  return verboseOutput;
}

export function hasCliOption(name: string): boolean {
  const flag = `--${name}`;
  return process.argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function formatJsonConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(redactSecrets(arg));
  } catch {
    return String(arg);
  }
}

export function emitJson(data: unknown): void {
  structuredJsonEmitted = true;
  originalConsoleLog(JSON.stringify(redactSecrets(data), null, 2));
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
  if (lower.includes("provider")) return ["mailery provider list --json", "mailery provider add --help"];
  if (lower.includes("domain")) return ["mailery domain list --json", "mailery domain add --help"];
  if (lower.includes("address")) return ["mailery address list --json", "mailery address provision --help"];
  if (lower.includes("template")) return ["mailery template list --json", "mailery template add --help"];
  if (lower.includes("sequence")) return ["mailery sequence list --json", "mailery sequence --help"];
  if (lower.includes("inbound") || lower.includes("inbox")) return ["mailery inbox sync-status --json", "mailery doctor delivery <address> --json"];
  if (lower.includes("--yes") || lower.includes("destructive")) return ["Re-run the same command with --yes after confirming the target ID"];
  return ["mailery status --json", "mailery doctor --json"];
}

export function handleError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (jsonOutput) {
    structuredJsonEmitted = true;
    originalConsoleError(JSON.stringify(redactSecrets({
      error: {
        message,
        code: errorCode(message),
        fix_commands: fixCommands(message),
        retryable: false,
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

export function parseCliPositiveIntOption(
  value: number | string | undefined,
  fallback: number,
  max = Number.POSITIVE_INFINITY,
): number {
  const cap = Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : Number.POSITIVE_INFINITY;
  const safeFallback = Number.isFinite(fallback) && fallback >= 1
    ? Math.min(cap, Math.trunc(fallback))
    : 1;
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(value ?? String(safeFallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return safeFallback;
  return Math.min(cap, Math.trunc(parsed));
}

export function parseCliNonNegativeIntOption(value: number | string | undefined, fallback = 0): number {
  const safeFallback = Number.isFinite(fallback) && fallback >= 0 ? Math.trunc(fallback) : 0;
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(value ?? String(safeFallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return safeFallback;
  return Math.trunc(parsed);
}

export function parseCliPage(
  opts: { limit?: number | string; offset?: number | string },
  fallbackLimit = DEFAULT_CLI_PAGE_LIMIT,
  maxLimit = MAX_CLI_PAGE_LIMIT,
): { limit: number; offset: number } {
  return {
    limit: parseCliPositiveIntOption(opts.limit, fallbackLimit, maxLimit),
    offset: parseCliNonNegativeIntOption(opts.offset, 0),
  };
}

export function parseCliListPage(
  opts: { limit?: number | string; offset?: number | string; verbose?: boolean },
  fallbackLimit = DEFAULT_CLI_PAGE_LIMIT,
  maxLimit = MAX_CLI_PAGE_LIMIT,
  compactLimit = DEFAULT_COMPACT_CLI_PAGE_LIMIT,
): { limit: number; offset: number; compact: boolean } {
  const rawLimit = opts.limit === undefined ? undefined : String(opts.limit);
  const looksLikeDefaultLimit = rawLimit === undefined || rawLimit === String(fallbackLimit);
  const compact = !jsonOutput && !verboseOutput && !opts.verbose && !hasCliOption("limit") && looksLikeDefaultLimit;
  const page = parseCliPage(
    compact ? { ...opts, limit: String(Math.min(compactLimit, fallbackLimit)) } : opts,
    fallbackLimit,
    maxLimit,
  );
  return { ...page, compact };
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function truncateCliText(value: unknown, max = 96): string {
  const raw = String(value ?? "");
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`;
}

export function summarizeCliValue(value: unknown, max = 96): string {
  if (value === null) return "null";
  if (value === undefined) return "unset";
  if (typeof value === "string") return JSON.stringify(truncateCliText(value, max - 2));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).length} key${Object.keys(value as Record<string, unknown>).length === 1 ? "" : "s"}}`;
  return truncateCliText(value, max);
}

export function formatListHint(opts: {
  shown: number;
  limit: number;
  offset?: number;
  noun: string;
  pluralNoun?: string;
  detailCommand?: string;
  verbose?: boolean;
}): string {
  const offset = opts.offset ?? 0;
  const pluralNoun = opts.pluralNoun
    ?? (opts.noun === "address" ? "addresses" : opts.noun === "alias" ? "aliases" : `${opts.noun}s`);
  const noun = opts.shown === 1 ? opts.noun : pluralNoun;
  const parts: string[] = [`Showing ${opts.shown} ${noun}${offset > 0 ? ` from offset ${offset}` : ""}.`];
  const hints: string[] = [];
  if (!opts.verbose) hints.push("use --verbose for expanded rows");
  if (opts.detailCommand) hints.push(opts.detailCommand);
  if (opts.shown >= opts.limit) hints.push(`page with --offset ${offset + opts.shown} or set --limit`);
  if (hints.length > 0) parts.push(hints.join("; "));
  return chalk.dim(parts.join(" "));
}

export function padRight(str: string, len: number): string {
  const visibleLen = str.replace(/\[[0-9;]*m/g, "").length;
  return str + " ".repeat(Math.max(0, len - visibleLen));
}
