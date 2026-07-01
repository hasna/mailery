// API route handlers — inbound-sequences.ts
import { listInboundEmailSummaries, getInboundEmail, clearInboundEmails, storeInboundEmail } from '../../db/inbound.js';
import { parseResendInbound, parseMailgunInbound, parseMimeEmail } from '../../lib/inbound.js';
import { createSequence, getSequence, listSequences, deleteSequence, addStep, listSteps, enroll, unenroll, listEnrollments, type EnrollmentStatus } from '../../db/sequences.js';
import { createWarmingSchedule, getWarmingSchedule, listWarmingSchedules, updateWarmingStatus, deleteWarmingSchedule } from '../../db/warming.js';
import { getTodayLimit, getTodaySentCount } from '../../lib/warming.js';
import { getTriage, listTriagedSummaries, getTriageStats } from '../../db/triage.js';
import { updateEmailStatus } from '../../db/emails.js';
import { upsertEvent } from '../../db/events.js';
import { getDatabase } from '../../db/database.js';
import { getLatestEmailDigest, normalizeEmailDigestPeriod } from '../../db/email-digests.js';
import { json, notFound, badRequest, internalError, resolveId, resolveIdStrict, resolveOptionalId, parseBody, checkRateLimit, tooManyRequests, parseInteger, queryInteger, optionalQueryInteger, queryPage } from './helpers.js';
import {
  MAILBOXES,
  listMailbox,
  listMailboxSources,
  listMailboxStatus,
  mailboxSourceFromRef,
  searchMailbox,
  type Mailbox,
  type MailboxSource,
} from '../../cli/tui/data.js';
import { getSelfHostedRuntimeStatus } from '../../lib/self-hosted-runtime.js';
import {
  assertSelfHostedDirectRuntimeConfigured,
  clearSelfHostedInboundEmails,
  getSelfHostedInboundEmail,
  getSelfHostedMailboxStatus,
  listSelfHostedInboundEmailSummaries,
  listSelfHostedSourceSummaries,
  type ListSelfHostedInboundOpts,
  type SelfHostedMailbox,
} from '../../db/self-hosted-inbound.js';


function normalizeDisplaySummary(value: string | null | undefined): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 360) : null;
}

function getInboundDisplaySummary(inboundEmailId: string): string | null {
  const db = getDatabase();
  const agent = db.query(`
    SELECT summary
      FROM email_agent_runs
     WHERE inbound_email_id = ?
       AND status = 'ok'
       AND TRIM(COALESCE(summary, '')) != ''
     ORDER BY CASE agent_key
                WHEN 'categorizer' THEN 0
                WHEN 'labeler' THEN 1
                WHEN 'fraud' THEN 2
                ELSE 3
              END,
              completed_at DESC
     LIMIT 1
  `).get(inboundEmailId) as { summary: string | null } | null;
  const agentSummary = normalizeDisplaySummary(agent?.summary);
  if (agentSummary) return agentSummary;

  const triage = db.query(`
    SELECT summary
      FROM email_triage
     WHERE inbound_email_id = ?
       AND TRIM(COALESCE(summary, '')) != ''
     ORDER BY triaged_at DESC
     LIMIT 1
  `).get(inboundEmailId) as { summary: string | null } | null;
  return normalizeDisplaySummary(triage?.summary);
}

function parseEnrollmentStatus(value: string | null): EnrollmentStatus | undefined {
  if (value === null || value === "") return undefined;
  if (value === "active" || value === "completed" || value === "cancelled") return value;
  throw new Error("status must be active, completed, or cancelled");
}

function resolveSequenceRef(raw: string) {
  return getSequence(decodeURIComponent(raw));
}

function normalizeMailboxParam(value: string | null | undefined): Mailbox {
  const normalized = (value ?? "inbox").trim().toLowerCase();
  return MAILBOXES.includes(normalized as Mailbox) ? normalized as Mailbox : "inbox";
}

function selfHostedRuntimeRequested(): boolean {
  return getSelfHostedRuntimeStatus().enabled;
}

function requireSelfHostedRuntime(): void {
  assertSelfHostedDirectRuntimeConfigured();
}

