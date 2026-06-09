// API route handlers — contacts-groups.ts
import { listContacts, suppressContact, unsuppressContact } from '../../db/contacts.js';
import { listTemplateSummaries, getTemplate, createTemplate, deleteTemplate } from '../../db/templates.js';
import { listGroups, createGroup, deleteGroup, getGroupByName, listMemberSummaries, getMember, addMember, removeMember } from '../../db/groups.js';
import { listScheduledEmailSummaries, cancelScheduledEmail } from '../../db/scheduled.js';
import { getEmailContent } from '../../db/email-content.js';
import { getAnalytics } from '../../lib/analytics.js';
import { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from '../../lib/export.js';
import { json, notFound, badRequest, internalError, resolveId, resolveOptionalId, parseBody, queryInteger, queryPage } from './helpers.js';

const EXPORT_DEFAULT_LIMIT = 1000;
const EXPORT_MAX_LIMIT = 5000;

function resolveGroupRef(raw: string): { id: string } | null {
  const ref = decodeURIComponent(raw);
  const group = getGroupByName(ref);
  if (group) return group;
  const id = resolveId("groups", ref);
  return id ? { id } : null;
}

export async function handle(req: Request, url: URL, path: string, method: string): Promise<Response | null> {
// ─── CONTACTS ──────────────────────────────────────────────────────────

// GET /api/contacts?suppressed=true|false
if (path === "/api/contacts" && method === "GET") {
  try {
    const suppressedParam = url.searchParams.get("suppressed");
    const opts = {
      ...(suppressedParam !== null ? { suppressed: suppressedParam === "true" } : {}),
      ...queryPage(url, 100),
    };
    return json(listContacts(opts));
  } catch (e) { return internalError(e); }
}

// POST /api/contacts/:id/suppress
const contactSuppressMatch = path.match(/^\/api\/contacts\/([^/]+)\/suppress$/);
if (contactSuppressMatch && method === "POST") {
  try {
    suppressContact(decodeURIComponent(contactSuppressMatch[1]!));
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// POST /api/contacts/:id/unsuppress
const contactUnsuppressMatch = path.match(/^\/api\/contacts\/([^/]+)\/unsuppress$/);
if (contactUnsuppressMatch && method === "POST") {
  try {
    unsuppressContact(decodeURIComponent(contactUnsuppressMatch[1]!));
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── TEMPLATES ─────────────────────────────────────────────────────────

// GET /api/templates
if (path === "/api/templates" && method === "GET") {
  try {
    return json(listTemplateSummaries(undefined, queryPage(url, 100)));
  } catch (e) { return internalError(e); }
}

// POST /api/templates
if (path === "/api/templates" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.name) return badRequest("name is required");
    if (!body.subject_template) return badRequest("subject_template is required");
    const template = createTemplate({
      name: String(body.name),
      subject_template: String(body.subject_template),
      html_template: body.html_template as string | undefined,
      text_template: body.text_template as string | undefined,
    });
    return json(template, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/templates/:id
const templateMatch = path.match(/^\/api\/templates\/([^/]+)$/);
if (templateMatch && method === "GET") {
  try {
    const template = getTemplate(decodeURIComponent(templateMatch[1]!));
    if (!template) return notFound("Template not found");
    return json(template);
  } catch (e) { return internalError(e); }
}

// DELETE /api/templates/:id
if (templateMatch && method === "DELETE") {
  try {
    const deleted = deleteTemplate(decodeURIComponent(templateMatch[1]!));
    if (!deleted) return notFound("Template not found");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── GROUPS ────────────────────────────────────────────────────────────

// GET /api/groups
if (path === "/api/groups" && method === "GET") {
  try {
    return json(listGroups(undefined, queryPage(url, 100)));
  } catch (e) { return internalError(e); }
}

// POST /api/groups
if (path === "/api/groups" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.name) return badRequest("name is required");
    const group = createGroup(String(body.name), body.description as string | undefined);
    return json(group, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/groups/:id/members
const groupMembersMatch = path.match(/^\/api\/groups\/([^/]+)\/members$/);
if (groupMembersMatch && method === "GET") {
  try {
    const group = resolveGroupRef(groupMembersMatch[1]!);
    if (!group) return notFound("Group not found");
    return json(listMemberSummaries(group.id, undefined, queryPage(url, 100)));
  } catch (e) { return internalError(e); }
}

// POST /api/groups/:id/members
if (groupMembersMatch && method === "POST") {
  try {
    const group = resolveGroupRef(groupMembersMatch[1]!);
    if (!group) return notFound("Group not found");
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.email) return badRequest("email is required");
    const member = addMember(group.id, String(body.email), body.name as string | undefined);
    return json(member, 201);
  } catch (e) { return internalError(e); }
}

// DELETE /api/groups/:id/members/:email
const groupMemberDeleteMatch = path.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)$/);
if (groupMemberDeleteMatch && method === "GET") {
  try {
    const group = resolveGroupRef(groupMemberDeleteMatch[1]!);
    if (!group) return notFound("Group not found");
    const member = getMember(group.id, decodeURIComponent(groupMemberDeleteMatch[2]!));
    if (!member) return notFound("Member not found");
    return json(member);
  } catch (e) { return internalError(e); }
}

if (groupMemberDeleteMatch && method === "DELETE") {
  try {
    const group = resolveGroupRef(groupMemberDeleteMatch[1]!);
    if (!group) return notFound("Group not found");
    const removed = removeMember(group.id, decodeURIComponent(groupMemberDeleteMatch[2]!));
    if (!removed) return notFound("Member not found");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// DELETE /api/groups/:id
const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
if (groupMatch && method === "DELETE") {
  try {
    const group = resolveGroupRef(groupMatch[1]!);
    if (!group) return notFound("Group not found");
    deleteGroup(group.id);
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── SCHEDULED ─────────────────────────────────────────────────────────

// GET /api/scheduled?status=pending|sent|cancelled
if (path === "/api/scheduled" && method === "GET") {
  try {
    const statusParam = url.searchParams.get("status") as "pending" | "sent" | "cancelled" | null;
    const opts = {
      ...(statusParam ? { status: statusParam } : {}),
      ...queryPage(url, 100),
    };
    return json(listScheduledEmailSummaries(opts));
  } catch (e) { return internalError(e); }
}

// DELETE /api/scheduled/:id
const scheduledMatch = path.match(/^\/api\/scheduled\/([^/]+)$/);
if (scheduledMatch && method === "DELETE") {
  const id = resolveId("scheduled_emails", scheduledMatch[1]!);
  if (!id) return notFound();
  try {
    const cancelled = cancelScheduledEmail(id);
    if (!cancelled) return badRequest("Cannot cancel email (may already be sent or cancelled)");
    return json({ ok: true });
  } catch (e) { return internalError(e); }
}

// ─── ANALYTICS ─────────────────────────────────────────────────────────

// GET /api/analytics?provider_id=x&period=30d
if (path === "/api/analytics" && method === "GET") {
  try {
    const period = url.searchParams.get("period") ?? "30d";
    const resolvedId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    return json(getAnalytics(resolvedId, period));
  } catch (e) { return internalError(e); }
}

// ─── EMAIL CONTENT ──────────────────────────────────────────────────────

// GET /api/email-content/:id
const emailContentMatch = path.match(/^\/api\/email-content\/([^/]+)$/);
if (emailContentMatch && method === "GET") {
  const id = resolveId("emails", emailContentMatch[1]!);
  if (!id) return notFound();
  try {
    const content = getEmailContent(id);
    if (!content) return notFound("Email content not found");
    return json(content);
  } catch (e) { return internalError(e); }
}

// ─── EXPORT ────────────────────────────────────────────────────────────

// GET /api/export/emails?format=csv|json&provider_id=x&since=...
if (path === "/api/export/emails" && method === "GET") {
  try {
    const format = url.searchParams.get("format") ?? "json";
    const providerId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const fromAddress = url.searchParams.get("from_address") ?? url.searchParams.get("from") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    const limit = queryInteger(url, "limit", EXPORT_DEFAULT_LIMIT, { min: 1, max: EXPORT_MAX_LIMIT });
    const offset = queryInteger(url, "offset", 0, { min: 0 });
    const filters = { provider_id: providerId, from_address: fromAddress, since, until, limit, offset };
    if (format === "csv") {
      return new Response(exportEmailsCsv(filters), {
        headers: { "Content-Type": "text/csv", "Access-Control-Allow-Origin": "*", "X-Export-Limit": String(limit), "X-Export-Offset": String(offset) },
      });
    }
    return new Response(exportEmailsJson(filters), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Export-Limit": String(limit), "X-Export-Offset": String(offset) },
    });
  } catch (e) { return internalError(e); }
}

// GET /api/export/events?format=csv|json&provider_id=x&since=...
if (path === "/api/export/events" && method === "GET") {
  try {
    const format = url.searchParams.get("format") ?? "json";
    const providerId = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    const limit = queryInteger(url, "limit", EXPORT_DEFAULT_LIMIT, { min: 1, max: EXPORT_MAX_LIMIT });
    const offset = queryInteger(url, "offset", 0, { min: 0 });
    const filters = { provider_id: providerId, since, until, limit, offset };
    if (format === "csv") {
      return new Response(exportEventsCsv(filters), {
        headers: { "Content-Type": "text/csv", "Access-Control-Allow-Origin": "*", "X-Export-Limit": String(limit), "X-Export-Offset": String(offset) },
      });
    }
    return new Response(exportEventsJson(filters), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Export-Limit": String(limit), "X-Export-Offset": String(offset) },
    });
  } catch (e) { return internalError(e); }
}

  return null;
}
