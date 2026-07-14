// Auth service: request-context resolver + all identity/tenant/membership/key
// endpoints (WI-2b). Design ref: docs/design/multi-tenancy-auth.md §3, §4.3, §5,
// §8, Addendum A1/A2.
//
// `resolveRequestContext` REPLACES the old single-key `authenticate()`: it
// dispatches by credential prefix (hasna_… -> contracts verifier -> kid ->
// api_key_tenants -> tenant; emss_… -> session -> user+tenant+role), fails closed
// on an unmapped key, and returns a `RequestContext` from which the handler
// derives ONLY `store.forTenant(ctx.tenantId)` — the tenant is NEVER a
// path/query/body parameter on a data route.
//
// `handleAuthRoutes` owns /v1/auth/*, /v1/me, /v1/tenants*, /v1/memberships/*,
// /v1/invites/*, and /v1/keys* (tenant-scoped key issuance). Role gates
// (owner/admin) protect member/tenant management; API keys can NEVER manage
// humans. Enumeration is avoided (generic messages, constant-time login).

import type { ApiKeyVerifier } from "@hasna/contracts/auth";
import { extractToken } from "@hasna/contracts/auth";
import {
  hashPassword,
  verifyPasswordOrEqualizeTiming,
  needsRehash,
} from "./password.js";
import {
  AuthStore,
  EmailTakenError,
  LastOwnerError,
  SlugTakenError,
  isRole,
  toPublicTenant,
  toPublicUser,
  type Role,
  type GlobalRole,
} from "./store.js";
import { RateLimiter } from "./rate-limit.js";
import { isAllowedSignupEmail } from "./allowed-email.js";
import {
  buildAuthMailerConfig,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendInvitationEmail,
  type AuthMailerConfig,
} from "./mailer.js";
import type { SelfHostedSender } from "../sender.js";
import {
  issueSelfHostedApiKey,
  revokeSelfHostedApiKey,
  type SelfHostedKeyStore,
} from "../keys.js";

// ---- request context ---------------------------------------------------------

export type PrincipalType = "user" | "apikey";

export interface RequestContext {
  tenantId: string;
  principalType: PrincipalType;
  userId?: string;
  role?: Role;
  globalRole?: GlobalRole;
  kid?: string;
  scopes: string[];
}

const SCOPES_BY_ROLE: Record<Role, string[]> = {
  owner: ["emails:read", "emails:write"],
  admin: ["emails:read", "emails:write"],
  member: ["emails:read", "emails:write"],
  viewer: ["emails:read"],
};

/** Map a membership role to the scope set used by the read/write route gates. */
export function scopesForRole(role: Role): string[] {
  return SCOPES_BY_ROLE[role] ?? ["emails:read"];
}

export interface AuthServiceDeps {
  authStore: AuthStore;
  verifier: ApiKeyVerifier;
  sender: SelfHostedSender;
  keyStore: SelfHostedKeyStore;
  signingSecret: string;
  rateLimiter: RateLimiter;
  mailer: AuthMailerConfig;
  env?: NodeJS.ProcessEnv;
}

export type ResolveResult =
  | { ok: true; ctx: RequestContext }
  | { ok: false; response: Response };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fail(status: number, message: string, reason: string): { ok: false; response: Response } {
  return { ok: false, response: json(status, { error: message, reason }) };
}

/**
 * Resolve a request to a tenant-bound principal. Dispatches by credential prefix;
 * fails closed on anything unmapped/unknown. `requiredScopes` are enforced
 * uniformly for both credential types.
 */
export async function resolveRequestContext(
  deps: AuthServiceDeps,
  req: Request,
  url: URL,
  requiredScopes: string[],
): Promise<ResolveResult> {
  const token = extractToken(req.headers);
  if (!token) return fail(401, "authentication required", "missing_token");

  if (token.startsWith("hasna_")) {
    const decision = await deps.verifier.authenticate(req.headers, {
      method: req.method,
      path: url.pathname,
      requiredScopes,
    });
    if (!decision.ok) {
      return { ok: false, response: json(decision.status, { error: decision.message, reason: decision.reason }) };
    }
    const tenantId = await deps.authStore.getApiKeyTenant(decision.principal.kid);
    if (!tenantId) return fail(403, "api key is not bound to a tenant", "no_tenant");
    return {
      ok: true,
      ctx: {
        tenantId,
        principalType: "apikey",
        kid: decision.principal.kid,
        scopes: decision.principal.scopes,
      },
    };
  }

  if (token.startsWith("emss_")) {
    const session = await deps.authStore.resolveSession(token);
    if (!session) return fail(401, "session is invalid or expired", "reauthenticate");
    const scopes = scopesForRole(session.role);
    for (const required of requiredScopes) {
      if (!scopes.includes(required)) return fail(403, "insufficient scope for this operation", "insufficient_scope");
    }
    return {
      ok: true,
      ctx: {
        tenantId: session.tenantId,
        principalType: "user",
        userId: session.userId,
        role: session.role,
        globalRole: session.globalRole,
        scopes,
      },
    };
  }

  return fail(401, "unrecognized credential", "malformed");
}

// ---- request helpers ---------------------------------------------------------

const MAX_AUTH_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_AUTH_BODY_BYTES) {
    throw new Error("request body too large");
  }
  const text = await req.text();
  if (text.length > MAX_AUTH_BODY_BYTES) throw new Error("request body too large");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || null;
  return req.headers.get("x-real-ip")?.trim() || null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

