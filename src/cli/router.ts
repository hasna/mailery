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
  "cloud",
  "browserplan",
] as const;

export type CommandModule = typeof allCommandModules[number];

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
  "status",
  "daemon",
  "logs",
  "cloud",
  "browserplan",
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
    case "status": return ["status"];
    case "daemon":
    case "logs": return ["daemon"];
    case "cloud": return ["cloud"];
    case "browserplan": return ["browserplan"];
    default: return allCommandModules;
  }
}
