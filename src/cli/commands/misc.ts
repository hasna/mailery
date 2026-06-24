import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import type { Database } from "../../db/database.js";
import type { Provider, SendEmailOptions } from "../../types/index.js";
import type { Template } from "../../db/templates.js";
import type { ProviderAdapter } from "../../providers/interface.js";
import { listScheduledEmailSummaries, cancelScheduledEmail, getDueEmails, markSent, markFailed } from "../../db/scheduled.js";
import { getActiveProvider, getLatestActiveProviderId, getProvider } from "../../db/providers.js";
import { createEmail } from "../../db/emails.js";
import { getTemplate, renderTemplate } from "../../db/templates.js";
import { getAdapter } from "../../providers/index.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { truncate } from "../../lib/format.js";
import {
  getDueEnrollments, advanceEnrollment, getStepAtIndex,
} from "../../db/sequences.js";
import { formatListHint, handleError, isCliVerboseOutput, resolveId, parseDuration, parseCliListPage } from "../utils.js";

const SCHEDULED_EMAIL_BATCH_SIZE = 100;
const SEQUENCE_SCHEDULER_BATCH_SIZE = 100;

type SchedulerLog = (message: string) => void;

export interface SchedulerTickResult {
  scheduled: { attempted: number; sent: number; failed: number; skipped: number };
  sequences: { attempted: number; sent: number; failed: number; skipped: number };
}

interface SchedulerTickOptions {
  scheduledLimit?: number;
  sequenceLimit?: number;
  log?: SchedulerLog;
}

interface SchedulerTickCache {
  db: Database;
  providers: Map<string, Provider | null>;
  adapters: Map<string, ProviderAdapter>;
  templates: Map<string, Template | null>;
  fromAddresses: Map<string, string | null>;
  defaultProvider?: Provider | null;
}

function schedulerCache(db: Database): SchedulerTickCache {
  return {
    db,
    providers: new Map(),
    adapters: new Map(),
    templates: new Map(),
    fromAddresses: new Map(),
  };
}

function emptyBatchResult() {
  return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
}

function getCachedProvider(cache: SchedulerTickCache, providerId: string): Provider | null {
  if (!cache.providers.has(providerId)) {
    cache.providers.set(providerId, getProvider(providerId, cache.db));
  }
  return cache.providers.get(providerId) ?? null;
}

function getCachedDefaultProvider(cache: SchedulerTickCache): Provider | null {
  if (cache.defaultProvider !== undefined) return cache.defaultProvider;
  try {
    cache.defaultProvider = getActiveProvider(cache.db);
  } catch {
    cache.defaultProvider = null;
  }
  return cache.defaultProvider;
}

function getCachedAdapter(cache: SchedulerTickCache, provider: Provider): ProviderAdapter {
  const cached = cache.adapters.get(provider.id);
  if (cached) return cached;
  const adapter = getAdapter(provider);
  cache.adapters.set(provider.id, adapter);
  return adapter;
}

function getCachedTemplate(cache: SchedulerTickCache, name: string): Template | null {
  if (!cache.templates.has(name)) {
    cache.templates.set(name, getTemplate(name, cache.db));
  }
  return cache.templates.get(name) ?? null;
}

function getCachedFromAddress(cache: SchedulerTickCache, providerId: string): string | null {
  if (!cache.fromAddresses.has(providerId)) {
    const row = cache.db.query("SELECT email FROM addresses WHERE provider_id = ? LIMIT 1").get(providerId) as { email: string } | null;
    cache.fromAddresses.set(providerId, row?.email ?? null);
  }
  return cache.fromAddresses.get(providerId) ?? null;
}