function mailboxSourceFromUrl(url: URL, sourceId?: string): MailboxSource | undefined {
  const to = url.searchParams.get("to")?.trim().toLowerCase();
  const domain = url.searchParams.get("domain")?.trim().toLowerCase();
  const address = url.searchParams.get("address")?.trim().toLowerCase();
  const rawProviderId = url.searchParams.get("provider_id")?.trim() || undefined;
  const providerId = selfHostedRuntimeRequested()
    ? rawProviderId
    : resolveOptionalId("providers", url.searchParams.get("provider_id"));
  return mailboxSourceFromRef({
    sourceId: sourceId ?? url.searchParams.get("source_id") ?? url.searchParams.get("source") ?? undefined,
    providerId,
    address: address ?? (to?.includes("@") ? to : undefined),
    domain: domain ?? (to && !to.includes("@") ? to : undefined),
  });
}

function selfHostedSourceOptions(source: MailboxSource | undefined): Pick<ListSelfHostedInboundOpts, "provider_id" | "sourceId" | "s3Bucket" | "legacy"> | undefined {
  if (!source) return undefined;
  let providerId = source.providerId;
  let s3Bucket = source.s3Bucket;
  let legacy = source.legacy;
  const sourceId = source.sourceId;
  if (sourceId === "legacy") legacy = true;
  else if (sourceId?.startsWith("provider:")) providerId = sourceId.slice("provider:".length);
  else if (sourceId?.startsWith("orphaned:")) providerId = sourceId.slice("orphaned:".length);
  else if (sourceId?.startsWith("s3:")) s3Bucket = decodeURIComponent(sourceId.slice("s3:".length));
  return { provider_id: providerId, sourceId, s3Bucket, legacy };
}

function mailboxPage(url: URL): { limit: number; offset: number } {
  return queryPage(url, 50, 1000);
}

async function mailboxListPayload(mailbox: Mailbox, url: URL, source?: MailboxSource): Promise<Record<string, unknown>> {
  const page = mailboxPage(url);
  if (selfHostedRuntimeRequested()) {
    requireSelfHostedRuntime();
    const rows = await listSelfHostedInboundEmailSummaries({
      ...selfHostedSourceOptions(source),
      mailbox: mailbox as SelfHostedMailbox,
      label: url.searchParams.get("label") ?? undefined,
      search: url.searchParams.get("search") ?? url.searchParams.get("q") ?? undefined,
      limit: page.limit + 1,
      offset: page.offset,
      recipients: source?.address ? [source.address] : undefined,
      recipientDomains: source?.domain ? [source.domain] : undefined,
    });
    const items = rows.slice(0, page.limit);
    return {
      mailbox,
      folder: mailbox,
      source: source ?? null,
      items,
      limit: page.limit,
      offset: page.offset,
      truncated: rows.length > page.limit,
    };
  }
  const rows = listMailbox(mailbox, {
    ...page,
    limit: page.limit + 1,
    source,
    label: url.searchParams.get("label") ?? undefined,
    search: url.searchParams.get("search") ?? url.searchParams.get("q") ?? undefined,
    sort: url.searchParams.get("sort") === "oldest" ? "oldest" : "newest",
  });
  const items = rows.slice(0, page.limit);
  return {
    mailbox,
    folder: mailbox,
    source: source ?? null,
    items,
    limit: page.limit,
    offset: page.offset,
    truncated: rows.length > page.limit,
  };
}

export async function handle(req: Request, url: URL, path: string, method: string): Promise<Response | null> {
// ─── INBOUND EMAILS ────────────────────────────────────────────────────

// GET /api/inbound?provider_id=x&limit=50&since=...
if (path === "/api/inbound" && method === "GET") {
  try {
    const provider_id = selfHostedRuntimeRequested()
      ? url.searchParams.get("provider_id")?.trim() || undefined
      : resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const since = url.searchParams.get("since") ?? undefined;
    const to = url.searchParams.get("to")?.trim().toLowerCase() || undefined;
    const unread = url.searchParams.get("unread") === "true" ? true : undefined;
    const read = url.searchParams.get("read") === "true" ? true : undefined;
    const archived = url.searchParams.get("archived") === "true" ? true : undefined;
    const page = queryPage(url, 50);
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      return json(await listSelfHostedInboundEmailSummaries({
        provider_id,
        since,
        ...page,
        unread,
        read,
        archived,
        recipients: to?.includes("@") ? [to] : undefined,
        recipientDomains: to && !to.includes("@") ? [to] : undefined,
      }));
    }
    return json(listInboundEmailSummaries({
      provider_id,
      since,
      ...page,
      unread,
      read,
      archived,
      recipients: to?.includes("@") ? [to] : undefined,
      recipientDomains: to && !to.includes("@") ? [to] : undefined,
    }));
  } catch (e) { return internalError(e); }
}

