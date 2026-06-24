import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import {
  createSequence, getSequence, listSequences, updateSequence,
  addStep, listSteps, removeStep,
  enroll, unenroll, listEnrollments, countEnrollmentsByStatus,
  type EnrollmentStatus,
} from "../../db/sequences.js";
import { truncate } from "../../lib/format.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliListPage } from "../utils.js";

function parseEnrollmentStatus(value?: string): EnrollmentStatus | undefined {
  if (!value) return undefined;
  if (value === "active" || value === "completed" || value === "cancelled") return value;
  throw new Error("status must be active, completed, or cancelled");
}

export function registerSequenceCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const sequenceCmd = program.command("sequence").description("Manage email drip sequences");
  const sequenceStepCmd = sequenceCmd.command("step").description("Manage steps in a sequence");

  sequenceCmd
    .command("create <name>")
    .description("Create a new email sequence")
    .option("--description <text>", "Sequence description")
    .action((name: string, opts: { description?: string }) => {
      try {
        const seq = createSequence({ name, description: opts.description });
        console.log(chalk.green(`✓ Sequence created: ${seq.name} (${seq.id.slice(0, 8)})`));
      } catch (e) {
        handleError(e);
      }
    });

  sequenceCmd
    .command("list")
    .description("List all sequences")
    .option("--limit <n>", "Maximum sequences to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of sequences to skip", "0")
    .option("--verbose", "Show sequence descriptions inline")
    .action((opts: { limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const page = parseCliListPage(opts);
        const seqs = listSequences(undefined, page);
        if (seqs.length === 0) {
          output([], chalk.dim("No sequences. Use 'mailery sequence create' to add one."));
          return;
        }
        const lines: string[] = [chalk.bold("\nSequences:")];
        const verbose = opts.verbose || isCliVerboseOutput();
        for (const s of seqs) {
          const statusColor = s.status === "active" ? chalk.green(s.status) : chalk.yellow(s.status);
          const desc = verbose && s.description ? chalk.dim(` — ${truncate(s.description, 80)}`) : "";
          lines.push(`  ${chalk.cyan(s.id.slice(0, 8))}  ${s.name}  [${statusColor}]${desc}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: seqs.length,
          limit: page.limit,
          offset: page.offset,
          noun: "sequence",
          detailCommand: "use mailery sequence show <name> for steps and enrollment counts",
          verbose,
        }));
        output(seqs, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  sequenceCmd
    .command("show <name>")
    .description("Show sequence details, steps, and enrollment count")
    .action((name: string) => {
      try {
        const seq = getSequence(name);
        if (!seq) handleError(new Error(`Sequence not found: ${name}`));
        const steps = listSteps(seq!.id);
        const enrollmentCounts = countEnrollmentsByStatus(seq!.id);

        console.log(chalk.bold(`\nSequence: ${seq!.name}`));
        if (seq!.description) console.log(chalk.dim(`  ${seq!.description}`));
        console.log(`  Status: ${seq!.status}`);
        console.log(`  Enrollments: ${enrollmentCounts.active} active / ${enrollmentCounts.total} total`);
        console.log(`\n  Steps (${steps.length}):`);
        if (steps.length === 0) {
          console.log(chalk.dim("    No steps. Use 'mailery sequence step add' to add some."));
        } else {
          for (const step of steps) {
            const fromStr = step.from_address ? ` from ${step.from_address}` : "";
            console.log(`    ${step.step_number}. [${step.id.slice(0, 8)}] ${step.template_name}${fromStr} (delay: ${step.delay_hours}h)`);
            if (step.subject_override) console.log(chalk.dim(`       subject: ${step.subject_override}`));
          }
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  sequenceCmd
    .command("pause <name>")
    .description("Pause a sequence (no new sends)")
    .action((name: string) => {
      try {
        const seq = getSequence(name);
        if (!seq) handleError(new Error(`Sequence not found: ${name}`));
        updateSequence(seq!.id, { status: "paused" });
        console.log(chalk.yellow(`⏸ Sequence paused: ${name}`));
      } catch (e) {
        handleError(e);
      }
    });

  sequenceCmd
    .command("archive <name>")
    .description("Archive a sequence")
    .action((name: string) => {
      try {
        const seq = getSequence(name);
        if (!seq) handleError(new Error(`Sequence not found: ${name}`));
        updateSequence(seq!.id, { status: "archived" });
        console.log(chalk.dim(`Sequence archived: ${name}`));
      } catch (e) {
        handleError(e);
      }
    });

  sequenceCmd
    .command("enroll <name> <email>")
    .description("Enroll a contact in a sequence")
    .option("--provider <id>", "Provider ID to use for sending")
    .action((name: string, email: string, opts: { provider?: string }) => {
      try {
        const seq = getSequence(name);
        if (!seq) handleError(new Error(`Sequence not found: ${name}`));
        const enrollment = enroll({ sequence_id: seq!.id, contact_email: email, provider_id: opts.provider });
        console.log(chalk.green(`✓ Enrolled ${email} in sequence '${name}' (${enrollment.id.slice(0, 8)})`));
        if (enrollment.next_send_at) {
          console.log(chalk.dim(`  Next send: ${enrollment.next_send_at}`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  sequenceCmd
    .command("unenroll <name> <email>")
    .description("Unenroll a contact from a sequence")
    .action((name: string, email: string) => {
      try {
        const seq = getSequence(name);
        if (!seq) handleError(new Error(`Sequence not found: ${name}`));
        const removed = unenroll(seq!.id, email);
        if (!removed) handleError(new Error(`Contact ${email} not actively enrolled in '${name}'`));
        console.log(chalk.green(`✓ Unenrolled ${email} from sequence '${name}'`));
      } catch (e) {
        handleError(e);
      }
    });

  sequenceCmd
    .command("enroll-bulk <name>")
    .description("Bulk-enroll contacts from a CSV file into a sequence")
    .requiredOption("--csv <path>", "CSV file with 'email' column")
    .option("--provider <id>", "Provider ID (uses default if not specified)")
    .action(async (name: string, opts: { csv: string; provider?: string }) => {
      try {
        const seq = getSequence(name);
        if (!seq) handleError(new Error(`Sequence not found: ${name}`));
        const { parseCsv } = await import("../../lib/batch.js");
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(opts.csv, "utf-8");
        const rows = parseCsv(content);
        if (!rows.length) handleError(new Error("CSV is empty or has no rows"));
        if (!rows[0]!.email) handleError(new Error("CSV must have an 'email' column"));
        let enrolled = 0, skipped = 0, failed = 0;
        for (const row of rows) {
          const email = row.email?.trim();
          if (!email) { skipped++; continue; }
          try {
            enroll({ sequence_id: seq!.id, contact_email: email, provider_id: opts.provider });
            enrolled++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("UNIQUE constraint")) { skipped++; } else { failed++; }
          }
        }
        console.log(chalk.green(`✓ Bulk enroll complete: ${enrolled} enrolled, ${skipped} skipped, ${failed} failed`));
      } catch (e) { handleError(e); }
    });

  sequenceCmd
    .command("enrollments [name]")
    .description("List enrollments, optionally filtered by sequence")
    .option("--status <status>", "Filter by status: active|completed|cancelled")
    .option("--limit <n>", "Maximum enrollments to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of enrollments to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((name: string | undefined, opts: { status?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const seq = name ? getSequence(name) : null;
        if (name && !seq) handleError(new Error(`Sequence not found: ${name}`));
        const page = parseCliListPage(opts);
        const status = parseEnrollmentStatus(opts.status);
        const enrollments = listEnrollments({
          ...(seq ? { sequence_id: seq.id } : {}),
          ...(status ? { status } : {}),
          ...page,
        });
        if (enrollments.length === 0) {
          output([], chalk.dim("No enrollments."));
          return;
        }
        const scope = seq ? `for '${seq.name}'` : "for all sequences";
        const lines: string[] = [chalk.bold(`\nEnrollments ${scope}:`)];
        for (const e of enrollments) {
          const statusColor = e.status === "active" ? chalk.green(e.status) : chalk.dim(e.status);
          const next = e.next_send_at ? chalk.dim(` next: ${e.next_send_at}`) : "";
          const sequence = seq ? "" : `  seq:${e.sequence_id.slice(0, 8)}`;
          lines.push(`  ${chalk.cyan(e.id.slice(0, 8))}  ${e.contact_email}${sequence}  [${statusColor}]  step ${e.current_step}${next}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: enrollments.length,
          limit: page.limit,
          offset: page.offset,
          noun: "enrollment",
          detailCommand: "filter with --status or pass a sequence name",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(enrollments, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  sequenceStepCmd
    .command("add <name>")
    .description("Add a step to a sequence")
    .requiredOption("--step <number>", "Step number (1, 2, 3...)")
    .requiredOption("--delay <hours>", "Delay in hours before sending this step")
    .requiredOption("--template <name>", "Template name to use")
    .option("--from <email>", "From address override")
    .option("--subject <text>", "Subject override")
    .action((name: string, opts: { step: string; delay: string; template: string; from?: string; subject?: string }) => {
      try {
        const seq = getSequence(name);
        if (!seq) handleError(new Error(`Sequence not found: ${name}`));
        const step = addStep({
          sequence_id: seq!.id,
          step_number: parseInt(opts.step, 10),
          delay_hours: parseInt(opts.delay, 10),
          template_name: opts.template,
          from_address: opts.from,
          subject_override: opts.subject,
        });
        console.log(chalk.green(`✓ Step ${step.step_number} added (${step.id.slice(0, 8)}): ${step.template_name} in ${step.delay_hours}h`));
      } catch (e) {
        handleError(e);
      }
    });

  sequenceStepCmd
    .command("list <name>")
    .description("List steps in a sequence")
    .action((name: string) => {
      try {
        const seq = getSequence(name);
        if (!seq) handleError(new Error(`Sequence not found: ${name}`));
        const steps = listSteps(seq!.id);
        if (steps.length === 0) {
          console.log(chalk.dim("No steps."));
          return;
        }
        console.log(chalk.bold(`\nSteps for '${name}':`));
        for (const step of steps) {
          const fromStr = step.from_address ? ` from ${step.from_address}` : "";
          console.log(`  ${step.step_number}. [${chalk.cyan(step.id.slice(0, 8))}] ${step.template_name}${fromStr}  delay: ${step.delay_hours}h`);
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  sequenceStepCmd
    .command("remove <step-id>")
    .description("Remove a step by ID")
    .action((stepId: string) => {
      try {
        const removed = removeStep(stepId);
        if (!removed) handleError(new Error(`Step not found: ${stepId}`));
        console.log(chalk.green(`✓ Step removed: ${stepId}`));
      } catch (e) {
        handleError(e);
      }
    });
}