async function processDueScheduledEmails(cache: SchedulerTickCache, log: SchedulerLog, limit: number) {
  const result = emptyBatchResult();
  const due = getDueEmails({ limit }, cache.db);
  result.attempted = due.length;

  for (const scheduled of due) {
    try {
      const provider = getCachedProvider(cache, scheduled.provider_id);
      if (!provider) {
        markFailed(scheduled.id, "Provider not found", cache.db);
        result.failed++;
        continue;
      }

      const sendOpts: SendEmailOptions = {
        from: scheduled.from_address,
        to: scheduled.to_addresses,
        cc: scheduled.cc_addresses.length > 0 ? scheduled.cc_addresses : undefined,
        bcc: scheduled.bcc_addresses.length > 0 ? scheduled.bcc_addresses : undefined,
        reply_to: scheduled.reply_to || undefined,
        subject: scheduled.subject,
        html: scheduled.html || undefined,
        text: scheduled.text_body || undefined,
      };
      const messageId = await getCachedAdapter(cache, provider).sendEmail(sendOpts);
      createEmail(scheduled.provider_id, sendOpts, messageId, cache.db);
      markSent(scheduled.id, cache.db);
      result.sent++;
      log(chalk.green(`✓ Sent scheduled email ${scheduled.id.slice(0, 8)} to ${scheduled.to_addresses.join(", ")}`));
    } catch (err) {
      markFailed(scheduled.id, err instanceof Error ? err.message : String(err), cache.db);
      result.failed++;
      log(chalk.red(`✗ Failed scheduled email ${scheduled.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return result;
}

async function processDueSequenceEnrollments(cache: SchedulerTickCache, log: SchedulerLog, limit: number) {
  const result = emptyBatchResult();
  const dueEnrollments = getDueEnrollments({ limit }, cache.db);
  result.attempted = dueEnrollments.length;

  for (const enrollment of dueEnrollments) {
    try {
      const stepIndex = enrollment.current_step;
      const step = getStepAtIndex(enrollment.sequence_id, stepIndex, cache.db);
      if (!step) {
        advanceEnrollment(enrollment.id, cache.db);
        result.skipped++;
        continue;
      }

      const template = getCachedTemplate(cache, step.template_name);
      if (!template) {
        log(chalk.yellow(`⚠ Template not found for sequence step: ${step.template_name}`));
        advanceEnrollment(enrollment.id, cache.db);
        result.skipped++;
        continue;
      }

      const provider = enrollment.provider_id
        ? getCachedProvider(cache, enrollment.provider_id)
        : getCachedDefaultProvider(cache);
      if (!provider) {
        log(chalk.yellow(`⚠ No provider for sequence enrollment ${enrollment.id.slice(0, 8)}`));
        result.skipped++;
        continue;
      }

      let from = step.from_address || "";
      if (!from) from = getCachedFromAddress(cache, provider.id) ?? "";
      if (!from) {
        log(chalk.yellow(`⚠ No from address for sequence step ${step.id.slice(0, 8)}`));
        advanceEnrollment(enrollment.id, cache.db);
        result.skipped++;
        continue;
      }

      const vars: Record<string, string> = { email: enrollment.contact_email };
      const sendOpts: SendEmailOptions = {
        from,
        to: [enrollment.contact_email],
        subject: renderTemplate(step.subject_override || template.subject_template, vars),
        html: template.html_template ? renderTemplate(template.html_template, vars) : undefined,
        text: template.text_template ? renderTemplate(template.text_template, vars) : undefined,
      };

      const messageId = await getCachedAdapter(cache, provider).sendEmail(sendOpts);
      createEmail(provider.id, sendOpts, messageId, cache.db);
      advanceEnrollment(enrollment.id, cache.db);
      result.sent++;
      log(chalk.green(`✓ Sent sequence step ${step.step_number} to ${enrollment.contact_email}`));
    } catch (err) {
      result.failed++;
      log(chalk.red(`✗ Failed sequence enrollment ${enrollment.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return result;
}

export async function runSchedulerTick(opts: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  const cache = schedulerCache(getDatabase());
  const log = opts.log ?? (() => {});
  return {
    scheduled: await processDueScheduledEmails(cache, log, opts.scheduledLimit ?? SCHEDULED_EMAIL_BATCH_SIZE),
    sequences: await processDueSequenceEnrollments(cache, log, opts.sequenceLimit ?? SEQUENCE_SCHEDULER_BATCH_SIZE),
  };
}

export function registerMiscCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  // ─── SCHEDULE ───────────────────────────────────────────────────────────────
  // Unified `schedule` command. Old `scheduled` kept as alias.
  const scheduleCmd = program.command("schedule").description("Manage and run the email scheduler");
  // Keep `scheduled` as alias
  const scheduledCmd = program.command("scheduled").description("Manage scheduled emails (alias: mailery schedule)");

  scheduledCmd
    .command("list")
    .description("List scheduled emails")
    .option("--status <status>", "Filter by status: pending|sent|cancelled|failed")
    .option("--limit <n>", "Maximum scheduled emails to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of scheduled emails to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { status?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const status = opts.status as "pending" | "sent" | "cancelled" | "failed" | undefined;
        const page = parseCliListPage(opts);
        const emails = listScheduledEmailSummaries({
          ...(status ? { status } : {}),
          ...page,
        });
        if (emails.length === 0) {
          output([], chalk.dim("No scheduled emails."));
          return;
        }
        const lines = [chalk.bold("\nScheduled Emails:")];
        for (const e of emails) {
          const statusColor = e.status === "pending" ? chalk.blue(e.status) :
            e.status === "sent" ? chalk.green(e.status) :
            e.status === "cancelled" ? chalk.yellow(e.status) :
            chalk.red(e.status);
          lines.push(`  ${chalk.cyan(e.id.slice(0, 8))}  ${truncate(e.subject, 40)}  -> ${truncate(e.to_addresses.join(", "), 42)}  [${statusColor}]  at ${e.scheduled_at}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: emails.length,
          limit: page.limit,
          offset: page.offset,
          noun: "scheduled email",
          detailCommand: "filter with --status or adjust --limit/--offset",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(emails, lines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  scheduledCmd
    .command("cancel <id>")
    .description("Cancel a scheduled email")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "scheduled_emails", id);
        if (!resolvedId) handleError(new Error(`Scheduled email not found: ${id}`));
        const cancelled = cancelScheduledEmail(resolvedId!, db);
        if (!cancelled) handleError(new Error(`Cannot cancel email ${id} (may already be sent or cancelled)`));
        console.log(chalk.green(`✓ Scheduled email cancelled: ${resolvedId!.slice(0, 8)}`));
      } catch (e) {
        handleError(e);
      }
    });

  // schedule list / cancel — same as scheduled but under unified command
  scheduleCmd
    .command("list")
    .description("List scheduled emails")
    .option("--status <status>", "Filter: pending|sent|cancelled|failed")
    .option("--limit <n>", "Maximum scheduled emails to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of scheduled emails to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { status?: string; limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const status = opts.status as "pending" | "sent" | "cancelled" | "failed" | undefined;
        const page = parseCliListPage(opts);
        const emails = listScheduledEmailSummaries({
          ...(status ? { status } : {}),
          ...page,
        });
        if (emails.length === 0) { output([], chalk.dim("No scheduled emails.")); return; }
        const lines = [chalk.bold("\nScheduled:")];
        for (const e of emails) {
          const sc = e.status === "pending" ? chalk.blue(e.status) : e.status === "sent" ? chalk.green(e.status) : e.status === "cancelled" ? chalk.yellow(e.status) : chalk.red(e.status);
          lines.push(`  ${chalk.cyan(e.id.slice(0,8))}  ${e.scheduled_at}  [${sc}]  ${truncate(e.subject, 40)}  -> ${truncate(e.to_addresses.join(", "), 42)}`);
        }
        lines.push("");
        lines.push(formatListHint({
          shown: emails.length,
          limit: page.limit,
          offset: page.offset,
          noun: "scheduled email",
          detailCommand: "filter with --status or adjust --limit/--offset",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(emails, lines.join("\n"));
      } catch (e) { handleError(e); }
    });

  scheduleCmd
    .command("cancel <id>")
    .description("Cancel a scheduled email")
    .action((id: string) => {
      try {
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "scheduled_emails", id);
        if (!resolvedId) handleError(new Error(`Scheduled email not found: ${id}`));
        if (!cancelScheduledEmail(resolvedId!, db)) handleError(new Error(`Cannot cancel ${id}`));
        console.log(chalk.green(`✓ Cancelled: ${resolvedId!.slice(0,8)}`));
      } catch (e) { handleError(e); }
    });

  scheduleCmd
    .command("run")
    .description("Start the scheduler daemon — sends due emails on interval")
    .option("--interval <duration>", "Poll interval (e.g. 30s, 1m)", "30s")
    .action(async (opts: { interval?: string }) => {
      try {
        const interval = parseDuration(opts.interval || "30s");
        console.log(chalk.blue(`Scheduler running. Polling every ${opts.interval || "30s"}. Press Ctrl+C to stop.`));
        while (true) {
          await runSchedulerTick({ log: console.log });
          await new Promise(r => setTimeout(r, interval));
        }
      } catch (e) { handleError(e); }
    });

  // ─── SCHEDULER (alias) ───────────────────────────────────────────────────────
  program
    .command("scheduler")
    .description("Start the email scheduler (alias: mailery schedule run)")
    .option("--interval <duration>", "Poll interval (e.g. 30s, 1m, 5m)", "30s")
    .action(async (opts: { interval?: string }) => {
      try {
        const interval = parseDuration(opts.interval || "30s");
        console.log(chalk.blue(`Scheduler started. Polling every ${opts.interval || "30s"}...`));
        while (true) {
          await runSchedulerTick({ log: console.log });
          await new Promise(r => setTimeout(r, interval));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ─── BATCH ──────────────────────────────────────────────────────────────────
  program
    .command("batch")
    .description("Batch send emails from CSV")
    .requiredOption("--csv <path>", "Path to CSV file (must have 'email' column)")
    .requiredOption("--template <name>", "Template name to use")
    .requiredOption("--from <email>", "Sender email address")
    .option("--provider <id>", "Provider ID (uses first active if not specified)")
    .option("--force", "Send even to suppressed contacts")
    .action(async (opts: { csv: string; template: string; from: string; provider?: string; force?: boolean }) => {
      try {
        const db = getDatabase();

        let providerId: string;
        if (opts.provider) {
          providerId = resolveId("providers", opts.provider);
        } else {
          const activeProviderId = getLatestActiveProviderId(undefined, db);
          if (!activeProviderId) handleError(new Error("No active providers. Add one with 'mailery provider add'"));
          providerId = activeProviderId!;
        }

        const provider = getProvider(providerId, db);
        if (!provider) handleError(new Error(`Provider not found: ${providerId}`));

        console.log(chalk.dim(`Batch sending with template '${opts.template}' from ${opts.from}...`));
        const { batchSend } = await import("../../lib/batch.js");
        const result = await batchSend({
          csvPath: opts.csv,
          templateName: opts.template,
          from: opts.from,
          provider: provider!,
          force: opts.force,
        });

        console.log(chalk.bold("\nBatch Send Results:"));
        console.log(`  Total:      ${result.total}`);
        console.log(`  Sent:       ${chalk.green(String(result.sent))}`);
        console.log(`  Failed:     ${result.failed > 0 ? chalk.red(String(result.failed)) : "0"}`);
        console.log(`  Suppressed: ${result.suppressed > 0 ? chalk.yellow(String(result.suppressed)) : "0"}`);
        if (result.errors.length > 0) {
          console.log(chalk.bold("\n  Errors:"));
          for (const err of result.errors) {
            console.log(chalk.red(`    ${err.email}: ${err.error}`));
          }
        }
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  // ─── COMPLETION ───────────────────────────────────────────────────────────────
  program
    .command("completion")
    .description("Generate shell completion script")
    .argument("<shell>", "Shell type: bash, zsh, or fish")
    .action(async (shell: string) => {
      const { generateBashCompletion, generateZshCompletion, generateFishCompletion } = await import("../../lib/completion.js");
      switch (shell) {
        case "bash":
          console.log(generateBashCompletion());
          break;
        case "zsh":
          console.log(generateZshCompletion());
          break;
        case "fish":
          console.log(generateFishCompletion());
          break;
        default:
          handleError(new Error(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`));
      }
    });

  // ─── DOCTOR ───────────────────────────────────────────────────────────────────
  const doctorCmd = program
    .command("doctor")
    .description("Run system diagnostics")
    .option("--live", "Validate provider credentials with live provider API calls")
    .action(async (opts: { live?: boolean }) => {
      try {
        const { runDiagnostics, formatDiagnostics } = await import("../../lib/doctor.js");
        const checks = await runDiagnostics(undefined, { liveProviderChecks: opts.live === true });
        output(checks, formatDiagnostics(checks));
      } catch (e) {
        handleError(e);
      }
    });

  doctorCmd
    .command("delivery <address>")
    .description("Diagnose why inbound mail may not be reaching a local address")
    .action(async (address: string) => {
      try {
        const { diagnoseInboundDeliveryLive, formatDeliveryDoctorReport } = await import("../../lib/delivery-doctor.js");
        const report = await diagnoseInboundDeliveryLive(address);
        output(report, formatDeliveryDoctorReport(report));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────
  program
    .command("verify-email <email>")
    .description("Verify an email address (format + MX records + optional SMTP probe)")
    .option("--smtp", "Also do SMTP probe (RCPT TO check, no email sent)")
    .option("--timeout <ms>", "DNS/SMTP timeout in milliseconds", "5000")
    .action(async (email: string, opts: { smtp?: boolean; timeout?: string }) => {
      try {
        const { verifyEmailAddress, formatVerifyResult } = await import("../../lib/email-verify.js");
        const result = await verifyEmailAddress(email, {
          smtpProbe: !!opts.smtp,
          timeoutMs: parseInt(opts.timeout ?? "5000", 10),
        });
        const formatted = formatVerifyResult(result);
        output(result, result.valid ? chalk.green(formatted) : chalk.red(formatted));
      } catch (e) {
        handleError(e);
      }
    });
}