// GET /api/mailboxes?source_id=... — folder counts for a mailbox/source scope.
if (path === "/api/mailboxes" && method === "GET") {
  try {
    const source = mailboxSourceFromUrl(url);
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      return json({
        source: source ?? null,
        ...await getSelfHostedMailboxStatus(selfHostedSourceOptions(source)),
      });
    }
    return json({
      source: source ?? null,
      ...listMailboxStatus({ source }),
    });
  } catch (e) { return internalError(e); }
}

// GET /api/mailbox/:folder?source_id=...&search=...
const mailboxMatch = path.match(/^\/api\/mailbox(?:es)?\/([^/]+)$/);
if (mailboxMatch && method === "GET" && mailboxMatch[1] !== "search") {
  try {
    const mailbox = normalizeMailboxParam(mailboxMatch[1]);
    const source = mailboxSourceFromUrl(url);
    return json(await mailboxListPayload(mailbox, url, source));
  } catch (e) { return internalError(e); }
}

// GET /api/mailbox/search?q=...&folder=inbox&source_id=...
if (path === "/api/mailbox/search" && method === "GET") {
  try {
    const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? url.searchParams.get("search") ?? "";
    if (!query.trim()) return badRequest("q is required");
    const page = mailboxPage(url);
    const mailbox = normalizeMailboxParam(url.searchParams.get("folder") ?? url.searchParams.get("mailbox"));
    const source = mailboxSourceFromUrl(url);
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      const rows = await listSelfHostedInboundEmailSummaries({
        ...selfHostedSourceOptions(source),
        mailbox: mailbox as SelfHostedMailbox,
        ...page,
        limit: page.limit + 1,
        sourceId: source?.sourceId,
        label: url.searchParams.get("label") ?? undefined,
        search: query,
        recipients: source?.address ? [source.address] : undefined,
        recipientDomains: source?.domain ? [source.domain] : undefined,
      });
      const items = rows.slice(0, page.limit);
      return json({
        mailbox,
        folder: mailbox,
        source: source ?? null,
        query,
        items,
        limit: page.limit,
        offset: page.offset,
        truncated: rows.length > page.limit,
      });
    }
    const rows = searchMailbox(query, {
      mailbox,
      ...page,
      limit: page.limit + 1,
      source,
      label: url.searchParams.get("label") ?? undefined,
      sort: url.searchParams.get("sort") === "oldest" ? "oldest" : "newest",
    });
    const items = rows.slice(0, page.limit);
    return json({
      mailbox,
      folder: mailbox,
      source: source ?? null,
      query,
      items,
      limit: page.limit,
      offset: page.offset,
      truncated: rows.length > page.limit,
    });
  } catch (e) { return internalError(e); }
}

// GET /api/sources — ingestion stream status with legacy/orphaned badges.
if (path === "/api/sources" && method === "GET") {
  try {
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      return json({
        sources: await listSelfHostedSourceSummaries({
          limit: queryInteger(url, "limit", 100, { min: 1, max: 1000 }),
          search: url.searchParams.get("search") ?? url.searchParams.get("q") ?? undefined,
        }),
      });
    }
    return json({
      sources: listMailboxSources({
        limit: queryInteger(url, "limit", 100, { min: 1, max: 1000 }),
        search: url.searchParams.get("search") ?? url.searchParams.get("q") ?? undefined,
      }),
    });
  } catch (e) { return internalError(e); }
}