function validatePassword(password: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true, value: password };
}

function env(deps: AuthServiceDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

// ---- route dispatcher --------------------------------------------------------

/**
 * Handle an auth/tenant/membership/key route. Returns null when the path is NOT
 * owned by the auth service (so the caller falls through to the resource router).
 */
export async function handleAuthRoutes(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  const isAuthPath =
    path === "/v1/me" || path.startsWith("/v1/me/") ||
    path === "/v1/auth" || path.startsWith("/v1/auth/") ||
    path === "/v1/tenants" || path.startsWith("/v1/tenants/") ||
    path.startsWith("/v1/memberships/") ||
    path === "/v1/invites/accept" ||
    path === "/v1/keys" || path.startsWith("/v1/keys/");
  if (!isAuthPath) return null;

  try {
    // ---- unauthenticated auth endpoints ----------------------------------
    if (path === "/v1/auth/signup" && method === "POST") return await handleSignup(deps, req);
    if (path === "/v1/auth/login" && method === "POST") return await handleLogin(deps, req);
    if (path === "/v1/auth/verify-email" && (method === "POST" || method === "GET")) return await handleVerifyEmail(deps, req, url);
    if (path === "/v1/auth/verify-email/resend" && method === "POST") return await handleVerifyResend(deps, req);
    if (path === "/v1/auth/password/forgot" && method === "POST") return await handleForgot(deps, req);
    if (path === "/v1/auth/password/reset" && method === "POST") return await handleReset(deps, req);
    if (path === "/v1/invites/accept" && method === "POST") return await handleAcceptInvite(deps, req);
    if (path === "/v1/auth/bootstrap-owner" && method === "POST") return await handleBootstrapOwner(deps, req, url);
    if (path === "/v1/auth/bootstrap-super-admin" && method === "POST") return await handleBootstrapSuperAdmin(deps, req, url);

    // ---- session-authenticated endpoints ---------------------------------
    if (path === "/v1/me" && method === "GET") return await handleMe(deps, req, url);
    if (path === "/v1/me/email-identities") {
      if (method === "GET") return await handleListEmailIdentities(deps, req, url);
      if (method === "POST") return await handleAddEmailIdentity(deps, req, url);
    }
    const primaryIdentity = path.match(/^\/v1\/me\/email-identities\/([^/]+)\/primary$/);
    if (primaryIdentity && method === "POST") {
      return await handleMakePrimaryEmailIdentity(deps, req, url, decodeURIComponent(primaryIdentity[1]!));
    }
    const deleteIdentity = path.match(/^\/v1\/me\/email-identities\/([^/]+)$/);
    if (deleteIdentity && method === "DELETE") {
      return await handleDeleteEmailIdentity(deps, req, url, decodeURIComponent(deleteIdentity[1]!));
    }
    if (path === "/v1/auth/logout" && method === "POST") return await handleLogout(deps, req, url);
    if (path === "/v1/auth/logout-all" && method === "POST") return await handleLogoutAll(deps, req, url);
    if (path === "/v1/auth/switch-tenant" && method === "POST") return await handleSwitchTenant(deps, req, url);

    // tenants
    if (path === "/v1/tenants") {
      if (method === "GET") return await handleListTenants(deps, req, url);
      if (method === "POST") return await handleCreateTenant(deps, req, url);
      return json(405, { error: "method not allowed" });
    }
    const tenantMembersMatch = path.match(/^\/v1\/tenants\/([^/]+)\/members$/);
    if (tenantMembersMatch) {
      if (method === "GET") return await handleListMembers(deps, req, url, decodeURIComponent(tenantMembersMatch[1]!));
      return json(405, { error: "method not allowed" });
    }
    const tenantInvitesMatch = path.match(/^\/v1\/tenants\/([^/]+)\/invites$/);
    if (tenantInvitesMatch) {
      const tenantId = decodeURIComponent(tenantInvitesMatch[1]!);
      if (method === "POST") return await handleCreateInvite(deps, req, url, tenantId);
      if (method === "GET") return await handleListInvites(deps, req, url, tenantId);
      return json(405, { error: "method not allowed" });
    }
    const tenantMatch = path.match(/^\/v1\/tenants\/([^/]+)$/);
    if (tenantMatch) {
      const tenantId = decodeURIComponent(tenantMatch[1]!);
      if (method === "GET") return await handleGetTenant(deps, req, url, tenantId);
      if (method === "PATCH" || method === "PUT") return await handleUpdateTenant(deps, req, url, tenantId);
      if (method === "DELETE") return await handleDeleteTenant(deps, req, url, tenantId);
      return json(405, { error: "method not allowed" });
    }

    // memberships
    const membershipMatch = path.match(/^\/v1\/memberships\/([^/]+)$/);
    if (membershipMatch) {
      const membershipId = decodeURIComponent(membershipMatch[1]!);
      if (method === "PATCH" || method === "PUT") return await handleUpdateMembership(deps, req, url, membershipId);
      if (method === "DELETE") return await handleRemoveMembership(deps, req, url, membershipId);
      return json(405, { error: "method not allowed" });
    }

    // tenant-scoped keys
    if (path === "/v1/keys") {
      if (method === "GET") return await handleListKeys(deps, req, url);
      if (method === "POST") return await handleCreateKey(deps, req, url);
      return json(405, { error: "method not allowed" });
    }
    const keyMatch = path.match(/^\/v1\/keys\/([^/]+)$/);
    if (keyMatch) {
      if (method === "DELETE") return await handleRevokeKey(deps, req, url, decodeURIComponent(keyMatch[1]!));
      return json(405, { error: "method not allowed" });
    }

    return json(404, { error: "not found" });
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes("JSON"))) {
      return json(400, { error: "invalid request body" });
    }
    if (err instanceof Error && err.message === "request body too large") {
      return json(413, { error: "request body too large" });
    }
    if (err instanceof LastOwnerError) return json(409, { error: err.message, reason: "last_owner" });
    if (err instanceof SlugTakenError) return json(409, { error: err.message, reason: "slug_taken" });
    if (err instanceof EmailTakenError) return json(409, { error: err.message, reason: "email_taken" });
    console.error("[emails-self-hosted-auth] request failed", {
      path,
      method,
      error: err instanceof Error ? err.name : "UnknownError",
    });
    return json(500, { error: "internal error" });
  }
}

