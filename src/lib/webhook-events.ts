/**
 * Verify Resend webhook signature (svix-style HMAC-SHA256).
 * Resend sends: svix-id, svix-timestamp, svix-signature headers.
 * The signed content is: `{svix-id}.{svix-timestamp}.{body}`
 */
export async function verifyResendSignature(
  body: string,
  headers: Record<string, string | null>,
  secret: string,
): Promise<boolean> {
  const svixId = headers["svix-id"];
  const svixTimestamp = headers["svix-timestamp"];
  const svixSignature = headers["svix-signature"];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const ts = parseInt(svixTimestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedContent));
  const computed = "v1," + Buffer.from(sig).toString("base64");

  return svixSignature.split(" ").some((signature) => signature === computed);
}

/**
 * Verify SES/SNS webhook shape. Full SNS certificate validation requires
 * fetching AWS certs; this structural guard rejects non-SNS-looking payloads.
 */
export function verifySnsStructure(body: Record<string, unknown>): boolean {
  if (body.Type && body.Type !== "Notification" && body.Type !== "SubscriptionConfirmation") return false;
  const topicArn = body.TopicArn as string | undefined;
  if (topicArn && !topicArn.startsWith("arn:aws")) return false;
  return true;
}

export interface WebhookEvent {
  provider_event_id: string;
  type: "delivered" | "bounced" | "complained" | "opened" | "clicked";
  recipient?: string;
  provider_message_id?: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
}

export function parseResendWebhook(body: any): WebhookEvent | null {
  const typeMap: Record<string, string> = {
    "email.delivered": "delivered",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.opened": "opened",
    "email.clicked": "clicked",
  };
  const eventType = typeMap[body.type];
  if (!eventType) return null;
  return {
    provider_event_id: body.data?.email_id || crypto.randomUUID(),
    type: eventType as WebhookEvent["type"],
    recipient: Array.isArray(body.data?.to) ? body.data.to[0] : body.data?.to,
    provider_message_id: body.data?.email_id,
    occurred_at: body.data?.created_at || new Date().toISOString(),
    metadata: body.data || {},
  };
}

export function parseSesWebhook(body: any): WebhookEvent | null {
  const typeMap: Record<string, string> = {
    Delivery: "delivered",
    Bounce: "bounced",
    Complaint: "complained",
  };
  const eventType = typeMap[body.notificationType];
  if (!eventType) return null;
  const messageId = body.mail?.messageId;
  const recipients = body.mail?.destination || [];
  return {
    provider_event_id: body.mail?.messageId || crypto.randomUUID(),
    type: eventType as WebhookEvent["type"],
    recipient: recipients[0],
    provider_message_id: messageId,
    occurred_at: body.mail?.timestamp || new Date().toISOString(),
    metadata: body,
  };
}
