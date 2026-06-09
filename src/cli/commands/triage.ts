import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { getTriage, listTriagedSummaries, getTriageStats, deleteTriageByEmail } from "../../db/triage.js";
import { truncate, formatDate } from "../../lib/format.js";
import { parseCliNonNegativeIntOption, parseCliPositiveIntOption, handleError } from "../utils.js";

const MAX_TRIAGE_RUN_LIMIT = 100;

const LABEL_COLORS: Record<string, (s: string) => string> = {
  "action-required": chalk.red,
  urgent: chalk.redBright,
  "follow-up": chalk.yellow,
  fyi: chalk.blue,
  newsletter: chalk.dim,
  spam: chalk.gray,
  transactional: chalk.cyan,
};

function colorLabel(label: string): string {
  const fn = LABEL_COLORS[label] || chalk.white;
  return fn(label);
}

function colorPriority(p: number): string {
  if (p <= 1) return chalk.redBright(`P${p}`);
  if (p <= 2) return chalk.red(`P${p}`);
  if (p <= 3) return chalk.yellow(`P${p}`);
  return chalk.dim(`P${p}`);
}

export function registerTriageCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const triageCmd = program.command("triage").description("AI-powered email triage (classify, prioritize, draft replies)");

  // ─── RUN ────────────────────────────────────────────────────────────────────
  triageCmd
    .command("run")
    .description("Triage untriaged emails using Cerebras AI")
    .option("--type <type>", "Email type: sent or inbound", "inbound")
    .option("--limit <n>", "Max emails to triage", "10")
    .option("--model <model>", "Cerebras model to use")
    .option("--skip-draft", "Skip generating draft replies")
    .action(async (opts: { type?: string; limit?: string; model?: string; skipDraft?: boolean }) => {
      try {
        const type = (opts.type === "sent" ? "sent" : "inbound") as "sent" | "inbound";
        const limit = parseCliPositiveIntOption(opts.limit, 10, MAX_TRIAGE_RUN_LIMIT);
        console.log(chalk.dim(`Triaging up to ${limit} ${type} emails...`));

        const { triageBatch } = await import("../../lib/triage.js");
        const { triaged, errors } = await triageBatch(type, limit, {
          model: opts.model,
          skip_draft: opts.skipDraft,
        });

        const lines: string[] = [];
        for (const t of triaged) {
          lines.push(`  ${chalk.dim(t.id.slice(0, 8))}  ${colorLabel(t.label)}  ${colorPriority(t.priority)}  ${truncate(t.summary || "", 50)}`);
        }

        if (errors.length > 0) {
          lines.push("");
          lines.push(chalk.red(`${errors.length} error(s):`));
          for (const e of errors) {
            lines.push(`  ${chalk.dim(e.id.slice(0, 8))}  ${chalk.red(e.error)}`);
          }
        }

        const header = chalk.green(`Triaged ${triaged.length} email(s)`);
        output({ triaged: triaged.length, errors: errors.length }, `${header}\n${lines.join("\n")}`);
      } catch (e) {
        handleError(e);
      }
    });

  // ─── SHOW ───────────────────────────────────────────────────────────────────
  triageCmd
    .command("show <email-id>")
    .description("Show triage result for an email")
    .option("--type <type>", "Email type: inbound or sent (default: inbound)", "inbound")
    .action((emailId: string, opts: { type?: string }) => {
      try {
        const type = (opts.type === "sent" ? "sent" : "inbound") as "sent" | "inbound";
        const triage = getTriage(emailId, type);
        if (!triage) {
          console.log(chalk.yellow("No triage result found for this email."));
          return;
        }

        const lines = [
          `${chalk.bold("Label:")}     ${colorLabel(triage.label)}`,
          `${chalk.bold("Priority:")}  ${colorPriority(triage.priority)}`,
          `${chalk.bold("Sentiment:")} ${triage.sentiment || "N/A"}`,
          `${chalk.bold("Confidence:")} ${(triage.confidence * 100).toFixed(0)}%`,
          `${chalk.bold("Model:")}     ${triage.model || "N/A"}`,
          `${chalk.bold("Triaged:")}   ${formatDate(triage.triaged_at)}`,
          "",
          `${chalk.bold("Summary:")}`,
          `  ${triage.summary || "No summary"}`,
        ];

        if (triage.draft_reply) {
          lines.push("", `${chalk.bold("Draft Reply:")}`, `  ${triage.draft_reply}`);
        }

        output(triage, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── LIST ───────────────────────────────────────────────────────────────────
  triageCmd
    .command("list")
    .description("List triaged emails")
    .option("--label <label>", "Filter by label")
    .option("--priority <n>", "Filter by priority (1-5)")
    .option("--limit <n>", "Max results", "20")
    .option("--offset <n>", "Skip first N results", "0")
    .action((opts: { label?: string; priority?: string; limit?: string; offset?: string }) => {
      try {
        const list = listTriagedSummaries({
          label: opts.label as any,
          priority: opts.priority ? parseInt(opts.priority, 10) : undefined,
          limit: parseCliPositiveIntOption(opts.limit, 20),
          offset: parseCliNonNegativeIntOption(opts.offset),
        });

        if (list.length === 0) {
          console.log(chalk.dim("No triaged emails found."));
          return;
        }

        const lines = list.map((t) => {
          const id = chalk.dim(t.id.slice(0, 8));
          const emailRef = chalk.dim((t.email_id || t.inbound_email_id || "").slice(0, 8));
          return `  ${id}  ${emailRef}  ${colorLabel(t.label)}  ${colorPriority(t.priority)}  ${truncate(t.summary || "", 40)}`;
        });

        output(list, `${chalk.bold(`Triaged emails (${list.length}):`)}\n${lines.join("\n")}`);
      } catch (e) {
        handleError(e);
      }
    });

  // ─── STATS ──────────────────────────────────────────────────────────────────
  triageCmd
    .command("stats")
    .description("Show triage statistics")
    .action(() => {
      try {
        const stats = getTriageStats();

        const lines = [
          `${chalk.bold("Total triaged:")} ${stats.total}`,
          `${chalk.bold("Avg priority:")}  ${stats.avg_priority.toFixed(1)}`,
          `${chalk.bold("Avg confidence:")} ${(stats.avg_confidence * 100).toFixed(0)}%`,
          "",
          chalk.bold("By label:"),
          ...Object.entries(stats.by_label).map(([k, v]) => `  ${colorLabel(k)}: ${v}`),
          "",
          chalk.bold("By priority:"),
          ...Object.entries(stats.by_priority).map(([k, v]) => `  ${colorPriority(Number(k))}: ${v}`),
          "",
          chalk.bold("By sentiment:"),
          ...Object.entries(stats.by_sentiment).map(([k, v]) => `  ${k}: ${v}`),
        ];

        output(stats, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── DRAFT ──────────────────────────────────────────────────────────────────
  triageCmd
    .command("draft <email-id>")
    .description("Generate a draft reply for an email")
    .option("--type <type>", "Email type: inbound or sent (default: inbound)", "inbound")
    .option("--model <model>", "Cerebras model to use")
    .action(async (emailId: string, opts: { type?: string; model?: string }) => {
      try {
        const type = (opts.type === "sent" ? "sent" : "inbound") as "sent" | "inbound";
        console.log(chalk.dim("Generating draft reply..."));
        const { generateDraftForEmail } = await import("../../lib/triage.js");
        const draft = await generateDraftForEmail(emailId, type, { model: opts.model });
        output({ draft }, `${chalk.bold("Draft Reply:")}\n\n${draft}`);
      } catch (e) {
        handleError(e);
      }
    });

  // ─── RESET ──────────────────────────────────────────────────────────────────
  triageCmd
    .command("reset <email-id>")
    .description("Delete triage result for an email and optionally re-triage")
    .option("--type <type>", "Email type: inbound or sent (default: inbound)", "inbound")
    .option("--retriage", "Re-triage after reset")
    .action(async (emailId: string, opts: { type?: string; retriage?: boolean }) => {
      try {
        const type = (opts.type === "sent" ? "sent" : "inbound") as "sent" | "inbound";
        const deleted = deleteTriageByEmail(emailId, type);
        if (!deleted) {
          console.log(chalk.yellow("No triage result found for this email."));
          return;
        }
        console.log(chalk.green("Triage result deleted."));

        if (opts.retriage) {
          console.log(chalk.dim("Re-triaging..."));
          const { triageEmail } = await import("../../lib/triage.js");
          const result = await triageEmail(emailId, type);
          output(result, `${chalk.green("Re-triaged:")} ${colorLabel(result.label)} ${colorPriority(result.priority)}`);
        }
      } catch (e) {
        handleError(e);
      }
    });
}
