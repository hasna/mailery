import type { Command } from "commander";
import { handleError, isCliVerboseOutput } from "../utils.js";

export function registerStatusCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  program
    .command("status")
    .description("Show email system health, configured sources, and next useful actions")
    .action(async () => {
      try {
        const { getEmailSystemStatusForRuntime, formatEmailSystemStatus } = await import("../../lib/agent-context.js");
        const status = await getEmailSystemStatusForRuntime();
        output(status, formatEmailSystemStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  const agent = program
    .command("agent")
    .description("Agent-oriented local context helpers");

  agent
    .command("context")
    .description("Print a redacted system snapshot and recommended workflows for coding agents")
    .option("--verbose", "Print the full redacted context snapshot")
    .option("--full", "Alias for --verbose")
    .action(async (opts: { verbose?: boolean; full?: boolean }) => {
      try {
        const { formatAgentContextSummary, getAgentContextForRuntime } = await import("../../lib/agent-context.js");
        const context = await getAgentContextForRuntime();
        const full = opts.verbose || opts.full || isCliVerboseOutput();
        output(context, full ? JSON.stringify(context, null, 2) : formatAgentContextSummary(context));
      } catch (e) {
        handleError(e);
      }
    });
}