// ---- handlers: signup / login / verify / reset -------------------------------

/**
 * POST /v1/auth/signup — create org + owner (UNVERIFIED) + send confirmation.
 * A1-gated (@hasna only, generic 403). Non-enumerating: a duplicate email and a
 * fresh signup both return the SAME `verification_required` shape; the user must
 * confirm the email then log in (no session is issued at signup — A2).
 */
async function handleSignup(deps: AuthServiceDeps, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const email = str(body.email).toLowerCase();
  const ip = clientIp(req);

  const rl = deps.rateLimiter.checkAll("signup", [ip, email]);
  if (!rl.ok) return retryLater(rl.retryAfterSeconds);

  if (!email || !isAllowedSignupEmail(email, env(deps))) {
    return json(403, { error: "signups are restricted", reason: "email_not_allowed" });
  }
  const pw = validatePassword(body.password);
  if (!pw.ok) return json(400, { error: pw.error });
  const tenantName = str(body.tenant_name);
  if (!tenantName) return json(400, { error: "tenant_name is required" });

  const generic = json(200, { status: "verification_required", email, verification_required: true });

  // Duplicate email: do NOT reveal existence — return the SAME generic response
  // (design §8). Still run the argon2 hash so the response time matches a real
  // signup (no timing oracle for account existence).
  const existing = await deps.authStore.findUserByEmail(email);
  if (existing) {
    await hashPassword(pw.value);
    return generic;
  }

  const passwordHash = await hashPassword(pw.value);
  let created;
  try {
    created = await deps.authStore.createTenantWithOwner({
      email,
      passwordHash,
      name: str(body.name) || null,
      tenantName,
      tenantSlug: str(body.tenant_slug) || null,
    });
  } catch (err) {
    // Lost a race on the unique email — collapse to the generic response.
    if (err instanceof EmailTakenError) return generic;
    throw err;
  }

  // Best-effort per-tenant agent-settings seed (see AuthStore note re: 0013).
  await deps.authStore.seedTenantAgentSettings(created.tenant.id);

  // A2: send the confirmation email through the app's SES path. NEVER block on a
  // transient failure — the token is persisted; a resend is available.
  const verification = await deps.authStore.createEmailVerification(created.user.id, email);
  await sendVerificationEmail(deps.sender, deps.mailer, email, verification.token);
  return generic;
}

/**
 * POST /v1/auth/login — verify credentials (constant-time for unknown email),
 * enforce @hasna gate (A1) + lockout + email-verified gate (A2), then mint a
 * session for the chosen/only tenant. Multi-tenant users without a `tenant_slug`
 * get `{needs_tenant:true, tenants:[…]}` and no session.
 */
async function handleLogin(deps: AuthServiceDeps, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const email = str(body.email).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const ip = clientIp(req);

  const rl = deps.rateLimiter.checkAll("login", [ip, email]);
  if (!rl.ok) return retryLater(rl.retryAfterSeconds);

  if (!email || !isAllowedSignupEmail(email, env(deps))) {
    return json(403, { error: "login is restricted", reason: "email_not_allowed" });
  }

  const user = await deps.authStore.findUserByEmail(email);
  if (user && (await deps.authStore.isLocked(user))) {
    return json(429, { error: "too many attempts; try again later", reason: "locked" });
  }

  // Constant-time verify (dummy hash for unknown email) + rehash-on-drift.
  const ok = await verifyPasswordOrEqualizeTiming(password, user?.password_hash ?? null);
  if (!ok || !user || user.status !== "active") {
    if (user) await deps.authStore.recordFailedLogin(user.id);
    return json(401, { error: "invalid email or password", reason: "invalid_credentials" });
  }
  if (needsRehash(user.password_hash)) {
    await deps.authStore.setPasswordHash(user.id, await hashPassword(password));
  }

  // A2: refuse login until the email is confirmed.
  if (!user.login_email_verified_at) {
    return json(403, { error: "email is not verified", reason: "email_unverified" });
  }

  await deps.authStore.clearFailedLogins(user.id);
  deps.rateLimiter.reset("login", email);

  const memberships = await deps.authStore.listTenantsForUser(user.id);
  if (memberships.length === 0) {
    return json(403, { error: "your account is not a member of any organization", reason: "no_tenant" });
  }

  const slug = str(body.tenant_slug).toLowerCase();
  let chosen = memberships[0]!;
  if (slug) {
    const match = memberships.find((m) => m.slug === slug);
    if (!match) return json(403, { error: "you are not a member of that organization", reason: "not_a_member" });
    chosen = match;
  } else if (memberships.length > 1) {
    return json(200, {
      needs_tenant: true,
      tenants: memberships.map((m) => ({ slug: m.slug, name: m.name, role: m.role })),
    });
  }

  const session = await deps.authStore.createSession(user.id, chosen.id, {
    userAgent: req.headers.get("user-agent"),
    ip,
  });
  return json(200, {
    session_token: session.token,
    expires_at: session.expiresAt,
    user: toPublicUser(user),
    tenant: { id: chosen.id, slug: chosen.slug, name: chosen.name, status: chosen.status },
    role: chosen.role,
  });
}

