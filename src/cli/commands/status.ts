import type { Command } from "commander";
import { handleError } from "../utils.js";

export function registerStatusCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  program
    .command("status")
    .description("Show email system health, configured sources, and next useful actions")
    .action(async () => {
      try {
        const { getEmailSystemStatus, formatEmailSystemStatus } = await import("../../lib/agent-context.js");
        const status = getEmailSystemStatus();
        output(status, formatEmailSystemStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  const agent = program.command("agent").description("Agent-oriented context and workflow helpers");
  agent
    .command("context")
    .description("Print a redacted system snapshot and recommended workflows for coding agents")
    .action(async () => {
      try {
        const { getAgentContext } = await import("../../lib/agent-context.js");
        const context = getAgentContext();
        output(context, JSON.stringify(context, null, 2));
      } catch (e) {
        handleError(e);
      }
    });
}
