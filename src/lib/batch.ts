import { readFileSync } from "fs";
import { getTemplateByName, renderTemplate } from "../db/templates.js";
import { getSuppressedEmailSet, incrementSendCounts } from "../db/contacts.js";
import { getDatabase } from "../db/database.js";
import { parseCsv } from "./csv.js";
import type { Provider } from "../types/index.js";
import { createSentEmailLedger } from "./sent-ledger.js";
import { sendWithFailover } from "./send.js";

export { parseCsv } from "./csv.js";

export interface BatchResult {
  total: number;
  sent: number;
  failed: number;
  suppressed: number;
  errors: { email: string; error: string }[];
}

export async function batchSend(opts: {
  csvPath: string;
  templateName: string;
  from: string;
  provider: Provider;
  force?: boolean;
  /** @internal for testing — inject an adapter instead of resolving from provider */
  _adapter?: { sendEmail: (opts: unknown) => Promise<string | undefined> };
  /** @internal for testing — inject CSV content instead of reading from file */
  _csvContent?: string;
}): Promise<BatchResult> {
  const db = getDatabase();
  const csvContent = opts._csvContent ?? readFileSync(opts.csvPath, "utf-8");
  const rows = parseCsv(csvContent);

  const template = getTemplateByName(opts.templateName, db);
  if (!template) {
    throw new Error(`Template not found: ${opts.templateName}`);
  }

  const adapter = opts._adapter;
  const result: BatchResult = { total: rows.length, sent: 0, failed: 0, suppressed: 0, errors: [] };
  const suppressedEmailSet = opts.force ? new Set<string>() : getSuppressedEmailSet(rows.map((row) => row["email"] ?? ""), db);
  const sentEmails: string[] = [];

  for (const row of rows) {
    const email = row["email"];
    if (!email) {
      result.failed++;
      result.errors.push({ email: "(missing)", error: "Row missing 'email' column" });
      continue;
    }

    // Check suppression
    if (!opts.force && suppressedEmailSet.has(email)) {
      result.suppressed++;
      continue;
    }

    try {
      const vars = row as Record<string, string>;
      const subject = renderTemplate(template.subject_template, vars);
      const html = template.html_template ? renderTemplate(template.html_template, vars) : undefined;
      const text = template.text_template ? renderTemplate(template.text_template, vars) : undefined;

      const sendOpts = {
        from: opts.from,
        to: email,
        subject,
        html,
        text,
      };

      const sent = adapter
        ? { providerId: opts.provider.id, messageId: await adapter.sendEmail(sendOpts) }
        : await sendWithFailover(opts.provider.id, sendOpts, db);
      await createSentEmailLedger(sent.providerId, sendOpts, sent.messageId, db, "selfHostedSendAttemptId" in sent ? sent.selfHostedSendAttemptId : undefined);
      sentEmails.push(email);

      result.sent++;
    } catch (err) {
      result.failed++;
      result.errors.push({ email, error: err instanceof Error ? err.message : String(err) });
    }
  }

  incrementSendCounts(sentEmails, db);

  return result;
}