/** POST/GET /v1/auth/verify-email — consume a token, mark the user verified. */
async function handleVerifyEmail(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  let token = "";
  if (req.method.toUpperCase() === "GET") {
    token = str(url.searchParams.get("token"));
  } else {
    const body = await readJsonBody(req);
    token = str(body.token);
  }
  if (!token) return json(400, { error: "token is required" });
  const user = await deps.authStore.consumeEmailVerification(token);
  if (!user) return json(400, { error: "verification link is invalid or expired", reason: "invalid_token" });
  return json(200, { verified: true, user: toPublicUser(user) });
}

/**
 * POST /v1/auth/verify-email/resend — reissue a confirmation email. Non-
 * enumerating: always returns the same generic 200. Only actually sends when the
 * email maps to an unverified @hasna user.
 */
async function handleVerifyResend(deps: AuthServiceDeps, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const email = str(body.email).toLowerCase();
  const ip = clientIp(req);
  const rl = deps.rateLimiter.checkAll("verify-resend", [ip, email]);
  if (!rl.ok) return retryLater(rl.retryAfterSeconds);

  const generic = json(200, { status: "verification_required", verification_required: true });
  if (!email || !isAllowedSignupEmail(email, env(deps))) return generic;
  const user = await deps.authStore.findUserByEmail(email);
  if (user && !user.email_verified_at) {
    const verification = await deps.authStore.createEmailVerification(user.id, email);
    await sendVerificationEmail(deps.sender, deps.mailer, email, verification.token);
  }
  return generic;
}

/** POST /v1/auth/password/forgot — always 200 (no enumeration); emails the token. */
async function handleForgot(deps: AuthServiceDeps, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const email = str(body.email).toLowerCase();
  const ip = clientIp(req);
  const rl = deps.rateLimiter.checkAll("forgot", [ip, email]);
  if (!rl.ok) return retryLater(rl.retryAfterSeconds);

  const generic = json(200, { status: "reset_requested" });
  if (!email || !isAllowedSignupEmail(email, env(deps))) return generic;
  const user = await deps.authStore.findUserByEmail(email);
  if (user && user.status === "active" && user.login_email_verified_at) {
    const reset = await deps.authStore.createPasswordReset(user.id);
    // M7: token is emailed, never logged.
    await sendPasswordResetEmail(deps.sender, deps.mailer, email, reset.token);
  }
  return generic;
}

/** POST /v1/auth/password/reset — consume token, rehash, revoke all sessions. */
async function handleReset(deps: AuthServiceDeps, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const token = str(body.token);
  const ip = clientIp(req);
  const rl = deps.rateLimiter.checkAll("reset", [ip]);
  if (!rl.ok) return retryLater(rl.retryAfterSeconds);
  if (!token) return json(400, { error: "token is required" });
  const pw = validatePassword(body.new_password);
  if (!pw.ok) return json(400, { error: pw.error });
  const passwordHash = await hashPassword(pw.value);
  const done = await deps.authStore.consumePasswordReset(token, passwordHash);
  if (!done) return json(400, { error: "reset link is invalid or expired", reason: "invalid_token" });
  return json(200, { reset: true });
}

/** POST /v1/invites/accept — join a tenant via invite; creates the user if new. */
async function handleAcceptInvite(deps: AuthServiceDeps, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const token = str(body.token);
  if (!token) return json(400, { error: "token is required" });

  // Pre-resolve so we can validate a required password shape without a wasted txn.
  const invite = await deps.authStore.resolveInvitation(token);
  if (!invite) return json(400, { error: "invitation is invalid or expired", reason: "invalid_token" });

  let passwordHash: string | null = null;
  const existing = await deps.authStore.findUserByEmail(invite.email);
  if (!existing) {
    const pw = validatePassword(body.password);
    if (!pw.ok) return json(400, { error: pw.error, reason: "needs_password" });
    passwordHash = await hashPassword(pw.value);
  }

  const result = await deps.authStore.acceptInvitation({ token, passwordHash, name: str(body.name) || null });
  if ("error" in result) {
    if (result.error === "needs_password") return json(400, { error: "a password is required", reason: "needs_password" });
    return json(400, { error: "invitation is invalid or expired", reason: "invalid_token" });
  }
  const tenant = await deps.authStore.getTenantById(result.tenantId);
  const session = await deps.authStore.createSession(result.user.id, result.tenantId, {
    userAgent: req.headers.get("user-agent"),
    ip: clientIp(req),
  });
  return json(200, {
    session_token: session.token,
    expires_at: session.expiresAt,
    user: toPublicUser(result.user),
    tenant: tenant ? toPublicTenant(tenant) : null,
    role: result.role,
  });
}

