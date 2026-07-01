import type { Database } from "../db/database.js";
import type { Email, SendEmailOptions } from "../types/index.js";
import { createEmail } from "../db/emails.js";
import { storeEmailContent } from "../db/email-content.js";
import { setEmailThreading, type EmailThreading } from "../db/threads.js";
import { getSelfHostedRuntimeStatus } from "./self-hosted-runtime.js";
import {
  createSelfHostedSentEmail,
  setSelfHostedEmailThreading,
  storeSelfHostedEmailContent,
} from "../db/self-hosted-sent.js";

function useSelfHostedSentLedger(): boolean {
  return getSelfHostedRuntimeStatus().enabled;
}

export async function createSentEmailLedger(
  providerId: string,
  opts: SendEmailOptions,
  providerMessageId?: string,
  db?: Database,
  selfHostedSendAttemptId?: string,
): Promise<Email> {
  if (useSelfHostedSentLedger()) {
    return createSelfHostedSentEmail(providerId, opts, providerMessageId, selfHostedSendAttemptId);
  }
  return createEmail(providerId, opts, providerMessageId, db);
}

export async function storeSentEmailContent(
  emailId: string,
  content: { html?: string; text?: string; headers?: Record<string, string> },
  db?: Database,
): Promise<void> {
  if (useSelfHostedSentLedger()) {
    await storeSelfHostedEmailContent(emailId, content);
    return;
  }
  storeEmailContent(emailId, content, db);
}

export async function setSentEmailThreading(
  emailId: string,
  threading: Partial<EmailThreading>,
  db?: Database,
): Promise<void> {
  if (useSelfHostedSentLedger()) {
    await setSelfHostedEmailThreading(emailId, threading);
    return;
  }
  setEmailThreading(emailId, threading, db);
}
