import type { Command } from "commander";
import { handleError, isCliVerboseOutput, parseCliNonNegativeIntOption, parseCliPositiveIntOption } from "../utils.js";

interface AgentPromptOptions {
  provider?: "cerebras" | "groq";
  model?: string;
  steps?: string;
  maxOutputTokens?: string;
}

async function runAgentPrompt(
  promptParts: string[] | undefined,
  opts: AgentPromptOptions,
  output: (data: unknown, formatted: string) => void,
): Promise<void> {
  try {
    const prompt = (promptParts ?? []).join(" ").trim();
    if (!prompt) handleError(new Error("Agent prompt is required. Try: mailery agent \"extract links from latest unread email\""));
    const { formatMaileryAgentResult, runMaileryAgent } = await import("../../lib/mailery-agent.js");
    const result = await runMaileryAgent(prompt, {
      provider: opts.provider,
      model: opts.model,
      maxSteps: parseCliPositiveIntOption(opts.steps, 6, 12),
      maxOutputTokens: parseCliPositiveIntOption(opts.maxOutputTokens, 1200, 8000),
    });
    output(result, formatMaileryAgentResult(result));
  } catch (e) {
    handleError(e);
  }
}

function addAgentPromptOptions(command: Command): Command {
  return command
    .option("--provider <provider>", "AI provider: cerebras or groq")
    .option("--model <model>", "Model ID (default: Cerebras zai-glm-4.7, Groq qwen/qwen3-32b)")
    .option("--steps <n>", "Maximum tool-calling steps", "6")
    .option("--max-output-tokens <n>", "Maximum model output tokens", "1200");
}

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

  const agent = addAgentPromptOptions(program
    .command("agent [prompt...]")
    .description("Agent-oriented context and read-only AI email inspection helpers"))
    .action((promptParts: string[] | undefined, opts: AgentPromptOptions) => runAgentPrompt(promptParts, opts, output));

  agent
    .command("context")
    .description("Print a redacted system snapshot and recommended workflows for coding agents")
    .option("--verbose", "Print the full redacted context snapshot")
    .option("--full", "Alias for --verbose")
    .action(async (opts: { verbose?: boolean; full?: boolean }) => {
      try {
        const { formatAgentContextSummary, getAgentContext } = await import("../../lib/agent-context.js");
        const context = getAgentContext();
        const full = opts.verbose || opts.full || isCliVerboseOutput();
        output(context, full ? JSON.stringify(context, null, 2) : formatAgentContextSummary(context));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("list")
    .description("List managed email agents and their enabled/always-on state")
    .action(async () => {
      try {
        const { ensureEmailAgentSettings } = await import("../../db/email-agents.js");
        const { formatEmailAgentRuntimeStatus, formatEmailAgentSetting, getEmailAgentRuntimeStatus } = await import("../../lib/email-agents.js");
        const settings = ensureEmailAgentSettings();
        const status = getEmailAgentRuntimeStatus();
        output({ status, settings }, [formatEmailAgentRuntimeStatus(status), settings.map(formatEmailAgentSetting).join("\n\n")].join("\n\n"));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("defaults")
    .description("Show managed email agent defaults, Groq model, and credential readiness")
    .action(async () => {
      try {
        const { formatEmailAgentRuntimeStatus, getEmailAgentRuntimeStatus } = await import("../../lib/email-agents.js");
        const status = getEmailAgentRuntimeStatus();
        output(status, formatEmailAgentRuntimeStatus(status));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("enable <agent>")
    .description("Enable a managed email agent")
    .option("--always-on", "Run this agent automatically after refresh")
    .option("--provider <provider>", "AI provider: groq or cerebras")
    .option("--model <model>", "Model ID")
    .option("--apply-labels", "Apply returned labels to local email labels")
    .option("--skip-labels", "Do not apply returned labels to local email labels")
    .option("--network", "Enable DNS/RDAP/search tools")
    .option("--skip-network", "Disable DNS/RDAP/search tools")
    .action(async (agentName: string, opts: { alwaysOn?: boolean; provider?: string; model?: string; applyLabels?: boolean; skipLabels?: boolean; network?: boolean; skipNetwork?: boolean }) => {
      try {
        const { normalizeEmailAgentKey, updateEmailAgentSetting } = await import("../../db/email-agents.js");
        const { formatEmailAgentSetting } = await import("../../lib/email-agents.js");
        const agentKey = normalizeEmailAgentKey(agentName);
        const setting = updateEmailAgentSetting(agentKey, {
          enabled: true,
          always_on: opts.alwaysOn === true ? true : undefined,
          provider: normalizeProviderOption(opts.provider),
          model: opts.model,
          apply_labels: normalizeBooleanPair(opts.applyLabels, opts.skipLabels),
          use_network_tools: normalizeBooleanPair(opts.network, opts.skipNetwork),
        });
        output(setting, formatEmailAgentSetting(setting));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("disable <agent>")
    .description("Disable a managed email agent")
    .option("--keep-always-on", "Leave always-on flag unchanged")
    .action(async (agentName: string, opts: { keepAlwaysOn?: boolean }) => {
      try {
        const { normalizeEmailAgentKey, updateEmailAgentSetting } = await import("../../db/email-agents.js");
        const { formatEmailAgentSetting } = await import("../../lib/email-agents.js");
        const agentKey = normalizeEmailAgentKey(agentName);
        const setting = updateEmailAgentSetting(agentKey, {
          enabled: false,
          always_on: opts.keepAlwaysOn ? undefined : false,
        });
        output(setting, formatEmailAgentSetting(setting));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("config <agent>")
    .description("Update managed email agent provider, model, labels, and network-tool settings")
    .option("--provider <provider>", "AI provider: groq or cerebras")
    .option("--model <model>", "Model ID")
    .option("--apply-labels", "Apply returned labels locally")
    .option("--skip-labels", "Do not apply returned labels locally")
    .option("--network", "Enable DNS/RDAP/search tools")
    .option("--skip-network", "Disable DNS/RDAP/search tools")
    .option("--always-on", "Run automatically after refresh")
    .option("--manual", "Do not run automatically after refresh")
    .action(async (agentName: string, opts: { provider?: string; model?: string; applyLabels?: boolean; skipLabels?: boolean; network?: boolean; skipNetwork?: boolean; alwaysOn?: boolean; manual?: boolean }) => {
      try {
        const { normalizeEmailAgentKey, updateEmailAgentSetting } = await import("../../db/email-agents.js");
        const { formatEmailAgentSetting } = await import("../../lib/email-agents.js");
        const agentKey = normalizeEmailAgentKey(agentName);
        const setting = updateEmailAgentSetting(agentKey, {
          provider: normalizeProviderOption(opts.provider),
          model: opts.model,
          apply_labels: normalizeBooleanPair(opts.applyLabels, opts.skipLabels),
          use_network_tools: normalizeBooleanPair(opts.network, opts.skipNetwork),
          always_on: opts.manual ? false : opts.alwaysOn,
        });
        output(setting, formatEmailAgentSetting(setting));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("run [agent]")
    .description("Run managed email agents on inbound emails")
    .option("--limit <n>", "Max emails per agent", "10")
    .option("--all", "Re-run on latest emails even if this agent already has a run")
    .option("--force", "Run even when the agent is disabled")
    .option("--provider <provider>", "AI provider override: groq or cerebras")
    .option("--model <model>", "Model override")
    .option("--skip-labels", "Do not apply returned labels locally")
    .option("--skip-network", "Disable DNS/RDAP/search tools")
    .action(async (agentName: string | undefined, opts: { limit?: string; all?: boolean; force?: boolean; provider?: string; model?: string; skipLabels?: boolean; skipNetwork?: boolean }) => {
      try {
        const { EMAIL_AGENT_DEFINITIONS, normalizeEmailAgentKey } = await import("../../db/email-agents.js");
        const { formatEmailAgentRun, runEmailAgentBatch } = await import("../../lib/email-agents.js");
        const limit = parseCliPositiveIntOption(opts.limit, 10, 200);
        const agentKeys = agentName ? [normalizeEmailAgentKey(agentName)] : EMAIL_AGENT_DEFINITIONS.map((agentDef) => agentDef.key);
        const allRuns = [];
        const allErrors = [];
        for (const agentKey of agentKeys) {
          const result = await runEmailAgentBatch(agentKey, {
            limit,
            all: opts.all,
            force: opts.force,
            provider: normalizeProviderOption(opts.provider),
            model: opts.model,
            applyLabels: opts.skipLabels ? false : undefined,
            useNetworkTools: opts.skipNetwork ? false : undefined,
          });
          allRuns.push(...result.runs);
          allErrors.push(...result.errors);
        }
        const lines = allRuns.length ? allRuns.map(formatEmailAgentRun) : ["No emails needed agent processing."];
        if (allErrors.length) {
          lines.push("", `${allErrors.length} error(s):`);
          for (const error of allErrors) lines.push(`  ${error.agent_key} ${error.inbound_email_id.slice(0, 8)} ${error.error}`);
        }
        output({ runs: allRuns, errors: allErrors }, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("organize")
    .description("Run managed agents to categorize, label, and prioritize inbound emails")
    .option("--limit <n>", "Max emails to organize", "100")
    .option("--all", "Re-run on latest emails even if agents already processed them")
    .option("--agents <list>", "Comma-separated agents: categorizer,labeler,fraud")
    .option("--provider <provider>", "AI provider override: groq or cerebras")
    .option("--model <model>", "Model override")
    .option("--skip-labels", "Do not apply returned labels locally")
    .option("--skip-network", "Disable DNS/RDAP/search tools")
    .option("--apply-actions", "Apply safe mailbox state actions such as archive-suggested")
    .action(async (opts: { limit?: string; all?: boolean; agents?: string; provider?: string; model?: string; skipLabels?: boolean; skipNetwork?: boolean; applyActions?: boolean }) => {
      try {
        const { normalizeEmailAgentKey } = await import("../../db/email-agents.js");
        const { formatEmailOrganizationResult, runEmailOrganization } = await import("../../lib/email-agents.js");
        const agents = opts.agents
          ? opts.agents.split(",").map((agentName) => normalizeEmailAgentKey(agentName))
          : undefined;
        const result = await runEmailOrganization({
          limit: parseCliPositiveIntOption(opts.limit, 100, 2000),
          all: opts.all,
          agents,
          force: true,
          provider: normalizeProviderOption(opts.provider),
          model: opts.model,
          applyLabels: opts.skipLabels ? false : true,
          useNetworkTools: opts.skipNetwork ? false : undefined,
          applyActions: opts.applyActions,
        });
        output(result, formatEmailOrganizationResult(result));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("digest [period]")
    .description("Show or generate an AI inbox digest for today, yesterday, last7, or month")
    .option("--fresh", "Generate a new digest instead of showing the latest saved digest")
    .option("--local", "Generate a deterministic local digest without AI credentials")
    .option("--fallback-local", "Use a local digest if AI generation fails")
    .option("--limit <n>", "Max emails to include in the digest prompt", "160")
    .option("--provider <provider>", "AI provider override: groq or cerebras")
    .option("--model <model>", "Model override")
    .action(async (period: string | undefined, opts: { fresh?: boolean; local?: boolean; fallbackLocal?: boolean; limit?: string; provider?: string; model?: string }) => {
      try {
        const { formatEmailDigest, loadEmailDigest } = await import("../../lib/email-digest.js");
        const digest = await loadEmailDigest(period ?? "today", {
          fresh: opts.fresh || opts.local,
          offline: opts.local,
          allowLocalFallback: opts.fallbackLocal || opts.local,
          limit: parseCliPositiveIntOption(opts.limit, 160, 500),
          provider: normalizeProviderOption(opts.provider),
          model: opts.model,
        });
        output(digest, formatEmailDigest(digest));
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command("runs")
    .description("List managed email agent run records")
    .option("--agent <agent>", "Filter by agent")
    .option("--email <id>", "Filter by inbound email id")
    .option("--status <status>", "ok, error, or skipped")
    .option("--limit <n>", "Max runs", "20")
    .option("--offset <n>", "Skip N runs", "0")
    .action(async (opts: { agent?: string; email?: string; status?: string; limit?: string; offset?: string }) => {
      try {
        const { listEmailAgentRuns, normalizeEmailAgentKey } = await import("../../db/email-agents.js");
        const { formatEmailAgentRun } = await import("../../lib/email-agents.js");
        const status = normalizeRunStatus(opts.status);
        const runs = listEmailAgentRuns({
          agent_key: opts.agent ? normalizeEmailAgentKey(opts.agent) : undefined,
          inbound_email_id: opts.email,
          status,
          limit: parseCliPositiveIntOption(opts.limit, 20, 500),
          offset: parseCliNonNegativeIntOption(opts.offset),
        });
        output(runs, runs.length ? runs.map(formatEmailAgentRun).join("\n") : "No managed email agent runs found.");
      } catch (e) {
        handleError(e);
      }
    });

  addAgentPromptOptions(program
    .command("ask [prompt...]")
    .description("Ask a read-only Mailery AI agent to inspect local email with tool calls"))
    .action((promptParts: string[] | undefined, opts: AgentPromptOptions) => runAgentPrompt(promptParts, opts, output));
}

function normalizeProviderOption(value: string | undefined): "cerebras" | "groq" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "cerebras" || normalized === "groq") return normalized;
  throw new Error(`Unsupported AI provider "${value}". Use cerebras or groq.`);
}

function normalizeRunStatus(value: string | undefined): "ok" | "error" | "skipped" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "ok" || normalized === "error" || normalized === "skipped") return normalized;
  throw new Error(`Unsupported run status "${value}". Use ok, error, or skipped.`);
}

function normalizeBooleanPair(enabled: boolean | undefined, disabled: boolean | undefined): boolean | undefined {
  if (enabled && disabled) throw new Error("Choose only one of the positive/skip boolean flags.");
  if (enabled) return true;
  if (disabled) return false;
  return undefined;
}
