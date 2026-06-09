/**
 * AI-powered email triage engine using Cerebras API.
 * Classifies, prioritizes, summarizes, and generates draft replies.
 */

import { promptJson } from "./cerebras.js";
import { saveTriage, getUntriaged } from "../db/triage.js";
import { getEmail } from "../db/emails.js";
import { getEmailContent } from "../db/email-content.js";
import { getInboundEmail, getReplyCount, listReplyPromptParts } from "../db/inbound.js";
import type { TriageLabel, TriageSentiment, TriageResult, SaveTriageInput } from "../db/triage.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClassifyResult {
  label: TriageLabel;
  confidence: number;
}

export interface TriageOptions {
  model?: string;
  skip_draft?: boolean;
  temperature?: number;
}

export interface EmailContext {
  from: string;
  to: string[];
  subject: string;
  body: string;
  thread?: string[];
}

const TRIAGE_EMAIL_BODY_CHAR_LIMIT = 8000;
const TRIAGE_REPLY_HISTORY_LIMIT = 10;
const TRIAGE_REPLY_BODY_CHAR_LIMIT = 1000;

function truncateForPrompt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} characters]`;
}

// ─── Email context builders ──────────────────────────────────────────────────

function buildSentEmailContext(emailId: string): EmailContext | null {
  const email = getEmail(emailId);
  if (!email) return null;
  const content = getEmailContent(emailId);
  const body = truncateForPrompt(content?.text_body || content?.html || "", TRIAGE_EMAIL_BODY_CHAR_LIMIT);
  const replyCount = getReplyCount(emailId);
  const replyOffset = Math.max(0, replyCount - TRIAGE_REPLY_HISTORY_LIMIT);
  const replies = listReplyPromptParts(emailId, undefined, {
    limit: TRIAGE_REPLY_HISTORY_LIMIT,
    offset: replyOffset,
  });
  const thread = replies.map(
    (r) => `[${r.from_address}]: ${truncateForPrompt(r.text_body || r.subject, TRIAGE_REPLY_BODY_CHAR_LIMIT)}`,
  );
  const omittedReplyCount = Math.max(0, replyCount - replies.length);
  if (omittedReplyCount > 0) {
    thread.unshift(`[${omittedReplyCount} older replies omitted]`);
  }
  return {
    from: email.from_address,
    to: email.to_addresses,
    subject: email.subject,
    body,
    thread: thread.length > 0 ? thread : undefined,
  };
}

function buildInboundEmailContext(inboundId: string): EmailContext | null {
  const email = getInboundEmail(inboundId);
  if (!email) return null;
  return {
    from: email.from_address,
    to: email.to_addresses,
    subject: email.subject,
    body: truncateForPrompt(email.text_body || email.html_body || "", TRIAGE_EMAIL_BODY_CHAR_LIMIT),
  };
}

function formatEmailForPrompt(ctx: EmailContext): string {
  let text = `From: ${ctx.from}\nTo: ${ctx.to.join(", ")}\nSubject: ${ctx.subject}\n\n${ctx.body}`;
  if (ctx.thread && ctx.thread.length > 0) {
    text += `\n\n--- Thread History ---\n${ctx.thread.join("\n")}`;
  }
  return text;
}

// ─── AI functions ────────────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an email classification AI. Classify the email into exactly one label.
Labels: action-required, fyi, urgent, follow-up, spam, newsletter, transactional.
Respond with JSON: {"label": "<label>", "confidence": <0.0-1.0>}`;

export async function classifyEmail(
  ctx: EmailContext,
  opts?: { model?: string; temperature?: number },
): Promise<ClassifyResult> {
  const result = await promptJson<ClassifyResult>(
    CLASSIFY_SYSTEM,
    formatEmailForPrompt(ctx),
    { model: opts?.model, temperature: opts?.temperature ?? 0.1 },
  );
  return { label: result.label, confidence: result.confidence };
}

const PRIORITY_SYSTEM = `You are an email priority scoring AI. Score the email priority from 1 (highest/most urgent) to 5 (lowest/least urgent).
Consider: sender importance, time sensitivity, action required, business impact.
Respond with JSON: {"priority": <1-5>, "reason": "<brief reason>"}`;

export async function scorePriority(
  ctx: EmailContext,
  opts?: { model?: string; temperature?: number },
): Promise<{ priority: number; reason: string }> {
  return promptJson(
    PRIORITY_SYSTEM,
    formatEmailForPrompt(ctx),
    { model: opts?.model, temperature: opts?.temperature ?? 0.1 },
  );
}