/**
 * POST /v1/auth/bootstrap-owner — API-KEY-ONLY migration bridge: the deployed
 * operator (holding the default-tenant key) creates the first owner user so they
 * can start logging in. Refuses if the tenant already has an owner.
 */
async function handleBootstrapOwner(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  if (resolved.ctx.principalType !== "apikey") {
    return json(403, { error: "bootstrap requires an api key", reason: "apikey_required" });
  }
  const body = await readJsonBody(req);
  const email = str(body.email).toLowerCase();
  if (!email || !isAllowedSignupEmail(email, env(deps))) {
    return json(403, { error: "owner email is restricted", reason: "email_not_allowed" });
  }
  const pw = validatePassword(body.password);
  if (!pw.ok) return json(400, { error: pw.error });
  const passwordHash = await hashPassword(pw.value);
  const result = await deps.authStore.bootstrapOwner({
    tenantId: resolved.ctx.tenantId,
    email,
    passwordHash,
    name: str(body.name) || null,
  });
  if ("error" in result) {
    if (result.error === "exists") return json(409, { error: "this tenant already has an owner", reason: "owner_exists" });
    return json(409, { error: "an account with that email already exists", reason: "email_taken" });
  }
  const tenant = await deps.authStore.getTenantById(resolved.ctx.tenantId);
  await deps.authStore.seedTenantAgentSettings(resolved.ctx.tenantId);
  return json(201, { user: toPublicUser(result.user), tenant: tenant ? toPublicTenant(tenant) : null });
}

/** Normalize the non-secret operator setting used to pin primary bootstrap. */
export function configuredPrimarySuperAdminEmail(source: NodeJS.ProcessEnv): string | null {
  const value = source["EMAILS_PRIMARY_SUPER_ADMIN_EMAIL"]?.trim().toLowerCase() ?? "";
  return value && /^[^@\s]+@[^@\s]+$/.test(value) ? value : null;
}

/** Pin bootstrap to one operator-managed API-key identifier (the KID is not secret). */
export function configuredPrimarySuperAdminBootstrapKid(source: NodeJS.ProcessEnv): string | null {
  const value = source["EMAILS_PRIMARY_SUPER_ADMIN_BOOTSTRAP_KID"]?.trim() ?? "";
  return value || null;
}

/**
 * POST /v1/auth/bootstrap-super-admin — operator API-key-only, idempotent, and
 * pinned to EMAILS_PRIMARY_SUPER_ADMIN_EMAIL. Email matching is not itself an
 * authorization mechanism; the verified mapped API key remains mandatory.
 */
async function handleBootstrapSuperAdmin(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  if (resolved.ctx.principalType !== "apikey" || !resolved.ctx.kid) {
    return json(403, { error: "bootstrap requires an operator api key", reason: "apikey_required" });
  }
  const configuredEmail = configuredPrimarySuperAdminEmail(env(deps));
  const configuredActorKid = configuredPrimarySuperAdminBootstrapKid(env(deps));
  if (!configuredEmail || !configuredActorKid) {
    return json(503, { error: "primary super-admin bootstrap is not configured", reason: "bootstrap_not_configured" });
  }
  if (resolved.ctx.kid !== configuredActorKid) {
    return json(403, { error: "api key is not authorized for primary bootstrap", reason: "bootstrap_key_forbidden" });
  }
  const body = await readJsonBody(req);
  const requestedEmail = str(body.email).toLowerCase();
  if (requestedEmail && requestedEmail !== configuredEmail) {
    return json(403, { error: "bootstrap email does not match operator configuration", reason: "email_mismatch" });
  }
  const pw = validatePassword(body.password);
  if (!pw.ok) return json(400, { error: pw.error });
  const result = await deps.authStore.bootstrapPrimarySuperAdmin({
    tenantId: resolved.ctx.tenantId,
    email: configuredEmail,
    passwordHash: await hashPassword(pw.value),
    actorKid: resolved.ctx.kid,
    name: str(body.name) || null,
  });
  if ("error" in result) {
    return json(409, { error: "a different primary super-admin already exists", reason: result.error });
  }
  const tenant = await deps.authStore.getTenantById(resolved.ctx.tenantId);
  await deps.authStore.seedTenantAgentSettings(resolved.ctx.tenantId);
  return json(result.created ? 201 : 200, {
    created: result.created,
    user: toPublicUser(result.user),
    tenant: tenant ? toPublicTenant(tenant) : null,
  });
}

// ---- handlers: session lifecycle + me ---------------------------------------

async function handleLogout(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, []);
  if (!resolved.ok) return resolved.response;
  if (resolved.ctx.principalType !== "user") return json(400, { error: "not a session", reason: "not_session" });
  const token = extractToken(req.headers);
  if (token) await deps.authStore.revokeSessionByToken(token);
  return json(200, { logged_out: true });
}

async function handleLogoutAll(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, []);
  if (!resolved.ok) return resolved.response;
  if (resolved.ctx.principalType !== "user" || !resolved.ctx.userId) {
    return json(400, { error: "not a session", reason: "not_session" });
  }
  await deps.authStore.revokeAllUserSessions(resolved.ctx.userId);
  return json(200, { logged_out: true });
}

