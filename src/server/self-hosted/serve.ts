// Bootstraps and runs the Emails self-hosted service (Bun.serve).
//
// Wires the product-owned Postgres pool, the API-key verifier
// (@hasna/contracts/auth), the migration set, and the request handler together.

import { ApiKeyStore, type ApiKeyVerifier } from "@hasna/contracts/auth";
import { assertServingRoleCannotBypassRls } from "./rls-guard.js";
import { getSelfHostedPool, requireSigningSecret, SELF_HOSTED_APP, SELF_HOSTED_APP_ALIASES } from "./env.js";
import { verifyApiKeyWithAliases } from "./api-key-verifier.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { buildSelfHostedSender } from "./sender.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { buildAuthMailerConfig } from "./auth/mailer.js";

/** Assemble the service dependencies from the environment. */
export function buildSelfHostedService(version: string): SelfHostedServiceDeps {
  const { client } = getSelfHostedPool();
  const signingSecret = requireSigningSecret();
  const keys = new ApiKeyStore(client);
  // Accept the canonical "mailery" app slug AND the legacy "emails" alias so
  // API keys issued before the rename keep authenticating (see env.ts).
  const verifier: ApiKeyVerifier = verifyApiKeyWithAliases(
    {
      signingSecret,
      isRevoked: keys.statusChecker(),
      audit: (e) => {
        // Structured, secret-free audit line (kid + outcome only).
        console.log(
          `[api-auth] ${e.outcome} app=${e.app} kid=${e.kid ?? "-"} reason=${e.reason ?? "-"} ` +
            `${e.method ?? "-"} ${e.path ?? "-"} status=${e.status}`,
        );
      },
    },
    [SELF_HOSTED_APP, ...SELF_HOSTED_APP_ALIASES],
  );
  return {
    client,
    store: new EmailsSelfHostedStore(client),
    verifier,
    sender: buildSelfHostedSender(),
    migrations: emailsSelfHostedMigrations(),
    version,
    // ---- multi-tenancy + auth (WI-2) ----
    // AuthStore needs the pool client (transactions for signup/invite/reset).
    authStore: new AuthStore(client),
    keyStore: keys,
    signingSecret,
    rateLimiter: new RateLimiter(),
    mailer: buildAuthMailerConfig(),
    env: process.env,
  };
}

// The RLS boot guard now lives in a light standalone module so the headless
// ingest worker can reuse it without importing the request-server graph. Kept
// re-exported here for existing importers (e.g. rls.integration.test.ts).
export { assertServingRoleCannotBypassRls };

/** Start the self-hosted HTTP server. */
export async function startSelfHostedServer(
  version: string,
  port = Number(process.env["PORT"] ?? "8080") || 8080,
  hostname = process.env["HOST"] ?? "0.0.0.0",
): Promise<{ port: number; stop: () => void }> {
  const deps = buildSelfHostedService(version);
  // Defense-in-depth: never serve with the RLS backstop silently disabled.
  await assertServingRoleCannotBypassRls(deps.client);

  const server = Bun.serve({
    port,
    hostname,
    fetch: async (req) => {
      const response = await handleSelfHostedRequest(deps, req);
      if (response) return response;
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  console.log(`Emails self-hosted service listening on http://${hostname}:${server.port}`);
  console.log(`  probes: GET /health  GET /ready  GET /version`);
  console.log(`  api:    /v1/domains  /v1/addresses  /v1/messages  /v1/messages/send  (x-api-key required)`);
  console.log(`  alias:  /api/v1/* is accepted as an alias for /v1/* (native client compatibility)`);

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}
