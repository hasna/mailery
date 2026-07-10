// Product-owned Emails Postgres storage utilities.
// Forked from storage-kit 0.4.2 and maintained in this repository.

// Postgres pool factory for the Emails Postgres storage utilities.
//
// The single sanctioned way to open a self_hosted Postgres connection. TLS is
// resolved through `tls.ts` (one correct approach), and env/mode resolution
// runs through `mode.ts` (the contract). PURE REMOTE (Amendment A1): a Pool is
// only ever built for `self_hosted` mode; there is no local/hybrid Postgres path.

import pg from "pg";
import type { Pool, PoolConfig } from "pg";
import { resolveStorageMode, resolveDatabaseUrl } from "./mode.js";
import {
  connectionStringWithoutTlsParameters,
  resolveTlsConfig,
  sslNegotiationFromConnectionString,
  type TlsResolveOptions,
} from "./tls.js";
import { createQueryClient, type PoolQueryClient } from "./query.js";

export interface CreatePgPoolOptions extends TlsResolveOptions {
  connectionString: string;
  /** Max clients in the pool. Defaults to pg's default (10). */
  max?: number;
  /** Idle client timeout (ms). */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout (ms). */
  connectionTimeoutMillis?: number;
  /** Application name reported to Postgres (shows in pg_stat_activity). */
  applicationName?: string;
}

/** Build a `pg.Pool` with consistent TLS handling. */
export function createPgPool(options: CreatePgPoolOptions): Pool {
  const ssl = resolveTlsConfig(options.connectionString, {
    ...(options.ca !== undefined ? { ca: options.ca } : {}),
    ...(options.caCertPath !== undefined ? { caCertPath: options.caCertPath } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const connectionString = connectionStringWithoutTlsParameters(options.connectionString);
  const sslnegotiation = sslNegotiationFromConnectionString(options.connectionString);

  const config: PoolConfig & { sslnegotiation?: "postgres" | "direct" } = { connectionString };
  if (ssl !== undefined) config.ssl = ssl;
  if (sslnegotiation !== undefined) config.sslnegotiation = sslnegotiation;
  if (options.max !== undefined) config.max = options.max;
  if (options.idleTimeoutMillis !== undefined) config.idleTimeoutMillis = options.idleTimeoutMillis;
  if (options.connectionTimeoutMillis !== undefined) config.connectionTimeoutMillis = options.connectionTimeoutMillis;
  if (options.applicationName !== undefined) config.application_name = options.applicationName;

  return new pg.Pool(config);
}

export interface CreateSelfHostedPoolFromEnvOptions extends TlsResolveOptions {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
}

export interface SelfHostedPoolFromEnv {
  client: PoolQueryClient;
  connectionSource: string;
}

/**
 * Resolve mode + database URL from the environment and build a self_hosted pool.
 *
 * Throws when the resolved mode is not `self_hosted` (PURE REMOTE has no Postgres in
 * `local` mode) or when the database URL is missing. Never logs the URL.
 */
export function createSelfHostedPoolFromEnv(
  appName: string,
  options: CreateSelfHostedPoolFromEnvOptions = {},
): SelfHostedPoolFromEnv {
  const env = options.env ?? process.env;
  const resolution = resolveStorageMode(appName, env);
  if (resolution.mode !== "self_hosted") {
    throw new Error(
      `createSelfHostedPoolFromEnv requires Emails mode 'self_hosted', got '${resolution.mode}'. ` +
        "Set EMAILS_MODE=self_hosted.",
    );
  }
  const connectionString = resolveDatabaseUrl(appName, env);
  if (!connectionString) {
    throw new Error(
      `self_hosted mode for ${appName} needs EMAILS_DATABASE_URL.`,
    );
  }
  const pool = createPgPool({
    connectionString,
    ...(options.ca !== undefined ? { ca: options.ca } : {}),
    ...(options.caCertPath !== undefined ? { caCertPath: options.caCertPath } : {}),
    env,
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.idleTimeoutMillis !== undefined ? { idleTimeoutMillis: options.idleTimeoutMillis } : {}),
    ...(options.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMillis }
      : {}),
    ...(options.applicationName !== undefined ? { applicationName: options.applicationName } : {}),
  });
  return {
    client: createQueryClient(pool),
    connectionSource: resolution.databaseUrlSource ?? "unknown",
  };
}
