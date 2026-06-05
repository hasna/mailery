// API route handlers — core.ts
import { createProvider, listProviders, deleteProvider, getProvider, updateProvider } from '../../db/providers.js';
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from '../../db/domains.js';
import { createAddress, deleteAddress } from '../../db/addresses.js';
import { listEmails, getEmail, searchEmails } from '../../db/emails.js';
import { listSandboxEmails, getSandboxEmail, clearSandboxEmails } from '../../db/sandbox.js';
import { getDatabase, resolvePartialId } from '../../db/database.js';
import { listEvents } from '../../db/events.js';
import { getAdapter } from '../../providers/index.js';
import { getLocalStats } from '../../lib/stats.js';
import { listEnrichedAddresses } from '../../lib/address-ownership.js';
import { json, notFound, badRequest, internalError, resolveId, parseBody, sanitizeProvider, checkRateLimit, tooManyRequests } from './helpers.js';

export async function handle(req: Request, url: URL, path: string, method: string): Promise<Response | null> {
// GET /api/providers
if (path === "/api/providers" && method === "GET") {
  try {
    return json(listProviders().map(p => sanitizeProvider(p as unknown as Record<string, unknown>)));
  } catch (e) { return internalError(e); }
}

// POST /api/providers
if (path === "/api/providers" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    const provider = createProvider({
      name: String(body.name ?? ""),
      type: (body.type as "resend" | "ses" | "gmail") ?? "resend",
      api_key: body.api_key as string | undefined,
      region: body.region as string | undefined,
      access_key: body.access_key as string | undefined,
      secret_key: body.secret_key as string | undefined,
      oauth_client_id: body.oauth_client_id as string | undefined,
      oauth_client_secret: body.oauth_client_secret as string | undefined,
      oauth_refresh_token: body.oauth_refresh_token as string | undefined,
      oauth_access_token: body.oauth_access_token as string | undefined,
      oauth_token_expiry: body.oauth_token_expiry as string | undefined,
    });
    return json(sanitizeProvider(provider as unknown as Record<string, unknown>), 201);
  } catch (e) { return internalError(e); }
}

// PUT /api/providers/:id
const providerPutMatch = path.match(/^\/api\/providers\/([^/]+)$/);
if (providerPutMatch && method === "PUT") {
  const id = resolveId("providers", providerPutMatch[1]!);
  if (!id) return notFound();
  try {
    const provider = getProvider(id);
    if (!provider) return notFound("Provider not found");
    const body = await parseBody(req) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    for (const key of ["name", "api_key", "region", "access_key", "secret_key", "oauth_client_id", "oauth_client_secret", "oauth_refresh_token", "oauth_access_token", "oauth_token_expiry"]) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    const updated = updateProvider(id, updates as any);
    return json(sanitizeProvider(updated as unknown as Record<string, unknown>));
  } catch (e) { return internalError(e); }
}

