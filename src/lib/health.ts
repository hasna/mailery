import { listActiveProviders } from "../db/providers.js";
import { getDatabase } from "../db/database.js";
import { countValue } from "../db/scalars.js";
import { getAdapter } from "../providers/index.js";
import type { Database } from "../db/database.js";
import type { Provider } from "../types/index.js";
import type { ProviderHealth } from "./provider-health-format.js";

export { formatProviderHealth } from "./provider-health-format.js";
export type { ProviderHealth } from "./provider-health-format.js";

export interface ProviderHealthOptions {
  validateCredentials?: boolean;
}

interface ProviderLocalHealthMetrics {
  domainCount: number;
  verifiedDomains: number;
  addressCount: number;
  verifiedAddresses: number;
  bounceRate: number;
}

function locallyConfigured(provider: Provider): { ok: boolean; message?: string } {
  switch (provider.type) {
    case "sandbox":
      return { ok: true };
    case "resend":
      return provider.api_key ? { ok: true } : { ok: false, message: "Missing Resend API key" };
    case "ses":
      return provider.region ? { ok: true } : { ok: false, message: "Missing AWS region" };
    default:
      return { ok: false, message: `Unknown provider type: ${(provider as { type?: unknown }).type}` };
  }
}

function emptyLocalHealthMetrics(): ProviderLocalHealthMetrics {
  return {
    domainCount: 0,
    verifiedDomains: 0,
    addressCount: 0,
    verifiedAddresses: 0,
    bounceRate: 0,
  };
}

function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

async function checkCredentialState(provider: Provider, opts: ProviderHealthOptions): Promise<Pick<ProviderHealth, "credentialsValid" | "credentialsChecked" | "credentialError">> {
  const credentialsChecked = opts.validateCredentials !== false;
  if (credentialsChecked) {
    try {
      const adapter = getAdapter(provider);
      await adapter.listDomains();
      return { credentialsChecked, credentialsValid: true };
    } catch (e) {
      return {
        credentialsChecked,
        credentialsValid: false,
        credentialError: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const local = locallyConfigured(provider);
  return {
    credentialsChecked,
    credentialsValid: local.ok,
    credentialError: local.message,
  };
}

function statusFrom(credentialsValid: boolean, bounceRate: number): ProviderHealth["status"] {
  if (!credentialsValid) return "error";
  if (bounceRate > 5) return "warning";
  return "healthy";
}

function buildProviderHealth(
  provider: Provider,
  credentials: Pick<ProviderHealth, "credentialsValid" | "credentialsChecked" | "credentialError">,
  metrics: ProviderLocalHealthMetrics,
): ProviderHealth {
  return {
    provider,
    ...credentials,
    ...metrics,
    status: statusFrom(credentials.credentialsValid, metrics.bounceRate),
  };
}

function listLocalProviderHealthMetrics(providers: Provider[], db: Database): Map<string, ProviderLocalHealthMetrics> {
  const ids = [...new Set(providers.map((provider) => provider.id).filter(Boolean))];
  const metrics = new Map(ids.map((id) => [id, emptyLocalHealthMetrics()]));
  if (ids.length === 0) return metrics;

  const placeholders = ids.map(() => "?").join(", ");
  const domainRows = db.query(
    `SELECT
       provider_id,
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN dkim_status = 'verified' THEN 1 ELSE 0 END), 0) AS verified
     FROM domains
     WHERE provider_id IN (${placeholders})
     GROUP BY provider_id`,
  ).all(...ids) as Array<{ provider_id: string; total: unknown; verified: unknown }>;
  for (const row of domainRows) {
    const current = metrics.get(row.provider_id) ?? emptyLocalHealthMetrics();
    metrics.set(row.provider_id, {
      ...current,
      domainCount: countValue(row.total),
      verifiedDomains: countValue(row.verified),
    });
  }

  const addressRows = db.query(
    `SELECT
       provider_id,
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) AS verified
     FROM addresses
     WHERE provider_id IN (${placeholders})
     GROUP BY provider_id`,
  ).all(...ids) as Array<{ provider_id: string; total: unknown; verified: unknown }>;
  for (const row of addressRows) {
    const current = metrics.get(row.provider_id) ?? emptyLocalHealthMetrics();
    metrics.set(row.provider_id, {
      ...current,
      addressCount: countValue(row.total),
      verifiedAddresses: countValue(row.verified),
    });
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const eventRows = db.query(
    `SELECT
       provider_id,
       COUNT(*) AS sent,
       COALESCE(SUM(CASE WHEN type = 'bounced' THEN 1 ELSE 0 END), 0) AS bounced
     FROM events
     WHERE occurred_at >= ?
       AND provider_id IN (${placeholders})
     GROUP BY provider_id`,
  ).all(since, ...ids) as Array<{ provider_id: string; sent: unknown; bounced: unknown }>;
  for (const row of eventRows) {
    const sent = countValue(row.sent);
    const bounced = countValue(row.bounced);
    const current = metrics.get(row.provider_id) ?? emptyLocalHealthMetrics();
    metrics.set(row.provider_id, {
      ...current,
      bounceRate: sent > 0 ? roundRate((bounced / sent) * 100) : 0,
    });
  }

  return metrics;
}

export async function checkProviderHealth(provider: Provider, db?: Database, opts: ProviderHealthOptions = {}): Promise<ProviderHealth> {
  const d = db || getDatabase();
  const credentials = await checkCredentialState(provider, opts);
  const metrics = listLocalProviderHealthMetrics([provider], d).get(provider.id) ?? emptyLocalHealthMetrics();

  return buildProviderHealth(provider, credentials, metrics);
}

export async function checkAllProviders(db?: Database, opts: ProviderHealthOptions = {}): Promise<ProviderHealth[]> {
  const d = db || getDatabase();
  const providers = listActiveProviders(undefined, d);
  const metrics = listLocalProviderHealthMetrics(providers, d);
  const credentials = await Promise.all(providers.map((provider) => checkCredentialState(provider, opts)));
  return providers.map((provider, index) => buildProviderHealth(
    provider,
    credentials[index] ?? { credentialsChecked: opts.validateCredentials !== false, credentialsValid: false },
    metrics.get(provider.id) ?? emptyLocalHealthMetrics(),
  ));
}