// GET /api/sources/:sourceId/mailbox/:folder
const sourceMailboxMatch = path.match(/^\/api\/sources\/([^/]+)\/mailbox(?:es)?\/([^/]+)$/);
if (sourceMailboxMatch && method === "GET") {
  try {
    const sourceId = decodeURIComponent(sourceMailboxMatch[1]!);
    const mailbox = normalizeMailboxParam(sourceMailboxMatch[2]);
    return json(await mailboxListPayload(mailbox, url, mailboxSourceFromUrl(url, sourceId)));
  } catch (e) { return internalError(e); }
}

// GET /api/sources/:sourceId/search?q=...&folder=inbox
const sourceSearchMatch = path.match(/^\/api\/sources\/([^/]+)\/search$/);
if (sourceSearchMatch && method === "GET") {
  try {
    const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? url.searchParams.get("search") ?? "";
    if (!query.trim()) return badRequest("q is required");
    const sourceId = decodeURIComponent(sourceSearchMatch[1]!);
    const page = mailboxPage(url);
    const mailbox = normalizeMailboxParam(url.searchParams.get("folder") ?? url.searchParams.get("mailbox"));
    const source = mailboxSourceFromUrl(url, sourceId);
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      const rows = await listSelfHostedInboundEmailSummaries({
        ...selfHostedSourceOptions(source),
        mailbox: mailbox as SelfHostedMailbox,
        ...page,
        limit: page.limit + 1,
        label: url.searchParams.get("label") ?? undefined,
        search: query,
        recipients: source?.address ? [source.address] : undefined,
        recipientDomains: source?.domain ? [source.domain] : undefined,
      });
      return json({
        mailbox,
        folder: mailbox,
        source,
        query,
        items: rows.slice(0, page.limit),
        limit: page.limit,
        offset: page.offset,
        truncated: rows.length > page.limit,
      });
    }
    const rows = searchMailbox(query, {
      mailbox,
      ...page,
      limit: page.limit + 1,
      source,
      label: url.searchParams.get("label") ?? undefined,
      sort: url.searchParams.get("sort") === "oldest" ? "oldest" : "newest",
    });
    return json({
      mailbox,
      folder: mailbox,
      source,
      query,
      items: rows.slice(0, page.limit),
      limit: page.limit,
      offset: page.offset,
      truncated: rows.length > page.limit,
    });
  } catch (e) { return internalError(e); }
}

// DELETE /api/inbound?provider_id=x
if (path === "/api/inbound" && method === "DELETE") {
  try {
    const provider_id = selfHostedRuntimeRequested()
      ? url.searchParams.get("provider_id")?.trim() || undefined
      : resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const count = selfHostedRuntimeRequested()
      ? await (requireSelfHostedRuntime(), clearSelfHostedInboundEmails(provider_id))
      : clearInboundEmails(provider_id);
    return json({ ok: true, count });
  } catch (e) { return internalError(e); }
}