// DELETE /api/providers/:id
const providerMatch = path.match(/^\/api\/providers\/([^/]+)$/);
if (providerMatch && method === "DELETE") {
  const id = resolveId("providers", providerMatch[1]!);
  if (!id) return notFound();
  try {
    deleteProvider(id);
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// POST /api/providers/:id/auth — Gmail OAuth re-authentication
const providerAuthMatch = path.match(/^\/api\/providers\/([^/]+)\/auth$/);
if (providerAuthMatch && method === "POST") {
  const id = resolveId("providers", providerAuthMatch[1]!);
  if (!id) return notFound();
  try {
    const provider = getProvider(id);
    if (!provider) return notFound("Provider not found");
    if (provider.type !== "gmail") return badRequest("Only Gmail providers support OAuth re-authentication");
    if (!provider.oauth_client_id || !provider.oauth_client_secret) {
      return badRequest("Provider is missing oauth_client_id or oauth_client_secret");
    }

    const { startGmailOAuthFlow } = await import("../../lib/gmail-oauth.js");
    const tokens = await startGmailOAuthFlow(provider.oauth_client_id, provider.oauth_client_secret);

    const { updateProvider } = await import("../../db/providers.js");
    const updated = updateProvider(id, {
      oauth_refresh_token: tokens.refresh_token,
      oauth_access_token: tokens.access_token,
      oauth_token_expiry: tokens.expiry,
    });

    return json({ ok: true, provider: sanitizeProvider(updated as unknown as Record<string, unknown>) });
  } catch (e) { return internalError(e); }
}

// GET /api/domains
if (path === "/api/domains" && method === "GET") {
  try {
    const providerId = url.searchParams.get("provider_id") ?? undefined;
    const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
    return json(listDomains(resolvedId));
  } catch (e) { return internalError(e); }
}

// POST /api/domains
if (path === "/api/domains" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    const providerId = resolveId("providers", String(body.provider_id ?? ""));
    if (!providerId) return notFound("Provider not found");

    const provider = getProvider(providerId);
    if (!provider) return notFound("Provider not found");

    const domainName = String(body.domain ?? "");
    if (!domainName) return badRequest("domain is required");

    const adapter = getAdapter(provider);
    await adapter.addDomain(domainName);

    const domain = createDomain(providerId, domainName);
    return json(domain, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/domains/:id/dns
const domainDnsMatch = path.match(/^\/api\/domains\/([^/]+)\/dns$/);
if (domainDnsMatch && method === "GET") {
  const id = resolveId("domains", domainDnsMatch[1]!);
  if (!id) return notFound();
  try {
    const domain = getDomain(id);
    if (!domain) return notFound();

    const provider = getProvider(domain.provider_id);
    if (!provider) return notFound("Provider not found");

    const adapter = getAdapter(provider);
    const records = await adapter.getDnsRecords(domain.domain);
    return json(records);
  } catch (e) { return internalError(e); }
}

// POST /api/domains/:id/verify
const domainVerifyMatch = path.match(/^\/api\/domains\/([^/]+)\/verify$/);
if (domainVerifyMatch && method === "POST") {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!checkRateLimit(ip, "verify", 10)) return tooManyRequests();
  const id = resolveId("domains", domainVerifyMatch[1]!);
  if (!id) return notFound();
  try {
    const domain = getDomain(id);
    if (!domain) return notFound();

    const provider = getProvider(domain.provider_id);
    if (!provider) return notFound("Provider not found");

    const adapter = getAdapter(provider);
    const status = await adapter.verifyDomain(domain.domain);
    const updated = updateDnsStatus(id, status.dkim, status.spf, status.dmarc);
    return json(updated);
  } catch (e) { return internalError(e); }
}

// DELETE /api/domains/:id
const domainMatch = path.match(/^\/api\/domains\/([^/]+)$/);
if (domainMatch && method === "DELETE") {
  const id = resolveId("domains", domainMatch[1]!);
  if (!id) return notFound();
  try {
    deleteDomain(id);
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// GET /api/addresses
if (path === "/api/addresses" && method === "GET") {
  try {
    const providerId = url.searchParams.get("provider_id") ?? undefined;
    const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
    return json(listEnrichedAddresses(resolvedId));
  } catch (e) { return internalError(e); }
}

// POST /api/addresses
if (path === "/api/addresses" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    const providerId = resolveId("providers", String(body.provider_id ?? ""));
    if (!providerId) return notFound("Provider not found");

    const provider = getProvider(providerId);
    if (!provider) return notFound("Provider not found");

    const emailAddr = String(body.email ?? "");
    if (!emailAddr) return badRequest("email is required");

    const adapter = getAdapter(provider);
    await adapter.addAddress(emailAddr);

    const addr = createAddress({
      provider_id: providerId,
      email: emailAddr,
      display_name: body.display_name as string | undefined,
    });
    return json(addr, 201);
  } catch (e) { return internalError(e); }
}

// DELETE /api/addresses/:id
const addressMatch = path.match(/^\/api\/addresses\/([^/]+)$/);
if (addressMatch && method === "DELETE") {
  const id = resolveId("addresses", addressMatch[1]!);
  if (!id) return notFound();
  try {
    deleteAddress(id);
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// GET /api/emails
if (path === "/api/emails" && method === "GET") {
  try {
    const filter = {
      provider_id: url.searchParams.get("provider_id") ?? undefined,
      status: url.searchParams.get("status") as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined,
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50,
      offset: url.searchParams.has("offset") ? parseInt(url.searchParams.get("offset")!, 10) : undefined,
    };
    return json(listEmails(filter));
  } catch (e) { return internalError(e); }
}

// GET /api/emails/search?q=...
if (path === "/api/emails/search" && method === "GET") {
  try {
    const q = url.searchParams.get("q") ?? "";
    if (!q) return badRequest("q parameter is required");
    const since = url.searchParams.get("since") ?? undefined;
    const limit = url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;
    return json(searchEmails(q, { since, limit }));
  } catch (e) { return internalError(e); }
}

// GET /api/emails/:id
const emailMatch = path.match(/^\/api\/emails\/([^/]+)$/);
if (emailMatch && method === "GET") {
  const id = resolveId("emails", emailMatch[1]!);
  if (!id) return notFound();
  try {
    const email = getEmail(id);
    if (!email) return notFound();
    return json(email);
  } catch (e) { return internalError(e); }
}

// GET /api/events
if (path === "/api/events" && method === "GET") {
  try {
    const filter = {
      email_id: url.searchParams.get("email_id") ?? undefined,
      provider_id: url.searchParams.get("provider_id") ?? undefined,
      type: url.searchParams.get("type") as "delivered" | "bounced" | "complained" | "opened" | "clicked" | "unsubscribed" | undefined,
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 100,
    };
    return json(listEvents(filter));
  } catch (e) { return internalError(e); }
}

// GET /api/stats
if (path === "/api/stats" && method === "GET") {
  try {
    const providerId = url.searchParams.get("provider_id") ?? undefined;
    const period = url.searchParams.get("period") ?? "30d";
    const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
    const stats = getLocalStats(resolvedId, period);
    return json(stats);
  } catch (e) { return internalError(e); }
}

// GET /api/sandbox
if (path === "/api/sandbox" && method === "GET") {
  try {
    const providerId = url.searchParams.get("provider_id") ?? undefined;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;
    const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
    return json(listSandboxEmails(resolvedId, limit));
  } catch (e) { return internalError(e); }
}

// GET /api/sandbox/:id
const sandboxGetMatch = path.match(/^\/api\/sandbox\/([^/]+)$/);
if (sandboxGetMatch && method === "GET") {
  try {
    const db = getDatabase();
    const id = resolvePartialId(db, "sandbox_emails", sandboxGetMatch[1]!);
    if (!id) return notFound("Sandbox email not found");
    const email = getSandboxEmail(id, db);
    if (!email) return notFound("Sandbox email not found");
    return json(email);
  } catch (e) { return internalError(e); }
}

// DELETE /api/sandbox
if (path === "/api/sandbox" && method === "DELETE") {
  try {
    const providerId = url.searchParams.get("provider_id") ?? undefined;
    const resolvedId = providerId ? resolveId("providers", providerId) ?? providerId : undefined;
    const db = getDatabase();
    const count = clearSandboxEmails(resolvedId, db);
    return json({ deleted: count });
  } catch (e) { return internalError(e); }
}

  return null;
}
