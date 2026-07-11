// API route handlers — core.ts
import { createProvider, listProviderSummaries, deleteProvider, getProvider, updateProvider } from '../../db/providers.js';
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from '../../db/domains.js';
import { createAddress, deleteAddress } from '../../db/addresses.js';
import { listEmails, getEmail, searchEmails } from '../../db/emails.js';
import { listSandboxEmailSummaries, getSandboxEmail, clearSandboxEmails } from '../../db/sandbox.js';
import { getDatabase } from '../../db/database.js';
import { getEvent, listEventSummaries } from '../../db/events.js';
import { getAdapter } from '../../providers/index.js';
import { getLocalStats } from '../../lib/stats.js';
import { listEnrichedAddresses } from '../../lib/address-ownership.js';
import {
  getDomainLifecycleSummary,
  listDomainLifecycleSummaries,
  updateDomainLifecycleReadiness,
  type DomainReadinessMutationInput,
} from '../../lib/domain-readiness-service.js';
import { json, notFound, badRequest, internalError, resolveId, resolveIdStrict, resolveOptionalId, parseBody, sanitizeProvider, checkRateLimit, tooManyRequests, queryInteger, optionalQueryInteger, queryPage } from './helpers.js';

class DomainReadinessRequestError extends Error {}

export async function handle(req: Request, url: URL, path: string, method: string): Promise<Response | null> {
function enumField<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DomainReadinessRequestError(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function stringOrNullField(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new DomainReadinessRequestError(`${key} must be a string or null`);
}

function objectField(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new DomainReadinessRequestError(`${key} must be an object`);
}

function domainReadinessMutation(body: Record<string, unknown>): DomainReadinessMutationInput {
  return {
    domain_type: enumField(body, "domain_type", ["system", "self_hosted", "local_only"] as const),
    source_of_truth: enumField(body, "source_of_truth", ["local", "postgres"] as const),
    ownership_status: enumField(body, "ownership_status", ["pending", "verified", "failed"] as const),
    inbound_status: enumField(body, "inbound_status", ["pending", "ready", "disabled", "failed"] as const),
    outbound_status: enumField(body, "outbound_status", ["pending", "ready", "disabled", "failed"] as const),
    monitoring_status: enumField(body, "monitoring_status", ["none", "monitoring", "clean", "risky"] as const),
    dns_records: objectField(body, "dns_records"),
    provider_metadata: objectField(body, "provider_metadata"),
    last_dns_check_at: stringOrNullField(body, "last_dns_check_at"),
    last_inbound_check_at: stringOrNullField(body, "last_inbound_check_at"),
    last_outbound_check_at: stringOrNullField(body, "last_outbound_check_at"),
    last_monitored_at: stringOrNullField(body, "last_monitored_at"),
    restricted_at: stringOrNullField(body, "restricted_at"),
    suspended_at: stringOrNullField(body, "suspended_at"),
    force: body.force === true,
  };
}

// GET /api/providers
if (path === "/api/providers" && method === "GET") {
  try {
    return json(listProviderSummaries(undefined, queryPage(url, 50)));
  } catch (e) { return internalError(e); }
}

// POST /api/providers
if (path === "/api/providers" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    const type = String(body.type ?? "resend");
    if (type !== "resend" && type !== "ses" && type !== "sandbox") {
      return badRequest("Provider type must be one of: resend, ses, sandbox");
    }
    const provider = createProvider({
      name: String(body.name ?? ""),
      type: type as "resend" | "ses" | "sandbox",
      api_key: body.api_key as string | undefined,
      region: body.region as string | undefined,
      access_key: body.access_key as string | undefined,
      secret_key: body.secret_key as string | undefined,
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
    for (const key of ["name", "api_key", "region", "access_key", "secret_key"]) {
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

// GET /api/domains
if (path === "/api/domains" && method === "GET") {
  try {
    const resolvedId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const page = queryPage(url, 100);
    return json(listDomains(resolvedId, getDatabase(), page));
  } catch (e) { return internalError(e); }
}

// GET /api/domains/readiness
if (path === "/api/domains/readiness" && method === "GET") {
  try {
    const resolvedId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const page = queryPage(url, 100);
    return json(listDomainLifecycleSummaries({ provider_id: resolvedId, ...page }));
  } catch (e) { return internalError(e); }
}

// GET /api/domains/:id/readiness
const domainReadinessMatch = path.match(/^\/api\/domains\/([^/]+)\/readiness$/);
if (domainReadinessMatch && method === "GET") {
  const id = resolveId("domains", domainReadinessMatch[1]!);
  if (!id) return notFound();
  try {
    return json(getDomainLifecycleSummary(id));
  } catch (e) { return internalError(e); }
}

// PATCH/POST /api/domains/:id/readiness
if (domainReadinessMatch && (method === "PATCH" || method === "POST")) {
  const id = resolveId("domains", domainReadinessMatch[1]!);
  if (!id) return notFound();
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    return json(updateDomainLifecycleReadiness(id, domainReadinessMutation(body)).after);
  } catch (e) {
    if (e instanceof DomainReadinessRequestError) return badRequest(e.message);
    return internalError(e);
  }
}

// POST /api/domains
if (path === "/api/domains" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    const providerId = resolveIdStrict("providers", String(body.provider_id ?? ""));

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
    const resolvedId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const page = queryPage(url, 100);
    return json(listEnrichedAddresses(resolvedId, getDatabase(), page));
  } catch (e) { return internalError(e); }
}

// POST /api/addresses
if (path === "/api/addresses" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    const providerId = resolveIdStrict("providers", String(body.provider_id ?? ""));

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
      provider_id: resolveOptionalId("providers", url.searchParams.get("provider_id")),
      status: url.searchParams.get("status") as "sent" | "delivered" | "bounced" | "complained" | "failed" | undefined,
      from_address: url.searchParams.get("from_address") ?? url.searchParams.get("from") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      limit: queryInteger(url, "limit", 50, { min: 1, max: 1000 }),
      offset: optionalQueryInteger(url, "offset", { min: 0 }),
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
    const limit = queryInteger(url, "limit", 50, { min: 1, max: 1000 });
    const offset = optionalQueryInteger(url, "offset", { min: 0 });
    return json(searchEmails(q, { since, limit, offset }));
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
      provider_id: resolveOptionalId("providers", url.searchParams.get("provider_id")),
      type: url.searchParams.get("type") as "delivered" | "bounced" | "complained" | "opened" | "clicked" | "unsubscribed" | undefined,
      since: url.searchParams.get("since") ?? undefined,
      until: url.searchParams.get("until") ?? undefined,
      limit: queryInteger(url, "limit", 100, { min: 1, max: 1000 }),
      offset: queryInteger(url, "offset", 0, { min: 0 }),
    };
    return json(listEventSummaries(filter));
  } catch (e) { return internalError(e); }
}

// GET /api/events/:id
const eventMatch = path.match(/^\/api\/events\/([^/]+)$/);
if (eventMatch && method === "GET") {
  const id = resolveId("events", eventMatch[1]!);
  if (!id) return notFound("Event not found");
  try {
    const event = getEvent(id);
    if (!event) return notFound("Event not found");
    return json(event);
  } catch (e) { return internalError(e); }
}

// GET /api/stats
if (path === "/api/stats" && method === "GET") {
  try {
    const period = url.searchParams.get("period") ?? "30d";
    const resolvedId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const stats = getLocalStats(resolvedId, period);
    return json(stats);
  } catch (e) { return internalError(e); }
}

// GET /api/sandbox
if (path === "/api/sandbox" && method === "GET") {
  try {
    const page = queryPage(url, 50);
    const resolvedId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    return json(listSandboxEmailSummaries(resolvedId, page.limit, page.offset));
  } catch (e) { return internalError(e); }
}

// GET /api/sandbox/:id
const sandboxGetMatch = path.match(/^\/api\/sandbox\/([^/]+)$/);
if (sandboxGetMatch && method === "GET") {
  try {
    const db = getDatabase();
    const id = resolveIdStrict("sandbox_emails", sandboxGetMatch[1]!);
    const email = getSandboxEmail(id, db);
    if (!email) return notFound("Sandbox email not found");
    return json(email);
  } catch (e) { return internalError(e); }
}

// DELETE /api/sandbox
if (path === "/api/sandbox" && method === "DELETE") {
  try {
    const resolvedId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const db = getDatabase();
    const count = clearSandboxEmails(resolvedId, db);
    return json({ deleted: count });
  } catch (e) { return internalError(e); }
}

  return null;
}
