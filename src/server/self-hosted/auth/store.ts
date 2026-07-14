// Identity data layer for self-hosted user accounts + multi-tenancy (WI-2a).
//
// Design ref: docs/design/multi-tenancy-auth.md §3 (data model), §4 (auth), §5
// (API), Addendum A2 (email confirmation). This owns CRUD for the NON-tenant-
// scoped identity tables (tenants/users/memberships/sessions/api_key_tenants/
// invitations/password_reset_tokens/email_verification_tokens) plus the two
// resolution primitives the request pipeline needs: `getApiKeyTenant(kid)` and
// `resolveSession(token)`.
//
// These tables are read BEFORE a tenant is known (they resolve it) and they hold
// secrets (password_hash, token_hash). They are deliberately ABSENT from
// SELF_HOSTED_RESOURCES, so the generic /v1 SELECT * layer can never reach them,
// exactly as send_key_secrets is handled. Only sha256 hashes are stored for
// sessions/reset/invite/verify tokens; the plaintext is returned once at mint.

import type { PoolQueryClient, TypedQueryClient } from "../../../storage-kit/index.js";
import {
  hashPassword,
  needsRehash,
  verifyPasswordOrEqualizeTiming,
} from "./password.js";
import {
  hashToken,
  mintSessionToken,
  mintResetToken,
  mintInviteToken,
  mintEmailVerifyToken,
} from "./tokens.js";

export type Role = "owner" | "admin" | "member" | "viewer";
export type GlobalRole = "user" | "super_admin";
export const ROLES: readonly Role[] = ["owner", "admin", "member", "viewer"];
/** Roles that may be assigned via invite/membership APIs (viewer is read-only, still assignable). */
export const ASSIGNABLE_ROLES: readonly Role[] = ["owner", "admin", "member", "viewer"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  status: string;
  email_verified_at: string | null;
  global_role: GlobalRole;
  is_primary_super_admin: boolean;
  failed_login_count: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  /** Verification state of the identity used for an email lookup/login. */
  login_email_verified_at?: string | null;
}

/** Safe user projection (NEVER carries password_hash). */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  status: string;
  email_verified: boolean;
  global_role: GlobalRole;
  is_primary_super_admin: boolean;
  created_at: string;
}

export interface MembershipRow {
  id: string;
  user_id: string;
  tenant_id: string;
  role: Role;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SessionContext {
  sessionId: string;
  userId: string;
  tenantId: string;
  role: Role;
  globalRole: GlobalRole;
}

export interface UserEmailIdentity {
  id: string;
  user_id: string;
  email: string;
  is_primary: boolean;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: string;
  absoluteExpiresAt: string;
}

export interface MintedTokenResult {
  token: string;
  id: string;
  expiresAt: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    email_verified: row.email_verified_at !== null,
    global_role: row.global_role ?? "user",
    is_primary_super_admin: row.is_primary_super_admin ?? false,
    created_at: row.created_at,
  };
}

export function toPublicTenant(row: TenantRow): { id: string; slug: string; name: string; status: string } {
  return { id: row.id, slug: row.slug, name: row.name, status: row.status };
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Lowercase a slug candidate to the `[a-z0-9-]` grammar; empty -> random. */
export function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
  return base || `org-${randomSuffix()}`;
}

function randomSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

export interface AuthStoreOptions {
  /** Clock override for tests (expiry / lockout). */
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export class LastOwnerError extends Error {
  constructor() {
    super("a tenant must always retain at least one active owner");
    this.name = "LastOwnerError";
  }
}

export class SlugTakenError extends Error {
  constructor(public readonly slug: string) {
    super(`tenant slug '${slug}' is already taken`);
    this.name = "SlugTakenError";
  }
}

export class EmailTakenError extends Error {
  constructor() {
    super("an account with that email already exists");
    this.name = "EmailTakenError";
  }
}

export class AuthStore {
  private readonly now: () => Date;
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly resetTtlMs: number;
  private readonly inviteTtlMs: number;
  private readonly verifyTtlMs: number;