async function handleMe(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:read"]);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  const tenant = await deps.authStore.getTenantById(ctx.tenantId);
  if (ctx.principalType === "apikey") {
    return json(200, {
      principal_type: "apikey",
      kid: ctx.kid,
      tenant: tenant ? toPublicTenant(tenant) : { id: ctx.tenantId },
      scopes: ctx.scopes,
    });
  }
  const user = ctx.userId ? await deps.authStore.getUserById(ctx.userId) : null;
  const memberships = ctx.userId ? await deps.authStore.listTenantsForUser(ctx.userId) : [];
  const emailIdentities = ctx.userId ? await deps.authStore.listUserEmailIdentities(ctx.userId) : [];
  return json(200, {
    principal_type: "user",
    user: user ? toPublicUser(user) : null,
    tenant: tenant ? toPublicTenant(tenant) : { id: ctx.tenantId },
    role: ctx.role,
    scopes: ctx.scopes,
    memberships: memberships.map((m) => ({ tenant_id: m.id, slug: m.slug, name: m.name, role: m.role })),
    email_identities: emailIdentities.map((identity) => ({
      id: identity.id,
      email: identity.email,
      is_primary: identity.is_primary,
      verified: identity.verified_at !== null,
    })),
  });
}

async function requireUserSession(deps: AuthServiceDeps, req: Request, url: URL, write: boolean) {
  const resolved = await resolveRequestContext(deps, req, url, [write ? "emails:write" : "emails:read"]);
  if (!resolved.ok) return resolved;
  if (resolved.ctx.principalType !== "user" || !resolved.ctx.userId) {
    return { ok: false as const, response: json(403, { error: "session required", reason: "session_required" }) };
  }
  return resolved as typeof resolved & { ctx: RequestContext & { userId: string } };
}

async function handleListEmailIdentities(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const auth = await requireUserSession(deps, req, url, false);
  if (!auth.ok) return auth.response;
  const identities = await deps.authStore.listUserEmailIdentities(auth.ctx.userId);
  return json(200, {
    email_identities: identities.map((identity) => ({
      id: identity.id,
      email: identity.email,
      is_primary: identity.is_primary,
      verified: identity.verified_at !== null,
      created_at: identity.created_at,
    })),
  });
}

async function handleAddEmailIdentity(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const auth = await requireUserSession(deps, req, url, true);
  if (!auth.ok) return auth.response;
  const body = await readJsonBody(req);
  const email = str(body.email).toLowerCase();
  if (!email || !isAllowedSignupEmail(email, env(deps))) {
    return json(403, { error: "that email domain is not allowed", reason: "email_not_allowed" });
  }
  const existing = await deps.authStore.findUserByEmail(email);
  if (existing) return json(409, { error: "email identity is already registered", reason: "email_taken" });
  const identity = await deps.authStore.addUserEmailIdentity(auth.ctx.userId, email);
  const verification = await deps.authStore.createEmailVerification(auth.ctx.userId, email);
  await sendVerificationEmail(deps.sender, deps.mailer, email, verification.token);
  return json(201, {
    email_identity: { id: identity.id, email: identity.email, is_primary: false, verified: false },
    verification_required: true,
  });
}

async function handleMakePrimaryEmailIdentity(
  deps: AuthServiceDeps,
  req: Request,
  url: URL,
  identityId: string,
): Promise<Response> {
  const auth = await requireUserSession(deps, req, url, true);
  if (!auth.ok) return auth.response;
  const identity = await deps.authStore.makePrimaryEmailIdentity(auth.ctx.userId, identityId);
  if (!identity) return json(409, { error: "email identity must exist and be verified", reason: "identity_unverified" });
  return json(200, { email_identity: { id: identity.id, email: identity.email, is_primary: true, verified: true } });
}

async function handleDeleteEmailIdentity(
  deps: AuthServiceDeps,
  req: Request,
  url: URL,
  identityId: string,
): Promise<Response> {
  const auth = await requireUserSession(deps, req, url, true);
  if (!auth.ok) return auth.response;
  const removed = await deps.authStore.removeUserEmailIdentity(auth.ctx.userId, identityId);
  return removed
    ? json(200, { removed: true, id: identityId })
    : json(409, { error: "primary or unknown email identity cannot be removed", reason: "identity_not_removable" });
}

async function handleSwitchTenant(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:read"]);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  if (ctx.principalType !== "user" || !ctx.userId) return json(400, { error: "not a session", reason: "not_session" });
  const body = await readJsonBody(req);
  const slug = str(body.tenant_slug).toLowerCase();
  if (!slug) return json(400, { error: "tenant_slug is required" });
  const tenant = await deps.authStore.getTenantBySlug(slug);
  if (!tenant || tenant.status !== "active") return json(404, { error: "organization not found", reason: "not_found" });
  const membership = await deps.authStore.getMembership(ctx.userId, tenant.id);
  if (!membership) return json(403, { error: "you are not a member of that organization", reason: "not_a_member" });
  // Rotate: revoke the old session, mint one bound to the new tenant.
  const token = extractToken(req.headers);
  if (token) await deps.authStore.revokeSessionByToken(token);
  const session = await deps.authStore.createSession(ctx.userId, tenant.id, {
    userAgent: req.headers.get("user-agent"),
    ip: clientIp(req),
  });
  return json(200, {
    session_token: session.token,
    expires_at: session.expiresAt,
    tenant: toPublicTenant(tenant),
    role: membership.role,
  });
}

