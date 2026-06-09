/**
 * Resend inbound webhook — the receive half for the Resend provider. Point a
 * Resend inbound webhook at `POST /webhook/resend-inbound`. Resend inbound is
 * push (there's nothing to poll), so this is how Resend mail lands in the store.
 *
 * Optional signature verification: set config `resend_webhook_secret` (or env
 * RESEND_WEBHOOK_SECRET); when present, requests with a bad/absent signature are
 * rejected.
 */
import { isResendInboundEvent, parseResendInboundEvent, verifyResendWebhook, type ResendInboundEvent } from "../../lib/resend-inbound.js";
import { storeInboundEmail } from "../../db/inbound.js";
import { getLatestActiveProvider } from "../../db/providers.js";
import { getDatabase } from "../../db/database.js";
import { json, badRequest } from "./helpers.js";

export async function handleResendWebhook(req: Request, path: string, method: string): Promise<Response | null> {
  if (path !== "/webhook/resend-inbound" || method !== "POST") return null;

  const raw = await req.text();
  let event: ResendInboundEvent;
  try { event = JSON.parse(raw) as ResendInboundEvent; } catch { return badRequest("Invalid JSON"); }

  // Optional signature verification.
  const { loadConfig } = await import("../../lib/config.js");
  const secret = (loadConfig()["resend_webhook_secret"] as string | undefined) ?? process.env["RESEND_WEBHOOK_SECRET"];
  if (secret) {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    let valid = false;
    try { valid = verifyResendWebhook(raw, headers, secret); } catch { valid = false; }
    if (!valid) return json({ error: "Invalid signature" }, 401);
  }

  if (!isResendInboundEvent(event)) return json({ ok: true, ignored: `not an inbound event (${event.type ?? "?"})` });

  const parsed = parseResendInboundEvent(event);
  const db = getDatabase();
  const resend = getLatestActiveProvider("resend", db);

  const stored = storeInboundEmail({
    provider_id: resend?.id ?? null,
    message_id: parsed.provider_message_id || null,
    in_reply_to_email_id: null,
    from_address: parsed.from_address,
    to_addresses: parsed.to_addresses,
    cc_addresses: parsed.cc_addresses,
    subject: parsed.subject,
    text_body: parsed.text_body,
    html_body: parsed.html_body,
    attachments: [],
    attachment_paths: [],
    headers: parsed.headers,
    raw_size: (parsed.text_body ?? parsed.html_body ?? "").length,
    received_at: parsed.received_at,
  }, db);

  return json({ ok: true, id: stored.id, message_id: parsed.provider_message_id });
}
