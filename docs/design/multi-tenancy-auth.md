# Design: Multi-Tenancy + User Accounts + Signup/Login for `@hasna/emails`

Status: IMPLEMENTED v3 (integration candidate; production rollout pending). Original author: Marcus (architect).
Canonical package: `@hasna/emails`. Projects project: `open-emails`. GitHub repository: `hasna/emails`.

> Sections 1–14 preserve the reviewed pre-implementation baseline and threat
> model. Section 15 is the authoritative reconciliation with the implemented
> source. Where historical wording conflicts with section 15, section 15 wins.

> **v2 incorporates an independent adversarial security review** (findings C1, H1-H3,
> M1-M7, L1-L4). The corrections are folded inline and summarized in §14. Build agents:
> read §14 first — it overrides several first-draft assumptions (invalid `SET LOCAL`
> SQL, a two-role model that does not yet exist, credential→tenant resolution that must
> avoid RLS tables, the send state machine, and envelope-only inbound routing).

> This is a build spec meant to be fanned out to implementation agents. It is not a
> record of completed work. New DB migrations are **0012+**; migration ids **≤0011**
> (and the contracts-owned `hasna_auth_0001/0002`) are frozen and never edited.

---

## 1. Current architecture (grounded)

Self-hosted-ONLY. A Bun `Bun.serve` process (`src/server/self-hosted/serve.ts`) exposes:

- Probes `/health` `/ready` `/version` `/openapi.json` (unauthenticated).
- `/v1/*` — authenticated CRUD. Auth is a single Hasna API key verified by
  `@hasna/contracts/auth` (`verifyApiKey`), scoped to `emails:read` / `emails:write` /
  `emails:*`. `service.ts::authenticate()` (lines 306-324) gates every route.
- Data access via `EmailsSelfHostedStore` (`store.ts`) over a `pg.Pool`-backed
  `PoolQueryClient` (has `.transaction()`), reading/writing operator-owned Postgres.

Two data-access shapes in the store:
1. **Hand-written** methods for `domains`, `addresses`, `messages` (+ send-intent
   state machine), mail-views (threads/mailboxes/raw), and scoped **send keys**
   (`mintSendKey`/`verifySendKey`/`isOwnerAuthorizedFrom`).
2. **Generic resource layer** — `listResource/getResource/createResource/
   updateResource/deleteResource` driven by the trusted `SELF_HOSTED_RESOURCES`
   registry (`resources.ts`, **24 resources**: contacts, providers, templates, groups,
   sequences, owners, send-keys, scheduled, aliases, forwarding, warming, triage,
   provisioning, sources, events, email-agents, email-agent-runs, email-digests,
   group-members, sequence-steps, sequence-enrollments, address-ownership-events,
   webhook-receipts, sandbox-emails). **This is a single chokepoint** — scoping it
   tenant-scopes all 24 at once. With the 3 hand-written tables (domains, addresses,
   messages) that is **27 tenant-scoped tables total** (L4).

Schema: migrations 0001-0011 (`migrations.ts`) create every table. **No table has any
tenant/user/org concept today.** Uniqueness is global: `domains.domain`,
`addresses.email`, `contacts.email`, `templates.name`, `contact_groups.name`,
`warming_schedules.domain`, `aliases(domain,local_part)`,
`forwarding_rules(source_address,target_address,mode)`, `group_members(group_id,email)`,
`email_agent_runs(agent_key,inbound_email_id)`, and partial-unique
`messages(source_id)` / `messages(idempotency_key)`. `email_agent_settings` is PK'd on
`agent_key` (3 globally-seeded rows). `send_key_secrets(key_hash)` is globally unique.

`@hasna/contracts/auth` (v0.4.2, dist-only) provides **API keys only** — no users,
sessions, or passwords. Its `api_keys` table is `kid`-keyed with a free-form signed
`agent` claim surfaced as `principal.agent`. Contract table + migrations
(`hasna_auth_0001/0002`) are frozen; **we do not alter them** — tenant binding lives in
a table we own.

Client (`CLI/MCP/TUI`) talks only to `/v1` through **two** HTTP chokepoints, both
sending `Authorization: Bearer <cred>`, both fed by one config resolver:
- Sync resources: `httpRequest()` — `src/db/self-hosted-store.ts:179` (curl/spawnSync).
- Async mail/inbox: `SelfHostedMailDataSource.request()` — `src/lib/self-hosted-mail-data-source.ts:322` (fetch).
- Config: `resolveSelfHostedConfig()` — `src/db/self-hosted-store.ts:70` → `{baseUrl, apiKey}`.
- Env (via `src/lib/client-env.ts`): vault pointer `EMAILS_CLIENT_ENV_SECRET` →
  `EMAILS_MODE`, `EMAILS_SELF_HOSTED_URL`, `EMAILS_SELF_HOSTED_API_KEY`.

The code runs on a **single DB DSN** (`EMAILS_DATABASE_URL`, `env.ts`) used by both
`migrate.ts` and `serve.ts`. A least-privilege app role is only *aspirational* (a comment
at `service.ts:41`), not wired. The RLS backstop (§6 Layer 2) therefore **requires new
infra** — a separate `NOBYPASSRLS` serving role/DSN — and until that lands, Layer 1 (the
typed scoped store) is the sole isolation guarantee (adversarial fix H1).

---

## 2. Goals / non-goals

