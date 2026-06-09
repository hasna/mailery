/**
 * Authenticated programmatic API (`/api/v1/*`) for agents and apps.
 *
 * Every route requires a scoped send key in `Authorization: Bearer esk_…`.
 * The key resolves to an owner; all operations are scoped to addresses that
 * owner owns or administers, so one caller can never act as another tenant.
 */
import { verifySendKey, canOwnerSendFrom } from "../../db/send-keys.js";
import { getOwner, assignAddressOwner, listAddressesByOwner, listAdministeredAddressesNotOwnedBy, getAddressOwnership } from "../../db/owners.js";
import { getActiveProvider, getProvider } from "../../db/providers.js";
import { createAddress, getAddressByEmail } from "../../db/addresses.js";
import { createEmail } from "../../db/emails.js";
import { storeEmailContent } from "../../db/email-content.js";
import { listInboundEmailSummariesForOwner, getInboundEmail, getInboundEmailSummary, setInboundReadFlag, inboundEmailBelongsToOwner } from "../../db/inbound.js";
import { getAdapter } from "../../providers/index.js";
import { getDatabase } from "../../db/database.js";
import { json, badRequest, notFound, internalError, parseBody, queryInteger, resolveIdStrict } from "./helpers.js";

function unauthorized(msg = "Missing or invalid send key"): Response {
  return json({ error: msg }, 401);
}
function forbidden(msg: string): Response {
  return json({ error: msg }, 403);
}

/** Resolve the Bearer send key → owner, or null if absent/invalid. */
function authOwner(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const key = verifySendKey(m[1]!.trim());
  if (!key) return null;
  return getOwner(key.owner_id);
}

function queryBoolean(url: URL, key: string): boolean | undefined {
  if (!url.searchParams.has(key)) return undefined;
  const value = (url.searchParams.get(key) ?? "").trim().toLowerCase();
  if (!value) return true;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function queryText(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

export async function handle(req: Request, url: URL, path: string, method: string): Promise<Response | null> {
  if (!path.startsWith("/api/v1/")) return null;

  const owner = authOwner(req);
  if (!owner) return unauthorized();

  // POST /api/v1/provision/address — register + provision an address for the caller.
  if (path === "/api/v1/provision/address" && method === "POST") {
    try {
      const body = (await parseBody(req)) as Record<string, unknown>;
      const email = String(body.email ?? "").trim();
      if (!email) return badRequest("email is required");
      const providerId = body.provider_id
        ? resolveIdStrict("providers", String(body.provider_id))
        : getActiveProvider().id;
      if (!providerId) return notFound("Provider not found");
      const provider = getProvider(providerId);
      if (!provider) return notFound("Provider not found");

      const existing = getAddressByEmail(providerId, email);
      // Don't let one caller take over an address another owner already holds.
      if (existing) {
        const own = getAddressOwnership(existing.id);
        if (own && own.owner_id !== owner.id) {
          return json({ error: `Address ${email} is already owned by another owner` }, 409);
        }
      }
      const adapter = getAdapter(provider);
      await adapter.addAddress(email);
      const addr = existing ?? createAddress({ provider_id: providerId, email, display_name: body.display_name as string | undefined });
      // The caller owns what it provisions (agent owner self-administers).
      assignAddressOwner(addr.id, owner.id);
      return json({ ...addr, owner_id: owner.id }, existing ? 200 : 201);
    } catch (e) { return internalError(e); }
  }

  // GET /api/v1/addresses — addresses the caller owns/administers.
  if (path === "/api/v1/addresses" && method === "GET") {
    try {
      const page = {
        limit: queryInteger(url, "limit", 200, { min: 1, max: 1000 }),
        offset: queryInteger(url, "offset", 0, { min: 0 }),
      };
      const owned = listAddressesByOwner(owner.id, "owner", undefined, page);
      const administered = listAdministeredAddressesNotOwnedBy(owner.id, undefined, page);
      return json({ owner: { id: owner.id, name: owner.name, type: owner.type }, owned, administered });
    } catch (e) { return internalError(e); }
  }

  // POST /api/v1/send — send from an address the caller controls.
  if (path === "/api/v1/send" && method === "POST") {
    try {
      const body = (await parseBody(req)) as Record<string, unknown>;
      const from = String(body.from ?? "").trim();
      const to = body.to;
      const subject = String(body.subject ?? "");
      if (!from) return badRequest("from is required");
      if (!to) return badRequest("to is required");
      if (!subject) return badRequest("subject is required");
      if (!canOwnerSendFrom(owner.id, from)) {
        return forbidden(`Not authorized to send from ${from}`);
      }
      const providerId = body.provider_id
        ? resolveIdStrict("providers", String(body.provider_id))
        : getActiveProvider().id;
      const sendOpts = {
        provider_id: providerId || undefined,
        from,
        to: to as string | string[],
        cc: body.cc as string | string[] | undefined,
        bcc: body.bcc as string | string[] | undefined,
        reply_to: body.reply_to as string | undefined,
        subject,
        html: body.html as string | undefined,
        text: body.text as string | undefined,
      };
      const db = getDatabase();
      const { sendWithFailover } = await import("../../lib/send.js");
      const { messageId, providerId: actual } = await sendWithFailover(providerId, sendOpts, db);
      const email = createEmail(actual, sendOpts, messageId, db);
      storeEmailContent(email.id, { html: sendOpts.html, text: sendOpts.text }, db);
      return json({ id: email.id, message_id: messageId }, 201);
    } catch (e) { return internalError(e); }
  }

  // GET /api/v1/inbox — inbound mail addressed to the caller's addresses
  // (including alias / catch-all routing), scoped in SQL so it can't leak or be
  // truncated by a global row cap.
  if (path === "/api/v1/inbox" && method === "GET") {
    try {
      const mine = listInboundEmailSummariesForOwner(owner.id, {
        limit: queryInteger(url, "limit", 200, { min: 1, max: 1000 }),
        offset: queryInteger(url, "offset", 0, { min: 0 }),
        since: queryText(url, "since"),
        search: queryText(url, "search") ?? queryText(url, "q"),
        from: queryText(url, "from"),
        subject: queryText(url, "subject"),
        unread: queryBoolean(url, "unread"),
        read: queryBoolean(url, "read"),
        starred: queryBoolean(url, "starred"),
        archived: queryBoolean(url, "archived"),
      });
      return json(mine);
    } catch (e) { return internalError(e); }
  }

  // GET /api/v1/inbox/:id — read one inbound email (marks it read).
  const inboxMatch = path.match(/^\/api\/v1\/inbox\/([^/]+)$/);
  if (inboxMatch && method === "GET") {
    try {
      const db = getDatabase();
      const id = resolveIdStrict("inbound_emails", inboxMatch[1]!);
      const summary = getInboundEmailSummary(id, db);
      if (!summary) return notFound("Inbound email not found");
      if (!inboundEmailBelongsToOwner(summary.id, owner.id, db)) return forbidden("This email is not addressed to one of your addresses");
      if (!summary.is_read) setInboundReadFlag(id, true, db);
      const email = getInboundEmail(id, db);
      if (!email) return notFound("Inbound email not found");
      return json(email);
    } catch (e) { return internalError(e); }
  }

  return null;
}