  constructor(private readonly client: PoolQueryClient, options: AuthStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    const env = options.env ?? process.env;
    this.idleTtlMs = envInt(env, "EMAILS_SESSION_IDLE_TTL_DAYS", 14) * 86_400_000;
    this.absoluteTtlMs = envInt(env, "EMAILS_SESSION_ABSOLUTE_TTL_DAYS", 90) * 86_400_000;
    this.resetTtlMs = envInt(env, "EMAILS_RESET_TTL_MINUTES", 60) * 60_000;
    this.inviteTtlMs = envInt(env, "EMAILS_INVITE_TTL_HOURS", 168) * 3_600_000;
    this.verifyTtlMs = envInt(env, "EMAILS_EMAIL_VERIFY_TTL_HOURS", 24) * 3_600_000;
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  // ---- resolution primitives (used by resolveRequestContext) ---------------

  /**
   * Map a verified API key id to its (ACTIVE) tenant. Missing mapping OR a
   * suspended/inactive tenant -> null (fail closed). The tenant-status join
   * mirrors resolveSession, so suspending a tenant locks out its API keys too —
   * otherwise a "deleted" (suspended) tenant's machine credentials keep working.
   */
  async getApiKeyTenant(kid: string): Promise<string | null> {
    const row = await this.client.get<{ tenant_id: string }>(
      `SELECT akt.tenant_id
         FROM api_key_tenants akt
         JOIN tenants t ON t.id = akt.tenant_id
        WHERE akt.kid = $1 AND t.status = 'active'`,
      [kid],
    );
    return row?.tenant_id ?? null;
  }

  /**
   * Resolve an opaque session token to its live {user, tenant, role}. Validates
   * not-revoked + within idle/absolute expiry + active user/tenant/membership,
   * then SLIDES the idle window (updates expires_at + last_used_at, capped by the
   * absolute expiry). Returns null for anything invalid/expired (caller -> 401).
   */
  async resolveSession(token: string): Promise<SessionContext | null> {
    const tokenHash = hashToken(token);
    const nowIso = this.iso();
    const row = await this.client.get<{
      session_id: string;
      user_id: string;
      tenant_id: string;
      role: Role;
      global_role: GlobalRole;
      absolute_expires_at: string;
    }>(
      `SELECT s.id AS session_id, s.user_id, s.tenant_id, m.role, u.global_role, s.absolute_expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN tenants t ON t.id = s.tenant_id
         JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > $2::timestamptz
          AND s.absolute_expires_at > $2::timestamptz
          AND u.status = 'active'
          AND t.status = 'active'
          AND m.status = 'active'`,
      [tokenHash, nowIso],
    );
    if (!row) return null;
    // Slide the idle window, never past the absolute cap.
    const proposed = this.now().getTime() + this.idleTtlMs;
    const absoluteMs = new Date(row.absolute_expires_at).getTime();
    const nextExpiry = new Date(Math.min(proposed, absoluteMs)).toISOString();
    await this.client.execute(
      `UPDATE sessions SET expires_at = $2::timestamptz, last_used_at = now() WHERE id = $1`,
      [row.session_id, nextExpiry],
    );
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      role: row.role,
      globalRole: row.global_role ?? "user",
    };
  }

  // ---- users ---------------------------------------------------------------

  async findUserByEmail(email: string): Promise<UserRow | null> {
    return this.client.get<UserRow>(
      `SELECT u.*, i.verified_at AS login_email_verified_at FROM users u
       JOIN user_email_identities i ON i.user_id = u.id
       WHERE i.email = $1`,
      [email.trim()],
    );
  }

  async getUserById(id: string): Promise<UserRow | null> {
    return this.client.get<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  }

  /**
   * Verify a login password with constant-time behavior for unknown emails
   * (design §8): a dummy argon2 verify runs when the user is absent so timing does
   * not leak account existence. Also opportunistically rehashes on param drift.
   * Returns the user on success, else null. Does NOT touch lockout counters — the
   * caller (login handler) owns lockout policy.
   */
  async verifyLogin(email: string, password: string): Promise<UserRow | null> {
    const user = await this.findUserByEmail(email);
    const ok = await verifyPasswordOrEqualizeTiming(password, user?.password_hash ?? null);
    if (!ok || !user) return null;
    if (user.status !== "active") return null;
    if (needsRehash(user.password_hash)) {
      const rehashed = await hashPassword(password);
      await this.client.execute(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [user.id, rehashed]);
    }
    return user;
  }

  async isLocked(user: UserRow): Promise<boolean> {
    if (!user.locked_until) return false;
    return new Date(user.locked_until).getTime() > this.now().getTime();
  }