const SUMMARY_SYSTEM = `You are an email summarization AI. Provide a concise 1-2 sentence summary of the email.
Focus on: who, what, any action items. Be brief and direct.
Respond with JSON: {"summary": "<summary>"}`;

export async function summarizeEmail(
  ctx: EmailContext,
  opts?: { model?: string; temperature?: number },
): Promise<string> {
  const result = await promptJson<{ summary: string }>(
    SUMMARY_SYSTEM,
    formatEmailForPrompt(ctx),
    { model: opts?.model, temperature: opts?.temperature ?? 0.3 },
  );
  return result.summary;
}

const SENTIMENT_SYSTEM = `You are an email sentiment analysis AI. Classify the overall sentiment.
Respond with JSON: {"sentiment": "positive" | "negative" | "neutral"}`;

export async function analyzeSentiment(
  ctx: EmailContext,
  opts?: { model?: string; temperature?: number },
): Promise<TriageSentiment> {
  const result = await promptJson<{ sentiment: TriageSentiment }>(
    SENTIMENT_SYSTEM,
    formatEmailForPrompt(ctx),
    { model: opts?.model, temperature: opts?.temperature ?? 0.1 },
  );
  return result.sentiment;
}

const DRAFT_SYSTEM = `You are an email reply drafting AI. Generate a professional, contextually appropriate draft reply.
Use the thread history if available for context. Keep it concise and actionable.
Respond with JSON: {"draft": "<reply text>"}`;

export async function generateDraftReply(
  ctx: EmailContext,
  opts?: { model?: string; temperature?: number },
): Promise<string> {
  const result = await promptJson<{ draft: string }>(
    DRAFT_SYSTEM,
    formatEmailForPrompt(ctx),
    { model: opts?.model, temperature: opts?.temperature ?? 0.5 },
  );
  return result.draft;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export async function triageEmail(
  emailId: string,
  type: "sent" | "inbound" = "sent",
  opts?: TriageOptions,
): Promise<TriageResult> {
  const ctx = type === "inbound"
    ? buildInboundEmailContext(emailId)
    : buildSentEmailContext(emailId);

  if (!ctx) throw new Error(`Email not found: ${emailId} (type: ${type})`);

  const modelOpts = { model: opts?.model, temperature: opts?.temperature };

  // Run classification, priority, summary, sentiment in parallel
  const [classification, priorityResult, summary, sentiment] = await Promise.all([
    classifyEmail(ctx, modelOpts),
    scorePriority(ctx, modelOpts),
    summarizeEmail(ctx, modelOpts),
    analyzeSentiment(ctx, modelOpts),
  ]);

  // Draft reply only for actionable emails (unless skipped)
  let draft_reply: string | null = null;
  if (
    !opts?.skip_draft &&
    ["action-required", "urgent", "follow-up"].includes(classification.label)
  ) {
    draft_reply = await generateDraftReply(ctx, modelOpts);
  }

  const input: SaveTriageInput = {
    email_id: type === "sent" ? emailId : null,
    inbound_email_id: type === "inbound" ? emailId : null,
    label: classification.label,
    priority: priorityResult.priority,
    summary,
    sentiment,
    draft_reply,
    confidence: classification.confidence,
    model: opts?.model || "llama-4-scout-17b-16e-instruct",
  };

  return saveTriage(input);
}

export async function triageBatch(
  type: "sent" | "inbound" = "sent",
  limit = 10,
  opts?: TriageOptions,
): Promise<{ triaged: TriageResult[]; errors: { id: string; error: string }[] }> {
  const untriaged = getUntriaged(type, limit);
  const triaged: TriageResult[] = [];
  const errors: { id: string; error: string }[] = [];

  // Process sequentially to respect rate limits
  for (const email of untriaged) {
    try {
      const result = await triageEmail(email.id, type, opts);
      triaged.push(result);
    } catch (e) {
      errors.push({ id: email.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { triaged, errors };
}

/** Generate a draft reply for an already-triaged email */
export async function generateDraftForEmail(
  emailId: string,
  type: "sent" | "inbound" = "sent",
  opts?: { model?: string; temperature?: number },
): Promise<string> {
  const ctx = type === "inbound"
    ? buildInboundEmailContext(emailId)
    : buildSentEmailContext(emailId);
  if (!ctx) throw new Error(`Email not found: ${emailId} (type: ${type})`);
  return generateDraftReply(ctx, opts);
}
