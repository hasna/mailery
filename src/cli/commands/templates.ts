import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { createTemplate, listTemplateSummaries, getTemplate, deleteTemplate, renderTemplate } from "../../db/templates.js";
import { truncate } from "../../lib/format.js";
import { formatListHint, handleError, isCliVerboseOutput, parseCliListPage } from "../utils.js";
import { openLocalTarget } from "../../lib/local-actions.js";

export function registerTemplateCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const templateCmd = program.command("template").description("Manage email templates");

  templateCmd
    .command("add <name>")
    .description("Add an email template")
    .requiredOption("--subject <subject>", "Subject template (supports {{var}} placeholders)")
    .option("--html <html>", "Inline HTML template")
    .option("--text <text>", "Inline text template")
    .option("--html-file <path>", "Read HTML template from file")
    .option("--text-file <path>", "Read text template from file")
    .action((name: string, opts: { subject: string; html?: string; text?: string; htmlFile?: string; textFile?: string }) => {
      try {
        let htmlTemplate = opts.html;
        let textTemplate = opts.text;

        if (opts.htmlFile) {
          htmlTemplate = readFileSync(opts.htmlFile, "utf-8");
        }
        if (opts.textFile) {
          textTemplate = readFileSync(opts.textFile, "utf-8");
        }

        const template = createTemplate({
          name,
          subject_template: opts.subject,
          html_template: htmlTemplate,
          text_template: textTemplate,
        });
        console.log(chalk.green(`✓ Template created: ${template.name} (${template.id.slice(0, 8)})`));
      } catch (e) {
        handleError(e);
      }
    });

  templateCmd
    .command("list")
    .description("List all templates")
    .option("--limit <n>", "Maximum templates to show (default 20 compact, 50 verbose/json)")
    .option("--offset <n>", "Number of templates to skip", "0")
    .option("--verbose", "Show expanded list hints")
    .action((opts: { limit?: string; offset?: string; verbose?: boolean }) => {
      try {
        const page = parseCliListPage(opts);
        const templates = listTemplateSummaries(undefined, page);
        if (templates.length === 0) {
          output([], chalk.dim("No templates configured. Use 'mailery template add' to create one."));
          return;
        }
        const tplLines: string[] = [chalk.bold("\nTemplates:")];
        for (const t of templates) {
          const hasHtml = t.has_html_template ? chalk.green("html") : chalk.dim("no-html");
          const hasText = t.has_text_template ? chalk.green("text") : chalk.dim("no-text");
          tplLines.push(`  ${chalk.cyan(t.id.slice(0, 8))}  ${t.name}  subject="${truncate(t.subject_template, 30)}"  [${hasHtml}] [${hasText}]`);
        }
        tplLines.push("");
        tplLines.push(formatListHint({
          shown: templates.length,
          limit: page.limit,
          offset: page.offset,
          noun: "template",
          detailCommand: "use mailery template show <name> for body details",
          verbose: opts.verbose || isCliVerboseOutput(),
        }));
        output(templates, tplLines.join("\n"));
      } catch (e) {
        handleError(e);
      }
    });

  templateCmd
    .command("show <name>")
    .description("Show template details")
    .action((name: string) => {
      try {
        const template = getTemplate(name);
        if (!template) handleError(new Error(`Template not found: ${name}`));
        console.log(chalk.bold(`\nTemplate: ${template!.name}`));
        console.log(`  ID:      ${template!.id}`);
        console.log(`  Subject: ${template!.subject_template}`);
        if (template!.html_template) {
          console.log(`  HTML:    ${truncate(template!.html_template, 60)}`);
        }
        if (template!.text_template) {
          console.log(`  Text:    ${truncate(template!.text_template, 60)}`);
        }
        console.log(`  Created: ${template!.created_at}`);
        console.log();
      } catch (e) {
        handleError(e);
      }
    });

  templateCmd
    .command("remove <name>")
    .description("Remove a template")
    .action((name: string) => {
      try {
        const deleted = deleteTemplate(name);
        if (!deleted) handleError(new Error(`Template not found: ${name}`));
        console.log(chalk.green(`✓ Template removed: ${name}`));
      } catch (e) {
        handleError(e);
      }
    });

  // ─── PREVIEW ─────────────────────────────────────────────────────────────────
  program.command("preview <template-name>").description("Preview a template with sample variables")
    .option("--vars <json>", "Template variables as JSON string")
    .option("--open", "Open rendered HTML in browser")
    .action((templateName: string, opts: { vars?: string; open?: boolean }) => {
      try {
        const template = getTemplate(templateName);
        if (!template) handleError(new Error(`Template not found: ${templateName}`));
        const vars: Record<string, string> = opts.vars ? JSON.parse(opts.vars) : {};

        const renderedSubject = renderTemplate(template!.subject_template, vars);
        console.log(chalk.bold("\nSubject:"));
        console.log(`  ${renderedSubject}`);

        if (template!.html_template) {
          const renderedHtml = renderTemplate(template!.html_template, vars);
          console.log(chalk.bold("\nHTML Body:"));
          console.log(renderedHtml);

          if (opts.open) {
            const tmpPath = pathJoin(tmpdir(), `mailery-preview-${templateName}.html`);
            writeFileSync(tmpPath, renderedHtml, "utf-8");
            const opened = openLocalTarget(tmpPath);
            const message = opened.ok ? `Opened preview in browser: ${tmpPath}` : `Saved preview: ${tmpPath}`;
            console.log(chalk.dim(`\n${message}`));
          }
        }

        if (template!.text_template) {
          const renderedText = renderTemplate(template!.text_template, vars);
          console.log(chalk.bold("\nText Body:"));
          console.log(renderedText);
        }

        console.log();
      } catch (e) { handleError(e); }
    });
}