// POST /api/inbound — webhook endpoint for Resend/Mailgun inbound routing
if (path === "/api/inbound" && method === "POST") {
  try {
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      return json({
        error: "Direct local inbound webhook ingestion is disabled in self_hosted mode. Use /webhook/ses-inbound with SES/S3 receipt objects.",
      }, 409);
    }
    const body = await parseBody(req) as Record<string, unknown>;
    let parsed: ReturnType<typeof parseMimeEmail>;

    // Auto-detect format from payload shape
    if (body["message-headers"] !== undefined || body["body-plain"] !== undefined || body.recipient !== undefined) {
      // Mailgun format
      parsed = parseMailgunInbound(body);
    } else if (body.from !== undefined || body.to !== undefined || body.subject !== undefined) {
      // Resend inbound format
      parsed = parseResendInbound(body);
    } else if (typeof body.raw === "string") {
      // Raw MIME
      parsed = parseMimeEmail(body.raw);
    } else {
      // Try Resend as default
      parsed = parseResendInbound(body);
    }

    const provider_id = resolveOptionalId("providers", url.searchParams.get("provider_id"));
    const rawBody = JSON.stringify(body);
    const stored = storeInboundEmail({
      provider_id: provider_id ?? null,
      message_id: parsed.message_id,
      in_reply_to_email_id: null,  // auto-detected from headers
      from_address: parsed.from_address || "unknown",
      to_addresses: parsed.to_addresses,
      cc_addresses: parsed.cc_addresses,
      subject: parsed.subject,
      text_body: parsed.text_body,
      html_body: parsed.html_body,
      attachments: [],
      attachment_paths: [],
      headers: parsed.headers,
      raw_size: rawBody.length,
      received_at: new Date().toISOString(),
    });
    return json(stored, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/inbound/:id
const inboundMatch = path.match(/^\/api\/inbound\/([^/]+)$/);
if (inboundMatch && method === "GET") {
  try {
    if (selfHostedRuntimeRequested()) {
      requireSelfHostedRuntime();
      const email = await getSelfHostedInboundEmail(inboundMatch[1]!);
      if (!email) return notFound("Inbound email not found");
      return json({ ...email, summary: null });
    }
    const id = resolveId("inbound_emails", inboundMatch[1]!);
    if (!id) return notFound("Inbound email not found");
    const email = getInboundEmail(id);
    if (!email) return notFound("Inbound email not found");
    return json({ ...email, summary: getInboundDisplaySummary(email.id) });
  } catch (e) { return internalError(e); }
}

// ─── DOCTOR ────────────────────────────────────────────────────────────

// GET /api/doctor
if (path === "/api/doctor" && method === "GET") {
  try {
    const live = url.searchParams.get("live") === "true";
    const { runDiagnostics } = await import('../../lib/doctor.js');
    const checks = await runDiagnostics(undefined, { liveProviderChecks: live });
    return json(checks);
  } catch (e) { return internalError(e); }
}

// POST /api/pull
if (path === "/api/pull" && method === "POST") {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!checkRateLimit(ip, "pull", 5)) return tooManyRequests();
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    let result: Record<string, number>;
    if (body.provider_id) {
      const id = resolveIdStrict("providers", String(body.provider_id));
      const { syncProvider } = await import('../../lib/sync.js');
      const count = await syncProvider(id);
      result = { [id]: count };
    } else {
      const { syncAll } = await import('../../lib/sync.js');
      result = await syncAll();
    }
    return json(result);
  } catch (e) { return internalError(e); }
}

// GET /api/digest?period=today — latest saved digest, local snapshot if missing
if (path === "/api/digest" && method === "GET") {
  try {
    const period = normalizeEmailDigestPeriod(url.searchParams.get("period") ?? "today");
    const latest = getLatestEmailDigest(period);
    if (latest) return json(latest);
    const { generateEmailDigest } = await import('../../lib/email-digest.js');
    return json(await generateEmailDigest({ period, offline: true }));
  } catch (e) { return internalError(e); }
}

// POST /api/digest — generate a fresh Groq/Cerebras digest, or local with { local: true }
if (path === "/api/digest" && method === "POST") {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!checkRateLimit(ip, "digest", 3)) return tooManyRequests();
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    const period = normalizeEmailDigestPeriod(String(body.period ?? "today"));
    const local = body.local === true || body.offline === true;
    const { generateEmailDigest, loadEmailDigest } = await import('../../lib/email-digest.js');
    const digest = local
      ? await generateEmailDigest({ period, offline: true, limit: Number(body.limit) || undefined })
      : await loadEmailDigest({
          period,
          fresh: true,
          allowLocalFallback: body.fallback_local === true,
          limit: Number(body.limit) || undefined,
          provider: body.provider === "cerebras" || body.provider === "groq" ? body.provider : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
        });
    return json(digest);
  } catch (e) { return internalError(e); }
}

// POST /api/agents/organize — categorize/label existing inbound mail
if (path === "/api/agents/organize" && method === "POST") {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  if (!checkRateLimit(ip, "organize", 3)) return tooManyRequests();
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    const { normalizeEmailAgentKey } = await import('../../db/email-agents.js');
    const { runEmailOrganization } = await import('../../lib/email-agents.js');
    const agentList = typeof body.agents === "string"
      ? body.agents.split(",").map((agent) => normalizeEmailAgentKey(agent))
      : undefined;
    const result = await runEmailOrganization({
      limit: Math.max(1, Math.min(Number(body.limit) || 100, 2000)),
      all: body.all === true,
      agents: agentList,
      force: true,
      applyLabels: body.skip_labels === true ? false : true,
      useNetworkTools: body.skip_network === true ? false : undefined,
      applyActions: body.apply_actions === true,
      provider: body.provider === "cerebras" || body.provider === "groq" ? body.provider : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
    });
    return json(result);
  } catch (e) { return internalError(e); }
}

