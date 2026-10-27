import { SDK_VERSION } from "./version.js";
// MCP (Model Context Protocol) core for Mailery. Exposes agent-facing SDK
// tools via JSON-RPC 2.0 dispatch. No transport: the stdio server (packages/cli/src/mcp.ts)
// and the HTTP API endpoint (src/server/app.ts POST /api/v1/mcp) both delegate
// to this shared core.

import { MaileryError, NotYetAvailableError } from "./errors.js";
import type { MaileryClient } from "./client.js";
import type { MaileryDomainAvailability, SendAttachmentInput, SendBatchItem, SendInput } from "./types.js";

/** Mirrors SEND_BATCH_MAX on the server (src/lib/send-batch.ts). */
const SEND_BATCH_MAX = 100;

const PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP tool annotations (additive metadata; clients on protocol versions that
 * predate annotations ignore unknown fields). Hints only — never security
 * guarantees: readOnlyHint means the tool does not modify its environment,
 * destructiveHint=false means it is unlikely to be destructive when it does.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

const stringArray = { type: "array", items: { type: "string" } } as const;

/** Attachment entry shared by send_email and send_email_batch. */
const sendAttachments = {
  type: "array",
  maxItems: 10,
  items: {
    type: "object",
    properties: {
      filename: { type: "string" },
      contentType: { type: "string", description: "MIME type, e.g. application/pdf." },
      content: { type: "string", description: "Base64 file content. Mutually exclusive with attachmentId." },
      attachmentId: { type: "string", description: "Id of an attachment already stored on this tenant (e.g. one you received). Mutually exclusive with content." },
    },
  },
} as const;

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "get_terms",
    description: "Read Mailery's exact current Terms link and immutable version before signup or accepting for paid entry. Never infer permission to accept.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "accept_terms",
    description: "Show the exact Terms link/version from get_terms to the person. Record acceptance only after an explicit yes from the person or an agent they authorized. Supply the exact version, never a default.",
    inputSchema: {
      type: "object", required: ["acceptedTerms", "termsVersion"],
      properties: { acceptedTerms: { type: "boolean", const: true }, termsVersion: { type: "string" } },
    },
  },
  {
    name: "signup",
    description: "Create a Mailery account only after showing the exact Terms link/version from get_terms to the person and receiving an explicit yes from the person or an agent they authorized. No country gate applies to free signup.",
    inputSchema: {
      type: "object", required: ["email", "password"],
      properties: {
        email: { type: "string" }, password: { type: "string" }, name: { type: "string" }, inviteCode: { type: "string" },
        acceptedTerms: { type: "boolean", const: true }, termsVersion: { type: "string" },
      },
    },
  },
  {
    name: "send_email",
    description: "Send hosted email from a Mailery mailbox on an outbound-ready tenant domain. Supports attachments (base64 or the id of an attachment you already received), threaded replies (inReplyTo/references), custom X- headers, and an idempotency key.",
    inputSchema: {
      type: "object",
      required: ["mailboxId", "to"],
      properties: {
        mailboxId: { type: "string", description: "Mailbox id to send from (see create_mailbox / mailboxes list)." },
        to: { oneOf: [{ type: "string" }, stringArray], description: "Recipient address(es)." },
        cc: { oneOf: [{ type: "string" }, stringArray] },
        bcc: { oneOf: [{ type: "string" }, stringArray] },
        subject: { type: "string" },
        text: { type: "string", description: "Plain-text body." },
        html: { type: "string", description: "HTML body." },
        replyTo: { oneOf: [{ type: "string" }, stringArray] },
        inReplyTo: { type: "string", description: "Message-ID of the message you are replying to (from read_message). Threads the reply in the recipient's client." },
        references: { oneOf: [{ type: "string" }, stringArray], description: "The parent's References ancestry, oldest first. Send it with inReplyTo to keep deep threads intact." },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "Custom headers: any X- header plus a few standard filing headers (List-Unsubscribe, Importance, …). Max 10." },
        attachments: { ...sendAttachments, description: "Up to 10 attachments, 10 MiB decoded in total. Give either content (base64) or attachmentId." },
        idempotencyKey: { type: "string", description: "YOUR stable key for this send (8-200 chars). Retrying with the same key replays the original result instead of sending twice. Reuse the same key across retries of the SAME message; never reuse it for a different one." },
      },
    },
  },
  {
    name: "send_email_batch",
    description: "Send up to 100 hosted emails in one call. Each message takes the same fields as send_email, including its own idempotencyKey, and gets its own result; the batch is metered once and the units of messages that never reached the provider are returned. The per-minute send limit applies per message, so a batch bigger than your remaining window is refused rather than partly sent.",
    inputSchema: {
      type: "object",
      required: ["messages"],
      properties: {
        messages: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "The messages to send; each entry takes the same fields as send_email.",
          items: {
            type: "object",
            required: ["mailboxId", "to"],
            properties: {
              mailboxId: { type: "string" },
              to: { oneOf: [{ type: "string" }, stringArray] },
              cc: { oneOf: [{ type: "string" }, stringArray] },
              bcc: { oneOf: [{ type: "string" }, stringArray] },
              subject: { type: "string" },
              text: { type: "string" },
              html: { type: "string" },
              replyTo: { oneOf: [{ type: "string" }, stringArray] },
              inReplyTo: { type: "string" },
              references: { oneOf: [{ type: "string" }, stringArray] },
              headers: { type: "object", additionalProperties: { type: "string" } },
              attachments: sendAttachments,
              idempotencyKey: { type: "string", description: "Per-message stable key; a repeated key replays that message's original result." },
            },
          },
        },
      },
    },
  },
  {
    name: "get_message_events",
    description: "Delivery timeline for one message (newest first): sent, delivered, bounced, complained, rejected, each with the recipients and the provider reason code, plus the message's current status and the timestamp of its last event. Use this to find out what actually happened to a send.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Message id returned by send_email." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max events (default 100)." },
      },
    },
  },
  {
    name: "list_inbox",
    description: "List inbox messages (bodyless projection) with optional folder/search/pagination.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Folder/group filter, e.g. inbox, sent, spam." },
        q: { type: "string", description: "Full-text search query." },
        mailboxId: { type: "string" },
        direction: { type: "string", enum: ["inbound", "outbound"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: { type: "string", description: "Opaque continuation cursor from a previous page's nextCursor." },
      },
    },
  },
  {
    name: "read_message",
    description: "Fetch one full message (bodies + attachments) by id.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "search_domains",
    description: "Check whether a domain is available for a Mailery identity.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: { domain: { type: "string" } },
    },
  },
  {
    name: "get_domain_status",
    description: "Read domain readiness, warm-up state and remaining UTC-day recipient capacity. Connected-domain availability.check_status=not_requested means no registrar availability was queried; available=false is conservative. Pending warm-up means the domain is still ramping; zero remaining capacity or a pause blocks sends.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", required: ["domain"], properties: { domain: { type: "string" } } },
  },
  {
    name: "buy_domain",
    description: "New domain purchases are unavailable at paid opening (domain_sales_disabled). Use get_domain_status to check an existing domain. To replay an existing purchase, use the SDK purchaseDomain method with the original idempotency key and unchanged request body. Connect a domain you already own through the CLI or SDK.",
    inputSchema: {
      type: "object",
      required: ["domain", "maxPriceCents", "currency", "idempotencyKey"],
      properties: {
        domain: { type: "string" },
        maxPriceCents: { type: "integer", minimum: 1, description: "Maximum all-in price authorized in minor units." },
        currency: { type: "string", pattern: "^[A-Za-z]{3}$", description: "Authorized three-letter quote currency." },
        idempotencyKey: { type: "string", description: "Caller-generated key for this purchase attempt." },
      },
    },
  },
  {
    name: "create_mailbox",
    description: "Create (or upsert) a mailbox. Omit provider for the normal managed identity path.",
    inputSchema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string" },
        name: { type: "string" },
        provider: { type: "string", enum: ["hosted", "manual", "sandbox"], description: "Advanced override; normally omitted." },
      },
    },
  },
  {
    name: "list_mailboxes",
    description: "List every mailbox on the tenant: id, email, provider, and status. Call this first to obtain the mailboxId required by send_email.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_message",
    description: "Update one message's flags (read/star/archive/spam/trash/important) by id and return the updated message. Bodies are never modified.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        isRead: { type: "boolean", description: "Mark as read (true) or unread (false)." },
        isStarred: { type: "boolean" },
        isArchived: { type: "boolean" },
        isImportant: { type: "boolean" },
        isSpam: { type: "boolean" },
        isTrash: { type: "boolean" },
      },
    },
  },
  {
    name: "list_changes",
    description: "Delta feed of created-or-changed messages since a watermark — poll this instead of re-listing the inbox. Returns changed messages plus nextCursor (pass back as cursor to continue paging) and state (an opaque server-time watermark; pass it as `since` on the next poll to fetch only newer changes).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Watermark timestamp or a previous response's `state` token; returns messages created-or-changed after it." },
        cursor: { type: "string", description: "Opaque continuation cursor from a previous call's nextCursor; takes precedence over `since` within one drain." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Page size (default 100)." },
        mailboxId: { type: "string" },
      },
    },
  },
  {
    name: "generate_digest",
    description: "Generate an inbox digest for a window ('today' default, 'yesterday', 'last_7_days', 'month') and return it with an AI summary and highlights. Costs credits but is idempotent per tenant+window+UTC-day: regenerating the same day returns the stored digest without re-charging.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["today", "yesterday", "last_7_days", "month"], description: "Defaults to today." },
      },
    },
  },
  {
    name: "list_digests",
    description: "List previously generated digests (window, summary) newest first. Pair with generate_digest; pass limit to cap results.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "get_billing_status",
    description: "Return the tenant billing overview: send-credit balance, the PREPAID WALLET (wallet.balance_cents — the USD balance domain purchases and renewals are charged against, with its recent transactions and top-up presets), plans, subscriptions, and recent credit ledger. New wallet funding and domain sales are unavailable at paid opening; existing balances and transactions remain readable.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_checkout_country_policy",
    description: "First checkout step. Read and show the current country restrictions to the customer before preparing a paid purchase. Signup and free use remain open. Obtain a billing or residence country declaration and retain this policy version for add_wallet_funds.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_wallet_funds",
    description: "New wallet funding is unavailable at paid opening (wallet_funding_disabled). Retained for replay of an existing checkout attempt. Preserve its original amount, key and country declaration exactly. Plans and send-credit packs remain available.",
    inputSchema: {
      type: "object",
      required: ["amountCents", "idempotencyKey"],
      properties: {
        country: { type: "string", description: "Customer-declared ISO 3166-1 alpha-2 billing or residence country. Never infer from IP or nationality." },
        countryBasis: { type: "string", enum: ["billing", "residence"] },
        countryPolicyVersion: { type: "string", description: "Original version from get_checkout_country_policy after showing its restrictions to the customer. Retain it on every retry, even after the current policy changes." },
        amountCents: { type: "integer", minimum: 1000, description: "USD cents to add; at least 1000 ($10.00)." },
        idempotencyKey: { type: "string", description: "Caller-stable key for this top-up attempt." },
      },
    },
  },
  {
    name: "create_webhook",
    description: "Register an HTTPS webhook endpoint that receives signed Mailery events (email.received, email.delivered, email.bounced, domain.ready, billing.suspended, …). Returns the endpoint and its signing secret ONCE — store the secret where the receiver verifies Mailery-Signature. Prefer this over polling list_changes.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Absolute public https URL (private, loopback, and cloud-metadata destinations are rejected)." },
        description: { type: "string" },
        events: { ...stringArray, description: "Event filter: exact types or group wildcards such as email.*; omit for every event." },
        idempotencyKey: { type: "string", description: "Caller-stable key so a retried registration replays the same endpoint + secret." },
      },
    },
  },
  {
    name: "list_webhooks",
    description: "List the tenant's webhook endpoints: id, url, event filter, status (active/disabled/dead), failure count, and secret prefix. Secrets are never returned here.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_suppressions",
    description: "List addresses hosted send currently refuses for this tenant: hard bounces and spam complaints recorded from provider feedback, newest first. Check this first when a send fails with recipient_suppressed.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["bounce", "complaint", "manual"], description: "Filter by why the address was suppressed." },
        email: { type: "string", description: "Look up one exact address." },
        limit: { type: "number", description: "Page size (1-200, default 50)." },
        cursor: { type: "string", description: "Continue from a previous page's nextCursor." },
      },
    },
  },
  {
    name: "test_webhook",
    description: "Enqueue a webhook.test event for one endpoint so the receiver can confirm signature verification end to end. Returns the queued delivery; check list_webhooks / the deliveries API for the outcome.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "Webhook endpoint id (see list_webhooks)." } },
    },
  },
  {
    name: "submit_feedback",
    description: "Submit product feedback (bug/idea/question/praise/other). Never billing-gated.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" },
        kind: { type: "string", enum: ["bug", "idea", "question", "praise", "other"] },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        url: { type: "string", description: "Absolute http(s) URL the feedback is about." },
        tags: stringArray,
      },
    },
  },
];

