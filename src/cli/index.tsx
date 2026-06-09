#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function shouldPrintVersionEarly(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-V");
}

type OutputFn = (data: unknown, formatted: string) => void;
type RegisterFn = (program: Command, output: OutputFn) => void;

const allCommandModules = [
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
  "ui",
  "profiles",
  "triage",
  "aws",
  "storage",
  "status",
  "daemon",
] as const;

type CommandModule = typeof allCommandModules[number];

function requestedCommand(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--json" || arg === "-q" || arg === "--quiet" || arg === "-v" || arg === "--verbose") continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function commandModulesFor(args: string[]): readonly CommandModule[] {
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
    case "inbox": return ["inbox"];
    case "refresh": return ["refresh"];
    case "provision": return ["provision"];
    case "owner": return ["owner"];
    case "alias": return ["alias"];
    case "sendkey": return ["sendkey"];
    case "reply":
    case "forward": return ["reply"];
    case "ui": return ["ui"];
    case "profiles":
    case "accounts": return ["profiles"];
    case "triage": return ["triage"];
    case "aws": return ["aws"];
    case "storage": return ["storage"];
    case "status":
    case "agent": return ["status"];
    case "daemon":
    case "logs": return ["daemon"];
    default: return allCommandModules;
  }
}

async function loadCommandModule(module: CommandModule): Promise<RegisterFn> {
  switch (module) {
    case "provider": return (await import("./commands/provider.js")).registerProviderCommands;
    case "domain": return (await import("./commands/domain.js")).registerDomainCommands;
    case "address": return (await import("./commands/address.js")).registerAddressCommands;
    case "send": return (await import("./commands/send.js")).registerSendCommands;
    case "email-log": return (await import("./commands/email-log.js")).registerEmailLogCommands;
    case "sync": return (await import("./commands/sync.js")).registerSyncCommands;
    case "serve": return (await import("./commands/serve.js")).registerServeCommands;
    case "config": return (await import("./commands/config.js")).registerConfigCommands;
    case "templates": return (await import("./commands/templates.js")).registerTemplateCommands;
    case "contacts": return (await import("./commands/contacts.js")).registerContactCommands;
    case "groups": return (await import("./commands/groups.js")).registerGroupCommands;
    case "sequences": return (await import("./commands/sequences.js")).registerSequenceCommands;
    case "sandbox": return (await import("./commands/sandbox.js")).registerSandboxCommands;
    case "misc": return (await import("./commands/misc.js")).registerMiscCommands;
    case "inbox": return (await import("./commands/inbox.js")).registerInboxCommands;
    case "refresh": return (await import("./commands/refresh.js")).registerRefreshCommand;
    case "provision": return (await import("./commands/provision.js")).registerProvisionCommands;
    case "owner": return (await import("./commands/owner.js")).registerOwnerCommands;
    case "alias": return (await import("./commands/alias.js")).registerAliasCommands;
    case "sendkey": return (await import("./commands/sendkey.js")).registerSendKeyCommands;
    case "reply": return (await import("./commands/reply.js")).registerReplyCommand;
    case "ui": return (await import("./commands/ui.js")).registerUiCommand;
    case "profiles": return (await import("./commands/profiles.js")).registerProfilesCommands;
    case "triage": return (await import("./commands/triage.js")).registerTriageCommands;
    case "aws": return (await import("./commands/aws.js")).registerAwsCommands;
    case "storage": return (await import("./commands/storage.js")).registerStorageCommands;
    case "status": return (await import("./commands/status.js")).registerStatusCommands;
    case "daemon": return (await import("./commands/daemon.js")).registerDaemonCommands;
  }
}

async function registerCommandsForArgs(program: Command, output: OutputFn, args: string[]): Promise<void> {
  const registrars = await Promise.all(commandModulesFor(args).map(loadCommandModule));
  for (const register of registrars) {
    register(program, output);
  }
}

async function main(): Promise<void> {
  const version = getPackageVersion();
  if (shouldPrintVersionEarly(process.argv.slice(2))) {
    console.log(version);
    return;
  }

  const program = new Command();
  const [{ setLogLevel }, { configureCliRuntime, emitJson }] = await Promise.all([
    import("../lib/logger.js"),
    import("./utils.js"),
  ]);

  program
    .name("emails")
    .description("Email management CLI — send, receive, sync, and manage email via Resend, AWS SES, and Gmail")
    .version(version)
    .option("--json", "Output JSON instead of formatted text")
    .option("-q, --quiet", "Suppress info output")
    .option("-v, --verbose", "Show debug info")
    .hook("preAction", () => {
      const opts = program.opts();
      configureCliRuntime({ json: !!opts.json });
      setLogLevel(!!opts.quiet, !!opts.verbose);
    });

  function output(data: unknown, formatted: string): void {
    const opts = program.opts();
    if (opts.json) {
      emitJson(data);
    } else {
      console.log(formatted);
    }
  }

  await registerCommandsForArgs(program, output, process.argv.slice(2));

  await program.parseAsync(process.argv);
}

await main();