// ─── SEQUENCES ───────────────────────────────────────────────────────

// GET /api/sequences
if (path === "/api/sequences" && method === "GET") {
  try {
    return json(listSequences(undefined, queryPage(url, 100)));
  } catch (e) { return internalError(e); }
}

// POST /api/sequences
if (path === "/api/sequences" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.name) return badRequest("name is required");
    const seq = createSequence({ name: String(body.name), description: body.description ? String(body.description) : undefined });
    return json(seq, 201);
  } catch (e) { return internalError(e); }
}

// DELETE /api/sequences/:id
const seqDeleteMatch = path.match(/^\/api\/sequences\/([^/]+)$/);
if (seqDeleteMatch && method === "DELETE") {
  try {
    const seq = resolveSequenceRef(seqDeleteMatch[1]!);
    if (!seq) return notFound("Sequence not found");
    deleteSequence(seq.id);
    return json({ deleted: true });
  } catch (e) { return internalError(e); }
}

// GET /api/sequences/:id/steps
const seqStepsMatch = path.match(/^\/api\/sequences\/([^/]+)\/steps$/);
if (seqStepsMatch && method === "GET") {
  try {
    const seq = resolveSequenceRef(seqStepsMatch[1]!);
    if (!seq) return notFound("Sequence not found");
    return json(listSteps(seq.id));
  } catch (e) { return internalError(e); }
}

// POST /api/sequences/:id/steps
if (seqStepsMatch && method === "POST") {
  try {
    const seq = resolveSequenceRef(seqStepsMatch[1]!);
    if (!seq) return notFound("Sequence not found");
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.step_number || !body.template_name) return badRequest("step_number and template_name are required");
    const step = addStep({
      sequence_id: seq.id,
      step_number: Number(body.step_number),
      delay_hours: body.delay_hours ? Number(body.delay_hours) : 24,
      template_name: String(body.template_name),
      from_address: body.from_address ? String(body.from_address) : undefined,
      subject_override: body.subject_override ? String(body.subject_override) : undefined,
    });
    return json(step, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/sequences/:id/enrollments
const seqEnrollmentsMatch = path.match(/^\/api\/sequences\/([^/]+)\/enrollments$/);
if (seqEnrollmentsMatch && method === "GET") {
  try {
    const seq = resolveSequenceRef(seqEnrollmentsMatch[1]!);
    if (!seq) return notFound("Sequence not found");
    let status: EnrollmentStatus | undefined;
    try {
      status = parseEnrollmentStatus(url.searchParams.get("status"));
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : String(error));
    }
    return json(listEnrollments({
      sequence_id: seq.id,
      ...(status ? { status } : {}),
      ...queryPage(url, 100),
    }));
  } catch (e) { return internalError(e); }
}

// POST /api/sequences/:id/enroll
const seqEnrollMatch = path.match(/^\/api\/sequences\/([^/]+)\/enroll$/);
if (seqEnrollMatch && method === "POST") {
  try {
    const seq = resolveSequenceRef(seqEnrollMatch[1]!);
    if (!seq) return notFound("Sequence not found");
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.contact_email) return badRequest("contact_email is required");
    const enrollment = enroll({
      sequence_id: seq.id,
      contact_email: String(body.contact_email),
      provider_id: body.provider_id ? resolveIdStrict("providers", String(body.provider_id)) : undefined,
    });
    return json(enrollment, 201);
  } catch (e) { return internalError(e); }
}