/**
 * Map one tool-call argument object onto a SendInput, shared by send_email and
 * every entry of send_email_batch so the two can never drift.
 *
 * `idempotencyKey` is passed through EXACTLY as the caller supplied it and is
 * never generated here: an agent that wants retry safety supplies a key stable
 * across its own retries, and a key this layer invented would be different on
 * every attempt (protecting nothing) or shared across different messages
 * (silently dropping sends).
 */
function sendInputFromArgs(args: Record<string, unknown>): { value: SendInput } | { error: { code: string; message: string } } {
  const to = asArray(arg(args, "to"));
  if (!arg<string>(args, "mailboxId") || !to || to.length === 0) {
    return { error: { code: "bad_request", message: "mailboxId and at least one `to` recipient are required" } };
  }
  const rawAttachments = arg<unknown>(args, "attachments");
  if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
    return { error: { code: "bad_request", message: "attachments must be an array" } };
  }
  const headers = arg<unknown>(args, "headers");
  if (headers !== undefined && (typeof headers !== "object" || headers === null || Array.isArray(headers))) {
    return { error: { code: "bad_request", message: "headers must be an object of header name to string value" } };
  }
  const attachments = (rawAttachments as SendAttachmentInput[] | undefined)?.map((entry) => ({
    filename: typeof entry?.filename === "string" ? entry.filename : undefined,
    contentType: typeof entry?.contentType === "string" ? entry.contentType : undefined,
    content: typeof entry?.content === "string" ? entry.content : undefined,
    attachmentId: typeof entry?.attachmentId === "string" ? entry.attachmentId : undefined,
  }));
  return {
    value: {
      mailboxId: arg<string>(args, "mailboxId"),
      to,
      cc: asArray(arg(args, "cc")),
      bcc: asArray(arg(args, "bcc")),
      subject: arg<string>(args, "subject"),
      text: arg<string>(args, "text"),
      html: arg<string>(args, "html"),
      replyTo: asArray(arg(args, "replyTo")),
      inReplyTo: arg<string>(args, "inReplyTo"),
      references: asArray(arg(args, "references")),
      headers: headers as Record<string, string> | undefined,
      attachments,
      idempotencyKey: arg<string>(args, "idempotencyKey"),
    },
  };
}

function asArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

function arg<T = unknown>(args: Record<string, unknown>, key: string): T {
  return args[key] as T;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(payload: unknown, isError = false): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/** Remove pricing fields from domain availability for public CLI/MCP output. */
function withPublicDomainAvailability(availability: MaileryDomainAvailability): Omit<MaileryDomainAvailability, "quoted_price_cents" | "quoted_price" | "currency"> {
  const { quoted_price_cents: _quotedPriceCents, quoted_price: _quotedPrice, currency: _currency, ...publicPayload } = availability;
  return publicPayload;
}

/** Execute a single MCP tool against the SDK. Never throws — SDK errors become isError results. */
export async function callTool(name: string, rawArgs: Record<string, unknown> | undefined, client: MaileryClient, transportVersion = SDK_VERSION): Promise<ToolResult> {
  const clientDeclaration = { name: "mailery-mcp", version: transportVersion };
  const args = rawArgs ?? {};
  let signupTerms: { url: string; version: string } | undefined;
  try {
    switch (name) {
      case "get_terms": {
        const terms = await client.getCurrentTerms();
        return textResult({ ...terms, url: new URL(terms.url, client.baseUrl).href });
      }
      case "accept_terms":
      case "signup": {
        // Held publication must also win over missing consent in this client.
        // No account mutation or implied acceptance occurs during discovery.
        if (name === "signup") {
          const current = await client.getCurrentTerms();
          signupTerms = { url: new URL(current.url, client.baseUrl).href, version: current.version };
        }
        if (args.acceptedTerms !== true || typeof args.termsVersion !== "string") return textResult({ code: "terms_acceptance_required", message: "Show the Terms link/version to the person and obtain an explicit yes from the person or an agent they authorized", ...(signupTerms ? { terms: signupTerms } : {}) }, true);
        if (name === "accept_terms") return textResult(await client.acceptTerms({ acceptedTerms: true, termsVersion: args.termsVersion }, clientDeclaration));
        if (typeof args.email !== "string" || typeof args.password !== "string") return textResult({ code: "bad_request", message: "email and password required", terms: signupTerms }, true);
        const result = await client.signup({ email: args.email, password: args.password, name: typeof args.name === "string" ? args.name : undefined, inviteCode: typeof args.inviteCode === "string" ? args.inviteCode : undefined, acceptedTerms: true, termsVersion: args.termsVersion }, clientDeclaration);
        return textResult({ ...result, terms: signupTerms });
      }
      case "send_email": {
        const input = sendInputFromArgs(args);
        if ("error" in input) return textResult(input.error, true);
        return textResult(await client.send(input.value));
      }
      case "send_email_batch": {
        const raw = arg<unknown>(args, "messages");
        if (!Array.isArray(raw) || raw.length === 0) {
          return textResult({ code: "bad_request", message: "messages must be a non-empty array of send bodies" }, true);
        }
        if (raw.length > SEND_BATCH_MAX) {
          return textResult({ code: "bad_request", message: `a batch may carry at most ${SEND_BATCH_MAX} messages` }, true);
        }
        const items: SendBatchItem[] = [];
        for (const [index, entry] of raw.entries()) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return textResult({ code: "bad_request", message: `messages[${index}] must be an object` }, true);
          }
          const parsed = sendInputFromArgs(entry as Record<string, unknown>);
          if ("error" in parsed) return textResult({ ...parsed.error, message: `messages[${index}]: ${parsed.error.message}` }, true);
          items.push(parsed.value);
        }
        return textResult(await client.sendBatch(items));
      }
      case "get_message_events": {
        const id = arg<string>(args, "id");
        if (!id) return textResult({ code: "bad_request", message: "id is required" }, true);
        return textResult(await client.getMessageEvents(id, { limit: typeof args.limit === "number" ? args.limit : undefined }));
      }
      case "list_inbox":
        return textResult(await client.listInbox({
          group: arg<string>(args, "group"),
          q: arg<string>(args, "q"),
          mailboxId: arg<string>(args, "mailboxId"),
          direction: arg<"inbound" | "outbound">(args, "direction"),
          limit: typeof args.limit === "number" ? args.limit : undefined,
          cursor: arg<string>(args, "cursor"),
        }));
      case "read_message": {
        const id = arg<string>(args, "id");
        if (!id) return textResult({ code: "bad_request", message: "id is required" }, true);
        return textResult(await client.getMessage(id));
      }
      case "search_domains": {
        const domain = arg<string>(args, "domain");
        if (!domain) return textResult({ code: "bad_request", message: "domain is required" }, true);
        return textResult(withPublicDomainAvailability(await client.searchDomains(domain)));
      }
      case "get_domain_status": {
        const domain = arg<string>(args, "domain");
        if (!domain) return textResult({ code: "bad_request", message: "domain is required" }, true);
        return textResult(await client.getDomainStatus(domain));
      }
      case "buy_domain": {
        const domain = arg<string>(args, "domain");
        if (!domain) return textResult({ code: "bad_request", message: "domain is required" }, true);
        const maxPriceCents = arg<number>(args, "maxPriceCents");
        const currency = arg<string>(args, "currency")?.trim().toLowerCase();
        const idempotencyKey = arg<string>(args, "idempotencyKey");
        if (!Number.isSafeInteger(maxPriceCents) || maxPriceCents <= 0) return textResult({ code: "invalid_price_limit", message: "maxPriceCents must be a positive safe integer" }, true);
        if (!currency || !/^[a-z]{3}$/.test(currency)) return textResult({ code: "invalid_currency", message: "currency must be a three-letter code" }, true);
        if (!idempotencyKey) return textResult({ code: "bad_request", message: "idempotencyKey is required" }, true);
        try {
          const availability = await client.searchDomains(domain);
          const quote = availability.purchase_quote;
          if (!availability.available || !quote?.token || !Number.isSafeInteger(quote.quoted_price_cents) || quote.quoted_price_cents <= 0) {
            return textResult({ code: "domain_not_purchasable", message: `${domain} is not available with a valid signed quote` }, true);
          }
          const quoteCurrency = quote.currency.trim().toLowerCase();
          if (quoteCurrency !== currency) return textResult({ code: "quote_currency_mismatch", message: `quote currency ${quoteCurrency} does not match authorized currency ${currency}` }, true);
          if (quote.quoted_price_cents > maxPriceCents) return textResult({ code: "price_limit_exceeded", message: `quoted price ${quote.quoted_price_cents} exceeds authorized maximum ${maxPriceCents}` }, true);
          return textResult(await client.purchaseDomain({ domain, quoteToken: quote.token, maxPriceCents, currency, idempotencyKey }));
        } catch (err) {
          if (err instanceof NotYetAvailableError) {
            return textResult({ code: "not_yet_available", message: err.message }, true);
          }
          throw err;
        }
      }
      case "create_mailbox": {
        const email = arg<string>(args, "email");
        if (!email) return textResult({ code: "bad_request", message: "email is required" }, true);
        return textResult(await client.createMailbox({
          email,
          name: arg<string>(args, "name"),
          provider: arg<string>(args, "provider"),
        }));
      }
      case "list_mailboxes":
        return textResult(await client.listMailboxes());
      case "update_message": {
        const id = arg<string>(args, "id");
        if (!id) return textResult({ code: "bad_request", message: "id is required" }, true);
        const patch: Record<string, boolean> = {};
        for (const key of ["isRead", "isImportant", "isArchived", "isSpam", "isTrash", "isStarred"] as const) {
          if (typeof args[key] === "boolean") patch[key] = args[key] as boolean;
        }
        if (Object.keys(patch).length === 0) {
          return textResult({ code: "bad_request", message: "provide at least one flag: isRead, isStarred, isArchived, isImportant, isSpam, isTrash" }, true);
        }
        return textResult(await client.updateMessage(id, patch));
      }
      case "list_changes":
        return textResult(await client.listMessageChanges({
          since: arg<string>(args, "since"),
          cursor: arg<string>(args, "cursor"),
          limit: typeof args.limit === "number" ? args.limit : undefined,
          mailboxId: arg<string>(args, "mailboxId"),
        }));
      case "generate_digest": {
        // Local validation before the credit-charging POST: an unknown window
        // must not silently coerce to a different (billable) digest.
        const windows = ["today", "yesterday", "last_7_days", "month"] as const;
        const window = arg<string>(args, "window") ?? "today";
        if (!(windows as readonly string[]).includes(window)) {
          return textResult({ code: "bad_request", message: `window must be one of: ${windows.join(", ")}` }, true);
        }
        return textResult(await client.generateDigest(window as (typeof windows)[number]));
      }
      case "list_digests":
        return textResult(await client.listDigests({ limit: typeof args.limit === "number" ? args.limit : undefined }));
      case "get_billing_status":
        return textResult(await client.getBillingStatus());
      case "get_checkout_country_policy":
        return textResult(await client.getCheckoutCountryPolicy());
      case "add_wallet_funds": {
        const amountCents = arg<number>(args, "amountCents");
        const idempotencyKey = arg<string>(args, "idempotencyKey");
        if (!Number.isSafeInteger(amountCents) || amountCents < 1000) {
          return textResult({ code: "bad_request", message: "amountCents must be an integer of at least 1000 ($10.00)" }, true);
        }
        if (!idempotencyKey) return textResult({ code: "bad_request", message: "idempotencyKey is required" }, true);
        return textResult(await client.topUpWallet({ amountCents, idempotencyKey, country: arg<string>(args, "country"), countryBasis: arg<"billing" | "residence">(args, "countryBasis"), countryPolicyVersion: arg<string>(args, "countryPolicyVersion") }));
      }
      case "create_webhook": {
        const url = arg<string>(args, "url");
        if (!url) return textResult({ code: "bad_request", message: "url is required" }, true);
        return textResult(await client.createWebhook({
          url,
          description: arg<string>(args, "description"),
          events: asArray(arg(args, "events")),
          idempotencyKey: arg<string>(args, "idempotencyKey"),
        }));
      }
      case "list_webhooks":
        return textResult(await client.listWebhooks());
      case "list_suppressions":
        return textResult(await client.listSuppressions({
          reason: arg<string>(args, "reason"),
          email: arg<string>(args, "email"),
          limit: arg<number>(args, "limit"),
          cursor: arg<string>(args, "cursor"),
        }));
      case "test_webhook": {
        const id = arg<string>(args, "id");
        if (!id) return textResult({ code: "bad_request", message: "id is required" }, true);
        return textResult(await client.testWebhook(id));
      }
      case "submit_feedback": {
        const message = arg<string>(args, "message");
        if (!message) return textResult({ code: "bad_request", message: "message is required" }, true);
        return textResult(await client.submitFeedback({
          message,
          kind: arg<string>(args, "kind"),
          severity: arg<string>(args, "severity"),
          url: arg<string>(args, "url"),
          tags: asArray(arg(args, "tags")),
        }));
      }
      default:
        return textResult({ code: "unknown_tool", message: `unknown tool: ${name}` }, true);
    }
  } catch (err) {
    if (err instanceof MaileryError) {
      let details = err.details;
      if (signupTerms && details && typeof details === "object" && !Array.isArray(details)) {
        const record = details as Record<string, unknown>;
        const supplied = record.terms;
        if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
          const serverTerms = supplied as Record<string, unknown>;
          if (typeof serverTerms.url === "string" && typeof serverTerms.version === "string") {
            try {
              signupTerms = { url: new URL(serverTerms.url, client.baseUrl).href, version: serverTerms.version };
              details = { ...record, terms: { ...serverTerms, ...signupTerms } };
            } catch { /* Keep the successful preflight discovery if server metadata is malformed. */ }
          }
        }
      }
      return textResult({ code: err.code ?? "request_failed", message: err.message, status: err.status, details, ...(signupTerms ? { terms: signupTerms } : {}) }, true);
    }
    return textResult({ code: "cli_error", message: err instanceof Error ? err.message : String(err), ...(signupTerms ? { terms: signupTerms } : {}) }, true);
  }
}

function reply(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function replyError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/**
 * Handle one JSON-RPC message. Returns a response to write, or null for
 * notifications (messages with no id, e.g. notifications/initialized).
 *
 * @param msg - JSON-RPC request object
 * @param client - MaileryClient instance (SDK or server-side)
 * @param serverInfo - Optional server info override (defaults to "mailery" + VERSION)
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  client: MaileryClient,
  serverInfo?: { name: string; version: string }
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: serverInfo ?? { name: "mailery", version: "unknown" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
      const result = await callTool(name, args, client, serverInfo?.version ?? SDK_VERSION);
      return reply(id, result);
    }
    default:
      if (isNotification) return null;
      return replyError(id, -32601, `method not found: ${msg.method ?? "(none)"}`);
  }
}
