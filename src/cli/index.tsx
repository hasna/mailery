#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setLogLevel } from "../lib/logger.js";
import { redactSecrets } from "../lib/redaction.js";

import { registerProviderCommands } from "./commands/provider.js";
import { registerDomainCommands } from "./commands/domain.js";
import { registerAddressCommands } from "./commands/address.js";
import { registerSendCommands } from "./commands/send.js";
import { registerEmailLogCommands } from "./commands/email-log.js";
import { registerSyncCommands } from "./commands/sync.js";
import { registerServeCommands } from "./commands/serve.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerTemplateCommands } from "./commands/templates.js";
import { registerContactCommands } from "./commands/contacts.js";
import { registerGroupCommands } from "./commands/groups.js";
import { registerSequenceCommands } from "./commands/sequences.js";
import { registerSandboxCommands } from "./commands/sandbox.js";
// inbound commands merged into inbox
import { registerMiscCommands } from "./commands/misc.js";
import { registerInboxCommands } from "./commands/inbox.js";
import { registerRefreshCommand } from "./commands/refresh.js";
import { registerProvisionCommands } from "./commands/provision.js";
import { registerOwnerCommands } from "./commands/owner.js";
import { registerAliasCommands } from "./commands/alias.js";
import { registerSendKeyCommands } from "./commands/sendkey.js";
import { registerReplyCommand } from "./commands/reply.js";
import { registerUiCommand } from "./commands/ui.js";
import { registerProfilesCommands } from "./commands/profiles.js";
import { registerTriageCommands } from "./commands/triage.js";
import { registerAwsCommands } from "./commands/aws.js";
import { registerCloudCommands } from "./commands/cloud.js";
import { registerStatusCommands } from "./commands/status.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { configureCliRuntime } from "./utils.js";

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("emails")
  .description("Email management CLI — send, receive, sync, and manage email via Resend, AWS SES, and Gmail")
  .version(getPackageVersion())
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
    console.log(JSON.stringify(redactSecrets(data), null, 2));
  } else {
    console.log(formatted);
  }
}

registerProviderCommands(program, output);
registerDomainCommands(program, output);
registerAddressCommands(program, output);
registerSendCommands(program, output);
registerEmailLogCommands(program, output);
registerSyncCommands(program, output);
registerServeCommands(program, output);
registerConfigCommands(program, output);
registerTemplateCommands(program, output);
registerContactCommands(program, output);
registerGroupCommands(program, output);
registerSequenceCommands(program, output);
registerSandboxCommands(program, output);

registerMiscCommands(program, output);
registerInboxCommands(program, output);
registerRefreshCommand(program, output);
registerProvisionCommands(program, output);
registerOwnerCommands(program, output);
registerAliasCommands(program, output);
registerSendKeyCommands(program, output);
registerReplyCommand(program, output);
registerUiCommand(program, output);
registerProfilesCommands(program, output);
registerTriageCommands(program, output);
registerAwsCommands(program, output);
registerCloudCommands(program, output);
registerStatusCommands(program, output);
registerDaemonCommands(program, output);
program.parse(process.argv);