// DELETE /api/sequences/:id/enrollments/:email
const seqUnenrollMatch = path.match(/^\/api\/sequences\/([^/]+)\/enrollments\/(.+)$/);
if (seqUnenrollMatch && method === "DELETE") {
  try {
    const seq = resolveSequenceRef(seqUnenrollMatch[1]!);
    const email = decodeURIComponent(seqUnenrollMatch[2]!);
    if (!seq) return notFound("Sequence not found");
    const removed = unenroll(seq.id, email);
    if (!removed) return notFound("Enrollment not found or already inactive");
    return json({ unenrolled: true });
  } catch (e) { return internalError(e); }
}

// ─── WARMING ─────────────────────────────────────────────────────────

// GET /api/warming
if (path === "/api/warming" && method === "GET") {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    return json(listWarmingSchedules(status, undefined, queryPage(url, 50)));
  } catch (e) { return internalError(e); }
}

// POST /api/warming
if (path === "/api/warming" && method === "POST") {
  try {
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.domain) return badRequest("domain is required");
    if (!body.target_daily_volume) return badRequest("target_daily_volume is required");
    const schedule = createWarmingSchedule({
      domain: String(body.domain),
      target_daily_volume: Number(body.target_daily_volume),
      start_date: body.start_date ? String(body.start_date) : undefined,
      provider_id: body.provider_id ? resolveIdStrict("providers", String(body.provider_id)) : undefined,
    });
    return json(schedule, 201);
  } catch (e) { return internalError(e); }
}

