#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { commandModulesFor, routeRootPromptArgs, shouldPrintVersionEarly, type CommandModule } from "./router.js";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

type OutputFn = (data: unknown, formatted: string) => void;
type RegisterFn = (program: Command, output: OutputFn) => void;

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
    case "forwarding": return (await import("./commands/forwarding.js")).registerForwardingCommands;
    case "ui": return (await import("./commands/ui.js")).registerUiCommand;
    case "aws": return (await import("./commands/aws.js")).registerAwsCommands;
    case "status": return (await import("./commands/status.js")).registerStatusCommands;
    case "daemon": return (await import("./commands/daemon.js")).registerDaemonCommands;
    case "db": return (await import("./commands/db.js")).registerDbCommands;
    case "self-hosted": return (await import("./commands/self-hosted.js")).registerSelfHostedCommands;
  }
  throw new Error(`Unknown command module: ${module}`);
}

async function registerCommandsForArgs(program: Command, output: OutputFn, args: string[]): Promise<void> {
  const registrars = await Promise.all(commandModulesFor(args).map(loadCommandModule));
  for (const register of registrars) {
    register(program, output);
  }
}

function configureJsonCommanderErrors(command: Command): void {
  command.exitOverride();
  command.configureOutput({ writeErr: () => {} });
  for (const subcommand of command.commands) configureJsonCommanderErrors(subcommand);
}

async function main(): Promise<void> {
  const version = getPackageVersion();
  const rawArgs = process.argv.slice(2);
  if (shouldPrintVersionEarly(rawArgs)) {
    console.log(version);
    return;
  }
  const cliArgs = routeRootPromptArgs(rawArgs);

  const program = new Command();
  const [{ setLogLevel }, { configureCliRuntime, emitJson, handleError }] = await Promise.all([
    import("../lib/logger.js"),
    import("./utils.js"),
  ]);
  const jsonRequested = cliArgs.includes("--json");
  const verboseRequested = cliArgs.includes("--verbose") || cliArgs.includes("-v");
  const quietRequested = cliArgs.includes("--quiet") || cliArgs.includes("-q");
  configureCliRuntime({ json: jsonRequested, verbose: verboseRequested });
  setLogLevel(quietRequested, verboseRequested);

  program
    .name("emails")
    .description("Emails email management CLI - send, receive, sync, and manage email locally or in your AWS account")
    .version(version)
    .option("--json", "Output JSON instead of formatted text")
    .option("-q, --quiet", "Suppress info output")
    .option("-v, --verbose", "Show debug info")
    .hook("preAction", async () => {
      const opts = program.opts();
      configureCliRuntime({ json: !!opts.json, verbose: !!opts.verbose });
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

  await registerCommandsForArgs(program, output, cliArgs);

  if (jsonRequested && !cliArgs.includes("--help") && !cliArgs.includes("-h")) {
    configureJsonCommanderErrors(program);
  }

  try {
    await program.parseAsync([process.argv[0] ?? "bun", process.argv[1] ?? "emails", ...cliArgs]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handleError(new Error(message));
  }
}

await main();
