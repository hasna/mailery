/**
 * Authenticated programmatic API (`/api/v1/*`) for agents and apps.
 *
 * Every route requires a scoped send key in `Authorization: Bearer esk_…`.
 * The key resolves to an owner; all operations are scoped to addresses that
 * owner owns or administers, so one caller can never act as another tenant.
 */
import { verifySendKey, canOwnerSendFrom } from "../../db/send-keys.js";
import { getOwner, assignAddressOwner, listAddressesByOwner } from "../../db/owners.js";
import { getActiveProvider, getProvider } from "../../db/providers.js";
import { createAddress, getAddressByEmail } from "../../db/addresses.js";
import { createEmail } from "../../db/emails.js";
import { storeEmailContent } from "../../db/email-content.js";
import { listInboundEmails, getInboundEmail, setInboundRead } from "../../db/inbound.js";
import { getAdapter } from "../../providers/index.js";
import { sendWithFailover } from "../../lib/send.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { json, badRequest, notFound, internalError, parseBody, resolveId } from "./helpers.js";

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

/** Emails this owner owns or administers, de-duplicated by address. */
function scopedEmails(ownerId: string): Set<string> {
  const addrs = [...listAddressesByOwner(ownerId, "owner"), ...listAddressesByOwner(ownerId, "administrator")];
  return new Set(addrs.map((a) => a.email.toLowerCase()));
}

export async function handle(req: Request, _url: URL, path: string, method: string): Promise<Response | null> {
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
        ? resolveId("providers", String(body.provider_id))
        : getActiveProvider().id;
      if (!providerId) return notFound("Provider not found");
      const provider = getProvider(providerId);
      if (!provider) return notFound("Provider not found");

      const existing = getAddressByEmail(providerId, email);
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
      const owned = listAddressesByOwner(owner.id, "owner");
      const administered = listAddressesByOwner(owner.id, "administrator").filter((a) => !owned.some((o) => o.id === a.id));
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
        ? resolveId("providers", String(body.provider_id)) ?? ""
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
      const { messageId, providerId: actual } = await sendWithFailover(providerId, sendOpts, db);
      const email = createEmail(actual, sendOpts, messageId, db);
      storeEmailContent(email.id, { html: sendOpts.html, text: sendOpts.text }, db);
      return json({ id: email.id, message_id: messageId }, 201);
    } catch (e) { return internalError(e); }
  }

  // GET /api/v1/inbox — inbound mail addressed to the caller's addresses.
  if (path === "/api/v1/inbox" && method === "GET") {
    try {
      const scope = scopedEmails(owner.id);
      const limit = 200;
      const all = listInboundEmails({ limit });
      const mine = all.filter((m) => m.to_addresses.some((t) => scope.has(t.toLowerCase())));
      return json(mine);
    } catch (e) { return internalError(e); }
  }

  // GET /api/v1/inbox/:id — read one inbound email (marks it read).
  const inboxMatch = path.match(/^\/api\/v1\/inbox\/([^/]+)$/);
  if (inboxMatch && method === "GET") {
    try {
      const db = getDatabase();
      const id = resolvePartialId(db, "inbound_emails", inboxMatch[1]!) ?? inboxMatch[1]!;
      const email = getInboundEmail(id, db);
      if (!email) return notFound("Inbound email not found");
      const scope = scopedEmails(owner.id);
      if (!email.to_addresses.some((t) => scope.has(t.toLowerCase()))) {
        return forbidden("This email is not addressed to one of your addresses");
      }
      const updated = email.is_read ? email : setInboundRead(id, true, db);
      return json(updated);
    } catch (e) { return internalError(e); }
  }

  return null;
}