// GET /api/warming/:domain
const warmingDomainMatch = path.match(/^\/api\/warming\/([^/]+)$/);
if (warmingDomainMatch && method === "GET") {
  try {
    const domain = decodeURIComponent(warmingDomainMatch[1]!);
    const schedule = getWarmingSchedule(domain);
    if (!schedule) return notFound("Warming schedule not found");
    const today_limit = getTodayLimit(schedule);
    const today_sent = getTodaySentCount(domain);
    const startDate = new Date(schedule.start_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    startDate.setHours(0, 0, 0, 0);
    const current_day = Math.max(1, Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
    return json({ schedule, today_limit, today_sent, current_day });
  } catch (e) { return internalError(e); }
}

// PUT /api/warming/:domain
if (warmingDomainMatch && method === "PUT") {
  try {
    const domain = decodeURIComponent(warmingDomainMatch[1]!);
    const body = await parseBody(req) as Record<string, unknown>;
    if (!body.status) return badRequest("status is required");
    const status = String(body.status) as "active" | "paused" | "completed";
    const updated = updateWarmingStatus(domain, status);
    if (!updated) return notFound("Warming schedule not found");
    return json(updated);
  } catch (e) { return internalError(e); }
}

// DELETE /api/warming/:domain
if (warmingDomainMatch && method === "DELETE") {
  try {
    const domain = decodeURIComponent(warmingDomainMatch[1]!);
    const deleted = deleteWarmingSchedule(domain);
    if (!deleted) return notFound("Warming schedule not found");
    return json({ deleted: true });
  } catch (e) { return internalError(e); }
}

// ─── TRACKING ────────────────────────────────────────────────────────

// ─── TRIAGE (AI) ──────────────────────────────────────────────────────

// GET /api/triage/stats
if (path === "/api/triage/stats" && method === "GET") {
  try {
    return json(getTriageStats());
  } catch (e) { return internalError(e); }
}

// POST /api/triage/batch
if (path === "/api/triage/batch" && method === "POST") {
  try {
    const body = await req.json() as { type?: string; limit?: number; model?: string; skip_draft?: boolean };
    const type = (body.type === "sent" ? "sent" : "inbound") as "sent" | "inbound";
    const limit = parseInteger(body.limit, 10, { min: 1, max: 100 });
    const { triageBatch } = await import('../../lib/triage.js');
    const result = await triageBatch(type, limit, { model: body.model, skip_draft: body.skip_draft });
    return json(result);
  } catch (e) { return internalError(e); }
}

// POST /api/triage/:id/draft
const triageDraftMatch = path.match(/^\/api\/triage\/([^/]+)\/draft$/);
if (triageDraftMatch && method === "POST") {
  try {
    const body = await req.json() as { type?: string; model?: string };
    const type = (body.type === "inbound" ? "inbound" : "sent") as "sent" | "inbound";
    const { generateDraftForEmail } = await import('../../lib/triage.js');
    const draft = await generateDraftForEmail(triageDraftMatch[1]!, type, { model: body.model });
    return json({ draft });
  } catch (e) { return internalError(e); }
}

// /api/triage/:id — GET, POST, DELETE
const triageIdMatch = path.match(/^\/api\/triage\/([^/]+)$/);
if (triageIdMatch && triageIdMatch[1] !== "batch" && triageIdMatch[1] !== "stats") {
  const triageTargetId = triageIdMatch[1]!;

  if (method === "GET") {
    try {
      const { getTriageById } = await import("../../db/triage.js");
      const typeParam = url.searchParams.get("type") || "sent";
      let result = getTriageById(triageTargetId);
      if (!result) result = getTriage(triageTargetId, typeParam as "sent" | "inbound");
      if (!result) return notFound("No triage result found");
      return json(result);
    } catch (e) { return internalError(e); }
  }

  if (method === "POST") {
    try {
      const body = await req.json() as { type?: string; model?: string; skip_draft?: boolean };
      const type = (body.type === "inbound" ? "inbound" : "sent") as "sent" | "inbound";
      const { triageEmail } = await import('../../lib/triage.js');
      const result = await triageEmail(triageTargetId, type, { model: body.model, skip_draft: body.skip_draft });
      return json(result);
    } catch (e) { return internalError(e); }
  }

  if (method === "DELETE") {
    try {
      const { deleteTriage } = await import("../../db/triage.js");
      const deleted = deleteTriage(triageTargetId);
      return json({ deleted });
    } catch (e) { return internalError(e); }
  }
}

// GET /api/triage — list triaged emails
if (path === "/api/triage" && method === "GET") {
  try {
    const label = url.searchParams.get("label") || undefined;
    const priority = optionalQueryInteger(url, "priority", { min: 1 });
    const sentiment = url.searchParams.get("sentiment") || undefined;
    const limit = queryInteger(url, "limit", 20, { min: 1, max: 100 });
    const offset = optionalQueryInteger(url, "offset", { min: 0 });
    return json(listTriagedSummaries({ label: label as any, priority, sentiment: sentiment as any, limit, offset }));
  } catch (e) { return internalError(e); }
}

// GET /track/open/:emailId — record open event, return 1x1 transparent GIF
const trackOpenMatch = path.match(/^\/track\/open\/([^/]+)$/);
if (trackOpenMatch && method === "GET") {
  const emailId = trackOpenMatch[1]!;
  try {
    upsertEvent({
      email_id: emailId,
      provider_id: "tracking",
      provider_event_id: `open-${emailId}-${Date.now()}`,
      type: "opened",
      recipient: null,
      metadata: { tracked: true, ip: req.headers.get("x-forwarded-for") ?? "unknown" },
      occurred_at: new Date().toISOString(),
    });
    updateEmailStatus(emailId, "delivered");
  } catch { /* non-fatal — don't break the tracking pixel response */ }

  // Return 1x1 transparent GIF
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  return new Response(gif, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache" },
  });
}

// GET /track/click/:emailId/:encodedUrl — record click, redirect to original URL
const trackClickMatch = path.match(/^\/track\/click\/([^/]+)\/([^/]+)$/);
if (trackClickMatch && method === "GET") {
  const emailId = trackClickMatch[1]!;
  const encoded = trackClickMatch[2]!;
  let originalUrl = "";
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf-8");
    // Security: only allow http/https URLs to prevent open redirect to javascript: or file://
    if (decoded.startsWith("https://") || decoded.startsWith("http://")) {
      originalUrl = decoded;
    }
    upsertEvent({
      email_id: emailId,
      provider_id: "tracking",
      provider_event_id: `click-${emailId}-${encoded}-${Date.now()}`,
      type: "clicked",
      recipient: null,
      metadata: { url: originalUrl, tracked: true },
      occurred_at: new Date().toISOString(),
    });
  } catch { /* non-fatal — still redirect */ }

  if (!originalUrl) return badRequest("Invalid tracking URL");
  return new Response(null, {
    status: 302,
    headers: { "Location": originalUrl },
  });
}
  return null;
}
