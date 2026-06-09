import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import type { Mailbox } from "../tui/data.js";

interface UiRuntime {
  runOpenTuiApp(initialMailbox?: Mailbox): Promise<void>;
}

const runtimeBundleSpecifier = "./ui-runtime-bundle.js";
const workspaceDistRuntimeSpecifier = "../../../dist/cli/ui-runtime-bundle.js";
const sourceRuntimeSpecifier = "../tui/runtime.js";

export function registerUiCommand(program: Command, _output: (data: unknown, formatted: string) => void): void {
  program
    .command("ui")
    .description("Open the email UI")
    .option("--mailbox <name>", "Start in: inbox | unread | starred | sent | archived (default: your saved setting)")
    .action(async (opts: { mailbox?: string }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(chalk.red("Email UI requires a TTY terminal."));
        console.error(chalk.dim("Use `emails inbox list`, `emails inbox read <id>`, or `emails send` non-interactively."));
        process.exitCode = 1;
        return;
      }
      const valid: Mailbox[] = ["inbox", "unread", "starred", "sent", "archived"];
      const mailbox = opts.mailbox && valid.includes(opts.mailbox as Mailbox) ? (opts.mailbox as Mailbox) : undefined;
      await runOpenTuiApp(mailbox);
    });
}

export async function runOpenTuiApp(initialMailbox?: Mailbox): Promise<void> {
  const runtime = await loadUiRuntime();
  await runtime.runOpenTuiApp(initialMailbox);
}

async function loadUiRuntime(): Promise<UiRuntime> {
  const bundledRuntime = await tryImportRuntime(runtimeBundleSpecifier);
  if (bundledRuntime) return bundledRuntime;

  const workspaceDistRuntime = await tryImportRuntime(workspaceDistRuntimeSpecifier);
  if (workspaceDistRuntime) return workspaceDistRuntime;

  return await import(sourceRuntimeSpecifier) as UiRuntime;
}

async function tryImportRuntime(specifier: string): Promise<UiRuntime | null> {
  try {
    return await import(specifier) as UiRuntime;
  } catch (error) {
    if (!isMissingRuntimeBundle(error)) throw error;
    return null;
  }
}

function isMissingRuntimeBundle(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error);
  return message.includes("ui-runtime-bundle.js") || message.includes(runtimeBundleSpecifier);
}