**Goals.** True multi-tenant isolation (a caller can NEVER see another tenant's rows);
first-class user accounts (email + password); signup (create org + owner), login →
session, logout, password reset; membership/roles (owner/admin/member); API keys become
tenant-scoped and coexist with user sessions; additive migration that backfills all
existing data into one default tenant with zero data loss and zero downtime for the
currently-deployed single operator.

**Non-goals (this phase).** SSO/OAuth/SAML, MFA/TOTP (design leaves room), billing,
browser SPA/cookie sessions (bearer-only for CLI; cookie layer is a later addition),
cross-tenant sharing of resources.

---

## 3. Data model

### 3.1 New identity tables (NOT tenant-scoped — they are the resolution layer)

These are read *before* a tenant is known, so they are **not** under tenant RLS.

```
tenants
  id          UUID PK              (default tenant = fixed sentinel, see §9)
  slug        TEXT UNIQUE NOT NULL (lowercase [a-z0-9-]; url/login selector)
  name        TEXT NOT NULL
  status      TEXT NOT NULL DEFAULT 'active'   -- active | suspended
  created_at, updated_at TIMESTAMPTZ

users                              -- GLOBAL identity (one login, many orgs)
  id             UUID PK
  email          CITEXT UNIQUE NOT NULL         -- case-insensitive, globally unique
  password_hash  TEXT NOT NULL                  -- argon2id (§4.1); NEVER selected by resource layer
  name           TEXT
  status         TEXT NOT NULL DEFAULT 'active'  -- active | disabled
  email_verified_at TIMESTAMPTZ
  failed_login_count INTEGER NOT NULL DEFAULT 0  -- durable lockout (§8)
  locked_until   TIMESTAMPTZ
  created_at, updated_at TIMESTAMPTZ

memberships                        -- user ↔ tenant M:N + role
  id         UUID PK
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer'))
  status     TEXT NOT NULL DEFAULT 'active'
  created_at, updated_at TIMESTAMPTZ
  UNIQUE (user_id, tenant_id)
  INDEX (tenant_id), INDEX (user_id)

sessions                           -- opaque server-side tokens (§4.2)
  id            UUID PK
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE  -- ACTIVE tenant for this session
  token_hash    TEXT UNIQUE NOT NULL          -- sha256 hex of the opaque token; token never stored
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  last_used_at  TIMESTAMPTZ
  expires_at    TIMESTAMPTZ NOT NULL          -- sliding (§4.2)
  absolute_expires_at TIMESTAMPTZ NOT NULL    -- hard cap regardless of sliding
  revoked_at    TIMESTAMPTZ
  user_agent    TEXT
  ip            INET
  INDEX (user_id), INDEX (expires_at)

api_key_tenants                    -- binds a contracts-owned api key (kid) to a tenant
  kid                TEXT PRIMARY KEY          -- == api_keys.kid (contract-owned table)
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
  created_by_user_id UUID REFERENCES users(id)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  INDEX (tenant_id)

invitations                        -- invite/join flow
  id          UUID PK
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
  email       CITEXT NOT NULL
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','member'))
  token_hash  TEXT UNIQUE NOT NULL
  invited_by  UUID REFERENCES users(id)
  expires_at  TIMESTAMPTZ NOT NULL
  accepted_at TIMESTAMPTZ
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  UNIQUE (tenant_id, email) WHERE accepted_at IS NULL   -- one open invite per email/tenant

password_reset_tokens
  id         UUID PK
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  token_hash TEXT UNIQUE NOT NULL
  expires_at TIMESTAMPTZ NOT NULL
  used_at    TIMESTAMPTZ
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

Decisions & rationale:
- **Global users + memberships** (Slack/GitHub model), not per-tenant users. One login
  works across orgs, invites of existing users are trivial, and the M:N table already
  models it. `users.email` globally unique (CITEXT).
- **`api_key_tenants` mapping** rather than encoding tenant in the signed `agent` claim.
  Keeps authn (contracts) decoupled from tenancy (our authorization boundary), makes the
  tenant an authoritative DB fact (indexed, listable per tenant, re-assignable), and
  avoids trusting a claim for a security boundary. We may *also* set `agent="<tenantId>"`
  for human-readable audit, but the mapping table is the source of truth. **Fail closed**:
  a verified key with no mapping row → 403.
- Identity tables hold secrets (`password_hash`, `token_hash`) and are **deliberately
  absent from `SELF_HOSTED_RESOURCES`** — no generic `SELECT *` path can ever reach them,
  exactly as `send_key_secrets` is handled today.

### 3.2 `tenant_id` on every existing data table

Add to all 27 data tables: `tenant_id UUID NOT NULL REFERENCES tenants(id)` + `INDEX
(tenant_id)`. Tables:

```
domains, addresses, messages, contacts, self_hosted_providers, templates,
contact_groups, sequences, owners, send_keys, scheduled_emails, aliases,
forwarding_rules, warming_schedules, email_triage, provisioning_events,
mailbox_sources, events, email_agent_settings, email_agent_runs, email_digests,
group_members, sequence_steps, sequence_enrollments, address_ownership_events,
webhook_receipts, sandbox_emails
```

Explicitly **not** tenant_id'd:
- `send_key_secrets` — holds only `(id, send_key_id, key_hash)`; reached via a global
  `key_hash` lookup (the token *is* the credential). The resolved `send_keys` row carries
  the tenant. Keeping it tenant-free preserves the verify-without-context lookup.
- `api_keys` — contracts-owned/frozen; tenant lives in `api_key_tenants`.
- `schema_migrations` — ledger.

### 3.3 Uniqueness must become per-tenant

Global uniques would otherwise let one tenant block another from registering the same
domain/address/name. Convert each to composite `(tenant_id, …)`:

| table | old unique | new unique |
|---|---|---|
| domains | `(domain)` | `(tenant_id, domain)` |
| addresses | `(email)` | `(tenant_id, email)` |
| contacts | `(email)` | `(tenant_id, email)` |
| templates | `(name)` | `(tenant_id, name)` |
| contact_groups | `(name)` | `(tenant_id, name)` |
| warming_schedules | `(domain)` | `(tenant_id, domain)` |
| aliases | `(domain, local_part)` | `(tenant_id, domain, local_part)` |
| forwarding_rules | `(source_address, target_address, mode)` | `+ tenant_id` |
| group_members | `(group_id, email)` | `(tenant_id, group_id, email)` |
| email_agent_runs | `(agent_key, inbound_email_id)` | `(tenant_id, agent_key, inbound_email_id)` |
| messages | partial `(source_id)`, `(idempotency_key)` | `(tenant_id, source_id)`, `(tenant_id, idempotency_key)` |
| email_agent_settings | PK `(agent_key)` | PK `(tenant_id, agent_key)` |
| webhook_receipts | *(none — only a non-unique index today)* | **new** UNIQUE `(tenant_id, provider, event_id)` (see below) |
| send_key_secrets | `(key_hash)` | **unchanged** (global; credential) |

**webhook_receipts (adversarial fix M2).** It has NO unique constraint today (migration
0011 creates only `CREATE INDEX … (provider, event_id)`; app-side dedup is best-effort and
racy). Introducing `UNIQUE(tenant_id, provider, event_id)` is a *new* constraint that can
fail on pre-existing duplicate `(provider, event_id)` rows — the migration must **dedupe
first** (`DELETE … USING …` keeping the newest) then create the unique index. And tenant on
a provider webhook is only known after inbound routing (§6 cross-cutting #1).

**Idempotency keys become per-tenant** — this is a correctness fix, not just isolation:
two tenants must be able to use the same `idempotency_key` independently, and one must
never observe another's send-intent replay. Same for `source_id` (inbound dedupe).

`email_agent_settings` PK change: drop PK, backfill `tenant_id`, add PK `(tenant_id,
agent_key)`. The 3 default rows are re-seeded per tenant (at signup; §5).

---

## 4. Auth model

### 4.1 Password hashing — **argon2id via `Bun.password`**

Choice: **argon2id**, using Bun's built-in `Bun.password.hash(pw, {algorithm:"argon2id"})`
/ `Bun.password.verify()`.

Justification:
- Memory-hard → GPU/ASIC-resistant; OWASP's first-choice password hash; argon2id is the
  hybrid resistant to both side-channel and time-memory tradeoff attacks.
- **Zero new dependencies.** The server is `Bun.serve`; `Bun.password` ships argon2id
  natively. No native addon, no supply-chain risk, no Bun release-age quarantine concern.
- Self-tuning cost params baked into the encoded hash (PHC string), so verification and
  future re-tuning are transparent; supports rehash-on-login when params change.
- scrypt (Node `crypto.scrypt`) is a fine memory-hard alternative and the fallback if a
  non-Bun runtime ever hosts this, but argon2id is the modern default and Bun gives it for
  free. bcrypt is rejected (72-byte truncation, not memory-hard).

Parameters: start at Bun defaults (argon2id, m≈19 MiB, t=2, p=1) and tune to ~50-100ms on
the deploy host; store the full PHC string; rehash opportunistically on successful login
if the encoded params differ from current policy.

### 4.2 Session tokens — **opaque, server-side, hashed at rest**

Choice: **opaque random tokens** (256-bit), stored only as `sha256` hash in `sessions`,
NOT JWTs.

Format: `emss_<base64url(32 random bytes)>`. At rest: `sessions.token_hash =
sha256hex(token)` (UNIQUE). Lookups are constant-time via the unique-hash index; the
plaintext is returned to the client exactly once at login.

Justification vs JWT:
- **Instant revocation.** logout, "sign out everywhere", password reset, admin-disable,
  role change — all take effect immediately by flipping/deleting the DB row. Stateless
  JWTs can't be revoked before expiry without a server-side denylist, which reintroduces
  exactly the state a JWT was meant to avoid.
- **Consistency.** The server already mints→stores-hash→verifies→revokes for API keys and
  send keys. Opaque sessions reuse that proven pattern; no second signing-key type or JWT
  rotation machinery.
- **Authoritative tenant/role.** `sessions.tenant_id` + `memberships.role` are read live,
  so a role downgrade or tenant change is honored on the very next request — impossible
  with a long-lived JWT that baked in stale claims.
- **Smaller leak blast radius.** Only the hash is stored; a DB read leak yields no usable
  tokens. Bearer over TLS only.

Expiry/refresh: single session token, **sliding** — `expires_at = now() + idle_ttl`
(e.g. 14d) bumped on each authenticated use, capped by `absolute_expires_at` (e.g. 90d).
No separate refresh token in phase 1 (unnecessary for a CLI/agent tool; a short
access-token + refresh split can be layered later for a browser SPA without touching the
data plane). Expired/revoked → 401 with a `reauthenticate` reason so the CLI can prompt.

### 4.3 Coexistence: sessions ⨯ API keys, one resolution pipeline

Both credential types converge on a single `RequestContext`:

```ts
interface RequestContext {
  tenantId: string;
  principalType: 'user' | 'apikey';
  userId?: string;           // user sessions only
  role?: 'owner'|'admin'|'member';  // user sessions only
  kid?: string;              // api keys only
  scopes: string[];          // emails:read/write/*  (derived for users from role)
}
```

`resolveRequestContext(deps, req, url, requiredScopes)` (replaces `authenticate()`):

1. Extract the bearer token (`Authorization: Bearer …`, or `x-api-key`) via the same
   extractor the contract uses.
2. **Dispatch by prefix** (no header collision, minimal client change):
   - `hasna_…`  → API-key path: `verifier.authenticate()` (unchanged signature/scope/
     revocation checks) → `principal.kid` → `api_key_tenants[kid].tenant_id`. Missing
     mapping ⇒ 403. `scopes = principal.scopes`. `principalType='apikey'`.
   - `emss_…`  → session path: `sha256` → `sessions` where not revoked and `now() <
     expires_at` and `now() < absolute_expires_at` → `userId`, `tenantId`; load
     `memberships(user,tenant).role`; slide `expires_at`+`last_used_at`. `scopes` derived
     from role (§5.3). `principalType='user'`.
   - else → 401.
3. Enforce `requiredScopes` (read/write) uniformly for both types.
4. Return `{ ok, ctx }`. Handlers then use **only** `deps.store.forTenant(ctx.tenantId)`.

The client puts *either* credential into the same Bearer slot; the server figures out
which by prefix. Identity/auth tables are read here (before a tenant GUC is set), which is
why they must not be under tenant RLS (§6).

---

## 5. API surface

All under `/v1`. Auth endpoints are unauthenticated except where noted. JSON in/out.

### 5.1 Auth & session
- `POST /v1/auth/signup` — `{email, password, name?, tenant_name, tenant_slug?}`. In ONE
  transaction: create `tenant`, `user` (argon2id hash), `membership(role=owner)`, seed
  per-tenant `email_agent_settings`, mint a `session`. Returns `{session_token, user, tenant}`.
  Subject to signup rate limit + optional invite-only toggle (§8).
- `POST /v1/auth/login` — `{email, password, tenant_slug?}`. Verify password (constant
  timing even for unknown email). If the user has multiple memberships and no `tenant_slug`,
  return `{needs_tenant:true, tenants:[…]}` (no session yet); else mint session for the
  chosen/only tenant. Returns `{session_token, user, tenant}`.
- `POST /v1/auth/logout` — session-auth; revokes the current session (`revoked_at=now()`).
- `POST /v1/auth/logout-all` — revokes all of the user's sessions.
- `GET  /v1/me` — session or key auth; returns safe projection: user (id/email/name),
  active tenant, role, and the user's memberships (session) — or `{principalType:'apikey',
  tenant, scopes}` for a key.
- `POST /v1/auth/switch-tenant` — session-auth; `{tenant_slug}`; if the user is a member,
  mint a new session bound to that tenant (old session optionally revoked). Returns new token.
- `POST /v1/auth/password/forgot` — `{email}`; always 200 (no enumeration); creates a
  reset token and **emails it through the app's own sender** (self-hosted eating its own
  dog food) or logs it if no sender configured.
- `POST /v1/auth/password/reset` — `{token, new_password}`; consumes token, rehashes,
  revokes all sessions.
- `POST /v1/auth/bootstrap-owner` — **API-key auth only**, one-time: lets the currently
  deployed operator (holding the existing API key mapped to the default tenant) create the
  first owner `user` for their tenant so they can start logging in. Refuses if the tenant
  already has an owner. This is the migration bridge from "key-only" to "has users".

### 5.2 Tenant & membership management (session-auth; role-gated)
- `POST /v1/tenants` — any authenticated user starts a new org (becomes its owner).
- `GET  /v1/tenants` — tenants the caller belongs to. `GET /v1/tenants/:id` — details.
- `PATCH /v1/tenants/:id` — owner/admin; rename/slug/status.
- `DELETE /v1/tenants/:id` — owner only; soft-delete/suspend.
- `GET  /v1/tenants/:id/members` — owner/admin; list memberships (safe projection).
- `POST /v1/tenants/:id/invites` — owner/admin; `{email, role}`; creates invitation +
  emails token.
- `POST /v1/invites/accept` — `{token, password?, name?}`; if the email has no user,
  create one; add membership; mint session.
- `PATCH /v1/memberships/:id` — owner/admin; change role (cannot demote the last owner).
- `DELETE /v1/memberships/:id` — owner/admin; remove member (cannot remove last owner).

### 5.3 Tenant-scoped API keys (session-auth to manage)
Replaces the operator-global key flow (`keys.ts`) with tenant-scoped issuance:
- `POST /v1/keys` — session-auth (admin/owner); mint via `issueSelfHostedApiKey`, then
  insert `api_key_tenants(kid, tenant_id=ctx.tenant, created_by_user_id)`. Return token
  once. Key scopes still restricted to `emails:read|write|*`.
- `GET /v1/keys` — list keys for `ctx.tenant` (join `api_keys` ⨝ `api_key_tenants`).
- `DELETE /v1/keys/:kid` — revoke, only if the key belongs to `ctx.tenant`.

### 5.4 Existing resource routes — isolation derivation
Every existing `/v1` route (domains, addresses, messages, messages/send, mailboxes,
threads, send-keys/mint+verify, and all generic resources) changes in exactly one way:
`authenticate()` → `resolveRequestContext()`, then `deps.store` → `deps.store.forTenant(
ctx.tenantId)`. **The tenant is never a path/query/body parameter** — it is derived from
the credential. A caller therefore cannot address another tenant's rows: every query is
`… WHERE tenant_id = ctx.tenant`, and a cross-tenant id simply 404s.

Role → scope mapping for downstream checks (keeps existing read/write scope gates intact):
- `viewer` → `['emails:read']` (read-only; adversarial fix L1 — a member must not be able
  to delete domains/addresses/messages or send).
- `member`/`admin`/`owner` → `['emails:read','emails:write']` for data routes.
- Member-management + tenant-config routes additionally require `role ∈ {admin, owner}`
  (or `owner` for destructive tenant ops) — a *role* gate, not a scope gate. **API keys
  can never hit member-management routes** (machine creds don't manage humans).

---

## 6. Tenant isolation — defense in depth

Three independent layers; any one alone would isolate, together they are belt-and-braces.

### Layer 1 (primary) — a tenant-scoped store, enforced by the type system
`EmailsSelfHostedStore.forTenant(tenantId): TenantScopedStore`. Handlers are **only ever**
handed a `TenantScopedStore`; the data-CRUD methods live on that type, so a handler that
forgets tenant context is a *compile error*, not a runtime leak. Every method injects
`tenant_id`:

- Hand-written methods (`domains/addresses/messages/*`, mail-views, send-key auth): every
  `SELECT/UPDATE/DELETE` gains `AND tenant_id = $tenant`; every `INSERT` sets `tenant_id`;
  send-intent conflict targets become `(tenant_id, idempotency_key)` / `(tenant_id,
  source_id)`; `listMailboxes`/`listThreads`/`messageCounts` filter by tenant.
- Generic resource layer (the chokepoint — covers all 24 registry resources): `listResource` adds
  `WHERE tenant_id = $tenant` (before other filters); `getResource/updateResource/
  deleteResource` add `AND tenant_id = $tenant`; `createResource` includes `tenant_id`;
  natural-key upserts (`email-agents`) use conflict target `(tenant_id, agent_key)`.

The unscoped base `EmailsSelfHostedStore` retains ONLY identity/system methods (used by the
auth resolver and background workers) + `forTenant()`.

### Layer 2 (backstop) — Postgres Row-Level Security — **CONDITIONAL; requires new infra**
Enabled in migration 0013 (after Layer 1 ships and is verified), on all 27 data tables.
The first draft got the mechanics wrong; the corrected design (adversarial fixes H1, H2,
H3, M1) is:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;   -- owner is also constrained (only meaningful for a NON-superuser owner)
CREATE POLICY <t>_tenant_isolation ON <t>
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
```

`current_setting('app.current_tenant', true)` is `''`/NULL when unset → `NULLIF(...,'')`
→ NULL → `tenant_id = NULL` matches nothing ⇒ **fail closed**. (The `NULLIF` guard is
required: casting `''::uuid` throws — M1.)

**Setting the GUC — corrected (M1, H3).** `SET LOCAL app.current_tenant = $1` is *invalid*
Postgres — `SET` takes no bind params. Use `set_config`, and set it **per store
operation, inside that operation's own short transaction**, NOT once per whole request:

```ts
// inside each TenantScopedStore method:
return this.client.transaction(async (tx) => {
  await tx.execute(`SELECT set_config('app.current_tenant', $1, true)`, [this.tenantId]);
  return /* the scoped query on tx */;
});
```

Why per-operation, not per-request: `/v1/messages/send` is a deliberate **multi-commit,
exactly-once** state machine — `reserveSendIntent` COMMITs a `pending` row *before* the
provider network call, then `claimSendIntent` → `sender.send()` (external HTTP) →
`completeSendIntent` (`service.ts:587-682`). Wrapping the whole handler in one transaction
(a) would lose the exactly-once guarantee on rollback and (b) would hold a pooled
connection (pool max 10) open across the provider HTTP call → exhaustion. Per-operation
`set_config(...,true)` keeps each mutation atomic, releases the connection during the
provider call, and never holds a tx across a network hop. **Never open a transaction across
an external side effect.**

**Credential→tenant resolution must not read RLS-forced tables (H2).** The resolver learns
the tenant *from* a credential, so it cannot have set the GUC yet. Any table it must read
before the tenant is known is therefore **excluded from tenant RLS**:
- Identity/auth tables (`tenants/users/memberships/sessions/api_key_tenants/invitations/
  password_reset_tokens`) — never under tenant RLS.
- **send-key resolution**: today `verifySendKey` reads `send_key_secrets` (global) then
  `send_keys` (which would be RLS-forced). Fix: add a non-RLS `send_key_tenants(send_key_id
  → tenant_id)` map (mirroring `api_key_tenants`) OR carry `tenant_id` on the non-RLS
  `send_key_secrets`; resolve tenant from that, THEN set the GUC and read `send_keys`
  scoped.
- **inbound routing**: read via the non-RLS global `inbound_domain_routes` table (§6
  cross-cutting #1), never via the RLS-forced `domains`/`addresses`.

**Role model — this is NEW infra, not existing (H1).** The first draft claimed the server
"already assumes a two-role model." It does **not**: `migrate.ts` and `serve.ts` both use
the single `EMAILS_DATABASE_URL` (`env.ts`); the only "role" reference is a comment
(`service.ts:41`). If that single DSN is a superuser or has `BYPASSRLS` (common for a
self-hosted operator's master DSN), `FORCE ROW LEVEL SECURITY` is **silently ignored** and
Layer 2 provides zero isolation. Therefore RLS is **contingent on introducing**:
1. a migration/owner role (has `CREATE`; owns tables; runs 0012/0013), and
2. a **separate serving DSN** (`EMAILS_APP_DATABASE_URL`) whose role is non-owner and
   explicitly `NOBYPASSRLS`, used by `serve.ts` for request handling.
Plus a **boot-time assertion** that the serving role is actually subject to RLS (probe
`SHOW row_security` / a canary insert that must be blocked) before the server claims the
backstop exists. Until that infra lands, Layer 1 (typed scoped store) is the *sole*
isolation guarantee — which is acceptable, but the doc must not overstate Layer 2.

### Layer 3 — `NOT NULL` + no permanent default
After rollout, `tenant_id` is `NOT NULL` with **no** default (the transitional default is
dropped in 0013), so any insert that fails to set tenant_id is a loud constraint violation
rather than a silent write into the wrong tenant.

### Cross-cutting: writers that arrive WITHOUT a tenant context
Three paths receive a credential/event that must be *resolved* to a tenant before scoped
writes:
1. **Inbound mail / ingest worker + provider webhooks (adversarial fix C1 — the single
   most dangerous *writeable* leak).** Incoming mail/events carry no tenant. The first
   draft said "match recipient address/domain" — but the ingest worker today prefers the
   **MIME `To:` header** (`parsed.to_addrs`, attacker-controlled) over the SES envelope
   recipients (`note.recipients`), and §3.3 makes `domains` per-tenant-unique, so the same
   domain could resolve to two tenants. Both make header-based routing spoofable into a
   cross-tenant WRITE. Corrected rules:
   - Route from the **SES envelope recipient only** (`note.recipients`), never the MIME
     `To:`/`Cc:` headers.
   - Resolve tenant via a **global, single-tenant `inbound_domain_routes(domain UNIQUE →
     tenant_id)`** table (a physical receiving domain belongs to exactly ONE tenant at the
     DNS/SES layer). This is a *non-RLS* routing table (read before the GUC is set, H2). Do
     NOT resolve via the per-tenant-unique `domains` table.
   - Zero-match or ambiguous (recipients spanning >1 tenant) ⇒ **quarantine**, never write
     to a default/arbitrary tenant. A multi-tenant recipient set is split per envelope
     recipient, each written only to its resolved tenant.
   - Once tenant is resolved, `set_config` it and write the message/event + the
     `webhook_receipts (tenant_id, provider, event_id)` dedup scoped to that tenant. The
     `findMessageIdByKey` dedup then runs tenant-scoped (correct, since `source_id` is now
     per-tenant).
2. **Send-key token verify** (`/v1/send-keys/verify`). The token is the tenant-bearing
   credential: global `key_hash` lookup on the non-RLS `send_key_secrets` → a non-RLS
   `send_key_tenants` map (or `tenant_id` on `send_key_secrets`) yields `tenant_id`; then
   set the GUC and read `send_keys` + `isOwnerAuthorizedFrom` scoped to that tenant (H2).
3. **API-key verify** — `kid` → `api_key_tenants.tenant_id` (already covered).

---

## 7. Client impact

Minimal, because both chokepoints already send `Authorization: Bearer <cred>` and both
read one config object.

- **Config**: add `EMAILS_SESSION_TOKEN` to `CLIENT_ENV_KEYS`
  (`src/lib/client-env.ts`) and to `SelfHostedConfig`. `resolveSelfHostedConfig`
  (`src/db/self-hosted-store.ts:70`) prefers a session token when present, else the API
  key, and threads whichever into `SelfHostedConfig.credential`. Both chokepoints
  (`httpRequest` `:186`, `SelfHostedMailDataSource.request` `:324`) put `credential` in the
  Bearer slot — no per-callsite change beyond reading the new field. Tenant is *never* sent
  by the client (no client-side tenant spoofing surface).
- **CLI** (`src/cli/commands/auth.ts`, new): `emails auth signup`, `emails auth login`
  (prompt email/password; on `needs_tenant`, prompt which org; persist the returned
  `session_token` to the vault entry behind `EMAILS_CLIENT_ENV_SECRET`), `emails auth
  logout`, `emails whoami` (`GET /v1/me`), `emails auth switch-tenant`, `emails auth
  bootstrap` (uses the existing API key to create the first owner user). `emails keys …`
  becomes tenant-scoped (must be logged in as admin/owner).
- **MCP/TUI**: no protocol change — they use the same config/chokepoints. Surface tenant +
  identity via a `whoami`/context call so the TUI header can show the active org.
- **Back-compat**: an operator who keeps using only `EMAILS_SELF_HOSTED_API_KEY` continues
  to work unchanged — their key maps to the default tenant (§9 backfill). Sessions are
  additive.

---

## 8. Security

- **Passwords**: argon2id (§4.1); rehash-on-login when params drift; never logged, never in
  any resource projection, never in `/v1/me`.
- **Sessions/tokens/keys**: 256-bit random; store only `sha256` hash; constant-time lookup
  via unique index; bearer over TLS only; `token_hash`/`password_hash`/`key_hash` tables
  excluded from `SELF_HOSTED_RESOURCES`.
- **Tenant isolation**: three layers (§6); RLS fail-closed backstop; `FORCE ROW LEVEL
  SECURITY`; tenant derived from credential, never from client input.
- **Enumeration & timing**: login/reset return generic messages; login always performs an
  argon2 verify against a fixed dummy hash when the email is unknown to equalize timing;
  password/forgot always 200. Public signup with an existing email → generic response +
  "you already have an account" email (or 409 for invite-only/internal deployments —
  configurable).
- **Rate limiting** (`src/server/self-hosted/auth/rate-limit.ts`, new): in-process
  sliding-window keyed by `(route, ip)` and `(route, email)` for login/signup/forgot
  (e.g. login 5/15min per ip+email; signup 3/hour per ip). Durable per-account lockout via
  `users.failed_login_count` + `users.locked_until` with escalating backoff. Optional
  invite-only toggle disables public signup. (Single-process `Bun.serve` ⇒ in-memory is
  fine; note a DB/Redis counter is needed if horizontally scaled.)
- **Session hygiene**: fresh session on login; rotate/revoke on password reset and role
  change; `logout-all`; sliding expiry with absolute cap.
- **CSRF/cookies**: bearer-only (CLI) ⇒ no CSRF surface. If a browser cookie session is
  added later: `HttpOnly`+`Secure`+`SameSite=Lax/Strict` + CSRF tokens.
- **Audit**: extend the existing secret-free audit line (`serve.ts`) with
  `principalType`, `tenant`, `userId?`/`kid?`, outcome — never token/password material.
- **Invites/resets**: single-use, short TTL, hashed at rest, bound to email/tenant.

---

## 9. Migration sketch

Two new migrations, appended in `emailsSelfHostedMigrations()` after
`PARITY_RESOURCE_SCHEMA_2` (0011). Ids ≤0011 are frozen.

### `0012_emails_tenancy_identity_and_backfill` (additive, safe, zero-downtime)
Runs under the migration role, ideally inside the ledger's transaction.

```sql
-- 0. extensions
CREATE EXTENSION IF NOT EXISTS citext;