// ---- handlers: tenants + memberships ----------------------------------------

/** Load the caller's active membership in a specific tenant (session principals only). */
async function callerMembership(deps: AuthServiceDeps, ctx: RequestContext, tenantId: string) {
  if (ctx.principalType !== "user" || !ctx.userId) return null;
  return deps.authStore.getMembership(ctx.userId, tenantId);
}

async function handleListTenants(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:read"]);
  if (!resolved.ok) return resolved.response;
  if (resolved.ctx.principalType !== "user" || !resolved.ctx.userId) {
    return json(403, { error: "session required", reason: "session_required" });
  }
  const tenants = await deps.authStore.listTenantsForUser(resolved.ctx.userId);
  return json(200, { tenants: tenants.map((t) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status, role: t.role })) });
}

async function handleCreateTenant(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  if (resolved.ctx.principalType !== "user" || !resolved.ctx.userId) {
    return json(403, { error: "only a user can create an organization", reason: "session_required" });
  }
  const body = await readJsonBody(req);
  const name = str(body.name);
  if (!name) return json(400, { error: "name is required" });
  const { tenant, membership } = await deps.authStore.createTenantForUser(resolved.ctx.userId, name, str(body.slug) || null);
  await deps.authStore.seedTenantAgentSettings(tenant.id);
  return json(201, { tenant: toPublicTenant(tenant), role: membership.role });
}

async function handleGetTenant(deps: AuthServiceDeps, req: Request, url: URL, tenantId: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:read"]);
  if (!resolved.ok) return resolved.response;
  const membership = await callerMembership(deps, resolved.ctx, tenantId);
  // A key may read its own tenant; a user must be a member.
  const keyOwnsTenant = resolved.ctx.principalType === "apikey" && resolved.ctx.tenantId === tenantId;
  if (!membership && !keyOwnsTenant) return json(404, { error: "organization not found", reason: "not_found" });
  const tenant = await deps.authStore.getTenantById(tenantId);
  if (!tenant) return json(404, { error: "organization not found", reason: "not_found" });
  return json(200, { tenant: toPublicTenant(tenant), role: membership?.role });
}

async function handleUpdateTenant(deps: AuthServiceDeps, req: Request, url: URL, tenantId: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  const membership = await callerMembership(deps, resolved.ctx, tenantId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  const body = await readJsonBody(req);
  const patch: { name?: string; slug?: string; status?: string } = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.slug === "string") patch.slug = body.slug;
  // Only an owner may change status (suspend/reactivate).
  if (typeof body.status === "string") {
    if (membership.role !== "owner") return json(403, { error: "owner required to change status", reason: "forbidden" });
    patch.status = body.status;
  }
  const tenant = await deps.authStore.updateTenant(tenantId, patch);
  return tenant ? json(200, { tenant: toPublicTenant(tenant) }) : json(404, { error: "organization not found" });
}

async function handleDeleteTenant(deps: AuthServiceDeps, req: Request, url: URL, tenantId: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  const membership = await callerMembership(deps, resolved.ctx, tenantId);
  if (!membership || membership.role !== "owner") {
    return json(403, { error: "owner required", reason: "forbidden" });
  }
  const done = await deps.authStore.suspendTenant(tenantId);
  return done ? json(200, { suspended: true, id: tenantId }) : json(404, { error: "organization not found" });
}

