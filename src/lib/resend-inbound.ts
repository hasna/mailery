/**
 * Resend inbound email — webhook-based receiving (Resend has no mailboxes).
 *
 * Setup: add MX records for your domain (or use a managed <id>.resend.app
 * address), then register a webhook for the `email.received` event. Resend
 * stores the message server-side; the webhook payload carries metadata, so the
 * full body/attachments are fetched via the Received-emails API when needed.
 *
 * Aligns with the Resend CLI (`resend emails receiving list|get|listen`).
 *
 * This module parses the webhook event into our inbound shape and verifies the
 * Svix signature. Pure parsing → unit-testable; signature verification is
 * delegated to the caller-provided verifier (Svix) so we stay dependency-light.
 */

export interface ResendInboundEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[] | string;
    cc?: string[] | string;
    subject?: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
  };
}

export interface ParsedInbound {
  provider_message_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  text_body: string | null;
  html_body: string | null;
  headers: Record<string, string>;
  received_at: string;
}

export function isResendInboundEvent(event: ResendInboundEvent): boolean {
  return event.type === "email.received" || event.type === "inbound.email.received";
}

function toArray(v: string[] | string | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** Parse an `email.received` webhook event into our inbound row shape. */
export function parseResendInboundEvent(event: ResendInboundEvent): ParsedInbound {
  if (!isResendInboundEvent(event)) {
    throw new Error(`Not a Resend inbound event: ${event.type}`);
  }
  const d = event.data ?? {};
  return {
    provider_message_id: d.email_id ?? "",
    from_address: d.from ?? "",
    to_addresses: toArray(d.to),
    cc_addresses: toArray(d.cc),
    subject: d.subject ?? "(no subject)",
    text_body: d.text ?? null,
    html_body: d.html ?? null,
    headers: d.headers ?? {},
    received_at: event.created_at ?? new Date().toISOString(),
  };
}

/**
 * Verify a Resend (Svix) webhook signature. The actual HMAC verification is
 * provided by the caller (e.g. svix's Webhook.verify) to avoid a hard dep;
 * this wrapper enforces that a verifier is supplied in production.
 */
export function verifyResendWebhook(
  payload: string,
  headers: Record<string, string>,
  secret: string,
  verifier?: (payload: string, headers: Record<string, string>, secret: string) => boolean,
): boolean {
  if (!secret) throw new Error("Resend webhook secret is required");
  if (!verifier) throw new Error("Provide a Svix verifier (resend.webhooks.verify) for signature checking");
  return verifier(payload, headers, secret);
}