-- 1. identity tables (see §3.1 for full columns)
CREATE TABLE IF NOT EXISTS tenants (...);
CREATE TABLE IF NOT EXISTS users (...);
CREATE TABLE IF NOT EXISTS memberships (...);
CREATE TABLE IF NOT EXISTS sessions (...);
CREATE TABLE IF NOT EXISTS api_key_tenants (...);
CREATE TABLE IF NOT EXISTS invitations (...);
CREATE TABLE IF NOT EXISTS password_reset_tokens (...);
-- non-RLS resolution tables (read before a tenant GUC exists — H2/C1):
CREATE TABLE IF NOT EXISTS inbound_domain_routes (          -- global single-tenant receive map
  domain     TEXT PRIMARY KEY,                              -- one physical domain -> one tenant
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS send_key_tenants (               -- credential -> tenant (mirrors api_key_tenants)
  send_key_id TEXT PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);

-- 1b. dedupe webhook_receipts BEFORE adding the new unique (M2)
DELETE FROM webhook_receipts a USING webhook_receipts b
  WHERE a.provider = b.provider AND a.event_id = b.event_id AND a.ctid < b.ctid;

-- 2. default tenant (fixed sentinel id for deterministic backfill)
INSERT INTO tenants (id, slug, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default Tenant', 'active')
ON CONFLICT (id) DO NOTHING;

-- 3. per data table (repeat for all 27):
ALTER TABLE domains ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE domains SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE domains ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001'; -- TRANSITIONAL
ALTER TABLE domains ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE domains ADD CONSTRAINT domains_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS domains_tenant_idx ON domains (tenant_id);
-- swap global unique -> per-tenant (names discovered via pg_constraint in the real impl)
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_domain_key;
DROP INDEX IF EXISTS domains_domain_key;
CREATE UNIQUE INDEX IF NOT EXISTS domains_tenant_domain_uidx ON domains (tenant_id, domain);

-- messages: rebuild the partial unique indexes tenant-scoped
DROP INDEX IF EXISTS messages_source_id_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_source_id_uidx
  ON messages (tenant_id, source_id) WHERE source_id IS NOT NULL;
DROP INDEX IF EXISTS messages_idempotency_key_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_idempotency_key_uidx
  ON messages (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- email_agent_settings PK change
ALTER TABLE email_agent_settings ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE email_agent_settings SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE email_agent_settings ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE email_agent_settings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE email_agent_settings DROP CONSTRAINT IF EXISTS email_agent_settings_pkey;
ALTER TABLE email_agent_settings ADD PRIMARY KEY (tenant_id, agent_key);

-- 4. bind EVERY existing api key to the default tenant (keeps the deployed operator working)
INSERT INTO api_key_tenants (kid, tenant_id)
SELECT kid, '00000000-0000-0000-0000-000000000001' FROM api_keys
ON CONFLICT (kid) DO NOTHING;
-- backfill the resolution maps to the default tenant
INSERT INTO send_key_tenants (send_key_id, tenant_id)
SELECT id, '00000000-0000-0000-0000-000000000001' FROM send_keys
ON CONFLICT (send_key_id) DO NOTHING;
INSERT INTO inbound_domain_routes (domain, tenant_id)
SELECT domain, '00000000-0000-0000-0000-000000000001' FROM domains
ON CONFLICT (domain) DO NOTHING;

-- 5. webhook_receipts new tenant-scoped unique (after dedupe in step 1b)
CREATE UNIQUE INDEX IF NOT EXISTS webhook_receipts_tenant_provider_event_uidx
  ON webhook_receipts (tenant_id, provider, event_id);
```

Notes: the **transitional DEFAULT** means that during the brief deploy window any
still-running old code (which doesn't set `tenant_id`) writes into the default tenant
instead of erroring — no crash, no data loss. It is removed in 0013.

### `0013_emails_tenancy_rls_and_seal` (after new code is deployed & verified)
```sql
-- drop the transitional default so forgotten scoping fails loudly (Layer 3)
ALTER TABLE domains ALTER COLUMN tenant_id DROP DEFAULT;   -- ...repeat all 27

-- enable RLS + fail-closed policy (Layer 2), repeat all 27 data tables
-- PREREQUISITE (H1): a separate NOBYPASSRLS, non-owner serving role + EMAILS_APP_DATABASE_URL
-- must exist and serve.ts must use it; otherwise FORCE RLS on a superuser/BYPASSRLS DSN is a no-op.
ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE domains FORCE ROW LEVEL SECURITY;
CREATE POLICY domains_tenant_isolation ON domains
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)  -- NULLIF: '' would throw (M1)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON domains TO emails_app;  -- serving role, not owner
```
Boot-time assertion (serve.ts): probe that the serving role is genuinely under RLS (e.g.
attempt an unscoped read that must return 0 rows) before logging that the backstop is
active — never assume `FORCE` took effect.

`webhook_receipts` unique also becomes `(tenant_id, provider, event_id)` (0012), and the
ingest/webhook path resolves tenant before writing (§6 cross-cutting).

---

## 10. Rollout ordering (must not break the deployed single operator)

1. **Release N** ships together: migration 0012 **+** all Layer-1 tenant-aware code
   (scoped store, `resolveRequestContext`, api_key_tenants lookup, auth endpoints). Boot
   runs 0012: identity tables created, all rows + all existing keys backfilled to the
   default tenant, transitional DEFAULT in place. The operator's existing
   `EMAILS_SELF_HOSTED_API_KEY` keeps working (its `kid` now maps to default tenant); all
   existing data is visible under the default tenant. Sessions become available; operator
   runs `emails auth bootstrap` to create their owner user.
2. **Verify in prod**: existing key reads/writes work; all data under default tenant; new
   signup/login works; isolation tests green.
3. **Release N+1** ships migration 0013: drop transitional DEFAULT, enable RLS. (Kept
   separate so RLS is only sealed once every query is proven tenant-scoped — enabling RLS
   before the app is tenant-aware would blank every read.)
4. Background workers (ingest) updated to resolve tenant per item before N+1's RLS seal.

This staging guarantees zero manual data steps and zero downtime for the currently
deployed operator.

---

## 11. Phased build plan (parallelizable; explicit file ownership)

Sole-owner files are noted to avoid merge conflicts across build agents.

**Phase 0 — foundations (blocking).**
- **WI-0a Auth primitives.** New `src/server/self-hosted/auth/password.ts` (argon2id
  hash/verify/needsRehash + dummy-hash for timing) and `auth/tokens.ts` (mint/hash/
  compare opaque `emss_`/reset/invite tokens). Owner A. No deps. + unit tests.
- **WI-0b Migration 0012.** Append to `src/server/self-hosted/migrations.ts` (identity
  tables, tenant_id on all 27, unique swaps, PK change, backfill, api_key_tenants
  backfill, transitional default). Owner B (sole writer of migrations.ts this phase).
  Deps: none. This is the schema spine.

**Phase 1 — server tenant scoping (dep: 0b).**
- **WI-1a Scoped store.** `src/server/self-hosted/store.ts` — add `forTenant()` +
  `TenantScopedStore`; inject `tenant_id` into all hand-written queries + the generic
  resource layer; tenant-scope send-intent conflict targets + mail-views. Move
  data-CRUD onto the scoped type. Owner C (**sole writer of store.ts**).
  **Enumerated hand-written leak points that a blanket rule misses (adversarial fix M3)** —
  each needs an explicit `AND tenant_id = $tenant` and a foreign-tenant-id test:
  `getDomainByName` (`:387`, backs the POST 409 pre-check — unscoped both leaks and wrongly
  blocks per-tenant registration), `reserveSendIntent` fallback select by `idempotency_key`
  (`:780-786`), `getMessageAttachment` (`:683`), `findMessageIdByKey` (`:711`),
  `isOwnerAuthorizedFrom` (`:1190`), plus `listMailboxes`/`listThreads`/`messageCounts`
  rollups. **Body-supplied FK validation (M4)**: `mintSendKey` `owner_id` (`service.ts:835`)
  and generic `createResource` FKs (`group_id`/`sequence_id`/`address_id`/`provider_id`)
  must be verified to belong to `ctx.tenant` before insert — stamping `tenant_id` alone
  does not stop a cross-tenant reference.
- **WI-1b Resource registry metadata.** `src/server/self-hosted/resources.ts` — annotate
  the composite key for `email-agents` and confirm all resources are tenant-scoped. Small;
  Owner C (bundle with 1a — tightly coupled).

**Phase 2 — auth service + endpoints (dep: 0a, 0b; parallel with Phase 1).**
- **WI-2a Auth store.** New `src/server/self-hosted/auth/store.ts` — CRUD for tenants/
  users/memberships/sessions/api_key_tenants/invites/reset; **transactional signup**;
  `resolveSessionContext`/`resolveApiKeyContext`. Owner D.
- **WI-2b Auth handlers + resolver.** New `src/server/self-hosted/auth/service.ts` —
  `/v1/auth/*`, `/v1/me`, `/v1/tenants*`, `/v1/memberships*`, `/v1/keys*`, and
  `resolveRequestContext()`. Owner D (coordinates with 2a).
- **WI-2c Rate limiter.** New `src/server/self-hosted/auth/rate-limit.ts` + account
  lockout. Owner D.
- **WI-2d Integration seam.** `src/server/self-hosted/service.ts` — replace
  `authenticate()` with `resolveRequestContext()`, route `/v1/auth/*` (+ mgmt) before the
  resource matcher, wrap authenticated routes in the `SET LOCAL` transaction, hand every
  route a `forTenant` store. Owner E (**sole writer of service.ts**). Dep: 1a (`forTenant`)
  + 2b (`resolveRequestContext`) — sequence last among server WIs.
- **WI-2e Keys module.** `src/server/self-hosted/keys.ts` — issuance also writes
  `api_key_tenants`; list/revoke scoped by tenant. Owner D.

**Phase 3 — client wiring (dep: 2b API contract; can start against the contract).**
- **WI-3a Client credential.** `src/lib/client-env.ts` (+`EMAILS_SESSION_TOKEN`),
  `src/db/self-hosted-store.ts` (`resolveSelfHostedConfig`, `httpRequest` credential),
  `src/lib/self-hosted-mail-data-source.ts` (`request` credential). Owner F.
- **WI-3b CLI auth.** New `src/cli/commands/auth.ts` (signup/login/logout/whoami/
  switch-tenant/bootstrap) + persist session token to the vault entry; tenant-scope
  `keys` command. Owner G.
- **WI-3c MCP/TUI context.** Surface `whoami`/active-tenant in MCP + TUI header. Owner H.

**Phase 4 — RLS seal (dep: Phase 1 verified in prod; H1/H2/H3).**
- **WI-4a-0 Serving role + DSN (PREREQUISITE, H1).** Introduce a non-owner `NOBYPASSRLS`
  serving role + `EMAILS_APP_DATABASE_URL`; point `serve.ts` request handling at it
  (keep `EMAILS_DATABASE_URL` for `migrate.ts`); add a boot assertion that the serving
  role is genuinely under RLS. Owner I. **RLS must not be enabled until this lands.**
- **WI-4a Migration 0013 + system writers.** Append 0013 (drop transitional default,
  enable+FORCE RLS with the `NULLIF(...set_config...)` policy). Update ingest worker
  (`src/server/self-hosted/ingest-worker.ts`) to route from the **SES envelope recipient**
  via `inbound_domain_routes`, resolve tenant off non-RLS tables, then `set_config` +
  scoped writes; quarantine unresolved/ambiguous (C1/H2). Owner B (migrations) + I
  (ingest). Must land only after Phase 1 verified.

**Phase 5 — tests (parallel; one QA owner per source WI).**
- WI-5a auth primitives (password/tokens/rate-limit). WI-5b auth endpoints
  (signup/login/logout/me/invite/switch/reset). **WI-5c tenant-isolation matrix** — for
  EVERY resource, tenant A cannot list/get/patch/delete tenant B's rows; per-tenant
  idempotency/source_id; send-key token resolves the right tenant; api-key-without-mapping
  → 403. WI-5d migration/backfill (existing rows→default; existing key still works; NOT
  NULL enforced). WI-5e RLS (raw query without `SET LOCAL` returns/writes nothing;
  `FORCE` honored). Update `parity.test.ts`/`postgres.integration.test.ts`.

Critical path: **0b → 1a → 2d → 5c** (schema → scoped store → integration → isolation
proof). 0a/2a/2b/2c and 3a/3b/3c parallelize off that spine.

---

## 12. Adversarial review — risks & mitigations

- **Pooled `SET LOCAL` leakage.** `SET` (not `SET LOCAL`) or a `SET LOCAL` outside a
  transaction would leak tenant context across pooled connections. Mitigation: RLS context
  is set ONLY via `SET LOCAL` inside `PoolQueryClient.transaction()` (dedicated connection,
  auto-reset on COMMIT/ROLLBACK). Add a test that runs two interleaved requests and proves
  no bleed.
- **Inbound mail with no tenant (biggest risk — C1).** A received email/webhook has no
  credential. Wrong routing = cross-tenant data placement (a leak that *writes*).
  Mitigation (corrected, see §6 cross-cutting #1): **envelope-recipient-only** routing via
  a **global single-tenant `inbound_domain_routes`** table; quarantine on zero/ambiguous;
  split multi-recipient mail per envelope recipient. Do NOT route from the MIME `To:`
  header (spoofable) and do NOT resolve via the per-tenant-unique `domains` table.
- **RLS enabled before code is scoped.** Would blank all reads. Mitigation: strict
  ordering — RLS is 0013, a separate release after Layer-1 is verified.
- **Backfill of legacy/odd rows.** 0012 backfill must touch every table incl. the
  audit/append-only ones. Mitigation: enumerate all 27; the transitional DEFAULT catches
  any row created mid-deploy; `NOT NULL` proves completeness.
- **Constraint-name drift on legacy DBs.** `domains_domain_key` etc. may be named
  differently on old databases. Mitigation: the real migration discovers unique-constraint
  names from `pg_constraint`/`pg_index` rather than hard-coding, with `IF EXISTS` guards.
- **`agent`-claim tenant trust.** Rejected as the boundary; `api_key_tenants` (DB fact) is
  authoritative; fail-closed on missing mapping.
- **Session/key ambiguity.** Prefix dispatch (`hasna_` vs `emss_`) must be exhaustive;
  anything else → 401. Add a test for a malformed/foreign prefix.
- **Last-owner lockout.** Role change/member removal must refuse to drop the final owner of
  a tenant. Enforced in `memberships` handlers + a DB check.
- **Enumeration/timing.** Constant-time login path incl. unknown-email dummy verify;
  generic reset responses.
- **Send-key token = cross-tenant lookup by design.** `key_hash` is global; the token
  itself carries the tenant via its `send_keys` row. Verified: this is intended and does
  not leak (a token holder already possesses that tenant's send credential).

## 13. Open decisions (flag before build)
1. Public signup vs invite-only default (recommend invite-only for an internal tool;
   `AUTH_SIGNUP_MODE` env).
2. One tenant per user session vs multi-tenant token with per-request tenant selection
   (recommend one-tenant-per-session + `switch-tenant`; simpler isolation).
3. Password reset delivery when no sender is configured (log vs hard-require a sender).
4. Whether to also set api key `agent="<tenantId>"` for audit readability (recommend yes,
   non-authoritative).
5. MFA/TOTP timing (out of scope now; schema leaves room on `users`).

---

## 14. Adversarial review reconciliation (v2)

Independent security review findings and their disposition. Build agents must satisfy the
"resolved by" column; unresolved items are gating.

| # | Sev | Finding | Resolved by |
|---|-----|---------|-------------|
| C1 | Critical | Inbound routing used spoofable MIME `To:`; per-tenant `domains` uniqueness contradicted "single-tenant domain" | §6 x-cut #1 + §12: envelope-only routing via global `inbound_domain_routes`; quarantine ambiguous |
| H1 | High | "Two-role DB model" does not exist (single DSN; superuser/BYPASSRLS ⇒ `FORCE RLS` is a no-op) | §6 Layer 2: RLS made **contingent** on new `EMAILS_APP_DATABASE_URL` `NOBYPASSRLS` serving role + boot assertion; Layer 1 is sole guarantee until then |
| H2 | High | Credential→tenant resolution reads RLS-forced tables (`send_keys`, `domains`) before GUC set ⇒ breaks under FORCE | §6 Layer 2 + x-cut: non-RLS resolution tables `send_key_tenants`, `inbound_domain_routes`; identity tables never RLS'd |
| H3 | High | Per-request `transaction` wrapper breaks the `/v1/messages/send` exactly-once state machine + holds a pooled conn across the provider HTTP call | §6 Layer 2: GUC set **per store operation** via `set_config(...,true)`; never a tx across an external side effect; send route carved out |
| M1 | Med | `SET LOCAL app.current_tenant = $1` is invalid SQL; `''::uuid` throws | §6/§9: `SELECT set_config(...)`; `NULLIF(current_setting(...),'')::uuid` |
| M2 | Med | `webhook_receipts` has no unique to "convert"; new unique can fail on dupes; §3.3 omitted it | §3.3 row added; §9 dedupe-then-`CREATE UNIQUE INDEX` |
| M3 | Med | Specific hand-written reads left unscoped (`getDomainByName`, `reserveSendIntent` fallback, `getMessageAttachment`, `findMessageIdByKey`, `isOwnerAuthorizedFrom`, rollups) | WI-1a enumerates them + per-method foreign-tenant tests |
| M4 | Med | Body-supplied FK ids (`owner_id`, `group_id`, …) not validated against `ctx.tenant` | WI-1a: validate referenced rows belong to tenant before insert |
| M5 | Med | Last-owner-lockout guard racy | §5.2: `SELECT … FOR UPDATE` owners / transactional count check |
| M6 | Med | API keys minted by a user not revoked when their membership is removed | §5.2: on membership removal, revoke `api_key_tenants` rows `created_by_user_id = removed` |
| M7 | Med | Password-reset token logged to stdout contradicts §8 | §5.1/§8: never log token; hard-require a sender (or emit only a correlation id) |
| L1 | Low | No read-only role (member can delete/send) | Added `viewer` role → `['emails:read']` (§3.1, §5.4) |
| L2 | Low | Legacy DBs may lack the original UNIQUE / carry dupes ⇒ `CREATE UNIQUE INDEX` fails | §9: pre-dedupe + discover/guard constraint names via `pg_constraint`; tolerate absent old constraint |
| L3 | Low | argon2id verify is a CPU/mem DoS amplifier on the single Bun loop | §8: rate-limit + cheap per-IP pre-filter/cost cap before the verify |
| L4 | Low | Count nit: **24** generic registry resources; **27** = 24 + 3 hand-written (domains/addresses/messages) | Wording noted here; WI-5c must cover all 27 tables + 3 hand-written paths + assert secret tables unreachable |

**Net posture after v2.** Layer 1 (typed `forTenant` store) is the isolation that holds
unconditionally and must be complete (M3/M4). Layer 2 (RLS) is a real backstop **only once
the second serving role lands** (H1) and is wired off non-RLS resolution tables (H2) with
per-operation `set_config` (H3, M1); until then it is documented as aspirational, not
relied upon. Layer 3 (NOT NULL, no default) is sound. The one writeable leak (C1) is closed
by envelope-only routing through a global single-tenant domain map.

---

## 15. Implementation reconciliation (v3)

The implementation now has exactly two deployment modes: local SQLite and
operator-owned `self_hosted` PostgreSQL. It has no hosted SaaS control plane and
no hybrid synchronization mode. Passing an explicit Bun `Database` handle to
the public library always selects that caller-owned SQLite database, even when
the process is otherwise configured as a self-hosted client.

The self-hosted schema is additive through migrations 0012–0016:

- 0012 adds tenant/identity/session/membership/API-key binding and tenant-scopes
  existing resources with a default-tenant backfill;
- 0013 seals the RLS model, while API startup rejects a superuser or
  `BYPASSRLS` serving role;
- 0014 adds indexed message-ID prefix resolution;
- 0015 adds multiple verified email identities per user, the singleton primary
  super-admin flag, and an audit-safe bootstrap ledger;
- 0016 makes inbound-domain ownership atomic and quarantines/removes stale,
  pending, or unverified legacy routes before new writers run.

User sessions, tenant API keys, invitations, memberships, password reset, email
verification, tenant switching, and multiple login email identities are wired
through the HTTP service and formal OpenAPI-generated SDK. Member sessions must
present a sender-scoped send key; owner/admin sessions and tenant API keys retain
tenant-wide send authority. Envelope recipients—not spoofable MIME headers—own
inbound tenant routing.

Primary super-admin bootstrap is deliberately not authorized by matching an
email alone. The operator configures both an exact lowercase email and one exact
API-key KID; the endpoint is singleton, race-idempotent, rejects other KIDs, and
never records or logs the password or token. The generic AWS module exposes the
email/KID as paired nullable API-only settings and never hardcodes a person or
accepts the token in Terraform.

Production ordering is a hard gate: drain old API/worker/ingest writers; deploy
new-code-compatible migration tooling; run migrations through 0016; then start
only the new API and worker tasks. After 0016, never roll back to an old unscoped
writer. A rollback may restore the previous new-code-compatible image, but not a
pre-tenancy writer.

Required release evidence is: full local suite, real PostgreSQL migration +
multi-tenancy + RLS + message-ID suites, generated SDK sync, public package
identity/contents, staged secret scan, immutable image scan, primary-super-admin
idempotency/DB/API proof, local SQLite smoke, and self-hosted HTTPS smoke.

---

## Addendum (owner requirements, 2026-07-13)

### A1. Signup/login restricted to @hasna.<tld>
Only email addresses whose domain matches `hasna.<tld>` may sign up OR log in
(hasna.com, hasna.xyz, hasna.studio, etc.). Enforce with a single allowlist
predicate `isAllowedSignupEmail(email)` — regex `^[^@]+@hasna\.[a-z0-9-]+$`
(case-insensitive), applied at BOTH `/v1/auth/signup` and `/v1/auth/login`
(reject non-matching with a generic 403, no enumeration). Make the allowed
pattern configurable via env (`EMAILS_AUTH_ALLOWED_EMAIL_DOMAINS`, default
`hasna.*`) so it can widen later without a code change. Applies to invitations
too (cannot invite a non-hasna address).

### A2. Email confirmation via the hasna-studio-alumia SES account
Signup creates the user `unverified`; login is refused until verified. On signup
(and a `/v1/auth/verify-email/resend`), send a confirmation email containing a
single-use, short-TTL, hashed-at-rest email-verification token (reuse the
`emiv_`/token pattern) with a verify link → `/v1/auth/verify-email` marks the
user verified. Send via the app's existing SES sender (`SelfHostedSender`) using
the **hasna-studio-alumia** SES account (638389534677 — where the app's SES
identities already live), from a hasna-verified from-address
(`EMAILS_AUTH_FROM`, e.g. `noreply@hasna.studio`). The server runs in
xyz-infra, so sending via alumia SES is cross-account: prefer the app's normal
outbound path (which already targets alumia SES) rather than new creds; if the
send path needs an explicit account/region, thread it through. Never block
signup on a transient send failure — record the token, surface a resend.
