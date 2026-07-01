import { readStorageMode } from "../lib/remote-runtime-guard.js";
import { resolveMaileryMode } from "../lib/mode.js";

export function shouldPrintVersionEarly(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-V");
}

export const allCommandModules = [
  "provider",
  "domain",
  "address",
  "send",
  "email-log",
  "sync",
  "serve",
  "config",
  "templates",
  "contacts",
  "groups",
  "sequences",
  "sandbox",
  "misc",
  "inbox",
  "refresh",
  "provision",
  "owner",
  "alias",
  "sendkey",
  "reply",
  "forwarding",
  "ui",
  "triage",
  "aws",
  "storage",
  "status",
  "daemon",
  "browserplan",
  "cloud",
] as const;

export type CommandModule = typeof allCommandModules[number] | "project-panel";

export const knownCommandNames = new Set([
  "provider",
  "domain",
  "domains",
  "address",
  "addresses",
  "send",
  "email",
  "log",
  "search",
  "show",
  "replies",
  "conversation",
  "test",
  "export",
  "webhook",
  "pull",
  "stats",
  "monitor",
  "analytics",
  "serve",
  "mcp",
  "config",
  "template",
  "preview",
  "contact",
  "contacts",
  "group",
  "sequence",
  "sandbox",
  "schedule",
  "scheduled",
  "scheduler",
  "batch",
  "completion",
  "doctor",
  "delivery",
  "verify-email",
  "inbox",
  "code",
  "refresh",
  "provision",
  "owner",
  "alias",
  "sendkey",
  "reply",
  "forward",
  "forwarding",
  "ui",
  "links",
  "triage",
  "agent",
  "ask",
  "aws",
  "storage",
  "self-hosted",
  "self_hosted",
  "selfhosted",
  "status",
  "project-panel",
  "daemon",
  "logs",
  "browserplan",
  "cloud",
]);

export function routeRootPromptArgs(args: string[]): string[] {
  const command = requestedCommand(args);
  if (args.includes("--help") || args.includes("-h")) return args;

  const firstCommandIndex = args.findIndex((arg) => arg === command);
  const promptArgs = firstCommandIndex >= 0 ? args.slice(firstCommandIndex) : args;
  if (!command) return args;
  if (knownCommandNames.has(command)) {
    if (command !== "links" || !looksLikeLinksPrompt(promptArgs)) return args;
  }
  const promptText = promptArgs.join(" ").trim();
  const looksNatural = promptArgs.length > 1 || /\s|\?/.test(command);
  if (!promptText || !looksNatural) return args;

  const leading = firstCommandIndex > 0 ? args.slice(0, firstCommandIndex) : [];
  return [...leading, "agent", ...promptArgs];
}

function looksLikeLinksPrompt(args: string[]): boolean {
  const target = args.slice(1).find((arg) => !arg.startsWith("-"));
  if (!target) return false;
  return !/^[a-f0-9-]{4,}$/i.test(target);
}

export function requestedCommand(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--json" || arg === "-q" || arg === "--quiet" || arg === "-v" || arg === "--verbose") continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

const REMOTE_RUNTIME_STORAGE_MANAGEMENT_COMMANDS = new Set(["status", "setup", "push", "pull", "sync", "migrate", "migrate-local", "migrate-to-self-hosted"]);
const DIRECT_SELF_HOSTED_COMMANDS = new Set([
  "list",
  "search",
  "read",
  "latest",
  "links",
  "attachment",
  "mark-read",
  "archive",
  "star",
  "label",
  "delete",
  "clear",
  "sources",
  "mailboxes",
  "status",
  "sync-status",
]);

export function remoteStorageRuntimeError(args: string[]): string | null {
  void args;
  return null;
}

function isMcpConfigOnlyCommand(args: string[]): boolean {
  if (args.includes("--claude") || args.includes("--uninstall")) return args.includes("--dry-run");
  return args.includes("--codex") || args.includes("--gemini");
}

function requestedStorageSubcommand(args: string[]): string | null {
  const storageIndex = args.findIndex((arg) => arg === "storage" || arg === "self-hosted" || arg === "self_hosted" || arg === "selfhosted");
  if (storageIndex < 0) return null;
  for (const arg of args.slice(storageIndex + 1)) {
    if (arg === "--") return null;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function shouldUseSelfHostedRuntimeCacheForArgs(args: string[]): boolean {
  if (args.includes("--help") || args.includes("-h") || shouldPrintVersionEarly(args)) return false;
  const command = requestedCommand(args);
  if (!command) return false;
  if (command === "cloud") return false;
  const storageMode = readStorageMode();
  const maileryMode = resolveMaileryMode().mode;
  if (maileryMode === "cloud") return false;
  const wantsSelfHostedRuntime = storageMode === "remote" || (storageMode !== "hybrid" && maileryMode === "self_hosted");
  if (!wantsSelfHostedRuntime) return false;
  if ((command === "inbox" && DIRECT_SELF_HOSTED_COMMANDS.has(requestedSubcommandAfter(args, "inbox") ?? ""))
    || command === "links") {
    return false;
  }
  if (command === "storage" || command === "self-hosted" || command === "self_hosted" || command === "selfhosted") {
    const subcommand = requestedStorageSubcommand(args);
    if (!subcommand || REMOTE_RUNTIME_STORAGE_MANAGEMENT_COMMANDS.has(subcommand)) return false;
  }
  if (command === "mcp" && isMcpConfigOnlyCommand(args)) return false;
  return true;
}

function requestedSubcommandAfter(args: string[], commandName: string): string | null {
  const commandIndex = args.findIndex((arg) => arg === commandName);
  if (commandIndex < 0) return null;
  for (const arg of args.slice(commandIndex + 1)) {
    if (arg === "--") return null;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function commandModulesFor(args: string[]): readonly CommandModule[] {
  switch (requestedCommand(args)) {
    case "provider": return ["provider", "sync"];
    case "domain":
    case "domains": return ["domain"];
    case "address":
    case "addresses": return ["address"];
    case "send": return ["send"];
    case "email":
    case "log":
    case "search":
    case "show":
    case "replies":
    case "conversation":
    case "test":
    case "export":
    case "webhook": return ["email-log"];
    case "pull":
    case "stats":
    case "monitor":
    case "analytics": return ["sync"];
    case "serve":
    case "mcp": return ["serve"];
    case "config": return ["config"];
    case "template":
    case "preview": return ["templates"];
    case "contact":
    case "contacts": return ["contacts"];
    case "group": return ["groups"];
    case "sequence": return ["sequences"];
    case "sandbox": return ["sandbox"];
    case "schedule":
    case "scheduled":
    case "scheduler":
    case "batch":
    case "completion":
    case "doctor":
    case "delivery":
    case "verify-email": return ["misc"];
    case "inbox":
    case "code":
    case "links": return ["inbox"];
    case "refresh": return ["refresh"];
    case "provision": return ["provision"];
    case "owner": return ["owner"];
    case "alias": return ["alias"];
    case "sendkey": return ["sendkey"];
    case "reply":
    case "forward": return ["reply"];
    case "forwarding": return ["forwarding"];
    case "ui": return ["ui"];
    case "triage": return ["triage"];
    case "agent":
    case "ask": return ["status"];
    case "aws": return ["aws"];
    case "storage": return ["storage"];
    case "self-hosted":
    case "self_hosted":
    case "selfhosted": return ["storage"];
    case "status": return ["status"];
    case "project-panel": return ["status"];
    case "daemon":
    case "logs": return ["daemon"];
    case "browserplan": return ["browserplan"];
    case "cloud": return ["cloud"];
    default: return allCommandModules;
  }
}
