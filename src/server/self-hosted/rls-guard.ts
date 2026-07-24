// Shared Row-Level-Security boot guard for the Emails self-hosted service.
//
// Extracted from serve.ts so BOTH the request server (serve.ts) and the headless
// SES-inbound ingest worker (ingest-worker.ts) can fail closed at boot without
// the worker having to import the heavyweight request-server module graph.

import type { TypedQueryClient } from "../../storage-kit/index.js";

/**
 * Boot-time defense so Row-Level Security (migration 0013) can NEVER be silently
 * off: `FORCE ROW LEVEL SECURITY` is a no-op for a role that bypasses RLS (a
 * superuser or a `BYPASSRLS` role), which would leave Layer 2 disabled while the
 * process believes the backstop exists. If the serving role can bypass RLS we
 * refuse to start, loudly, rather than run with the backstop disabled.
 *
 * The serving role `emails_app` is deliberately `NOSUPERUSER NOBYPASSRLS` (and
 * owns the tables, so FORCE subjects it to its own policies). This asserts that
 * invariant at every boot. A role can always read its own `pg_roles` row.
 */
export async function assertServingRoleCannotBypassRls(client: TypedQueryClient): Promise<void> {
  const row = await client.get<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  if (!row) {
    throw new Error(
      "RLS boot assertion failed: could not read the serving DB role's attributes (pg_roles).",
    );
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `RLS boot assertion FAILED: serving DB role '${row.rolname}' can bypass Row-Level Security ` +
        `(rolsuper=${row.rolsuper}, rolbypassrls=${row.rolbypassrls}). FORCE ROW LEVEL SECURITY is a ` +
        `silent no-op for such a role, so tenant isolation Layer 2 would be OFF. Refusing to start. ` +
        `Point EMAILS_DATABASE_URL at a NOSUPERUSER, NOBYPASSRLS serving role (design §6 Layer 2 / H1).`,
    );
  }
}