  /** Escalating lockout: bump the counter, lock for a growing window past a threshold. */
  async recordFailedLogin(userId: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) return;
    const count = (user.failed_login_count ?? 0) + 1;
    // 5 strikes -> 5 min; doubles each additional strike, capped at 60 min.
    let lockedUntil: string | null = null;
    if (count >= 5) {
      const minutes = Math.min(60, 5 * 2 ** (count - 5));
      lockedUntil = this.iso(minutes * 60_000);
    }
    await this.client.execute(
      `UPDATE users SET failed_login_count = $2, locked_until = $3::timestamptz, updated_at = now() WHERE id = $1`,
      [userId, count, lockedUntil],
    );
  }

  async clearFailedLogins(userId: string): Promise<void> {
    await this.client.execute(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [userId],
    );
  }

  /** Set a new (already-hashed) password — used for rehash-on-login param drift. */
  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.client.execute(
      `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
      [userId, passwordHash],
    );
  }

  // ---- signup (transactional: tenant + owner user + membership) ------------

  /**
   * Create a brand-new org with its first owner, in ONE transaction. The user is
   * created UNVERIFIED (email_verified_at NULL) per Addendum A2 — login is refused
   * until a verification token is consumed. Does NOT mint a session (no access
   * before verification). `passwordHash` must already be argon2id-hashed.
   */
  async createTenantWithOwner(input: {
    email: string;
    passwordHash: string;
    name?: string | null;
    tenantName: string;
    tenantSlug?: string | null;
  }): Promise<{ tenant: TenantRow; user: UserRow; membership: MembershipRow }> {
    const email = input.email.trim();
    const slug = await this.resolveFreeSlug(input.tenantSlug ?? input.tenantName);
    return this.client.transaction(async (tx) => {
      // Guard email uniqueness inside the txn (CITEXT UNIQUE also enforces it).
      const existing = await tx.get<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      if (existing) throw new EmailTakenError();
      const tenant = await tx.one<TenantRow>(
        `INSERT INTO tenants (slug, name, status) VALUES ($1, $2, 'active') RETURNING *`,
        [slug, input.tenantName.trim()],
      );
      const user = await tx.one<UserRow>(
        `INSERT INTO users (email, password_hash, name, status) VALUES ($1, $2, $3, 'active') RETURNING *`,
        [email, input.passwordHash, input.name ?? null],
      );
      await tx.execute(
        `INSERT INTO user_email_identities (user_id, email, is_primary, verified_at)
         VALUES ($1, $2, true, NULL)`,
        [user.id, email],
      );
      const membership = await tx.one<MembershipRow>(
        `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, 'owner', 'active') RETURNING *`,
        [user.id, tenant.id],
      );
      return { tenant, user, membership };
    });
  }

  /** An existing (authenticated) user starts a new org and becomes its owner. */
  async createTenantForUser(userId: string, name: string, slugHint?: string | null): Promise<{ tenant: TenantRow; membership: MembershipRow }> {
    const slug = await this.resolveFreeSlug(slugHint ?? name);
    return this.client.transaction(async (tx) => {
      const tenant = await tx.one<TenantRow>(
        `INSERT INTO tenants (slug, name, status) VALUES ($1, $2, 'active') RETURNING *`,
        [slug, name.trim()],
      );
      const membership = await tx.one<MembershipRow>(
        `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, 'owner', 'active') RETURNING *`,
        [userId, tenant.id],
      );
      return { tenant, membership };
    });
  }

  /**
   * Best-effort per-tenant seed of the default email-agent settings rows (design
   * §5.1). email_agent_settings is a tenant-scoped table under Row-Level Security
   * (migration 0013), so the insert must run with `app.current_tenant` set to the
   * target tenant IN THE SAME TRANSACTION — otherwise the RLS WITH CHECK policy
   * rejects the write. The upsert conflicts on the composite (tenant_id, agent_key)
   * PK (the legacy agent_key-alone unique is dropped in 0013). This is best-effort
   * and swallows any failure so a transient seed error NEVER fails signup.
   */
  async seedTenantAgentSettings(tenantId: string): Promise<void> {
    const defaults: Array<{ agent_key: string; model: string }> = [
      { agent_key: "labeler", model: "gpt-4o-mini" },
      { agent_key: "responder", model: "gpt-4o-mini" },
      { agent_key: "summarizer", model: "gpt-4o-mini" },
    ];
    for (const d of defaults) {
      try {
        await this.client.transaction(async (tx) => {
          await tx.execute(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
          await tx.execute(
            `INSERT INTO email_agent_settings (tenant_id, agent_key, enabled, always_on, provider, model, apply_labels, use_network_tools, config_json)
             VALUES ($1, $2, false, false, 'external', $3, true, true, '{}'::jsonb)
             ON CONFLICT (tenant_id, agent_key) DO NOTHING`,
            [tenantId, d.agent_key, d.model],
          );
        });
      } catch (err) {
        // Best-effort: never fail signup on a seed error (e.g. an in-memory test
        // shim without transaction support, or a transient DB hiccup). Log it so a
        // silent seeding regression (e.g. an RLS WITH CHECK misconfig) is at least
        // observable — the message carries no secret material.
        console.warn(
          `[auth] seedTenantAgentSettings(${tenantId}, ${d.agent_key}) skipped: ` +
            (err instanceof Error ? err.message.split("\n")[0] : String(err)),
        );
      }
    }
  }

  private async resolveFreeSlug(hint: string): Promise<string> {
    const base = slugify(hint);
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const taken = await this.client.get<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1`, [candidate]);
      if (!taken) return candidate;
    }
    throw new SlugTakenError(base);
  }

  // ---- tenants + memberships ----------------------------------------------

  async getTenantById(id: string): Promise<TenantRow | null> {
    return this.client.get<TenantRow>(`SELECT * FROM tenants WHERE id = $1`, [id]);
  }

  async getTenantBySlug(slug: string): Promise<TenantRow | null> {
    return this.client.get<TenantRow>(`SELECT * FROM tenants WHERE slug = $1`, [slug.trim().toLowerCase()]);
  }

  async listTenantsForUser(userId: string): Promise<Array<TenantRow & { role: Role }>> {
    return this.client.many<TenantRow & { role: Role }>(
      `SELECT t.*, m.role FROM tenants t
         JOIN memberships m ON m.tenant_id = t.id
        WHERE m.user_id = $1 AND m.status = 'active'
        ORDER BY t.created_at ASC`,
      [userId],
    );
  }

  async getMembership(userId: string, tenantId: string): Promise<MembershipRow | null> {
    return this.client.get<MembershipRow>(
      `SELECT * FROM memberships WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [userId, tenantId],
    );
  }

  async getMembershipById(id: string): Promise<MembershipRow | null> {
    return this.client.get<MembershipRow>(`SELECT * FROM memberships WHERE id = $1`, [id]);
  }

  async listMemberships(tenantId: string): Promise<Array<MembershipRow & { email: string; name: string | null }>> {
    return this.client.many<MembershipRow & { email: string; name: string | null }>(
      `SELECT m.*, u.email, u.name FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1
        ORDER BY m.created_at ASC`,
      [tenantId],
    );
  }

  async updateTenant(id: string, patch: { name?: string; slug?: string; status?: string }): Promise<TenantRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.name !== undefined) { params.push(patch.name.trim()); sets.push(`name = $${params.length}`); }
    if (patch.slug !== undefined) {
      const slug = slugify(patch.slug);
      const taken = await this.client.get<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1 AND id <> $2`, [slug, id]);
      if (taken) throw new SlugTakenError(slug);
      params.push(slug); sets.push(`slug = $${params.length}`);
    }
    if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}`); }
    if (sets.length === 0) return this.getTenantById(id);
    sets.push("updated_at = now()");
    return this.client.get<TenantRow>(`UPDATE tenants SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
  }

  async suspendTenant(id: string): Promise<boolean> {
    const rows = await this.client.many<{ id: string }>(
      `UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  /** Count active owners of a tenant (last-owner guard, design M5). */
  async countActiveOwners(tenantId: string, tx: TypedQueryClient = this.client): Promise<number> {
    const row = await tx.get<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'`,
      [tenantId],
    );
    return row?.n ?? 0;
  }

  /**
   * Change a membership's role. Refuses to demote the LAST active owner (M5): the
   * count + update run in one transaction with FOR UPDATE row locks so a
   * concurrent demotion cannot race two owners down to zero.
   */
  async changeMembershipRole(membershipId: string, role: Role): Promise<MembershipRow | null> {
    return this.client.transaction(async (tx) => {
      const membership = await tx.get<MembershipRow>(
        `SELECT * FROM memberships WHERE id = $1 FOR UPDATE`,
        [membershipId],
      );
      if (!membership) return null;
      if (membership.role === "owner" && role !== "owner") {
        // Lock the tenant's owner rows so the count is stable within the txn.
        await tx.many(`SELECT id FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active' FOR UPDATE`, [membership.tenant_id]);
        const owners = await this.countActiveOwners(membership.tenant_id, tx);
        if (owners <= 1) throw new LastOwnerError();
      }
      return tx.get<MembershipRow>(
        `UPDATE memberships SET role = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [membershipId, role],
      );
    });
  }

  /**
   * Remove a membership. Refuses to remove the last active owner (M5). On removal,
   * revokes any api keys the removed user created for this tenant (M6) and revokes
   * that user's sessions bound to this tenant.
   */
  async removeMembership(membershipId: string): Promise<{ removed: boolean }> {
    return this.client.transaction(async (tx) => {
      const membership = await tx.get<MembershipRow>(`SELECT * FROM memberships WHERE id = $1 FOR UPDATE`, [membershipId]);
      if (!membership) return { removed: false };
      if (membership.role === "owner") {
        await tx.many(`SELECT id FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active' FOR UPDATE`, [membership.tenant_id]);
        const owners = await this.countActiveOwners(membership.tenant_id, tx);
        if (owners <= 1) throw new LastOwnerError();
      }
      await tx.execute(`DELETE FROM memberships WHERE id = $1`, [membershipId]);
      // M6: revoke api keys this user created for this tenant.
      await tx.execute(
        `UPDATE api_keys SET revoked_at = now(), revoked_reason = 'membership removed'
          WHERE revoked_at IS NULL AND kid IN (
            SELECT kid FROM api_key_tenants WHERE tenant_id = $1 AND created_by_user_id = $2
          )`,
        [membership.tenant_id, membership.user_id],
      );
      // Revoke that user's sessions in this tenant.
      await tx.execute(
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
        [membership.user_id, membership.tenant_id],
      );
      return { removed: true };
    });
  }

  async addMembership(userId: string, tenantId: string, role: Role): Promise<MembershipRow> {
    return this.client.one<MembershipRow>(
      `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()
       RETURNING *`,
      [userId, tenantId, role],
    );
  }

  // ---- sessions ------------------------------------------------------------

  async createSession(userId: string, tenantId: string, meta: { userAgent?: string | null; ip?: string | null } = {}): Promise<CreatedSession> {
    const { token, tokenHash } = mintSessionToken();
    const expiresAt = this.iso(this.idleTtlMs);
    const absoluteExpiresAt = this.iso(this.absoluteTtlMs);
    const row = await this.client.one<{ id: string }>(
      `INSERT INTO sessions (user_id, tenant_id, token_hash, expires_at, absolute_expires_at, user_agent, ip, last_used_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, now())
       RETURNING id`,
      [userId, tenantId, tokenHash, expiresAt, absoluteExpiresAt, meta.userAgent ?? null, ipOrNull(meta.ip)],
    );
    return { token, sessionId: row.id, expiresAt, absoluteExpiresAt };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.client.execute(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
  }

  /** Revoke a session by its plaintext token (logout / switch-tenant rotation). */
  async revokeSessionByToken(token: string): Promise<void> {
    await this.client.execute(
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.client.execute(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }

  // ---- api key tenant binding (WI-2e support) ------------------------------

  async bindApiKeyTenant(kid: string, tenantId: string, createdByUserId: string | null): Promise<void> {
    await this.client.execute(
      `INSERT INTO api_key_tenants (kid, tenant_id, created_by_user_id) VALUES ($1, $2, $3)
       ON CONFLICT (kid) DO NOTHING`,
      [kid, tenantId, createdByUserId],
    );
  }

  async listApiKeyKidsForTenant(tenantId: string): Promise<string[]> {
    const rows = await this.client.many<{ kid: string }>(
      `SELECT kid FROM api_key_tenants WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows.map((r) => r.kid);
  }

  /**
   * List the tenant's api keys by joining api_keys ⨝ api_key_tenants (design §5.3).
   * Returns only non-secret metadata — the token hash is NEVER selected. (We do the
   * join here rather than via ApiKeyStore.list, which does not bind its filter.)
   */
  async listApiKeysForTenant(tenantId: string): Promise<Array<{
    kid: string;
    app: string;
    agent: string | null;
    scopes: string[];
    issued_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    last_used_at: string | null;
    created_by_user_id: string | null;
  }>> {
    return this.client.many(
      `SELECT k.kid, k.app, k.agent, k.scopes, k.issued_at, k.expires_at, k.revoked_at,
              k.last_used_at, akt.created_by_user_id
         FROM api_keys k
         JOIN api_key_tenants akt ON akt.kid = k.kid
        WHERE akt.tenant_id = $1
        ORDER BY k.issued_at DESC`,
      [tenantId],
    );
  }

  async apiKeyBelongsToTenant(kid: string, tenantId: string): Promise<boolean> {
    const row = await this.client.get<{ kid: string }>(
      `SELECT kid FROM api_key_tenants WHERE kid = $1 AND tenant_id = $2`,
      [kid, tenantId],
    );
    return row !== null;
  }

  // ---- email verification (Addendum A2) ------------------------------------

  async createEmailVerification(userId: string, email: string): Promise<MintedTokenResult> {
    const { token, tokenHash } = mintEmailVerifyToken();
    const expiresAt = this.iso(this.verifyTtlMs);
    const row = await this.client.one<{ id: string }>(
      `INSERT INTO email_verification_tokens (user_id, email, token_hash, expires_at)
       VALUES ($1, $2, $3, $4::timestamptz) RETURNING id`,
      [userId, email.trim(), tokenHash, expiresAt],
    );
    return { token, id: row.id, expiresAt };
  }

  /**
   * Consume a verification token: single-use + unexpired. Marks the token used and
   * the user verified in one transaction. Returns the verified user, or null.
   */
  async consumeEmailVerification(token: string): Promise<UserRow | null> {
    const tokenHash = hashToken(token);
    const nowIso = this.iso();
    return this.client.transaction(async (tx) => {
      const row = await tx.get<{ id: string; user_id: string; email: string }>(
        `UPDATE email_verification_tokens SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2::timestamptz
          RETURNING id, user_id, email`,
        [tokenHash, nowIso],
      );
      if (!row) return null;
      await tx.execute(
        `UPDATE user_email_identities SET verified_at = COALESCE(verified_at, now()), updated_at = now()
         WHERE user_id = $1 AND email = $2`,
        [row.user_id, row.email],
      );
      return tx.get<UserRow>(
        `UPDATE users SET
           email_verified_at = CASE WHEN email = $2 THEN COALESCE(email_verified_at, now()) ELSE email_verified_at END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [row.user_id, row.email],
      );
    });
  }

  async listUserEmailIdentities(userId: string): Promise<UserEmailIdentity[]> {
    return this.client.many<UserEmailIdentity>(
      `SELECT id, user_id, email, is_primary, verified_at, created_at, updated_at
       FROM user_email_identities WHERE user_id = $1
       ORDER BY is_primary DESC, created_at ASC`,
      [userId],
    );
  }

  async addUserEmailIdentity(userId: string, email: string): Promise<UserEmailIdentity> {
    return this.client.one<UserEmailIdentity>(
      `INSERT INTO user_email_identities (user_id, email, is_primary)
       VALUES ($1, $2, false)
       RETURNING id, user_id, email, is_primary, verified_at, created_at, updated_at`,
      [userId, email.trim()],
    );
  }

  async makePrimaryEmailIdentity(userId: string, identityId: string): Promise<UserEmailIdentity | null> {
    return this.client.transaction(async (tx) => {
      const identity = await tx.get<UserEmailIdentity>(
        `SELECT id, user_id, email, is_primary, verified_at, created_at, updated_at
         FROM user_email_identities WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [identityId, userId],
      );
      if (!identity || !identity.verified_at) return null;
      await tx.execute(`UPDATE user_email_identities SET is_primary = false, updated_at = now() WHERE user_id = $1`, [userId]);
      const primary = await tx.one<UserEmailIdentity>(
        `UPDATE user_email_identities SET is_primary = true, updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id, user_id, email, is_primary, verified_at, created_at, updated_at`,
        [identityId, userId],
      );
      await tx.execute(
        `UPDATE users SET email = $2, email_verified_at = $3::timestamptz, updated_at = now() WHERE id = $1`,
        [userId, primary.email, primary.verified_at],
      );
      return primary;
    });
  }

  async removeUserEmailIdentity(userId: string, identityId: string): Promise<boolean> {
    const deleted = await this.client.many<{ id: string }>(
      `DELETE FROM user_email_identities
       WHERE id = $1 AND user_id = $2 AND is_primary = false
       RETURNING id`,
      [identityId, userId],
    );
    return deleted.length > 0;
  }

  // ---- password reset ------------------------------------------------------

  async createPasswordReset(userId: string): Promise<MintedTokenResult> {
    const { token, tokenHash } = mintResetToken();
    const expiresAt = this.iso(this.resetTtlMs);
    const row = await this.client.one<{ id: string }>(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3::timestamptz) RETURNING id`,
      [userId, tokenHash, expiresAt],
    );
    return { token, id: row.id, expiresAt };
  }

  /**
   * Consume a reset token (single-use, unexpired), set the new argon2id hash, and
   * revoke ALL of the user's sessions. One transaction. Returns true on success.
   */
  async consumePasswordReset(token: string, newPasswordHash: string): Promise<boolean> {
    const tokenHash = hashToken(token);
    const nowIso = this.iso();
    return this.client.transaction(async (tx) => {
      const row = await tx.get<{ user_id: string }>(
        `UPDATE password_reset_tokens SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2::timestamptz
          RETURNING user_id`,
        [tokenHash, nowIso],
      );
      if (!row) return false;
      await tx.execute(
        `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [row.user_id, newPasswordHash],
      );
      await tx.execute(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
      return true;
    });
  }

  // ---- invitations ---------------------------------------------------------

  async createInvitation(input: { tenantId: string; email: string; role: Role; invitedBy: string | null }): Promise<MintedTokenResult> {
    const { token, tokenHash } = mintInviteToken();
    const expiresAt = this.iso(this.inviteTtlMs);
    const email = input.email.trim();
    // One OPEN invite per (tenant, email): supersede any prior open invite.
    const row = await this.client.transaction(async (tx) => {
      await tx.execute(
        `DELETE FROM invitations WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL`,
        [input.tenantId, email],
      );
      return tx.one<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz) RETURNING id`,
        [input.tenantId, email, input.role, tokenHash, input.invitedBy, expiresAt],
      );
    });
    return { token, id: row.id, expiresAt };
  }

  async resolveInvitation(token: string): Promise<{ id: string; tenant_id: string; email: string; role: Role } | null> {
    const tokenHash = hashToken(token);
    const nowIso = this.iso();
    return this.client.get<{ id: string; tenant_id: string; email: string; role: Role }>(
      `SELECT id, tenant_id, email, role FROM invitations
        WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2::timestamptz`,
      [tokenHash, nowIso],
    );
  }

  async listInvitations(tenantId: string): Promise<Array<{ id: string; email: string; role: Role; expires_at: string; accepted_at: string | null; created_at: string }>> {
    return this.client.many(
      `SELECT id, email, role, expires_at, accepted_at, created_at FROM invitations WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
  }

  /**
   * Accept an invite: create the user (verified, since the invite proves email
   * control) if it does not exist, add the membership, mark the invite accepted.
   * All in one transaction. Returns the user + tenant. `passwordHash` is required
   * only when the invited email has no existing user.
   */
  async acceptInvitation(input: {
    token: string;
    passwordHash?: string | null;
    name?: string | null;
  }): Promise<{ user: UserRow; tenantId: string; role: Role } | { error: "invalid" | "needs_password" }> {
    const tokenHash = hashToken(input.token);
    const nowIso = this.iso();
    return this.client.transaction(async (tx) => {
      const invite = await tx.get<{ id: string; tenant_id: string; email: string; role: Role }>(
        `SELECT id, tenant_id, email, role FROM invitations
          WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2::timestamptz FOR UPDATE`,
        [tokenHash, nowIso],
      );
      if (!invite) return { error: "invalid" as const };
      let user = await tx.get<UserRow>(
        `SELECT u.* FROM users u JOIN user_email_identities i ON i.user_id = u.id WHERE i.email = $1`,
        [invite.email],
      );
      if (!user) {
        if (!input.passwordHash) return { error: "needs_password" as const };
        user = await tx.one<UserRow>(
          `INSERT INTO users (email, password_hash, name, status, email_verified_at)
           VALUES ($1, $2, $3, 'active', now()) RETURNING *`,
          [invite.email, input.passwordHash, input.name ?? null],
        );
        await tx.execute(
          `INSERT INTO user_email_identities (user_id, email, is_primary, verified_at)
           VALUES ($1, $2, true, now())`,
          [user.id, invite.email],
        );
      }
      await tx.execute(
        `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()`,
        [user.id, invite.tenant_id, invite.role],
      );
      await tx.execute(`UPDATE invitations SET accepted_at = now() WHERE id = $1`, [invite.id]);
      return { user, tenantId: invite.tenant_id, role: invite.role };
    });
  }

  // ---- bootstrap-owner (migration bridge, design §5.1) ---------------------

  /**
   * Create the FIRST owner user for a tenant that currently has ZERO users (the
   * key-only operator bridging to sessions). Refuses if the tenant already has any
   * owner. Creates the user VERIFIED (the API-key holder is already trusted).
   */
  async bootstrapOwner(input: { tenantId: string; email: string; passwordHash: string; name?: string | null }): Promise<{ user: UserRow } | { error: "exists" | "email_taken" }> {
    const email = input.email.trim();
    return this.client.transaction(async (tx) => {
      await tx.many(`SELECT id FROM memberships WHERE tenant_id = $1 FOR UPDATE`, [input.tenantId]);
      const owners = await this.countActiveOwners(input.tenantId, tx);
      if (owners > 0) return { error: "exists" as const };
      const dup = await tx.get<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      if (dup) return { error: "email_taken" as const };
      const user = await tx.one<UserRow>(
        `INSERT INTO users (email, password_hash, name, status, email_verified_at)
         VALUES ($1, $2, $3, 'active', now()) RETURNING *`,
        [email, input.passwordHash, input.name ?? null],
      );
      await tx.execute(
        `INSERT INTO user_email_identities (user_id, email, is_primary, verified_at)
         VALUES ($1, $2, true, now())`,
        [user.id, email],
      );
      await tx.execute(
        `INSERT INTO memberships (user_id, tenant_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
        [user.id, input.tenantId],
      );
      return { user };
    });
  }

  /**
   * Operator-only, idempotent creation/promotion of the single primary platform
   * super-admin. The caller is authenticated separately with an API key; only its
   * non-secret kid is written to the audit ledger.
   */
  async bootstrapPrimarySuperAdmin(input: {
    tenantId: string;
    email: string;
    passwordHash: string;
    actorKid: string;
    name?: string | null;
  }): Promise<{ user: UserRow; created: boolean } | { error: "primary_exists" }> {
    const email = input.email.trim().toLowerCase();
    return this.client.transaction(async (tx) => {
      // Serialize this one-time global operator action. Without this lock, two
      // concurrent first calls can both observe an empty singleton before either
      // inserts, turning an idempotent replay into a unique-constraint 500.
      await tx.execute(`SELECT pg_advisory_xact_lock(hashtext('emails:primary-super-admin-bootstrap'))`);
      const incumbent = await tx.get<{ id: string; email: string }>(
        `SELECT id, email FROM users WHERE is_primary_super_admin = true FOR UPDATE`,
      );
      let user = await tx.get<UserRow>(
        `SELECT u.* FROM users u JOIN user_email_identities i ON i.user_id = u.id WHERE i.email = $1 FOR UPDATE`,
        [email],
      );
      if (incumbent && (!user || incumbent.id !== user.id)) return { error: "primary_exists" as const };

      let created = false;
      if (!user) {
        user = await tx.one<UserRow>(
          `INSERT INTO users (
             email, password_hash, name, status, email_verified_at, global_role, is_primary_super_admin
           ) VALUES ($1, $2, $3, 'active', now(), 'super_admin', true)
           RETURNING *`,
          [email, input.passwordHash, input.name ?? null],
        );
        await tx.execute(
          `INSERT INTO user_email_identities (user_id, email, is_primary, verified_at)
           VALUES ($1, $2, true, now())`,
          [user.id, email],
        );
        created = true;
      } else {
        user = await tx.one<UserRow>(
          `UPDATE users SET global_role = 'super_admin', is_primary_super_admin = true,
             status = 'active', email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
           WHERE id = $1 RETURNING *`,
          [user.id],
        );
        await tx.execute(
          `UPDATE user_email_identities SET verified_at = COALESCE(verified_at, now()), updated_at = now()
           WHERE user_id = $1 AND email = $2`,
          [user.id, email],
        );
      }

      await tx.execute(
        `INSERT INTO memberships (user_id, tenant_id, role, status)
         VALUES ($1, $2, 'owner', 'active')
         ON CONFLICT (user_id, tenant_id) DO UPDATE
           SET role = 'owner', status = 'active', updated_at = now()`,
        [user.id, input.tenantId],
      );
      await tx.execute(
        `INSERT INTO admin_bootstrap_audit (action, tenant_id, user_id, email, actor_kid)
         VALUES ('primary_super_admin_bootstrap', $1, $2, $3, $4)
         ON CONFLICT (action, tenant_id, user_id) DO NOTHING`,
        [input.tenantId, user.id, email, input.actorKid],
      );
      return { user, created };
    });
  }
}

/** Only pass a syntactically plausible IP to the INET column (else NULL). */
function ipOrNull(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  // Basic IPv4/IPv6 shape guard; INET cast would otherwise throw on junk.
  if (/^[0-9a-fA-F:.]+$/.test(trimmed) && trimmed.length <= 45) return trimmed;
  return null;
}