async function handleListMembers(deps: AuthServiceDeps, req: Request, url: URL, tenantId: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:read"]);
  if (!resolved.ok) return resolved.response;
  const membership = await callerMembership(deps, resolved.ctx, tenantId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  const members = await deps.authStore.listMemberships(tenantId);
  return json(200, {
    members: members.map((m) => ({
      id: m.id,
      user_id: m.user_id,
      email: m.email,
      name: m.name,
      role: m.role,
      status: m.status,
      created_at: m.created_at,
    })),
  });
}

async function handleCreateInvite(deps: AuthServiceDeps, req: Request, url: URL, tenantId: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  const membership = await callerMembership(deps, resolved.ctx, tenantId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  const body = await readJsonBody(req);
  const email = str(body.email).toLowerCase();
  if (!email) return json(400, { error: "email is required" });
  // A1 also applies to invites (cannot invite a non-hasna address).
  if (!isAllowedSignupEmail(email, env(deps))) {
    return json(403, { error: "that email domain is not allowed", reason: "email_not_allowed" });
  }
  const roleRaw = str(body.role) || "member";
  // The invitations CHECK (migration 0012) permits only owner/admin/member — a
  // 'viewer' invite would otherwise fail closed as a 500. And only an OWNER may
  // invite another OWNER (an admin cannot mint owners — see H1).
  if (roleRaw !== "owner" && roleRaw !== "admin" && roleRaw !== "member") {
    return json(400, { error: "invalid role; must be owner, admin, or member" });
  }
  if (roleRaw === "owner" && membership.role !== "owner") {
    return json(403, { error: "only an owner can invite an owner", reason: "forbidden" });
  }
  const rl = deps.rateLimiter.checkAll("invite", [tenantId]);
  if (!rl.ok) return retryLater(rl.retryAfterSeconds);
  const invite = await deps.authStore.createInvitation({
    tenantId,
    email,
    role: roleRaw as Role,
    invitedBy: resolved.ctx.userId ?? null,
  });
  const tenant = await deps.authStore.getTenantById(tenantId);
  await sendInvitationEmail(deps.sender, deps.mailer, email, invite.token, tenant?.name ?? "your organization");
  return json(201, { invited: true, email, role: roleRaw, expires_at: invite.expiresAt });
}

async function handleListInvites(deps: AuthServiceDeps, req: Request, url: URL, tenantId: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:read"]);
  if (!resolved.ok) return resolved.response;
  const membership = await callerMembership(deps, resolved.ctx, tenantId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  const invites = await deps.authStore.listInvitations(tenantId);
  return json(200, { invites });
}

async function handleUpdateMembership(deps: AuthServiceDeps, req: Request, url: URL, membershipId: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  const target = await deps.authStore.getMembershipById(membershipId);
  if (!target) return json(404, { error: "membership not found", reason: "not_found" });
  const membership = await callerMembership(deps, resolved.ctx, target.tenant_id);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  const body = await readJsonBody(req);
  const roleRaw = str(body.role);
  if (!isRole(roleRaw)) return json(400, { error: "invalid role" });
  // H1: the owner role is a privilege boundary. Only an OWNER may grant `owner`
  // or modify an existing owner's membership — otherwise an admin could
  // self-promote to owner (PATCH own membership) or demote the founding owner.
  if ((roleRaw === "owner" || target.role === "owner") && membership.role !== "owner") {
    return json(403, { error: "only an owner can grant or modify the owner role", reason: "forbidden" });
  }
  const updated = await deps.authStore.changeMembershipRole(membershipId, roleRaw);
  return updated ? json(200, { membership: { id: updated.id, role: updated.role, status: updated.status } }) : json(404, { error: "membership not found" });
}

async function handleRemoveMembership(deps: AuthServiceDeps, req: Request, url: URL, membershipId: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  const target = await deps.authStore.getMembershipById(membershipId);
  if (!target) return json(404, { error: "membership not found", reason: "not_found" });
  const membership = await callerMembership(deps, resolved.ctx, target.tenant_id);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  // H1: only an owner may remove an owner (an admin cannot evict an owner).
  if (target.role === "owner" && membership.role !== "owner") {
    return json(403, { error: "only an owner can remove an owner", reason: "forbidden" });
  }
  const result = await deps.authStore.removeMembership(membershipId);
  return result.removed ? json(200, { removed: true, id: membershipId }) : json(404, { error: "membership not found" });
}

// ---- handlers: tenant-scoped API keys (WI-2e) -------------------------------

async function handleCreateKey(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  // Only an owner/admin USER may mint tenant keys (a key minting keys is disallowed).
  if (ctx.principalType !== "user" || !ctx.userId || (ctx.role !== "owner" && ctx.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  const body = await readJsonBody(req);
  const scopes = Array.isArray(body.scopes) ? body.scopes.map((s) => String(s)) : undefined;
  const ttlDays = body.ttl_days === null ? null : typeof body.ttl_days === "number" ? body.ttl_days : undefined;
  let minted;
  try {
    minted = await issueSelfHostedApiKey(deps.keyStore, deps.signingSecret, {
      scopes,
      ttlDays,
      agent: ctx.tenantId,
      createdBy: ctx.userId,
    });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : "could not mint key" });
  }
  await deps.authStore.bindApiKeyTenant(minted.kid, ctx.tenantId, ctx.userId);
  // Token returned ONCE.
  return json(201, {
    token: minted.token,
    kid: minted.kid,
    scopes: minted.claims.scopes,
    expires_at: minted.claims.exp ? new Date(minted.claims.exp * 1000).toISOString() : null,
  });
}

async function handleListKeys(deps: AuthServiceDeps, req: Request, url: URL): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:read"]);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  if (ctx.principalType !== "user" || (ctx.role !== "owner" && ctx.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  const keys = await deps.authStore.listApiKeysForTenant(ctx.tenantId);
  return json(200, { keys });
}

async function handleRevokeKey(deps: AuthServiceDeps, req: Request, url: URL, kid: string): Promise<Response> {
  const resolved = await resolveRequestContext(deps, req, url, ["emails:write"]);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  if (ctx.principalType !== "user" || (ctx.role !== "owner" && ctx.role !== "admin")) {
    return json(403, { error: "owner or admin required", reason: "forbidden" });
  }
  // Only revoke a key that belongs to THIS tenant.
  if (!(await deps.authStore.apiKeyBelongsToTenant(kid, ctx.tenantId))) {
    return json(404, { error: "key not found", reason: "not_found" });
  }
  const done = await revokeSelfHostedApiKey(deps.keyStore, kid, "revoked by tenant admin");
  return done ? json(200, { revoked: true, kid }) : json(404, { error: "key not found" });
}

function retryLater(seconds: number): Response {
  return new Response(JSON.stringify({ error: "too many requests", reason: "rate_limited", retry_after: seconds }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(seconds) },
  });
}

/** Build the default auth deps from the environment (used by serve.ts). */
export function buildAuthMailer(env: NodeJS.ProcessEnv = process.env): AuthMailerConfig {
  return buildAuthMailerConfig(env);
}
