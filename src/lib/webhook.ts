import { parseResendWebhook, parseSesWebhook, verifyResendSignature, verifySnsStructure } from "./webhook-events.js";
import type { WebhookEvent } from "./webhook-events.js";

export {
  parseResendWebhook,
  parseSesWebhook,
  verifyResendSignature,
  verifySnsStructure,
} from "./webhook-events.js";
export type { WebhookEvent } from "./webhook-events.js";

function colorEventType(type: string, chalk: typeof import("chalk").default): string {
  switch (type) {
    case "delivered": return chalk.green(type);
    case "bounced": return chalk.red(type);
    case "complained": return chalk.red(type);
    case "opened": return chalk.blue(type);
    case "clicked": return chalk.cyan(type);
    default: return type;
  }
}

export function createWebhookServer(port: number, providerId?: string, webhookSecret?: string) {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      let event: WebhookEvent | null = null;
      let bodyText: string;
      let body: any;

      try {
        bodyText = await req.text();
        body = JSON.parse(bodyText);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (url.pathname === "/webhook/resend") {
        // Verify Resend signature if secret is configured
        if (webhookSecret) {
          const headers: Record<string, string | null> = {
            "svix-id": req.headers.get("svix-id"),
            "svix-timestamp": req.headers.get("svix-timestamp"),
            "svix-signature": req.headers.get("svix-signature"),
          };
          const valid = await verifyResendSignature(bodyText, headers, webhookSecret).catch(() => false);
          if (!valid) return new Response("Invalid signature", { status: 401 });
        }
        event = parseResendWebhook(body);
      } else if (url.pathname === "/webhook/ses") {
        // Verify SNS structure
        if (!verifySnsStructure(body)) return new Response("Invalid SNS payload", { status: 400 });
        event = parseSesWebhook(body);
      } else {
        return new Response("Not found", { status: 404 });
      }

      if (!event) {
        return new Response("Unrecognized event type", { status: 200 });
      }

      // Determine provider ID — use provided one or try to find from path
      const pId = providerId || "webhook";

      try {
        const [{ getDatabase }, { upsertEvent }] = await Promise.all([
          import("../db/database.js"),
          import("../db/events.js"),
        ]);
        upsertEvent(
          {
            provider_id: pId,
            provider_event_id: event.provider_event_id,
            type: event.type,
            recipient: event.recipient || null,
            metadata: event.metadata || {},
            occurred_at: event.occurred_at,
          },
          getDatabase(),
        );
      } catch {
        // If provider_id doesn't exist in providers table, just log
      }

      const timestamp = new Date().toLocaleTimeString();
      const { default: chalk } = await import("chalk");
      console.log(
        `${chalk.gray(`[${timestamp}]`)} ${colorEventType(event.type, chalk)}  ${event.recipient || "unknown"}  ${chalk.dim(event.provider_event_id.slice(0, 12))}`,
      );

      return new Response("OK", { status: 200 });
    },
  });

  return server;
}
